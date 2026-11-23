//! The reachability of the sample namespace (contract C13) against the real `skopos-e2e` kind
//! cluster, with the Cilium CRDs of `e2e/fixtures/cilium-crds.yaml`, which
//! `scripts/kind-up.sh` installs. No Cilium agent runs: the API server keeps the policies and
//! the core reads them as written. CoreDNS is the kind cluster's own.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{ApiResource, DeleteParams, DynamicObject, ListParams, PostParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::reachability::{
    NotEvaluated, PolicyRef, ReachCell, ReachCounts, ReachEvent, ReachGroup, ReachHttp,
    ReachMissing, ReachPeer, ReachPeerKind, ReachPolicySource, ReachPort, ReachProtocol,
    ReachVerdict,
};
use support::{connected_kind, in_namespace};
use tokio::sync::mpsc;

/// C13's `payments`, and the prefix of the other two namespaces.
const NAMESPACE: &str = "skopos-kind-reach";
/// C13's `ingress-nginx`.
const INGRESS: &str = "skopos-kind-reach-ingress";
/// C13's `monitoring`.
const MONITORING: &str = "skopos-kind-reach-monitoring";
const CLUSTER_POLICY: &str = "skopos-kind-reach-allow-prometheus-scrape";
const PAUSE: &str = "registry.k8s.io/pause:3.10";
const WAIT: Duration = Duration::from_secs(120);

/// (group, version, kind, plural)
type Resource = (&'static str, &'static str, &'static str, &'static str);
const DEPLOYMENTS: Resource = ("apps", "v1", "Deployment", "deployments");
const STATEFUL_SETS: Resource = ("apps", "v1", "StatefulSet", "statefulsets");
const NETWORK_POLICIES: Resource = (
    "networking.k8s.io",
    "v1",
    "NetworkPolicy",
    "networkpolicies",
);
const CILIUM_POLICIES: Resource = (
    "cilium.io",
    "v2",
    "CiliumNetworkPolicy",
    "ciliumnetworkpolicies",
);
const CILIUM_CLUSTER_POLICIES: Resource = (
    "cilium.io",
    "v2",
    "CiliumClusterwideNetworkPolicy",
    "ciliumclusterwidenetworkpolicies",
);

/// `namespace` is `None` for a cluster-scoped kind.
fn api(client: &Client, resource: Resource, namespace: Option<&str>) -> Api<DynamicObject> {
    let (group, version, kind, plural) = resource;
    let api_resource = ApiResource {
        group: group.into(),
        version: version.into(),
        api_version: format!("{group}/{version}"),
        kind: kind.into(),
        plural: plural.into(),
    };
    match namespace {
        Some(namespace) => Api::namespaced_with(client.clone(), namespace, &api_resource),
        None => Api::all_with(client.clone(), &api_resource),
    }
}

async fn create(client: &Client, resource: Resource, namespace: Option<&str>, mut object: Value) {
    let (group, version, kind, _) = resource;
    object["apiVersion"] = json!(format!("{group}/{version}"));
    object["kind"] = json!(kind);
    let name = object["metadata"]["name"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let object: DynamicObject = serde_json::from_value(object).unwrap();
    api(client, resource, namespace)
        .create(&PostParams::default(), &object)
        .await
        .unwrap_or_else(|e| panic!("create {kind} {name}: {e}"));
}

/// A Deployment or StatefulSet of `replicas` pause Pods with `labels` and container `ports`.
async fn workload(
    client: &Client,
    resource: Resource,
    namespace: &str,
    name: &str,
    replicas: u32,
    labels: Value,
    ports: Value,
) {
    let mut spec = json!({
        "replicas": replicas,
        "selector": { "matchLabels": labels },
        "template": {
            "metadata": { "labels": labels },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [{ "name": "app", "image": PAUSE, "ports": ports }],
            },
        },
    });
    if resource == STATEFUL_SETS {
        spec["serviceName"] = json!(name);
    }
    create(
        client,
        resource,
        Some(namespace),
        json!({ "metadata": { "name": name }, "spec": spec }),
    )
    .await;
}

/// C13's workloads and policies, in the three namespaces and the cluster.
async fn create_sample(client: &Client) {
    let ports = json!([
        { "name": "http", "containerPort": 8080, "protocol": "TCP" },
        { "name": "metrics", "containerPort": 9090, "protocol": "TCP" },
    ]);
    workload(
        client,
        DEPLOYMENTS,
        NAMESPACE,
        "web",
        3,
        json!({ "app": "web", "tier": "frontend" }),
        ports.clone(),
    )
    .await;
    workload(
        client,
        DEPLOYMENTS,
        NAMESPACE,
        "api",
        2,
        json!({ "app": "api", "tier": "backend" }),
        ports,
    )
    .await;
    workload(
        client,
        STATEFUL_SETS,
        NAMESPACE,
        "db",
        1,
        json!({ "app": "db", "tier": "data" }),
        json!([
            { "name": "postgres", "containerPort": 5432, "protocol": "TCP" },
            { "name": "metrics", "containerPort": 9090, "protocol": "TCP" },
        ]),
    )
    .await;
    workload(
        client,
        DEPLOYMENTS,
        NAMESPACE,
        "worker",
        2,
        json!({ "app": "worker" }),
        json!([]),
    )
    .await;
    workload(
        client,
        DEPLOYMENTS,
        INGRESS,
        "ingress-nginx-controller",
        1,
        json!({ "app.kubernetes.io/name": "ingress-nginx" }),
        json!([{ "containerPort": 80, "protocol": "TCP" }]),
    )
    .await;
    workload(
        client,
        DEPLOYMENTS,
        MONITORING,
        "prometheus",
        1,
        json!({ "app": "prometheus" }),
        json!([{ "containerPort": 9090, "protocol": "TCP" }]),
    )
    .await;

    let app = |name: &str| json!({ "matchLabels": { "app": name } });
    let web_api_db = json!({ "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web", "api", "db"] }] });
    let tcp = |port: u16| json!({ "protocol": "TCP", "port": port });
    let network_policies = [
        (
            "default-deny",
            json!({ "podSelector": web_api_db, "policyTypes": ["Ingress", "Egress"] }),
        ),
        (
            "allow-web-from-ingress",
            json!({
                "podSelector": app("web"),
                "ingress": [{
                    "from": [{ "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": INGRESS } } }],
                    "ports": [tcp(8080)],
                }],
            }),
        ),
        (
            "allow-db-from-api",
            json!({
                "podSelector": app("db"),
                "ingress": [{ "from": [{ "podSelector": app("api") }], "ports": [tcp(5432)] }],
            }),
        ),
        (
            "allow-web-to-api",
            json!({
                "podSelector": app("web"),
                "policyTypes": ["Egress"],
                "egress": [{ "to": [{ "podSelector": app("api") }], "ports": [tcp(8080)] }],
            }),
        ),
        (
            "allow-api-to-db",
            json!({
                "podSelector": app("api"),
                "policyTypes": ["Egress"],
                "egress": [{ "to": [{ "podSelector": app("db") }], "ports": [tcp(5432)] }],
            }),
        ),
        (
            "allow-dns",
            json!({
                "podSelector": web_api_db,
                "policyTypes": ["Egress"],
                "egress": [{
                    "to": [{
                        "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "kube-system" } },
                        "podSelector": { "matchLabels": { "k8s-app": "kube-dns" } },
                    }],
                    "ports": [{ "protocol": "UDP", "port": 53 }, tcp(53)],
                }],
            }),
        ),
    ];
    for (name, spec) in network_policies {
        create(
            client,
            NETWORK_POLICIES,
            Some(NAMESPACE),
            json!({ "metadata": { "name": name }, "spec": spec }),
        )
        .await;
    }

    // Cilium writes ports as strings.
    let cilium_policies = [
        (
            "allow-api-from-web",
            json!({
                "endpointSelector": app("api"),
                "ingress": [{
                    "fromEndpoints": [app("web")],
                    "toPorts": [{
                        "ports": [{ "port": "8080", "protocol": "TCP" }],
                        "rules": { "http": [{ "method": "GET", "path": "/api/.*" }] },
                    }],
                }],
            }),
        ),
        (
            "api-egress-stripe",
            json!({
                "endpointSelector": app("api"),
                "egress": [
                    {
                        "toFQDNs": [{ "matchName": "api.stripe.com" }],
                        "toPorts": [{ "ports": [{ "port": "443", "protocol": "TCP" }] }],
                    },
                    {
                        "toEndpoints": [{ "matchLabels": {
                            "k8s:io.kubernetes.pod.namespace": "kube-system",
                            "k8s-app": "kube-dns",
                        } }],
                        "toPorts": [{
                            "ports": [{ "port": "53", "protocol": "UDP" }],
                            "rules": { "dns": [{ "matchPattern": "*" }] },
                        }],
                    },
                ],
            }),
        ),
        (
            "db-no-internet",
            json!({
                "endpointSelector": app("db"),
                "egressDeny": [{ "toEntities": ["world"] }],
            }),
        ),
    ];
    for (name, spec) in cilium_policies {
        create(
            client,
            CILIUM_POLICIES,
            Some(NAMESPACE),
            json!({ "metadata": { "name": name }, "spec": spec }),
        )
        .await;
    }
    create(
        client,
        CILIUM_CLUSTER_POLICIES,
        None,
        json!({
            "metadata": { "name": CLUSTER_POLICY },
            "spec": {
                "endpointSelector": {
                    "matchLabels": { "io.kubernetes.pod.namespace": NAMESPACE },
                    "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web", "api", "db"] }],
                },
                "ingress": [{
                    "fromEndpoints": [{ "matchLabels": {
                        "k8s:io.kubernetes.pod.namespace": MONITORING,
                        "app": "prometheus",
                    } }],
                    "toPorts": [{ "ports": [{ "port": "9090", "protocol": "TCP" }] }],
                }],
            },
        }),
    )
    .await;
}

/// Runs `test` with the sample in place, then removes the three namespaces and the
/// cluster-wide policy whether or not it failed.
async fn with_sample<F: Future<Output = ()>>(client: &Client, test: F) {
    let cluster_policies = api(client, CILIUM_CLUSTER_POLICIES, None);
    // A leftover of an earlier failed run.
    let _ = cluster_policies
        .delete(CLUSTER_POLICY, &DeleteParams::default())
        .await;
    let sample = async move {
        create_sample(client).await;
        test.await;
    };
    let outcome = AssertUnwindSafe(in_namespace(
        client,
        INGRESS,
        in_namespace(client, MONITORING, in_namespace(client, NAMESPACE, sample)),
    ))
    .catch_unwind()
    .await;
    let _ = cluster_policies
        .delete(CLUSTER_POLICY, &DeleteParams::default())
        .await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// Waits until `count` Pods of `namespace` run.
async fn wait_running_pods(client: &Client, namespace: &str, count: usize) {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let started = Instant::now();
    loop {
        let listed = pods.list(&ListParams::default()).await.unwrap();
        let running = listed
            .items
            .iter()
            .filter(|pod| {
                pod.metadata.deletion_timestamp.is_none()
                    && pod.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running")
            })
            .count();
        if running == count {
            return;
        }
        assert!(
            started.elapsed() < WAIT,
            "{running} of {count} Pods run in {namespace}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

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
}

/// Reads snapshots until one satisfies `done`. A failure ends the test.
async fn until(
    rx: &mut mpsc::Receiver<Arc<ReachEvent>>,
    what: &str,
    done: impl Fn(&Snapshot) -> bool,
) -> Snapshot {
    let started = Instant::now();
    loop {
        let left = WAIT
            .checked_sub(started.elapsed())
            .unwrap_or_else(|| panic!("timed out waiting for {what}"));
        let event = tokio::time::timeout(left, rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
            .expect("the subscription ended");
        let snapshot = match Arc::unwrap_or_clone(event) {
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
            },
            ReachEvent::Failure { message } => panic!("the reachability failed: {message}"),
        };
        if done(&snapshot) {
            return snapshot;
        }
    }
}

fn port(protocol: ReachProtocol, number: u16) -> ReachPort {
    ReachPort {
        protocol,
        port: Some(number),
        end_port: None,
        name: None,
        http: Vec::new(),
    }
}

fn policy(source: ReachPolicySource, namespace: &str, name: &str) -> PolicyRef {
    PolicyRef {
        source,
        namespace: namespace.to_owned(),
        name: name.to_owned(),
    }
}

fn k8s(name: &str) -> PolicyRef {
    policy(ReachPolicySource::Kubernetes, NAMESPACE, name)
}

fn cilium(name: &str) -> PolicyRef {
    policy(ReachPolicySource::Cilium, NAMESPACE, name)
}

/// A cluster-wide policy's namespace is "".
fn cluster_wide() -> PolicyRef {
    policy(ReachPolicySource::CiliumClusterwide, "", CLUSTER_POLICY)
}

/// A policy as text, to put lists in one order whatever order the core sends.
fn chip(policy: &PolicyRef) -> String {
    format!("{:?} {}/{}", policy.source, policy.namespace, policy.name)
}

fn sorted(mut policies: Vec<PolicyRef>) -> Vec<PolicyRef> {
    policies.sort_by_key(chip);
    policies
}

fn cell(
    from: &str,
    to: &str,
    verdict: ReachVerdict,
    ports: Vec<ReachPort>,
    policies: Vec<PolicyRef>,
) -> ReachCell {
    ReachCell {
        from: from.to_owned(),
        to: to.to_owned(),
        verdict,
        ports,
        policies: sorted(policies),
        some_pods: false,
    }
}

/// The cells by source, then destination, each with its policies in one order.
fn normalized(mut cells: Vec<ReachCell>) -> Vec<ReachCell> {
    for cell in &mut cells {
        cell.policies.sort_by_key(chip);
    }
    cells.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
    cells
}

/// Contract C13: the canvas sample gives the board's matrix on a real API server, read through
/// the watch hub.
#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn the_reachability_of_the_sample_namespace() {
    let (core, cluster, _root) = connected_kind().await;
    let client = core.cluster_client(&cluster).unwrap();
    with_sample(&client, async {
        // Spec §5.1: a workload with no running Pod is left out.
        wait_running_pods(&client, NAMESPACE, 8).await;
        wait_running_pods(&client, INGRESS, 1).await;
        wait_running_pods(&client, MONITORING, 1).await;
        let (tx, mut rx) = mpsc::channel(16);
        let subscription = core
            .network_reachability_subscribe(&cluster, NAMESPACE.to_owned(), tx, "main")
            .unwrap();
        assert!(subscription.starts_with("reach-"), "{subscription}");

        let web = format!("Deployment/{NAMESPACE}/web");
        let api = format!("Deployment/{NAMESPACE}/api");
        let db = format!("StatefulSet/{NAMESPACE}/db");
        let worker = format!("Deployment/{NAMESPACE}/worker");
        let coredns = "Deployment/kube-system/coredns";
        let ingress = format!("Deployment/{INGRESS}/ingress-nginx-controller");
        let prometheus = format!("Deployment/{MONITORING}/prometheus");
        let stripe = "fqdn:api.stripe.com";
        let snapshot = until(&mut rx, "the sample's four workloads", |s| {
            let pods: Vec<(&str, u32)> =
                s.groups.iter().map(|g| (g.name.as_str(), g.pods)).collect();
            pods == [("api", 2), ("db", 1), ("web", 3), ("worker", 2)]
        })
        .await;

        assert_eq!(snapshot.namespace, NAMESPACE);
        let groups: Vec<(&str, &str, bool, bool)> = snapshot
            .groups
            .iter()
            .map(|g| {
                (
                    g.id.as_str(),
                    g.kind.as_str(),
                    g.ingress_isolated,
                    g.egress_isolated,
                )
            })
            .collect();
        assert_eq!(
            groups,
            [
                (api.as_str(), "Deployment", true, true),
                (db.as_str(), "StatefulSet", true, true),
                (web.as_str(), "Deployment", true, true),
                (worker.as_str(), "Deployment", false, false),
            ]
        );
        let expected_groups = [
            (
                &api,
                vec!["app=api", "tier=backend"],
                vec![
                    k8s("allow-api-to-db"),
                    k8s("allow-dns"),
                    k8s("default-deny"),
                    cilium("allow-api-from-web"),
                    cilium("api-egress-stripe"),
                    cluster_wide(),
                ],
            ),
            (
                &db,
                vec!["app=db", "tier=data"],
                vec![
                    k8s("allow-db-from-api"),
                    k8s("allow-dns"),
                    k8s("default-deny"),
                    cilium("db-no-internet"),
                    cluster_wide(),
                ],
            ),
            (
                &web,
                vec!["app=web", "tier=frontend"],
                vec![
                    k8s("allow-dns"),
                    k8s("allow-web-from-ingress"),
                    k8s("allow-web-to-api"),
                    k8s("default-deny"),
                    cluster_wide(),
                ],
            ),
            (&worker, vec!["app=worker"], Vec::new()),
        ];
        for (id, labels, policies) in expected_groups {
            let group = snapshot.groups.iter().find(|g| &g.id == id).unwrap();
            // R13: the pairs every Pod shares, which include the controller's hash labels.
            for label in labels {
                assert!(
                    group.labels.iter().any(|l| l == label),
                    "{id}: {:?}",
                    group.labels
                );
            }
            assert_eq!(sorted(group.policies.clone()), sorted(policies), "{id}");
        }

        let peers: Vec<(&str, &ReachPeerKind, bool, bool)> = snapshot
            .peers
            .iter()
            .map(|p| (p.id.as_str(), &p.kind, p.source, p.destination))
            .collect();
        assert_eq!(
            peers,
            [
                (coredns, &ReachPeerKind::Workload, false, true),
                (ingress.as_str(), &ReachPeerKind::Workload, true, false),
                (prometheus.as_str(), &ReachPeerKind::Workload, true, false),
                (stripe, &ReachPeerKind::Fqdn, false, true),
                ("otherPods", &ReachPeerKind::OtherPods, true, true),
                ("world", &ReachPeerKind::World, true, true),
            ]
        );
        let dns_peer = snapshot.peers.iter().find(|p| p.id == coredns).unwrap();
        assert_eq!(
            (
                dns_peer.label.as_str(),
                dns_peer.detail.as_str(),
                dns_peer.namespace.as_deref()
            ),
            (
                "kube-system/coredns",
                "Deployment · 2 Pods",
                Some("kube-system")
            )
        );

        let tcp = |number| port(ReachProtocol::Tcp, number);
        let dns = vec![tcp(53), port(ReachProtocol::Udp, 53)];
        let get_api = ReachHttp {
            side: None,
            method: Some("GET".to_owned()),
            path: Some("/api/.*".to_owned()),
            host: None,
            headers: Vec::new(),
        };
        let expected_cells = normalized(vec![
            cell(
                &web,
                &api,
                ReachVerdict::Allowed,
                vec![ReachPort {
                    http: vec![get_api],
                    ..tcp(8080)
                }],
                vec![k8s("allow-web-to-api"), cilium("allow-api-from-web")],
            ),
            cell(
                &api,
                &db,
                ReachVerdict::Allowed,
                vec![tcp(5432)],
                vec![k8s("allow-api-to-db"), k8s("allow-db-from-api")],
            ),
            cell(
                &web,
                coredns,
                ReachVerdict::Allowed,
                dns.clone(),
                vec![k8s("allow-dns")],
            ),
            cell(
                &db,
                coredns,
                ReachVerdict::Allowed,
                dns.clone(),
                vec![k8s("allow-dns")],
            ),
            cell(
                &api,
                coredns,
                ReachVerdict::Allowed,
                dns,
                vec![k8s("allow-dns"), cilium("api-egress-stripe")],
            ),
            cell(
                &api,
                stripe,
                ReachVerdict::Allowed,
                vec![tcp(443)],
                vec![cilium("api-egress-stripe")],
            ),
            cell(
                &db,
                "world",
                ReachVerdict::Denied,
                Vec::new(),
                vec![cilium("db-no-internet")],
            ),
            // `world` covers every FQDN, so the deny reaches api.stripe.com too.
            cell(
                &db,
                stripe,
                ReachVerdict::Denied,
                Vec::new(),
                vec![cilium("db-no-internet")],
            ),
            cell(
                &ingress,
                &web,
                ReachVerdict::Allowed,
                vec![tcp(8080)],
                vec![k8s("allow-web-from-ingress")],
            ),
            cell(
                &prometheus,
                &web,
                ReachVerdict::Allowed,
                vec![tcp(9090)],
                vec![cluster_wide()],
            ),
            cell(
                &prometheus,
                &api,
                ReachVerdict::Allowed,
                vec![tcp(9090)],
                vec![cluster_wide()],
            ),
            cell(
                &prometheus,
                &db,
                ReachVerdict::Allowed,
                vec![tcp(9090)],
                vec![cluster_wide()],
            ),
        ]);
        assert_eq!(
            normalized(snapshot.cells),
            expected_cells,
            "every other cell follows from the isolation flags (R4)"
        );

        assert_eq!(
            snapshot.counts,
            ReachCounts {
                kubernetes: 6,
                cilium: 4
            }
        );
        assert!(snapshot.cilium);
        assert_eq!(
            snapshot.not_evaluated,
            [NotEvaluated {
                policy: cilium("api-egress-stripe"),
                field: "rules.dns".to_owned(),
            }]
        );
        assert!(snapshot.missing.is_empty(), "{:?}", snapshot.missing);
        assert_eq!(snapshot.truncated, 0);
        core.network_reachability_unsubscribe(&subscription);
    })
    .await;
}
