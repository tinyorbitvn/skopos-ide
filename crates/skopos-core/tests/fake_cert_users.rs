//! Creating users with client certificates, approving CSRs and removing subjects, against the
//! fake API server. Every kubeconfig lives in a temp home; `KUBECONFIG` is never read.

mod support;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use k8s_openapi::api::certificates::v1::CertificateSigningRequest;
use kube::Api;
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::CsrDecision;
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;

const SIGNER: &str = "kubernetes.io/kube-apiserver-client";
const CSRS: &str = "certificatesigningrequests";
const APPROVAL_OF_ALICE: &str =
    "/apis/certificates.k8s.io/v1/certificatesigningrequests/alice-1/approval";

async fn connected(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let (core, fake, id, root) = support::connected_fake(cfg).await;
    fake.serve_resource(FakeResource::new(
        "certificates.k8s.io",
        "v1",
        "CertificateSigningRequest",
        CSRS,
        false,
    ));
    fake.serve_resource(FakeResource::new(
        "rbac.authorization.k8s.io",
        "v1",
        "RoleBinding",
        "rolebindings",
        true,
    ));
    fake.serve_resource(FakeResource::new(
        "rbac.authorization.k8s.io",
        "v1",
        "ClusterRoleBinding",
        "clusterrolebindings",
        false,
    ));
    (core, fake, id, root)
}

fn approval_denied() -> FakeKubeConfig {
    FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "update".into(),
            plural: format!("{CSRS}/approval"),
            namespace: None,
        }],
        ..FakeKubeConfig::default()
    }
}

fn pending(name: &str) -> Value {
    let key = rcgen::KeyPair::generate().unwrap();
    let request = rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap();
    json!({
        "metadata": { "name": name },
        "spec": { "request": STANDARD.encode(request), "signerName": SIGNER, "usages": ["client auth"] },
    })
}

async fn stored(core: &AppCore, id: &ClusterId, name: &str) -> Option<CertificateSigningRequest> {
    Api::<CertificateSigningRequest>::all(core.cluster_client(id).unwrap())
        .get_opt(name)
        .await
        .unwrap()
}

/// (type, reason, message) of each condition.
fn conditions(csr: &CertificateSigningRequest) -> Vec<(String, Option<String>, Option<String>)> {
    csr.status
        .as_ref()
        .and_then(|s| s.conditions.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|c| (c.type_, c.reason, c.message))
        .collect()
}

#[tokio::test]
async fn approving_adds_the_condition_and_the_signer_issues() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(CSRS, pending("alice-1"));

    core.csr_set_approval(&id, "alice-1", CsrDecision::Approve)
        .await
        .unwrap();

    let csr = stored(&core, &id, "alice-1").await.unwrap();
    assert_eq!(
        conditions(&csr),
        [(
            "Approved".into(),
            Some("ApprovedInSkoposIDE".into()),
            Some("Approved in SkoposIDE".into())
        )]
    );
    assert!(csr.status.unwrap().certificate.is_some());
    core.shutdown().await;
}

#[tokio::test]
async fn approval_is_a_put_that_needs_update_only() {
    // An approver with the documented rights has `update`, not `patch`, on /approval.
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "patch".into(),
            plural: format!("{CSRS}/approval"),
            namespace: None,
        }],
        ..FakeKubeConfig::default()
    };
    let (core, fake, id, _root) = connected(cfg).await;
    fake.upsert(CSRS, pending("alice-1"));

    core.csr_set_approval(&id, "alice-1", CsrDecision::Approve)
        .await
        .unwrap();

    let writes = fake.writes("PUT", APPROVAL_OF_ALICE);
    assert_eq!(writes.len(), 1);
    assert!(writes[0]
        .body
        .pointer("/metadata/resourceVersion")
        .is_some());
    assert!(fake.writes("PATCH", APPROVAL_OF_ALICE).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn denying_adds_denied_and_issues_nothing() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(CSRS, pending("alice-1"));

    core.csr_set_approval(&id, "alice-1", CsrDecision::Deny)
        .await
        .unwrap();

    let csr = stored(&core, &id, "alice-1").await.unwrap();
    assert_eq!(
        conditions(&csr),
        [(
            "Denied".into(),
            Some("DeniedInSkoposIDE".into()),
            Some("Denied in SkoposIDE".into())
        )]
    );
    assert!(csr.status.unwrap().certificate.is_none());
    core.shutdown().await;
}

#[tokio::test]
async fn a_decided_request_is_refused_with_conflict() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(CSRS, pending("alice-1"));
    fake.upsert(CSRS, pending("bob-1"));
    core.csr_set_approval(&id, "alice-1", CsrDecision::Approve)
        .await
        .unwrap();
    core.csr_set_approval(&id, "bob-1", CsrDecision::Deny)
        .await
        .unwrap();

    for (name, decision, word) in [
        ("alice-1", CsrDecision::Approve, "approved"),
        ("alice-1", CsrDecision::Deny, "approved"),
        ("bob-1", CsrDecision::Approve, "denied"),
    ] {
        let error = core
            .csr_set_approval(&id, name, decision)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(error.message, format!("the request was already {word}"));
    }
    core.shutdown().await;
}

#[tokio::test]
async fn a_request_changed_meanwhile_is_read_again_once() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(CSRS, pending("alice-1"));
    fake.fail_next_writes_to(CSRS, "alice-1", 409, 1);

    core.csr_set_approval(&id, "alice-1", CsrDecision::Approve)
        .await
        .unwrap();
    assert_eq!(fake.writes("PUT", APPROVAL_OF_ALICE).len(), 2);

    fake.upsert(CSRS, pending("alice-1"));
    fake.fail_next_writes_to(CSRS, "alice-1", 409, 2);
    let error = core
        .csr_set_approval(&id, "alice-1", CsrDecision::Approve)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    core.shutdown().await;
}

#[tokio::test]
async fn a_forbidden_approval_is_forbidden() {
    let (core, fake, id, _root) = connected(approval_denied()).await;
    fake.upsert(CSRS, pending("alice-1"));

    let error = core
        .csr_set_approval(&id, "alice-1", CsrDecision::Approve)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert!(conditions(&stored(&core, &id, "alice-1").await.unwrap()).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn the_fake_signer_can_be_off_and_others_can_decide() {
    let cfg = FakeKubeConfig {
        no_csr_signer: true,
        ..FakeKubeConfig::default()
    };
    let (core, fake, id, _root) = connected(cfg).await;
    fake.upsert(CSRS, pending("alice-1"));
    fake.decide_csr("alice-1", "Approved", "someone else");
    let csr = stored(&core, &id, "alice-1").await.unwrap();
    assert_eq!(conditions(&csr)[0].0, "Approved");
    assert!(csr.status.unwrap().certificate.is_none());
    core.shutdown().await;
}

#[tokio::test]
async fn a_bad_name_is_refused_before_any_request() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let error = core
        .csr_set_approval(&id, "a/b", CsrDecision::Approve)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    core.shutdown().await;
}
