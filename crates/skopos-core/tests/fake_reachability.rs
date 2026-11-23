//! The reachability hub against the fake API server (spec §9, Review Focus 2).
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::reachability::{
    NotEvaluated, PolicyRef, ReachCell, ReachCounts, ReachEvent, ReachGroup, ReachMissing,
    ReachPeer, ReachPolicySource, ReachPort, ReachProtocol, ReachVerdict,
};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "fake";
const CILIUM: &str = "cilium.io";
const WAIT: Duration = Duration::from_secs(10);
const INTERVAL: Duration = Duration::from_millis(500);
const FAST_BATCH: Duration = Duration::from_millis(20);
const SHORT_LINGER: Duration = Duration::from_millis(200);
/// Longer than the interval, so a second snapshot would have come by then.
const QUIET: Duration = Duration::from_millis(700);
const WEB: &str = "Deployment/shop/web";
const API: &str = "StatefulSet/shop/api";

/// The kinds the hub reads that the fake does not serve by default; with `cilium`, the two
/// Cilium policy kinds at `cilium.io/v2` too.
fn reach_resources(cilium: bool) -> Vec<FakeResource> {
    let mut resources = vec![
        FakeResource::new("apps", "v1", "ReplicaSet", "replicasets", true),
        FakeResource::new("batch", "v1", "Job", "jobs", true),
        FakeResource::new(
            "networking.k8s.io",
            "v1",
            "NetworkPolicy",
            "networkpolicies",
            true,
        ),
    ];
    if cilium {
        resources.extend([
            FakeResource::new(
                CILIUM,
                "v2",
                "CiliumNetworkPolicy",
                "ciliumnetworkpolicies",
                true,
            ),
            FakeResource::new(
                CILIUM,
                "v2",
                "CiliumClusterwideNetworkPolicy",
                "ciliumclusterwidenetworkpolicies",
                false,
            ),
        ]);
    }
    resources
}

/// Discovery is read when the cluster connects, so the kinds are served before that.
async fn connected(cfg: FakeKubeConfig, cilium: bool) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    for resource in reach_resources(cilium) {
        fake.serve_resource(resource);
    }
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    fake.write_kubeconfig(&kube_dir.join("config"), CONTEXT)
        .unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    core.set_watch_timing_for_test(FAST_BATCH, SHORT_LINGER);
    core.set_reachability_interval_for_test(INTERVAL);
    let started = Instant::now();
    let id = loop {
        let found = core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == CONTEXT);
        if let Some(entry) = found {
            break entry.id;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "no catalog entry"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    (core, fake, id, root)
}

async fn eventually(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The user may not list `plural`, in any namespace.
fn deny_list(plural: &str) -> FakeKubeConfig {
    FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: plural.into(),
            namespace: None,
        }],
        ..Default::default()
    }
}

fn namespace(name: &str) -> Value {
    json!({
        "metadata": { "name": name, "labels": { "kubernetes.io/metadata.name": name } },
        "spec": {},
        "status": { "phase": "Active" },
    })
}

fn controller(kind: &str, name: &str) -> Value {
    json!([{ "apiVersion": "apps/v1", "kind": kind, "name": name, "uid": format!("{name}-uid"), "controller": true }])
}

/// A running Pod labelled `app=<app>`, with the container port `http` 8080.
fn pod(namespace: &str, name: &str, app: &str, owners: Value) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": { "name": name, "namespace": namespace, "labels": { "app": app }, "ownerReferences": owners },
        "spec": {
            "serviceAccountName": "default",
            "containers": [{ "name": "app", "ports": [{ "name": "http", "containerPort": 8080, "protocol": "TCP" }] }],
        },
        "status": { "phase": "Running" },
    })
}

/// In `shop`: Deployment `web` (ReplicaSet `web-1`, two Pods), StatefulSet `api` (one Pod) and
/// the NetworkPolicy `allow-web`, which lets api reach web on 8080; with `cilium`, the
/// CiliumNetworkPolicy `api-ingress` too, which lets web reach api on 8080. In `other`: a Pod
/// labelled `app=api` that no rule of `shop` names, since a `podSelector` alone stays in `shop`.
fn seed(fake: &FakeKube, cilium: bool) {
    fake.upsert("namespaces", namespace("shop"));
    fake.upsert("namespaces", namespace("other"));
    fake.upsert(
        "replicasets",
        json!({
            "metadata": { "name": "web-1", "namespace": "shop", "ownerReferences": controller("Deployment", "web") },
            "spec": { "replicas": 2 },
            "status": { "replicas": 2, "readyReplicas": 2 },
        }),
    );
    fake.upsert(
        "pods",
        pod("shop", "web-1-a", "web", controller("ReplicaSet", "web-1")),
    );
    fake.upsert(
        "pods",
        pod("shop", "web-1-b", "web", controller("ReplicaSet", "web-1")),
    );
    fake.upsert(
        "pods",
        pod("shop", "api-0", "api", controller("StatefulSet", "api")),
    );
    fake.upsert("pods", pod("other", "tool", "api", json!([])));
    fake.upsert(
        "networkpolicies",
        json!({
            "metadata": { "name": "allow-web", "namespace": "shop" },
            "spec": {
                "podSelector": { "matchLabels": { "app": "web" } },
                "policyTypes": ["Ingress"],
                "ingress": [{
                    "from": [{ "podSelector": { "matchLabels": { "app": "api" } } }],
                    "ports": [{ "protocol": "TCP", "port": 8080 }],
                }],
            },
        }),
    );
    if cilium {
        fake.upsert(
            "ciliumnetworkpolicies",
            json!({
                "metadata": { "name": "api-ingress", "namespace": "shop" },
                "spec": {
                    "endpointSelector": { "matchLabels": { "app": "api" } },
                    "ingress": [{
                        "fromEndpoints": [{ "matchLabels": { "app": "web" } }],
                        "toPorts": [{ "ports": [{ "port": "8080", "protocol": "TCP" }] }],
                    }],
                },
            }),
        );
    }
}

/// A snapshot event's fields, and the event as it crosses to the interface.
struct Snapshot {
    namespace: String,
    groups: Vec<ReachGroup>,
    peers: Vec<ReachPeer>,
    cells: Vec<ReachCell>,
    counts: ReachCounts,
    not_evaluated: Vec<NotEvaluated>,
    missing: Vec<ReachMissing>,
    cilium: bool,
    truncated: u32,
    json: Value,
}

impl Snapshot {
    fn group_ids(&self) -> Vec<&str> {
        self.groups.iter().map(|g| g.id.as_str()).collect()
    }
}

fn into_snapshot(event: Option<Arc<ReachEvent>>) -> Snapshot {
    let Some(event) = event else {
        panic!("the subscription ended");
    };
    let json = serde_json::to_value(event.as_ref()).unwrap();
    match Arc::unwrap_or_clone(event) {
        ReachEvent::Snapshot {
            namespace,
            groups,
            peers,
            cells,
            counts,
            not_evaluated,
            missing,
            cilium,
            truncated,
        } => Snapshot {
            namespace,
            groups,
            peers,
            cells,
            counts,
            not_evaluated,
            missing,
            cilium,
            truncated,
            json,
        },
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

struct Subscription {
    id: String,
    rx: mpsc::Receiver<Arc<ReachEvent>>,
}

impl Subscription {
    fn start(core: &AppCore, cluster: &ClusterId, namespace: &str) -> Self {
        Self::start_as(core, cluster, namespace, "main")
    }

    /// The page in the window `owner`.
    fn start_as(core: &AppCore, cluster: &ClusterId, namespace: &str, owner: &str) -> Self {
        let (tx, rx) = mpsc::channel(16);
        let id = core
            .network_reachability_subscribe(cluster, namespace.to_owned(), tx, owner)
            .unwrap();
        Self { id, rx }
    }

    async fn next(&mut self) -> Option<Arc<ReachEvent>> {
        tokio::time::timeout(WAIT, self.rx.recv())
            .await
            .expect("timed out waiting for an event")
    }

    async fn snapshot(&mut self) -> Snapshot {
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

fn tcp(port: u16) -> ReachPort {
    ReachPort {
        protocol: ReachProtocol::Tcp,
        port: Some(port),
        end_port: None,
        name: None,
        http: Vec::new(),
    }
}

fn policy(source: ReachPolicySource, name: &str) -> PolicyRef {
    PolicyRef {
        source,
        namespace: "shop".to_owned(),
        name: name.to_owned(),
    }
}

/// The cells by source, then destination: the order the core sends them in is its own.
fn sorted_cells(mut cells: Vec<ReachCell>) -> Vec<ReachCell> {
    cells.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
    cells
}

#[tokio::test]
async fn a_namespace_s_snapshot_holds_its_workloads_and_the_cells_its_policies_allow() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed(&fake, true);
    let mut sub = Subscription::start(&core, &id, "shop");
    assert!(sub.id.starts_with("reach-"), "{}", sub.id);
    let snapshot = sub.snapshot().await;

    assert_eq!(snapshot.namespace, "shop");
    assert_eq!(
        snapshot.groups,
        [
            ReachGroup {
                id: API.into(),
                kind: "StatefulSet".into(),
                name: "api".into(),
                pods: 1,
                labels: vec!["app=api".into()],
                policies: vec![policy(ReachPolicySource::Cilium, "api-ingress")],
                ingress_isolated: true,
                egress_isolated: false,
            },
            ReachGroup {
                id: WEB.into(),
                kind: "Deployment".into(),
                name: "web".into(),
                pods: 2,
                labels: vec!["app=web".into()],
                policies: vec![policy(ReachPolicySource::Kubernetes, "allow-web")],
                ingress_isolated: true,
                egress_isolated: false,
            },
        ]
    );
    let peers: Vec<(&str, &str)> = snapshot
        .peers
        .iter()
        .map(|p| (p.id.as_str(), p.label.as_str()))
        .collect();
    assert_eq!(
        peers,
        [
            ("otherPods", "Other Pods in the cluster"),
            ("world", "Outside the cluster"),
        ],
        "a rule that names Pods of `shop` alone gives no outside peer"
    );
    assert_eq!(
        sorted_cells(snapshot.cells),
        [
            ReachCell {
                from: WEB.into(),
                to: API.into(),
                verdict: ReachVerdict::Allowed,
                ports: vec![tcp(8080)],
                policies: vec![policy(ReachPolicySource::Cilium, "api-ingress")],
                some_pods: false,
            },
            ReachCell {
                from: API.into(),
                to: WEB.into(),
                verdict: ReachVerdict::Allowed,
                ports: vec![tcp(8080)],
                policies: vec![policy(ReachPolicySource::Kubernetes, "allow-web")],
                some_pods: false,
            },
        ],
        "every other cell follows from the isolation flags (R4)"
    );
    assert_eq!(
        snapshot.counts,
        ReachCounts {
            kubernetes: 1,
            cilium: 1
        }
    );
    assert!(snapshot.cilium);
    assert!(
        snapshot.not_evaluated.is_empty(),
        "{:?}",
        snapshot.not_evaluated
    );
    assert!(snapshot.missing.is_empty(), "{:?}", snapshot.missing);
    assert_eq!(snapshot.truncated, 0);
    assert_eq!(snapshot.json["type"], "snapshot");
    assert_eq!(snapshot.json["notEvaluated"], json!([]));
    assert_eq!(snapshot.json["groups"][0]["ingressIsolated"], true);
    assert_eq!(snapshot.json["cells"][0]["verdict"], "allowed");
    assert_eq!(snapshot.json["cells"][0]["somePods"], false);
    assert_eq!(snapshot.json["cells"][0]["ports"][0]["protocol"], "TCP");
}

#[tokio::test]
async fn subscriptions_of_one_cluster_share_one_hub_and_it_stops_after_the_last() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    seed(&fake, false);
    let mut first = Subscription::start(&core, &id, "shop");
    let mut second = Subscription::start(&core, &id, "shop");
    let mut other = Subscription::start(&core, &id, "other");
    let a = first.next().await.expect("a snapshot");
    let b = second.next().await.expect("a snapshot");
    let c = other.snapshot().await;
    assert!(
        Arc::ptr_eq(&a, &b),
        "one build and namespace, one shared event"
    );
    assert_eq!(c.namespace, "other");
    assert_eq!(c.group_ids(), ["Pod/other/tool"]);
    assert_eq!(core.running_reachabilities_for_test(), 1);

    core.network_reachability_unsubscribe(&first.id);
    first.ended().await;
    core.network_reachability_unsubscribe(&other.id);
    other.ended().await;
    core.network_reachability_unsubscribe("reach-unknown");
    tokio::time::sleep(SHORT_LINGER * 2).await;
    assert_eq!(
        core.running_reachabilities_for_test(),
        1,
        "the second keeps it"
    );

    core.network_reachability_unsubscribe(&second.id);
    second.ended().await;
    eventually("the hub to stop", || {
        core.running_reachabilities_for_test() == 0
    })
    .await;
    eventually("the watches to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn a_change_elsewhere_sends_nothing_and_one_in_the_namespace_a_new_snapshot() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    seed(&fake, false);
    let mut sub = Subscription::start(&core, &id, "shop");
    sub.snapshot().await;

    fake.upsert("pods", pod("other", "tool-2", "tool", json!([])));
    sub.quiet(QUIET).await;

    fake.upsert(
        "pods",
        pod("shop", "web-1-c", "web", controller("ReplicaSet", "web-1")),
    );
    let later = sub.snapshot().await;
    let pods: Vec<(&str, u32)> = later
        .groups
        .iter()
        .map(|g| (g.name.as_str(), g.pods))
        .collect();
    assert_eq!(pods, [("api", 1), ("web", 3)]);
    sub.quiet(QUIET).await;
}

#[tokio::test]
async fn a_window_s_reachability_ends_with_it_and_another_window_s_goes_on() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    seed(&fake, false);
    let mut kept = Subscription::start_as(&core, &id, "shop", "main");
    let mut ended = Subscription::start_as(&core, &id, "shop", "window-2");
    kept.snapshot().await;
    ended.snapshot().await;

    core.subscriptions_stop_owned("window-2");

    ended.ended().await;
    // The hub and the rows it reads belong to no window: the other one still follows them.
    fake.upsert(
        "pods",
        pod("shop", "web-1-c", "web", controller("ReplicaSet", "web-1")),
    );
    let later = kept.snapshot().await;
    assert_eq!(
        later.groups.iter().find(|g| g.id == WEB).map(|g| g.pods),
        Some(3)
    );
    assert_eq!(core.running_reachabilities_for_test(), 1);
}

#[tokio::test]
async fn a_disconnect_ends_the_subscription_without_a_failure() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    seed(&fake, false);
    let mut sub = Subscription::start(&core, &id, "shop");
    sub.snapshot().await;

    core.cluster_disconnect(&id).await.unwrap();
    sub.ended().await;
    assert_eq!(core.running_reachabilities_for_test(), 0);
    let (tx, _rx) = mpsc::channel(1);
    let refused = core
        .network_reachability_subscribe(&id, "shop".to_owned(), tx, "main")
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::InvalidInput);
    assert_eq!(refused.message, format!("cluster {id} is disconnected"));
}

#[tokio::test]
async fn a_closed_receiver_stops_the_hub_and_its_watches() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    seed(&fake, false);
    let mut sub = Subscription::start(&core, &id, "shop");
    sub.snapshot().await;
    drop(sub);
    eventually("the hub to stop", || {
        core.running_reachabilities_for_test() == 0
    })
    .await;
    eventually("the watches to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn without_cilium_and_argo_cd_nothing_is_missing() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    seed(&fake, false);
    let mut sub = Subscription::start(&core, &id, "shop");
    let snapshot = sub.snapshot().await;
    assert!(
        snapshot.missing.is_empty(),
        "a kind the cluster does not serve is not missing: {:?}",
        snapshot.missing
    );
    assert!(!snapshot.cilium);
    assert_eq!(
        snapshot.counts,
        ReachCounts {
            kubernetes: 1,
            cilium: 0
        }
    );
    assert_eq!(snapshot.group_ids(), [API, WEB]);
}

#[tokio::test]
async fn a_forbidden_cilium_network_policy_list_is_missing() {
    let (core, fake, id, _root) = connected(deny_list("ciliumnetworkpolicies"), true).await;
    seed(&fake, true);
    let mut sub = Subscription::start(&core, &id, "shop");
    let snapshot = sub.snapshot().await;
    let missing: Vec<&str> = snapshot.missing.iter().map(|m| m.plural.as_str()).collect();
    assert_eq!(missing, ["ciliumnetworkpolicies"]);
    let reason = &snapshot.missing[0].reason;
    assert!(reason.contains("cannot list resource"), "{reason}");
    assert!(snapshot.cilium, "the cluster still serves a Cilium kind");
    assert_eq!(
        snapshot.counts,
        ReachCounts {
            kubernetes: 1,
            cilium: 0
        }
    );
    assert_eq!(snapshot.group_ids(), [API, WEB], "the rest still shows");
}

#[tokio::test]
async fn forbidden_pods_end_the_reachability_with_a_failure() {
    let (core, fake, id, _root) = connected(deny_list("pods"), false).await;
    seed(&fake, false);
    let mut sub = Subscription::start(&core, &id, "shop");
    match sub.next().await.as_deref() {
        Some(ReachEvent::Failure { message }) => {
            assert!(message.starts_with("Pods cannot be listed: "), "{message}");
            assert!(message.contains("cannot list resource"), "{message}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    sub.ended().await;
    eventually("the hub to stop", || {
        core.running_reachabilities_for_test() == 0
    })
    .await;
}
