//! What the reachability page receives (spec §7.3, contract C9), camelCase on the wire.

use serde::Serialize;
use ts_rs::TS;

/// What a subscriber receives. A snapshot replaces everything it holds; a failure is the
/// subscription's last event. `cells` holds only the cells the page cannot derive (R4).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ReachEvent {
    Snapshot {
        namespace: String,
        groups: Vec<ReachGroup>,
        peers: Vec<ReachPeer>,
        cells: Vec<ReachCell>,
        counts: ReachCounts,
        #[serde(rename = "notEvaluated")]
        not_evaluated: Vec<NotEvaluated>,
        missing: Vec<ReachMissing>,
        cilium: bool,
        truncated: u32,
    },
    Failure {
        message: String,
    },
}

/// A workload of the namespace (spec §5.1). `id` is the map's node id,
/// `<Kind>/<namespace>/<name>`; `labels` are the `key=value` pairs all its Pods share, by key.
/// A flag is true when any of its Pods is isolated in that direction.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReachGroup {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub pods: u32,
    pub labels: Vec<String>,
    pub policies: Vec<PolicyRef>,
    pub ingress_isolated: bool,
    pub egress_isolated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ReachPeerKind {
    Workload,
    Selector,
    Cidr,
    Entity,
    Fqdn,
    OtherPods,
    World,
}

/// A row or column outside the namespace's workloads (spec §5.2): a source when `source`, a
/// destination when `destination`. Ids, labels and details follow contract C9.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReachPeer {
    pub id: String,
    pub kind: ReachPeerKind,
    pub namespace: Option<String>,
    pub label: String,
    pub detail: String,
    pub source: bool,
    pub destination: bool,
    pub ingress_isolated: bool,
    pub egress_isolated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ReachVerdict {
    Allowed,
    Denied,
    Open,
    Blocked,
}

/// The verdict from a group or peer to another (R4). `somePods` when the Pods of either side
/// get different verdicts.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReachCell {
    pub from: String,
    pub to: String,
    pub verdict: ReachVerdict,
    pub ports: Vec<ReachPort>,
    pub policies: Vec<PolicyRef>,
    pub some_pods: bool,
}

/// `ANY` is TCP, UDP and SCTP.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "UPPERCASE")]
pub enum ReachProtocol {
    Tcp,
    Udp,
    Sctp,
    Any,
}

/// `port: null` is every port of the protocol; `name` is a named port that did not resolve.
/// `http` empty: every request.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReachPort {
    pub protocol: ReachProtocol,
    pub port: Option<u16>,
    pub end_port: Option<u16>,
    pub name: Option<String>,
    pub http: Vec<ReachHttp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ReachSide {
    Ingress,
    Egress,
}

/// One HTTP rule. `side` is set only when both sides limit L7 on the port; `headers` are
/// "name: value", or "name" alone.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReachHttp {
    pub side: Option<ReachSide>,
    pub method: Option<String>,
    pub path: Option<String>,
    pub host: Option<String>,
    pub headers: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ReachPolicySource {
    Kubernetes,
    Cilium,
    CiliumClusterwide,
}

/// A policy object. `namespace` is "" for a cluster-wide policy.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRef {
    pub source: ReachPolicySource,
    pub namespace: String,
    pub name: String,
}

/// The policies the bar counts (spec §3.2): the namespace's NetworkPolicies, and its
/// CiliumNetworkPolicies plus the CiliumClusterwideNetworkPolicies that select a Pod in it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReachCounts {
    pub kubernetes: u32,
    pub cilium: u32,
}

/// A field of a policy that is not evaluated (spec §4.6).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NotEvaluated {
    pub policy: PolicyRef,
    pub field: String,
}

/// A kind that could not be listed, by plural, and why (R5).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReachMissing {
    pub plural: String,
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn events_serialize_as_the_page_reads_them() {
        let policy = PolicyRef {
            source: ReachPolicySource::CiliumClusterwide,
            namespace: String::new(),
            name: "scrape".into(),
        };
        let event = ReachEvent::Snapshot {
            namespace: "payments".into(),
            groups: vec![ReachGroup {
                id: "Deployment/payments/api".into(),
                kind: "Deployment".into(),
                name: "api".into(),
                pods: 2,
                labels: vec!["app=api".into()],
                policies: vec![policy.clone()],
                ingress_isolated: true,
                egress_isolated: false,
            }],
            peers: vec![ReachPeer {
                id: "otherPods".into(),
                kind: ReachPeerKind::OtherPods,
                namespace: None,
                label: "Other Pods in the cluster".into(),
                detail: "Pods the rules above do not name".into(),
                source: true,
                destination: true,
                ingress_isolated: false,
                egress_isolated: false,
            }],
            cells: vec![ReachCell {
                from: "Deployment/payments/web".into(),
                to: "Deployment/payments/api".into(),
                verdict: ReachVerdict::Allowed,
                ports: vec![ReachPort {
                    protocol: ReachProtocol::Any,
                    port: Some(8000),
                    end_port: Some(8080),
                    name: None,
                    http: vec![ReachHttp {
                        side: Some(ReachSide::Ingress),
                        method: Some("GET".into()),
                        path: Some("/api/.*".into()),
                        host: None,
                        headers: vec!["X-Team: a".into()],
                    }],
                }],
                policies: vec![policy.clone()],
                some_pods: true,
            }],
            counts: ReachCounts {
                kubernetes: 6,
                cilium: 4,
            },
            not_evaluated: vec![NotEvaluated {
                policy,
                field: "rules.dns".into(),
            }],
            missing: vec![ReachMissing {
                plural: "ciliumnetworkpolicies".into(),
                reason: "listing is forbidden".into(),
            }],
            cilium: true,
            truncated: 3,
        };
        let scrape = json!({ "source": "ciliumClusterwide", "namespace": "", "name": "scrape" });
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "type": "snapshot",
                "namespace": "payments",
                "groups": [{
                    "id": "Deployment/payments/api", "kind": "Deployment", "name": "api", "pods": 2,
                    "labels": ["app=api"], "policies": [scrape],
                    "ingressIsolated": true, "egressIsolated": false,
                }],
                "peers": [{
                    "id": "otherPods", "kind": "otherPods", "namespace": null,
                    "label": "Other Pods in the cluster", "detail": "Pods the rules above do not name",
                    "source": true, "destination": true, "ingressIsolated": false, "egressIsolated": false,
                }],
                "cells": [{
                    "from": "Deployment/payments/web", "to": "Deployment/payments/api", "verdict": "allowed",
                    "ports": [{
                        "protocol": "ANY", "port": 8000, "endPort": 8080, "name": null,
                        "http": [{
                            "side": "ingress", "method": "GET", "path": "/api/.*", "host": null,
                            "headers": ["X-Team: a"],
                        }],
                    }],
                    "policies": [scrape],
                    "somePods": true,
                }],
                "counts": { "kubernetes": 6, "cilium": 4 },
                "notEvaluated": [{ "policy": scrape, "field": "rules.dns" }],
                "missing": [{ "plural": "ciliumnetworkpolicies", "reason": "listing is forbidden" }],
                "cilium": true,
                "truncated": 3,
            })
        );
        let failure = ReachEvent::Failure {
            message: "Pods cannot be listed: listing is forbidden".into(),
        };
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            json!({ "type": "failure", "message": "Pods cannot be listed: listing is forbidden" })
        );
        let protocols: Vec<_> = [ReachProtocol::Tcp, ReachProtocol::Udp, ReachProtocol::Sctp]
            .iter()
            .map(|protocol| serde_json::to_value(protocol).unwrap())
            .collect();
        assert_eq!(protocols, [json!("TCP"), json!("UDP"), json!("SCTP")]);
        let kinds: Vec<_> = [
            ReachPeerKind::Workload,
            ReachPeerKind::Fqdn,
            ReachPeerKind::World,
        ]
        .iter()
        .map(|kind| serde_json::to_value(kind).unwrap())
        .collect();
        assert_eq!(kinds, [json!("workload"), json!("fqdn"), json!("world")]);
        let verdicts: Vec<_> = [
            ReachVerdict::Denied,
            ReachVerdict::Open,
            ReachVerdict::Blocked,
        ]
        .iter()
        .map(|verdict| serde_json::to_value(verdict).unwrap())
        .collect();
        assert_eq!(verdicts, [json!("denied"), json!("open"), json!("blocked")]);
    }
}
