//! The relationship graph of a cluster's resources (spec E §4): what owns, selects, routes to,
//! mounts, reads, runs as and claims what. One graph per cluster, read through the watch hub.

mod build;
mod extract;
mod hub;
mod kinds;
mod pod;
mod types;

pub(crate) use hub::GraphHub;
pub(crate) use pod::{is_init_progress, pod_summary};
pub use types::{GraphEdge, GraphEvent, GraphNamespaceCount, GraphNode, GraphRel, GraphStatus};

// The reachability hub reads the cluster through the graph's store (network policies spec
// §7.3).
#[allow(unused_imports)]
pub(crate) use build::Store;
#[allow(unused_imports)]
pub(crate) use extract::{Item, Netpol};
#[allow(unused_imports)]
pub(crate) use kinds::{served_kinds, Kind};
