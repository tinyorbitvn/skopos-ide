//! The reachability of a namespace's workloads (spec §3.2, §7.3): which may talk to which, by
//! port and HTTP rule, from the NetworkPolicies and Cilium policies that select their Pods.

mod build;
mod hub;
mod types;

pub(crate) use hub::ReachabilityHub;
pub use types::{
    NotEvaluated, PolicyRef, ReachCell, ReachCounts, ReachEvent, ReachGroup, ReachHttp,
    ReachMissing, ReachPeer, ReachPeerKind, ReachPolicySource, ReachPort, ReachProtocol, ReachSide,
    ReachVerdict,
};
