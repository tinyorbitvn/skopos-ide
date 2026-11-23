//! Network policies (spec §4, §7.1): label selectors and a model of NetworkPolicies,
//! CiliumNetworkPolicies and CiliumClusterwideNetworkPolicies, read from their JSON objects and
//! evaluated for the map and the Reachability page. Pure: no I/O, no kube client, no tokio.

mod model;
mod parse;
mod selector;

pub(crate) use model::{
    Entity, HttpRule, NamespaceScope, Peer, Policy, PolicyId, PolicyRule, PolicySource, PortRule,
    PortValue, Protocol, Rule, Subject,
};
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use parse::parse_policy;
pub(crate) use selector::LabelSelector;
