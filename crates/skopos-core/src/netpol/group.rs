//! The workloads and outside peers of a namespace, and a verdict merged over their Pods
//! (spec §5.1 to §5.3). Pure, like the rest of the policy module.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::eval::{
    names_every_pod, unite, End, Index, Outside, PortSpan, Verdict, VerdictKind, NAME_LABEL,
};
use super::model::{Entity, NamespaceScope, Peer, PolicyId};
use super::pods::{PodInfo, NAMESPACE_LABEL};
use super::selector::{LabelSelector, Operator};

/// The controller of each ReplicaSet and Job: (kind, namespace, name) → (kind, name).
pub(crate) type Owners = HashMap<(String, String, String), (String, String)>;

/// A workload of the namespace (spec §5.1): `id` is `<Kind>/<namespace>/<name>`; `pods` are the
/// indices of its running Pods, ascending; `labels` the pairs all of them share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Workload {
    pub id: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub pods: Vec<usize>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum PeerKind {
    Workload,
    Selector,
    Cidr,
    Entity,
    Fqdn,
    OtherPods,
    World,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PeerEnd {
    Pods(Vec<usize>),
    Outside(Outside),
}

/// An outside peer (spec §5.2), with the id, label and detail of contract C9.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutsidePeer {
    pub id: String,
    pub kind: PeerKind,
    pub namespace: Option<String>,
    pub label: String,
    pub detail: String,
    pub source: bool,
    pub destination: bool,
    pub end: PeerEnd,
}

/// The verdict of many Pod pairs merged (spec §5.1): Denied only when every pair is denied,
/// else the most permissive; ports united; `some_pods` when the pairs differ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Merged {
    pub kind: VerdictKind,
    pub ports: Vec<PortSpan>,
    pub policies: Vec<PolicyId>,
    pub some_pods: bool,
}

/// "1 Pod" or "N Pods".
fn pods_text(count: usize) -> String {
    if count == 1 {
        "1 Pod".to_owned()
    } else {
        format!("{count} Pods")
    }
}

/// The top owner of a Pod (spec §5.1): the controller of its ReplicaSet or Job when that has
/// one, else its own controller, else the Pod itself. As (kind, name).
fn top_owner(pod: &PodInfo, owners: &Owners) -> (String, String) {
    let Some((kind, name)) = &pod.owner else {
        return ("Pod".to_owned(), pod.name.clone());
    };
    if kind == "ReplicaSet" || kind == "Job" {
        let key = (kind.clone(), pod.namespace.clone(), name.clone());
        if let Some(top) = owners.get(&key) {
            return top.clone();
        }
    }
    (kind.clone(), name.clone())
}

/// The label pairs every one of `pods` has.
fn shared_labels(index: &Index, pods: &[usize]) -> BTreeMap<String, String> {
    let mut all = pods.iter().filter_map(|pod| index.pods().get(*pod));
    let Some(first) = all.next() else {
        return BTreeMap::new();
    };
    let mut shared = first.labels.clone();
    for pod in all {
        shared.retain(|key, value| pod.labels.get(key) == Some(value));
    }
    shared
}

/// `pods` grouped by namespace and top owner, by name then kind.
fn group(index: &Index, pods: impl IntoIterator<Item = usize>, owners: &Owners) -> Vec<Workload> {
    let mut groups: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    for pod in pods {
        let Some(info) = index.pods().get(pod) else {
            continue;
        };
        let (kind, name) = top_owner(info, owners);
        groups
            .entry((name, kind, info.namespace.clone()))
            .or_default()
            .push(pod);
    }
    groups
        .into_iter()
        .map(|((name, kind, namespace), mut pods)| {
            pods.sort_unstable();
            pods.dedup();
            Workload {
                id: format!("{kind}/{namespace}/{name}"),
                labels: shared_labels(index, &pods),
                kind,
                namespace,
                name,
                pods,
            }
        })
        .collect()
}

/// The running Pods of `namespace`.
fn running(index: &Index, namespace: &str) -> Vec<usize> {
    index
        .pods()
        .iter()
        .enumerate()
        .filter(|(_, pod)| pod.namespace == namespace && !pod.finished)
        .map(|(i, _)| i)
        .collect()
}

/// The workloads of `namespace`, by name then kind. Finished Pods are left out, and so is a
/// workload with no running Pod.
pub(crate) fn workloads(index: &Index, namespace: &str, owners: &Owners) -> Vec<Workload> {
    group(index, running(index, namespace), owners)
}

/// The one namespace a selector requirement names: `key In [<one value>]`.
fn single(selector: &LabelSelector, key: &str) -> Option<String> {
    selector
        .requirements
        .iter()
        .find_map(|requirement| match &requirement.operator {
            Operator::In(values) if requirement.key == key && values.len() == 1 => {
                Some(values[0].clone())
            }
            _ => None,
        })
}

/// The selector without its requirements on `key`.
fn without(selector: &LabelSelector, key: &str) -> LabelSelector {
    let mut rest = selector.clone();
    rest.requirements
        .retain(|requirement| requirement.key != key);
    rest
}

/// The namespace part of a Pods peer (contract C9), the one namespace it names if any, and
/// the text of its Pod selector. A Cilium selector carries its namespace as a label (R2).
fn selector_parts(
    namespaces: &NamespaceScope,
    pods: &LabelSelector,
) -> (String, Option<String>, String) {
    match namespaces {
        NamespaceScope::Only(name) => (name.clone(), Some(name.clone()), pods.text()),
        NamespaceScope::Selected(selector) => {
            if selector.is_everything() {
                ("*".to_owned(), None, pods.text())
            } else if let (1, Some(name)) =
                (selector.requirements.len(), single(selector, NAME_LABEL))
            {
                (name.clone(), Some(name), pods.text())
            } else {
                (selector.text(), None, pods.text())
            }
        }
        NamespaceScope::Any => match single(pods, NAMESPACE_LABEL) {
            Some(name) => (
                name.clone(),
                Some(name),
                without(pods, NAMESPACE_LABEL).text(),
            ),
            None => ("*".to_owned(), None, pods.text()),
        },
    }
}

/// The row of one peer of a rule, or `None` when it needs none: a Pods peer that takes in no
/// running Pod outside the namespace, or every Pod, and the entities `all`, `cluster` and
/// `world`, which the catch-alls stand for.
fn row_of(index: &Index, namespace: &str, owners: &Owners, peer: &Peer) -> Option<OutsidePeer> {
    let row = |id: String, kind: PeerKind, label: String, detail: &str, end: Outside| OutsidePeer {
        id,
        kind,
        namespace: None,
        label,
        detail: detail.to_owned(),
        source: false,
        destination: false,
        end: PeerEnd::Outside(end),
    };
    match peer {
        Peer::Pods {
            namespaces, pods, ..
        } => {
            if names_every_pod(peer) || *namespaces == NamespaceScope::Only(namespace.to_owned()) {
                return None;
            }
            let matched: Vec<usize> = index
                .pods()
                .iter()
                .enumerate()
                .filter(|(i, pod)| {
                    pod.namespace != namespace && !pod.finished && index.peer_selects(peer, *i)
                })
                .map(|(i, _)| i)
                .collect();
            if matched.is_empty() {
                return None;
            }
            let mut workloads = group(index, matched.iter().copied(), owners);
            if workloads.len() == 1 {
                let workload = workloads.remove(0);
                return Some(OutsidePeer {
                    id: workload.id,
                    kind: PeerKind::Workload,
                    label: format!("{}/{}", workload.namespace, workload.name),
                    detail: format!("{} · {}", workload.kind, pods_text(workload.pods.len())),
                    namespace: Some(workload.namespace),
                    source: false,
                    destination: false,
                    end: PeerEnd::Pods(workload.pods),
                });
            }
            let (part, single_namespace, selector) = selector_parts(namespaces, pods);
            let label = format!("{part}/{selector}");
            Some(OutsidePeer {
                id: format!("selector:{label}"),
                kind: PeerKind::Selector,
                namespace: single_namespace,
                label,
                detail: pods_text(matched.len()),
                source: false,
                destination: false,
                end: PeerEnd::Pods(matched),
            })
        }
        Peer::Cidr { cidr, except } => {
            let label = if except.is_empty() {
                cidr.clone()
            } else {
                format!("{cidr} except {}", except.join(", "))
            };
            let end = Outside::Cidr {
                cidr: cidr.clone(),
                except: except.clone(),
            };
            Some(row(
                format!("cidr:{label}"),
                PeerKind::Cidr,
                label,
                "CIDR",
                end,
            ))
        }
        Peer::Entity(Entity::All | Entity::Cluster | Entity::World) => None,
        Peer::Entity(entity) => {
            let label = entity.name().to_owned();
            let end = Outside::Entity(*entity);
            Some(row(
                format!("entity:{label}"),
                PeerKind::Entity,
                label,
                "Cilium entity",
                end,
            ))
        }
        Peer::Fqdn { name, pattern } => {
            let label = name.clone().or_else(|| pattern.clone())?;
            let end = Outside::Fqdn {
                name: name.clone(),
                pattern: pattern.clone(),
            };
            Some(row(
                format!("fqdn:{label}"),
                PeerKind::Fqdn,
                label,
                "DNS name",
                end,
            ))
        }
    }
}

/// Adds a row, or joins it to the row of the same id: its Pods are united, and the detail
/// counts them again.
fn add(rows: &mut Vec<OutsidePeer>, row: OutsidePeer, source: bool) {
    let index = match rows.iter().position(|kept| kept.id == row.id) {
        Some(index) => index,
        None => {
            rows.push(row.clone());
            rows.len() - 1
        }
    };
    let kept = &mut rows[index];
    if let (PeerEnd::Pods(pods), PeerEnd::Pods(more)) = (&mut kept.end, &row.end) {
        pods.extend(more.iter().copied());
        pods.sort_unstable();
        pods.dedup();
        let count = pods_text(pods.len());
        kept.detail = match kept.detail.split_once(" · ") {
            Some((kind, _)) => format!("{kind} · {count}"),
            None => count,
        };
    }
    if source {
        kept.source = true;
    } else {
        kept.destination = true;
    }
}

/// The outside peers of `namespace`, sorted by kind then label, then the two catch-alls.
pub(crate) fn outside_peers(index: &Index, namespace: &str, owners: &Owners) -> Vec<OutsidePeer> {
    let rules: BTreeSet<(usize, usize)> = running(index, namespace)
        .into_iter()
        .flat_map(|pod| index.rules_of(pod).iter().copied())
        .collect();
    let mut peers: Vec<(&Peer, bool)> = Vec::new();
    for (policy, rule) in rules {
        let Some(rule) = index.policies().get(policy).and_then(|p| p.rules.get(rule)) else {
            continue;
        };
        let sources = rule
            .ingress
            .iter()
            .chain(&rule.ingress_deny)
            .map(|entry| (entry, true));
        let destinations = rule
            .egress
            .iter()
            .chain(&rule.egress_deny)
            .map(|entry| (entry, false));
        for (entry, source) in sources.chain(destinations) {
            for peer in &entry.peers {
                if !peers.contains(&(peer, source)) {
                    peers.push((peer, source));
                }
            }
        }
    }
    let mut rows: Vec<OutsidePeer> = Vec::new();
    for (peer, source) in peers {
        if let Some(row) = row_of(index, namespace, owners, peer) {
            add(&mut rows, row, source);
        }
    }
    rows.sort_by(|a, b| (a.kind, &a.label).cmp(&(b.kind, &b.label)));
    let catch_all =
        |id: &str, kind: PeerKind, label: &str, detail: &str, end: Outside| OutsidePeer {
            id: id.to_owned(),
            kind,
            namespace: None,
            label: label.to_owned(),
            detail: detail.to_owned(),
            source: true,
            destination: true,
            end: PeerEnd::Outside(end),
        };
    rows.push(catch_all(
        "otherPods",
        PeerKind::OtherPods,
        "Other Pods in the cluster",
        "Pods the rules above do not name",
        Outside::OtherPods,
    ));
    rows.push(catch_all(
        "world",
        PeerKind::World,
        "Outside the cluster",
        "Addresses the rules above do not name",
        Outside::World,
    ));
    rows
}

/// One end for each distinct signature: Pods alike in namespace, labels, ports and service
/// account get the same verdicts, so one of them stands for all (spec §5.1).
fn distinct<'a>(index: &Index, ends: &'a [End]) -> Vec<&'a End> {
    let mut seen = HashSet::new();
    ends.iter()
        .filter(|end| match end {
            End::Pod(pod) => seen.insert(index.signature(*pod)),
            End::Outside(_) => true,
        })
        .collect()
}

/// Each pair (from, to) once per distinct Pod signature (labels, ports, service account).
pub(crate) fn merge(index: &Index, from: &[End], to: &[End]) -> Merged {
    let destinations = distinct(index, to);
    let verdicts: Vec<Verdict> = distinct(index, from)
        .into_iter()
        .flat_map(|source| {
            destinations
                .iter()
                .map(move |destination| index.verdict(source, destination))
        })
        .collect();
    let Some(first) = verdicts.first() else {
        return Merged {
            kind: VerdictKind::Blocked,
            ports: Vec::new(),
            policies: Vec::new(),
            some_pods: false,
        };
    };
    let some_pods = verdicts
        .iter()
        .any(|verdict| verdict.kind != first.kind || verdict.ports != first.ports);
    let kind = verdicts
        .iter()
        .map(|verdict| verdict.kind)
        .filter(|kind| *kind != VerdictKind::Denied)
        .max()
        .unwrap_or(VerdictKind::Denied);
    let mut ports = Vec::new();
    let mut policies = Vec::new();
    for verdict in verdicts.iter().filter(|verdict| verdict.kind == kind) {
        ports.extend(verdict.ports.iter().cloned());
        policies.extend(verdict.policies.iter().cloned());
    }
    policies.sort();
    policies.dedup();
    Merged {
        kind,
        ports: unite(ports),
        policies,
        some_pods,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use serde_json::{json, Value};

    use super::*;
    use crate::netpol::eval::SideHttp;
    use crate::netpol::model::{Policy, PolicySource, Protocol};
    use crate::netpol::parse::parse_policy;
    use crate::netpol::pods::{pod_info, ContainerPort, NamespaceInfo};

    fn k8s(object: Value) -> Policy {
        parse_policy(PolicySource::Kubernetes, &object).unwrap()
    }

    fn cluster(object: Value) -> Policy {
        parse_policy(PolicySource::CiliumClusterwide, &object).unwrap()
    }

    /// A running Pod of `namespace` with its controller and labels.
    fn pod(namespace: &str, name: &str, owner: Option<(&str, &str)>, labels: Value) -> PodInfo {
        let owners = owner.map_or_else(Vec::new, |(kind, owner)| {
            vec![json!({ "kind": kind, "name": owner, "controller": true })]
        });
        pod_info(&json!({
            "metadata": { "name": name, "namespace": namespace, "labels": labels, "ownerReferences": owners },
            "status": { "phase": "Running" },
        }))
        .unwrap()
    }

    fn with_port(mut pod: PodInfo, name: &str, port: u16) -> PodInfo {
        pod.ports.push(ContainerPort {
            name: Some(name.into()),
            port,
            protocol: Protocol::Tcp,
        });
        pod
    }

    fn owners(entries: &[(&str, &str, &str, &str, &str)]) -> Owners {
        entries
            .iter()
            .map(|(kind, namespace, name, top_kind, top_name)| {
                let key = (
                    (*kind).to_owned(),
                    (*namespace).to_owned(),
                    (*name).to_owned(),
                );
                (key, ((*top_kind).to_owned(), (*top_name).to_owned()))
            })
            .collect()
    }

    fn ids(workloads: &[Workload]) -> Vec<(&str, Vec<usize>)> {
        workloads
            .iter()
            .map(|workload| (workload.id.as_str(), workload.pods.clone()))
            .collect()
    }

    fn tcp(port: u16) -> PortSpan {
        PortSpan {
            protocol: Protocol::Tcp,
            port: Some(port),
            end_port: None,
            name: None,
            http: Vec::<SideHttp>::new(),
        }
    }

    fn ends(pods: &[usize]) -> Vec<End> {
        pods.iter().map(|pod| End::Pod(*pod)).collect()
    }

    /// Spec §5.1: a ReplicaSet's controller, then a Job's, then the direct controller, then the
    /// Pod itself; sorted by name then kind.
    #[test]
    fn pods_group_by_their_top_owner() {
        let pods = vec![
            pod(
                "a",
                "web-1",
                Some(("ReplicaSet", "web-7d9f")),
                json!({ "app": "web", "pod": "1" }),
            ),
            pod(
                "a",
                "web-2",
                Some(("ReplicaSet", "web-7d9f")),
                json!({ "app": "web", "pod": "2" }),
            ),
            pod("a", "loose-1", Some(("ReplicaSet", "loose")), json!({})),
            pod("a", "backup-1", Some(("Job", "backup-29000")), json!({})),
            pod("a", "once-1", Some(("Job", "once")), json!({})),
            pod("a", "db-0", Some(("StatefulSet", "db")), json!({})),
            pod("a", "bare", None, json!({})),
            pod("a", "web", Some(("StatefulSet", "web")), json!({})),
            pod("b", "web-3", Some(("ReplicaSet", "web-7d9f")), json!({})),
        ];
        let owners = owners(&[
            ("ReplicaSet", "a", "web-7d9f", "Deployment", "web"),
            ("Job", "a", "backup-29000", "CronJob", "backup"),
        ]);
        let index = Index::new(Vec::new(), pods, Vec::new());
        let workloads = workloads(&index, "a", &owners);
        assert_eq!(
            ids(&workloads),
            [
                ("CronJob/a/backup", vec![3]),
                ("Pod/a/bare", vec![6]),
                ("StatefulSet/a/db", vec![5]),
                ("ReplicaSet/a/loose", vec![2]),
                ("Job/a/once", vec![4]),
                ("Deployment/a/web", vec![0, 1]),
                ("StatefulSet/a/web", vec![7]),
            ]
        );
        assert_eq!(
            workloads[5].labels,
            BTreeMap::from([("app".to_owned(), "web".to_owned())])
        );
        assert_eq!(
            (
                workloads[5].kind.as_str(),
                workloads[5].namespace.as_str(),
                workloads[5].name.as_str()
            ),
            ("Deployment", "a", "web")
        );
        // The ReplicaSet of the same name in `b` has no known controller.
        assert_eq!(
            ids(&super::workloads(&index, "b", &owners)),
            [("ReplicaSet/b/web-7d9f", vec![8])]
        );
    }

    /// Spec §5.1: finished Pods are left out, and so is a workload with no running Pod.
    #[test]
    fn finished_pods_and_workloads_without_a_running_pod_are_left_out() {
        let mut done = pod("a", "backup-1", Some(("Job", "backup-1")), json!({}));
        done.finished = true;
        let mut failed = pod("a", "web-2", Some(("ReplicaSet", "web-7d9f")), json!({}));
        failed.finished = true;
        let pods = vec![
            done,
            pod("a", "web-1", Some(("ReplicaSet", "web-7d9f")), json!({})),
            failed,
        ];
        let owners = owners(&[("ReplicaSet", "a", "web-7d9f", "Deployment", "web")]);
        let index = Index::new(Vec::new(), pods, Vec::new());
        assert_eq!(
            ids(&workloads(&index, "a", &owners)),
            [("Deployment/a/web", vec![1])]
        );
    }

    /// Spec §5.1: a group shows the most permissive verdict its Pods get, and "Some Pods" when
    /// they differ.
    #[test]
    fn some_pods_when_the_pods_of_a_group_differ() {
        let pods = vec![
            pod("a", "web-1", None, json!({ "app": "web" })),
            pod("a", "api-1", None, json!({ "app": "api" })),
            pod(
                "a",
                "api-2",
                None,
                json!({ "app": "api", "canary": "true" }),
            ),
        ];
        let canary = k8s(json!({
            "metadata": { "name": "canary-closed", "namespace": "a" },
            "spec": { "podSelector": { "matchLabels": { "canary": "true" } }, "policyTypes": ["Ingress"] },
        }));
        let index = Index::new(vec![canary], pods, Vec::new());
        assert_eq!(
            merge(&index, &ends(&[0]), &ends(&[1, 2])),
            Merged {
                kind: VerdictKind::Open,
                ports: Vec::new(),
                policies: Vec::new(),
                some_pods: true,
            }
        );
        assert_eq!(
            merge(&index, &ends(&[0]), &ends(&[2])),
            Merged {
                kind: VerdictKind::Blocked,
                ports: Vec::new(),
                policies: vec![index.policies()[0].id.clone()],
                some_pods: false,
            }
        );
    }

    /// Review Focus 4: when a rollout changed the container port, the cell unites the ports and
    /// says "Some Pods".
    #[test]
    fn pods_that_resolve_a_named_port_differently_give_some_pods() {
        let pods = vec![
            pod("a", "web-1", None, json!({ "app": "web" })),
            with_port(
                pod("a", "api-1", None, json!({ "app": "api" })),
                "http",
                8080,
            ),
            with_port(
                pod("a", "api-2", None, json!({ "app": "api" })),
                "http",
                8081,
            ),
            with_port(
                pod("a", "api-3", None, json!({ "app": "api" })),
                "http",
                8080,
            ),
        ];
        let named = k8s(json!({
            "metadata": { "name": "api-http", "namespace": "a" },
            "spec": {
                "podSelector": { "matchLabels": { "app": "api" } },
                "ingress": [{ "ports": [{ "port": "http" }] }],
            },
        }));
        let index = Index::new(vec![named], pods, Vec::new());
        let merged = merge(&index, &ends(&[0]), &ends(&[1, 2, 3]));
        assert_eq!(
            merged,
            Merged {
                kind: VerdictKind::Allowed,
                ports: vec![tcp(8080), tcp(8081)],
                policies: vec![index.policies()[0].id.clone()],
                some_pods: true,
            }
        );
        // The Pods with the same port agree.
        assert!(!merge(&index, &ends(&[0]), &ends(&[1, 3])).some_pods);
    }

    /// Spec §5.1: Denied only when every pair is denied; else the most permissive verdict.
    #[test]
    fn denied_only_when_every_pair_is_denied() {
        let pods = vec![
            pod("a", "web-1", None, json!({ "app": "web" })),
            pod("a", "web-2", None, json!({ "app": "web", "old": "true" })),
            pod("a", "api-1", None, json!({ "app": "api" })),
        ];
        let deny = |name: &str, selector: Value| {
            parse_policy(
                PolicySource::Cilium,
                &json!({
                    "metadata": { "name": name, "namespace": "a" },
                    "spec": {
                        "endpointSelector": { "matchLabels": { "app": "api" } },
                        "ingressDeny": [{ "fromEndpoints": [{ "matchLabels": selector }] }],
                    },
                }),
            )
            .unwrap()
        };
        let index = Index::new(
            vec![deny("no-old", json!({ "old": "true" }))],
            pods.clone(),
            Vec::new(),
        );
        let merged = merge(&index, &ends(&[0, 1]), &ends(&[2]));
        assert_eq!(
            (merged.kind, merged.some_pods),
            (VerdictKind::Blocked, true)
        );

        let index = Index::new(
            vec![deny("no-web", json!({ "app": "web" }))],
            pods,
            Vec::new(),
        );
        let merged = merge(&index, &ends(&[0, 1]), &ends(&[2]));
        assert_eq!(
            merged,
            Merged {
                kind: VerdictKind::Denied,
                ports: Vec::new(),
                policies: vec![index.policies()[0].id.clone()],
                some_pods: false,
            }
        );
    }

    /// The `payments` namespace of contract C13, trimmed to what the outside peers need, plus
    /// two exporters in `monitoring` and a finished Pod in `ops`.
    fn outside_index() -> (Index, Owners) {
        let pods = vec![
            pod(
                "payments",
                "api-1",
                Some(("ReplicaSet", "api-5c8b")),
                json!({ "app": "api" }),
            ),
            pod(
                "kube-system",
                "coredns-1",
                Some(("ReplicaSet", "coredns-5d78")),
                json!({ "k8s-app": "kube-dns" }),
            ),
            pod(
                "kube-system",
                "coredns-2",
                Some(("ReplicaSet", "coredns-5d78")),
                json!({ "k8s-app": "kube-dns" }),
            ),
            pod(
                "monitoring",
                "node-exporter-a",
                Some(("DaemonSet", "node-exporter")),
                json!({ "app": "exporter" }),
            ),
            pod(
                "monitoring",
                "blackbox-1",
                Some(("ReplicaSet", "blackbox-6c7d")),
                json!({ "app": "exporter" }),
            ),
            {
                let mut done = pod(
                    "ops",
                    "report-1",
                    Some(("Job", "report")),
                    json!({ "app": "report" }),
                );
                done.finished = true;
                done
            },
        ];
        let namespaces = ["payments", "kube-system", "monitoring", "ops"]
            .iter()
            .map(|name| NamespaceInfo {
                name: (*name).to_owned(),
                labels: BTreeMap::from([(
                    "kubernetes.io/metadata.name".to_owned(),
                    (*name).to_owned(),
                )]),
            })
            .collect();
        let policies = vec![
            k8s(json!({
                "metadata": { "name": "api-peers", "namespace": "payments" },
                "spec": {
                    "podSelector": { "matchLabels": { "app": "api" } },
                    "policyTypes": ["Ingress", "Egress"],
                    "ingress": [{ "from": [
                        { "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "monitoring" } },
                          "podSelector": { "matchLabels": { "app": "exporter" } } },
                        { "podSelector": { "matchLabels": { "app": "web" } } },
                        { "namespaceSelector": {} },
                        { "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "ops" } } },
                    ] }],
                    "egress": [
                        { "to": [{
                            "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "kube-system" } },
                            "podSelector": { "matchLabels": { "k8s-app": "kube-dns" } },
                        }] },
                        { "to": [
                            { "ipBlock": { "cidr": "10.0.0.0/8", "except": ["10.1.0.0/16", "10.2.0.0/16"] } },
                            { "ipBlock": { "cidr": "192.168.0.0/16" } },
                        ] },
                    ],
                },
            })),
            cluster(json!({
                "metadata": { "name": "api-cilium" },
                "spec": {
                    "endpointSelector": { "matchLabels": { "app": "api" } },
                    "ingress": [
                        { "fromEndpoints": [{ "matchLabels": { "k8s:io.kubernetes.pod.namespace": "kube-system" } }] },
                        { "fromEntities": ["host", "world", "cluster"] },
                    ],
                    "egress": [
                        { "toFQDNs": [{ "matchName": "api.stripe.com" }, { "matchPattern": "*.example.com" }] },
                        { "toEntities": ["kube-apiserver", "all"] },
                        { "toEndpoints": [{ "matchLabels": { "k8s:io.kubernetes.pod.namespace": "monitoring", "app": "exporter" } }] },
                    ],
                    "egressDeny": [{ "toEntities": ["host"] }],
                },
            })),
        ];
        let owners = owners(&[
            ("ReplicaSet", "payments", "api-5c8b", "Deployment", "api"),
            (
                "ReplicaSet",
                "kube-system",
                "coredns-5d78",
                "Deployment",
                "coredns",
            ),
            (
                "ReplicaSet",
                "monitoring",
                "blackbox-6c7d",
                "Deployment",
                "blackbox",
            ),
        ]);
        (Index::new(policies, pods, namespaces), owners)
    }

    /// Spec §5.2 and contract C9: each peer of the namespace's rules is one row with its id,
    /// label and detail, sorted by kind then label; the two catch-alls come last.
    #[test]
    fn outside_peers_come_from_the_rules_of_the_namespace() {
        let (index, owners) = outside_index();
        let peers = outside_peers(&index, "payments", &owners);
        let rows: Vec<_> = peers
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
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (
                    "Deployment/kube-system/coredns",
                    PeerKind::Workload,
                    Some("kube-system"),
                    "kube-system/coredns",
                    "Deployment · 2 Pods",
                    true,
                    true
                ),
                (
                    "selector:monitoring/app=exporter",
                    PeerKind::Selector,
                    Some("monitoring"),
                    "monitoring/app=exporter",
                    "2 Pods",
                    true,
                    true
                ),
                (
                    "cidr:10.0.0.0/8 except 10.1.0.0/16, 10.2.0.0/16",
                    PeerKind::Cidr,
                    None,
                    "10.0.0.0/8 except 10.1.0.0/16, 10.2.0.0/16",
                    "CIDR",
                    false,
                    true
                ),
                (
                    "cidr:192.168.0.0/16",
                    PeerKind::Cidr,
                    None,
                    "192.168.0.0/16",
                    "CIDR",
                    false,
                    true
                ),
                (
                    "entity:host",
                    PeerKind::Entity,
                    None,
                    "host",
                    "Cilium entity",
                    true,
                    true
                ),
                (
                    "entity:kube-apiserver",
                    PeerKind::Entity,
                    None,
                    "kube-apiserver",
                    "Cilium entity",
                    false,
                    true
                ),
                (
                    "fqdn:*.example.com",
                    PeerKind::Fqdn,
                    None,
                    "*.example.com",
                    "DNS name",
                    false,
                    true
                ),
                (
                    "fqdn:api.stripe.com",
                    PeerKind::Fqdn,
                    None,
                    "api.stripe.com",
                    "DNS name",
                    false,
                    true
                ),
                (
                    "otherPods",
                    PeerKind::OtherPods,
                    None,
                    "Other Pods in the cluster",
                    "Pods the rules above do not name",
                    true,
                    true
                ),
                (
                    "world",
                    PeerKind::World,
                    None,
                    "Outside the cluster",
                    "Addresses the rules above do not name",
                    true,
                    true
                ),
            ]
        );
        assert_eq!(peers[0].end, PeerEnd::Pods(vec![1, 2]));
        assert_eq!(peers[1].end, PeerEnd::Pods(vec![3, 4]));
        assert_eq!(
            peers[2].end,
            PeerEnd::Outside(Outside::Cidr {
                cidr: "10.0.0.0/8".into(),
                except: vec!["10.1.0.0/16".into(), "10.2.0.0/16".into()],
            })
        );
        assert_eq!(peers[8].end, PeerEnd::Outside(Outside::OtherPods));
        assert_eq!(peers[9].end, PeerEnd::Outside(Outside::World));
    }

    /// Contract C9: a selector that resolves to one workload is that workload; to several, a
    /// selector peer whose namespace part is its namespace, its selector's text or `*`.
    #[test]
    fn a_selector_peer_is_labelled_by_its_namespace_part() {
        let pods = vec![
            pod("payments", "api-1", None, json!({ "app": "api" })),
            pod("team-a1", "client-1", None, json!({ "app": "client" })),
            pod("team-a2", "client-2", None, json!({ "app": "client" })),
        ];
        let namespaces = vec![
            NamespaceInfo {
                name: "team-a1".into(),
                labels: BTreeMap::from([("team".to_owned(), "a".to_owned())]),
            },
            NamespaceInfo {
                name: "team-a2".into(),
                labels: BTreeMap::from([("team".to_owned(), "a".to_owned())]),
            },
        ];
        let policy = k8s(json!({
            "metadata": { "name": "api-in", "namespace": "payments" },
            "spec": {
                "podSelector": { "matchLabels": { "app": "api" } },
                "ingress": [{ "from": [
                    { "namespaceSelector": { "matchLabels": { "team": "a" } } },
                    { "namespaceSelector": {}, "podSelector": { "matchLabels": { "app": "client" } } },
                ] }],
            },
        }));
        let index = Index::new(vec![policy], pods, namespaces);
        let peers = outside_peers(&index, "payments", &Owners::new());
        let labels: Vec<(&str, Option<&str>, &str)> = peers
            .iter()
            .map(|peer| {
                (
                    peer.id.as_str(),
                    peer.namespace.as_deref(),
                    peer.detail.as_str(),
                )
            })
            .collect();
        assert_eq!(
            labels,
            [
                ("selector:*/app=client", None, "2 Pods"),
                ("selector:team=a/All Pods", None, "2 Pods"),
                ("otherPods", None, "Pods the rules above do not name"),
                ("world", None, "Addresses the rules above do not name"),
            ]
        );
    }

    /// Spec §8: a namespace of 300 Pods in 30 Deployments under 1,000 NetworkPolicies merges
    /// every workload against every workload well inside the 2 s build interval.
    #[test]
    fn three_hundred_pods_under_a_thousand_policies_merge_quickly() {
        let mut pods = Vec::new();
        let mut owner_entries = Vec::new();
        for d in 0..30 {
            let app = format!("d-{d}");
            let replica_set = format!("{app}-rs");
            owner_entries.push((replica_set.clone(), app.clone()));
            for p in 0..10 {
                pods.push(with_port(
                    pod(
                        "perf",
                        &format!("{replica_set}-{p}"),
                        Some(("ReplicaSet", &replica_set)),
                        json!({ "app": app }),
                    ),
                    "http",
                    8080,
                ));
            }
        }
        let owners: Owners = owner_entries
            .into_iter()
            .map(|(replica_set, app)| {
                let key = ("ReplicaSet".to_owned(), "perf".to_owned(), replica_set);
                (key, ("Deployment".to_owned(), app))
            })
            .collect();
        let policies: Vec<Policy> = (0..1_000)
            .map(|j| {
                let app = j % 30;
                k8s(json!({
                    "metadata": { "name": format!("np-{j}"), "namespace": "perf" },
                    "spec": {
                        "podSelector": { "matchLabels": { "app": format!("d-{app}") } },
                        "policyTypes": ["Ingress", "Egress"],
                        "ingress": [{
                            "from": [{ "podSelector": { "matchLabels": { "app": format!("d-{}", (app + 1) % 30) } } }],
                            "ports": [{ "port": 8000 + j % 40 }, { "port": "http" }],
                        }],
                        "egress": [{
                            "to": [{ "podSelector": { "matchLabels": { "app": format!("d-{}", (app + 29) % 30) } } }],
                            "ports": [{ "port": "http" }],
                        }],
                    },
                }))
            })
            .collect();

        let started = Instant::now();
        let index = Index::new(policies, pods, Vec::new());
        let workloads = workloads(&index, "perf", &owners);
        let peers = outside_peers(&index, "perf", &owners);
        let mut allowed = 0;
        for from in &workloads {
            for to in &workloads {
                let merged = merge(&index, &ends(&from.pods), &ends(&to.pods));
                if merged.kind == VerdictKind::Allowed {
                    assert_eq!(merged.ports, [tcp(8080)]);
                    allowed += 1;
                }
            }
        }
        let took = started.elapsed();
        eprintln!("30 x 30 workloads of 300 Pods under 1,000 policies merged in {took:?}");

        assert_eq!(workloads.len(), 30);
        assert_eq!(peers.len(), 2);
        assert_eq!(allowed, 30);
        assert!(took.as_millis() < 2_000, "{took:?}");
    }
}
