//! Server dry runs of create and edit text (YAML authoring spec A10). Needs `make test-kind`.

mod support;

use serde_json::Value;
use skopos_core::error::ErrorCode;
use skopos_core::resources::ResourceRef;
use support::{connected_kind, in_namespace};

const NS: &str = "skopos-test-dry-run";

fn configmaps() -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "configmaps".into(),
        kind: "ConfigMap".into(),
        namespaced: true,
    }
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn kind_apply_dry_run_reports_each_document_and_writes_nothing() {
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, NS, async {
        let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: dry\ndata:\n  a: b\n---\napiVersion: e2e.invalid/v1\nkind: NoSuchKind\nmetadata:\n  name: bad\n";
        let results = core.resource_apply_dry_run(&id, yaml, NS).await.unwrap();
        assert_eq!(results.len(), 2, "{results:?}");
        assert!(results[0].ok, "{:?}", results[0]);
        assert_eq!(results[0].namespace.as_deref(), Some(NS));
        assert!(!results[1].ok, "{:?}", results[1]);
        let read = core.resource_get(&id, &configmaps(), Some(NS), "dry").await.unwrap_err();
        assert_eq!(read.code, ErrorCode::NotFound);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn kind_replace_dry_run_ignores_a_stale_version_and_writes_nothing() {
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, NS, async {
        let created = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: edited\ndata:\n  a: before\n";
        assert!(core.resource_apply(&id, created, NS).await.unwrap()[0].ok);
        let stale = format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: edited\n  namespace: {NS}\n  resourceVersion: \"1\"\ndata:\n  a: after\n");
        let answer: Value = core.resource_replace_dry_run(&id, &configmaps(), Some(NS), "edited", &stale).await.unwrap();
        assert_eq!(answer["data"]["a"], "after");
        let stored = core.resource_get(&id, &configmaps(), Some(NS), "edited").await.unwrap();
        assert_eq!(stored["data"]["a"], "before");
    })
    .await;
}
