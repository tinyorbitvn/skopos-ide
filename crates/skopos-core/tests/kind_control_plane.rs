//! `cluster_control_plane` and `nodes_disk_usage` against the `skopos-e2e` kind cluster, a
//! kubeadm cluster. Needs `make test-kind`; only `e2e/.tmp/kubeconfig` is read.

mod support;

use k8s_openapi::api::core::v1::Node;
use kube::api::ListParams;
use kube::Api;
use skopos_core::cluster::HealthState;
use support::connected_kind;

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn kubeadm_control_plane_is_healthy() {
    let (core, id, _root) = connected_kind().await;
    let plane = core.cluster_control_plane(&id).await.unwrap();

    let api = &plane.api_server;
    assert!(api.url.starts_with("https://"), "{}", api.url);
    assert!(api.version.starts_with('v'), "{}", api.version);
    assert_eq!(
        (api.live, api.ready),
        (HealthState::Healthy, HealthState::Healthy)
    );
    assert!(!api.checks.is_empty());
    assert!(api.checks.iter().all(|check| check.ok), "{:?}", api.checks);

    let ids: Vec<_> = plane.components.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        ["etcd", "scheduler", "controller-manager", "dns", "proxy"]
    );
    for component in &plane.components {
        assert_eq!(component.state, HealthState::Healthy, "{component:?}");
        let pods = component.pods.expect("pods are visible");
        assert!(pods.total > 0 && pods.ready == pods.total, "{component:?}");
    }
    for id in ["scheduler", "controller-manager"] {
        let component = plane.components.iter().find(|c| c.id == id).unwrap();
        let leader = component.leader.as_ref().expect("a leader");
        assert!(!leader.holder.is_empty(), "{id}");
    }
    let etcd = &plane.components[0];
    assert_eq!(etcd.check, Some(true));
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn node_disk_use_is_read_through_the_node_proxy() {
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    let nodes = Api::<Node>::all(client)
        .list(&ListParams::default())
        .await
        .unwrap();
    let names: Vec<String> = nodes
        .items
        .iter()
        .filter_map(|node| node.metadata.name.clone())
        .collect();
    assert!(!names.is_empty());

    let snapshot = core.nodes_disk_usage(&id, &names).await.unwrap();
    let mut listed: Vec<_> = snapshot.items.iter().map(|d| d.name.clone()).collect();
    let mut expected = names.clone();
    listed.sort();
    expected.sort();
    assert_eq!(listed, expected);
    for disk in &snapshot.items {
        assert!(disk.used_bytes > 0, "{disk:?}");
        assert!(disk.capacity_bytes >= disk.used_bytes, "{disk:?}");
    }
}
