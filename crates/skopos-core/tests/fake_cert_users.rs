//! Creating users with client certificates, approving CSRs and removing subjects, against the
//! fake API server. Every kubeconfig lives in a temp home; `KUBECONFIG` is never read.

mod support;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use k8s_openapi::api::certificates::v1::CertificateSigningRequest;
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding};
use kube::Api;
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::{
    BindingKind, BindingRef, CsrDecision, RemovalOutcome, SubjectKind, SubjectRef,
};
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

const RBAC: &str = "rbac.authorization.k8s.io";

fn binding(namespace: Option<&str>, name: &str, subjects: Value) -> Value {
    let mut metadata = json!({ "name": name });
    if let Some(namespace) = namespace {
        metadata["namespace"] = json!(namespace);
    }
    json!({
        "metadata": metadata,
        "roleRef": { "apiGroup": RBAC, "kind": "ClusterRole", "name": "view" },
        "subjects": subjects,
    })
}

fn user(name: &str) -> Value {
    json!({ "kind": "User", "apiGroup": RBAC, "name": name })
}

fn group(name: &str) -> Value {
    json!({ "kind": "Group", "apiGroup": RBAC, "name": name })
}

fn alice() -> SubjectRef {
    SubjectRef {
        kind: SubjectKind::User,
        name: "alice".into(),
    }
}

/// The reference the person saw: the binding as it is stored now.
async fn seen(core: &AppCore, id: &ClusterId, namespace: Option<&str>, name: &str) -> BindingRef {
    let client = core.cluster_client(id).unwrap();
    let (kind, resource_version) = match namespace {
        Some(namespace) => (
            BindingKind::RoleBinding,
            Api::<RoleBinding>::namespaced(client, namespace)
                .get(name)
                .await
                .unwrap()
                .metadata
                .resource_version,
        ),
        None => (
            BindingKind::ClusterRoleBinding,
            Api::<ClusterRoleBinding>::all(client)
                .get(name)
                .await
                .unwrap()
                .metadata
                .resource_version,
        ),
    };
    BindingRef {
        kind,
        namespace: namespace.map(str::to_owned),
        name: name.to_owned(),
        resource_version: resource_version.unwrap(),
    }
}

fn subject_names(subjects: Option<Vec<k8s_openapi::api::rbac::v1::Subject>>) -> Vec<String> {
    subjects
        .unwrap_or_default()
        .into_iter()
        .map(|s| format!("{} {}", s.kind, s.name))
        .collect()
}

#[tokio::test]
async fn removing_a_user_updates_deletes_and_reports_changes_per_binding() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let account = json!({ "kind": "ServiceAccount", "name": "alice", "namespace": "payments" });
    fake.upsert(
        "rolebindings",
        binding(
            Some("payments"),
            "shared",
            json!([user("alice"), group("devs"), account]),
        ),
    );
    fake.upsert(
        "rolebindings",
        binding(
            Some("payments"),
            "stale",
            json!([user("alice"), user("bob")]),
        ),
    );
    fake.upsert(
        "clusterrolebindings",
        binding(None, "alice-view", json!([user("alice")])),
    );
    let shared = seen(&core, &id, Some("payments"), "shared").await;
    let stale = seen(&core, &id, Some("payments"), "stale").await;
    let alice_view = seen(&core, &id, None, "alice-view").await;
    let gone = BindingRef {
        kind: BindingKind::RoleBinding,
        namespace: Some("payments".into()),
        name: "gone".into(),
        resource_version: "1".into(),
    };
    // Someone changes "stale" after the person saw it.
    fake.upsert(
        "rolebindings",
        binding(
            Some("payments"),
            "stale",
            json!([user("alice"), user("bob"), user("carol")]),
        ),
    );

    let removals = core
        .access_subject_remove(&id, &alice(), &[shared.clone(), alice_view, stale, gone])
        .await
        .unwrap();

    let outcomes: Vec<_> = removals
        .iter()
        .map(|r| (r.binding.name.as_str(), &r.outcome))
        .collect();
    assert_eq!(outcomes[0], ("shared", &RemovalOutcome::Updated));
    assert_eq!(outcomes[1], ("alice-view", &RemovalOutcome::Deleted));
    assert_eq!(outcomes[2], ("stale", &RemovalOutcome::Conflict));
    match outcomes[3] {
        ("gone", RemovalOutcome::Failed { error }) => assert_eq!(error.code, ErrorCode::NotFound),
        other => panic!("expected gone to fail, got {other:?}"),
    }

    let client = core.cluster_client(&id).unwrap();
    let rolebindings = Api::<RoleBinding>::namespaced(client.clone(), "payments");
    assert_eq!(
        subject_names(rolebindings.get("shared").await.unwrap().subjects),
        ["Group devs", "ServiceAccount alice"]
    );
    assert_eq!(
        subject_names(rolebindings.get("stale").await.unwrap().subjects).len(),
        3
    );
    assert!(Api::<ClusterRoleBinding>::all(client)
        .get_opt("alice-view")
        .await
        .unwrap()
        .is_none());

    // The update carried the version seen, and the delete was conditional on it.
    let put = fake.writes(
        "PUT",
        "/apis/rbac.authorization.k8s.io/v1/namespaces/payments/rolebindings/shared",
    );
    assert_eq!(
        put[0].body["metadata"]["resourceVersion"],
        json!(shared.resource_version)
    );
    let delete = fake.writes(
        "DELETE",
        "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/alice-view",
    );
    assert!(delete[0]
        .body
        .pointer("/preconditions/resourceVersion")
        .is_some());
    core.shutdown().await;
}

#[tokio::test]
async fn removing_a_group_keeps_a_user_of_the_same_name() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(
        "clusterrolebindings",
        binding(None, "ops", json!([user("ops"), group("ops")])),
    );
    let ops = seen(&core, &id, None, "ops").await;

    let group_ops = SubjectRef {
        kind: SubjectKind::Group,
        name: "ops".into(),
    };
    let removals = core
        .access_subject_remove(&id, &group_ops, &[ops])
        .await
        .unwrap();

    assert_eq!(removals[0].outcome, RemovalOutcome::Updated);
    let kept = Api::<ClusterRoleBinding>::all(core.cluster_client(&id).unwrap())
        .get("ops")
        .await
        .unwrap();
    assert_eq!(subject_names(kept.subjects), ["User ops"]);
    core.shutdown().await;
}

#[tokio::test]
async fn system_subjects_and_bad_references_are_refused_before_any_write() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(
        "clusterrolebindings",
        binding(None, "admins", json!([group("system:masters")])),
    );
    let admins = seen(&core, &id, None, "admins").await;

    let masters = SubjectRef {
        kind: SubjectKind::Group,
        name: "system:masters".into(),
    };
    let error = core
        .access_subject_remove(&id, &masters, std::slice::from_ref(&admins))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.message, "Kubernetes manages system users and groups");

    // One bad reference refuses the whole call, so the good one before it is untouched.
    fake.upsert(
        "clusterrolebindings",
        binding(None, "alice-view", json!([user("alice")])),
    );
    let alice_view = seen(&core, &id, None, "alice-view").await;
    for bad in [
        BindingRef {
            namespace: Some("payments".into()),
            ..admins.clone()
        },
        BindingRef {
            kind: BindingKind::RoleBinding,
            namespace: None,
            ..admins.clone()
        },
        BindingRef {
            name: "a/b".into(),
            ..admins.clone()
        },
    ] {
        let error = core
            .access_subject_remove(&id, &alice(), &[alice_view.clone(), bad])
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }
    assert!(fake
        .writes(
            "DELETE",
            "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/alice-view"
        )
        .is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn a_forbidden_binding_fails_alone() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "update".into(),
            plural: "rolebindings".into(),
            namespace: None,
        }],
        ..FakeKubeConfig::default()
    };
    let (core, fake, id, _root) = connected(cfg).await;
    fake.upsert(
        "rolebindings",
        binding(
            Some("payments"),
            "shared",
            json!([user("alice"), user("bob")]),
        ),
    );
    fake.upsert(
        "clusterrolebindings",
        binding(None, "alice-view", json!([user("alice")])),
    );
    let shared = seen(&core, &id, Some("payments"), "shared").await;
    let alice_view = seen(&core, &id, None, "alice-view").await;

    let removals = core
        .access_subject_remove(&id, &alice(), &[shared, alice_view])
        .await
        .unwrap();

    match &removals[0].outcome {
        RemovalOutcome::Failed { error } => assert_eq!(error.code, ErrorCode::Forbidden),
        other => panic!("expected Failed, got {other:?}"),
    }
    assert_eq!(removals[1].outcome, RemovalOutcome::Deleted);
    core.shutdown().await;
}
