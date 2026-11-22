//! Creating users with client certificates, approving CSRs and removing subjects, against the
//! fake API server. Every kubeconfig lives in a temp home; `KUBECONFIG` is never read.

mod support;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use k8s_openapi::api::certificates::v1::CertificateSigningRequest;
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding};
use k8s_openapi::jiff::Timestamp;
use kube::Api;
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::{
    certificate_request_describe, BindingKind, BindingRef, BoundBinding, CertUserEvent,
    CertUserLimits, CertUserRequest, CertUserStep, CsrDecision, RemovalOutcome, RoleGrant,
    RoleKind, SubjectKind, SubjectRef,
};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::sync::mpsc;

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

const FAST: CertUserLimits = CertUserLimits {
    approval: Duration::from_secs(3),
    issue: Duration::from_secs(2),
};
/// For tests that must not reach a limit.
const SLOW: CertUserLimits = CertUserLimits {
    approval: Duration::from_secs(60),
    issue: Duration::from_secs(60),
};
const WEEK: u32 = 7 * 24 * 3600;
const NO_APPROVAL: &str = "No one approved the request within 15 minutes. It was deleted.";
const NO_CERTIFICATE: &str = "The cluster approved the request, but no certificate came within 60 seconds. Managed clusters, such as EKS, may not sign kube-apiserver-client requests.";

fn new_user(user: &str, groups: &[&str], binding: Option<RoleGrant>) -> CertUserRequest {
    CertUserRequest {
        user_name: user.to_owned(),
        groups: groups.iter().map(|g| (*g).to_owned()).collect(),
        lifetime_seconds: WEEK,
        binding,
    }
}

fn grant(role_kind: RoleKind, role: &str, namespace: Option<&str>) -> RoleGrant {
    RoleGrant {
        role_kind,
        role_name: role.to_owned(),
        namespace: namespace.map(str::to_owned),
    }
}

fn dest(root: &TempDir, file: &str) -> PathBuf {
    root.path().join(file)
}

async fn start(
    core: &AppCore,
    id: &ClusterId,
    request: CertUserRequest,
    file: &Path,
    owner: &str,
    limits: CertUserLimits,
) -> (String, mpsc::Receiver<CertUserEvent>) {
    let (tx, rx) = mpsc::channel(64);
    let run = core
        .cert_user_create_start_with(id, request, file, tx, owner, limits)
        .await
        .unwrap();
    (run, rx)
}

/// The next event, failing the test after 10 seconds.
async fn next(rx: &mut mpsc::Receiver<CertUserEvent>) -> CertUserEvent {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("no event within 10 seconds")
        .expect("the run ended without a last event")
}

fn is_last(event: &CertUserEvent) -> bool {
    matches!(
        event,
        CertUserEvent::Done { .. } | CertUserEvent::Failed { .. } | CertUserEvent::Cancelled
    )
}

fn waiting(event: &CertUserEvent) -> bool {
    matches!(event, CertUserEvent::WaitingForApproval { .. })
}

/// The events up to the first that `stop` matches, which comes last.
async fn until(
    rx: &mut mpsc::Receiver<CertUserEvent>,
    stop: impl Fn(&CertUserEvent) -> bool,
) -> Vec<CertUserEvent> {
    let mut events = Vec::new();
    loop {
        let event = next(rx).await;
        let found = stop(&event);
        assert!(found || !is_last(&event), "the run ended early: {event:?}");
        events.push(event);
        if found {
            return events;
        }
    }
}

/// The events up to and with the last.
async fn all(rx: &mut mpsc::Receiver<CertUserEvent>) -> Vec<CertUserEvent> {
    until(rx, is_last).await
}

fn types(events: &[CertUserEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| {
            serde_json::to_value(e).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn csr_name(events: &[CertUserEvent]) -> String {
    events
        .iter()
        .find_map(|e| match e {
            CertUserEvent::Submitted { csr_name } => Some(csr_name.clone()),
            _ => None,
        })
        .expect("no submitted event")
}

fn failure(events: &[CertUserEvent]) -> (CertUserStep, ErrorCode, String) {
    match events.last() {
        Some(CertUserEvent::Failed { step, error }) => (*step, error.code, error.message.clone()),
        other => panic!("expected the run to fail, got {other:?}"),
    }
}

fn saved_config(file: &Path) -> Value {
    serde_yaml_ng::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

fn subject_of(request_der: &[u8]) -> (String, Vec<String>) {
    let info = certificate_request_describe(&STANDARD.encode(request_der), None).unwrap();
    (info.common_name, info.organizations)
}

#[tokio::test]
async fn a_full_run_saves_a_kubeconfig_and_reports_the_real_expiry() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    let file = dest(&root, "carol.kubeconfig");
    let (_run, mut rx) = start(
        &core,
        &id,
        new_user("carol", &["devs", "oncall"], None),
        &file,
        "main",
        FAST,
    )
    .await;
    let events = all(&mut rx).await;

    assert_eq!(
        types(&events),
        [
            "started",
            "started",
            "submitted",
            "started",
            "approved",
            "started",
            "issued",
            "started",
            "saved",
            "done"
        ]
    );
    // The fake signer's certificate ends on 2030-01-01, not a week from now.
    assert_eq!(
        events.last(),
        Some(&CertUserEvent::Done {
            expires_at: "2030-01-01T00:00:00Z".into(),
            binding: None
        })
    );

    let name = csr_name(&events);
    assert!(name.starts_with("carol-"), "{name}");
    let csr = stored(&core, &id, &name)
        .await
        .expect("a saved run keeps its request");
    assert_eq!(csr.spec.signer_name, SIGNER);
    assert_eq!(csr.spec.usages, Some(vec!["client auth".to_owned()]));
    assert_eq!(
        csr.spec.expiration_seconds,
        Some(i32::try_from(WEEK).unwrap())
    );
    assert_eq!(
        subject_of(&csr.spec.request.0),
        ("carol".into(), vec!["devs".into(), "oncall".into()])
    );

    let config = saved_config(&file);
    assert_eq!(config["current-context"], "carol@fake");
    assert_eq!(config["clusters"][0]["name"], "fake");
    assert_eq!(
        config["clusters"][0]["cluster"]["server"],
        json!(fake.url())
    );
    assert_eq!(config["contexts"][0]["context"]["user"], "carol@fake");
    assert!(config["contexts"][0]["context"].get("namespace").is_none());
    let user = &config["users"][0]["user"];
    let key = STANDARD
        .decode(user["client-key-data"].as_str().unwrap())
        .unwrap();
    assert!(String::from_utf8(key)
        .unwrap()
        .starts_with("-----BEGIN PRIVATE KEY-----"));
    let certificate = STANDARD
        .decode(user["client-certificate-data"].as_str().unwrap())
        .unwrap();
    assert_eq!(certificate, csr.status.unwrap().certificate.unwrap().0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    core.shutdown().await;
}

#[tokio::test]
async fn a_grant_makes_one_binding_for_the_exact_user_name() {
    let (core, _fake, id, root) = connected(FakeKubeConfig::default()).await;
    let edit = grant(RoleKind::ClusterRole, "edit", Some("payments"));
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], Some(edit)),
        &dest(&root, "carol"),
        "main",
        FAST,
    )
    .await;
    let events = all(&mut rx).await;

    let carol_edit = BoundBinding {
        kind: BindingKind::RoleBinding,
        namespace: Some("payments".into()),
        name: "carol-edit".into(),
    };
    assert_eq!(types(&events)[8..], ["saved", "started", "bound", "done"]);
    assert_eq!(
        events[events.len() - 2],
        CertUserEvent::Bound {
            binding: carol_edit.clone()
        }
    );
    assert!(
        matches!(events.last(), Some(CertUserEvent::Done { binding: Some(b), .. }) if *b == carol_edit)
    );
    assert_eq!(
        saved_config(&dest(&root, "carol"))["contexts"][0]["context"]["namespace"],
        "payments"
    );
    let client = core.cluster_client(&id).unwrap();
    let made = Api::<RoleBinding>::namespaced(client.clone(), "payments")
        .get("carol-edit")
        .await
        .unwrap();
    assert_eq!(
        (made.role_ref.kind.as_str(), made.role_ref.name.as_str()),
        ("ClusterRole", "edit")
    );
    let subjects = made.subjects.unwrap();
    assert_eq!(subjects.len(), 1);
    assert_eq!(
        (
            subjects[0].kind.as_str(),
            subjects[0].name.as_str(),
            subjects[0].api_group.as_deref()
        ),
        ("User", "carol", Some(RBAC))
    );

    let view = grant(RoleKind::ClusterRole, "view", None);
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("dave", &[], Some(view)),
        &dest(&root, "dave"),
        "main",
        FAST,
    )
    .await;
    let dave_view = BoundBinding {
        kind: BindingKind::ClusterRoleBinding,
        namespace: None,
        name: "dave-view".into(),
    };
    assert!(
        matches!(all(&mut rx).await.last(), Some(CertUserEvent::Done { binding: Some(b), .. }) if *b == dave_view)
    );
    assert!(Api::<ClusterRoleBinding>::all(client.clone())
        .get_opt("dave-view")
        .await
        .unwrap()
        .is_some());

    let reader = grant(RoleKind::Role, "payments-reader", Some("payments"));
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("erin", &[], Some(reader)),
        &dest(&root, "erin"),
        "main",
        FAST,
    )
    .await;
    all(&mut rx).await;
    let made = Api::<RoleBinding>::namespaced(client, "payments")
        .get("erin-payments-reader")
        .await
        .unwrap();
    assert_eq!(
        (made.role_ref.kind.as_str(), made.role_ref.name.as_str()),
        ("Role", "payments-reader")
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_requester_who_may_not_approve_waits_and_carries_on_once_approved() {
    let (core, fake, id, root) = connected(approval_denied()).await;
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &dest(&root, "carol"),
        "main",
        FAST,
    )
    .await;
    let events = until(&mut rx, waiting).await;
    let name = csr_name(&events);

    let Some(CertUserEvent::WaitingForApproval { csr_name, deadline }) = events.last() else {
        unreachable!()
    };
    assert_eq!(csr_name, &name);
    assert!(!deadline.contains('.'), "whole seconds: {deadline}");
    let left = deadline
        .parse::<Timestamp>()
        .unwrap()
        .duration_since(Timestamp::now())
        .as_secs();
    assert!((1..=3).contains(&left), "{left}");

    fake.decide_csr(&name, "Approved", "approved by an admin");
    assert_eq!(
        types(&all(&mut rx).await),
        ["approved", "started", "issued", "started", "saved", "done"]
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_denied_request_fails_with_its_message_and_is_deleted() {
    let (core, fake, id, root) = connected(approval_denied()).await;
    let file = dest(&root, "carol");
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &file,
        "main",
        FAST,
    )
    .await;
    let name = csr_name(&until(&mut rx, waiting).await);

    fake.decide_csr(&name, "Denied", "Not today.");
    let events = all(&mut rx).await;

    assert_eq!(
        failure(&events),
        (
            CertUserStep::Approve,
            ErrorCode::Forbidden,
            "The request was denied: Not today.".to_owned()
        )
    );
    assert!(stored(&core, &id, &name).await.is_none());
    assert!(!file.exists());
    core.shutdown().await;
}

#[tokio::test]
async fn no_approval_within_the_limit_fails_and_deletes_the_request() {
    let (core, _fake, id, root) = connected(approval_denied()).await;
    let started = Instant::now();
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &dest(&root, "carol"),
        "main",
        FAST,
    )
    .await;
    let events = all(&mut rx).await;

    assert!(started.elapsed() >= FAST.approval);
    assert_eq!(
        failure(&events),
        (
            CertUserStep::Approve,
            ErrorCode::Internal,
            NO_APPROVAL.to_owned()
        )
    );
    assert!(stored(&core, &id, &csr_name(&events)).await.is_none());
    core.shutdown().await;
}

#[tokio::test]
async fn an_approved_request_with_no_certificate_fails_with_the_managed_cluster_hint() {
    let cfg = FakeKubeConfig {
        no_csr_signer: true,
        ..FakeKubeConfig::default()
    };
    let (core, _fake, id, root) = connected(cfg).await;
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &dest(&root, "carol"),
        "main",
        FAST,
    )
    .await;
    let events = all(&mut rx).await;

    assert_eq!(types(&events)[4..6], ["approved", "started"]);
    assert_eq!(
        failure(&events),
        (
            CertUserStep::WaitForCertificate,
            ErrorCode::Internal,
            NO_CERTIFICATE.to_owned()
        )
    );
    assert!(stored(&core, &id, &csr_name(&events)).await.is_none());
    core.shutdown().await;
}

#[tokio::test]
async fn cancelling_while_waiting_deletes_the_request() {
    let (core, _fake, id, root) = connected(approval_denied()).await;
    let file = dest(&root, "carol");
    let (run, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &file,
        "main",
        SLOW,
    )
    .await;
    let name = csr_name(&until(&mut rx, waiting).await);

    core.cert_user_create_cancel(&run);

    assert_eq!(next(&mut rx).await, CertUserEvent::Cancelled);
    assert!(stored(&core, &id, &name).await.is_none());
    assert!(!file.exists());
    core.shutdown().await;
}

#[tokio::test]
async fn cancelling_after_saving_keeps_the_file_and_the_request() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    fake.delay_creates("rolebindings", Duration::from_secs(5));
    let file = dest(&root, "carol");
    let edit = grant(RoleKind::ClusterRole, "edit", Some("payments"));
    let (run, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], Some(edit)),
        &file,
        "main",
        SLOW,
    )
    .await;
    let events = until(&mut rx, |e| {
        *e == CertUserEvent::Started {
            step: CertUserStep::Bind,
        }
    })
    .await;

    core.cert_user_create_cancel(&run);

    assert_eq!(next(&mut rx).await, CertUserEvent::Cancelled);
    assert!(file.exists());
    assert!(stored(&core, &id, &csr_name(&events)).await.is_some());
    core.shutdown().await;
}

#[tokio::test]
async fn an_existing_binding_is_not_overwritten_and_the_file_stays() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(
        "rolebindings",
        binding(Some("payments"), "carol-edit", json!([user("someone")])),
    );
    let file = dest(&root, "carol");
    let edit = grant(RoleKind::ClusterRole, "edit", Some("payments"));
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], Some(edit)),
        &file,
        "main",
        FAST,
    )
    .await;
    let events = all(&mut rx).await;

    match &events[events.len() - 2] {
        CertUserEvent::BindingFailed { binding, error } => {
            assert_eq!(binding.name, "carol-edit");
            assert_eq!(error.code, ErrorCode::Conflict);
        }
        other => panic!("expected bindingFailed, got {other:?}"),
    }
    assert!(matches!(
        events.last(),
        Some(CertUserEvent::Done { binding: None, .. })
    ));
    assert!(file.exists());
    let kept = Api::<RoleBinding>::namespaced(core.cluster_client(&id).unwrap(), "payments")
        .get("carol-edit")
        .await
        .unwrap();
    assert_eq!(subject_names(kept.subjects), ["User someone"]);
    core.shutdown().await;
}

#[tokio::test]
async fn an_odd_user_name_keeps_its_text_and_gets_slugged_names() {
    let (core, _fake, id, root) = connected(FakeKubeConfig::default()).await;
    let file = dest(&root, "carol");
    let edit = grant(RoleKind::ClusterRole, "edit", Some("payments"));
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("Carol.Smith@Corp", &[], Some(edit)),
        &file,
        "main",
        FAST,
    )
    .await;
    let events = all(&mut rx).await;

    let name = csr_name(&events);
    assert!(name.starts_with("carol-smith-corp-"), "{name}");
    let csr = stored(&core, &id, &name).await.unwrap();
    assert_eq!(subject_of(&csr.spec.request.0).0, "Carol.Smith@Corp");
    let made = Api::<RoleBinding>::namespaced(core.cluster_client(&id).unwrap(), "payments")
        .get("carol-smith-corp-edit")
        .await
        .unwrap();
    assert_eq!(subject_names(made.subjects), ["User Carol.Smith@Corp"]);
    assert_eq!(
        saved_config(&file)["current-context"],
        "Carol.Smith@Corp@fake"
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_request_deleted_while_waiting_fails_at_once() {
    let (core, fake, id, root) = connected(approval_denied()).await;
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &dest(&root, "carol"),
        "main",
        SLOW,
    )
    .await;
    let name = csr_name(&until(&mut rx, waiting).await);

    let deleted = Instant::now();
    fake.delete(CSRS, None, &name);
    let events = all(&mut rx).await;

    assert!(deleted.elapsed() < Duration::from_secs(5));
    assert_eq!(
        failure(&events),
        (
            CertUserStep::Approve,
            ErrorCode::NotFound,
            format!("the signing request {name} was deleted before a certificate was issued")
        )
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_window_cancels_only_its_own_runs() {
    let (core, fake, id, root) = connected(approval_denied()).await;
    let (_, mut main) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &dest(&root, "carol"),
        "main",
        SLOW,
    )
    .await;
    let (_, mut other) = start(
        &core,
        &id,
        new_user("dave", &[], None),
        &dest(&root, "dave"),
        "other",
        SLOW,
    )
    .await;
    let carol = csr_name(&until(&mut main, waiting).await);
    let dave = csr_name(&until(&mut other, waiting).await);

    core.cert_user_create_cancel_owned("main");

    assert_eq!(next(&mut main).await, CertUserEvent::Cancelled);
    assert!(stored(&core, &id, &carol).await.is_none());
    fake.decide_csr(&dave, "Approved", "approved by an admin");
    assert!(matches!(
        all(&mut other).await.last(),
        Some(CertUserEvent::Done { .. })
    ));
    core.shutdown().await;
}

#[tokio::test]
async fn a_run_nobody_listens_to_stops_and_deletes_its_request() {
    let (core, _fake, id, root) = connected(approval_denied()).await;
    let (_, mut rx) = start(
        &core,
        &id,
        new_user("carol", &[], None),
        &dest(&root, "carol"),
        "main",
        SLOW,
    )
    .await;
    let name = csr_name(&until(&mut rx, waiting).await);

    drop(rx);

    for _ in 0..50 {
        if stored(&core, &id, &name).await.is_none() {
            core.shutdown().await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the request {name} was not deleted");
}

#[tokio::test]
async fn a_bad_request_or_destination_costs_nothing_on_the_cluster() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    for (request, file) in [
        (new_user("system:carol", &[], None), dest(&root, "carol")),
        (
            new_user("carol", &["devs", "devs"], None),
            dest(&root, "carol"),
        ),
        (
            new_user("carol", &[], None),
            root.path().join("missing").join("carol"),
        ),
        (
            new_user("carol", &[], None),
            PathBuf::from("carol.kubeconfig"),
        ),
    ] {
        let (tx, _rx) = mpsc::channel(8);
        let error = core
            .cert_user_create_start_with(&id, request, &file, tx, "main", FAST)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(!error.message.contains("missing"), "{}", error.message);
    }
    assert!(fake
        .writes(
            "POST",
            "/apis/certificates.k8s.io/v1/certificatesigningrequests"
        )
        .is_empty());
    core.shutdown().await;
}
