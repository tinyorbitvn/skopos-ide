//! The resource graph against the real `skopos-e2e` kind cluster (spec E §4.8, O §4.6).
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, ObjectMeta, Patch, PatchParams, PostParams,
};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::graph::{
    GraphEdge, GraphEvent, GraphNamespaceCount, GraphNode, GraphRel, GraphStatus,
};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use support::{connected_kind, in_namespace};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "kind-skopos-e2e";
/// The namespace, and the names of the GatewayClass and the CiliumClusterwideNetworkPolicy.
const NAMESPACE: &str = "skopos-test-graph";
const GATEWAY: &str = "gateway.networking.k8s.io";
const CILIUM: &str = "cilium.io";
const ARGO: &str = "argoproj.io";
/// A git SHA, as Argo CD writes `status.sync.revision`.
const REVISION: &str = "4f2a9c1e0b7d3a5f6c8e9d0a1b2c3d4e5f6a7b8c";
const REPO: &str = "https://git.example.com/policies.git";
const RBAC: &str = "rbac.authorization.k8s.io";
/// The ClusterRoleBinding of ServiceAccount `web` to the built-in ClusterRole `view`.
const VIEW_BINDING: &str = "skopos-test-graph-web-view";
const GATEWAY_API: &str =
    "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml";
const GATEWAY_CRDS: [&str; 3] = [
    "crd/gatewayclasses.gateway.networking.k8s.io",
    "crd/gateways.gateway.networking.k8s.io",
    "crd/httproutes.gateway.networking.k8s.io",
];
const WAIT: Duration = Duration::from_secs(120);
const SECRET_VALUE: &str = "graph-test-secret-value";
/// `SECRET_VALUE` in base64, as the API server keeps it.
const SECRET_BASE64: &str = "Z3JhcGgtdGVzdC1zZWNyZXQtdmFsdWU=";
const PLAIN_VALUE: &str = "graph-test-plain-value";

fn kubeconfig() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig")
}

fn kubectl(args: &[&str]) -> Output {
    Command::new("kubectl")
        .arg("--kubeconfig")
        .arg(kubeconfig())
        .args(["--context", CONTEXT])
        .args(args)
        .output()
        .expect("kubectl runs")
}

/// Spec E §18.3: the interface's e2e fixture runs the same command. Both leave the CRDs.
fn install_gateway_api() {
    let applied = kubectl(&[
        "--request-timeout=60s",
        "apply",
        "--server-side",
        "--force-conflicts",
        "--field-manager=skopos-e2e",
        "-f",
        GATEWAY_API,
    ]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    // A CRD just created has no conditions yet, and kubectl wait then fails at once instead of
    // waiting, so try again.
    let started = Instant::now();
    loop {
        let mut args = vec!["wait", "--for=condition=Established", "--timeout=60s"];
        args.extend(GATEWAY_CRDS);
        let waited = kubectl(&args);
        if waited.status.success() {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "{}",
            String::from_utf8_lossy(&waited.stderr)
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Connects after the CRDs are in, since discovery is read when the cluster connects.
async fn connected() -> (AppCore, ClusterId, TempDir) {
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::copy(kubeconfig(), kube_dir.join("config")).unwrap();
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

fn api(
    client: &Client,
    group: &str,
    kind: &str,
    plural: &str,
    namespaced: bool,
) -> Api<DynamicObject> {
    versioned_api(client, group, "v1", kind, plural, namespaced)
}

fn versioned_api(
    client: &Client,
    group: &str,
    version: &str,
    kind: &str,
    plural: &str,
    namespaced: bool,
) -> Api<DynamicObject> {
    let api_version = if group.is_empty() {
        version.to_owned()
    } else {
        format!("{group}/{version}")
    };
    let resource = ApiResource {
        group: group.into(),
        version: version.into(),
        api_version,
        kind: kind.into(),
        plural: plural.into(),
    };
    if namespaced {
        Api::namespaced_with(client.clone(), NAMESPACE, &resource)
    } else {
        Api::all_with(client.clone(), &resource)
    }
}

fn cluster_policies(client: &Client) -> Api<DynamicObject> {
    versioned_api(
        client,
        CILIUM,
        "v2",
        "CiliumClusterwideNetworkPolicy",
        "ciliumclusterwidenetworkpolicies",
        false,
    )
}

/// Two Pods, a policy of each source selecting them, and an Application that manages the two
/// namespaced policies and the namespace, with its AppProject and the ApplicationSet that owns
/// it. No Argo CD controller watches this namespace, so the Application's status stays as
/// written here, as the controller would write it.
async fn create_policies_and_argo_cd(client: &Client) {
    let meta = |name: &str| json!({ "name": name, "namespace": NAMESPACE });
    for app in ["web", "api"] {
        apply(
            &api(client, "", "Pod", "pods", true),
            json!({
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": { "name": app, "namespace": NAMESPACE, "labels": { "app": app } },
                "spec": {
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{ "name": "app", "image": "registry.k8s.io/pause:3.10" }],
                },
            }),
        )
        .await;
    }
    apply(
        &api(
            client,
            "networking.k8s.io",
            "NetworkPolicy",
            "networkpolicies",
            true,
        ),
        json!({
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": meta("web"),
            "spec": {
                "podSelector": { "matchLabels": { "app": "web" } },
                "ingress": [{ "from": [{ "podSelector": { "matchLabels": { "app": "api" } } }] }],
            },
        }),
    )
    .await;
    apply(
        &versioned_api(
            client,
            CILIUM,
            "v2",
            "CiliumNetworkPolicy",
            "ciliumnetworkpolicies",
            true,
        ),
        json!({
            "apiVersion": format!("{CILIUM}/v2"),
            "kind": "CiliumNetworkPolicy",
            "metadata": meta("api"),
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "api" } },
                "ingress": [{ "fromEndpoints": [{ "matchLabels": { "app": "web" } }] }],
            },
        }),
    )
    .await;
    apply(
        &cluster_policies(client),
        json!({
            "apiVersion": format!("{CILIUM}/v2"),
            "kind": "CiliumClusterwideNetworkPolicy",
            "metadata": { "name": NAMESPACE },
            "spec": {
                "endpointSelector": { "matchLabels": { "io.kubernetes.pod.namespace": NAMESPACE } },
                "egress": [{ "toEntities": ["cluster"] }],
            },
        }),
    )
    .await;

    let argo =
        |kind: &str, plural: &str| versioned_api(client, ARGO, "v1alpha1", kind, plural, true);
    let destination = json!({ "server": "https://kubernetes.default.svc", "namespace": NAMESPACE });
    let source = json!({ "repoURL": REPO, "path": "policies", "targetRevision": "HEAD" });
    apply(
        &argo("AppProject", "appprojects"),
        json!({
            "apiVersion": format!("{ARGO}/v1alpha1"),
            "kind": "AppProject",
            "metadata": meta("policies"),
            "spec": { "sourceRepos": ["*"], "destinations": [destination] },
        }),
    )
    .await;
    let application_sets = argo("ApplicationSet", "applicationsets");
    apply(
        &application_sets,
        json!({
            "apiVersion": format!("{ARGO}/v1alpha1"),
            "kind": "ApplicationSet",
            "metadata": meta("policies"),
            "spec": {
                "generators": [{ "list": { "elements": [] } }],
                "template": {
                    "metadata": { "name": "policies" },
                    "spec": { "project": "policies", "source": source, "destination": destination },
                },
            },
        }),
    )
    .await;
    let owner = application_sets.get("policies").await.unwrap();
    let uid = owner.metadata.uid.expect("the API server sets a uid");
    // The Application CRD has no status subresource, so the status goes in with the object.
    apply(
        &argo("Application", "applications"),
        json!({
            "apiVersion": format!("{ARGO}/v1alpha1"),
            "kind": "Application",
            "metadata": {
                "name": "policies",
                "namespace": NAMESPACE,
                "ownerReferences": [{
                    "apiVersion": format!("{ARGO}/v1alpha1"),
                    "kind": "ApplicationSet",
                    "name": "policies",
                    "uid": uid,
                    "controller": true,
                }],
            },
            "spec": { "project": "policies", "source": source, "destination": destination },
            "status": {
                "health": { "status": "Healthy" },
                "sync": { "status": "Synced", "revision": REVISION },
                "resources": [
                    {
                        "group": "networking.k8s.io",
                        "version": "v1",
                        "kind": "NetworkPolicy",
                        "namespace": NAMESPACE,
                        "name": "web",
                        "status": "Synced",
                    },
                    {
                        "group": CILIUM,
                        "version": "v2",
                        "kind": "CiliumNetworkPolicy",
                        "namespace": NAMESPACE,
                        "name": "api",
                        "status": "Synced",
                    },
                    { "version": "v1", "kind": "Namespace", "name": NAMESPACE, "status": "Synced" },
                ],
            },
        }),
    )
    .await;
}

fn gateway_classes(client: &Client) -> Api<DynamicObject> {
    api(client, GATEWAY, "GatewayClass", "gatewayclasses", false)
}

fn cluster_role_bindings(client: &Client) -> Api<DynamicObject> {
    api(
        client,
        RBAC,
        "ClusterRoleBinding",
        "clusterrolebindings",
        false,
    )
}

async fn apply(api: &Api<DynamicObject>, object: Value) {
    let name = object["metadata"]["name"].as_str().unwrap().to_owned();
    let params = PatchParams::apply("skopos-test").force();
    api.patch(&name, &params, &Patch::Apply(&object))
        .await
        .unwrap_or_else(|e| panic!("apply {name}: {e}"));
}

/// The objects of the interface's e2e fixture (spec E §18.3), in this test's namespace.
async fn create_fixture(client: &Client) {
    let meta = |name: &str| json!({ "name": name, "namespace": NAMESPACE });
    apply(
        &gateway_classes(client),
        json!({
            "apiVersion": format!("{GATEWAY}/v1"),
            "kind": "GatewayClass",
            "metadata": { "name": NAMESPACE },
            "spec": { "controllerName": "example.com/skopos-test" },
        }),
    )
    .await;
    let objects = [
        (
            GATEWAY,
            "Gateway",
            "gateways",
            json!({
                "metadata": meta("edge"),
                "spec": {
                    "gatewayClassName": NAMESPACE,
                    "listeners": [{ "name": "http", "port": 80, "protocol": "HTTP" }],
                },
            }),
        ),
        (
            GATEWAY,
            "HTTPRoute",
            "httproutes",
            json!({
                "metadata": meta("web"),
                "spec": {
                    "parentRefs": [{ "name": "edge" }],
                    "rules": [{ "backendRefs": [{ "name": "web", "port": 80 }] }],
                },
            }),
        ),
        (
            "networking.k8s.io",
            "Ingress",
            "ingresses",
            json!({
                "metadata": meta("web"),
                "spec": { "defaultBackend": { "service": { "name": "web", "port": { "number": 80 } } } },
            }),
        ),
        (
            "",
            "Service",
            "services",
            json!({
                "metadata": meta("web"),
                "spec": { "selector": { "app": "web" }, "ports": [{ "port": 80 }] },
            }),
        ),
        (
            "",
            "ServiceAccount",
            "serviceaccounts",
            json!({ "metadata": meta("web") }),
        ),
        (
            "",
            "ConfigMap",
            "configmaps",
            json!({ "metadata": meta("web-config"), "data": { "mode": "fast" } }),
        ),
        (
            "",
            "Secret",
            "secrets",
            json!({
                "metadata": meta("web-secret"),
                "type": "Opaque",
                "stringData": { "TOKEN": SECRET_VALUE },
            }),
        ),
        (
            "",
            "PersistentVolumeClaim",
            "persistentvolumeclaims",
            json!({
                "metadata": meta("web-data"),
                "spec": { "accessModes": ["ReadWriteOnce"], "resources": { "requests": { "storage": "1Mi" } } },
            }),
        ),
        (
            "apps",
            "Deployment",
            "deployments",
            json!({
                "metadata": meta("web"),
                "spec": {
                    "replicas": 1,
                    "selector": { "matchLabels": { "app": "web" } },
                    "template": {
                        "metadata": { "labels": { "app": "web" } },
                        "spec": {
                            "serviceAccountName": "web",
                            "containers": [{
                                "name": "app",
                                "image": "registry.k8s.io/pause:3.10",
                                "env": [{ "name": "PLAIN", "value": PLAIN_VALUE }],
                                "envFrom": [{ "secretRef": { "name": "web-secret" } }],
                                "volumeMounts": [
                                    { "name": "config", "mountPath": "/config" },
                                    { "name": "data", "mountPath": "/data" },
                                ],
                            }],
                            "volumes": [
                                { "name": "config", "configMap": { "name": "web-config" } },
                                { "name": "data", "persistentVolumeClaim": { "claimName": "web-data" } },
                            ],
                        },
                    },
                },
            }),
        ),
    ];
    for (group, kind, plural, mut object) in objects {
        object["apiVersion"] = json!(if group.is_empty() {
            "v1".to_owned()
        } else {
            format!("{group}/v1")
        });
        object["kind"] = json!(kind);
        apply(&api(client, group, kind, plural, true), object).await;
    }
}

/// Spec O §4.6: ServiceAccount `web` gets a RoleBinding to a Role that reads ConfigMaps, and a
/// ClusterRoleBinding to the built-in ClusterRole `view`.
async fn create_access(client: &Client) {
    let subjects = json!([{ "kind": "ServiceAccount", "name": "web", "namespace": NAMESPACE }]);
    let role_ref = |kind: &str, name: &str| json!({ "apiGroup": RBAC, "kind": kind, "name": name });
    apply(
        &api(client, RBAC, "Role", "roles", true),
        json!({
            "apiVersion": format!("{RBAC}/v1"),
            "kind": "Role",
            "metadata": { "name": "web-config-reader", "namespace": NAMESPACE },
            "rules": [{ "apiGroups": [""], "resources": ["configmaps"], "verbs": ["get", "list"] }],
        }),
    )
    .await;
    apply(
        &api(client, RBAC, "RoleBinding", "rolebindings", true),
        json!({
            "apiVersion": format!("{RBAC}/v1"),
            "kind": "RoleBinding",
            "metadata": { "name": "web-config-reader", "namespace": NAMESPACE },
            "roleRef": role_ref("Role", "web-config-reader"),
            "subjects": subjects,
        }),
    )
    .await;
    apply(
        &cluster_role_bindings(client),
        json!({
            "apiVersion": format!("{RBAC}/v1"),
            "kind": "ClusterRoleBinding",
            "metadata": { "name": VIEW_BINDING },
            "roleRef": role_ref("ClusterRole", "view"),
            "subjects": subjects,
        }),
    )
    .await;
}

/// Waits out a leftover from an earlier failed run, then creates the namespace.
async fn create_namespace(client: &Client) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    let started = Instant::now();
    while namespaces.get_opt(NAMESPACE).await.unwrap().is_some() {
        assert!(started.elapsed() < Duration::from_secs(90), "still there");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let namespace = Namespace {
        metadata: ObjectMeta {
            name: Some(NAMESPACE.to_owned()),
            ..Default::default()
        },
        ..Default::default()
    };
    namespaces
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
}

/// Builds the fixture, runs `body`, removes the namespace, the GatewayClass and the
/// ClusterRoleBinding whether or not it failed, then reports the failure.
async fn with_fixture<F>(client: &Client, body: F)
where
    F: std::future::Future<Output = ()>,
{
    create_namespace(client).await;
    let outcome = AssertUnwindSafe(async {
        create_fixture(client).await;
        body.await;
    })
    .catch_unwind()
    .await;
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    let _ = gateway_classes(client)
        .delete(NAMESPACE, &DeleteParams::default())
        .await;
    let _ = cluster_role_bindings(client)
        .delete(VIEW_BINDING, &DeleteParams::default())
        .await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

fn id(kind: &str, name: &str) -> String {
    format!("{kind}/{NAMESPACE}/{name}")
}

struct Snapshot {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    counts: Vec<GraphNamespaceCount>,
    missing: Vec<String>,
    gateway_api: bool,
    json: String,
}

impl Snapshot {
    fn find(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    fn node(&self, id: &str) -> &GraphNode {
        self.find(id).unwrap_or_else(|| {
            let ids: Vec<&str> = self.nodes.iter().map(|n| n.id.as_str()).collect();
            panic!("no {id} in {ids:?}")
        })
    }

    /// The one node of `kind` in the namespace, whose name the cluster chose.
    fn only(&self, kind: &str) -> &GraphNode {
        let prefix = format!("{kind}/{NAMESPACE}/");
        let found: Vec<&GraphNode> = self
            .nodes
            .iter()
            .filter(|n| n.id.starts_with(&prefix))
            .collect();
        assert_eq!(found.len(), 1, "{kind}: {found:?}");
        found[0]
    }

    fn has_edge(&self, from: &str, to: &str, rel: GraphRel) -> bool {
        self.edges
            .iter()
            .any(|e| e.from == from && e.to == to && e.rel == rel)
    }
}

struct Map {
    id: String,
    rx: mpsc::Receiver<Arc<GraphEvent>>,
}

impl Map {
    fn start(core: &AppCore, cluster: &ClusterId) -> Self {
        let (tx, rx) = mpsc::channel(16);
        let id = core
            .resource_graph_subscribe(cluster, Some(vec![NAMESPACE.to_owned()]), tx, "main")
            .unwrap();
        Self { id, rx }
    }

    /// Reads snapshots until one satisfies `done`. Review Focus 2: no snapshot on the way
    /// holds a Secret's value or an environment variable's value.
    async fn until(&mut self, what: &str, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let started = Instant::now();
        loop {
            let left = WAIT
                .checked_sub(started.elapsed())
                .unwrap_or_else(|| panic!("timed out waiting for {what}"));
            let event = tokio::time::timeout(left, self.rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
                .expect("the subscription ended");
            let json = serde_json::to_string(event.as_ref()).unwrap();
            let event = Arc::unwrap_or_clone(event);
            for value in [SECRET_VALUE, SECRET_BASE64, PLAIN_VALUE] {
                assert!(!json.contains(value), "{value} left the core");
            }
            let GraphEvent::Snapshot {
                nodes,
                edges,
                counts,
                missing,
                gateway_api,
            } = event
            else {
                panic!("expected a snapshot, got {json}");
            };
            let snapshot = Snapshot {
                nodes,
                edges,
                counts,
                missing,
                gateway_api,
                json,
            };
            if done(&snapshot) {
                return snapshot;
            }
        }
    }
}

fn status_of<'a>(snapshot: &'a Snapshot, id: &str) -> (GraphStatus, Option<&'a str>) {
    let node = snapshot.node(id);
    (node.status, node.status_text.as_deref())
}

/// The value of the node's fact `label`.
fn fact<'a>(snapshot: &'a Snapshot, id: &str, label: &str) -> Option<&'a str> {
    snapshot
        .node(id)
        .facts
        .iter()
        .find(|(name, _)| name == label)
        .map(|(_, value)| value.as_str())
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn the_graph_of_the_e2e_fixture() {
    install_gateway_api();
    let (core, cluster, _root) = connected().await;
    let client = core.cluster_client(&cluster).unwrap();
    with_fixture(&client, async {
        let mut map = Map::start(&core, &cluster);
        let ready = map
            .until("the Deployment and the Service to be ready", |s| {
                let nominal = |node: &str| {
                    s.find(node)
                        .is_some_and(|n| n.status == GraphStatus::Nominal)
                };
                nominal(&id("Deployment", "web")) && nominal(&id("Service", "web"))
            })
            .await;

        let replica_set = ready.only("ReplicaSet").id.clone();
        let pod = ready.only("Pod").id.clone();
        let class = format!("GatewayClass//{NAMESPACE}");
        let expected = [
            (id("Deployment", "web"), replica_set.clone(), GraphRel::Owns),
            (replica_set.clone(), pod.clone(), GraphRel::Owns),
            (id("Service", "web"), pod.clone(), GraphRel::Selects),
            (id("Ingress", "web"), id("Service", "web"), GraphRel::Routes),
            (
                id("Gateway", "edge"),
                id("HTTPRoute", "web"),
                GraphRel::Routes,
            ),
            (
                id("HTTPRoute", "web"),
                id("Service", "web"),
                GraphRel::Routes,
            ),
            (id("Gateway", "edge"), class.clone(), GraphRel::Class),
            (pod.clone(), id("ConfigMap", "web-config"), GraphRel::Mounts),
            (
                pod.clone(),
                id("PersistentVolumeClaim", "web-data"),
                GraphRel::Claims,
            ),
            (pod.clone(), id("Secret", "web-secret"), GraphRel::Env),
            (pod.clone(), id("ServiceAccount", "web"), GraphRel::RunsAs),
        ];
        for (from, to, rel) in &expected {
            assert!(ready.has_edge(from, to, *rel), "{from} {rel:?} {to}");
        }
        assert_eq!(ready.edges.len(), expected.len(), "{:?}", ready.edges);
        assert_eq!(
            ready.nodes.len(),
            12,
            "eleven in the namespace and the GatewayClass"
        );
        let counted = ready
            .counts
            .iter()
            .find(|c| c.namespace == NAMESPACE)
            .map(|c| c.nodes);
        assert_eq!(counted, Some(11));
        assert!(ready.missing.is_empty(), "{:?}", ready.missing);
        assert!(ready.gateway_api);
        assert!(
            !ready.json.contains("kube-root-ca.crt"),
            "the projected root CA gives no node"
        );

        // Nothing runs a Gateway or Ingress controller on the kind cluster.
        assert_eq!(
            status_of(&ready, &class),
            (GraphStatus::Warning, Some("Waiting for the controller"))
        );
        assert_eq!(
            status_of(&ready, &id("Gateway", "edge")),
            (GraphStatus::Warning, Some("Not programmed yet"))
        );
        assert_eq!(
            status_of(&ready, &id("HTTPRoute", "web")),
            (GraphStatus::Warning, Some("Not accepted yet"))
        );
        assert_eq!(
            status_of(&ready, &id("Ingress", "web")),
            (GraphStatus::Warning, Some("No address yet"))
        );
        assert_eq!(
            status_of(&ready, &pod),
            (GraphStatus::Nominal, Some("Running"))
        );
        assert_eq!(
            ready.node(&id("Secret", "web-secret")).facts,
            [
                ("Type".to_owned(), "Opaque".to_owned()),
                ("Keys".to_owned(), "1".to_owned()),
            ]
        );

        let config_maps: Api<ConfigMap> = Api::namespaced(client.clone(), NAMESPACE);
        config_maps
            .delete("web-config", &DeleteParams::default())
            .await
            .unwrap();
        let later = map
            .until("the ConfigMap to be gone", |s| {
                s.find(&id("ConfigMap", "web-config"))
                    .is_some_and(|n| n.status_text.as_deref() == Some("Not found"))
            })
            .await;
        assert_eq!(
            status_of(&later, &id("ConfigMap", "web-config")).0,
            GraphStatus::Critical
        );
        core.resource_graph_unsubscribe(&map.id);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn the_access_chain_of_a_service_account() {
    install_gateway_api();
    let (core, cluster, _root) = connected().await;
    let client = core.cluster_client(&cluster).unwrap();
    with_fixture(&client, async {
        create_access(&client).await;
        let mut map = Map::start(&core, &cluster);
        let role = id("Role", "web-config-reader");
        let view = "ClusterRole//view";
        let chain = map
            .until("the Role and ClusterRole view", |s| {
                s.find(&role).is_some() && s.find(view).is_some()
            })
            .await;

        let account = id("ServiceAccount", "web");
        let binding = id("RoleBinding", "web-config-reader");
        let cluster_binding = format!("ClusterRoleBinding//{VIEW_BINDING}");
        let pod = chain.only("Pod").id.clone();
        for (from, to, rel) in [
            (pod.as_str(), account.as_str(), GraphRel::RunsAs),
            (binding.as_str(), account.as_str(), GraphRel::Binds),
            (binding.as_str(), role.as_str(), GraphRel::Grants),
            (cluster_binding.as_str(), account.as_str(), GraphRel::Binds),
            (cluster_binding.as_str(), view, GraphRel::Grants),
        ] {
            assert!(chain.has_edge(from, to, rel), "{from} {rel:?} {to}");
        }
        assert_eq!(status_of(&chain, &role), (GraphStatus::Neutral, None));
        assert_eq!(
            chain.node(&role).facts,
            [("configmaps".to_owned(), "get, list".to_owned())]
        );
        assert_eq!(
            chain.node(&binding).facts,
            [
                ("Role".to_owned(), "Role web-config-reader".to_owned()),
                ("Subjects".to_owned(), "1 ServiceAccount".to_owned()),
            ]
        );
        assert_eq!(
            chain.node(view).facts.last(),
            Some(&("Aggregated".to_owned(), "Yes".to_owned())),
            "the built-in view collects the aggregate-to-view roles"
        );
        let counted = chain
            .counts
            .iter()
            .find(|c| c.namespace == NAMESPACE)
            .map(|c| c.nodes);
        assert_eq!(
            counted,
            Some(13),
            "the RoleBinding and the Role join the eleven"
        );
        assert!(chain.missing.is_empty(), "{:?}", chain.missing);
        core.resource_graph_unsubscribe(&map.id);
    })
    .await;
}

/// Spec §3.3 and §6.1: the policy and Argo CD nodes with their edges, and the cluster-wide
/// policy joining the namespace view through the Pods it selects (contract C14).
#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn the_policies_and_argo_cd_objects_of_a_namespace() {
    let (core, cluster, _root) = connected_kind().await;
    let client = core.cluster_client(&cluster).unwrap();
    let cluster_policy_api = cluster_policies(&client);
    // A leftover of an earlier failed run.
    let _ = cluster_policy_api
        .delete(NAMESPACE, &DeleteParams::default())
        .await;
    let outcome = AssertUnwindSafe(in_namespace(&client, NAMESPACE, async {
        create_policies_and_argo_cd(&client).await;
        let mut map = Map::start(&core, &cluster);
        let web = id("Pod", "web");
        let api_pod = id("Pod", "api");
        let network_policy = id("NetworkPolicy", "web");
        let cilium_policy = id("CiliumNetworkPolicy", "api");
        let cluster_policy = format!("CiliumClusterwideNetworkPolicy//{NAMESPACE}");
        let application = id("Application", "policies");
        let project = id("AppProject", "policies");
        let application_set = id("ApplicationSet", "policies");
        let expected = [
            (network_policy.clone(), web.clone(), GraphRel::Selects),
            (cilium_policy.clone(), api_pod.clone(), GraphRel::Selects),
            (cluster_policy.clone(), web.clone(), GraphRel::Selects),
            (cluster_policy.clone(), api_pod.clone(), GraphRel::Selects),
            (
                application.clone(),
                network_policy.clone(),
                GraphRel::Manages,
            ),
            (
                application.clone(),
                cilium_policy.clone(),
                GraphRel::Manages,
            ),
            (application.clone(), project.clone(), GraphRel::Project),
            (application_set.clone(), application.clone(), GraphRel::Owns),
        ];
        let ready = map
            .until("the policy and Argo CD edges", |s| {
                expected
                    .iter()
                    .all(|(from, to, rel)| s.has_edge(from, to, *rel))
            })
            .await;

        assert!(
            ready.find(&format!("Namespace//{NAMESPACE}")).is_none(),
            "a Namespace in status.resources is counted, not drawn"
        );
        assert!(ready.missing.is_empty(), "{:?}", ready.missing);
        assert_eq!(ready.node(&cluster_policy).namespace, "");
        for (policy, source) in [
            (&network_policy, "Kubernetes"),
            (&cilium_policy, "Cilium"),
            (&cluster_policy, "Cilium cluster-wide"),
        ] {
            assert_eq!(fact(&ready, policy, "Source"), Some(source), "{policy}");
            assert_eq!(
                status_of(&ready, policy).0,
                GraphStatus::Neutral,
                "{policy}"
            );
        }
        assert_eq!(
            status_of(&ready, &application),
            (GraphStatus::Nominal, Some("Healthy · Synced"))
        );
        assert_eq!(fact(&ready, &application, "Project"), Some("policies"));
        assert_eq!(fact(&ready, &application, "Health"), Some("Healthy"));
        assert_eq!(fact(&ready, &application, "Sync"), Some("Synced"));
        assert_eq!(fact(&ready, &application, "Revision"), Some(&REVISION[..7]));
        assert_eq!(status_of(&ready, &application_set).0, GraphStatus::Nominal);
        assert_eq!(status_of(&ready, &project).0, GraphStatus::Neutral);
        assert_eq!(fact(&ready, &project, "Destinations"), Some("1"));
        assert_eq!(fact(&ready, &project, "Source repos"), Some("1"));
        core.resource_graph_unsubscribe(&map.id);
    }))
    .catch_unwind()
    .await;
    let _ = cluster_policy_api
        .delete(NAMESPACE, &DeleteParams::default())
        .await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
