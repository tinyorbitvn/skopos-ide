//! `volumes_usage` against the real `skopos-e2e` kind cluster. Needs `make test-kind`; only
//! `e2e/.tmp/kubeconfig` is read, never a default one.
//! kind's `standard` class provisions host-path volumes, which the kubelet may not measure
//! (spec §11), so the read must succeed and what it reports must hold together; the claim
//! itself may be missing.

mod support;

use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod};
use kube::api::PostParams;
use kube::Api;
use serde_json::json;
use support::{connected_kind, create_pod, in_namespace, wait_running, TEST_IMAGE};

const NAMESPACE: &str = "skopos-test-volumes";

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn the_claims_a_pod_mounts_are_read_through_its_nodes_kubelet() {
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, NAMESPACE, async {
        let claims: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), NAMESPACE);
        let claim: PersistentVolumeClaim = serde_json::from_value(json!({
            "metadata": { "name": "data" },
            "spec": {
                "accessModes": ["ReadWriteOnce"],
                "storageClassName": "standard",
                "resources": { "requests": { "storage": "16Mi" } },
            },
        }))
        .unwrap();
        claims.create(&PostParams::default(), &claim).await.unwrap();
        // kind's class binds a claim once a Pod uses it, so the Pod runs once it is Bound.
        create_pod(
            &client,
            NAMESPACE,
            json!({
                "metadata": { "name": "writer" },
                "spec": {
                    "containers": [{
                        "name": "main",
                        "image": TEST_IMAGE,
                        "args": ["pause"],
                        "volumeMounts": [{ "name": "data", "mountPath": "/data" }],
                    }],
                    "volumes": [{ "name": "data", "persistentVolumeClaim": { "claimName": "data" } }],
                },
            }),
        )
        .await;
        wait_running(&client, NAMESPACE, "writer").await;
        let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
        let node = pods
            .get("writer")
            .await
            .unwrap()
            .spec
            .and_then(|spec| spec.node_name)
            .expect("a running Pod has a node");

        let snapshot = core.volumes_usage(&id, std::slice::from_ref(&node)).await.unwrap();

        assert!(snapshot
            .timestamp
            .parse::<k8s_openapi::jiff::Timestamp>()
            .is_ok());
        let keys: Vec<_> = snapshot
            .items
            .iter()
            .map(|item| (item.namespace.clone(), item.claim.clone()))
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(keys, sorted, "one item per claim, by namespace and claim");
        for item in &snapshot.items {
            assert_eq!(item.node, node, "{item:?}");
            assert!(item.capacity_bytes > 0, "{item:?}");
            assert!(item.capacity_bytes >= item.used_bytes, "{item:?}");
        }
        let ours: Vec<_> = snapshot
            .items
            .iter()
            .filter(|item| item.namespace == NAMESPACE)
            .collect();
        assert!(ours.iter().all(|item| item.claim == "data"), "{ours:?}");
        eprintln!(
            "the kubelet of {node} reports {} mounted claims, {} of them in {NAMESPACE}",
            snapshot.items.len(),
            ours.len()
        );
    })
    .await;
}
