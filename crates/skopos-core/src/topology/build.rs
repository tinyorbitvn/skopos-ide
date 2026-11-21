//! The node topology of a cluster's nodes and pods (topology spec §5): grouping, sorting, pod
//! states and request sums. Pure; the hub feeds it the rows of two watches.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use super::types::{
    NodeReady, PodState, TopologyAmounts, TopologyNode, TopologyPod, TopologyRegion,
    TopologySnapshot, TopologyTaint, TopologyZone,
};
use crate::graph::{is_init_progress, pod_summary};
use crate::metrics::parse_quantity;
use crate::resources::{WatchEvent, WatchStatus};

const REGION: &str = "topology.kubernetes.io/region";
const ZONE: &str = "topology.kubernetes.io/zone";
const OLD_REGION: &str = "failure-domain.beta.kubernetes.io/region";
const OLD_ZONE: &str = "failure-domain.beta.kubernetes.io/zone";
const ROLE_PREFIX: &str = "node-role.kubernetes.io/";
const ROLE_LABEL: &str = "kubernetes.io/role";
/// The conditions a card shows while they are True, worst first, as `nodeConditions` ranks them.
const SHOWN_CONDITIONS: [&str; 4] = [
    "NetworkUnavailable",
    "MemoryPressure",
    "DiskPressure",
    "PIDPressure",
];
/// The phases the API defines. Another phase that reaches the summary text is Unknown.
const PHASES: [&str; 5] = ["Pending", "Running", "Succeeded", "Failed", "Unknown"];
/// The largest amount a `u64` holds, as a float.
const MAX_AMOUNT: f64 = u64::MAX as f64;

/// A non-empty string.
fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// A Kubernetes quantity times `scale` (1000 for millicores), rounded. None when it is missing,
/// malformed, negative or too large.
fn quantity(value: &Value, scale: f64) -> Option<u64> {
    let amount = match value {
        Value::String(text) => parse_quantity(text)?,
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    let scaled = (amount * scale).round();
    if scaled.is_finite() && (0.0..=MAX_AMOUNT).contains(&scaled) {
        Some(scaled as u64)
    } else {
        None
    }
}

/// A container's request of `resource`, in `scale` units; 0 without one.
fn request(container: &Value, resource: &str, scale: f64) -> u64 {
    quantity(&container["resources"]["requests"][resource], scale).unwrap_or(0)
}

/// A node as the topology draws it, without pods or requests. None without a name.
pub(crate) fn node_record(node: &Value) -> Option<TopologyNode> {
    let metadata = &node["metadata"];
    let name = text(&metadata["name"])?.to_owned();
    let labels: BTreeMap<String, String> = metadata["labels"]
        .as_object()
        .map(|labels| {
            labels
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let mut roles: Vec<String> = labels
        .keys()
        .filter_map(|key| key.strip_prefix(ROLE_PREFIX))
        .filter(|role| !role.is_empty())
        .map(str::to_owned)
        .collect();
    if let Some(role) = labels.get(ROLE_LABEL).filter(|role| !role.is_empty()) {
        roles.push(role.clone());
    }
    roles.sort();
    roles.dedup();

    let status = &node["status"];
    let conditions = list(&status["conditions"]);
    let status_of = |kind: &str| {
        conditions
            .iter()
            .find(|condition| condition["type"] == kind)
            .and_then(|condition| condition["status"].as_str())
    };
    let ready = match status_of("Ready") {
        Some("True") => NodeReady::Ready,
        Some("False") => NodeReady::NotReady,
        _ => NodeReady::Unknown,
    };
    let shown = SHOWN_CONDITIONS
        .into_iter()
        .filter(|kind| status_of(kind) == Some("True"))
        .map(str::to_owned)
        .collect();
    let taints = list(&node["spec"]["taints"])
        .iter()
        .filter_map(|taint| {
            Some(TopologyTaint {
                key: text(&taint["key"])?.to_owned(),
                value: text(&taint["value"]).map(str::to_owned),
                effect: taint["effect"].as_str().unwrap_or_default().to_owned(),
            })
        })
        .collect();
    let allocatable = &status["allocatable"];
    Some(TopologyNode {
        name,
        labels,
        roles,
        ready,
        unschedulable: node["spec"]["unschedulable"] == true,
        taints,
        conditions: shown,
        allocatable: TopologyAmounts {
            cpu_millis: quantity(&allocatable["cpu"], 1000.0),
            memory_bytes: quantity(&allocatable["memory"], 1.0),
            pods: quantity(&allocatable["pods"], 1.0).and_then(|n| u32::try_from(n).ok()),
        },
        requests: TopologyAmounts::default(),
        pods: Vec::new(),
    })
}

/// A pod as the topology uses it: where it runs, how it shows and what it requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PodRecord {
    pub(crate) node_name: Option<String>,
    pub(crate) pod: TopologyPod,
    pub(crate) cpu_millis: u64,
    pub(crate) memory_bytes: u64,
}

/// None without a name or a namespace.
pub(crate) fn pod_record(pod: &Value) -> Option<PodRecord> {
    let metadata = &pod["metadata"];
    let name = text(&metadata["name"])?.to_owned();
    let namespace = text(&metadata["namespace"])?.to_owned();
    let status = pod_summary(pod).status;
    let state = pod_state(&status, pod["status"]["phase"].as_str());
    let (cpu_millis, memory_bytes) = pod_requests(pod);
    Some(PodRecord {
        node_name: text(&pod["spec"]["nodeName"]).map(str::to_owned),
        pod: TopologyPod {
            namespace,
            name,
            state,
            status,
        },
        cpu_millis,
        memory_bytes,
    })
}

/// The state of a pod's summary text (topology spec §5.2), checked in the table's order.
pub(crate) fn pod_state(text: &str, phase: Option<&str>) -> PodState {
    match text {
        "Completed" | "Succeeded" => PodState::Succeeded,
        "Running" => PodState::Running,
        "Pending" | "NotReady" | "ContainerCreating" | "PodInitializing" | "SchedulingGated" => {
            PodState::Pending
        }
        text if is_init_progress(text) => PodState::Pending,
        "Unknown" | "Terminating" => PodState::Unknown,
        // A phase the API does not define, which no reason replaced (spec §7).
        text if phase == Some(text) && !PHASES.contains(&text) => PodState::Unknown,
        _ => PodState::Failed,
    }
}

/// A pod's effective CPU (millicores) and memory (bytes) requests, as the scheduler counts them
/// (topology spec §5.3). Restartable init containers run beside the others, so they add to the
/// sum, and each later init container runs beside them. Finished pods count zero.
pub(crate) fn pod_requests(pod: &Value) -> (u64, u64) {
    if matches!(
        pod["status"]["phase"].as_str(),
        Some("Succeeded" | "Failed")
    ) {
        return (0, 0);
    }
    let spec = &pod["spec"];
    let (mut cpu, mut memory) = (0u64, 0u64);
    for container in list(&spec["containers"]) {
        cpu = cpu.saturating_add(request(container, "cpu", 1000.0));
        memory = memory.saturating_add(request(container, "memory", 1.0));
    }
    let (mut sidecar_cpu, mut sidecar_memory) = (0u64, 0u64);
    let (mut init_cpu, mut init_memory) = (0u64, 0u64);
    for container in list(&spec["initContainers"]) {
        let own_cpu = request(container, "cpu", 1000.0);
        let own_memory = request(container, "memory", 1.0);
        let (use_cpu, use_memory) = if container["restartPolicy"] == "Always" {
            cpu = cpu.saturating_add(own_cpu);
            memory = memory.saturating_add(own_memory);
            sidecar_cpu = sidecar_cpu.saturating_add(own_cpu);
            sidecar_memory = sidecar_memory.saturating_add(own_memory);
            (sidecar_cpu, sidecar_memory)
        } else {
            (
                own_cpu.saturating_add(sidecar_cpu),
                own_memory.saturating_add(sidecar_memory),
            )
        };
        init_cpu = init_cpu.max(use_cpu);
        init_memory = init_memory.max(use_memory);
    }
    let overhead = &spec["overhead"];
    (
        cpu.max(init_cpu)
            .saturating_add(quantity(&overhead["cpu"], 1000.0).unwrap_or(0)),
        memory
            .max(init_memory)
            .saturating_add(quantity(&overhead["memory"], 1.0).unwrap_or(0)),
    )
}

fn split_digits(bytes: &[u8]) -> (&[u8], &[u8]) {
    let end = bytes
        .iter()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(bytes.len());
    bytes.split_at(end)
}

fn trim_zeros(digits: &[u8]) -> &[u8] {
    let start = digits
        .iter()
        .position(|b| *b != b'0')
        .unwrap_or(digits.len());
    &digits[start..]
}

/// Natural order: runs of digits compare by value, so worker-2 comes before worker-10. Names
/// equal in value keep a stable order by their text.
pub(crate) fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a.as_bytes(), b.as_bytes());
    loop {
        match (left.first(), right.first()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (left_digits, left_rest) = split_digits(left);
                let (right_digits, right_rest) = split_digits(right);
                let (left_value, right_value) = (trim_zeros(left_digits), trim_zeros(right_digits));
                let order = left_value
                    .len()
                    .cmp(&right_value.len())
                    .then_with(|| left_value.cmp(right_value));
                if order != Ordering::Equal {
                    return order;
                }
                left = left_rest;
                right = right_rest;
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(y);
                }
                left = &left[1..];
                right = &right[1..];
            }
        }
    }
}

/// By name, with None ("No region", "No zone") last.
fn name_order(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => a.cmp(b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// A node's region and zone: the current label, else the deprecated one. Empty is missing.
fn place(node: &TopologyNode) -> (Option<String>, Option<String>) {
    let label = |current: &str, old: &str| {
        [current, old].into_iter().find_map(|key| {
            node.labels
                .get(key)
                .filter(|value| !value.is_empty())
                .cloned()
        })
    };
    (label(REGION, OLD_REGION), label(ZONE, OLD_ZONE))
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

type Zones = HashMap<Option<String>, Vec<TopologyNode>>;

/// The snapshot of `nodes` with their `pods` (topology spec §5.1). A pod bound to no listed
/// node is left out. While pods are hidden, nodes carry no pods and no requests.
pub(crate) fn build<'a>(
    nodes: impl IntoIterator<Item = &'a TopologyNode>,
    pods: impl IntoIterator<Item = &'a PodRecord>,
    pods_hidden: bool,
) -> TopologySnapshot {
    let mut placed: HashMap<String, TopologyNode> = HashMap::new();
    for node in nodes {
        let mut node = node.clone();
        node.pods.clear();
        node.requests = if pods_hidden {
            TopologyAmounts::default()
        } else {
            TopologyAmounts {
                cpu_millis: Some(0),
                memory_bytes: Some(0),
                pods: None,
            }
        };
        placed.insert(node.name.clone(), node);
    }
    if !pods_hidden {
        for record in pods {
            let Some(node) = record
                .node_name
                .as_deref()
                .and_then(|name| placed.get_mut(name))
            else {
                continue;
            };
            node.pods.push(record.pod.clone());
            node.requests.cpu_millis = node
                .requests
                .cpu_millis
                .map(|sum| sum.saturating_add(record.cpu_millis));
            node.requests.memory_bytes = node
                .requests
                .memory_bytes
                .map(|sum| sum.saturating_add(record.memory_bytes));
        }
    }

    let mut grouped: HashMap<Option<String>, Zones> = HashMap::new();
    for mut node in placed.into_values() {
        node.pods.sort_by(|a, b| {
            a.namespace
                .cmp(&b.namespace)
                .then_with(|| a.name.cmp(&b.name))
        });
        let (region, zone) = place(&node);
        grouped
            .entry(region)
            .or_default()
            .entry(zone)
            .or_default()
            .push(node);
    }
    let mut regions: Vec<TopologyRegion> = grouped
        .into_iter()
        .map(|(name, zones)| {
            let mut zones: Vec<TopologyZone> = zones
                .into_iter()
                .map(|(name, mut nodes)| {
                    nodes.sort_by(|a, b| natural_cmp(&a.name, &b.name));
                    TopologyZone { name, nodes }
                })
                .collect();
            zones.sort_by(|a, b| name_order(a.name.as_deref(), b.name.as_deref()));
            let node_count = count(zones.iter().map(|zone| zone.nodes.len()).sum());
            let pod_count = count(
                zones
                    .iter()
                    .flat_map(|zone| &zone.nodes)
                    .map(|node| node.pods.len())
                    .sum(),
            );
            TopologyRegion {
                name,
                zones,
                node_count,
                pod_count,
            }
        })
        .collect();
    regions.sort_by(|a, b| name_order(a.name.as_deref(), b.name.as_deref()));
    TopologySnapshot {
        node_count: regions.iter().map(|region| region.node_count).sum(),
        pod_count: regions.iter().map(|region| region.pod_count).sum(),
        regions,
        pods_hidden,
    }
}

/// Whether a watch's first list came, or can never come.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Phase {
    #[default]
    Waiting,
    Listed,
    /// Forbidden, or no longer served.
    Missing,
}

/// The two watches the topology reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Nodes,
    Pods,
}

/// The nodes and pods the hub sent, parsed once per row.
#[derive(Debug, Default)]
pub(crate) struct Store {
    nodes_phase: Phase,
    pods_phase: Phase,
    nodes: HashMap<String, TopologyNode>,
    pods: HashMap<(String, String), PodRecord>,
}

impl Store {
    /// Both first lists came, or the pods' cannot come.
    pub(crate) fn ready(&self) -> bool {
        self.nodes_phase != Phase::Waiting && self.pods_phase != Phase::Waiting
    }

    /// Applies one hub event. Returns the failure that ends the topology: the node list is
    /// forbidden or no longer served. Pods that cannot be listed hide instead.
    pub(crate) fn apply(&mut self, source: Source, event: WatchEvent) -> Option<String> {
        match (source, event) {
            // Only the forwarder to the webview cuts a snapshot, so none arrives here.
            (_, WatchEvent::SnapshotPart { .. }) => {}
            (Source::Nodes, WatchEvent::Snapshot { items }) => {
                self.nodes = items
                    .iter()
                    .filter_map(|row| node_record(&row.to_value()))
                    .map(|node| (node.name.clone(), node))
                    .collect();
                self.nodes_phase = Phase::Listed;
            }
            (Source::Pods, WatchEvent::Snapshot { items }) => {
                self.pods = items
                    .iter()
                    .filter_map(|row| pod_record(&row.to_value()))
                    .map(|record| {
                        let key = (record.pod.namespace.clone(), record.pod.name.clone());
                        (key, record)
                    })
                    .collect();
                self.pods_phase = Phase::Listed;
            }
            (Source::Nodes, WatchEvent::Batch { upserts, deletes }) => {
                for row in &upserts {
                    if let Some(node) = node_record(&row.to_value()) {
                        self.nodes.insert(node.name.clone(), node);
                    }
                }
                for deleted in deletes {
                    self.nodes.remove(&deleted.name);
                }
            }
            (Source::Pods, WatchEvent::Batch { upserts, deletes }) => {
                for row in &upserts {
                    if let Some(record) = pod_record(&row.to_value()) {
                        let key = (record.pod.namespace.clone(), record.pod.name.clone());
                        self.pods.insert(key, record);
                    }
                }
                for deleted in deletes {
                    self.pods
                        .remove(&(deleted.namespace.unwrap_or_default(), deleted.name));
                }
            }
            (
                Source::Nodes,
                WatchEvent::Status {
                    status: WatchStatus::Forbidden,
                    message,
                },
            ) => {
                return Some(match message {
                    Some(message) => format!("Listing nodes is not allowed: {message}"),
                    None => "Listing nodes is not allowed".to_owned(),
                });
            }
            (
                Source::Nodes,
                WatchEvent::Status {
                    status: WatchStatus::NotServed,
                    message,
                },
            ) => {
                return Some(
                    message.unwrap_or_else(|| "the cluster no longer serves nodes".to_owned()),
                );
            }
            // Both are final: the hub sends nothing more for pods.
            (
                Source::Pods,
                WatchEvent::Status {
                    status: WatchStatus::Forbidden | WatchStatus::NotServed,
                    ..
                },
            ) => {
                self.pods.clear();
                self.pods_phase = Phase::Missing;
            }
            (_, WatchEvent::Status { .. }) => {}
        }
        None
    }

    pub(crate) fn build(&self) -> TopologySnapshot {
        build(
            self.nodes.values(),
            self.pods.values(),
            self.pods_phase == Phase::Missing,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{json, Value};

    use super::*;
    use crate::resources::{ObjectKey, Row};
    use crate::topology::types::TopologyEvent;

    const GIB: u64 = 1 << 30;
    const MIB: u64 = 1 << 20;

    fn node(name: &str, labels: Value) -> Value {
        json!({
            "metadata": { "name": name, "labels": labels },
            "spec": {},
            "status": {
                "allocatable": { "cpu": "4", "memory": "16Gi", "pods": "110" },
                "conditions": [{ "type": "Ready", "status": "True" }],
            },
        })
    }

    fn running_pod(namespace: &str, name: &str, node: &str) -> Value {
        json!({
            "metadata": { "name": name, "namespace": namespace },
            "spec": {
                "nodeName": node,
                "containers": [{ "name": "app", "resources": { "requests": { "cpu": "100m", "memory": "64Mi" } } }],
            },
            "status": {
                "phase": "Running",
                "conditions": [{ "type": "Ready", "status": "True" }],
                "containerStatuses": [{ "name": "app", "ready": true, "restartCount": 0, "state": { "running": {} } }],
            },
        })
    }

    fn snapshot_of(nodes: &[Value], pods: &[Value]) -> TopologySnapshot {
        let nodes: Vec<TopologyNode> = nodes.iter().filter_map(node_record).collect();
        let pods: Vec<PodRecord> = pods.iter().filter_map(pod_record).collect();
        build(&nodes, &pods, false)
    }

    /// Each zone as (region, zone, node names), in order.
    fn groups(snapshot: &TopologySnapshot) -> Vec<(Option<&str>, Option<&str>, Vec<&str>)> {
        snapshot
            .regions
            .iter()
            .flat_map(|region| {
                region.zones.iter().map(move |zone| {
                    (
                        region.name.as_deref(),
                        zone.name.as_deref(),
                        zone.nodes.iter().map(|n| n.name.as_str()).collect(),
                    )
                })
            })
            .collect()
    }

    fn rows(values: &[Value]) -> Vec<Row> {
        values.iter().map(|v| Row::new(v).unwrap()).collect()
    }

    #[test]
    fn nodes_group_by_region_and_zone_from_the_current_or_deprecated_labels() {
        let snapshot = snapshot_of(
            &[
                node(
                    "a-1",
                    json!({ "topology.kubernetes.io/region": "eu", "topology.kubernetes.io/zone": "eu-1" }),
                ),
                node(
                    "a-2",
                    json!({ "failure-domain.beta.kubernetes.io/region": "eu", "failure-domain.beta.kubernetes.io/zone": "eu-2" }),
                ),
                node(
                    "a-3",
                    json!({ "topology.kubernetes.io/region": "eu", "topology.kubernetes.io/zone": "", "failure-domain.beta.kubernetes.io/zone": "eu-1" }),
                ),
                node(
                    "b-1",
                    json!({ "topology.kubernetes.io/region": "", "topology.kubernetes.io/zone": "us-1" }),
                ),
                node("c-1", json!({})),
                node("d-1", json!({ "topology.kubernetes.io/region": "ap" })),
            ],
            &[],
        );
        assert_eq!(
            groups(&snapshot),
            [
                (Some("ap"), None, vec!["d-1"]),
                (Some("eu"), Some("eu-1"), vec!["a-1", "a-3"]),
                (Some("eu"), Some("eu-2"), vec!["a-2"]),
                (None, Some("us-1"), vec!["b-1"]),
                (None, None, vec!["c-1"]),
            ]
        );
    }

    #[test]
    fn nodes_sort_in_natural_order_and_pods_by_namespace_then_name() {
        let snapshot = snapshot_of(
            &[
                node("worker-10", json!({})),
                node("worker-2", json!({})),
                node("worker-1", json!({})),
                node("edge", json!({})),
            ],
            &[
                running_pod("shop", "web-b", "worker-1"),
                running_pod("db", "pg-0", "worker-1"),
                running_pod("shop", "web-a", "worker-1"),
            ],
        );
        assert_eq!(
            groups(&snapshot),
            [(
                None,
                None,
                vec!["edge", "worker-1", "worker-2", "worker-10"]
            )]
        );
        let pods: Vec<String> = snapshot.regions[0].zones[0].nodes[1]
            .pods
            .iter()
            .map(|p| format!("{}/{}", p.namespace, p.name))
            .collect();
        assert_eq!(pods, ["db/pg-0", "shop/web-a", "shop/web-b"]);
    }

    #[test]
    fn natural_order_compares_digit_runs_by_value() {
        let mut names = vec![
            "worker-10",
            "worker-2",
            "worker-02",
            "worker-1",
            "w",
            "worker-1a",
            "worker-",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            [
                "w",
                "worker-",
                "worker-1",
                "worker-1a",
                "worker-02",
                "worker-2",
                "worker-10"
            ]
        );
    }

    #[test]
    fn counts_include_only_pods_bound_to_listed_nodes() {
        let mut unbound = running_pod("shop", "pending", "worker-1");
        unbound["spec"].as_object_mut().unwrap().remove("nodeName");
        let snapshot = snapshot_of(
            &[
                node("worker-1", json!({ "topology.kubernetes.io/region": "eu" })),
                node("worker-2", json!({ "topology.kubernetes.io/region": "eu" })),
            ],
            &[
                running_pod("shop", "web-1", "worker-1"),
                running_pod("shop", "web-2", "worker-2"),
                running_pod("shop", "lost", "deleted-node"),
                unbound,
            ],
        );
        let region = &snapshot.regions[0];
        assert_eq!((region.node_count, region.pod_count), (2, 2));
        assert_eq!((snapshot.node_count, snapshot.pod_count), (2, 2));
        assert!(!snapshot.pods_hidden);
    }

    #[test]
    fn a_pod_state_follows_its_summary_text() {
        for (text, phase, state) in [
            ("Completed", Some("Succeeded"), PodState::Succeeded),
            ("Succeeded", Some("Succeeded"), PodState::Succeeded),
            ("Running", Some("Running"), PodState::Running),
            ("Pending", Some("Pending"), PodState::Pending),
            ("NotReady", Some("Running"), PodState::Pending),
            ("ContainerCreating", Some("Pending"), PodState::Pending),
            ("PodInitializing", Some("Pending"), PodState::Pending),
            ("SchedulingGated", Some("Pending"), PodState::Pending),
            ("Init:1/2", Some("Pending"), PodState::Pending),
            ("Unknown", None, PodState::Unknown),
            ("Terminating", Some("Running"), PodState::Unknown),
            ("CrashLoopBackOff", Some("Running"), PodState::Failed),
            ("Error", Some("Failed"), PodState::Failed),
            ("ImagePullBackOff", Some("Pending"), PodState::Failed),
            ("OOMKilled", Some("Running"), PodState::Failed),
            ("Init:Error", Some("Pending"), PodState::Failed),
            ("Init:CrashLoopBackOff", Some("Pending"), PodState::Failed),
            ("Evicted", Some("Failed"), PodState::Failed),
            ("Weird", Some("Weird"), PodState::Unknown),
        ] {
            assert_eq!(pod_state(text, phase), state, "{text}");
        }
    }

    #[test]
    fn a_pod_record_carries_the_pods_table_text() {
        let mut pod = running_pod("shop", "web-1", "worker-1");
        pod["status"]["containerStatuses"][0] = json!({
            "name": "app", "ready": false, "restartCount": 4,
            "state": { "waiting": { "reason": "CrashLoopBackOff" } },
        });
        let record = pod_record(&pod).unwrap();
        assert_eq!(
            record.pod,
            TopologyPod {
                namespace: "shop".into(),
                name: "web-1".into(),
                state: PodState::Failed,
                status: "CrashLoopBackOff".into(),
            }
        );
        assert_eq!(record.node_name.as_deref(), Some("worker-1"));
        assert_eq!(
            (record.cpu_millis, record.memory_bytes),
            (100, 64 * MIB),
            "a crashing Running pod still counts"
        );
    }

    #[test]
    fn requests_follow_the_schedulers_rule() {
        let pod = json!({
            "metadata": { "name": "p", "namespace": "a" },
            "spec": {
                "containers": [{ "name": "app", "resources": { "requests": { "cpu": "100m", "memory": "64Mi" } } }],
                "initContainers": [
                    { "name": "setup", "resources": { "requests": { "cpu": "200m", "memory": "32Mi" } } },
                    { "name": "proxy", "restartPolicy": "Always", "resources": { "requests": { "cpu": "50m", "memory": "16Mi" } } },
                    { "name": "migrate", "resources": { "requests": { "cpu": "150m", "memory": "128Mi" } } },
                ],
                "overhead": { "cpu": "10m", "memory": "8Mi" },
            },
            "status": { "phase": "Running" },
        });
        // CPU: max(100 + 50, 200, 150 + 50) + 10. Memory in Mi: max(64 + 16, 32, 128 + 16) + 8.
        assert_eq!(pod_requests(&pod), (210, 152 * MIB));

        let mut bigger_init = pod.clone();
        bigger_init["spec"]["initContainers"] = json!([
            { "name": "setup", "resources": { "requests": { "cpu": "1", "memory": "1Gi" } } },
        ]);
        bigger_init["spec"]
            .as_object_mut()
            .unwrap()
            .remove("overhead");
        assert_eq!(pod_requests(&bigger_init), (1000, GIB));

        for phase in ["Succeeded", "Failed"] {
            let mut finished = pod.clone();
            finished["status"]["phase"] = json!(phase);
            assert_eq!(pod_requests(&finished), (0, 0), "{phase}");
        }
    }

    #[test]
    fn a_node_sums_its_pods_requests_and_reads_its_card() {
        let mut worker = node(
            "worker-1",
            json!({
                "node-role.kubernetes.io/worker": "",
                "node-role.kubernetes.io/control-plane": "",
                "node-role.kubernetes.io/": "",
                "kubernetes.io/role": "worker",
            }),
        );
        worker["spec"] = json!({
            "unschedulable": true,
            "taints": [
                { "key": "dedicated", "value": "db", "effect": "NoSchedule" },
                { "key": "gpu", "effect": "NoExecute" },
            ],
        });
        worker["status"]["allocatable"] =
            json!({ "cpu": "7800m", "memory": "15Gi", "pods": "110" });
        worker["status"]["conditions"] = json!([
            { "type": "MemoryPressure", "status": "True" },
            { "type": "Ready", "status": "False" },
            { "type": "DiskPressure", "status": "False" },
            { "type": "NetworkUnavailable", "status": "True" },
        ]);
        let snapshot = snapshot_of(
            &[worker],
            &[
                running_pod("a", "x", "worker-1"),
                running_pod("a", "y", "worker-1"),
            ],
        );
        let node = &snapshot.regions[0].zones[0].nodes[0];
        assert_eq!(node.roles, ["control-plane", "worker"]);
        assert_eq!(node.ready, NodeReady::NotReady);
        assert!(node.unschedulable);
        assert_eq!(node.conditions, ["NetworkUnavailable", "MemoryPressure"]);
        assert_eq!(
            node.taints,
            [
                TopologyTaint {
                    key: "dedicated".into(),
                    value: Some("db".into()),
                    effect: "NoSchedule".into()
                },
                TopologyTaint {
                    key: "gpu".into(),
                    value: None,
                    effect: "NoExecute".into()
                },
            ]
        );
        assert_eq!(
            node.allocatable,
            TopologyAmounts {
                cpu_millis: Some(7800),
                memory_bytes: Some(15 * GIB),
                pods: Some(110)
            }
        );
        assert_eq!(
            node.requests,
            TopologyAmounts {
                cpu_millis: Some(200),
                memory_bytes: Some(128 * MIB),
                pods: None
            }
        );
    }

    #[test]
    fn hidden_pods_leave_nodes_without_pods_or_requests() {
        let nodes: Vec<TopologyNode> = [node("worker-1", json!({}))]
            .iter()
            .filter_map(node_record)
            .collect();
        let pods: Vec<PodRecord> = [running_pod("a", "x", "worker-1")]
            .iter()
            .filter_map(pod_record)
            .collect();
        let snapshot = build(&nodes, &pods, true);
        assert!(snapshot.pods_hidden);
        let node = &snapshot.regions[0].zones[0].nodes[0];
        assert!(node.pods.is_empty());
        assert_eq!(node.requests, TopologyAmounts::default());
        assert_eq!((snapshot.regions[0].pod_count, snapshot.pod_count), (0, 0));
    }

    #[test]
    fn malformed_rows_give_unknown_or_nothing_never_a_panic() {
        assert!(
            pod_record(&json!({ "metadata": { "name": "x" } })).is_none(),
            "no namespace"
        );
        assert!(node_record(&json!({ "metadata": {} })).is_none(), "no name");
        let odd = pod_record(&json!({
            "metadata": { "name": "odd", "namespace": "shop" },
            "spec": { "nodeName": 7, "containers": "x", "initContainers": [{ "resources": { "requests": { "cpu": "lots" } } }] },
            "status": { "phase": 42, "containerStatuses": {} },
        }))
        .unwrap();
        assert_eq!(
            (odd.pod.state, odd.pod.status.as_str()),
            (PodState::Unknown, "Unknown")
        );
        assert_eq!(odd.node_name, None);
        assert_eq!((odd.cpu_millis, odd.memory_bytes), (0, 0));
        let weird = pod_record(&json!({
            "metadata": { "name": "w", "namespace": "shop" },
            "status": { "phase": "Weird" },
        }))
        .unwrap();
        assert_eq!(weird.pod.state, PodState::Unknown);
        let node = node_record(&json!({
            "metadata": { "name": "n", "labels": { "a": 1, "b": "x" } },
            "spec": { "taints": [{ "effect": "NoSchedule" }, { "key": "k", "effect": "NoExecute" }], "unschedulable": "yes" },
            "status": { "allocatable": { "cpu": "lots", "memory": -5, "pods": "1e12" }, "conditions": "x" },
        }))
        .unwrap();
        assert_eq!(
            node.labels,
            BTreeMap::from([("b".to_owned(), "x".to_owned())])
        );
        assert_eq!(
            node.taints,
            [TopologyTaint {
                key: "k".into(),
                value: None,
                effect: "NoExecute".into()
            }]
        );
        assert!(!node.unschedulable);
        assert_eq!(node.ready, NodeReady::Unknown);
        assert_eq!(node.allocatable, TopologyAmounts::default());
    }

    #[test]
    fn the_store_waits_for_both_lists_then_follows_batches() {
        let mut store = Store::default();
        assert!(!store.ready());
        assert_eq!(
            store.apply(
                Source::Nodes,
                WatchEvent::Snapshot {
                    items: rows(&[node("worker-1", json!({}))])
                }
            ),
            None
        );
        assert!(!store.ready());
        store.apply(
            Source::Pods,
            WatchEvent::Snapshot {
                items: rows(&[running_pod("a", "x", "worker-1")]),
            },
        );
        assert!(store.ready());
        assert_eq!(store.build().pod_count, 1);

        store.apply(
            Source::Nodes,
            WatchEvent::Batch {
                upserts: rows(&[node("worker-2", json!({}))]),
                deletes: Vec::new(),
            },
        );
        store.apply(
            Source::Pods,
            WatchEvent::Batch {
                upserts: rows(&[running_pod("a", "x", "worker-2")]),
                deletes: Vec::new(),
            },
        );
        let moved = store.build();
        assert_eq!(groups(&moved), [(None, None, vec!["worker-1", "worker-2"])]);
        assert!(moved.regions[0].zones[0].nodes[0].pods.is_empty());
        assert_eq!(moved.regions[0].zones[0].nodes[1].pods.len(), 1);

        store.apply(
            Source::Pods,
            WatchEvent::Batch {
                upserts: Vec::new(),
                deletes: vec![ObjectKey {
                    namespace: Some("a".into()),
                    name: "x".into(),
                }],
            },
        );
        store.apply(
            Source::Nodes,
            WatchEvent::Batch {
                upserts: Vec::new(),
                deletes: vec![ObjectKey {
                    namespace: None,
                    name: "worker-1".into(),
                }],
            },
        );
        let after = store.build();
        assert_eq!(groups(&after), [(None, None, vec!["worker-2"])]);
        assert_eq!(after.pod_count, 0);
    }

    #[test]
    fn a_forbidden_or_missing_node_list_fails_and_pods_hide_instead() {
        let status = |status, message: Option<&str>| WatchEvent::Status {
            status,
            message: message.map(str::to_owned),
        };
        let mut store = Store::default();
        assert_eq!(
            store.apply(
                Source::Nodes,
                status(WatchStatus::Forbidden, Some("nodes is forbidden"))
            ),
            Some("Listing nodes is not allowed: nodes is forbidden".to_owned())
        );
        assert_eq!(
            store.apply(Source::Nodes, status(WatchStatus::Forbidden, None)),
            Some("Listing nodes is not allowed".to_owned())
        );
        assert_eq!(
            store.apply(Source::Nodes, status(WatchStatus::NotServed, None)),
            Some("the cluster no longer serves nodes".to_owned())
        );
        assert_eq!(
            store.apply(
                Source::Nodes,
                status(WatchStatus::Reconnecting, Some("watch failed"))
            ),
            None
        );

        store.apply(
            Source::Nodes,
            WatchEvent::Snapshot {
                items: rows(&[node("worker-1", json!({}))]),
            },
        );
        store.apply(
            Source::Pods,
            WatchEvent::Snapshot {
                items: rows(&[running_pod("a", "x", "worker-1")]),
            },
        );
        assert_eq!(
            store.apply(
                Source::Pods,
                status(WatchStatus::Forbidden, Some("pods is forbidden"))
            ),
            None
        );
        assert!(store.ready());
        let hidden = store.build();
        assert!(hidden.pods_hidden);
        assert!(hidden.regions[0].zones[0].nodes[0].pods.is_empty());
    }

    #[test]
    fn the_event_crosses_in_camel_case() {
        let snapshot = snapshot_of(
            &[node("worker-1", json!({}))],
            &[running_pod("a", "x", "worker-1")],
        );
        let value = serde_json::to_value(TopologyEvent::Snapshot { snapshot }).unwrap();
        assert_eq!(value["type"], "snapshot");
        assert_eq!(value["snapshot"]["nodeCount"], 1);
        assert_eq!(value["snapshot"]["podsHidden"], false);
        assert_eq!(value["snapshot"]["regions"][0]["name"], Value::Null);
        let node = &value["snapshot"]["regions"][0]["zones"][0]["nodes"][0];
        assert_eq!(
            node["allocatable"],
            json!({ "cpuMillis": 4000, "memoryBytes": 16 * GIB, "pods": 110 })
        );
        assert_eq!(
            node["requests"],
            json!({ "cpuMillis": 100, "memoryBytes": 64 * MIB, "pods": null })
        );
        assert_eq!(node["ready"], "Ready");
        assert_eq!(
            node["pods"][0],
            json!({ "namespace": "a", "name": "x", "state": "Running", "status": "Running" })
        );
        assert_eq!(
            serde_json::to_value(TopologyEvent::Failure {
                message: "boom".into()
            })
            .unwrap(),
            json!({ "type": "failure", "message": "boom" })
        );
    }
}
