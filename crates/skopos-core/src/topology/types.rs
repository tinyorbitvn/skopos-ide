//! What the node topology sends to the interface (topology spec §4.1), camelCase on the wire.

use std::collections::BTreeMap;

use serde::Serialize;
use ts_rs::TS;

/// What a subscriber receives. A snapshot replaces everything it holds; a failure is the
/// subscription's last event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TopologyEvent {
    Snapshot {
        snapshot: TopologySnapshot,
    },
    /// As `GraphEvent::Failure`. A forbidden node list reads
    /// "Listing nodes is not allowed: <API server message>".
    Failure {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TopologySnapshot {
    pub regions: Vec<TopologyRegion>,
    pub node_count: u32,
    pub pod_count: u32,
    /// Pods could not be listed (forbidden or not served); nodes carry no pods.
    pub pods_hidden: bool,
}

/// `name: None` is "No region".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TopologyRegion {
    pub name: Option<String>,
    pub zones: Vec<TopologyZone>,
    pub node_count: u32,
    /// The pods bound to the region's nodes.
    pub pod_count: u32,
}

/// `name: None` is "No zone".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TopologyZone {
    pub name: Option<String>,
    pub nodes: Vec<TopologyNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TopologyNode {
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub roles: Vec<String>,
    pub ready: NodeReady,
    pub unschedulable: bool,
    pub taints: Vec<TopologyTaint>,
    /// Pressures and NetworkUnavailable while they are True, worst first. NotReady comes from
    /// `ready`.
    pub conditions: Vec<String>,
    pub allocatable: TopologyAmounts,
    /// The sum of the pods' requests; `pods` is always null, and CPU and memory are null while
    /// pods are hidden.
    pub requests: TopologyAmounts,
    pub pods: Vec<TopologyPod>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub enum NodeReady {
    Ready,
    NotReady,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TopologyTaint {
    pub key: String,
    pub value: Option<String>,
    pub effect: String,
}

/// Amounts of a node: millicores, bytes and a pod count. Null when unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TopologyAmounts {
    #[ts(type = "number | null")]
    pub cpu_millis: Option<u64>,
    #[ts(type = "number | null")]
    pub memory_bytes: Option<u64>,
    pub pods: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TopologyPod {
    pub namespace: String,
    pub name: String,
    pub state: PodState,
    /// The Pods table's Status text, such as "CrashLoopBackOff" or "Init:1/2".
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub enum PodState {
    Running,
    Pending,
    Failed,
    Succeeded,
    Unknown,
}
