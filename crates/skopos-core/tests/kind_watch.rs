//! The watch hub against the real `skopos-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::{ConfigMap, Container, Namespace, Node, Pod, PodSpec, Secret};
use k8s_openapi::ByteString;
use kube::api::{DeleteParams, ListParams, ObjectMeta, Patch, PatchParams, PostParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::resources::{ResourceRef, Row, WatchEvent};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "kind-skopos-e2e";
const NAMESPACE: &str = "skopos-test-watch";
const SECRET_NAMESPACE: &str = "skopos-test-watch-secrets";
const NODE_NAMESPACE: &str = "skopos-test-watch-node";
const WAIT: Duration = Duration::from_secs(30);

async fn connected() -> (AppCore, ClusterId, TempDir) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig");
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::copy(source, kube_dir.join("config")).unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let started = Instant::now();
    let id = loop {
        let found = core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == CONTEXT);
        if let Some(entry) = found {
            break entry.id;
        }
        assert!(started.elapsed() < WAIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    (core, id, root)
}

fn named(name: &str) -> ObjectMeta {
    ObjectMeta {
        name: Some(name.to_owned()),
        ..Default::default()
    }
}

/// Waits out a leftover from an earlier failed run, then creates the namespace.
async fn create_namespace(client: &Client, name: &str) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(name, &DeleteParams::default()).await;
    let started = Instant::now();
    while namespaces.get_opt(name).await.unwrap().is_some() {
        assert!(started.elapsed() < Duration::from_secs(90), "still there");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let namespace = Namespace {
        metadata: named(name),
        ..Default::default()
    };
    namespaces
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
}

async fn remove_namespace(client: &Client, name: &str) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(name, &DeleteParams::default()).await;
}

/// Runs `body`, removes `namespace` whether or not it failed, then reports the failure.
async fn with_namespace<F>(client: &Client, namespace: &str, body: F)
where
    F: std::future::Future<Output = ()>,
{
    create_namespace(client, namespace).await;
    let outcome = AssertUnwindSafe(body).catch_unwind().await;
    remove_namespace(client, namespace).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

fn row_name(object: &Value) -> (String, String) {
    (
        object["metadata"]["namespace"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        object["metadata"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}

struct Table {
    rx: mpsc::Receiver<WatchEvent>,
    rows: BTreeMap<(String, String), Value>,
}

impl Table {
    async fn subscribe(core: &AppCore, id: &ClusterId, resource: ResourceRef) -> Table {
        let (tx, rx) = mpsc::channel(64);
        core.resources_subscribe(id, resource, Vec::new(), tx, "main")
            .await
            .unwrap();
        Table {
            rx,
            rows: BTreeMap::new(),
        }
    }

    /// A Node's drawer: the Pods bound to `node`.
    async fn subscribe_on_node(core: &AppCore, id: &ClusterId, node: &str) -> Table {
        let (tx, rx) = mpsc::channel(64);
        core.resources_subscribe_node_pods(id, node.to_owned(), tx, "main")
            .await
            .unwrap();
        Table {
            rx,
            rows: BTreeMap::new(),
        }
    }

    async fn until(&mut self, what: &str, limit: Duration, done: impl Fn(&Self) -> bool) {
        let deadline = tokio::time::Instant::now() + limit;
        while !done(self) {
            let event = tokio::time::timeout_at(deadline, self.rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
                .unwrap_or_else(|| panic!("closed before {what}"));
            match event {
                WatchEvent::Snapshot { items } => {
                    self.rows = items
                        .iter()
                        .map(Row::to_value)
                        .map(|o| (row_name(&o), o))
                        .collect();
                }
                WatchEvent::Batch { upserts, deletes } => {
                    for object in upserts.iter().map(Row::to_value) {
                        self.rows.insert(row_name(&object), object);
                    }
                    for key in deletes {
                        self.rows
                            .remove(&(key.namespace.unwrap_or_default(), key.name));
                    }
                }
                WatchEvent::Status { .. } => {}
                WatchEvent::SnapshotPart { .. } => {
                    panic!("only the forwarder to the webview cuts a snapshot")
                }
            }
        }
    }

    fn row(&self, namespace: &str, name: &str) -> Option<&Value> {
        self.rows.get(&(namespace.to_owned(), name.to_owned()))
    }
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn configmap_changes_arrive_within_a_second() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();

    with_namespace(&client, NAMESPACE, async {
        let maps: Api<ConfigMap> = Api::namespaced(client.clone(), NAMESPACE);
        let map = ConfigMap {
            metadata: named("watched"),
            data: Some([("key".to_owned(), "first".to_owned())].into()),
            ..Default::default()
        };
        maps.create(&PostParams::default(), &map).await.unwrap();

        let resource = ResourceRef {
            group: String::new(),
            version: "v1".to_owned(),
            plural: "configmaps".to_owned(),
            kind: "ConfigMap".to_owned(),
            namespaced: true,
        };
        let mut table = Table::subscribe(&core, &id, resource).await;
        table
            .until("the configmap", WAIT, |t| {
                t.row(NAMESPACE, "watched").is_some()
            })
            .await;
        let row = table.row(NAMESPACE, "watched").unwrap();
        assert!(row["metadata"].get("managedFields").is_none());
        assert_eq!(row["kind"], "ConfigMap");

        // Watched ConfigMap rows keep their keys with blank values, so the change shows as the
        // patched object's resourceVersion.
        let version = maps
            .patch(
                "watched",
                &PatchParams::default(),
                &Patch::Merge(json!({ "data": { "key": "second" } })),
            )
            .await
            .unwrap()
            .metadata
            .resource_version
            .unwrap();
        let patched = Instant::now();
        table
            .until("the change", Duration::from_secs(1), |t| {
                t.row(NAMESPACE, "watched").is_some_and(|row| {
                    row["metadata"]["resourceVersion"].as_str() == Some(version.as_str())
                })
            })
            .await;
        assert!(patched.elapsed() < Duration::from_secs(1));
        assert_eq!(table.row(NAMESPACE, "watched").unwrap()["data"]["key"], "");

        maps.delete("watched", &DeleteParams::default())
            .await
            .unwrap();
        table
            .until("the delete", Duration::from_secs(1), |t| {
                t.row(NAMESPACE, "watched").is_none()
            })
            .await;
    })
    .await;
}

/// A real server leaves `kind` out of list items, which must not let values through.
#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn listed_and_watched_secrets_arrive_without_values() {
    const VALUE: &str = "kind-watch-marker-value";
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();

    with_namespace(&client, SECRET_NAMESPACE, async {
        let secrets: Api<Secret> = Api::namespaced(client.clone(), SECRET_NAMESPACE);
        let secret = |name: &str| Secret {
            metadata: named(name),
            data: Some([("password".to_owned(), ByteString(VALUE.into()))].into()),
            ..Default::default()
        };
        secrets
            .create(&PostParams::default(), &secret("listed"))
            .await
            .unwrap();

        let resource = ResourceRef {
            group: String::new(),
            version: "v1".to_owned(),
            plural: "secrets".to_owned(),
            kind: "Secret".to_owned(),
            namespaced: true,
        };
        let mut table = Table::subscribe(&core, &id, resource).await;
        table
            .until("the listed secret", WAIT, |t| {
                t.row(SECRET_NAMESPACE, "listed").is_some()
            })
            .await;
        secrets
            .create(&PostParams::default(), &secret("watched"))
            .await
            .unwrap();
        table
            .until("the watched secret", WAIT, |t| {
                t.row(SECRET_NAMESPACE, "watched").is_some()
            })
            .await;

        for name in ["listed", "watched"] {
            let row = table.row(SECRET_NAMESPACE, name).unwrap();
            assert_eq!(row["data"]["password"], "", "{name}");
        }
    })
    .await;
}

fn pause_pod(name: &str, spec: PodSpec) -> Pod {
    Pod {
        metadata: named(name),
        spec: Some(PodSpec {
            containers: vec![Container {
                name: "main".to_owned(),
                image: Some("registry.k8s.io/pause:3.10".to_owned()),
                ..Default::default()
            }],
            ..spec
        }),
        ..Default::default()
    }
}

/// Creates the Pod once its new namespace has the service account a Pod needs.
async fn create_pod(pods: &Api<Pod>, pod: &Pod) {
    let started = Instant::now();
    while let Err(error) = pods.create(&PostParams::default(), pod).await {
        assert!(started.elapsed() < WAIT, "the pod was not created: {error}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// A real server picks a node's Pods by `spec.nodeName`: those of every namespace that are
/// bound to it, a Pod bound to it later, and no Pod that is bound to no node.
#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_nodes_pods_are_the_ones_the_server_says_are_bound_to_it() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    let nodes: Api<Node> = Api::all(client.clone());
    let node = nodes.list(&ListParams::default()).await.unwrap().items[0]
        .metadata
        .name
        .clone()
        .unwrap();

    with_namespace(&client, NODE_NAMESPACE, async {
        let pods: Api<Pod> = Api::namespaced(client.clone(), NODE_NAMESPACE);
        let mut on_node = Table::subscribe_on_node(&core, &id, &node).await;
        on_node
            .until("the node's system pods", WAIT, |t| {
                t.rows
                    .keys()
                    .any(|(namespace, _)| namespace == "kube-system")
            })
            .await;

        // No node has this label, so the Pod stays bound to none.
        let unbound = PodSpec {
            node_selector: Some([("skopos.test/no-such-node".to_owned(), "x".to_owned())].into()),
            ..Default::default()
        };
        create_pod(&pods, &pause_pod("unbound", unbound)).await;
        let bound = PodSpec {
            node_name: Some(node.clone()),
            ..Default::default()
        };
        create_pod(&pods, &pause_pod("bound", bound)).await;
        on_node
            .until("the pod bound to the node", WAIT, |t| {
                t.row(NODE_NAMESPACE, "bound").is_some()
            })
            .await;

        assert!(on_node.row(NODE_NAMESPACE, "unbound").is_none());
        for (key, row) in &on_node.rows {
            assert_eq!(row["spec"]["nodeName"], node.as_str(), "{key:?}");
        }

        pods.delete("bound", &DeleteParams::default().grace_period(0))
            .await
            .unwrap();
        on_node
            .until("the delete", WAIT, |t| {
                t.row(NODE_NAMESPACE, "bound").is_none()
            })
            .await;
    })
    .await;
}
