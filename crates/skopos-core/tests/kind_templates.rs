//! Every create-tab template is accepted by the API server as it is (YAML authoring spec T3).
//! Kinds the cluster does not serve, such as the Gateway API, are skipped. Needs `make test-kind`.

mod support;

use std::path::Path;
use support::{connected_kind, in_namespace};

const NS: &str = "skopos-test-templates";

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn kind_every_template_passes_a_server_dry_run() {
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    let folder =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/features/editor/templates/yaml");
    let mut files: Vec<_> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    assert_eq!(files.len(), 36, "{files:?}");
    in_namespace(&client, NS, async {
        for file in &files {
            let yaml = std::fs::read_to_string(file).unwrap();
            let results = core.resource_apply_dry_run(&id, &yaml, NS).await.unwrap();
            assert_eq!(results.len(), 1, "{file:?}");
            let result = &results[0];
            if result.message.contains("unknown kind") {
                eprintln!("skipped {file:?}: {}", result.message);
                continue;
            }
            assert!(result.ok, "{file:?}: {}", result.message);
        }
    })
    .await;
}
