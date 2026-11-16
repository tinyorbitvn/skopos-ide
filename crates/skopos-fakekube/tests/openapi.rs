//! `serve_openapi_v3`: the index at `/openapi/v3` and each document at its hashed URL (spec L27).

use axum::http::{header, Request, StatusCode};
use kube::client::Body;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use skopos_fakekube::{FakeKube, FakeKubeConfig};

async fn client(fake: &FakeKube, dir: &std::path::Path) -> Client {
    let path = dir.join("config");
    fake.write_kubeconfig(&path, "fake").unwrap();
    let kubeconfig = Kubeconfig::read_from(&path).unwrap();
    let options = KubeConfigOptions {
        context: Some("fake".into()),
        ..Default::default()
    };
    let mut config = Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .unwrap();
    config.default_retry = false;
    Client::try_from(config).unwrap()
}

/// The status, the `Location` header and the body of a GET.
async fn fetch(client: &Client, path: &str) -> (StatusCode, Option<String>, Vec<u8>) {
    let request = Request::get(path).body(Vec::new()).unwrap();
    let response = client.send(request.map(Body::from)).await.unwrap();
    let status = response.status();
    let location = response
        .headers()
        .get(header::LOCATION)
        .map(|value| value.to_str().unwrap().to_owned());
    let body = response.into_body().collect_bytes().await.unwrap().to_vec();
    (status, location, body)
}

fn sha256_hex(body: &[u8]) -> String {
    Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A document with one schema under `key`.
fn document(key: &str) -> Value {
    json!({ "openapi": "3.0.0", "components": { "schemas": { key: { "type": "object" } } } })
}

fn url_of(key: &str, doc: &Value) -> String {
    format!(
        "/openapi/v3/{key}?hash={}",
        sha256_hex(&serde_json::to_vec(doc).unwrap())
    )
}

#[tokio::test]
async fn nothing_served_answers_404() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = client(&fake, dir.path()).await;

    let (status, _, _) = fetch(&client, "/openapi/v3").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(fake.request_count("/openapi/v3"), 1);
}

#[tokio::test]
async fn the_index_lists_each_document_at_the_hash_of_its_bytes() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = client(&fake, dir.path()).await;
    let apps = document("io.example.apps.v1.Deployment");
    fake.serve_openapi_v3("apps/v1", apps.clone());
    fake.serve_openapi_v3("v1", document("io.example.core.v1.ConfigMap"));

    let (status, _, body) = fetch(&client, "/openapi/v3").await;
    assert_eq!(status, StatusCode::OK);
    let index: Value = serde_json::from_slice(&body).unwrap();
    let paths = index["paths"].as_object().unwrap();
    assert_eq!(paths.keys().collect::<Vec<_>>(), ["api/v1", "apis/apps/v1"]);
    let url = paths["apis/apps/v1"]["serverRelativeURL"].as_str().unwrap();
    assert_eq!(url, url_of("apis/apps/v1", &apps));

    let (status, _, body) = fetch(&client, url).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), apps);
    assert_eq!(fake.request_count("/openapi/v3"), 1);
    assert_eq!(fake.request_count("/openapi/v3/apis/apps/v1"), 1);
}

#[tokio::test]
async fn a_stale_hash_is_sent_on_to_the_current_document() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = client(&fake, dir.path()).await;
    let first = document("io.example.apps.v1.Deployment");
    fake.serve_openapi_v3("apps/v1", first.clone());
    let replaced = document("io.example.apps.v1.StatefulSet");
    fake.serve_openapi_v3("apps/v1", replaced.clone());

    let (status, location, _) = fetch(&client, &url_of("apis/apps/v1", &first)).await;
    assert_eq!(status, StatusCode::MOVED_PERMANENTLY);
    assert_eq!(location, Some(url_of("apis/apps/v1", &replaced)));

    let (status, _, body) = fetch(&client, "/openapi/v3/apis/apps/v1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), replaced);

    let (status, _, _) = fetch(&client, "/openapi/v3/apis/batch/v1").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(fake.request_count("/openapi/v3/apis/apps/v1"), 2);
}
