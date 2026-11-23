//! The reachability of one namespace from what the store holds (spec §5, §7.3): one build
//! indexes the whole cluster's Pods, owners, namespaces and policies, and each subscribed
//! namespace's snapshot is cut from it.

use std::collections::BTreeSet;

use super::types::{
    NotEvaluated, PolicyRef, ReachCell, ReachCounts, ReachEvent, ReachGroup, ReachHttp,
    ReachMissing, ReachPeer, ReachPeerKind, ReachPolicySource, ReachPort, ReachProtocol, ReachSide,
    ReachVerdict,
};
use crate::graph::{Kind, Netpol, Store};
use crate::netpol::eval::{Direction, End, Index, PortSpan, VerdictKind};
use crate::netpol::group::{merge, outside_peers, workloads, Merged, Owners, PeerEnd, PeerKind};
use crate::netpol::model::{Policy, PolicyId, PolicySource, Protocol};
use crate::netpol::pods::{NamespaceInfo, PodInfo};

/// The kinds the reachability store reads, where served.
pub(crate) const REACH_KINDS: [Kind; 7] = [
    Kind::Pod,
    Kind::ReplicaSet,
    Kind::Job,
    Kind::Namespace,
    Kind::NetworkPolicy,
    Kind::CiliumNetworkPolicy,
    Kind::CiliumClusterwideNetworkPolicy,
];

/// The policy kinds, in the order their policies are read.
const POLICY_KINDS: [Kind; 3] = [
    Kind::NetworkPolicy,
    Kind::CiliumNetworkPolicy,
    Kind::CiliumClusterwideNetworkPolicy,
];

/// Spec §7.3: at most this many groups, by name; `truncated` counts the rest.
const MAX_GROUPS: usize = 500;

/// One build of the whole cluster. Equal builds compare equal whatever their `generation`.
#[derive(Debug)]
pub(crate) struct Built {
    index: Index,
    owners: Owners,
    missing: Vec<ReachMissing>,
    cilium: bool,
    /// Which published build this is: set by the hub, `0` until then.
    pub generation: u64,
}

/// Two builds are equal when they hold the same inputs. `generation` says when a build was
/// published, not what it holds, so it is left out.
impl PartialEq for Built {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index
            && self.owners == other.owners
            && self.missing == other.missing
            && self.cilium == other.cilium
    }
}

/// Reads the store into an owned index, sorted so that two reads of the same objects compare
/// equal: Pods by namespace and name, namespaces by name, policies by id.
pub(crate) fn build(store: &Store) -> Built {
    let mut pods: Vec<PodInfo> = store
        .items(Kind::Pod)
        .filter_map(|item| match &item.netpol {
            Netpol::Pod(pod) => Some(pod.clone()),
            _ => None,
        })
        .collect();
    pods.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    let mut namespaces: Vec<NamespaceInfo> = store
        .items(Kind::Namespace)
        .filter_map(|item| match &item.netpol {
            Netpol::Namespace(namespace) => Some(namespace.clone()),
            _ => None,
        })
        .collect();
    namespaces.sort_by(|a, b| a.name.cmp(&b.name));
    let mut policies: Vec<Policy> = POLICY_KINDS
        .into_iter()
        .flat_map(|kind| store.items(kind))
        .filter_map(|item| match &item.netpol {
            Netpol::Policy(policy) => Some(policy.clone()),
            _ => None,
        })
        .collect();
    policies.sort_by(|a, b| a.id.cmp(&b.id));
    let owners: Owners = [Kind::ReplicaSet, Kind::Job]
        .into_iter()
        .flat_map(|kind| store.items(kind))
        .filter_map(|item| {
            let key = (
                item.kind.name().to_owned(),
                item.namespace.clone(),
                item.name.clone(),
            );
            Some((key, item.owner.clone()?))
        })
        .collect();
    let missing = store
        .missing_reasons()
        .into_iter()
        .filter(|(kind, _)| REACH_KINDS.contains(kind))
        .map(|(kind, reason)| ReachMissing {
            plural: kind.plural().to_owned(),
            reason,
        })
        .collect();
    let cilium = store.serves(Kind::CiliumNetworkPolicy)
        || store.serves(Kind::CiliumClusterwideNetworkPolicy);
    Built {
        index: Index::new(policies, pods, namespaces),
        owners,
        missing,
        cilium,
        generation: 0,
    }
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn policy_ref(id: &PolicyId) -> PolicyRef {
    let source = match id.source {
        PolicySource::Kubernetes => ReachPolicySource::Kubernetes,
        PolicySource::Cilium => ReachPolicySource::Cilium,
        PolicySource::CiliumClusterwide => ReachPolicySource::CiliumClusterwide,
    };
    PolicyRef {
        source,
        namespace: id.namespace.clone(),
        name: id.name.clone(),
    }
}

fn port(span: &PortSpan) -> ReachPort {
    let protocol = match span.protocol {
        Protocol::Tcp => ReachProtocol::Tcp,
        Protocol::Udp => ReachProtocol::Udp,
        Protocol::Sctp => ReachProtocol::Sctp,
        Protocol::Any => ReachProtocol::Any,
    };
    let http = span
        .http
        .iter()
        .map(|http| ReachHttp {
            side: http.side.map(|side| match side {
                Direction::Ingress => ReachSide::Ingress,
                Direction::Egress => ReachSide::Egress,
            }),
            method: http.rule.method.clone(),
            path: http.rule.path.clone(),
            host: http.rule.host.clone(),
            headers: http.rule.headers.clone(),
        })
        .collect();
    ReachPort {
        protocol,
        port: span.port,
        end_port: span.end_port,
        name: span.name.clone(),
        http,
    }
}

fn verdict(kind: VerdictKind) -> ReachVerdict {
    match kind {
        VerdictKind::Allowed => ReachVerdict::Allowed,
        VerdictKind::Denied => ReachVerdict::Denied,
        VerdictKind::Open => ReachVerdict::Open,
        VerdictKind::Blocked => ReachVerdict::Blocked,
    }
}

fn peer_kind(kind: PeerKind) -> ReachPeerKind {
    match kind {
        PeerKind::Workload => ReachPeerKind::Workload,
        PeerKind::Selector => ReachPeerKind::Selector,
        PeerKind::Cidr => ReachPeerKind::Cidr,
        PeerKind::Entity => ReachPeerKind::Entity,
        PeerKind::Fqdn => ReachPeerKind::Fqdn,
        PeerKind::OtherPods => ReachPeerKind::OtherPods,
        PeerKind::World => ReachPeerKind::World,
    }
}

/// A row or a column of the matrix: its id, its ends, and its isolation flags. A flag is true
/// when any of its Pods is isolated; an outside end has none.
struct Line {
    id: String,
    ends: Vec<End>,
    ingress_isolated: bool,
    egress_isolated: bool,
    outside: bool,
}

impl Line {
    fn of(index: &Index, id: &str, end: &PeerEnd, outside: bool) -> Line {
        match end {
            PeerEnd::Pods(pods) => Line {
                id: id.to_owned(),
                ends: pods.iter().map(|pod| End::Pod(*pod)).collect(),
                ingress_isolated: pods.iter().any(|pod| index.isolation(*pod).ingress),
                egress_isolated: pods.iter().any(|pod| index.isolation(*pod).egress),
                outside,
            },
            PeerEnd::Outside(end) => Line {
                id: id.to_owned(),
                ends: vec![End::Outside(end.clone())],
                ingress_isolated: false,
                egress_isolated: false,
                outside,
            },
        }
    }
}

/// The cell from `source` to `destination`, when the page cannot derive it (R4): it is
/// Allowed or Denied, its Pods differ, or the flags would derive another verdict.
fn cell(index: &Index, source: &Line, destination: &Line) -> Option<ReachCell> {
    let Merged {
        kind,
        ports,
        policies,
        some_pods,
    } = merge(index, &source.ends, &destination.ends);
    let derived = if source.egress_isolated || destination.ingress_isolated {
        VerdictKind::Blocked
    } else {
        VerdictKind::Open
    };
    let sent =
        matches!(kind, VerdictKind::Allowed | VerdictKind::Denied) || some_pods || kind != derived;
    sent.then(|| ReachCell {
        from: source.id.clone(),
        to: destination.id.clone(),
        verdict: verdict(kind),
        ports: ports.iter().map(port).collect(),
        policies: policies.iter().map(policy_ref).collect(),
        some_pods,
    })
}

/// Counts (contract C9): the namespace's NetworkPolicies; its CiliumNetworkPolicies plus the
/// CiliumClusterwideNetworkPolicies that select one of its Pods.
fn counts(index: &Index, namespace: &str, here: &[bool]) -> ReachCounts {
    let mut counts = ReachCounts {
        kubernetes: 0,
        cilium: 0,
    };
    for (i, policy) in index.policies().iter().enumerate() {
        match policy.id.source {
            PolicySource::Kubernetes if policy.id.namespace == namespace => counts.kubernetes += 1,
            PolicySource::Cilium if policy.id.namespace == namespace => counts.cilium += 1,
            PolicySource::CiliumClusterwide if selects(index, i, here) => counts.cilium += 1,
            _ => {}
        }
    }
    counts
}

/// Whether `policy` selects a Pod marked in `here`.
fn selects(index: &Index, policy: usize, here: &[bool]) -> bool {
    index
        .selected_pods(policy)
        .iter()
        .any(|pod| here.get(*pod).copied().unwrap_or(false))
}

/// The fields not evaluated (contract C9) of every policy that selects a Pod of the namespace
/// or names one as a peer, sorted, unique.
fn not_evaluated(index: &Index, pods: &[usize], here: &[bool]) -> Vec<NotEvaluated> {
    let names_here = |policy: &Policy| {
        policy.rules.iter().any(|rule| {
            let entries = rule
                .ingress
                .iter()
                .chain(&rule.egress)
                .chain(&rule.ingress_deny)
                .chain(&rule.egress_deny);
            entries
                .flat_map(|entry| &entry.peers)
                .any(|peer| pods.iter().any(|pod| index.peer_selects(peer, *pod)))
        })
    };
    let mut notes: BTreeSet<(&PolicyId, &str)> = BTreeSet::new();
    for (i, policy) in index.policies().iter().enumerate() {
        if policy.notes.is_empty() || !(selects(index, i, here) || names_here(policy)) {
            continue;
        }
        notes.extend(policy.notes.iter().map(|note| (&policy.id, note.as_str())));
    }
    notes
        .into_iter()
        .map(|(id, field)| NotEvaluated {
            policy: policy_ref(id),
            field: field.to_owned(),
        })
        .collect()
}

/// The snapshot of one namespace (always `ReachEvent::Snapshot`).
pub(crate) fn snapshot(built: &Built, namespace: &str) -> ReachEvent {
    let index = &built.index;
    let mut workloads = workloads(index, namespace, &built.owners);
    let peers = outside_peers(index, namespace, &built.owners);
    let pods: Vec<usize> = workloads
        .iter()
        .flat_map(|workload| workload.pods.iter().copied())
        .collect();
    let mut here = vec![false; index.pods().len()];
    for pod in &pods {
        here[*pod] = true;
    }
    let truncated = count(workloads.len().saturating_sub(MAX_GROUPS));
    workloads.truncate(MAX_GROUPS);

    let group_lines: Vec<Line> = workloads
        .iter()
        .map(|workload| {
            let end = PeerEnd::Pods(workload.pods.clone());
            Line::of(index, &workload.id, &end, false)
        })
        .collect();
    let peer_lines: Vec<Line> = peers
        .iter()
        .map(|peer| Line::of(index, &peer.id, &peer.end, true))
        .collect();

    // With no rule on a Pod of the namespace, every cell is Open and derived: none is sent.
    let mut cells = Vec::new();
    if pods.iter().any(|pod| !index.rules_of(*pod).is_empty()) {
        let sources = group_lines.iter().chain(
            peers
                .iter()
                .zip(&peer_lines)
                .filter(|(peer, _)| peer.source)
                .map(|(_, line)| line),
        );
        let destinations: Vec<&Line> = group_lines
            .iter()
            .chain(
                peers
                    .iter()
                    .zip(&peer_lines)
                    .filter(|(peer, _)| peer.destination)
                    .map(|(_, line)| line),
            )
            .collect();
        for source in sources {
            for destination in &destinations {
                if !(source.outside && destination.outside) {
                    cells.extend(cell(index, source, destination));
                }
            }
        }
    }

    let groups = workloads
        .iter()
        .zip(&group_lines)
        .map(|(workload, line)| {
            let mut policies: Vec<&PolicyId> = workload
                .pods
                .iter()
                .flat_map(|pod| index.policies_of(*pod))
                .filter_map(|policy| index.policies().get(*policy).map(|policy| &policy.id))
                .collect();
            policies.sort();
            policies.dedup();
            // R13: the labels controllers add to every Pod they make say nothing about it.
            const CONTROLLER_LABELS: [&str; 8] = [
                "pod-template-hash",
                "controller-revision-hash",
                "statefulset.kubernetes.io/pod-name",
                "apps.kubernetes.io/pod-index",
                "batch.kubernetes.io/controller-uid",
                "batch.kubernetes.io/job-name",
                "controller-uid",
                "job-name",
            ];
            ReachGroup {
                id: workload.id.clone(),
                kind: workload.kind.clone(),
                name: workload.name.clone(),
                pods: count(workload.pods.len()),
                labels: workload
                    .labels
                    .iter()
                    .filter(|(key, _)| !CONTROLLER_LABELS.contains(&key.as_str()))
                    .map(|(key, value)| format!("{key}={value}"))
                    .collect(),
                policies: policies.into_iter().map(policy_ref).collect(),
                ingress_isolated: line.ingress_isolated,
                egress_isolated: line.egress_isolated,
            }
        })
        .collect();
    let peers = peers
        .iter()
        .zip(&peer_lines)
        .map(|(peer, line)| ReachPeer {
            id: peer.id.clone(),
            kind: peer_kind(peer.kind),
            namespace: peer.namespace.clone(),
            label: peer.label.clone(),
            detail: peer.detail.clone(),
            source: peer.source,
            destination: peer.destination,
            ingress_isolated: line.ingress_isolated,
            egress_isolated: line.egress_isolated,
        })
        .collect();

    ReachEvent::Snapshot {
        namespace: namespace.to_owned(),
        groups,
        peers,
        cells,
        counts: counts(index, namespace, &here),
        not_evaluated: not_evaluated(index, &pods, &here),
        missing: built.missing.clone(),
        cilium: built.cilium,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::resources::{Row, WatchEvent, WatchStatus};

    /// A store of `kinds`, where each kind in `forbidden` failed with its message and every
    /// other one listed what `objects` holds of it.
    fn store_of(kinds: &[Kind], forbidden: &[(Kind, &str)], objects: &[(Kind, Value)]) -> Store {
        let mut store = Store::new(kinds);
        for kind in kinds {
            if let Some((_, message)) = forbidden.iter().find(|(failed, _)| failed == kind) {
                let status = WatchEvent::Status {
                    status: WatchStatus::Forbidden,
                    message: Some((*message).to_owned()),
                };
                store.apply(*kind, status);
                continue;
            }
            let items = objects
                .iter()
                .filter(|(k, _)| k == kind)
                .map(|(_, object)| Row::new(object).unwrap())
                .collect();
            store.apply(*kind, WatchEvent::Snapshot { items });
        }
        store
    }

    fn namespace(name: &str) -> (Kind, Value) {
        let labels = json!({ "kubernetes.io/metadata.name": name });
        (
            Kind::Namespace,
            json!({ "metadata": { "name": name, "labels": labels } }),
        )
    }

    fn replica_set(namespace: &str, name: &str, deployment: &str) -> (Kind, Value) {
        let owner = json!({ "kind": "Deployment", "name": deployment, "controller": true });
        let metadata = json!({ "name": name, "namespace": namespace, "ownerReferences": [owner] });
        (Kind::ReplicaSet, json!({ "metadata": metadata }))
    }

    /// A running Pod of its controller `owner` (kind, name).
    fn pod(
        namespace: &str,
        name: &str,
        owner: (&str, &str),
        labels: Value,
        ports: Value,
    ) -> (Kind, Value) {
        let owner = json!({ "kind": owner.0, "name": owner.1, "controller": true });
        (
            Kind::Pod,
            json!({
                "metadata": { "name": name, "namespace": namespace, "labels": labels, "ownerReferences": [owner] },
                "spec": { "containers": [{ "name": "app", "ports": ports }] },
                "status": { "phase": "Running" },
            }),
        )
    }

    fn policy(kind: Kind, namespace: &str, name: &str, spec: Value) -> (Kind, Value) {
        let metadata = if namespace.is_empty() {
            json!({ "name": name })
        } else {
            json!({ "name": name, "namespace": namespace })
        };
        (kind, json!({ "metadata": metadata, "spec": spec }))
    }

    fn app(app: &str) -> Value {
        json!({ "matchLabels": { "app": app } })
    }

    fn apps() -> Value {
        json!({ "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web", "api", "db"] }] })
    }

    /// The sample namespace of contract C13.
    fn payments() -> Vec<(Kind, Value)> {
        let web_ports = json!([
            { "name": "http", "containerPort": 8080 },
            { "name": "metrics", "containerPort": 9090 },
        ]);
        let mut objects = vec![
            namespace("payments"),
            namespace("ingress-nginx"),
            namespace("monitoring"),
            namespace("kube-system"),
            replica_set("payments", "web-7d9f", "web"),
            replica_set("payments", "api-5c8b", "api"),
            replica_set("payments", "worker-6f4d", "worker"),
            replica_set(
                "ingress-nginx",
                "ingress-nginx-controller-5b7f",
                "ingress-nginx-controller",
            ),
            replica_set("monitoring", "prometheus-6d5c", "prometheus"),
            replica_set("kube-system", "coredns-5d78", "coredns"),
        ];
        for suffix in ["a", "b", "c"] {
            let labels = json!({ "app": "web", "tier": "frontend" });
            let name = format!("web-7d9f-{suffix}");
            objects.push(pod(
                "payments",
                &name,
                ("ReplicaSet", "web-7d9f"),
                labels,
                web_ports.clone(),
            ));
        }
        for suffix in ["a", "b"] {
            let labels = json!({ "app": "api", "tier": "backend" });
            let name = format!("api-5c8b-{suffix}");
            objects.push(pod(
                "payments",
                &name,
                ("ReplicaSet", "api-5c8b"),
                labels,
                web_ports.clone(),
            ));
            let name = format!("worker-6f4d-{suffix}");
            objects.push(pod(
                "payments",
                &name,
                ("ReplicaSet", "worker-6f4d"),
                json!({ "app": "worker" }),
                json!([]),
            ));
            let name = format!("coredns-5d78-{suffix}");
            let ports = json!([
                { "name": "dns", "containerPort": 53, "protocol": "UDP" },
                { "name": "dns-tcp", "containerPort": 53, "protocol": "TCP" },
            ]);
            let labels = json!({ "k8s-app": "kube-dns" });
            objects.push(pod(
                "kube-system",
                &name,
                ("ReplicaSet", "coredns-5d78"),
                labels,
                ports,
            ));
        }
        objects.extend([
            pod(
                "payments",
                "db-0",
                ("StatefulSet", "db"),
                json!({ "app": "db", "tier": "data" }),
                json!([{ "name": "postgres", "containerPort": 5432 }, { "name": "metrics", "containerPort": 9090 }]),
            ),
            pod(
                "ingress-nginx",
                "ingress-nginx-controller-5b7f-a",
                ("ReplicaSet", "ingress-nginx-controller-5b7f"),
                json!({ "app.kubernetes.io/name": "ingress-nginx" }),
                json!([{ "containerPort": 80 }]),
            ),
            pod(
                "monitoring",
                "prometheus-6d5c-a",
                ("ReplicaSet", "prometheus-6d5c"),
                json!({ "app": "prometheus" }),
                json!([{ "containerPort": 9090 }]),
            ),
        ]);
        let netpol = Kind::NetworkPolicy;
        let cnp = Kind::CiliumNetworkPolicy;
        let tcp = |port: u16| json!({ "protocol": "TCP", "port": port });
        let names = |name: &str| json!({ "matchLabels": { "kubernetes.io/metadata.name": name } });
        let cilium_ports = |port: &str, protocol: &str| json!([{ "ports": [{ "port": port, "protocol": protocol }] }]);
        objects.extend([
            policy(netpol, "payments", "default-deny", json!({ "podSelector": apps(), "policyTypes": ["Ingress", "Egress"] })),
            policy(netpol, "payments", "allow-web-from-ingress", json!({
                "podSelector": app("web"),
                "ingress": [{ "from": [{ "namespaceSelector": names("ingress-nginx") }], "ports": [tcp(8080)] }],
            })),
            policy(netpol, "payments", "allow-db-from-api", json!({
                "podSelector": app("db"),
                "ingress": [{ "from": [{ "podSelector": app("api") }], "ports": [tcp(5432)] }],
            })),
            policy(netpol, "payments", "allow-web-to-api", json!({
                "podSelector": app("web"),
                "policyTypes": ["Egress"],
                "egress": [{ "to": [{ "podSelector": app("api") }], "ports": [tcp(8080)] }],
            })),
            policy(netpol, "payments", "allow-api-to-db", json!({
                "podSelector": app("api"),
                "policyTypes": ["Egress"],
                "egress": [{ "to": [{ "podSelector": app("db") }], "ports": [tcp(5432)] }],
            })),
            policy(netpol, "payments", "allow-dns", json!({
                "podSelector": apps(),
                "policyTypes": ["Egress"],
                "egress": [{
                    "to": [{
                        "namespaceSelector": names("kube-system"),
                        "podSelector": { "matchLabels": { "k8s-app": "kube-dns" } },
                    }],
                    "ports": [{ "protocol": "UDP", "port": 53 }, tcp(53)],
                }],
            })),
            policy(cnp, "payments", "allow-api-from-web", json!({
                "endpointSelector": app("api"),
                "ingress": [{
                    "fromEndpoints": [app("web")],
                    "toPorts": [{
                        "ports": [{ "port": "8080", "protocol": "TCP" }],
                        "rules": { "http": [{ "method": "GET", "path": "/api/.*" }] },
                    }],
                }],
            })),
            policy(cnp, "payments", "api-egress-stripe", json!({
                "endpointSelector": app("api"),
                "egress": [
                    { "toFQDNs": [{ "matchName": "api.stripe.com" }], "toPorts": cilium_ports("443", "TCP") },
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
            })),
            policy(cnp, "payments", "db-no-internet", json!({
                "endpointSelector": app("db"),
                "egressDeny": [{ "toEntities": ["world"] }],
            })),
            policy(Kind::CiliumClusterwideNetworkPolicy, "", "allow-prometheus-scrape", json!({
                "endpointSelector": {
                    "matchLabels": { "io.kubernetes.pod.namespace": "payments" },
                    "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web", "api", "db"] }],
                },
                "ingress": [{
                    "fromEndpoints": [{ "matchLabels": {
                        "k8s:io.kubernetes.pod.namespace": "monitoring",
                        "app": "prometheus",
                    } }],
                    "toPorts": cilium_ports("9090", "TCP"),
                }],
            })),
        ]);
        objects
    }

    fn snapshot_of(objects: &[(Kind, Value)], namespace: &str) -> ReachEvent {
        snapshot(&build(&store_of(&REACH_KINDS, &[], objects)), namespace)
    }

    /// The page's names of a policy (contract C12's chips): `K8s`, `Cilium`, `Cilium cluster`.
    fn policy_text(policy: &PolicyRef) -> String {
        let tag = match policy.source {
            ReachPolicySource::Kubernetes => "K8s",
            ReachPolicySource::Cilium => "Cilium",
            ReachPolicySource::CiliumClusterwide => "Cilium cluster",
        };
        format!("{tag} {}", policy.name)
    }

    fn policies_text(policies: &[PolicyRef]) -> Vec<String> {
        policies.iter().map(policy_text).collect()
    }

    fn port_text(port: &ReachPort) -> String {
        let protocol = match port.protocol {
            ReachProtocol::Tcp => "TCP",
            ReachProtocol::Udp => "UDP",
            ReachProtocol::Sctp => "SCTP",
            ReachProtocol::Any => "ANY",
        };
        let number = match (port.port, port.end_port, &port.name) {
            (Some(start), Some(end), _) => format!("{start}-{end}"),
            (Some(start), None, _) => start.to_string(),
            (None, _, Some(name)) => name.clone(),
            (None, _, None) => "all".to_owned(),
        };
        let mut text = format!("{protocol} {number}");
        for http in &port.http {
            let parts = [&http.method, &http.path, &http.host];
            for part in parts.into_iter().flatten() {
                text.push(' ');
                text.push_str(part);
            }
        }
        text
    }

    /// A cell as `from -> to: Verdict [ports] policies`, then ` (some Pods)` when so.
    fn cell_text(cell: &ReachCell) -> String {
        let ports: Vec<String> = cell.ports.iter().map(port_text).collect();
        let some = if cell.some_pods { " (some Pods)" } else { "" };
        format!(
            "{} -> {}: {:?} [{}] {}{some}",
            cell.from,
            cell.to,
            cell.verdict,
            ports.join(", "),
            policies_text(&cell.policies).join(", "),
        )
    }

    struct Parts {
        groups: Vec<ReachGroup>,
        peers: Vec<ReachPeer>,
        cells: Vec<ReachCell>,
        counts: ReachCounts,
        not_evaluated: Vec<NotEvaluated>,
        missing: Vec<ReachMissing>,
        cilium: bool,
        truncated: u32,
    }

    fn parts(event: ReachEvent) -> Parts {
        let ReachEvent::Snapshot {
            groups,
            peers,
            cells,
            counts,
            not_evaluated,
            missing,
            cilium,
            truncated,
            ..
        } = event
        else {
            panic!("not a snapshot: {event:?}");
        };
        Parts {
            groups,
            peers,
            cells,
            counts,
            not_evaluated,
            missing,
            cilium,
            truncated,
        }
    }

    /// Contract C13: the canvas board's namespace gives exactly the board's matrix.
    #[test]
    fn the_sample_namespace_gives_the_boards_matrix() {
        let snapshot = parts(snapshot_of(&payments(), "payments"));

        let groups: Vec<_> = snapshot
            .groups
            .iter()
            .map(|group| {
                (
                    group.id.as_str(),
                    group.kind.as_str(),
                    group.name.as_str(),
                    group.pods,
                    group.labels.join(", "),
                    policies_text(&group.policies).join(", "),
                    group.ingress_isolated,
                    group.egress_isolated,
                )
            })
            .collect();
        assert_eq!(
            groups,
            [
                (
                    "Deployment/payments/api",
                    "Deployment",
                    "api",
                    2,
                    "app=api, tier=backend".to_owned(),
                    "K8s allow-api-to-db, K8s allow-dns, K8s default-deny, Cilium allow-api-from-web, \
                     Cilium api-egress-stripe, Cilium cluster allow-prometheus-scrape"
                        .to_owned(),
                    true,
                    true
                ),
                (
                    "StatefulSet/payments/db",
                    "StatefulSet",
                    "db",
                    1,
                    "app=db, tier=data".to_owned(),
                    "K8s allow-db-from-api, K8s allow-dns, K8s default-deny, Cilium db-no-internet, \
                     Cilium cluster allow-prometheus-scrape"
                        .to_owned(),
                    true,
                    true
                ),
                (
                    "Deployment/payments/web",
                    "Deployment",
                    "web",
                    3,
                    "app=web, tier=frontend".to_owned(),
                    "K8s allow-dns, K8s allow-web-from-ingress, K8s allow-web-to-api, K8s default-deny, \
                     Cilium cluster allow-prometheus-scrape"
                        .to_owned(),
                    true,
                    true
                ),
                (
                    "Deployment/payments/worker",
                    "Deployment",
                    "worker",
                    2,
                    "app=worker".to_owned(),
                    String::new(),
                    false,
                    false
                ),
            ]
        );

        let peers: Vec<_> = snapshot
            .peers
            .iter()
            .map(|peer| {
                (
                    peer.id.as_str(),
                    peer.kind,
                    peer.namespace.as_deref(),
                    peer.label.as_str(),
                    peer.detail.as_str(),
                    peer.source,
                    peer.destination,
                    peer.ingress_isolated || peer.egress_isolated,
                )
            })
            .collect();
        assert_eq!(
            peers,
            [
                (
                    "Deployment/ingress-nginx/ingress-nginx-controller",
                    ReachPeerKind::Workload,
                    Some("ingress-nginx"),
                    "ingress-nginx/ingress-nginx-controller",
                    "Deployment · 1 Pod",
                    true,
                    false,
                    false
                ),
                (
                    "Deployment/kube-system/coredns",
                    ReachPeerKind::Workload,
                    Some("kube-system"),
                    "kube-system/coredns",
                    "Deployment · 2 Pods",
                    false,
                    true,
                    false
                ),
                (
                    "Deployment/monitoring/prometheus",
                    ReachPeerKind::Workload,
                    Some("monitoring"),
                    "monitoring/prometheus",
                    "Deployment · 1 Pod",
                    true,
                    false,
                    false
                ),
                (
                    "fqdn:api.stripe.com",
                    ReachPeerKind::Fqdn,
                    None,
                    "api.stripe.com",
                    "DNS name",
                    false,
                    true,
                    false
                ),
                (
                    "otherPods",
                    ReachPeerKind::OtherPods,
                    None,
                    "Other Pods in the cluster",
                    "Pods the rules above do not name",
                    true,
                    true,
                    false
                ),
                (
                    "world",
                    ReachPeerKind::World,
                    None,
                    "Outside the cluster",
                    "Addresses the rules above do not name",
                    true,
                    true,
                    false
                ),
            ]
        );

        let cells: Vec<String> = snapshot.cells.iter().map(cell_text).collect();
        assert_eq!(
            cells,
            [
                "Deployment/payments/api -> StatefulSet/payments/db: Allowed [TCP 5432] \
                 K8s allow-api-to-db, K8s allow-db-from-api",
                "Deployment/payments/api -> Deployment/kube-system/coredns: Allowed [TCP 53, UDP 53] \
                 K8s allow-dns, Cilium api-egress-stripe",
                "Deployment/payments/api -> fqdn:api.stripe.com: Allowed [TCP 443] Cilium api-egress-stripe",
                "StatefulSet/payments/db -> Deployment/kube-system/coredns: Allowed [TCP 53, UDP 53] K8s allow-dns",
                "StatefulSet/payments/db -> fqdn:api.stripe.com: Denied [] Cilium db-no-internet",
                "StatefulSet/payments/db -> world: Denied [] Cilium db-no-internet",
                "Deployment/payments/web -> Deployment/payments/api: Allowed [TCP 8080 GET /api/.*] \
                 K8s allow-web-to-api, Cilium allow-api-from-web",
                "Deployment/payments/web -> Deployment/kube-system/coredns: Allowed [TCP 53, UDP 53] K8s allow-dns",
                "Deployment/ingress-nginx/ingress-nginx-controller -> Deployment/payments/web: Allowed [TCP 8080] \
                 K8s allow-web-from-ingress",
                "Deployment/monitoring/prometheus -> Deployment/payments/api: Allowed [TCP 9090] \
                 Cilium cluster allow-prometheus-scrape",
                "Deployment/monitoring/prometheus -> StatefulSet/payments/db: Allowed [TCP 9090] \
                 Cilium cluster allow-prometheus-scrape",
                "Deployment/monitoring/prometheus -> Deployment/payments/web: Allowed [TCP 9090] \
                 Cilium cluster allow-prometheus-scrape",
            ]
        );
        // The HTTP rule is the ingress side's alone, so it names no side.
        assert_eq!(snapshot.cells[6].ports[0].http[0].side, None);

        assert_eq!(
            snapshot.counts,
            ReachCounts {
                kubernetes: 6,
                cilium: 4
            }
        );
        assert_eq!(
            snapshot.not_evaluated,
            [NotEvaluated {
                policy: PolicyRef {
                    source: ReachPolicySource::Cilium,
                    namespace: "payments".into(),
                    name: "api-egress-stripe".into(),
                },
                field: "rules.dns".into(),
            }]
        );
        assert_eq!(snapshot.missing, []);
        assert!(snapshot.cilium);
        assert_eq!(snapshot.truncated, 0);
    }

    /// Another namespace of the same build counts only its own policies.
    #[test]
    fn another_namespace_of_the_sample_sees_only_its_own_side() {
        let snapshot = parts(snapshot_of(&payments(), "monitoring"));
        let groups: Vec<&str> = snapshot
            .groups
            .iter()
            .map(|group| group.id.as_str())
            .collect();
        assert_eq!(groups, ["Deployment/monitoring/prometheus"]);
        assert_eq!(
            snapshot.counts,
            ReachCounts {
                kubernetes: 0,
                cilium: 0
            }
        );
        assert_eq!(snapshot.not_evaluated, []);
        assert_eq!(snapshot.cells, []);
        let peers: Vec<&str> = snapshot.peers.iter().map(|peer| peer.id.as_str()).collect();
        assert_eq!(peers, ["otherPods", "world"]);
    }

    /// R4: with no policy every cell is Open, which the page derives, so none is sent.
    #[test]
    fn a_namespace_with_no_policies_sends_no_cells() {
        let objects: Vec<(Kind, Value)> = payments()
            .into_iter()
            .filter(|(kind, _)| !kind.is_policy())
            .collect();
        let kinds = [
            Kind::Pod,
            Kind::ReplicaSet,
            Kind::Job,
            Kind::Namespace,
            Kind::NetworkPolicy,
        ];
        let snapshot = parts(snapshot(
            &build(&store_of(&kinds, &[], &objects)),
            "payments",
        ));
        assert_eq!(snapshot.cells, []);
        assert_eq!(snapshot.groups.len(), 4);
        assert!(snapshot.groups.iter().all(|group| !group.ingress_isolated
            && !group.egress_isolated
            && group.policies.is_empty()));
        let peers: Vec<&str> = snapshot.peers.iter().map(|peer| peer.id.as_str()).collect();
        assert_eq!(peers, ["otherPods", "world"]);
        assert_eq!(
            snapshot.counts,
            ReachCounts {
                kubernetes: 0,
                cilium: 0
            }
        );
        assert!(!snapshot.cilium);
        assert_eq!(snapshot.missing, []);
    }

    /// R5, Review Focus 2: a forbidden CiliumNetworkPolicy list is missing with its reason; the
    /// rest still shows.
    #[test]
    fn a_forbidden_cilium_policy_list_is_missing_with_its_reason() {
        let reason =
            "ciliumnetworkpolicies.cilium.io is forbidden: User \"dev\" cannot list resource \
                      \"ciliumnetworkpolicies\" in API group \"cilium.io\" at the cluster scope";
        let store = store_of(
            &REACH_KINDS,
            &[(Kind::CiliumNetworkPolicy, reason)],
            &payments(),
        );
        let snapshot = parts(snapshot(&build(&store), "payments"));
        assert_eq!(
            snapshot.missing,
            [ReachMissing {
                plural: "ciliumnetworkpolicies".into(),
                reason: reason.into(),
            }]
        );
        assert!(snapshot.cilium);
        assert_eq!(
            snapshot.counts,
            ReachCounts {
                kubernetes: 6,
                cilium: 1
            }
        );
        assert_eq!(snapshot.groups.len(), 4);
    }

    /// Spec §7.3: at most 500 groups, by name; `truncated` counts the rest.
    #[test]
    fn groups_stop_at_five_hundred() {
        let objects: Vec<(Kind, Value)> = (0..501)
            .map(|n| {
                let metadata = json!({ "name": format!("p-{n:03}"), "namespace": "big" });
                (
                    Kind::Pod,
                    json!({ "metadata": metadata, "status": { "phase": "Running" } }),
                )
            })
            .collect();
        let snapshot = parts(snapshot_of(&objects, "big"));
        assert_eq!(snapshot.groups.len(), 500);
        assert_eq!(snapshot.groups[0].id, "Pod/big/p-000");
        assert_eq!(snapshot.groups[499].id, "Pod/big/p-499");
        assert_eq!(snapshot.truncated, 1);
    }

    /// The hub sends a build only when it changed: the same objects read in another order
    /// build an equal index, whatever the generation.
    #[test]
    fn equal_builds_compare_equal_whatever_their_generation() {
        let mut objects = payments();
        let one = build(&store_of(&REACH_KINDS, &[], &objects));
        objects.reverse();
        let mut two = build(&store_of(&REACH_KINDS, &[], &objects));
        two.generation = 7;
        assert!(one == two);
        objects.pop();
        let three = build(&store_of(&REACH_KINDS, &[], &objects));
        assert!(one != three);
    }

    /// R13: the labels a controller adds to its Pods say nothing about the workload.
    #[test]
    fn a_group_leaves_out_the_labels_controllers_add() {
        let labels = json!({
            "app": "db",
            "controller-revision-hash": "db-6b7c",
            "statefulset.kubernetes.io/pod-name": "db-0",
            "apps.kubernetes.io/pod-index": "0",
            "pod-template-hash": "7d9f",
        });
        let objects = vec![
            namespace("shop"),
            pod("shop", "db-0", ("StatefulSet", "db"), labels, json!([])),
        ];
        let snapshot = parts(snapshot_of(&objects, "shop"));
        assert_eq!(snapshot.groups[0].labels, ["app=db"]);
    }
}
