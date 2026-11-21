//! The watch hub against the fake API server.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::ErrorCode;
use skopos_core::graph::{GraphEvent, GraphRel};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::resources::{
    ObjectKey, ResourceRef, Row, WatchEvent, WatchStatus, NAMESPACE_LISTS_AT_ONCE,
};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "fake";
const PODS: &str = "/api/v1/pods";
const WIDGETS: &str = "/apis/example.com/v1/widgets";
const WAIT: Duration = Duration::from_secs(10);
const QUIET: Duration = Duration::from_secs(2);
const FAST_BATCH: Duration = Duration::from_millis(20);
const LONG_LINGER: Duration = Duration::from_secs(30);

async fn connected(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    fake.write_kubeconfig(&kube_dir.join("config"), CONTEXT)
        .unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    core.set_watch_timing_for_test(FAST_BATCH, LONG_LINGER);
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
            "timed out waiting for the catalog entry"
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

fn resource(group: &str, kind: &str, plural: &str, namespaced: bool) -> ResourceRef {
    ResourceRef {
        group: group.into(),
        version: "v1".into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced,
    }
}

fn pods() -> ResourceRef {
    resource("", "Pod", "pods", true)
}

fn secrets() -> ResourceRef {
    resource("", "Secret", "secrets", true)
}

fn widgets() -> ResourceRef {
    resource("example.com", "Widget", "widgets", true)
}

fn fake_widgets() -> FakeResource {
    FakeResource::new("example.com", "v1", "Widget", "widgets", true)
}

fn widget(name: &str) -> Value {
    json!({ "metadata": { "name": name, "namespace": "default" } })
}

fn deny_list(plural: &str) -> DenyRule {
    DenyRule {
        verb: "list".into(),
        plural: plural.into(),
        namespace: None,
    }
}

fn row_of(object: &Value) -> ObjectKey {
    ObjectKey {
        namespace: object
            .pointer("/metadata/namespace")
            .and_then(Value::as_str)
            .map(str::to_owned),
        name: object
            .pointer("/metadata/name")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned(),
    }
}

fn key(namespace: &str, name: &str) -> ObjectKey {
    ObjectKey {
        namespace: Some(namespace.to_owned()),
        name: name.to_owned(),
    }
}

/// What a table does: applies the events to a local map of rows.
struct Consumer {
    id: String,
    rx: mpsc::Receiver<WatchEvent>,
    rows: BTreeMap<(Option<String>, String), Value>,
    seen: Vec<WatchEvent>,
}

impl Consumer {
    async fn subscribe(core: &AppCore, id: &ClusterId, resource: ResourceRef) -> Consumer {
        Self::with_capacity(core, id, resource, 64).await
    }

    async fn with_capacity(
        core: &AppCore,
        id: &ClusterId,
        resource: ResourceRef,
        capacity: usize,
    ) -> Consumer {
        Self::start(core, id, resource, capacity, "main", &[]).await
    }

    /// A table in the window `owner`.
    async fn subscribe_as(
        core: &AppCore,
        id: &ClusterId,
        resource: ResourceRef,
        owner: &str,
    ) -> Consumer {
        Self::start(core, id, resource, 64, owner, &[]).await
    }

    /// A Node's drawer: the Pods bound to `node`.
    async fn subscribe_on_node(core: &AppCore, id: &ClusterId, node: &str) -> Consumer {
        let (tx, rx) = mpsc::channel(64);
        let id = core
            .resources_subscribe_node_pods(id, node.to_owned(), tx, "main")
            .await
            .unwrap();
        Consumer {
            id,
            rx,
            rows: BTreeMap::new(),
            seen: Vec::new(),
        }
    }

    /// The names of the rows, sorted.
    fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.rows.keys().map(|(_, name)| name.as_str()).collect();
        names.sort_unstable();
        names
    }

    /// A drawer, or a table that shows only `namespaces`.
    async fn subscribe_in(
        core: &AppCore,
        id: &ClusterId,
        resource: ResourceRef,
        namespaces: &[&str],
    ) -> Consumer {
        Self::start(core, id, resource, 64, "main", namespaces).await
    }

    async fn start(
        core: &AppCore,
        id: &ClusterId,
        resource: ResourceRef,
        capacity: usize,
        owner: &str,
        namespaces: &[&str],
    ) -> Consumer {
        let (tx, rx) = mpsc::channel(capacity);
        let namespaces = namespaces.iter().map(|&name| name.to_owned()).collect();
        let id = core
            .resources_subscribe(id, resource, namespaces, tx, owner)
            .await
            .unwrap();
        Consumer {
            id,
            rx,
            rows: BTreeMap::new(),
            seen: Vec::new(),
        }
    }

    fn take(&mut self, event: WatchEvent) {
        match &event {
            WatchEvent::Snapshot { items } => {
                self.rows.clear();
                for item in items.iter().map(Row::to_value) {
                    let row = row_of(&item);
                    self.rows.insert((row.namespace, row.name), item);
                }
            }
            WatchEvent::Batch { upserts, deletes } => {
                for item in upserts.iter().map(Row::to_value) {
                    let row = row_of(&item);
                    self.rows.insert((row.namespace, row.name), item);
                }
                for row in deletes {
                    self.rows.remove(&(row.namespace.clone(), row.name.clone()));
                }
            }
            WatchEvent::Status { .. } => {}
            WatchEvent::SnapshotPart { .. } => {
                panic!("only the forwarder to the webview cuts a snapshot")
            }
        }
        self.seen.push(event);
    }

    /// Receives until `done` holds.
    async fn until(&mut self, what: &str, done: impl Fn(&Consumer) -> bool) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while !done(self) {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(event)) => self.take(event),
                Ok(None) => panic!("closed before {what}; saw {}", self.summary()),
                Err(_) => panic!("timed out waiting for {what}; saw {}", self.summary()),
            }
        }
    }

    /// Receives whatever arrives during `span`.
    async fn drain_for(&mut self, span: Duration) {
        let deadline = tokio::time::Instant::now() + span;
        while let Ok(Some(event)) = tokio::time::timeout_at(deadline, self.rx.recv()).await {
            self.take(event);
        }
    }

    async fn until_closed(&mut self, what: &str, limit: Duration) {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(event)) => self.take(event),
                Ok(None) => return,
                Err(_) => panic!("{what} did not close; saw {}", self.summary()),
            }
        }
    }

    fn snapshots(&self) -> usize {
        self.seen
            .iter()
            .filter(|e| matches!(e, WatchEvent::Snapshot { .. }))
            .count()
    }

    fn batches(&self) -> usize {
        self.seen
            .iter()
            .filter(|e| matches!(e, WatchEvent::Batch { .. }))
            .count()
    }

    fn saw_status(&self, status: WatchStatus) -> bool {
        self.status_message(status).is_some()
    }

    /// The message of the last event with this status. `Some("")` when it has none.
    fn status_message(&self, wanted: WatchStatus) -> Option<String> {
        self.seen.iter().rev().find_map(|event| match event {
            WatchEvent::Status { status, message } if *status == wanted => {
                Some(message.clone().unwrap_or_default())
            }
            _ => None,
        })
    }

    /// The status of the last status event.
    fn last_status(&self) -> Option<&WatchStatus> {
        self.seen.iter().rev().find_map(|event| match event {
            WatchEvent::Status { status, .. } => Some(status),
            _ => None,
        })
    }

    /// The names the batches from `seen[marker]` on upserted and deleted, each sorted.
    fn changes_since(&self, marker: usize) -> (Vec<String>, Vec<String>) {
        let (mut upserted, mut deleted) = (Vec::new(), Vec::new());
        for event in &self.seen[marker..] {
            if let WatchEvent::Batch { upserts, deletes } = event {
                upserted.extend(upserts.iter().map(|row| row_of(&row.to_value()).name));
                deleted.extend(deletes.iter().map(|key| key.name.clone()));
            }
        }
        upserted.sort();
        deleted.sort();
        (upserted, deleted)
    }

    fn has(&self, namespace: &str, name: &str) -> bool {
        self.rows
            .contains_key(&(Some(namespace.to_owned()), name.to_owned()))
    }

    fn summary(&self) -> String {
        let events: Vec<String> = self
            .seen
            .iter()
            .map(|event| match event {
                WatchEvent::SnapshotPart { items } => format!("part({})", items.len()),
                WatchEvent::Snapshot { items } => format!("snapshot({})", items.len()),
                WatchEvent::Batch { upserts, deletes } => {
                    format!("batch(+{} -{})", upserts.len(), deletes.len())
                }
                WatchEvent::Status { status, .. } => format!("{status:?}"),
            })
            .collect();
        events.join(" ")
    }
}

impl Consumer {
    async fn subscribe_object(
        core: &AppCore,
        id: &ClusterId,
        resource: ResourceRef,
        namespace: Option<&str>,
        name: &str,
    ) -> Consumer {
        Self::subscribe_object_as(core, id, resource, namespace, name, "main").await
    }

    /// A detail panel in the window `owner`.
    async fn subscribe_object_as(
        core: &AppCore,
        id: &ClusterId,
        resource: ResourceRef,
        namespace: Option<&str>,
        name: &str,
        owner: &str,
    ) -> Consumer {
        let (tx, rx) = mpsc::channel(64);
        let id = core
            .resources_subscribe_object(
                id,
                resource,
                namespace.map(str::to_owned),
                name.to_owned(),
                tx,
                owner,
            )
            .await
            .unwrap();
        Consumer {
            id,
            rx,
            rows: BTreeMap::new(),
            seen: Vec::new(),
        }
    }
}

async fn eventually(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn first_event_is_a_snapshot_then_batches_follow() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    fake.add_pod("default", "two");

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;

    let first_data = pods
        .seen
        .iter()
        .find(|e| !matches!(e, WatchEvent::Status { .. }))
        .unwrap();
    assert!(matches!(first_data, WatchEvent::Snapshot { items } if items.len() == 2));
    // A status before the first data can only say the watcher is still syncing.
    let before = pods
        .seen
        .iter()
        .take_while(|e| !matches!(e, WatchEvent::Snapshot { .. }));
    for event in before {
        assert!(
            matches!(
                event,
                WatchEvent::Status {
                    status: WatchStatus::Syncing,
                    ..
                }
            ),
            "{event:?}"
        );
    }

    fake.add_pod("default", "three");
    pods.until("the added pod", |c| c.has("default", "three"))
        .await;
    assert_eq!(pods.snapshots(), 1, "an upsert must arrive in a batch");
    assert!(pods.batches() >= 1);

    fake.delete_pod("default", "one");
    pods.until("the deleted pod", |c| !c.has("default", "one"))
        .await;
    assert_eq!(pods.snapshots(), 1, "a delete must arrive in a batch");
    let deleted = pods.seen.iter().any(|event| {
        matches!(event, WatchEvent::Batch { deletes, .. } if deletes.contains(&key("default", "one")))
    });
    assert!(deleted, "{}", pods.summary());

    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
}

#[tokio::test]
async fn second_subscriber_shares_the_watcher_and_gets_a_snapshot() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.watch_request_count(PODS) == 1).await;
    fake.add_pod("default", "two");
    first
        .until("the second pod", |c| c.has("default", "two"))
        .await;
    let requests = fake.request_count(PODS);

    let mut second = Consumer::subscribe(&core, &id, pods()).await;
    second.until("the snapshot", |c| c.snapshots() == 1).await;

    assert!(second.has("default", "one") && second.has("default", "two"));
    assert_eq!(fake.watch_request_count(PODS), 1);
    assert_eq!(fake.request_count(PODS), requests, "no new list");
    assert_eq!(fake.open_watch_count(), 1);
}

#[tokio::test]
async fn watcher_closes_after_linger_when_no_subscribers_remain() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(FAST_BATCH, Duration::from_millis(200));
    fake.add_pod("default", "one");
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    core.resources_unsubscribe(&first.id);
    fake.add_pod("default", "while-away");
    eventually("the watch to close", || fake.open_watch_count() == 0).await;

    let mut again = Consumer::subscribe(&core, &id, pods()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(again.has("default", "one") && again.has("default", "while-away"));
}

#[tokio::test]
async fn dropping_the_receiver_counts_as_leaving() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(FAST_BATCH, Duration::from_millis(100));
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    drop(first);

    eventually("the watch to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn resubscribe_within_linger_reuses_the_watcher() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    core.resources_unsubscribe(&first.id);
    fake.add_pod("default", "while-away");
    let requests = fake.request_count(PODS);

    let mut again = Consumer::subscribe(&core, &id, pods()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;

    assert_eq!(fake.request_count(PODS), requests, "no new list or watch");
    assert_eq!(fake.open_watch_count(), 1);
    again
        .until("the pod added while away", |c| {
            c.has("default", "while-away")
        })
        .await;
}

fn object_with_server_fields(name: &str) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "{\"marker\":\"applied\"}",
                "keep": "me",
            },
            "managedFields": [{ "manager": "marker-manager", "operation": "Apply" }],
        },
        "spec": { "containers": [] },
    })
}

#[tokio::test]
async fn managed_fields_are_stripped() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    // A ConfigMap row cuts annotation values to 256 characters, which "keep" and "me" are under.
    fake.upsert("configmaps", object_with_server_fields("listed"));

    let configmaps = resource("", "ConfigMap", "configmaps", true);
    let mut table = Consumer::subscribe(&core, &id, configmaps).await;
    table.until("the snapshot", |c| c.snapshots() == 1).await;
    fake.upsert("configmaps", object_with_server_fields("watched"));
    table
        .until("the watched object", |c| c.has("default", "watched"))
        .await;

    let text = serde_json::to_string(&table.seen).unwrap();
    assert!(!text.contains("marker-manager"), "{text}");
    assert!(!text.contains("managedFields"), "{text}");
    assert!(!text.contains("last-applied-configuration"), "{text}");
    let row = table.rows.values().next().unwrap();
    assert_eq!(row["metadata"]["annotations"]["keep"], "me");
}

fn secret_object(name: &str) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration":
                    "{\"data\":{\"password\":\"czNjcjN0\"}}",
            },
        },
        "type": "Opaque",
        "data": { "password": "czNjcjN0", "user": "czNjcjN0" },
        "stringData": { "token": "czNjcjN0" },
    })
}

#[tokio::test]
async fn secret_values_are_stripped_from_watch() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    // A list item carries no kind, so this one is recognized by the resource.
    fake.upsert("secrets", secret_object("listed"));

    let mut secrets = Consumer::subscribe(&core, &id, secrets()).await;
    secrets.until("the snapshot", |c| c.snapshots() == 1).await;
    fake.upsert("secrets", secret_object("watched"));
    secrets
        .until("the watched secret", |c| c.has("default", "watched"))
        .await;

    let text = serde_json::to_string(&secrets.seen).unwrap();
    assert!(!text.contains("czNjcjN0"), "{text}");
    for row in secrets.rows.values() {
        assert_eq!(row["data"]["password"], "");
        assert_eq!(row["data"]["user"], "");
        assert_eq!(row["stringData"]["token"], "");
        assert_eq!(row["kind"], "Secret");
    }
}

#[tokio::test]
async fn a_wrong_kind_does_not_exempt_secrets() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("secrets", secret_object("listed"));

    let wrong = resource("", "ConfigMap", "secrets", true);
    let mut secrets = Consumer::subscribe(&core, &id, wrong).await;
    secrets.until("the snapshot", |c| c.snapshots() == 1).await;

    let text = serde_json::to_string(&secrets.seen).unwrap();
    assert!(!text.contains("czNjcjN0"), "{text}");
}

/// A drawer, or a table that shows a few namespaces, asks for those only. It is sent their
/// rows, from the one watch that also serves a table of every namespace.
#[tokio::test]
async fn a_subscription_of_some_namespaces_is_sent_only_their_rows() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    fake.add_pod("other", "two");

    let mut whole = Consumer::subscribe(&core, &id, pods()).await;
    let mut scoped = Consumer::subscribe_in(&core, &id, pods(), &["default"]).await;
    whole.until("both pods", |c| c.rows.len() == 2).await;
    scoped.until("its snapshot", |c| c.snapshots() == 1).await;
    assert_eq!(scoped.rows.len(), 1, "{}", scoped.summary());

    fake.add_pod("other", "three");
    fake.add_pod("default", "four");
    whole.until("both new pods", |c| c.rows.len() == 4).await;
    scoped.until("its new pod", |c| c.rows.len() == 2).await;

    let names: Vec<&str> = scoped.rows.keys().map(|(_, name)| name.as_str()).collect();
    assert_eq!(names, ["four", "one"]);
    let sent = serde_json::to_string(&scoped.seen).unwrap();
    assert!(!sent.contains("other"), "{sent}");
    assert_eq!(fake.watch_request_count("/api/v1/pods"), 1);
}

#[tokio::test]
async fn namespaces_that_cannot_apply_are_refused() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    for (resource, namespace) in [
        (resource("", "Node", "nodes", false), "default"),
        (pods(), "../kube-system"),
        (pods(), ""),
    ] {
        let (tx, _rx) = mpsc::channel(1);
        let err = core
            .resources_subscribe(&id, resource, vec![namespace.to_owned()], tx, "main")
            .await
            .expect_err(namespace);
        assert_eq!(err.code, skopos_core::error::ErrorCode::InvalidInput);
    }
}

#[tokio::test]
async fn a_resource_path_with_odd_characters_is_refused() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    for wrong in [
        resource("", "Pod", "../v1/secrets", true),
        resource("", "Pod", "", true),
        resource("example.com/x", "Pod", "pods", true),
        ResourceRef {
            version: "v1/../v1".into(),
            ..pods()
        },
    ] {
        let (tx, _rx) = mpsc::channel(1);
        let err = core
            .resources_subscribe(&id, wrong.clone(), Vec::new(), tx, "main")
            .await
            .expect_err(&format!("{wrong:?}"));
        assert_eq!(err.code, skopos_core::error::ErrorCode::InvalidInput);
    }
}

fn pod_on(namespace: &str, name: &str, node: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": { "namespace": namespace, "name": name },
        "spec": { "nodeName": node, "containers": [{ "name": "app", "image": "app" }] },
        "status": { "phase": "Running" },
    })
}

/// A Node's drawer shows the Pods bound to it. The API server picks them, so the Pods of
/// the other nodes are neither listed nor sent.
#[tokio::test]
async fn a_nodes_pods_are_picked_by_the_server_and_no_other_pod_is_sent() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("pods", pod_on("default", "one", "node-a"));
    fake.upsert("pods", pod_on("other", "two", "node-b"));

    let mut on_node = Consumer::subscribe_on_node(&core, &id, "node-a").await;
    on_node.until("its snapshot", |c| c.snapshots() == 1).await;
    assert_eq!(on_node.names(), ["one"], "{}", on_node.summary());

    fake.upsert("pods", pod_on("other", "three", "node-a"));
    fake.upsert("pods", pod_on("default", "four", "node-b"));
    fake.upsert("pods", pod_on("default", "five", "node-a"));
    on_node
        .until("the node's new pods", |c| c.has("default", "five"))
        .await;
    assert_eq!(on_node.names(), ["five", "one", "three"]);
    fake.delete_pod("default", "one");
    on_node
        .until("the delete", |c| !c.has("default", "one"))
        .await;

    let sent = serde_json::to_string(&on_node.seen).unwrap();
    assert!(!sent.contains("node-b"), "{sent}");
    assert_eq!(
        fake.list_field_selectors(PODS),
        [Some("spec.nodeName=node-a".to_owned())]
    );
}

/// The watch of one node holds only that node's Pods, so a table of every Pod never
/// shares it, and a node's drawer never shares the table's.
#[tokio::test]
async fn a_nodes_pods_and_a_table_of_every_pod_keep_their_own_watch() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("pods", pod_on("default", "one", "node-a"));
    fake.upsert("pods", pod_on("default", "two", "node-b"));

    let mut on_a = Consumer::subscribe_on_node(&core, &id, "node-a").await;
    let mut whole = Consumer::subscribe(&core, &id, pods()).await;
    let mut on_b = Consumer::subscribe_on_node(&core, &id, "node-b").await;
    let mut again = Consumer::subscribe_on_node(&core, &id, "node-a").await;
    whole.until("its snapshot", |c| c.snapshots() == 1).await;
    on_a.until("its snapshot", |c| c.snapshots() == 1).await;
    on_b.until("its snapshot", |c| c.snapshots() == 1).await;
    again.until("its snapshot", |c| c.snapshots() == 1).await;

    assert_eq!(whole.names(), ["one", "two"]);
    assert_eq!(on_a.names(), ["one"]);
    assert_eq!(on_b.names(), ["two"]);
    assert_eq!(again.names(), ["one"]);
    // One watch for each node and one for the table: the second drawer of a node shares.
    assert_eq!(fake.watch_request_count(PODS), 3);
}

/// When Pods may not be listed in every namespace, a node's Pods are picked the same way
/// in each namespace.
#[tokio::test]
async fn a_nodes_pods_fall_back_to_each_namespace_with_the_same_selector() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        forbid_cluster_wide_pods: true,
        namespaces: vec!["a".into(), "b".into()],
        ..Default::default()
    })
    .await;
    fake.upsert("pods", pod_on("a", "in-a", "node-a"));
    fake.upsert("pods", pod_on("b", "in-b", "node-a"));
    fake.upsert("pods", pod_on("b", "elsewhere", "node-b"));

    let mut on_node = Consumer::subscribe_on_node(&core, &id, "node-a").await;
    on_node.until("its snapshot", |c| c.snapshots() == 1).await;

    assert_eq!(on_node.names(), ["in-a", "in-b"], "{}", on_node.summary());
    for path in ["/api/v1/namespaces/a/pods", "/api/v1/namespaces/b/pods"] {
        assert_eq!(
            fake.list_field_selectors(path),
            [Some("spec.nodeName=node-a".to_owned())],
            "{path}"
        );
    }
}

#[tokio::test]
async fn a_node_name_that_is_no_name_is_refused() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    for node in ["", "..", "a/b", "a?b"] {
        let (tx, _rx) = mpsc::channel(1);
        let err = core
            .resources_subscribe_node_pods(&id, node.to_owned(), tx, "main")
            .await
            .expect_err(node);
        assert_eq!(err.code, ErrorCode::InvalidInput, "{node}");
    }
    assert_eq!(fake.request_count(PODS), 0);
}

fn numbered_pod(name: &str, rev: usize) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "labels": { "rev": rev.to_string() },
        },
        "spec": { "containers": [] },
    })
}

fn rev_of(consumer: &Consumer, name: &str) -> Option<String> {
    consumer
        .rows
        .get(&(Some("default".to_owned()), name.to_owned()))
        .and_then(|row| row.pointer("/metadata/labels/rev"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[tokio::test]
async fn updates_to_one_object_coalesce() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(Duration::from_millis(100), LONG_LINGER);
    fake.upsert("pods", numbered_pod("busy", 0));
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    for rev in 1..=200 {
        fake.upsert("pods", numbered_pod("busy", rev));
    }

    pods.until("the last update", |c| {
        rev_of(c, "busy").as_deref() == Some("200")
    })
    .await;
    assert!(pods.batches() < 20, "{}", pods.summary());
    pods.drain_for(Duration::from_millis(250)).await;
    assert_eq!(rev_of(&pods, "busy").as_deref(), Some("200"));
}

#[tokio::test]
async fn slow_subscriber_does_not_block_others() {
    const OBJECTS: usize = 20;
    const ROUNDS: usize = 50;
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut slow = Consumer::with_capacity(&core, &id, pods(), 1).await;
    let mut quick = Consumer::subscribe(&core, &id, pods()).await;
    quick.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    for rev in 1..=ROUNDS {
        for n in 0..OBJECTS {
            fake.upsert("pods", numbered_pod(&format!("pod-{n}"), rev));
        }
    }
    let last_rev = ROUNDS.to_string();
    let last_pod = format!("pod-{}", OBJECTS - 1);
    let started = Instant::now();
    quick
        .until("the last update", |c| {
            rev_of(c, &last_pod).as_deref() == Some(last_rev.as_str())
        })
        .await;
    assert!(
        started.elapsed() < QUIET,
        "the quick subscriber took {:?}",
        started.elapsed()
    );

    slow.until("the final state", |c| {
        (0..OBJECTS).all(|n| rev_of(c, &format!("pod-{n}")).as_deref() == Some(last_rev.as_str()))
    })
    .await;
    assert_eq!(slow.rows.len(), OBJECTS);
    // Pending holds one entry per object, so no batch can exceed the object count
    // and repeat one, and a thousand updates arrive as very few events.
    for event in &slow.seen {
        if let WatchEvent::Batch { upserts, .. } = event {
            assert!(upserts.len() <= OBJECTS, "{}", upserts.len());
            let unique: HashSet<_> = upserts.iter().map(|o| row_of(&o.to_value()).name).collect();
            assert_eq!(unique.len(), upserts.len());
        }
    }
    assert!(slow.seen.len() < 20, "{}", slow.summary());
}

#[tokio::test]
async fn a_stalled_subscriber_keeps_no_entry_for_objects_long_gone() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut stalled = Consumer::with_capacity(&core, &id, pods(), 1).await;
    let mut quick = Consumer::subscribe(&core, &id, pods()).await;
    quick.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    // Let the stalled subscriber's first events reach its channel.
    tokio::time::sleep(Duration::from_millis(100)).await;

    for n in 0..600 {
        let name = format!("short-lived-{n}");
        fake.add_pod("default", &name);
        fake.delete_pod("default", &name);
    }
    fake.add_pod("default", "last");
    quick
        .until("the last pod", |c| c.has("default", "last"))
        .await;

    stalled
        .until("the last pod", |c| c.has("default", "last"))
        .await;
    // The names that came and went were folded into a fresh snapshot.
    for event in &stalled.seen {
        if let WatchEvent::Batch { upserts, deletes } = event {
            assert!(upserts.len() + deletes.len() < 600, "{}", stalled.summary());
        }
    }
    assert_eq!(stalled.rows.len(), 1);
}

#[tokio::test]
async fn watch_drop_reconnects_and_reports_status() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.fail_watches_with("pods", Some(500));
    fake.drop_watches();
    pods.until("status reconnecting", |c| {
        c.saw_status(WatchStatus::Reconnecting)
    })
    .await;
    let message = pods.status_message(WatchStatus::Reconnecting).unwrap();
    assert!(message.contains("injected failure"), "{message}");
    assert!(pods.has("default", "one"), "the last data stays");
    let marker = pods.seen.len();
    fake.add_pod("default", "during-outage");

    fake.fail_watches_with("pods", None);
    pods.until("the pod added meanwhile", |c| {
        c.has("default", "during-outage")
    })
    .await;

    assert_eq!(pods.snapshots(), 1, "{}", pods.summary());
    let after: Vec<&WatchEvent> = pods.seen[marker..].iter().collect();
    let live = after
        .iter()
        .position(|e| {
            matches!(
                e,
                WatchEvent::Status {
                    status: WatchStatus::Live,
                    ..
                }
            )
        })
        .expect("status live after the outage");
    let rows = after
        .iter()
        .position(|e| matches!(e, WatchEvent::Batch { .. }))
        .unwrap();
    assert!(live < rows, "{}", pods.summary());
}

#[tokio::test]
async fn a_failing_watcher_backs_off() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    let before = fake.request_count(PODS);

    fake.fail_watches_with("pods", Some(500));
    fake.drop_watches();
    tokio::time::sleep(Duration::from_millis(3500)).await;

    // At most: the failed rewatch, then attempts after 1 s and 2 s more.
    let attempts = fake.request_count(PODS) - before;
    assert!((2..=4).contains(&attempts), "{attempts} attempts");
}

#[tokio::test]
async fn an_expired_resource_version_lists_again_without_reconnecting() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    let lists = fake.request_count(PODS) - fake.watch_request_count(PODS);
    fake.expire_watches("pods");

    eventually("the watch after the new list", || {
        fake.watch_request_count(PODS) == 2
    })
    .await;
    assert_eq!(
        fake.request_count(PODS) - fake.watch_request_count(PODS),
        lists + 1,
        "one new list"
    );
    fake.add_pod("default", "after");
    pods.until("a later pod", |c| c.has("default", "after"))
        .await;
    assert!(!pods.saw_status(WatchStatus::Reconnecting));
    assert!(pods.has("default", "one"));
}

#[tokio::test]
async fn a_new_list_that_changes_nothing_sends_no_rows() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(FAST_BATCH, LONG_LINGER);
    fake.add_pod("default", "one");
    fake.add_pod("default", "two");
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot and Live", |c| {
        c.snapshots() == 1 && c.saw_status(WatchStatus::Live)
    })
    .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    let seen = pods.seen.len();

    fake.expire_watches("pods");
    eventually("the watch after the new list", || {
        fake.watch_request_count(PODS) == 2
    })
    .await;

    pods.drain_for(Duration::from_millis(300)).await;
    assert_eq!(pods.seen.len(), seen, "{}", pods.summary());
    assert!(pods.has("default", "one") && pods.has("default", "two"));
}

#[tokio::test]
async fn a_new_list_after_an_outage_sends_only_what_changed() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(FAST_BATCH, LONG_LINGER);
    for name in ["kept", "changed", "gone"] {
        fake.upsert("pods", numbered_pod(name, 1));
    }
    let mut table = Consumer::subscribe(&core, &id, pods()).await;
    table
        .until("the snapshot and Live", |c| {
            c.snapshots() == 1 && c.saw_status(WatchStatus::Live)
        })
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.fail_watches_with("pods", Some(500));
    fake.drop_watches();
    table
        .until("status reconnecting", |c| {
            c.saw_status(WatchStatus::Reconnecting)
        })
        .await;
    let marker = table.seen.len();
    fake.upsert("pods", numbered_pod("changed", 2));
    fake.upsert("pods", numbered_pod("added", 1));
    fake.delete("pods", Some("default"), "gone");
    fake.fail_watches_with("pods", None);

    table
        .until("what changed meanwhile", |c| {
            c.has("default", "added")
                && !c.has("default", "gone")
                && rev_of(c, "changed").as_deref() == Some("2")
        })
        .await;

    assert_eq!(table.snapshots(), 1, "{}", table.summary());
    let (upserted, deleted) = table.changes_since(marker);
    assert_eq!(upserted, ["added", "changed"], "{}", table.summary());
    assert_eq!(deleted, ["gone"], "{}", table.summary());
    // A table opened now starts from the same rows.
    let mut late = Consumer::subscribe(&core, &id, pods()).await;
    late.until("the snapshot", |c| c.snapshots() == 1).await;
    assert_eq!(
        late.rows.keys().collect::<Vec<_>>(),
        table.rows.keys().collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn a_new_list_of_each_namespace_sends_no_rows_of_the_other() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        forbid_cluster_wide_pods: true,
        namespaces: vec!["a".into(), "b".into()],
        ..Default::default()
    })
    .await;
    core.set_watch_timing_for_test(FAST_BATCH, LONG_LINGER);
    fake.add_pod("a", "in-a");
    fake.add_pod("b", "in-b");
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot and Live", |c| {
        c.snapshots() == 1 && c.saw_status(WatchStatus::Live)
    })
    .await;
    eventually("both watches", || fake.open_watch_count() == 2).await;

    fake.fail_watches_with("pods", Some(500));
    fake.drop_watches();
    pods.until("status reconnecting", |c| {
        c.saw_status(WatchStatus::Reconnecting)
    })
    .await;
    let marker = pods.seen.len();
    fake.fail_watches_with("pods", None);
    // The old watches are gone, so each of these arrives only once its namespace is listed
    // again.
    fake.add_pod("a", "later-a");
    fake.add_pod("b", "later-b");
    pods.until("a later pod of each namespace", |c| {
        c.has("a", "later-a") && c.has("b", "later-b")
    })
    .await;

    assert_eq!(pods.snapshots(), 1, "{}", pods.summary());
    let (upserted, deleted) = pods.changes_since(marker);
    assert_eq!(upserted, ["later-a", "later-b"], "{}", pods.summary());
    assert!(deleted.is_empty(), "{deleted:?}");
    assert!(pods.has("a", "in-a") && pods.has("b", "in-b"));
}

/// Without the right to list a kind in every namespace, each namespace is listed by itself.
/// A cluster can have hundreds, so only some of them are listed at one time, whatever the
/// number of kinds being listed.
#[tokio::test]
async fn namespaces_are_listed_a_few_at_a_time_after_a_cluster_wide_refusal() {
    let names: Vec<String> = (0..40).map(|n| format!("team-{n:02}")).collect();
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        forbid_cluster_wide_pods: true,
        deny_cluster_wide: vec![DenyRule {
            verb: "list".into(),
            plural: "secrets".into(),
            namespace: None,
        }],
        namespaces: names.clone(),
        ..Default::default()
    })
    .await;
    for name in &names {
        fake.add_pod(name, "web");
    }
    fake.delay_namespaced_lists(Duration::from_millis(30));

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    let _secrets = Consumer::subscribe(&core, &id, secrets()).await;
    pods.until("the pod of every namespace", |c| c.rows.len() == 40)
        .await;
    eventually("a watch of every namespace for both kinds", || {
        fake.open_watch_count() == 80
    })
    .await;

    let most = fake.most_namespaced_lists_at_once();
    assert!(
        (2..=NAMESPACE_LISTS_AT_ONCE).contains(&most),
        "{most} namespaces were listed at one time"
    );
}

#[tokio::test]
async fn cluster_wide_forbidden_falls_back_to_namespaces() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        forbid_cluster_wide_pods: true,
        namespaces: vec!["a".into(), "b".into()],
        ..Default::default()
    })
    .await;
    fake.add_pod("a", "in-a");
    fake.add_pod("b", "in-b");

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(pods.has("a", "in-a") && pods.has("b", "in-b"));
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("both watches", || fake.open_watch_count() == 2).await;

    assert_eq!(fake.watch_request_count(PODS), 0);
    assert_eq!(fake.watch_request_count("/api/v1/namespaces/a/pods"), 1);
    assert_eq!(fake.watch_request_count("/api/v1/namespaces/b/pods"), 1);
    assert!(!pods.saw_status(WatchStatus::Reconnecting));

    fake.add_pod("b", "later");
    pods.until("the merged update", |c| c.has("b", "later"))
        .await;
    fake.delete_pod("a", "in-a");
    pods.until("the merged delete", |c| !c.has("a", "in-a"))
        .await;
    assert!(pods.has("b", "in-b"));
}

#[tokio::test]
async fn one_forbidden_namespace_leaves_the_others_live() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        forbid_cluster_wide_pods: true,
        namespaces: vec!["a".into(), "b".into()],
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "pods".into(),
            namespace: Some("b".into()),
        }],
        ..Default::default()
    })
    .await;
    fake.add_pod("a", "in-a");
    fake.add_pod("b", "in-b");

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;

    assert!(pods.has("a", "in-a"));
    assert!(!pods.has("b", "in-b"));
    assert!(!pods.saw_status(WatchStatus::Forbidden));
}

#[tokio::test]
async fn all_namespaces_forbidden_reports_forbidden_and_stops() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".into(), "b".into()],
        deny: vec![deny_list("pods")],
        ..Default::default()
    })
    .await;

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status forbidden", |c| c.saw_status(WatchStatus::Forbidden))
        .await;
    let message = pods.status_message(WatchStatus::Forbidden).unwrap();
    assert!(message.contains("cannot list resource"), "{message}");
    pods.until_closed("the subscription", QUIET).await;

    let count = || {
        fake.request_count(PODS)
            + fake.request_count("/api/v1/namespaces/a/pods")
            + fake.request_count("/api/v1/namespaces/b/pods")
    };
    let settled = count();
    assert!(settled <= 3, "{settled} requests");
    tokio::time::sleep(QUIET).await;
    assert_eq!(count(), settled, "no retries");
}

#[tokio::test]
async fn forbidden_cluster_scoped_resource_does_not_fall_back() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        deny: vec![deny_list("nodes")],
        ..Default::default()
    })
    .await;

    let nodes = resource("", "Node", "nodes", false);
    let mut nodes = Consumer::subscribe(&core, &id, nodes).await;
    nodes
        .until("status forbidden", |c| c.saw_status(WatchStatus::Forbidden))
        .await;

    assert_eq!(fake.request_count("/api/v1/namespaces/default/nodes"), 0);
}

#[tokio::test]
async fn resource_gone_reports_not_served_and_stops() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    fake.upsert("widgets", widget("one"));

    let mut widgets_sub = Consumer::subscribe(&core, &id, widgets()).await;
    widgets_sub
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.remove_resource("widgets");

    widgets_sub
        .until("status not served", |c| {
            c.saw_status(WatchStatus::NotServed)
        })
        .await;
    assert!(widgets_sub.has("default", "one"), "the last data stays");
    let requests = fake.request_count(WIDGETS);
    let documents = fake.request_count("/apis/example.com/v1");
    tokio::time::sleep(QUIET).await;
    assert_eq!(fake.request_count(WIDGETS), requests, "no retries");
    assert_eq!(
        fake.request_count("/apis/example.com/v1"),
        documents,
        "no discovery retries"
    );

    // Coming back to the table after the CRD returns starts over.
    fake.serve_resource(fake_widgets());
    fake.upsert("widgets", widget("reborn"));
    let mut again = Consumer::subscribe(&core, &id, widgets()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(again.has("default", "reborn"));
}

#[tokio::test]
async fn resource_gone_from_a_group_that_stays_reports_not_served() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    fake.serve_resource(FakeResource::new(
        "example.com",
        "v1",
        "Gadget",
        "gadgets",
        true,
    ));
    let mut widgets_sub = Consumer::subscribe(&core, &id, widgets()).await;
    widgets_sub
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.remove_resource("widgets");

    widgets_sub
        .until("status not served", |c| {
            c.saw_status(WatchStatus::NotServed)
        })
        .await;
}

#[tokio::test]
async fn not_found_while_discovery_still_serves_it_keeps_retrying() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    let mut widgets_sub = Consumer::subscribe(&core, &id, widgets()).await;
    widgets_sub
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.fail_watches_with("widgets", Some(404));
    fake.drop_watches();
    widgets_sub
        .until("status reconnecting", |c| {
            c.saw_status(WatchStatus::Reconnecting)
        })
        .await;
    fake.fail_watches_with("widgets", None);

    widgets_sub
        .until("status live again", |c| {
            c.last_status() == Some(&WatchStatus::Live)
        })
        .await;
    assert!(!widgets_sub.saw_status(WatchStatus::NotServed));
}

#[tokio::test]
async fn disconnect_ends_subscriptions_without_panic() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut pods_sub = Consumer::subscribe(&core, &id, pods()).await;
    pods_sub.until("the snapshot", |c| c.snapshots() == 1).await;
    // A subscriber that never reads must close too.
    let mut stalled = Consumer::with_capacity(&core, &id, pods(), 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    fake.add_pod("default", "two");
    tokio::time::sleep(Duration::from_millis(100)).await;

    core.cluster_disconnect(&id).await.unwrap();

    pods_sub.until_closed("the subscription", QUIET).await;
    stalled
        .until_closed("the stalled subscription", QUIET)
        .await;
    eventually("the watch to close", || fake.open_watch_count() == 0).await;

    let state = core.cluster_connect(&id).await.unwrap();
    assert!(matches!(state, ConnectionState::Connected { .. }));
    let mut again = Consumer::subscribe(&core, &id, pods()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(again.has("default", "one") && again.has("default", "two"));
}

#[tokio::test]
async fn subscribing_to_disconnected_cluster_errors() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.cluster_disconnect(&id).await.unwrap();

    let (tx, _rx) = mpsc::channel(1);
    assert!(core
        .resources_subscribe(&id, pods(), Vec::new(), tx, "main")
        .await
        .is_err());

    let (tx, _rx) = mpsc::channel(1);
    assert!(core
        .resources_subscribe(
            &"no-such-cluster".to_owned(),
            pods(),
            Vec::new(),
            tx,
            "main"
        )
        .await
        .is_err());
}

/// A table holds every Pod row, so a row carries only what the UI reads outside the drawer.
/// Its annotations stay for the filter, each value cut to 256 characters (spec M24, M26).
#[tokio::test]
async fn a_watched_pod_row_is_trimmed_and_a_get_returns_the_whole_pod() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let long = "x".repeat(300);
    fake.upsert(
        "pods",
        json!({
            "metadata": {
                "name": "full",
                "namespace": "default",
                "labels": { "app": "web" },
                "annotations": { "note": "for the drawer", "long": long },
            },
            "spec": { "containers": [{
                "name": "main",
                "image": "registry.k8s.io/pause:3.10",
                "env": [{ "name": "A", "value": "1" }],
            }] },
            "status": { "phase": "Running" },
        }),
    );
    let mut table = Consumer::subscribe(&core, &id, pods()).await;
    table.until("the pod", |c| c.has("default", "full")).await;
    let row = &table.rows[&(Some("default".to_owned()), "full".to_owned())];
    assert_eq!(row["metadata"]["labels"], json!({ "app": "web" }));
    assert_eq!(row["spec"]["containers"], json!([{ "name": "main" }]));
    assert_eq!(row["status"]["phase"], "Running");
    assert_eq!(
        row["metadata"]["annotations"],
        json!({ "note": "for the drawer", "long": "x".repeat(256) })
    );

    let whole = core
        .resource_get(&id, &pods(), Some("default"), "full")
        .await
        .unwrap();
    assert_eq!(
        whole["metadata"]["annotations"],
        json!({ "note": "for the drawer", "long": long })
    );
    assert_eq!(
        whole["spec"]["containers"][0]["env"],
        json!([{ "name": "A", "value": "1" }])
    );
    assert_eq!(
        whole["spec"]["containers"][0]["image"],
        "registry.k8s.io/pause:3.10"
    );
}

#[tokio::test]
async fn a_watched_config_map_row_blanks_its_values_and_a_get_returns_them() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let config_map = |name: &str| {
        json!({
            "metadata": { "name": name, "namespace": "default", "annotations": { "note": "n".repeat(300) } },
            "immutable": true,
            "data": { "mode": "fast", "empty": "" },
            "binaryData": { "blob": "AAEC" },
        })
    };
    fake.upsert("configmaps", config_map("listed"));
    let configmaps = resource("", "ConfigMap", "configmaps", true);
    let mut table = Consumer::subscribe(&core, &id, configmaps.clone()).await;
    table.until("the snapshot", |c| c.snapshots() == 1).await;
    fake.upsert("configmaps", config_map("watched"));
    table
        .until("the watched object", |c| c.has("default", "watched"))
        .await;

    for row in table.rows.values() {
        assert_eq!(row["data"], json!({ "mode": "", "empty": "" }));
        assert_eq!(row["binaryData"], json!({ "blob": "" }));
        assert!(row.get("immutable").is_none());
        assert_eq!(row["kind"], "ConfigMap");
        assert_eq!(row["metadata"]["annotations"]["note"], "n".repeat(256));
    }
    let whole = core
        .resource_get(&id, &configmaps, Some("default"), "listed")
        .await
        .unwrap();
    assert_eq!(whole["data"], json!({ "mode": "fast", "empty": "" }));
    assert_eq!(whole["binaryData"], json!({ "blob": "AAEC" }));
    assert_eq!(whole["immutable"], true);
}

#[tokio::test]
async fn watched_node_crd_and_replica_set_rows_are_trimmed_and_a_get_returns_them_whole() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(FakeResource::new(
        "apps",
        "v1",
        "ReplicaSet",
        "replicasets",
        true,
    ));
    fake.upsert(
        "nodes",
        json!({
            "metadata": { "name": "worker-1" },
            "spec": { "unschedulable": true, "podCIDR": "10.0.0.0/24" },
            "status": {
                "allocatable": { "cpu": "4" },
                "capacity": { "cpu": "8" },
                "images": [{ "names": ["registry.example.com/app:1"], "sizeBytes": 1 }],
                "nodeInfo": { "kubeletVersion": "v1.31.2", "machineID": "abc" },
            },
        }),
    );
    fake.upsert(
        "customresourcedefinitions",
        json!({
            "metadata": { "name": "widgets.example.com" },
            "spec": {
                "group": "example.com",
                "scope": "Namespaced",
                "names": { "plural": "widgets", "kind": "Widget" },
                "versions": [{
                    "name": "v1", "served": true, "storage": true,
                    "schema": { "openAPIV3Schema": { "type": "object" } },
                    "additionalPrinterColumns": [{ "name": "Size", "type": "integer", "jsonPath": ".spec.size" }],
                }],
            },
            "status": { "conditions": [{ "type": "Established", "status": "True", "message": "ok" }] },
        }),
    );
    fake.upsert(
        "replicasets",
        json!({
            "metadata": { "name": "web-1", "namespace": "default" },
            "spec": {
                "replicas": 2,
                "selector": { "matchLabels": { "app": "web" } },
                "template": { "spec": { "containers": [{ "name": "app", "image": "registry.example.com/app:1" }] } },
            },
            "status": { "replicas": 2, "availableReplicas": 2, "observedGeneration": 3 },
        }),
    );
    let nodes = resource("", "Node", "nodes", false);
    let crds = resource(
        "apiextensions.k8s.io",
        "CustomResourceDefinition",
        "customresourcedefinitions",
        false,
    );
    let replica_sets = resource("apps", "ReplicaSet", "replicasets", true);

    let mut node_table = Consumer::subscribe(&core, &id, nodes.clone()).await;
    let mut crd_table = Consumer::subscribe(&core, &id, crds.clone()).await;
    let mut rs_table = Consumer::subscribe(&core, &id, replica_sets.clone()).await;
    node_table.until("the node", |c| c.snapshots() == 1).await;
    crd_table.until("the crd", |c| c.snapshots() == 1).await;
    rs_table
        .until("the replica set", |c| c.snapshots() == 1)
        .await;

    let node = node_table.rows.values().next().unwrap();
    assert_eq!(node["spec"], json!({ "unschedulable": true }));
    assert_eq!(node["status"]["allocatable"], json!({ "cpu": "4" }));
    assert_eq!(
        node["status"]["nodeInfo"],
        json!({ "kubeletVersion": "v1.31.2" })
    );
    assert!(node["status"].get("images").is_none());
    assert!(node["status"].get("capacity").is_none());

    let crd = crd_table.rows.values().next().unwrap();
    assert!(crd["spec"]["versions"][0].get("schema").is_none());
    assert_eq!(
        crd["spec"]["versions"][0]["additionalPrinterColumns"][0]["jsonPath"],
        ".spec.size"
    );
    assert_eq!(
        crd["status"]["conditions"],
        json!([{ "type": "Established", "status": "True" }])
    );

    let rs = rs_table.rows.values().next().unwrap();
    assert_eq!(
        rs["spec"]["selector"],
        json!({ "matchLabels": { "app": "web" } })
    );
    assert_eq!(
        rs["spec"]["template"]["spec"]["containers"],
        json!([{ "name": "app" }])
    );
    assert!(rs["status"].get("observedGeneration").is_none());

    let whole = core
        .resource_get(&id, &nodes, None, "worker-1")
        .await
        .unwrap();
    assert_eq!(whole["status"]["images"][0]["sizeBytes"], 1);
    let whole = core
        .resource_get(&id, &crds, None, "widgets.example.com")
        .await
        .unwrap();
    assert_eq!(
        whole["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["type"],
        "object"
    );
    let whole = core
        .resource_get(&id, &replica_sets, Some("default"), "web-1")
        .await
        .unwrap();
    assert_eq!(whole["status"]["observedGeneration"], 3);
}

fn rich_pod(name: &str, rev: usize) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "labels": { "rev": rev.to_string() },
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "{\"marker\":\"applied\"}",
                "long": "x".repeat(300),
            },
            "managedFields": [{ "manager": "marker-manager", "operation": "Apply" }],
        },
        "spec": { "containers": [{
            "name": "main",
            "image": "registry.k8s.io/pause:3.10",
            "env": [{ "name": "A", "value": "1" }],
        }] },
        "status": { "phase": "Running", "hostIP": "10.0.0.9" },
    })
}

#[tokio::test]
async fn an_object_watch_sends_one_whole_object_then_its_changes_and_no_other() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("pods", rich_pod("web", 1));
    fake.upsert("pods", rich_pod("other", 1));

    let mut watch = Consumer::subscribe_object(&core, &id, pods(), Some("default"), "web").await;
    watch.until("the snapshot", |c| c.snapshots() == 1).await;
    assert_eq!(watch.rows.len(), 1, "{}", watch.summary());
    let row = &watch.rows[&(Some("default".to_owned()), "web".to_owned())];
    // Whole: no Pod trim.
    assert_eq!(
        row["spec"]["containers"][0]["env"],
        json!([{ "name": "A", "value": "1" }])
    );
    assert_eq!(
        row["spec"]["containers"][0]["image"],
        "registry.k8s.io/pause:3.10"
    );
    assert_eq!(row["status"]["hostIP"], "10.0.0.9");
    assert_eq!(row["metadata"]["annotations"]["long"], "x".repeat(300));
    // Stamped and stripped, as every row.
    assert_eq!(
        (row["kind"].as_str(), row["apiVersion"].as_str()),
        (Some("Pod"), Some("v1"))
    );
    let text = serde_json::to_string(&watch.seen).unwrap();
    assert!(
        !text.contains("marker-manager") && !text.contains("last-applied"),
        "{text}"
    );

    fake.upsert("pods", rich_pod("other", 2));
    fake.upsert("pods", rich_pod("web", 2));
    watch
        .until("the update", |c| rev_of(c, "web").as_deref() == Some("2"))
        .await;
    assert!(!watch.has("default", "other"), "{}", watch.summary());

    fake.delete("pods", Some("default"), "web");
    watch
        .until("the delete", |c| !c.has("default", "web"))
        .await;
    fake.upsert("pods", rich_pod("web", 3));
    watch
        .until("the object back", |c| {
            rev_of(c, "web").as_deref() == Some("3")
        })
        .await;
    assert!(!watch.has("default", "other"), "{}", watch.summary());
    assert_eq!(watch.snapshots(), 1, "{}", watch.summary());

    // One request for the namespace, none for a cluster-wide Pod watch.
    assert_eq!(fake.watch_request_count(PODS), 0);
    assert_eq!(
        fake.watch_request_count("/api/v1/namespaces/default/pods"),
        1
    );
}

#[tokio::test]
async fn an_object_watch_of_a_missing_object_sends_an_empty_snapshot_then_the_object() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut watch = Consumer::subscribe_object(&core, &id, pods(), Some("default"), "late").await;
    watch
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    assert_eq!(watch.snapshots(), 1);
    assert!(watch.rows.is_empty());

    fake.upsert("pods", rich_pod("late", 1));
    watch
        .until("the object", |c| c.has("default", "late"))
        .await;
    assert_eq!(watch.snapshots(), 1);
}

#[tokio::test]
async fn an_object_watch_of_a_cluster_scoped_object_uses_the_cluster_wide_path() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("nodes", json!({ "metadata": { "name": "worker-1" } }));
    fake.upsert("nodes", json!({ "metadata": { "name": "worker-2" } }));
    let nodes = resource("", "Node", "nodes", false);

    let mut watch = Consumer::subscribe_object(&core, &id, nodes, None, "worker-1").await;
    watch.until("the snapshot", |c| c.snapshots() == 1).await;

    assert_eq!(watch.rows.len(), 1);
    assert!(watch.rows.contains_key(&(None, "worker-1".to_owned())));
    // The snapshot ends the list; the watch request follows it.
    eventually("the watch request", || {
        fake.watch_request_count("/api/v1/nodes") == 1
    })
    .await;
}

#[tokio::test]
async fn an_object_watch_blanks_secret_values_in_the_snapshot_and_in_an_update() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("secrets", secret_object("db"));

    let mut watch = Consumer::subscribe_object(&core, &id, secrets(), Some("default"), "db").await;
    watch.until("the snapshot", |c| c.snapshots() == 1).await;
    fake.upsert("secrets", secret_object("db"));
    watch.until("the update", |c| c.batches() >= 1).await;

    let text = serde_json::to_string(&watch.seen).unwrap();
    assert!(!text.contains("czNjcjN0"), "{text}");
    let row = watch.rows.values().next().unwrap();
    assert_eq!(row["data"]["password"], "");
    assert_eq!(row["stringData"]["token"], "");
    assert_eq!(row["kind"], "Secret");
}

#[tokio::test]
async fn an_object_watch_without_the_right_to_list_reports_forbidden_and_ends() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        deny: vec![deny_list("pods")],
        ..Default::default()
    })
    .await;

    let mut watch = Consumer::subscribe_object(&core, &id, pods(), Some("default"), "web").await;
    watch
        .until("status forbidden", |c| c.saw_status(WatchStatus::Forbidden))
        .await;
    watch.until_closed("the subscription", QUIET).await;

    let path = "/api/v1/namespaces/default/pods";
    let settled = fake.request_count(path);
    tokio::time::sleep(QUIET).await;
    assert_eq!(fake.request_count(path), settled, "no retries");
}

#[tokio::test]
async fn an_object_watch_of_a_resource_that_is_gone_reports_not_served_and_ends() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    fake.upsert("widgets", widget("one"));

    let mut watch = Consumer::subscribe_object(&core, &id, widgets(), Some("default"), "one").await;
    watch
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.remove_resource("widgets");

    watch
        .until("status not served", |c| {
            c.saw_status(WatchStatus::NotServed)
        })
        .await;
    watch.until_closed("the subscription", QUIET).await;
}

#[tokio::test]
async fn an_object_watch_shares_the_id_counter_and_resources_unsubscribe_ends_it() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("pods", rich_pod("web", 1));
    let number = |c: &Consumer| c.id.trim_start_matches("watch-").parse::<u64>().unwrap();

    let mut table = Consumer::subscribe(&core, &id, pods()).await;
    let mut watch = Consumer::subscribe_object(&core, &id, pods(), Some("default"), "web").await;
    assert!(number(&watch) > number(&table), "{} {}", table.id, watch.id);
    table.until("the snapshot", |c| c.snapshots() == 1).await;
    watch.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("both watches", || fake.open_watch_count() == 2).await;

    core.resources_unsubscribe(&watch.id);

    watch.until_closed("the object watch", QUIET).await;
    eventually("the object watch to close", || fake.open_watch_count() == 1).await;
    fake.upsert("pods", rich_pod("web", 2));
    table
        .until("the table still live", |c| {
            rev_of(c, "web").as_deref() == Some("2")
        })
        .await;
}

#[tokio::test]
async fn an_object_watch_ends_when_the_cluster_disconnects() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("pods", rich_pod("web", 1));
    let mut watch = Consumer::subscribe_object(&core, &id, pods(), Some("default"), "web").await;
    watch.until("the snapshot", |c| c.snapshots() == 1).await;

    core.cluster_disconnect(&id).await.unwrap();

    watch.until_closed("the subscription", QUIET).await;
    eventually("the watch to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn an_object_watch_refuses_a_name_or_scope_that_does_not_fit_before_any_request() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let nodes = resource("", "Node", "nodes", false);
    let cases = [
        (pods(), Some("default"), "a/b"),
        (pods(), Some("default"), ".."),
        (pods(), Some("default"), ""),
        (pods(), Some("default"), "a%2Fb"),
        (pods(), Some("a/b"), "web"),
        (pods(), None, "web"),
        (nodes, Some("default"), "worker-1"),
        (resource("", "Pod", "../pods", true), Some("default"), "web"),
    ];
    for (resource, namespace, name) in cases {
        let (tx, _rx) = mpsc::channel(1);
        let refused = core
            .resources_subscribe_object(
                &id,
                resource.clone(),
                namespace.map(str::to_owned),
                name.to_owned(),
                tx,
                "main",
            )
            .await
            .unwrap_err();
        assert_eq!(
            refused.code,
            ErrorCode::InvalidInput,
            "{resource:?} {namespace:?} {name:?}"
        );
    }
    assert_eq!(fake.open_watch_count(), 0);

    core.cluster_disconnect(&id).await.unwrap();
    let (tx, _rx) = mpsc::channel(1);
    assert!(core
        .resources_subscribe_object(
            &id,
            pods(),
            Some("default".into()),
            "web".into(),
            tx,
            "main",
        )
        .await
        .is_err());
}

/// A Pod the graph follows to a ConfigMap, with what only the Pods table reads (the ports)
/// and what only the graph reads (the volumes and the service account).
fn mounting_pod(name: &str) -> Value {
    json!({
        "metadata": { "name": name, "namespace": "default" },
        "spec": {
            "serviceAccountName": "web",
            "volumes": [{ "name": "config", "configMap": { "name": "web-config" } }],
            "containers": [{
                "name": "main",
                "image": "registry.k8s.io/pause:3.10",
                "ports": [{ "containerPort": 8080 }],
                "env": [{ "name": "A", "value": "hidden-value" }],
            }],
        },
        "status": { "phase": "Running" },
    })
}

fn seed_mounting_pods(fake: &FakeKube) {
    fake.upsert(
        "configmaps",
        json!({ "metadata": { "name": "web-config", "namespace": "default" }, "data": { "a": "1" } }),
    );
    fake.upsert("pods", mounting_pod("web"));
}

/// Reads graph events until a snapshot holds the edge from Pod `pod` to the ConfigMap, and
/// gives it as the text that crosses to the interface.
async fn graph_mounting(graph: &mut mpsc::Receiver<Arc<GraphEvent>>, pod: &str) -> String {
    let from = format!("Pod/default/{pod}");
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let event = tokio::time::timeout_at(deadline, graph.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for the Mounts edge of {pod}"))
            .expect("the graph subscription ended");
        if let GraphEvent::Snapshot { edges, .. } = event.as_ref() {
            let mounted = edges.iter().any(|edge| {
                edge.from == from
                    && edge.to == "ConfigMap/default/web-config"
                    && edge.rel == GraphRel::Mounts
            });
            if mounted {
                return serde_json::to_string(event.as_ref()).unwrap();
            }
        }
    }
}

#[tokio::test]
async fn a_table_and_the_graph_share_one_pod_watcher_and_each_gets_its_own_rows() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_graph_interval_for_test(Duration::from_millis(100));
    seed_mounting_pods(&fake);

    let mut table = Consumer::subscribe(&core, &id, pods()).await;
    let (tx, mut graph) = mpsc::channel(16);
    core.resource_graph_subscribe(&id, None, tx, "main")
        .unwrap();
    table.until("the snapshot", |c| c.snapshots() == 1).await;
    let snapshot = graph_mounting(&mut graph, "web").await;

    // The table's row keeps the ports and not what only the graph reads.
    let row = &table.rows[&(Some("default".to_owned()), "web".to_owned())];
    assert_eq!(
        row["spec"]["containers"][0]["ports"][0]["containerPort"],
        8080
    );
    assert!(row["spec"].get("volumes").is_none());
    assert!(row["spec"].get("serviceAccountName").is_none());
    // The graph read the volumes from its own row, and no env value reached it.
    assert!(!snapshot.contains("hidden-value"), "{snapshot}");

    // A change reaches both shapes.
    fake.upsert("pods", mounting_pod("web-2"));
    table
        .until("the second pod", |c| c.has("default", "web-2"))
        .await;
    graph_mounting(&mut graph, "web-2").await;
    let row = &table.rows[&(Some("default".to_owned()), "web-2".to_owned())];
    assert!(row["spec"].get("volumes").is_none());

    assert_eq!(
        fake.watch_request_count(PODS),
        1,
        "the table and the graph share one Pod watch"
    );
}

#[tokio::test]
async fn the_pod_watcher_outlives_a_table_while_the_graph_still_reads_it() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let linger = Duration::from_millis(200);
    core.set_watch_timing_for_test(FAST_BATCH, linger);
    core.set_graph_interval_for_test(Duration::from_millis(100));
    seed_mounting_pods(&fake);
    let mut table = Consumer::subscribe(&core, &id, pods()).await;
    let (tx, mut graph) = mpsc::channel(16);
    let graph_id = core
        .resource_graph_subscribe(&id, None, tx, "main")
        .unwrap();
    table.until("the snapshot", |c| c.snapshots() == 1).await;
    graph_mounting(&mut graph, "web").await;
    assert_eq!(fake.watch_request_count(PODS), 1);

    core.resources_unsubscribe(&table.id);
    table.until_closed("the table", QUIET).await;
    tokio::time::sleep(linger * 3).await;

    // The graph is the group's last subscriber, so the table's leaving closed nothing.
    let mut again = Consumer::subscribe(&core, &id, pods()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(again.has("default", "web"));
    assert_eq!(
        fake.watch_request_count(PODS),
        1,
        "a table that comes back finds the Pod watch open"
    );

    core.resources_unsubscribe(&again.id);
    core.resource_graph_unsubscribe(&graph_id);
    eventually("every watch to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn a_quiet_subscription_sends_nothing_and_a_late_change_still_arrives_within_a_batch() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    fake.upsert("widgets", widget("one"));
    let mut table = Consumer::subscribe(&core, &id, widgets()).await;
    table
        .until("the snapshot and Live", |c| {
            c.snapshots() == 1 && c.saw_status(WatchStatus::Live)
        })
        .await;
    let seen = table.seen.len();

    table.drain_for(Duration::from_millis(600)).await;
    assert_eq!(table.seen.len(), seen, "{}", table.summary());

    let started = Instant::now();
    fake.upsert("widgets", widget("two"));
    table
        .until("the late change", |c| c.has("default", "two"))
        .await;
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_window_s_tables_end_with_it_and_another_window_s_go_on() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(FAST_BATCH, Duration::from_millis(100));
    fake.add_pod("default", "one");
    let mut kept = Consumer::subscribe_as(&core, &id, pods(), "main").await;
    let mut shared = Consumer::subscribe_as(&core, &id, pods(), "window-2").await;
    let mut alone = Consumer::subscribe_as(&core, &id, secrets(), "window-2").await;
    for table in [&mut kept, &mut shared, &mut alone] {
        table.until("the snapshot", |c| c.snapshots() == 1).await;
    }
    eventually("both watches", || fake.open_watch_count() == 2).await;

    core.subscriptions_stop_owned("window-2");

    shared.until_closed("the window's Pods", WAIT).await;
    alone.until_closed("the window's Secrets", WAIT).await;
    // The watch only that window read closes. The one it shared stays for the other window.
    eventually("the Secrets watch to close", || {
        fake.open_watch_count() == 1
    })
    .await;
    fake.add_pod("default", "two");
    kept.until("the second pod", |c| c.has("default", "two"))
        .await;
}

#[tokio::test]
async fn a_window_s_object_watch_ends_with_it_and_another_window_s_goes_on() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("pods", rich_pod("web", 1));
    let mut kept =
        Consumer::subscribe_object_as(&core, &id, pods(), Some("default"), "web", "main").await;
    let mut ended =
        Consumer::subscribe_object_as(&core, &id, pods(), Some("default"), "web", "window-2").await;
    for panel in [&mut kept, &mut ended] {
        panel.until("the snapshot", |c| c.snapshots() == 1).await;
    }
    eventually("both watches", || fake.open_watch_count() == 2).await;

    core.subscriptions_stop_owned("window-2");

    ended.until_closed("the window's watch", WAIT).await;
    eventually("its watch to close", || fake.open_watch_count() == 1).await;
    fake.upsert("pods", rich_pod("web", 2));
    kept.until("the update", |c| rev_of(c, "web").as_deref() == Some("2"))
        .await;
}
