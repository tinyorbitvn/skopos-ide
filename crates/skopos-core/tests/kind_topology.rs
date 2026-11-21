//! The node topology against the real `skopos-e2e` kind cluster (topology spec §8).
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::Node;
use kube::api::{Patch, PatchParams};
use kube::Api;
use serde_json::{json, Map, Value};
use skopos_core::topology::{NodeReady, PodState, TopologyEvent, TopologyNode, TopologySnapshot};
use support::connected_kind;
use tokio::sync::mpsc;

const WORKER: &str = "skopos-e2e-worker";
const CONTROL_PLANE: &str = "skopos-e2e-control-plane";
const ZONE_LABEL: &str = "topology.kubernetes.io/zone";
const ZONE: &str = "skopos-test-zone";
const WAIT: Duration = Duration::from_secs(60);

/// A merge patch that sets the worker's zone label, or removes it.
fn zone_patch(zone: Option<&str>) -> Value {
    let mut labels = Map::new();
    labels.insert(
        ZONE_LABEL.to_owned(),
        zone.map_or(Value::Null, |zone| Value::String(zone.to_owned())),
    );
    json!({ "metadata": { "labels": labels } })
}

/// The first snapshot `done` accepts, within `WAIT`.
async fn snapshot_where(
    rx: &mut mpsc::Receiver<Arc<TopologyEvent>>,
    done: impl Fn(&TopologySnapshot) -> bool,
) -> TopologySnapshot {
    let deadline = Instant::now() + WAIT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some(event)) => match event.as_ref() {
                TopologyEvent::Snapshot { snapshot } if done(snapshot) => {
                    return snapshot.clone();
                }
                TopologyEvent::Snapshot { .. } => {}
                TopologyEvent::Failure { message } => panic!("the topology failed: {message}"),
            },
            Ok(None) => panic!("the topology ended"),
            Err(_) => panic!("no matching snapshot within {WAIT:?}"),
        }
    }
}

/// A node with the name of the zone it sits in.
fn find<'a>(
    snapshot: &'a TopologySnapshot,
    name: &str,
) -> Option<(Option<&'a str>, &'a TopologyNode)> {
    snapshot
        .regions
        .iter()
        .flat_map(|region| &region.zones)
        .find_map(|zone| {
            zone.nodes
                .iter()
                .find(|node| node.name == name)
                .map(|node| (zone.name.as_deref(), node))
        })
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn the_topology_places_the_kind_nodes_by_zone_with_their_pods() {
    let (core, id, _root) = connected_kind().await;
    let nodes: Api<Node> = Api::all(core.cluster_client(&id).unwrap());
    let body = async {
        nodes
            .patch(
                WORKER,
                &PatchParams::default(),
                &Patch::Merge(zone_patch(Some(ZONE))),
            )
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::channel(16);
        let subscription = core.node_topology_subscribe(&id, tx, "main").unwrap();
        let snapshot = snapshot_where(&mut rx, |s| {
            find(s, WORKER).is_some_and(|(zone, _)| zone == Some(ZONE))
        })
        .await;

        let (_, worker) = find(&snapshot, WORKER).unwrap();
        let (control_zone, control_plane) =
            find(&snapshot, CONTROL_PLANE).expect("the control plane is listed");
        assert_eq!(control_zone, None);
        assert!(
            control_plane
                .roles
                .iter()
                .any(|role| role == "control-plane"),
            "{:?}",
            control_plane.roles
        );
        assert_eq!(worker.ready, NodeReady::Ready);
        assert!(worker.allocatable.cpu_millis.is_some_and(|cpu| cpu > 0));
        assert!(worker
            .allocatable
            .memory_bytes
            .is_some_and(|memory| memory > 0));
        assert!(
            worker
                .pods
                .iter()
                .any(|pod| pod.namespace == "kube-system" && pod.state == PodState::Running),
            "{:?}",
            worker.pods
        );
        assert!(worker.requests.cpu_millis.is_some());
        assert!(!snapshot.pods_hidden);
        assert!(snapshot.node_count >= 2);
        core.node_topology_unsubscribe(&subscription);
    };
    let outcome = AssertUnwindSafe(body).catch_unwind().await;
    let removed = nodes
        .patch(
            WORKER,
            &PatchParams::default(),
            &Patch::Merge(zone_patch(None)),
        )
        .await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    removed.unwrap();
}
