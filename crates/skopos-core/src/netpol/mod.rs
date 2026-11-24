//! Network policies (spec §4, §7.1): label selectors and a model of NetworkPolicies,
//! CiliumNetworkPolicies and CiliumClusterwideNetworkPolicies, read from their JSON objects and
//! evaluated for the map and the Reachability page. Pure: no I/O, no kube client, no tokio.

pub(crate) mod eval;
pub(crate) mod group;
pub(crate) mod model;
mod parse;
pub(crate) mod pods;
mod selector;

pub(crate) use eval::Index;
pub(crate) use model::{
    Entity, HttpRule, NamespaceScope, Peer, Policy, PolicyId, PolicyRule, PolicySource, PortRule,
    PortValue, Protocol, Rule, Subject,
};
pub(crate) use parse::parse_policy;
pub(crate) use pods::{namespace_info, pod_info, NamespaceInfo, PodInfo};
pub(crate) use selector::LabelSelector;
