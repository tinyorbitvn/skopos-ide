//! The node topology against the fake API server (topology spec §8).
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::topology::{PodState, TopologyEvent, TopologySnapshot};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig};
use support::connected_fake;
use tempfile::TempDir;
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(10);
const INTERVAL: Duration = Duration::from_millis(500);
const FAST_BATCH: Duration = Duration::from_millis(20);
const SHORT_LINGER: Duration = Duration::from_millis(200);
/// Longer than the interval, so a second snapshot would have come by then.
const QUIET: Duration = Duration::from_millis(700);

async fn connected(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let (core, fake, id, root) = connected_fake(cfg).await;
    core.set_watch_timing_for_test(FAST_BATCH, SHORT_LINGER);
    core.set_topology_interval_for_test(INTERVAL);
    (core, fake, id, root)
}

async fn eventually(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn node(name: &str, zone: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Node",
        "metadata": { "name": name, "labels": { "topology.kubernetes.io/zone": zone } },
        "spec": {},
        "status": {
            "allocatable": { "cpu": "4", "memory": "16Gi", "pods": "110" },
            "conditions": [{ "type": "Ready", "status": "True" }],
        },
    })
}

fn pod(namespace: &str, name: &str, node: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": { "name": name, "namespace": namespace },
        "spec": {
            "nodeName": node,
            "containers": [{ "name": "app", "resources": { "requests": { "cpu": "250m", "memory": "64Mi" } } }],
        },
        "status": {
            "phase": "Running",
            "conditions": [{ "type": "Ready", "status": "True" }],
            "containerStatuses": [{ "name": "app", "ready": true, "restartCount": 0, "state": { "running": {} } }],
        },
    })
}

/// Each node as (zone, name, pods as `namespace/name`), in order.
fn layout(snapshot: &TopologySnapshot) -> Vec<(Option<String>, String, Vec<String>)> {
    snapshot
        .regions
        .iter()
        .flat_map(|region| &region.zones)
        .flat_map(|zone| {
            zone.nodes.iter().map(move |node| {
                (
                    zone.name.clone(),
                    node.name.clone(),
                    node.pods
                        .iter()
                        .map(|p| format!("{}/{}", p.namespace, p.name))
                        .collect(),
                )
            })
        })
        .collect()
}

fn into_snapshot(event: Option<Arc<TopologyEvent>>) -> TopologySnapshot {
    match event.as_deref() {
        Some(TopologyEvent::Snapshot { snapshot }) => snapshot.clone(),
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

struct Subscription {
    id: String,
    rx: mpsc::Receiver<Arc<TopologyEvent>>,
}

impl Subscription {
    fn start(core: &AppCore, cluster: &ClusterId) -> Self {
        Self::start_as(core, cluster, "main")
    }

    /// Subscribes as the window `owner`.
    fn start_as(core: &AppCore, cluster: &ClusterId, owner: &str) -> Self {
        let (tx, rx) = mpsc::channel(16);
        let id = core.node_topology_subscribe(cluster, tx, owner).unwrap();
        Self { id, rx }
    }

    async fn next(&mut self) -> Option<Arc<TopologyEvent>> {
        tokio::time::timeout(WAIT, self.rx.recv())
            .await
            .expect("timed out waiting for an event")
    }

    async fn snapshot(&mut self) -> TopologySnapshot {
        into_snapshot(self.next().await)
    }

    async fn quiet(&mut self, period: Duration) {
        if let Ok(event) = tokio::time::timeout(period, self.rx.recv()).await {
            panic!("expected nothing, got {event:?}");
        }
    }

    async fn ended(&mut self) {
        let event = self.next().await;
        assert!(event.is_none(), "expected the end, got {event:?}");
    }
}

fn seed(fake: &FakeKube) {
    fake.upsert("nodes", node("worker-1", "a"));
    fake.upsert("nodes", node("worker-2", "b"));
    fake.upsert("pods", pod("shop", "web-1", "worker-1"));
    fake.upsert("pods", pod("shop", "web-2", "worker-2"));
    fake.upsert("pods", pod("shop", "lost", "deleted-node"));
}

#[tokio::test]
async fn the_topology_streams_a_snapshot_of_nodes_and_their_pods() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    seed(&fake);
    let mut sub = Subscription::start(&core, &id);
    let event = sub.next().await.expect("a snapshot");
    let json = serde_json::to_value(&*event).unwrap();
    let snapshot = into_snapshot(Some(event));

    assert_eq!(
        layout(&snapshot),
        [
            (
                Some("a".to_owned()),
                "worker-1".to_owned(),
                vec!["shop/web-1".to_owned()]
            ),
            (
                Some("b".to_owned()),
                "worker-2".to_owned(),
                vec!["shop/web-2".to_owned()]
            ),
        ]
    );
    assert_eq!((snapshot.node_count, snapshot.pod_count), (2, 2));
    assert!(!snapshot.pods_hidden);
    let worker = &snapshot.regions[0].zones[0].nodes[0];
    assert_eq!(worker.requests.cpu_millis, Some(250));
    assert_eq!(worker.requests.memory_bytes, Some(64 << 20));
    assert_eq!(worker.allocatable.cpu_millis, Some(4000));
    assert_eq!(worker.pods[0].state, PodState::Running);
    assert_eq!(json["type"], "snapshot");
    assert_eq!(
        json["snapshot"]["regions"][0]["zones"][0]["nodes"][0]["allocatable"]["cpuMillis"],
        4000
    );
}

#[tokio::test]
async fn each_change_sends_one_new_snapshot() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("nodes", node("worker-1", "a"));
    fake.upsert("pods", pod("shop", "web-1", "worker-1"));
    let mut sub = Subscription::start(&core, &id);
    sub.snapshot().await;

    fake.upsert("nodes", node("worker-2", "a"));
    let added = sub.snapshot().await;
    assert_eq!(added.node_count, 2);
    sub.quiet(QUIET).await;

    fake.upsert("pods", pod("shop", "web-1", "worker-2"));
    let moved = sub.snapshot().await;
    assert_eq!(
        layout(&moved),
        [
            (Some("a".to_owned()), "worker-1".to_owned(), Vec::new()),
            (
                Some("a".to_owned()),
                "worker-2".to_owned(),
                vec!["shop/web-1".to_owned()]
            ),
        ]
    );
    sub.quiet(QUIET).await;

    fake.delete("pods", Some("shop"), "web-1");
    let deleted = sub.snapshot().await;
    assert_eq!(deleted.pod_count, 0);
    sub.quiet(QUIET).await;

    let mut cordoned = node("worker-1", "a");
    cordoned["spec"]["unschedulable"] = json!(true);
    fake.upsert("nodes", cordoned);
    let later = sub.snapshot().await;
    assert!(later.regions[0].zones[0].nodes[0].unschedulable);
    sub.quiet(QUIET).await;
}

#[tokio::test]
async fn a_change_the_topology_does_not_read_sends_nothing() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    seed(&fake);
    let mut sub = Subscription::start(&core, &id);
    sub.snapshot().await;

    let mut annotated = node("worker-1", "a");
    annotated["metadata"]["annotations"] = json!({ "note": "changed" });
    fake.upsert("nodes", annotated);
    let mut labelled = pod("shop", "web-1", "worker-1");
    labelled["metadata"]["labels"] = json!({ "app": "web" });
    fake.upsert("pods", labelled);
    sub.quiet(QUIET).await;
}

#[tokio::test]
async fn subscribers_share_one_topology_and_it_stops_after_the_last() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    seed(&fake);
    let mut first = Subscription::start(&core, &id);
    let mut second = Subscription::start(&core, &id);
    let a = first.next().await.expect("a snapshot");
    let b = second.next().await.expect("a snapshot");
    assert!(Arc::ptr_eq(&a, &b), "one build, one shared event");
    assert_eq!(core.running_topologies_for_test(), 1);

    core.node_topology_unsubscribe(&first.id);
    first.ended().await;
    core.node_topology_unsubscribe("topology-unknown");
    tokio::time::sleep(SHORT_LINGER * 2).await;
    assert_eq!(core.running_topologies_for_test(), 1, "the second keeps it");

    core.node_topology_unsubscribe(&second.id);
    second.ended().await;
    eventually("the topology to stop", || {
        core.running_topologies_for_test() == 0
    })
    .await;
    eventually("the watches to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn a_window_s_topology_ends_with_it_and_another_window_s_goes_on() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    seed(&fake);
    let mut kept = Subscription::start_as(&core, &id, "main");
    let mut ended = Subscription::start_as(&core, &id, "window-2");
    kept.snapshot().await;
    ended.snapshot().await;

    core.subscriptions_stop_owned("window-2");

    ended.ended().await;
    // The topology and the rows it reads belong to no window: the other one still follows
    // them.
    fake.upsert("nodes", node("worker-3", "a"));
    assert_eq!(kept.snapshot().await.node_count, 3);
    assert_eq!(core.running_topologies_for_test(), 1);
}

#[tokio::test]
async fn forbidden_pods_hide_the_pods_and_keep_the_nodes() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "pods".into(),
            namespace: None,
        }],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(cfg).await;
    seed(&fake);
    let mut sub = Subscription::start(&core, &id);
    let snapshot = sub.snapshot().await;
    assert!(snapshot.pods_hidden);
    assert_eq!((snapshot.node_count, snapshot.pod_count), (2, 0));
    let worker = &snapshot.regions[0].zones[0].nodes[0];
    assert!(worker.pods.is_empty());
    assert_eq!(worker.requests.cpu_millis, None);
}

#[tokio::test]
async fn forbidden_nodes_end_the_topology_with_a_failure() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "nodes".into(),
            namespace: None,
        }],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(cfg).await;
    seed(&fake);
    let mut sub = Subscription::start(&core, &id);
    match sub.next().await.as_deref() {
        Some(TopologyEvent::Failure { message }) => {
            assert!(
                message.starts_with("Listing nodes is not allowed"),
                "{message}"
            );
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    sub.ended().await;
    eventually("the topology to stop", || {
        core.running_topologies_for_test() == 0
    })
    .await;
}

#[tokio::test]
async fn malformed_rows_are_unknown_never_a_crash() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut odd_node = node("worker-1", "a");
    odd_node["status"]["allocatable"] = json!({ "cpu": "lots", "memory": "16Gi" });
    fake.upsert("nodes", odd_node);
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "odd", "namespace": "shop" },
            "spec": { "nodeName": "worker-1", "containers": "x" },
            "status": { "phase": 42 },
        }),
    );
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "weird", "namespace": "shop" },
            "spec": { "nodeName": "worker-1" },
            "status": { "phase": "Weird" },
        }),
    );
    let mut sub = Subscription::start(&core, &id);
    let snapshot = sub.snapshot().await;
    let worker = &snapshot.regions[0].zones[0].nodes[0];
    assert_eq!(worker.allocatable.cpu_millis, None);
    assert_eq!(
        worker
            .pods
            .iter()
            .map(|p| (p.name.as_str(), p.state))
            .collect::<Vec<_>>(),
        [("odd", PodState::Unknown), ("weird", PodState::Unknown)]
    );
}

#[tokio::test]
async fn a_closed_receiver_stops_the_topology_and_its_watches() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    seed(&fake);
    let mut sub = Subscription::start(&core, &id);
    sub.snapshot().await;
    drop(sub);
    eventually("the topology to stop", || {
        core.running_topologies_for_test() == 0
    })
    .await;
    eventually("the watches to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn a_disconnect_ends_the_subscription_and_refuses_new_ones() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    seed(&fake);
    let mut sub = Subscription::start(&core, &id);
    sub.snapshot().await;

    core.cluster_disconnect(&id).await.unwrap();
    sub.ended().await;
    assert_eq!(core.running_topologies_for_test(), 0);
    let (tx, _rx) = mpsc::channel(1);
    let refused = core.node_topology_subscribe(&id, tx, "main").unwrap_err();
    assert_eq!(refused.code, ErrorCode::InvalidInput);
}
