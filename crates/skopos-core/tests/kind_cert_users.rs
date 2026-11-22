//! Client-certificate users against the real `skopos-e2e` kind cluster. Run with
//! `make test-kind`.

mod support;

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures::FutureExt;
use k8s_openapi::api::certificates::v1::{
    CertificateSigningRequest, CertificateSigningRequestCondition,
};
use kube::api::{DeleteParams, PostParams};
use kube::Api;
use serde_json::json;
use skopos_core::resources::certificate_request_describe;
use support::connected_kind;

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
