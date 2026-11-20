//! The node topology of a cluster (topology spec §4.1): its nodes grouped by region and zone,
//! each with its health, its pods' requests and its pods. One topology per cluster, read
//! through the watch hub.

mod build;
mod hub;
mod types;

pub(crate) use hub::TopologyHub;
pub use types::{
    NodeReady, PodState, TopologyAmounts, TopologyEvent, TopologyNode, TopologyPod, TopologyRegion,
    TopologySnapshot, TopologyTaint, TopologyZone,
};
