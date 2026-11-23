//! Network policies (spec §4, §7.1): label selectors and a model of NetworkPolicies,
//! CiliumNetworkPolicies and CiliumClusterwideNetworkPolicies, read from their JSON objects and
//! evaluated for the map and the Reachability page. Pure: no I/O, no kube client, no tokio.

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod eval;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod group;
mod model;
mod parse;
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod pods;
mod selector;

#[allow(unused_imports)]
pub(crate) use eval::Index;
pub(crate) use model::{
    Entity, HttpRule, NamespaceScope, Peer, Policy, PolicyId, PolicyRule, PolicySource, PortRule,
    PortValue, Protocol, Rule, Subject,
};
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use parse::parse_policy;
#[allow(unused_imports)]
pub(crate) use pods::{namespace_info, pod_info, NamespaceInfo, PodInfo};
pub(crate) use selector::LabelSelector;
