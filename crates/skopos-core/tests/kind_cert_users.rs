//! Client-certificate users against the real `skopos-e2e` kind cluster. Run with
//! `make test-kind`.

mod support;

use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures::FutureExt;
use k8s_openapi::api::authentication::v1::{SelfSubjectReview, TokenRequest};
use k8s_openapi::api::certificates::v1::{
    CertificateSigningRequest, CertificateSigningRequestCondition,
};
use k8s_openapi::api::core::v1::{Pod, ServiceAccount};
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, RoleBinding};
use kube::api::{DeleteParams, ListParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use skopos_core::resources::{
    certificate_request_describe, BindingKind, BindingRef, CertUserEvent, CertUserRequest,
    CsrDecision, RemovalOutcome, RoleGrant, RoleKind, SubjectKind, SubjectRef,
};
use support::{connected_kind, connected_with, in_namespace, kubeconfig_with_token};
use tokio::sync::mpsc;

const SIGNER: &str = "kubernetes.io/kube-apiserver-client";
const PROOF: &str = "skopos-cert-proof";

/// Spec §3: if this fails, stop and ask. Do not switch to RSA or add `aws_lc_rs`.
#[tokio::test]
#[ignore = "needs make test-kind"]
async fn the_cluster_signs_an_ecdsa_p256_client_request() {
    let (core, id, _root) = connected_kind().await;
    let csrs: Api<CertificateSigningRequest> = Api::all(core.cluster_client(&id).unwrap());
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let mut params = rcgen::CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, PROOF);
    params
        .distinguished_name
        .push(rcgen::DnType::OrganizationName, "skopos-proof-group");
    let request = params.serialize_request(&key).unwrap().pem().unwrap();
    let _ = csrs.delete(PROOF, &DeleteParams::default()).await;
    let csr: CertificateSigningRequest = serde_json::from_value(json!({
        "metadata": { "name": PROOF },
        "spec": {
            "request": STANDARD.encode(&request),
            "signerName": SIGNER,
            "usages": ["client auth"],
            "expirationSeconds": 600,
        },
    }))
    .unwrap();
    csrs.create(&PostParams::default(), &csr).await.unwrap();

    let issued = AssertUnwindSafe(async {
        let mut current = csrs.get(PROOF).await.unwrap();
        current
            .status
            .get_or_insert_with(Default::default)
            .conditions = Some(vec![CertificateSigningRequestCondition {
            type_: "Approved".into(),
            status: "True".into(),
            reason: Some("SkoposProof".into()),
            message: Some("proof of signing".into()),
            ..CertificateSigningRequestCondition::default()
        }]);
        csrs.replace_subresource("approval", PROOF, &PostParams::default(), &current)
            .await
            .unwrap();
        let started = Instant::now();
        loop {
            let current = csrs.get(PROOF).await.unwrap();
            if let Some(certificate) = current.status.and_then(|s| s.certificate) {
                break certificate.0;
            }
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "kind never signed the request"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .catch_unwind()
    .await;
    let _ = csrs.delete(PROOF, &DeleteParams::default()).await;
    let certificate = issued.unwrap_or_else(|panic| std::panic::resume_unwind(panic));

    let info = certificate_request_describe(
        &STANDARD.encode(&request),
        Some(&STANDARD.encode(&certificate)),
    )
    .unwrap();
    assert_eq!(info.common_name, PROOF);
    assert_eq!(info.key_algorithm, "ECDSA P-256");
    assert!(info.not_after.is_some());
    core.shutdown().await;
}

const RBAC: &str = "rbac.authorization.k8s.io";
const REQUESTER: &str = "skopos-cert-requester";
const APPROVER: &str = "skopos-cert-approver";

fn from_json<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn is_last(event: &CertUserEvent) -> bool {
    matches!(
        event,
        CertUserEvent::Done { .. } | CertUserEvent::Failed { .. } | CertUserEvent::Cancelled
    )
}

/// The events up to the first that `stop` matches, failing after `limit`.
async fn until(
    rx: &mut mpsc::Receiver<CertUserEvent>,
    limit: Duration,
    stop: impl Fn(&CertUserEvent) -> bool,
) -> Vec<CertUserEvent> {
    let deadline = tokio::time::Instant::now() + limit;
    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("the run stalled")
            .expect("the run ended without a last event");
        let found = stop(&event);
        assert!(found || !is_last(&event), "the run ended early: {event:?}");
        events.push(event);
        if found {
            return events;
        }
    }
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

/// Deletes the requests whose names start with `prefix`, left by this or an earlier run.
async fn delete_requests(client: &Client, prefix: &str) {
    let api: Api<CertificateSigningRequest> = Api::all(client.clone());
    for csr in api.list(&ListParams::default()).await.unwrap() {
        if let Some(name) = csr.metadata.name.filter(|n| n.starts_with(prefix)) {
            let _ = api.delete(&name, &DeleteParams::default()).await;
        }
    }
}

async fn client_from(file: &Path) -> Client {
    let kubeconfig = Kubeconfig::read_from(file).unwrap();
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    Client::try_from(config).unwrap()
}

async fn lists_pods(client: &Client, namespace: &str) -> Result<(), u16> {
    match Api::<Pod>::namespaced(client.clone(), namespace)
        .list(&ListParams::default())
        .await
    {
        Ok(_) => Ok(()),
        Err(kube::Error::Api(status)) => Err(status.code),
        Err(other) => panic!("listing pods failed: {other}"),
    }
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn an_admin_creates_a_user_who_reads_one_namespace_until_removed() {
    let (core, id, root) = connected_kind().await;
    let admin = core.cluster_client(&id).unwrap();
    delete_requests(&admin, "cert-user-a-").await;
    let body = async {
        let file = root.path().join("cert-user-a.kubeconfig");
        let request = CertUserRequest {
            user_name: "cert-user-a".into(),
            groups: vec!["team-a".into(), "team-b".into()],
            lifetime_seconds: 3600,
            binding: Some(RoleGrant {
                role_kind: RoleKind::ClusterRole,
                role_name: "view".into(),
                namespace: Some("skopos-cert".into()),
            }),
        };
        let (tx, mut rx) = mpsc::channel(64);
        core.cert_user_create_start(&id, request, &file, tx, "kind")
            .await
            .unwrap();
        let events = until(&mut rx, Duration::from_secs(90), is_last).await;
        match events.last() {
            Some(CertUserEvent::Done {
                binding: Some(binding),
                ..
            }) => {
                assert_eq!(binding.name, "cert-user-a-view");
            }
            other => panic!("expected done with a binding, got {other:?}"),
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let user = client_from(&file).await;
        let review = Api::<SelfSubjectReview>::all(user.clone())
            .create(&PostParams::default(), &SelfSubjectReview::default())
            .await
            .unwrap();
        let info = review.status.unwrap().user_info.unwrap();
        assert_eq!(info.username.as_deref(), Some("cert-user-a"));
        let groups = info.groups.unwrap_or_default();
        for group in ["team-a", "team-b", "system:authenticated"] {
            assert!(
                groups.iter().any(|g| g == group),
                "{group} missing from {groups:?}"
            );
        }
        assert_eq!(lists_pods(&user, "skopos-cert").await, Ok(()));
        assert_eq!(lists_pods(&user, "default").await, Err(403));

        let made = Api::<RoleBinding>::namespaced(admin.clone(), "skopos-cert")
            .get("cert-user-a-view")
            .await
            .unwrap();
        let seen = BindingRef {
            kind: BindingKind::RoleBinding,
            namespace: Some("skopos-cert".into()),
            name: "cert-user-a-view".into(),
            resource_version: made.metadata.resource_version.unwrap(),
        };
        let subject = SubjectRef {
            kind: SubjectKind::User,
            name: "cert-user-a".into(),
        };
        let removals = core
            .access_subject_remove(&id, &subject, &[seen])
            .await
            .unwrap();
        assert_eq!(removals[0].outcome, RemovalOutcome::Deleted);

        let started = Instant::now();
        while lists_pods(&user, "skopos-cert").await != Err(403) {
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "the access stayed after removal"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    };
    let result = AssertUnwindSafe(in_namespace(&admin, "skopos-cert", body))
        .catch_unwind()
        .await;
    delete_requests(&admin, "cert-user-a-").await;
    core.shutdown().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

/// A token for a new ServiceAccount, bound to the ClusterRole of the same name.
async fn account_with_role(client: &Client, namespace: &str, name: &str, rules: Value) -> String {
    let made = PostParams::default();
    let roles: Api<ClusterRole> = Api::all(client.clone());
    roles
        .create(
            &made,
            &from_json(json!({ "metadata": { "name": name }, "rules": rules })),
        )
        .await
        .unwrap();
    let bindings: Api<ClusterRoleBinding> = Api::all(client.clone());
    let binding = json!({
        "metadata": { "name": name },
        "roleRef": { "apiGroup": RBAC, "kind": "ClusterRole", "name": name },
        "subjects": [{ "kind": "ServiceAccount", "name": name, "namespace": namespace }],
    });
    bindings.create(&made, &from_json(binding)).await.unwrap();
    let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
    accounts
        .create(&made, &from_json(json!({ "metadata": { "name": name } })))
        .await
        .unwrap();
    let request: TokenRequest = from_json(json!({
        "apiVersion": "authentication.k8s.io/v1",
        "kind": "TokenRequest",
        "spec": { "audiences": [] },
    }));
    accounts
        .create_token_request(name, &made, &request)
        .await
        .unwrap()
        .status
        .unwrap()
        .token
        .unwrap()
}

async fn delete_cluster_objects(client: &Client) {
    for name in [REQUESTER, APPROVER] {
        let _ = Api::<ClusterRoleBinding>::all(client.clone())
            .delete(name, &DeleteParams::default())
            .await;
        let _ = Api::<ClusterRole>::all(client.clone())
            .delete(name, &DeleteParams::default())
            .await;
    }
    delete_requests(client, "cert-user-b-").await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn a_requester_who_may_not_approve_waits_for_an_approver() {
    let (core, id, _root) = connected_kind().await;
    let admin = core.cluster_client(&id).unwrap();
    delete_cluster_objects(&admin).await;
    let body = async {
        let requester = account_with_role(
            &admin,
            "skopos-cert-wait",
            REQUESTER,
            json!([{
                "apiGroups": ["certificates.k8s.io"],
                "resources": ["certificatesigningrequests"],
                "verbs": ["create", "get", "list", "watch", "delete"],
            }]),
        )
        .await;
        // Exactly the rights the Kubernetes docs give an approver: no `patch`.
        let approver = account_with_role(
            &admin,
            "skopos-cert-wait",
            APPROVER,
            json!([
                {
                    "apiGroups": ["certificates.k8s.io"],
                    "resources": ["certificatesigningrequests"],
                    "verbs": ["get", "list", "watch"],
                },
                {
                    "apiGroups": ["certificates.k8s.io"],
                    "resources": ["certificatesigningrequests/approval"],
                    "verbs": ["update"],
                },
                {
                    "apiGroups": ["certificates.k8s.io"],
                    "resources": ["signers"],
                    "resourceNames": [SIGNER],
                    "verbs": ["approve"],
                },
            ]),
        )
        .await;
        let (requester_core, requester_id, requester_root) =
            connected_with(&kubeconfig_with_token(&requester), "viewer").await;
        let (approver_core, approver_id, _approver_root) =
            connected_with(&kubeconfig_with_token(&approver), "viewer").await;

        let file = requester_root.path().join("cert-user-b.kubeconfig");
        let request = CertUserRequest {
            user_name: "cert-user-b".into(),
            groups: vec![],
            lifetime_seconds: 3600,
            binding: None,
        };
        let (tx, mut rx) = mpsc::channel(64);
        requester_core
            .cert_user_create_start(&requester_id, request, &file, tx, "kind")
            .await
            .unwrap();
        let waiting = until(&mut rx, Duration::from_secs(60), |e| {
            matches!(e, CertUserEvent::WaitingForApproval { .. })
        })
        .await;
        let name = csr_name(&waiting);

        let review = approver_core.csr_review(&approver_id, &name).await.unwrap();
        assert_eq!(review.grants_error, None);
        assert!(review.privileged.is_empty(), "{:?}", review.privileged);
        approver_core
            .csr_set_approval(&approver_id, &name, &review.uid, CsrDecision::Approve)
            .await
            .unwrap();

        let rest = until(&mut rx, Duration::from_secs(90), is_last).await;
        assert!(
            matches!(rest.last(), Some(CertUserEvent::Done { binding: None, .. })),
            "{rest:?}"
        );
        assert!(file.exists());
        let csr = Api::<CertificateSigningRequest>::all(admin.clone())
            .get(&name)
            .await
            .unwrap();
        let reasons: Vec<_> = csr
            .status
            .and_then(|s| s.conditions)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|c| c.reason)
            .collect();
        assert!(
            reasons.iter().any(|r| r == "ApprovedInSkoposIDE"),
            "{reasons:?}"
        );
        requester_core.shutdown().await;
        approver_core.shutdown().await;
    };
    let result = AssertUnwindSafe(in_namespace(&admin, "skopos-cert-wait", body))
        .catch_unwind()
        .await;
    delete_cluster_objects(&admin).await;
    core.shutdown().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
