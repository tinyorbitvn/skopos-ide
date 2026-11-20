//! The node topology of a cluster (topology spec §4.1): its nodes grouped by region and zone,
//! each with its health, its pods' requests and its pods. Read through the watch hub.

#[cfg_attr(not(test), allow(dead_code))]
mod build;
mod types;

pub use types::{
    NodeReady, PodState, TopologyAmounts, TopologyEvent, TopologyNode, TopologyPod, TopologyRegion,
    TopologySnapshot, TopologyTaint, TopologyZone,
};
