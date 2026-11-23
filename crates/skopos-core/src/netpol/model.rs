//! The policy model (spec §4, §7.1, plan R1): one `Policy` per NetworkPolicy or Cilium object,
//! with a `PolicyRule` for each rule it holds (a NetworkPolicy has one, a Cilium object one per
//! `spec` and `specs` entry). Each rule has its subject, its four sections and its isolation.

use super::selector::LabelSelector;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum PolicySource {
    Kubernetes,
    Cilium,
    CiliumClusterwide,
}

/// `namespace` is "" for a cluster-wide policy.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct PolicyId {
    pub source: PolicySource,
    pub namespace: String,
    pub name: String,
}

/// `Any` is Cilium's `ANY` (TCP, UDP and SCTP).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Protocol {
    Tcp,
    Udp,
    Sctp,
    Any,
}

/// A port as a policy writes it: a number, or the name of a container port.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum PortValue {
    Number(u16),
    Name(String),
}

/// One `rules.http` entry. `headers` are "name: value", or "name" alone.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct HttpRule {
    pub method: Option<String>,
    pub path: Option<String>,
    pub host: Option<String>,
    pub headers: Vec<String>,
}

/// `port: None` is every port of `protocol`. `http` empty: no L7 limit on this port.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PortRule {
    pub protocol: Protocol,
    pub port: Option<PortValue>,
    pub end_port: Option<u16>,
    pub http: Vec<HttpRule>,
}

/// A Cilium entity (spec §4.4).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Entity {
    All,
    Cluster,
    World,
    Host,
    RemoteNode,
    KubeApiserver,
    Health,
    Init,
    Unmanaged,
    Ingress,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Entity {
    const EVERY: [Entity; 10] = [
        Entity::All,
        Entity::Cluster,
        Entity::World,
        Entity::Host,
        Entity::RemoteNode,
        Entity::KubeApiserver,
        Entity::Health,
        Entity::Init,
        Entity::Unmanaged,
        Entity::Ingress,
    ];

    /// Cilium's spelling: "all", "cluster", "world", "host", "remote-node", "kube-apiserver",
    /// "health", "init", "unmanaged", "ingress". Anything else is `None`.
    pub(crate) fn parse(text: &str) -> Option<Entity> {
        Self::EVERY.into_iter().find(|entity| entity.name() == text)
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Entity::All => "all",
            Entity::Cluster => "cluster",
            Entity::World => "world",
            Entity::Host => "host",
            Entity::RemoteNode => "remote-node",
            Entity::KubeApiserver => "kube-apiserver",
            Entity::Health => "health",
            Entity::Init => "init",
            Entity::Unmanaged => "unmanaged",
            Entity::Ingress => "ingress",
        }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NamespaceScope {
    /// Only this namespace: a NetworkPolicy peer with a `podSelector` alone.
    Only(String),
    /// Namespaces whose labels match: a NetworkPolicy `namespaceSelector`.
    Selected(LabelSelector),
    /// Every namespace: Cilium selectors, which carry their namespace as a label (R2).
    Any,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Peer {
    /// Pods in `namespaces` whose labels match `pods`. With `cilium`, `pods` is matched against
    /// the Pod's Cilium labels (`PodInfo::cilium_labels`), else its own labels.
    Pods {
        namespaces: NamespaceScope,
        pods: LabelSelector,
        cilium: bool,
    },
    /// Addresses outside the cluster. Never matches a Pod.
    Cidr {
        cidr: String,
        except: Vec<String>,
    },
    Entity(Entity),
    /// `toFQDNs`: `matchName` or `matchPattern`, as written.
    Fqdn {
        name: Option<String>,
        pattern: Option<String>,
    },
}

/// `peers` empty: every peer. `ports` empty: every port and protocol.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rule {
    pub peers: Vec<Peer>,
    pub ports: Vec<PortRule>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Subject {
    /// The Pods matching `selector` in `namespace`, or in every namespace when `None`.
    Pods {
        namespace: Option<String>,
        selector: LabelSelector,
        cilium: bool,
    },
    /// A Cilium host policy (`nodeSelector`): selects no Pod and isolates none.
    Host,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolicyRule {
    pub subject: Subject,
    pub ingress: Vec<Rule>,
    pub egress: Vec<Rule>,
    pub ingress_deny: Vec<Rule>,
    pub egress_deny: Vec<Rule>,
    pub isolates_ingress: bool,
    pub isolates_egress: bool,
}

/// One policy object. `notes` are the fields not evaluated (spec §4.6), unique, in the order
/// found: "toServices", "toGroups", "toRequires", "fromRequires", "icmps", "rules.dns",
/// "rules.kafka", "rules.l7proto", "authentication", "nodeSelector", "label source <source>",
/// "operator <operator>"; and, for the other Cilium fields spec §13 leaves unevaluated,
/// "fromGroups", "fromNodes", "toNodes", "cidrGroupRef", "cidrGroupSelector",
/// "entity <name>" and "protocol <protocol>".
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Policy {
    pub id: PolicyId,
    pub rules: Vec<PolicyRule>,
    pub notes: Vec<String>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Policy {
    /// At least one rule, and every rule is `Subject::Host`.
    pub(crate) fn is_host(&self) -> bool {
        !self.rules.is_empty()
            && self
                .rules
                .iter()
                .all(|rule| matches!(rule.subject, Subject::Host))
    }

    /// Each Pod rule's selector text (`LabelSelector::text`), unique, joined with "; ".
    pub(crate) fn selector_text(&self) -> String {
        let mut texts = Vec::new();
        for rule in &self.rules {
            if let Subject::Pods { selector, .. } = &rule.subject {
                push_unique(&mut texts, selector.text());
            }
        }
        texts.join("; ")
    }

    /// "Ingress" when a rule isolates ingress or has `ingress`/`ingress_deny` rules, then
    /// "Egress" likewise.
    pub(crate) fn types(&self) -> Vec<&'static str> {
        let ingress = self.rules.iter().any(|rule| {
            rule.isolates_ingress || !rule.ingress.is_empty() || !rule.ingress_deny.is_empty()
        });
        let egress = self.rules.iter().any(|rule| {
            rule.isolates_egress || !rule.egress.is_empty() || !rule.egress_deny.is_empty()
        });
        let mut types = Vec::new();
        if ingress {
            types.push("Ingress");
        }
        if egress {
            types.push("Egress");
        }
        types
    }
}

/// Adds `item` unless it is there already, so notes, peers and texts keep the order they were
/// found in, once each.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn push_unique<T: PartialEq>(items: &mut Vec<T>, item: T) {
    if !items.contains(&item) {
        items.push(item);
    }
}

#[cfg(test)]
mod tests {
    // Through `netpol`'s re-exports, so that a build with tests uses each of them.
    use crate::netpol::{
        Entity, HttpRule, LabelSelector, NamespaceScope, Peer, Policy, PolicyId, PolicyRule,
        PolicySource, PortRule, PortValue, Protocol, Rule, Subject,
    };

    fn selector(key: &str, value: &str) -> LabelSelector {
        LabelSelector::default().with_label(key, value)
    }

    fn pods(selector: LabelSelector) -> Subject {
        Subject::Pods {
            namespace: Some("payments".to_owned()),
            selector,
            cilium: false,
        }
    }

    fn rule(subject: Subject) -> PolicyRule {
        PolicyRule {
            subject,
            ingress: Vec::new(),
            egress: Vec::new(),
            ingress_deny: Vec::new(),
            egress_deny: Vec::new(),
            isolates_ingress: false,
            isolates_egress: false,
        }
    }

    fn policy(rules: Vec<PolicyRule>) -> Policy {
        Policy {
            id: PolicyId {
                source: PolicySource::Cilium,
                namespace: "payments".to_owned(),
                name: "p".to_owned(),
            },
            rules,
            notes: Vec::new(),
        }
    }

    /// A rule with every form of peer and port.
    fn every_form() -> Rule {
        Rule {
            peers: vec![
                Peer::Pods {
                    namespaces: NamespaceScope::Only("payments".to_owned()),
                    pods: selector("app", "web"),
                    cilium: false,
                },
                Peer::Pods {
                    namespaces: NamespaceScope::Selected(selector("team", "a")),
                    pods: LabelSelector::default(),
                    cilium: false,
                },
                Peer::Pods {
                    namespaces: NamespaceScope::Any,
                    pods: selector("io.kubernetes.pod.namespace", "payments"),
                    cilium: true,
                },
                Peer::Cidr {
                    cidr: "10.0.0.0/8".to_owned(),
                    except: vec!["10.1.0.0/16".to_owned()],
                },
                Peer::Entity(Entity::World),
                Peer::Fqdn {
                    name: Some("api.stripe.com".to_owned()),
                    pattern: None,
                },
            ],
            ports: vec![
                PortRule {
                    protocol: Protocol::Tcp,
                    port: Some(PortValue::Number(8000)),
                    end_port: Some(8080),
                    http: vec![HttpRule {
                        method: Some("GET".to_owned()),
                        path: Some("/api/.*".to_owned()),
                        host: None,
                        headers: vec!["X-Team: a".to_owned()],
                    }],
                },
                PortRule {
                    protocol: Protocol::Udp,
                    port: Some(PortValue::Name("dns".to_owned())),
                    end_port: None,
                    http: Vec::new(),
                },
                PortRule {
                    protocol: Protocol::Sctp,
                    port: None,
                    end_port: None,
                    http: Vec::new(),
                },
                PortRule {
                    protocol: Protocol::Any,
                    port: None,
                    end_port: None,
                    http: Vec::new(),
                },
            ],
        }
    }

    #[test]
    fn entities_parse_and_name_in_cilium_spelling() {
        let names = [
            "all",
            "cluster",
            "world",
            "host",
            "remote-node",
            "kube-apiserver",
            "health",
            "init",
            "unmanaged",
            "ingress",
        ];
        for name in names {
            let entity = Entity::parse(name).expect("a Cilium entity");
            assert_eq!(entity.name(), name);
        }
        assert_eq!(Entity::parse("remote-node"), Some(Entity::RemoteNode));
        assert_eq!(Entity::parse("kube-apiserver"), Some(Entity::KubeApiserver));
        for unknown in ["", "World", "world-ipv4", "cluster-mesh", "reserved:host"] {
            assert_eq!(Entity::parse(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn policy_ids_sort_by_source_then_namespace_then_name() {
        let id = |source, namespace: &str, name: &str| PolicyId {
            source,
            namespace: namespace.to_owned(),
            name: name.to_owned(),
        };
        let mut ids = [
            id(PolicySource::CiliumClusterwide, "", "scrape"),
            id(PolicySource::Cilium, "payments", "allow-api"),
            id(PolicySource::Kubernetes, "payments", "default-deny"),
            id(PolicySource::Kubernetes, "billing", "z"),
            id(PolicySource::Kubernetes, "payments", "allow-dns"),
        ];
        ids.sort();
        let names: Vec<&str> = ids.iter().map(|id| id.name.as_str()).collect();
        assert_eq!(
            names,
            ["z", "allow-dns", "default-deny", "allow-api", "scrape"]
        );
    }

    #[test]
    fn a_policy_tells_its_types_from_isolation_and_sections() {
        assert!(policy(vec![rule(pods(LabelSelector::default()))])
            .types()
            .is_empty());

        let mut isolates_ingress = rule(pods(LabelSelector::default()));
        isolates_ingress.isolates_ingress = true;
        assert_eq!(policy(vec![isolates_ingress.clone()]).types(), ["Ingress"]);

        let mut egress_rules = rule(pods(LabelSelector::default()));
        egress_rules.egress = vec![every_form()];
        assert_eq!(policy(vec![egress_rules]).types(), ["Egress"]);

        let mut deny_only = rule(pods(LabelSelector::default()));
        deny_only.egress_deny = vec![every_form()];
        let mut ingress_deny = rule(pods(LabelSelector::default()));
        ingress_deny.ingress_deny = vec![every_form()];
        assert_eq!(
            policy(vec![deny_only, ingress_deny]).types(),
            ["Ingress", "Egress"]
        );

        let mut both = isolates_ingress;
        both.isolates_egress = true;
        assert_eq!(policy(vec![both]).types(), ["Ingress", "Egress"]);
    }

    #[test]
    fn a_policy_joins_the_selectors_of_its_pod_rules() {
        let web = rule(pods(selector("app", "web")));
        let api = rule(pods(selector("app", "api").with_label("tier", "backend")));
        let everything = rule(pods(LabelSelector::default()));
        let host = rule(Subject::Host);
        let joined = policy(vec![web.clone(), api, web, host, everything]);
        assert_eq!(
            joined.selector_text(),
            "app=web; app=api, tier=backend; All Pods"
        );
        assert_eq!(policy(vec![rule(Subject::Host)]).selector_text(), "");
    }

    #[test]
    fn a_host_policy_has_only_host_rules() {
        assert!(policy(vec![rule(Subject::Host), rule(Subject::Host)]).is_host());
        assert!(!policy(vec![
            rule(Subject::Host),
            rule(pods(LabelSelector::default()))
        ])
        .is_host());
        assert!(!policy(Vec::new()).is_host(), "a policy with no rule");
    }
}
