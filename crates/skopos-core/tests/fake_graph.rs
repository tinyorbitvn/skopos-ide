//! The resource graph against the fake API server (spec E §4.8).
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::ErrorCode;
use skopos_core::graph::{
    GraphEdge, GraphEvent, GraphNamespaceCount, GraphNode, GraphRel, GraphStatus,
};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "fake";
const GATEWAY: &str = "gateway.networking.k8s.io";
const CILIUM: &str = "cilium.io";
const ARGO: &str = "argoproj.io";
/// A git SHA, which an Application's "Revision" cuts to its first 7 characters.
const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";
const WAIT: Duration = Duration::from_secs(10);
const INTERVAL: Duration = Duration::from_millis(500);
/// How much sooner than the interval a later snapshot may come: the first one's delivery.
const SLACK: Duration = Duration::from_millis(100);
const FAST_BATCH: Duration = Duration::from_millis(20);
const SHORT_LINGER: Duration = Duration::from_millis(200);
/// "graph-secret-value" in base64.
const SECRET_BASE64: &str = "Z3JhcGgtc2VjcmV0LXZhbHVl";
const PLAIN_VALUE: &str = "graph-plain-value";

/// The kinds the graph reads that the fake does not serve by default.
fn graph_resources(gateway_api: bool) -> Vec<FakeResource> {
    let mut resources = vec![
        FakeResource::new("apps", "v1", "ReplicaSet", "replicasets", true),
        FakeResource::new("apps", "v1", "StatefulSet", "statefulsets", true),
        FakeResource::new("apps", "v1", "DaemonSet", "daemonsets", true),
        FakeResource::new("batch", "v1", "Job", "jobs", true),
        FakeResource::new("batch", "v1", "CronJob", "cronjobs", true),
        FakeResource::new("networking.k8s.io", "v1", "Ingress", "ingresses", true),
        FakeResource::new("", "v1", "ServiceAccount", "serviceaccounts", true),
        FakeResource::new(
            "",
            "v1",
            "PersistentVolumeClaim",
            "persistentvolumeclaims",
            true,
        ),
    ];
    if gateway_api {
        resources.extend([
            FakeResource::new(GATEWAY, "v1", "GatewayClass", "gatewayclasses", false),
            FakeResource::new(GATEWAY, "v1", "Gateway", "gateways", true),
            FakeResource::new(GATEWAY, "v1", "HTTPRoute", "httproutes", true),
        ]);
    }
    resources
}

/// NetworkPolicies, and Cilium's two policy kinds when `cilium`.
fn policy_resources(cilium: bool) -> Vec<FakeResource> {
    let mut resources = vec![FakeResource::new(
        "networking.k8s.io",
        "v1",
        "NetworkPolicy",
        "networkpolicies",
        true,
    )];
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

/// Argo CD's three kinds.
fn argo_resources() -> Vec<FakeResource> {
    vec![
        FakeResource::new(ARGO, "v1alpha1", "Application", "applications", true),
        FakeResource::new(ARGO, "v1alpha1", "ApplicationSet", "applicationsets", true),
        FakeResource::new(ARGO, "v1alpha1", "AppProject", "appprojects", true),
    ]
}

fn facts_of(node: &GraphNode) -> Vec<(&str, &str)> {
    node.facts
        .iter()
        .map(|(label, value)| (label.as_str(), value.as_str()))
        .collect()
}

/// A CiliumClusterwideNetworkPolicy that selects every `app=web` Pod.
fn every_web() -> Value {
    json!({
        "metadata": { "name": "every-web" },
        "spec": {
            "endpointSelector": { "matchLabels": { "app": "web" } },
            "ingress": [{ "fromEntities": ["cluster"] }],
        },
    })
}

/// The web objects' ids plus `more`, in order.
fn web_ids_and(more: &[&'static str]) -> Vec<&'static str> {
    let mut ids: Vec<&str> = WEB_IDS.iter().chain(more).copied().collect();
    ids.sort_unstable();
    ids
}

/// Discovery is read when the cluster connects, so the kinds are served before that.
async fn connected(
    cfg: FakeKubeConfig,
    gateway_api: bool,
) -> (AppCore, FakeKube, ClusterId, TempDir) {
    connected_serving(cfg, gateway_api, Vec::new()).await
}

/// As `connected`, with `extra` served too.
async fn connected_serving(
    cfg: FakeKubeConfig,
    gateway_api: bool,
    extra: Vec<FakeResource>,
) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    for resource in graph_resources(gateway_api).into_iter().chain(extra) {
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
    core.set_graph_interval_for_test(INTERVAL);
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

struct Snapshot {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    counts: Vec<GraphNamespaceCount>,
    missing: Vec<String>,
    gateway_api: bool,
    /// The event as it crosses to the interface.
    json: String,
}

impl Snapshot {
    fn ids(&self) -> Vec<&str> {
        self.nodes.iter().map(|n| n.id.as_str()).collect()
    }

    fn node(&self, id: &str) -> &GraphNode {
        self.nodes
            .iter()
            .find(|n| n.id == id)
            .unwrap_or_else(|| panic!("no {id} in {:?}", self.ids()))
    }

    fn edges(&self) -> Vec<(&str, &str, GraphRel)> {
        self.edges
            .iter()
            .map(|e| (e.from.as_str(), e.to.as_str(), e.rel))
            .collect()
    }

    fn counts(&self) -> Vec<(&str, u32)> {
        self.counts
            .iter()
            .map(|c| (c.namespace.as_str(), c.nodes))
            .collect()
    }
}

fn into_snapshot(event: Option<Arc<GraphEvent>>) -> Snapshot {
    let Some(event) = event else {
        panic!("the subscription ended");
    };
    let event = Arc::unwrap_or_clone(event);
    let json = serde_json::to_string(&event).unwrap();
    match event {
        GraphEvent::Snapshot {
            nodes,
            edges,
            counts,
            missing,
            gateway_api,
        } => Snapshot {
            nodes,
            edges,
            counts,
            missing,
            gateway_api,
            json,
        },
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

struct Subscription {
    id: String,
    rx: mpsc::Receiver<Arc<GraphEvent>>,
}

impl Subscription {
    fn start(core: &AppCore, cluster: &ClusterId, namespaces: Option<&[&str]>) -> Self {
        Self::start_as(core, cluster, namespaces, "main")
    }

    /// A map in the window `owner`.
    fn start_as(
        core: &AppCore,
        cluster: &ClusterId,
        namespaces: Option<&[&str]>,
        owner: &str,
    ) -> Self {
        let (tx, rx) = mpsc::channel(16);
        let namespaces = namespaces.map(|list| list.iter().map(|n| (*n).to_owned()).collect());
        let id = core
            .resource_graph_subscribe(cluster, namespaces, tx, owner)
            .unwrap();
        Self { id, rx }
    }

    async fn next(&mut self) -> Option<Arc<GraphEvent>> {
        tokio::time::timeout(WAIT, self.rx.recv())
            .await
            .expect("timed out waiting for an event")
    }

    async fn snapshot(&mut self) -> Snapshot {
        into_snapshot(self.next().await)
    }

    /// Reads snapshots until one satisfies `done`.
    async fn until(&mut self, what: &str, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let started = Instant::now();
        loop {
            let left = WAIT
                .checked_sub(started.elapsed())
                .unwrap_or_else(|| panic!("timed out waiting for {what}"));
            let event = tokio::time::timeout(left, self.rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
            let snapshot = into_snapshot(event);
            if done(&snapshot) {
                return snapshot;
            }
        }
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

fn controller(kind: &str, name: &str) -> Value {
    let api_version = if kind == "ReplicaSet" || kind == "Deployment" {
        "apps/v1"
    } else {
        "v1"
    };
    json!([{ "apiVersion": api_version, "kind": kind, "name": name, "uid": format!("{name}-uid"), "controller": true }])
}

/// Deployment, ReplicaSet and Pod `web`, with the Service, ServiceAccount, ConfigMap and Secret
/// they use: seven nodes and six edges.
fn seed_web(fake: &FakeKube, namespace: &str) {
    fake.upsert(
        "deployments",
        json!({
            "metadata": { "name": "web", "namespace": namespace },
            "spec": { "replicas": 1 },
            "status": { "availableReplicas": 1 },
        }),
    );
    fake.upsert("replicasets", json!({
        "metadata": { "name": "web-1", "namespace": namespace, "ownerReferences": controller("Deployment", "web") },
        "spec": { "replicas": 1 },
        "status": { "availableReplicas": 1, "readyReplicas": 1 },
    }));
    fake.upsert("pods", json!({
        "metadata": {
            "name": "web-1-a",
            "namespace": namespace,
            "labels": { "app": "web" },
            "ownerReferences": controller("ReplicaSet", "web-1"),
        },
        "spec": {
            "serviceAccountName": "web",
            "volumes": [{ "name": "config", "configMap": { "name": "web-config" } }],
            "containers": [{
                "name": "app",
                "image": "registry.example.com/web:1",
                "env": [{ "name": "PLAIN", "value": PLAIN_VALUE }],
                "envFrom": [{ "secretRef": { "name": "web-secret" } }],
            }],
        },
        "status": {
            "phase": "Running",
            "conditions": [{ "type": "Ready", "status": "True" }],
            "containerStatuses": [{ "name": "app", "ready": true, "restartCount": 0, "state": { "running": {} } }],
        },
    }));
    fake.upsert(
        "services",
        json!({
            "metadata": { "name": "web", "namespace": namespace },
            "spec": { "selector": { "app": "web" }, "ports": [{ "port": 80 }] },
        }),
    );
    fake.upsert(
        "serviceaccounts",
        json!({ "metadata": { "name": "web", "namespace": namespace } }),
    );
    fake.upsert(
        "configmaps",
        json!({
            "metadata": { "name": "web-config", "namespace": namespace },
            "data": { "mode": "fast" },
        }),
    );
    fake.upsert(
        "secrets",
        json!({
            "metadata": { "name": "web-secret", "namespace": namespace },
            "type": "Opaque",
            "data": { "token": SECRET_BASE64 },
        }),
    );
}

const WEB_IDS: [&str; 7] = [
    "ConfigMap/default/web-config",
    "Deployment/default/web",
    "Pod/default/web-1-a",
    "ReplicaSet/default/web-1",
    "Secret/default/web-secret",
    "Service/default/web",
    "ServiceAccount/default/web",
];

/// A Gateway in `infra` shared by routes in `a` and `b`, each with its Service, and a Pod of
/// `b`'s Service.
fn seed_shared_gateway(fake: &FakeKube) {
    fake.upsert(
        "gatewayclasses",
        json!({
            "metadata": { "name": "shared" },
            "spec": { "controllerName": "example.com/gateway" },
        }),
    );
    fake.upsert("gateways", json!({
        "metadata": { "name": "edge", "namespace": "infra" },
        "spec": { "gatewayClassName": "shared", "listeners": [{ "name": "http", "port": 80, "protocol": "HTTP" }] },
        "status": { "addresses": [{ "value": "10.0.0.9" }] },
    }));
    for (namespace, name) in [("a", "web"), ("b", "api")] {
        fake.upsert(
            "httproutes",
            json!({
                "metadata": { "name": name, "namespace": namespace },
                "spec": {
                    "parentRefs": [{ "name": "edge", "namespace": "infra" }],
                    "rules": [{ "backendRefs": [{ "name": name, "port": 80 }] }],
                },
            }),
        );
        fake.upsert(
            "services",
            json!({
                "metadata": { "name": name, "namespace": namespace },
                "spec": { "selector": { "app": name } },
            }),
        );
    }
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "api-1", "namespace": "b", "labels": { "app": "api" } },
            "spec": { "containers": [{ "name": "app" }] },
        }),
    );
}

#[tokio::test]
async fn the_first_snapshot_holds_the_graph_and_nothing_follows_without_a_change() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    let mut map = Subscription::start(&core, &id, None);

    let first = map.snapshot().await;
    assert_eq!(first.ids(), WEB_IDS);
    assert_eq!(
        first.edges(),
        [
            (
                "Deployment/default/web",
                "ReplicaSet/default/web-1",
                GraphRel::Owns
            ),
            (
                "Pod/default/web-1-a",
                "ConfigMap/default/web-config",
                GraphRel::Mounts
            ),
            (
                "Pod/default/web-1-a",
                "Secret/default/web-secret",
                GraphRel::Env
            ),
            (
                "Pod/default/web-1-a",
                "ServiceAccount/default/web",
                GraphRel::RunsAs
            ),
            (
                "ReplicaSet/default/web-1",
                "Pod/default/web-1-a",
                GraphRel::Owns
            ),
            (
                "Service/default/web",
                "Pod/default/web-1-a",
                GraphRel::Selects
            ),
        ]
    );
    assert_eq!(first.counts(), [("default", 7)]);
    assert!(first.missing.is_empty());
    assert!(first.gateway_api);
    let pod = first.node("Pod/default/web-1-a");
    assert_eq!(
        (pod.status, pod.status_text.as_deref()),
        (GraphStatus::Nominal, Some("Running"))
    );
    assert_eq!((pod.group.as_str(), pod.plural.as_str()), ("", "pods"));
    assert!(pod.created.is_some());
    assert_eq!(
        first.node("Service/default/web").status,
        GraphStatus::Nominal
    );
    assert_eq!(
        first.node("Secret/default/web-secret").facts,
        [
            ("Type".to_owned(), "Opaque".to_owned()),
            ("Keys".to_owned(), "1".to_owned()),
        ]
    );
    for value in [SECRET_BASE64, "graph-secret-value", PLAIN_VALUE] {
        assert!(!first.json.contains(value), "{value} left the core");
    }

    map.quiet(INTERVAL * 3).await;
}

#[tokio::test]
async fn unfiltered_subscriptions_share_one_event_and_a_namespace_view_does_not() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    let mut first = Subscription::start(&core, &id, None);
    let shared = first.next().await.expect("the first snapshot");
    // No further build, so the next subscriber joins the same generation.
    first.quiet(INTERVAL + Duration::from_millis(200)).await;

    let mut second = Subscription::start(&core, &id, None);
    let again = second.next().await.expect("the current snapshot");
    assert!(Arc::ptr_eq(&shared, &again), "one event for both");

    let mut namespaced = Subscription::start(&core, &id, Some(&["default"]));
    let own = namespaced.next().await.expect("the namespace view");
    assert!(!Arc::ptr_eq(&shared, &own), "a namespace view is its own");
}

#[tokio::test]
async fn a_change_comes_no_sooner_than_the_interval() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    let mut map = Subscription::start(&core, &id, None);
    map.snapshot().await;
    let shown = Instant::now();

    fake.delete("configmaps", Some("default"), "web-config");
    let later = map
        .until("the ConfigMap to be gone", |s| {
            s.node("ConfigMap/default/web-config")
                .status_text
                .as_deref()
                == Some("Not found")
        })
        .await;
    assert!(
        shown.elapsed() + SLACK >= INTERVAL,
        "after {:?}",
        shown.elapsed()
    );
    let config = later.node("ConfigMap/default/web-config");
    assert_eq!(config.status, GraphStatus::Critical);
    assert!(config.facts.is_empty() && config.created.is_none());
}

#[tokio::test]
async fn a_namespace_view_reaches_a_shared_gateway_and_every_subscription_shares_one_graph() {
    let cfg = FakeKubeConfig {
        namespaces: vec!["a".into(), "b".into(), "infra".into()],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(cfg, true).await;
    seed_shared_gateway(&fake);
    let mut only_a = Subscription::start(&core, &id, Some(&["a"]));
    let mut everything = Subscription::start(&core, &id, None);

    let view = only_a.snapshot().await;
    assert_eq!(
        view.ids(),
        [
            "Gateway/infra/edge",
            "GatewayClass//shared",
            "HTTPRoute/a/web",
            "HTTPRoute/b/api",
            "LoadBalancer//10.0.0.9",
            "Service/a/web",
            "Service/b/api",
        ]
    );
    assert!(view
        .edges()
        .contains(&("HTTPRoute/b/api", "Service/b/api", GraphRel::Routes)));
    assert!(view.edges().contains(&(
        "Gateway/infra/edge",
        "GatewayClass//shared",
        GraphRel::Class
    )));
    let whole = everything.snapshot().await;
    assert!(whole.ids().contains(&"Pod/b/api-1"));
    assert!(whole
        .edges()
        .contains(&("Service/b/api", "Pod/b/api-1", GraphRel::Selects)));
    assert_eq!(view.counts(), [("a", 2), ("b", 4), ("infra", 1)]);
    assert_eq!(whole.counts(), view.counts());
    assert_eq!(core.running_graphs_for_test(), 1);
}

#[tokio::test]
async fn the_graph_stops_after_its_last_subscription_and_the_linger() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    let mut first = Subscription::start(&core, &id, None);
    let mut second = Subscription::start(&core, &id, Some(&["default"]));
    first.snapshot().await;
    second.snapshot().await;

    core.resource_graph_unsubscribe(&first.id);
    first.ended().await;
    core.resource_graph_unsubscribe(&first.id);
    core.resource_graph_unsubscribe("graph-unknown");
    tokio::time::sleep(SHORT_LINGER * 2).await;
    assert_eq!(
        core.running_graphs_for_test(),
        1,
        "the second subscription keeps the graph"
    );

    core.resource_graph_unsubscribe(&second.id);
    second.ended().await;
    eventually("the graph to stop", || core.running_graphs_for_test() == 0).await;
    eventually("the watches to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn a_window_s_map_ends_with_it_and_another_window_s_goes_on() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    let mut kept = Subscription::start_as(&core, &id, None, "main");
    let mut ended = Subscription::start_as(&core, &id, Some(&["default"]), "window-2");
    kept.snapshot().await;
    ended.snapshot().await;

    core.subscriptions_stop_owned("window-2");

    ended.ended().await;
    // The graph and the rows it reads belong to no window: the other map still follows them.
    fake.delete("configmaps", Some("default"), "web-config");
    kept.until("the ConfigMap to be gone", |s| {
        s.node("ConfigMap/default/web-config")
            .status_text
            .as_deref()
            == Some("Not found")
    })
    .await;
    assert_eq!(core.running_graphs_for_test(), 1);
}

#[tokio::test]
async fn a_kind_the_user_may_not_list_is_named_missing() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "secrets".into(),
            namespace: None,
        }],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(cfg, true).await;
    seed_web(&fake, "default");
    fake.delete("configmaps", Some("default"), "web-config");
    let mut map = Subscription::start(&core, &id, None);

    let snapshot = map.snapshot().await;
    assert_eq!(snapshot.missing, ["secrets"]);
    assert_eq!(snapshot.ids(), WEB_IDS, "the graph still works");
    let secret = snapshot.node("Secret/default/web-secret");
    assert_eq!(
        (secret.status, secret.status_text.as_deref()),
        (GraphStatus::Neutral, None)
    );
    assert!(secret.facts.is_empty());
    let config = snapshot.node("ConfigMap/default/web-config");
    assert_eq!(
        (config.status, config.status_text.as_deref()),
        (GraphStatus::Critical, Some("Not found"))
    );
}

#[tokio::test]
async fn without_the_gateway_api_the_graph_still_works() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    seed_web(&fake, "default");
    let mut map = Subscription::start(&core, &id, None);
    let snapshot = map.snapshot().await;
    assert!(!snapshot.gateway_api);
    assert!(
        snapshot.missing.is_empty(),
        "a kind that is not served is not missing"
    );
    assert_eq!(snapshot.ids(), WEB_IDS);
}

#[tokio::test]
async fn a_kind_that_stops_being_served_joins_missing() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    fake.upsert("httproutes", json!({
        "metadata": { "name": "web", "namespace": "default" },
        "spec": { "parentRefs": [{ "name": "edge" }], "rules": [{ "backendRefs": [{ "name": "web", "port": 80 }] }] },
    }));
    let mut map = Subscription::start(&core, &id, None);
    let first = map.snapshot().await;
    assert!(first.ids().contains(&"HTTPRoute/default/web"));
    let gone = first.node("Gateway/default/edge");
    assert_eq!(gone.status_text.as_deref(), Some("Not found"));

    fake.remove_resource("httproutes");
    let later = map
        .until("httproutes to be missing", |s| s.missing == ["httproutes"])
        .await;
    assert!(!later.ids().contains(&"HTTPRoute/default/web"));
    assert!(
        !later.ids().contains(&"Gateway/default/edge"),
        "nothing refers to it any more"
    );
    assert!(later.gateway_api, "Gateways are still served");
}

#[tokio::test]
async fn a_closed_receiver_ends_the_subscription() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    let mut map = Subscription::start(&core, &id, None);
    map.snapshot().await;
    drop(map);
    eventually("the graph to stop", || core.running_graphs_for_test() == 0).await;
    eventually("the watches to close", || fake.open_watch_count() == 0).await;
}

/// Review Focus 4.
#[tokio::test]
async fn a_disconnect_ends_the_subscription_and_a_reconnect_starts_a_new_graph() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), true).await;
    seed_web(&fake, "default");
    let mut map = Subscription::start(&core, &id, None);
    map.snapshot().await;

    core.cluster_disconnect(&id).await.unwrap();
    map.ended().await;
    assert_eq!(core.running_graphs_for_test(), 0);
    let (tx, _rx) = mpsc::channel(1);
    let refused = core
        .resource_graph_subscribe(&id, None, tx, "main")
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::InvalidInput);

    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    let mut again = Subscription::start(&core, &id, None);
    assert_eq!(again.snapshot().await.ids(), WEB_IDS);
    assert_eq!(core.running_graphs_for_test(), 1);
}

#[tokio::test]
async fn trimmed_replica_set_and_config_map_rows_give_the_graph_the_same_facts() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), false).await;
    fake.upsert(
        "deployments",
        json!({ "metadata": { "name": "web", "namespace": "default" }, "spec": { "replicas": 3 } }),
    );
    fake.upsert(
        "replicasets",
        json!({
            "metadata": {
                "name": "web-1",
                "namespace": "default",
                "annotations": { "deployment.kubernetes.io/revision": "7", "note": "n".repeat(400) },
                "ownerReferences": controller("Deployment", "web"),
            },
            "spec": {
                "replicas": 3,
                "selector": { "matchLabels": { "app": "web" } },
                "template": { "spec": { "containers": [{
                    "name": "app",
                    "image": "registry.example.com/web:1",
                    "env": [{ "name": "PLAIN", "value": PLAIN_VALUE }],
                }] } },
            },
            "status": { "replicas": 3, "readyReplicas": 2, "availableReplicas": 2, "observedGeneration": 4 },
        }),
    );
    fake.upsert(
        "configmaps",
        json!({
            "metadata": { "name": "web-config", "namespace": "default" },
            "immutable": true,
            "data": { "a": PLAIN_VALUE, "b": "2" },
            "binaryData": { "c": "AAE=" },
        }),
    );
    // A ConfigMap no edge points at is not shown, and a trimmed ReplicaSet row keeps no
    // references, so a Pod that reads the ConfigMap is what brings it into the graph.
    fake.upsert(
        "pods",
        json!({
            "metadata": {
                "name": "web-1-a",
                "namespace": "default",
                "ownerReferences": controller("ReplicaSet", "web-1"),
            },
            "spec": { "containers": [{
                "name": "app",
                "image": "registry.example.com/web:1",
                "envFrom": [{ "configMapRef": { "name": "web-config" } }],
            }] },
        }),
    );
    let mut map = Subscription::start(&core, &id, None);

    let first = map.snapshot().await;

    let replica_set = first.node("ReplicaSet/default/web-1");
    assert_eq!(
        replica_set.facts,
        [
            ("Pods".to_owned(), "3".to_owned()),
            ("Ready".to_owned(), "2".to_owned()),
            ("Revision".to_owned(), "7".to_owned()),
        ]
    );
    assert_eq!(
        first.node("ConfigMap/default/web-config").facts,
        [("Keys".to_owned(), "3".to_owned())]
    );
    assert!(first.edges().contains(&(
        "Deployment/default/web",
        "ReplicaSet/default/web-1",
        GraphRel::Owns
    )));
    assert!(
        !first.json.contains(PLAIN_VALUE),
        "no ConfigMap value leaves the core"
    );
}

/// Review Focus 2.
#[tokio::test]
async fn without_cilium_and_argo_cd_nothing_is_missing() {
    let (core, fake, id, _root) =
        connected_serving(FakeKubeConfig::default(), false, policy_resources(false)).await;
    seed_web(&fake, "default");
    fake.upsert(
        "networkpolicies",
        json!({
            "metadata": { "name": "web", "namespace": "default" },
            "spec": { "podSelector": { "matchLabels": { "app": "web" } }, "policyTypes": ["Ingress"] },
        }),
    );
    let mut map = Subscription::start(&core, &id, None);

    let snapshot = map.snapshot().await;
    assert!(
        snapshot.missing.is_empty(),
        "kinds that are not served are not missing: {:?}",
        snapshot.missing
    );
    assert_eq!(snapshot.ids(), web_ids_and(&["NetworkPolicy/default/web"]));
    assert!(snapshot.edges().contains(&(
        "NetworkPolicy/default/web",
        "Pod/default/web-1-a",
        GraphRel::Selects
    )));
    let policy = snapshot.node("NetworkPolicy/default/web");
    assert_eq!(
        (policy.status, policy.status_text.as_deref()),
        (GraphStatus::Neutral, None)
    );
    assert_eq!(
        facts_of(policy),
        [
            ("Source", "Kubernetes"),
            ("Selector", "app=web"),
            ("Types", "Ingress"),
            ("Ingress rules", "0"),
            ("Egress rules", "0"),
        ]
    );
}

/// Review Focus 2.
#[tokio::test]
async fn a_forbidden_cilium_network_policy_list_is_missing() {
    let cfg = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "ciliumnetworkpolicies".into(),
            namespace: None,
        }],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected_serving(cfg, false, policy_resources(true)).await;
    seed_web(&fake, "default");
    fake.upsert(
        "ciliumnetworkpolicies",
        json!({
            "metadata": { "name": "web-egress", "namespace": "default" },
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "web" } },
                "egress": [{ "toEntities": ["world"] }],
            },
        }),
    );
    fake.upsert("ciliumclusterwidenetworkpolicies", every_web());
    let mut map = Subscription::start(&core, &id, None);

    let snapshot = map.snapshot().await;
    assert_eq!(snapshot.missing, ["ciliumnetworkpolicies"]);
    assert_eq!(
        snapshot.ids(),
        web_ids_and(&["CiliumClusterwideNetworkPolicy//every-web"]),
        "the graph still works"
    );
    assert!(snapshot.edges().contains(&(
        "CiliumClusterwideNetworkPolicy//every-web",
        "Pod/default/web-1-a",
        GraphRel::Selects
    )));
}

#[tokio::test]
async fn cilium_and_argo_cd_kinds_become_nodes_with_their_edges() {
    let cfg = FakeKubeConfig {
        namespaces: vec!["default".into(), "kube-system".into(), "argocd".into()],
        ..Default::default()
    };
    let mut extra = policy_resources(true);
    extra.extend(argo_resources());
    let (core, fake, id, _root) = connected_serving(cfg, false, extra).await;
    seed_web(&fake, "default");
    fake.upsert(
        "networkpolicies",
        json!({
            "metadata": { "name": "web-ingress", "namespace": "default" },
            "spec": {
                "podSelector": { "matchLabels": { "app": "web" } },
                "ingress": [{ "from": [{ "podSelector": {} }], "ports": [{ "port": 8080 }] }],
            },
        }),
    );
    fake.upsert(
        "networkpolicies",
        json!({
            "metadata": { "name": "nothing", "namespace": "default" },
            "spec": { "podSelector": { "matchLabels": { "app": "none" } } },
        }),
    );
    fake.upsert(
        "ciliumnetworkpolicies",
        json!({
            "metadata": { "name": "web-egress", "namespace": "default" },
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "web" } },
                "egress": [{
                    "toFQDNs": [{ "matchName": "api.example.com" }],
                    "toPorts": [{ "ports": [{ "port": "443", "protocol": "TCP" }] }],
                }],
            },
        }),
    );
    fake.upsert("ciliumclusterwidenetworkpolicies", every_web());
    fake.upsert(
        "appprojects",
        json!({
            "metadata": { "name": "team", "namespace": "argocd" },
            "spec": {
                "destinations": [{ "server": "*", "namespace": "default" }],
                "sourceRepos": ["https://example.com/web.git"],
            },
        }),
    );
    fake.upsert(
        "applicationsets",
        json!({
            "metadata": { "name": "apps", "namespace": "argocd" },
            "status": { "conditions": [{ "type": "ErrorOccurred", "status": "False" }] },
        }),
    );
    let application = |name: &str, resources: Value| {
        json!({
            "metadata": {
                "name": name,
                "namespace": "argocd",
                "ownerReferences": controller("ApplicationSet", "apps"),
            },
            "spec": {
                "project": "team",
                "destination": { "server": "https://kubernetes.default.svc", "namespace": "default" },
            },
            "status": {
                "health": { "status": "Healthy" },
                "sync": { "status": "Synced", "revision": REVISION },
                "resources": resources,
            },
        })
    };
    fake.upsert(
        "applications",
        application(
            "web",
            json!([
                { "group": "apps", "kind": "Deployment", "namespace": "default", "name": "web" },
                { "kind": "Service", "namespace": "default", "name": "web" },
                { "kind": "ConfigMap", "namespace": "default", "name": "gone" },
                { "kind": "Namespace", "name": "default" },
            ]),
        ),
    );
    fake.upsert(
        "applications",
        application(
            "other",
            json!([{ "group": "apps", "kind": "Deployment", "namespace": "elsewhere", "name": "api" }]),
        ),
    );
    let mut map = Subscription::start(&core, &id, None);

    let snapshot = map.snapshot().await;
    assert!(snapshot.missing.is_empty(), "{:?}", snapshot.missing);
    assert!(
        !snapshot.ids().iter().any(|id| id.starts_with("Namespace/")),
        "{:?}",
        snapshot.ids()
    );
    let edges: Vec<_> = snapshot
        .edges()
        .into_iter()
        .filter(|(from, _, _)| !WEB_IDS.contains(from))
        .collect();
    assert_eq!(
        edges,
        [
            (
                "Application/argocd/other",
                "AppProject/argocd/team",
                GraphRel::Project
            ),
            (
                "Application/argocd/other",
                "Deployment/elsewhere/api",
                GraphRel::Manages
            ),
            (
                "Application/argocd/web",
                "AppProject/argocd/team",
                GraphRel::Project
            ),
            (
                "Application/argocd/web",
                "ConfigMap/default/gone",
                GraphRel::Manages
            ),
            (
                "Application/argocd/web",
                "Deployment/default/web",
                GraphRel::Manages
            ),
            (
                "Application/argocd/web",
                "Service/default/web",
                GraphRel::Manages
            ),
            (
                "ApplicationSet/argocd/apps",
                "Application/argocd/other",
                GraphRel::Owns
            ),
            (
                "ApplicationSet/argocd/apps",
                "Application/argocd/web",
                GraphRel::Owns
            ),
            (
                "CiliumClusterwideNetworkPolicy//every-web",
                "Pod/default/web-1-a",
                GraphRel::Selects
            ),
            (
                "CiliumNetworkPolicy/default/web-egress",
                "Pod/default/web-1-a",
                GraphRel::Selects
            ),
            (
                "NetworkPolicy/default/web-ingress",
                "Pod/default/web-1-a",
                GraphRel::Selects
            ),
        ]
    );
    let nothing = snapshot.node("NetworkPolicy/default/nothing");
    assert_eq!(
        (nothing.status, nothing.status_text.as_deref()),
        (GraphStatus::Warning, Some("Selects no Pods"))
    );
    let app = snapshot.node("Application/argocd/web");
    assert_eq!(
        (app.group.as_str(), app.plural.as_str()),
        (ARGO, "applications")
    );
    assert_eq!(
        (app.status, app.status_text.as_deref()),
        (GraphStatus::Nominal, Some("Healthy · Synced"))
    );
    assert_eq!(
        facts_of(app),
        [
            ("Project", "team"),
            ("Health", "Healthy"),
            ("Sync", "Synced"),
            ("Revision", "0123456"),
            ("Destination", "default"),
            ("Other resources", "1 (Namespace)"),
        ]
    );
    let gone = snapshot.node("ConfigMap/default/gone");
    assert_eq!(
        (gone.status, gone.status_text.as_deref()),
        (GraphStatus::Critical, Some("Not found"))
    );
    assert_eq!(
        facts_of(snapshot.node("AppProject/argocd/team")),
        [("Destinations", "1"), ("Source repos", "1")]
    );
    let set = snapshot.node("ApplicationSet/argocd/apps");
    assert_eq!(
        (set.status, set.status_text.as_deref()),
        (GraphStatus::Nominal, None)
    );
    assert_eq!(
        snapshot.counts(),
        [("argocd", 4), ("default", 11), ("elsewhere", 1)],
        "a cluster-wide policy is not counted"
    );

    // C14: the cluster-wide policy, the Application that manages `default`'s objects, its
    // project and its set join the view; the other Application does not.
    let mut in_default = Subscription::start(&core, &id, Some(&["default"]));
    let view = in_default.snapshot().await;
    assert_eq!(
        view.ids(),
        web_ids_and(&[
            "AppProject/argocd/team",
            "Application/argocd/web",
            "ApplicationSet/argocd/apps",
            "CiliumClusterwideNetworkPolicy//every-web",
            "CiliumNetworkPolicy/default/web-egress",
            "ConfigMap/default/gone",
            "NetworkPolicy/default/nothing",
            "NetworkPolicy/default/web-ingress",
        ])
    );
    assert!(!view
        .edges()
        .iter()
        .any(|(from, to, _)| *from == "Application/argocd/other"
            || *to == "Application/argocd/other"));
}
