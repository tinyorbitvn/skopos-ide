//! `api_schema` against the fake API server (spec L5, L6, L12, L13, L29).
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

mod support;

use serde_json::{json, Map, Value};
use skopos_core::error::ErrorCode;
use skopos_fakekube::FakeKubeConfig;

use support::connected_fake;

const INDEX: &str = "/openapi/v3";
const APPS: &str = "/openapi/v3/apis/apps/v1";
const BATCH: &str = "/openapi/v3/apis/batch/v1";
const CORE: &str = "/openapi/v3/api/v1";

/// A group version's OpenAPI v3 document with one schema per kind.
fn document(group: &str, version: &str, kinds: &[&str]) -> Value {
    let schemas: Map<String, Value> = kinds
        .iter()
        .map(|kind| {
            (
                format!("io.example.{version}.{kind}"),
                json!({
                    "description": format!("{kind} for tests."),
                    "type": "object",
                    "properties": { "replicas": { "type": "integer", "format": "int32" } },
                    "x-kubernetes-group-version-kind": [
                        { "group": group, "version": version, "kind": kind }
                    ],
                }),
            )
        })
        .collect();
    json!({ "openapi": "3.0.0", "components": { "schemas": schemas } })
}

#[tokio::test]
async fn the_index_then_the_document_give_the_kind() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3(
        "apps/v1",
        document("apps", "v1", &["Deployment", "ReplicaSet"]),
    );

    let schema = core.api_schema(&id, "apps/v1", "Deployment").await.unwrap();

    assert_eq!(
        (schema.api_version.as_str(), schema.kind.as_str()),
        ("apps/v1", "Deployment")
    );
    assert_eq!(schema.description, "Deployment for tests.");
    assert_eq!(schema.fields.len(), 1);
    assert_eq!(schema.fields[0].name, "replicas");
    assert_eq!(schema.fields[0].type_label, "integer");
    assert_eq!(schema.fields[0].owner, "Deployment");
    assert_eq!(
        (fake.request_count(INDEX), fake.request_count(APPS)),
        (1, 1)
    );
}

#[tokio::test]
async fn a_second_call_and_another_kind_of_the_same_document_send_nothing() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3(
        "apps/v1",
        document("apps", "v1", &["Deployment", "ReplicaSet"]),
    );

    for kind in ["Deployment", "Deployment", "ReplicaSet", "Deployment"] {
        core.api_schema(&id, "apps/v1", kind).await.unwrap();
    }

    assert_eq!(
        (fake.request_count(INDEX), fake.request_count(APPS)),
        (1, 1)
    );
}

#[tokio::test]
async fn the_core_group_is_read_from_api_v1() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("v1", document("", "v1", &["ConfigMap"]));

    let schema = core.api_schema(&id, "v1", "ConfigMap").await.unwrap();

    assert_eq!(schema.kind, "ConfigMap");
    assert_eq!(fake.request_count(CORE), 1);
}

#[tokio::test]
async fn a_group_served_after_the_index_was_read_is_found_on_a_second_look() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("apps/v1", document("apps", "v1", &["Deployment"]));
    core.api_schema(&id, "apps/v1", "Deployment").await.unwrap();
    fake.serve_openapi_v3("batch/v1", document("batch", "v1", &["Job"]));

    let job = core.api_schema(&id, "batch/v1", "Job").await.unwrap();

    assert_eq!(job.kind, "Job");
    assert_eq!(
        (fake.request_count(INDEX), fake.request_count(BATCH)),
        (2, 1)
    );
}

#[tokio::test]
async fn a_kind_added_to_a_read_document_is_found_through_the_new_index() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("apps/v1", document("apps", "v1", &["Deployment"]));
    core.api_schema(&id, "apps/v1", "Deployment").await.unwrap();
    fake.serve_openapi_v3(
        "apps/v1",
        document("apps", "v1", &["Deployment", "StatefulSet"]),
    );

    let stateful = core
        .api_schema(&id, "apps/v1", "StatefulSet")
        .await
        .unwrap();

    assert_eq!(stateful.kind, "StatefulSet");
    assert_eq!(
        (fake.request_count(INDEX), fake.request_count(APPS)),
        (2, 2)
    );
}

#[tokio::test]
async fn a_document_replaced_before_it_was_read_is_followed_to_its_new_url() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("apps/v1", document("apps", "v1", &["Deployment"]));
    fake.serve_openapi_v3("batch/v1", document("batch", "v1", &["Job"]));
    core.api_schema(&id, "apps/v1", "Deployment").await.unwrap();
    // The kept index still names the first batch/v1 document, whose hash is now stale.
    fake.serve_openapi_v3("batch/v1", document("batch", "v1", &["Job", "CronJob"]));

    let cron = core.api_schema(&id, "batch/v1", "CronJob").await.unwrap();

    assert_eq!(cron.kind, "CronJob");
    // A redirected GET, the index read again, then the GET that is served.
    assert_eq!(
        (fake.request_count(INDEX), fake.request_count(BATCH)),
        (2, 2)
    );
}

#[tokio::test]
async fn a_cluster_with_no_openapi_v3_says_so_without_a_second_look() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;

    let err = core
        .api_schema(&id, "apps/v1", "Deployment")
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(
        err.message,
        "This cluster does not publish OpenAPI v3, so API docs are not available."
    );
    assert_eq!(fake.request_count(INDEX), 1);
}

#[tokio::test]
async fn a_group_version_with_no_document_is_not_found_after_one_more_look() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("apps/v1", document("apps", "v1", &["Deployment"]));

    let err = core
        .api_schema(&id, "nope.example.com/v1", "Thing")
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(
        err.message,
        "The cluster publishes no API docs for nope.example.com/v1."
    );
    assert_eq!(fake.request_count(INDEX), 2);
}

#[tokio::test]
async fn a_kind_the_document_lacks_is_not_found_after_one_more_look() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("apps/v1", document("apps", "v1", &["Deployment"]));

    let err = core.api_schema(&id, "apps/v1", "Gizmo").await.unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.message, "The API docs for apps/v1 have no Gizmo.");
    // The index is read twice; the document once, since its URL did not change.
    assert_eq!(
        (fake.request_count(INDEX), fake.request_count(APPS)),
        (2, 1)
    );
}

#[tokio::test]
async fn a_document_that_is_not_openapi_cannot_be_read() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("apps/v1", json!({ "hello": "world" }));

    let err = core
        .api_schema(&id, "apps/v1", "Deployment")
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::Internal);
    assert_eq!(
        err.message,
        "The cluster's API docs for apps/v1 could not be read."
    );
}

#[tokio::test]
async fn bad_input_is_refused_before_any_request() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let bad_version = "apiVersion must read ‹version› or ‹group›/‹version›.";

    for (api_version, kind, message) in [
        ("a/b/c", "Thing", bad_version),
        ("/v1", "Thing", bad_version),
        ("v1", " ", "kind is empty."),
    ] {
        let err = core.api_schema(&id, api_version, kind).await.unwrap_err();
        assert_eq!(
            (err.code, err.message.as_str()),
            (ErrorCode::InvalidInput, message),
            "{api_version} {kind}"
        );
    }
    assert_eq!(fake.request_count(INDEX), 0);
}

#[tokio::test]
async fn a_disconnect_drops_what_was_read() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_openapi_v3("apps/v1", document("apps", "v1", &["Deployment"]));
    core.api_schema(&id, "apps/v1", "Deployment").await.unwrap();

    core.cluster_disconnect(&id).await.unwrap();
    let err = core
        .api_schema(&id, "apps/v1", "Deployment")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);

    core.cluster_connect(&id).await.unwrap();
    core.api_schema(&id, "apps/v1", "Deployment").await.unwrap();
    assert_eq!(
        (fake.request_count(INDEX), fake.request_count(APPS)),
        (2, 2)
    );
}
