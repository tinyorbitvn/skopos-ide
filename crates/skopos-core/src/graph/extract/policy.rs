//! NetworkPolicies, CiliumNetworkPolicies and CiliumClusterwideNetworkPolicies (network
//! policies spec §3.3). Each keeps its parsed policy on the item, which the builder evaluates
//! for its `selects` edges; its facts say what the policy holds. A policy is `neutral`, and a
//! host policy says so in its status text.

use serde_json::Value;

use super::{Item, Netpol};
use crate::netpol::{parse_policy, Policy, PolicySource};

/// The "Source" fact of each kind of policy.
fn source_text(source: PolicySource) -> &'static str {
    match source {
        PolicySource::Kubernetes => "Kubernetes",
        PolicySource::Cilium => "Cilium",
        PolicySource::CiliumClusterwide => "Cilium cluster-wide",
    }
}

pub(super) fn policy(item: &mut Item, object: &Value, source: PolicySource) {
    item.fact("Source", source_text(source));
    let Some(policy) = parse_policy(source, object) else {
        return;
    };
    facts(item, &policy);
    if policy.is_host() {
        item.status_text = Some("Host policy".to_owned());
    }
    item.netpol = Netpol::Policy(policy);
}

/// Spec §3.3, in its order: the selector ("All Pods" when empty; none for a host policy), the
/// types, the allow rules of each direction, the deny rules when any and the fields not
/// evaluated when any.
fn facts(item: &mut Item, policy: &Policy) {
    let selector = policy.selector_text();
    if !selector.is_empty() {
        item.fact("Selector", selector);
    }
    let types = policy.types();
    if !types.is_empty() {
        item.fact("Types", types.join(", "));
    }
    let ingress: usize = policy.rules.iter().map(|rule| rule.ingress.len()).sum();
    let egress: usize = policy.rules.iter().map(|rule| rule.egress.len()).sum();
    let deny: usize = policy
        .rules
        .iter()
        .map(|rule| rule.ingress_deny.len() + rule.egress_deny.len())
        .sum();
    item.fact("Ingress rules", ingress.to_string());
    item.fact("Egress rules", egress.to_string());
    if deny > 0 {
        item.fact("Deny rules", deny.to_string());
    }
    if !policy.notes.is_empty() {
        item.fact("Not evaluated", policy.notes.join(", "));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::graph::extract::test_support::{facts, item};
    use crate::graph::extract::Netpol;
    use crate::graph::kinds::Kind;
    use crate::graph::types::GraphStatus;
    use crate::netpol::{parse_policy, PolicySource};

    #[test]
    fn a_network_policy_has_its_source_selector_types_and_rule_counts() {
        let object = json!({
            "metadata": { "name": "allow-web", "namespace": "a" },
            "spec": {
                "podSelector": { "matchLabels": { "app": "web" } },
                "policyTypes": ["Ingress", "Egress"],
                "ingress": [
                    { "from": [{ "podSelector": { "matchLabels": { "app": "api" } } }], "ports": [{ "port": 8080 }] },
                    { "from": [{ "ipBlock": { "cidr": "10.0.0.0/8" } }] },
                ],
                "egress": [{ "to": [{ "namespaceSelector": {} }] }],
            },
        });
        let policy = item(Kind::NetworkPolicy, object.clone());
        assert_eq!(policy.id(), "NetworkPolicy/a/allow-web");
        assert_eq!(
            (policy.status, policy.status_text.as_deref()),
            (GraphStatus::Neutral, None)
        );
        assert_eq!(
            facts(&policy),
            [
                ("Source", "Kubernetes"),
                ("Selector", "app=web"),
                ("Types", "Ingress, Egress"),
                ("Ingress rules", "2"),
                ("Egress rules", "1"),
            ]
        );
        assert_eq!(
            policy.netpol,
            Netpol::Policy(parse_policy(PolicySource::Kubernetes, &object).unwrap())
        );
        assert!(policy.refs.is_empty(), "rule peers are not drawn");

        let deny_all = item(
            Kind::NetworkPolicy,
            json!({
                "metadata": { "name": "default-deny", "namespace": "a" },
                "spec": { "podSelector": {}, "policyTypes": ["Ingress"] },
            }),
        );
        assert_eq!(
            facts(&deny_all),
            [
                ("Source", "Kubernetes"),
                ("Selector", "All Pods"),
                ("Types", "Ingress"),
                ("Ingress rules", "0"),
                ("Egress rules", "0"),
            ]
        );
    }

    #[test]
    fn a_cilium_policy_adds_its_deny_rules_and_what_is_not_evaluated() {
        let object = json!({
            "metadata": { "name": "api", "namespace": "a" },
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "api", "k8s:io.kubernetes.pod.namespace": "a" } },
                "ingress": [{
                    "fromEndpoints": [{ "matchLabels": { "app": "web" } }],
                    "toPorts": [{
                        "ports": [{ "port": "8080", "protocol": "TCP" }],
                        "rules": { "http": [{ "method": "GET", "path": "/api/.*" }] },
                    }],
                }],
                "egress": [
                    {
                        "toFQDNs": [{ "matchName": "api.stripe.com" }],
                        "toPorts": [{ "ports": [{ "port": "443", "protocol": "TCP" }] }],
                    },
                    {
                        "toEndpoints": [{ "matchLabels": {
                            "k8s:io.kubernetes.pod.namespace": "kube-system",
                            "k8s-app": "kube-dns",
                        } }],
                        "toPorts": [{
                            "ports": [{ "port": "53", "protocol": "UDP" }],
                            "rules": { "dns": [{ "matchPattern": "*" }] },
                        }],
                    },
                ],
                "egressDeny": [{ "toEntities": ["world"] }],
            },
        });
        let policy = item(Kind::CiliumNetworkPolicy, object.clone());
        assert_eq!(policy.id(), "CiliumNetworkPolicy/a/api");
        assert_eq!(
            (policy.status, policy.status_text.as_deref()),
            (GraphStatus::Neutral, None)
        );
        assert_eq!(
            facts(&policy),
            [
                ("Source", "Cilium"),
                ("Selector", "app=api, io.kubernetes.pod.namespace=a"),
                ("Types", "Ingress, Egress"),
                ("Ingress rules", "1"),
                ("Egress rules", "2"),
                ("Deny rules", "1"),
                ("Not evaluated", "rules.dns"),
            ]
        );
        assert_eq!(
            policy.netpol,
            Netpol::Policy(parse_policy(PolicySource::Cilium, &object).unwrap())
        );
    }

    #[test]
    fn a_cluster_wide_policy_has_no_namespace() {
        let policy = item(
            Kind::CiliumClusterwideNetworkPolicy,
            json!({
                "metadata": { "name": "scrape", "namespace": "ignored" },
                "spec": {
                    "endpointSelector": { "matchLabels": { "app": "web" } },
                    "ingress": [{
                        "fromEndpoints": [{ "matchLabels": {
                            "k8s:io.kubernetes.pod.namespace": "monitoring",
                            "app": "prometheus",
                        } }],
                        "toPorts": [{ "ports": [{ "port": "9090", "protocol": "TCP" }] }],
                    }],
                },
            }),
        );
        assert_eq!(policy.id(), "CiliumClusterwideNetworkPolicy//scrape");
        assert_eq!(
            facts(&policy),
            [
                ("Source", "Cilium cluster-wide"),
                ("Selector", "app=web"),
                ("Types", "Ingress"),
                ("Ingress rules", "1"),
                ("Egress rules", "0"),
            ]
        );
    }

    #[test]
    fn a_host_policy_says_so_and_names_no_selector() {
        let policy = item(
            Kind::CiliumClusterwideNetworkPolicy,
            json!({
                "metadata": { "name": "nodes" },
                "spec": {
                    "nodeSelector": { "matchLabels": { "role": "worker" } },
                    "ingress": [{ "fromEntities": ["cluster"] }],
                },
            }),
        );
        assert_eq!(
            (policy.status, policy.status_text.as_deref()),
            (GraphStatus::Neutral, Some("Host policy"))
        );
        let facts = facts(&policy);
        assert_eq!(facts[0], ("Source", "Cilium cluster-wide"));
        assert!(
            facts.contains(&("Not evaluated", "nodeSelector")),
            "{facts:?}"
        );
        assert!(
            !facts.iter().any(|(label, _)| *label == "Selector"),
            "{facts:?}"
        );
        assert!(matches!(&policy.netpol, Netpol::Policy(p) if p.is_host()));
    }
}
