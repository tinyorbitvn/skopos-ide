//! NetworkPolicies, CiliumNetworkPolicies and CiliumClusterwideNetworkPolicies read into the
//! policy model (spec §4.2, §4.3, §4.6, plan R1 to R3). Values are read leniently: a field of
//! another type than expected counts as absent, and nothing here panics. A peer or port list
//! that is given but holds nothing that can be evaluated never reads as "every peer" or "every
//! port": its rule or entry is dropped, keeping its notes (R3).

use serde_json::Value;

use super::model::push_unique;
use super::{
    Entity, HttpRule, LabelSelector, NamespaceScope, Peer, Policy, PolicyId, PolicyRule,
    PolicySource, PortRule, PortValue, Protocol, Rule, Subject,
};

/// The virtual label that carries a Pod's namespace in Cilium selectors (spec §4.1).
#[cfg_attr(not(test), allow(dead_code))]
const NAMESPACE_LABEL: &str = "io.kubernetes.pod.namespace";

/// The peer fields of a Cilium entry in one direction (spec §4.3).
#[cfg_attr(not(test), allow(dead_code))]
struct PeerFields {
    endpoints: &'static str,
    cidr: &'static str,
    cidr_set: &'static str,
    entities: &'static str,
    fqdns: Option<&'static str>,
    /// Peer fields that are not evaluated (spec §4.6). Each adds its note.
    unevaluated: &'static [&'static str],
}

#[cfg_attr(not(test), allow(dead_code))]
const FROM: PeerFields = PeerFields {
    endpoints: "fromEndpoints",
    cidr: "fromCIDR",
    cidr_set: "fromCIDRSet",
    entities: "fromEntities",
    fqdns: None,
    unevaluated: &["fromRequires", "fromGroups", "fromNodes"],
};

#[cfg_attr(not(test), allow(dead_code))]
const TO: PeerFields = PeerFields {
    endpoints: "toEndpoints",
    cidr: "toCIDR",
    cidr_set: "toCIDRSet",
    entities: "toEntities",
    fqdns: Some("toFQDNs"),
    unevaluated: &["toServices", "toGroups", "toRequires", "toNodes"],
};

/// A NetworkPolicy (`Kubernetes`), CiliumNetworkPolicy (`Cilium`) or
/// CiliumClusterwideNetworkPolicy (`CiliumClusterwide`) object. `None` only when it has no
/// `metadata.name`. Never panics.
pub(crate) fn parse_policy(source: PolicySource, object: &Value) -> Option<Policy> {
    let metadata = &object["metadata"];
    let name = text(metadata, "name")?;
    let namespace = match source {
        PolicySource::CiliumClusterwide => String::new(),
        PolicySource::Kubernetes | PolicySource::Cilium => {
            text(metadata, "namespace").unwrap_or_default()
        }
    };
    let mut reader = Reader {
        namespace: &namespace,
        cluster_wide: source == PolicySource::CiliumClusterwide,
        notes: Vec::new(),
    };
    let rules = match source {
        PolicySource::Kubernetes => vec![reader.network_policy(&object["spec"])],
        PolicySource::Cilium | PolicySource::CiliumClusterwide => std::iter::once(&object["spec"])
            .chain(list(&object["specs"]))
            .filter(|spec| spec.is_object())
            .filter_map(|spec| reader.cilium_rule(spec))
            .collect(),
    };
    let notes = reader.notes;
    Some(Policy {
        id: PolicyId {
            source,
            namespace,
            name,
        },
        rules,
        notes,
    })
}

/// Reads the rules of one policy object and collects its notes.
#[cfg_attr(not(test), allow(dead_code))]
struct Reader<'a> {
    /// The policy's namespace; "" for a cluster-wide policy.
    namespace: &'a str,
    cluster_wide: bool,
    notes: Vec<String>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Reader<'_> {
    fn note(&mut self, note: impl Into<String>) {
        push_unique(&mut self.notes, note.into());
    }

    /// A NetworkPolicy's spec (spec §4.2): one rule. Without `policyTypes` it has the API
    /// server's default: Ingress always, Egress when `egress` holds a rule. The rules of a
    /// direction it does not have are left out, as Kubernetes ignores them.
    fn network_policy(&mut self, spec: &Value) -> PolicyRule {
        let selector = LabelSelector::parse(&spec["podSelector"], &mut self.notes);
        let types = list(&spec["policyTypes"]);
        let (ingress, egress) = if types.is_empty() {
            (true, !list(&spec["egress"]).is_empty())
        } else {
            (
                types.iter().any(|kind| kind == "Ingress"),
                types.iter().any(|kind| kind == "Egress"),
            )
        };
        PolicyRule {
            subject: Subject::Pods {
                namespace: Some(self.namespace.to_owned()),
                selector,
                cilium: false,
            },
            ingress: if ingress {
                self.network_rules(&spec["ingress"], "from")
            } else {
                Vec::new()
            },
            egress: if egress {
                self.network_rules(&spec["egress"], "to")
            } else {
                Vec::new()
            },
            ingress_deny: Vec::new(),
            egress_deny: Vec::new(),
            isolates_ingress: ingress,
            isolates_egress: egress,
        }
    }

    fn network_rules(&mut self, rules: &Value, peers: &str) -> Vec<Rule> {
        list(rules)
            .iter()
            .filter_map(|rule| self.network_rule(rule, peers))
            .collect()
    }

    /// One `ingress` or `egress` rule: no `from` (`to`) is every peer, no `ports` every port
    /// and protocol (spec §4.2). A list that is given but yields nothing drops the rule.
    fn network_rule(&mut self, rule: &Value, peers_field: &str) -> Option<Rule> {
        if !rule.is_object() {
            return None;
        }
        let given = list(&rule[peers_field]);
        let peers: Vec<Peer> = given
            .iter()
            .filter_map(|peer| self.network_peer(peer))
            .collect();
        if !given.is_empty() && peers.is_empty() {
            return None;
        }
        let given = list(&rule["ports"]);
        let ports: Vec<PortRule> = given
            .iter()
            .filter_map(|port| self.port(port, Protocol::Tcp))
            .collect();
        if !given.is_empty() && ports.is_empty() {
            return None;
        }
        Some(Rule { peers, ports })
    }

    /// A NetworkPolicy peer (spec §4.2): `podSelector` alone selects in the policy's namespace,
    /// `namespaceSelector` every Pod of the namespaces it matches, both the matching Pods
    /// there; `ipBlock` is a CIDR. `None` when it names nothing readable or a selector selects
    /// nothing.
    fn network_peer(&mut self, peer: &Value) -> Option<Peer> {
        if let Some(block) = peer.get("ipBlock").filter(|block| block.is_object()) {
            return Some(Peer::Cidr {
                cidr: text(block, "cidr")?,
                except: strings(&block["except"]),
            });
        }
        let pods = peer
            .get("podSelector")
            .filter(|selector| selector.is_object())
            .map(|selector| LabelSelector::parse(selector, &mut self.notes));
        let namespaces = peer
            .get("namespaceSelector")
            .filter(|selector| selector.is_object())
            .map(|selector| LabelSelector::parse(selector, &mut self.notes));
        let (namespaces, pods) = match (namespaces, pods) {
            (None, None) => return None,
            (None, Some(pods)) => (NamespaceScope::Only(self.namespace.to_owned()), pods),
            (Some(namespaces), pods) => {
                if namespaces.matches_nothing {
                    return None;
                }
                (
                    NamespaceScope::Selected(namespaces),
                    pods.unwrap_or_default(),
                )
            }
        };
        if pods.matches_nothing {
            return None;
        }
        Some(Peer::Pods {
            namespaces,
            pods,
            cilium: false,
        })
    }

    /// One port: `protocol` (`default` when absent or empty), `port` as a number, a string of
    /// digits (Cilium writes ports as strings) or a name, absent or 0 for every port, and
    /// `endPort` when it is above a numeric `port`. `None` when the port cannot be read or the
    /// protocol is not TCP, UDP, SCTP or ANY (adding "protocol <protocol>").
    fn port(&mut self, port: &Value, default: Protocol) -> Option<PortRule> {
        if !port.is_object() {
            return None;
        }
        let protocol = match port["protocol"].as_str() {
            None | Some("") => default,
            Some("TCP") => Protocol::Tcp,
            Some("UDP") => Protocol::Udp,
            Some("SCTP") => Protocol::Sctp,
            Some("ANY") => Protocol::Any,
            Some(other) => {
                self.note(format!("protocol {other}"));
                return None;
            }
        };
        let value = port_value(&port["port"])?;
        let end_port = match value {
            Some(PortValue::Number(start)) => whole_number(&port["endPort"])
                .and_then(|end| u16::try_from(end).ok())
                .filter(|end| *end > start),
            _ => None,
        };
        Some(PortRule {
            protocol,
            port: value,
            end_port,
            http: Vec::new(),
        })
    }

    /// One Cilium rule, `spec` or an entry of `specs` (spec §4.3). `nodeSelector` makes a host
    /// rule; otherwise `endpointSelector` selects the Pods, in the policy's namespace for a
    /// CiliumNetworkPolicy (R2). `None` when it has neither selector.
    fn cilium_rule(&mut self, rule: &Value) -> Option<PolicyRule> {
        let subject = if rule["nodeSelector"].is_object() {
            self.note("nodeSelector");
            Subject::Host
        } else {
            let selector = rule.get("endpointSelector").filter(|s| s.is_object())?;
            let (selector, entities) = LabelSelector::parse_cilium(selector, &mut self.notes);
            let mut selector = self.in_namespace(selector);
            // A selector of reserved labels selects an entity, never a Pod.
            selector.matches_nothing |= !entities.is_empty();
            Subject::Pods {
                namespace: (!self.cluster_wide).then(|| self.namespace.to_owned()),
                selector,
                cilium: true,
            }
        };
        // A section, even empty, isolates its direction unless `enableDefaultDeny` turns that
        // off. A host rule never isolates a Pod.
        let host = subject == Subject::Host;
        let isolates = |allow: &str, deny: &str, direction: &str| {
            !host
                && (rule[allow].is_array() || rule[deny].is_array())
                && rule["enableDefaultDeny"][direction].as_bool() != Some(false)
        };
        let isolates_ingress = isolates("ingress", "ingressDeny", "ingress");
        let isolates_egress = isolates("egress", "egressDeny", "egress");
        Some(PolicyRule {
            subject,
            ingress: self.cilium_section(&rule["ingress"], &FROM),
            egress: self.cilium_section(&rule["egress"], &TO),
            ingress_deny: self.cilium_section(&rule["ingressDeny"], &FROM),
            egress_deny: self.cilium_section(&rule["egressDeny"], &TO),
            isolates_ingress,
            isolates_egress,
        })
    }

    /// R2: in a CiliumNetworkPolicy a selector without a requirement on the namespace label
    /// selects in the policy's namespace. A cluster-wide policy's selectors stay as written.
    fn in_namespace(&self, selector: LabelSelector) -> LabelSelector {
        if self.cluster_wide || selector.constrains(NAMESPACE_LABEL) {
            selector
        } else {
            selector.with_label(NAMESPACE_LABEL, self.namespace)
        }
    }

    fn cilium_section(&mut self, section: &Value, fields: &PeerFields) -> Vec<Rule> {
        list(section)
            .iter()
            .filter_map(|entry| self.cilium_entry(entry, fields))
            .collect()
    }

    /// One entry of a Cilium section (spec §4.3). Its peer fields add up; with `toPorts` and
    /// no peer field it allows every peer on those ports. It is dropped, keeping its notes,
    /// when its peer fields give no peer that can be evaluated, when `toPorts` gives no port
    /// that can be read, when it has `icmps` and no `toPorts` (R3), and when it has neither a
    /// peer field nor `toPorts`: Cilium's `- {}` allows nothing.
    fn cilium_entry(&mut self, entry: &Value, fields: &PeerFields) -> Option<Rule> {
        if !entry.is_object() {
            return None;
        }
        let named = [
            fields.endpoints,
            fields.cidr,
            fields.cidr_set,
            fields.entities,
        ]
        .iter()
        .chain(fields.fqdns.iter())
        .chain(fields.unevaluated)
        .any(|field| entry[*field].is_array());
        let mut peers = Vec::new();
        for selector in list(&entry[fields.endpoints]) {
            if !selector.is_object() {
                continue;
            }
            let (selector, entities) = LabelSelector::parse_cilium(selector, &mut self.notes);
            if !entities.is_empty() {
                for entity in entities {
                    push_unique(&mut peers, Peer::Entity(entity));
                }
            } else if !selector.matches_nothing {
                let pods = self.in_namespace(selector);
                push_unique(
                    &mut peers,
                    Peer::Pods {
                        namespaces: NamespaceScope::Any,
                        pods,
                        cilium: true,
                    },
                );
            }
        }
        for cidr in strings(&entry[fields.cidr]) {
            push_unique(
                &mut peers,
                Peer::Cidr {
                    cidr,
                    except: Vec::new(),
                },
            );
        }
        for set in list(&entry[fields.cidr_set]) {
            if let Some(cidr) = text(set, "cidr") {
                let except = strings(&set["except"]);
                push_unique(&mut peers, Peer::Cidr { cidr, except });
            } else {
                for field in ["cidrGroupRef", "cidrGroupSelector"] {
                    if set.get(field).is_some_and(|value| !value.is_null()) {
                        self.note(field);
                    }
                }
            }
        }
        for name in list(&entry[fields.entities])
            .iter()
            .filter_map(Value::as_str)
        {
            match Entity::parse(name) {
                Some(entity) => push_unique(&mut peers, Peer::Entity(entity)),
                None => self.note(format!("entity {name}")),
            }
        }
        for fqdn in fields.fqdns.map_or(&[][..], |field| list(&entry[field])) {
            let name = text(fqdn, "matchName");
            let pattern = text(fqdn, "matchPattern");
            if name.is_some() || pattern.is_some() {
                push_unique(&mut peers, Peer::Fqdn { name, pattern });
            }
        }
        for field in fields.unevaluated {
            if !list(&entry[*field]).is_empty() {
                self.note(*field);
            }
        }
        let ports_given = !list(&entry["toPorts"]).is_empty();
        let ports = self.cilium_ports(&entry["toPorts"]);
        let icmps = !list(&entry["icmps"]).is_empty();
        if icmps {
            self.note("icmps");
        }
        if entry["authentication"].is_object() {
            self.note("authentication");
        }
        let dropped = (named && peers.is_empty())
            || (ports_given && ports.is_empty())
            || (!ports_given && (!named || icmps));
        if dropped {
            return None;
        }
        Some(Rule { peers, ports })
    }

    /// The ports of `toPorts` (spec §4.3), each with the HTTP rules of its entry. An entry
    /// without `ports` covers every port of every protocol. A port's protocol defaults to ANY,
    /// as in Cilium.
    fn cilium_ports(&mut self, to_ports: &Value) -> Vec<PortRule> {
        let mut ports = Vec::new();
        for entry in list(to_ports) {
            if !entry.is_object() {
                continue;
            }
            let http = self.l7_rules(&entry["rules"]);
            let given = list(&entry["ports"]);
            if given.is_empty() {
                push_unique(
                    &mut ports,
                    PortRule {
                        protocol: Protocol::Any,
                        port: None,
                        end_port: None,
                        http,
                    },
                );
                continue;
            }
            for port in given {
                if let Some(mut port) = self.port(port, Protocol::Any) {
                    port.http = http.clone();
                    push_unique(&mut ports, port);
                }
            }
        }
        ports
    }

    /// `rules.http` (spec §4.3); `dns`, `kafka` and `l7proto` add their notes (spec §4.6) and
    /// leave the port without an L7 limit. An HTTP rule that names nothing allows every
    /// request, so then the port has no L7 limit either.
    fn l7_rules(&mut self, rules: &Value) -> Vec<HttpRule> {
        if !list(&rules["dns"]).is_empty() {
            self.note("rules.dns");
        }
        if !list(&rules["kafka"]).is_empty() {
            self.note("rules.kafka");
        }
        if text(rules, "l7proto").is_some() || !list(&rules["l7"]).is_empty() {
            self.note("rules.l7proto");
        }
        let http: Vec<HttpRule> = list(&rules["http"])
            .iter()
            .filter(|rule| rule.is_object())
            .map(http_rule)
            .collect();
        let allows_every_request = http.iter().any(|rule| {
            rule.method.is_none()
                && rule.path.is_none()
                && rule.host.is_none()
                && rule.headers.is_empty()
        });
        if allows_every_request {
            Vec::new()
        } else {
            http
        }
    }
}

/// One `rules.http` entry. `headers` are kept as written; each `headerMatches` entry reads as
/// "name: value", or "name" alone when the policy does not write the value (it may come from
/// a Secret, which is never read).
#[cfg_attr(not(test), allow(dead_code))]
fn http_rule(rule: &Value) -> HttpRule {
    let mut headers = strings(&rule["headers"]);
    for header in list(&rule["headerMatches"]) {
        if let Some(name) = text(header, "name") {
            headers.push(match text(header, "value") {
                Some(value) => format!("{name}: {value}"),
                None => name,
            });
        }
    }
    HttpRule {
        method: text(rule, "method"),
        path: text(rule, "path"),
        host: text(rule, "host"),
        headers,
    }
}

/// A `port` field: `Some(None)` when absent, empty or 0 (every port); a number from 1 to 65535
/// or a string of digits as a number; any other string as a name; `None` for anything else.
#[cfg_attr(not(test), allow(dead_code))]
fn port_value(value: &Value) -> Option<Option<PortValue>> {
    if value.is_null() || value.as_str() == Some("") {
        return Some(None);
    }
    if let Some(name) = value
        .as_str()
        .filter(|text| !text.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Some(Some(PortValue::Name(name.to_owned())));
    }
    match u16::try_from(whole_number(value)?).ok()? {
        0 => Some(None),
        number => Some(Some(PortValue::Number(number))),
    }
}

/// A whole number, written as a number or as a string of digits.
#[cfg_attr(not(test), allow(dead_code))]
fn whole_number(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) if text.bytes().all(|byte| byte.is_ascii_digit()) => text.parse().ok(),
        _ => None,
    }
}

/// A string at `field` that is not empty.
#[cfg_attr(not(test), allow(dead_code))]
fn text(value: &Value, field: &str) -> Option<String> {
    value[field]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The array `value` holds, or nothing.
#[cfg_attr(not(test), allow(dead_code))]
fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// The strings of the array `value` holds, leaving out empty ones and other values.
#[cfg_attr(not(test), allow(dead_code))]
fn strings(value: &Value) -> Vec<String> {
    list(value)
        .iter()
        .filter_map(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::NAMESPACE_LABEL;
    use crate::netpol::selector::{Operator, Requirement};
    use crate::netpol::{
        parse_policy, Entity, HttpRule, LabelSelector, NamespaceScope, Peer, Policy, PolicyId,
        PolicyRule, PolicySource, PortRule, PortValue, Protocol, Rule, Subject,
    };

    /// A NetworkPolicy `p` in `payments`.
    fn network_policy(spec: Value) -> Policy {
        let object = json!({ "metadata": { "name": "p", "namespace": "payments" }, "spec": spec });
        parse_policy(PolicySource::Kubernetes, &object).expect("a named policy")
    }

    /// A CiliumNetworkPolicy `p` in `payments` with one `spec`.
    fn cilium(spec: Value) -> Policy {
        let object = json!({ "metadata": { "name": "p", "namespace": "payments" }, "spec": spec });
        parse_policy(PolicySource::Cilium, &object).expect("a named policy")
    }

    fn only_rule(policy: &Policy) -> &PolicyRule {
        assert_eq!(policy.rules.len(), 1, "{policy:?}");
        &policy.rules[0]
    }

    /// `key=value` requirements in this order.
    fn selector(pairs: &[(&str, &str)]) -> LabelSelector {
        pairs
            .iter()
            .fold(LabelSelector::default(), |selector, (key, value)| {
                selector.with_label(key, value)
            })
    }

    fn within(key: &str, values: &[&str]) -> LabelSelector {
        LabelSelector {
            requirements: vec![Requirement {
                key: key.to_owned(),
                operator: Operator::In(values.iter().map(|value| (*value).to_owned()).collect()),
            }],
            matches_nothing: false,
        }
    }

    fn pods_in(namespace: &str, pods: LabelSelector) -> Peer {
        Peer::Pods {
            namespaces: NamespaceScope::Only(namespace.to_owned()),
            pods,
            cilium: false,
        }
    }

    fn cilium_pods(pods: LabelSelector) -> Peer {
        Peer::Pods {
            namespaces: NamespaceScope::Any,
            pods,
            cilium: true,
        }
    }

    fn cidr(cidr: &str, except: &[&str]) -> Peer {
        Peer::Cidr {
            cidr: cidr.to_owned(),
            except: except.iter().map(|text| (*text).to_owned()).collect(),
        }
    }

    fn port(protocol: Protocol, port: Option<PortValue>) -> PortRule {
        PortRule {
            protocol,
            port,
            end_port: None,
            http: Vec::new(),
        }
    }

    fn number(protocol: Protocol, number: u16) -> PortRule {
        port(protocol, Some(PortValue::Number(number)))
    }

    fn named(protocol: Protocol, name: &str) -> PortRule {
        port(protocol, Some(PortValue::Name(name.to_owned())))
    }

    fn tcp(number_: u16) -> PortRule {
        number(Protocol::Tcp, number_)
    }

    fn rule(peers: Vec<Peer>, ports: Vec<PortRule>) -> Rule {
        Rule { peers, ports }
    }

    fn texts(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn network_policy_types_default_as_the_api_server_does() {
        let ingress_only = network_policy(json!({ "podSelector": {} }));
        assert_eq!(
            ingress_only.id,
            PolicyId {
                source: PolicySource::Kubernetes,
                namespace: "payments".to_owned(),
                name: "p".to_owned(),
            }
        );
        assert_eq!(
            ingress_only.rules,
            [PolicyRule {
                subject: Subject::Pods {
                    namespace: Some("payments".to_owned()),
                    selector: LabelSelector::default(),
                    cilium: false,
                },
                ingress: Vec::new(),
                egress: Vec::new(),
                ingress_deny: Vec::new(),
                egress_deny: Vec::new(),
                isolates_ingress: true,
                isolates_egress: false,
            }]
        );
        assert_eq!(ingress_only.types(), ["Ingress"]);
        assert!(ingress_only.notes.is_empty());

        let with_egress = network_policy(json!({
            "podSelector": { "matchLabels": { "app": "web" } },
            "ingress": [{}],
            "egress": [{ "to": [], "ports": [] }],
        }));
        let both = only_rule(&with_egress);
        assert!(both.isolates_ingress && both.isolates_egress);
        assert_eq!(
            both.ingress,
            [rule(Vec::new(), Vec::new())],
            "every peer, every port"
        );
        assert_eq!(both.egress, [rule(Vec::new(), Vec::new())]);
        assert_eq!(with_egress.selector_text(), "app=web");

        let empty_egress = network_policy(json!({ "podSelector": {}, "egress": [] }));
        assert!(!only_rule(&empty_egress).isolates_egress);

        let egress_only = network_policy(json!({
            "podSelector": {},
            "policyTypes": ["Egress"],
            "ingress": [{}],
        }));
        let egress = only_rule(&egress_only);
        assert!(!egress.isolates_ingress && egress.isolates_egress);
        assert!(
            egress.ingress.is_empty(),
            "rules of a type it lacks are ignored"
        );
        assert!(
            egress.egress.is_empty(),
            "isolated with no rule: nothing allowed"
        );
        assert_eq!(egress_only.types(), ["Egress"]);

        let listed = network_policy(json!({
            "podSelector": {},
            "policyTypes": ["Ingress", "Egress"],
        }));
        assert_eq!(listed.types(), ["Ingress", "Egress"]);
    }

    #[test]
    fn network_policy_peers_read_every_form() {
        let policy = network_policy(json!({
            "podSelector": {},
            "ingress": [{
                "from": [
                    { "podSelector": { "matchLabels": { "app": "api" } } },
                    { "namespaceSelector": { "matchLabels": { "team": "a" } } },
                    {
                        "namespaceSelector": {},
                        "podSelector": { "matchLabels": { "app": "prometheus" } },
                    },
                    { "ipBlock": { "cidr": "10.0.0.0/8", "except": ["10.1.0.0/16", "10.2.0.0/16"] } },
                    { "ipBlock": { "cidr": "192.168.0.0/16" } },
                ],
            }],
        }));
        assert_eq!(
            only_rule(&policy).ingress,
            [rule(
                vec![
                    pods_in("payments", selector(&[("app", "api")])),
                    Peer::Pods {
                        namespaces: NamespaceScope::Selected(selector(&[("team", "a")])),
                        pods: LabelSelector::default(),
                        cilium: false,
                    },
                    Peer::Pods {
                        namespaces: NamespaceScope::Selected(LabelSelector::default()),
                        pods: selector(&[("app", "prometheus")]),
                        cilium: false,
                    },
                    cidr("10.0.0.0/8", &["10.1.0.0/16", "10.2.0.0/16"]),
                    cidr("192.168.0.0/16", &[]),
                ],
                Vec::new(),
            )]
        );
    }

    #[test]
    fn network_policy_ports_read_every_form() {
        let policy = network_policy(json!({
            "podSelector": {},
            "policyTypes": ["Egress"],
            "egress": [{
                "to": [{ "podSelector": {} }],
                "ports": [
                    { "port": 8080 },
                    { "protocol": "UDP", "port": 53 },
                    { "protocol": "SCTP", "port": "metrics" },
                    { "protocol": "TCP", "port": 8000, "endPort": 8080 },
                    { "protocol": "UDP" },
                ],
            }],
        }));
        assert_eq!(
            only_rule(&policy).egress,
            [rule(
                vec![pods_in("payments", LabelSelector::default())],
                vec![
                    tcp(8080),
                    number(Protocol::Udp, 53),
                    named(Protocol::Sctp, "metrics"),
                    PortRule {
                        end_port: Some(8080),
                        ..tcp(8000)
                    },
                    port(Protocol::Udp, None),
                ],
            )]
        );
    }

    #[test]
    fn cilium_spec_and_specs_are_each_a_rule() {
        let object = json!({
            "metadata": { "name": "api", "namespace": "payments" },
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "api" } },
                "ingress": [{ "fromEndpoints": [{ "matchLabels": { "app": "web" } }] }],
            },
            "specs": [
                {
                    "endpointSelector": {
                        "matchLabels": { "k8s:io.kubernetes.pod.namespace": "payments", "app": "db" },
                    },
                    "egress": [{
                        "toEndpoints": [
                            { "matchLabels": { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" } },
                            {},
                        ],
                    }],
                },
                "not a rule",
                { "description": "no selector", "ingress": [{ "fromEntities": ["world"] }] },
            ],
        });
        let policy = parse_policy(PolicySource::Cilium, &object).expect("a named policy");
        assert_eq!(
            policy.id,
            PolicyId {
                source: PolicySource::Cilium,
                namespace: "payments".to_owned(),
                name: "api".to_owned(),
            }
        );
        let in_payments =
            |pairs: &[(&str, &str)]| selector(pairs).with_label(NAMESPACE_LABEL, "payments");
        assert_eq!(
            policy.rules,
            [
                PolicyRule {
                    subject: Subject::Pods {
                        namespace: Some("payments".to_owned()),
                        selector: in_payments(&[("app", "api")]),
                        cilium: true,
                    },
                    ingress: vec![rule(
                        vec![cilium_pods(in_payments(&[("app", "web")]))],
                        Vec::new()
                    )],
                    egress: Vec::new(),
                    ingress_deny: Vec::new(),
                    egress_deny: Vec::new(),
                    isolates_ingress: true,
                    isolates_egress: false,
                },
                PolicyRule {
                    subject: Subject::Pods {
                        namespace: Some("payments".to_owned()),
                        selector: selector(&[("app", "db"), (NAMESPACE_LABEL, "payments")]),
                        cilium: true,
                    },
                    ingress: Vec::new(),
                    egress: vec![rule(
                        vec![
                            cilium_pods(selector(&[
                                ("k8s-app", "kube-dns"),
                                (NAMESPACE_LABEL, "kube-system")
                            ])),
                            cilium_pods(in_payments(&[])),
                        ],
                        Vec::new(),
                    )],
                    ingress_deny: Vec::new(),
                    egress_deny: Vec::new(),
                    isolates_ingress: false,
                    isolates_egress: true,
                },
            ]
        );

        let object = json!({
            "metadata": { "name": "scrape", "namespace": "ignored" },
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "web" } },
                "ingress": [{ "fromEndpoints": [{ "matchLabels": { "app": "prometheus" } }] }],
            },
        });
        let cluster =
            parse_policy(PolicySource::CiliumClusterwide, &object).expect("a named policy");
        assert_eq!(
            cluster.id.namespace, "",
            "a cluster-wide policy has no namespace"
        );
        let scrape = only_rule(&cluster);
        assert_eq!(
            scrape.subject,
            Subject::Pods {
                namespace: None,
                selector: selector(&[("app", "web")]),
                cilium: true,
            }
        );
        assert_eq!(
            scrape.ingress,
            [rule(
                vec![cilium_pods(selector(&[("app", "prometheus")]))],
                Vec::new()
            )],
            "a cluster-wide selector stays as written"
        );

        let object = json!({ "metadata": { "name": "empty", "namespace": "payments" } });
        let empty = parse_policy(PolicySource::Cilium, &object).expect("a named policy");
        assert!(empty.rules.is_empty());
        assert!(empty.types().is_empty() && !empty.is_host());
    }

    #[test]
    fn cilium_peers_read_entities_cidrs_and_fqdns() {
        let policy = cilium(json!({
            "endpointSelector": {},
            "ingress": [{
                "fromEntities": ["world", "cluster", "remote-node"],
                "fromEndpoints": [{ "matchLabels": { "reserved:host": "" } }],
                "fromCIDR": ["10.0.0.0/8"],
                "fromCIDRSet": [{ "cidr": "172.16.0.0/12", "except": ["172.16.1.0/24"] }],
            }],
            "egress": [
                { "toFQDNs": [{ "matchName": "api.stripe.com" }, { "matchPattern": "*.example.com" }, {}] },
                { "toEntities": ["kube-apiserver", "world"], "toCIDR": ["0.0.0.0/0"] },
            ],
        }));
        let only = only_rule(&policy);
        assert_eq!(
            only.subject,
            Subject::Pods {
                namespace: Some("payments".to_owned()),
                selector: selector(&[(NAMESPACE_LABEL, "payments")]),
                cilium: true,
            }
        );
        assert_eq!(
            only.ingress,
            [rule(
                vec![
                    Peer::Entity(Entity::Host),
                    cidr("10.0.0.0/8", &[]),
                    cidr("172.16.0.0/12", &["172.16.1.0/24"]),
                    Peer::Entity(Entity::World),
                    Peer::Entity(Entity::Cluster),
                    Peer::Entity(Entity::RemoteNode),
                ],
                Vec::new(),
            )]
        );
        assert_eq!(
            only.egress,
            [
                rule(
                    vec![
                        Peer::Fqdn {
                            name: Some("api.stripe.com".to_owned()),
                            pattern: None,
                        },
                        Peer::Fqdn {
                            name: None,
                            pattern: Some("*.example.com".to_owned()),
                        },
                    ],
                    Vec::new(),
                ),
                rule(
                    vec![
                        cidr("0.0.0.0/0", &[]),
                        Peer::Entity(Entity::KubeApiserver),
                        Peer::Entity(Entity::World),
                    ],
                    Vec::new(),
                ),
            ]
        );
        assert!(policy.notes.is_empty());
    }

    #[test]
    fn cilium_ports_read_any_names_and_http_rules() {
        let policy = cilium(json!({
            "endpointSelector": { "matchLabels": { "app": "api" } },
            "ingress": [{
                "fromEndpoints": [{ "matchLabels": { "app": "web" } }],
                "toPorts": [{
                    "ports": [{ "port": "8080", "protocol": "TCP" }, { "port": "http" }],
                    "rules": { "http": [
                        { "method": "GET", "path": "/api/.*" },
                        {
                            "host": "api.example.com",
                            "headers": ["X-Team: a", "X-Debug"],
                            "headerMatches": [
                                { "name": "X-Key", "value": "1" },
                                { "name": "X-Token", "secret": { "namespace": "payments", "name": "token" } },
                            ],
                        },
                    ] },
                }],
            }],
            "egress": [
                { "toPorts": [{ "ports": [
                    { "port": "53", "protocol": "ANY" },
                    { "port": 8000, "endPort": 8080, "protocol": "TCP" },
                    { "port": "0", "protocol": "UDP" },
                ] }] },
                { "toEndpoints": [{}], "toPorts": [{ "rules": { "http": [{ "method": "GET" }, {}] } }] },
            ],
        }));
        let only = only_rule(&policy);
        let http = vec![
            HttpRule {
                method: Some("GET".to_owned()),
                path: Some("/api/.*".to_owned()),
                host: None,
                headers: Vec::new(),
            },
            HttpRule {
                method: None,
                path: None,
                host: Some("api.example.com".to_owned()),
                headers: texts(&["X-Team: a", "X-Debug", "X-Key: 1", "X-Token"]),
            },
        ];
        assert_eq!(
            only.ingress,
            [rule(
                vec![cilium_pods(selector(&[
                    ("app", "web"),
                    (NAMESPACE_LABEL, "payments")
                ]))],
                vec![
                    PortRule {
                        http: http.clone(),
                        ..tcp(8080)
                    },
                    PortRule {
                        http,
                        ..named(Protocol::Any, "http")
                    },
                ],
            )]
        );
        assert_eq!(
            only.egress,
            [
                rule(
                    Vec::new(),
                    vec![
                        number(Protocol::Any, 53),
                        PortRule {
                            end_port: Some(8080),
                            ..tcp(8000)
                        },
                        port(Protocol::Udp, None),
                    ],
                ),
                rule(
                    vec![cilium_pods(selector(&[(NAMESPACE_LABEL, "payments")]))],
                    vec![port(Protocol::Any, None)],
                ),
            ],
            "ports alone allow every peer; no ports is every port; an empty HTTP rule allows every request"
        );
        assert!(policy.notes.is_empty());
    }

    #[test]
    fn cilium_isolation_follows_sections_and_enable_default_deny() {
        let isolation = |spec: Value| {
            let policy = cilium(spec);
            let only = only_rule(&policy);
            (only.isolates_ingress, only.isolates_egress)
        };
        assert_eq!(isolation(json!({ "endpointSelector": {} })), (false, false));
        assert_eq!(
            isolation(json!({ "endpointSelector": {}, "ingress": [] })),
            (true, false),
            "an empty section isolates"
        );
        assert_eq!(
            isolation(
                json!({ "endpointSelector": {}, "egressDeny": [{ "toEntities": ["world"] }] })
            ),
            (false, true)
        );
        assert_eq!(
            isolation(json!({ "endpointSelector": {}, "ingressDeny": [], "egress": [{}] })),
            (true, true)
        );
        assert_eq!(
            isolation(json!({
                "endpointSelector": {},
                "ingress": [{}],
                "egress": [{}],
                "enableDefaultDeny": { "ingress": false },
            })),
            (false, true)
        );
        assert_eq!(
            isolation(json!({
                "endpointSelector": {},
                "ingress": [{}],
                "egress": [{}],
                "enableDefaultDeny": { "ingress": true, "egress": false },
            })),
            (true, false)
        );

        let deny_all = cilium(json!({ "endpointSelector": {}, "ingress": [{}] }));
        let only = only_rule(&deny_all);
        assert!(only.isolates_ingress);
        assert!(only.ingress.is_empty(), "Cilium's `- {{}}` allows nothing");
        assert_eq!(deny_all.types(), ["Ingress"]);

        let not_isolating = cilium(json!({
            "endpointSelector": {},
            "egress": [{ "toEntities": ["all"] }],
            "enableDefaultDeny": { "egress": false },
        }));
        assert_eq!(
            only_rule(&not_isolating).egress,
            [rule(vec![Peer::Entity(Entity::All)], Vec::new())],
            "its rules still allow"
        );
        assert_eq!(not_isolating.types(), ["Egress"]);
    }

    #[test]
    fn cilium_deny_sections_read_like_allow_sections() {
        let policy = cilium(json!({
            "endpointSelector": { "matchLabels": { "app": "db" } },
            "ingressDeny": [{ "fromEntities": ["world"] }],
            "egressDeny": [{
                "toCIDRSet": [{ "cidr": "0.0.0.0/0", "except": ["10.0.0.0/8"] }],
                "toPorts": [{ "ports": [{ "port": "25", "protocol": "TCP" }] }],
            }],
        }));
        let only = only_rule(&policy);
        assert!(only.ingress.is_empty() && only.egress.is_empty());
        assert_eq!(
            only.ingress_deny,
            [rule(vec![Peer::Entity(Entity::World)], Vec::new())]
        );
        assert_eq!(
            only.egress_deny,
            [rule(
                vec![cidr("0.0.0.0/0", &["10.0.0.0/8"])],
                vec![tcp(25)]
            )]
        );
        assert!(only.isolates_ingress && only.isolates_egress);
        assert_eq!(policy.types(), ["Ingress", "Egress"]);
    }

    #[test]
    fn a_cilium_host_policy_is_listed_with_a_note() {
        let object = json!({
            "metadata": { "name": "nodes" },
            "spec": {
                "nodeSelector": { "matchLabels": { "node-role.kubernetes.io/control-plane": "" } },
                "ingress": [{ "fromEntities": ["cluster"] }],
            },
        });
        let policy =
            parse_policy(PolicySource::CiliumClusterwide, &object).expect("a named policy");
        assert!(policy.is_host());
        assert_eq!(policy.notes, ["nodeSelector"]);
        assert_eq!(
            policy.rules,
            [PolicyRule {
                subject: Subject::Host,
                ingress: vec![rule(vec![Peer::Entity(Entity::Cluster)], Vec::new())],
                egress: Vec::new(),
                ingress_deny: Vec::new(),
                egress_deny: Vec::new(),
                isolates_ingress: false,
                isolates_egress: false,
            }],
            "a host rule isolates no Pod"
        );
        assert_eq!(policy.selector_text(), "");
        assert_eq!(policy.types(), ["Ingress"]);
    }

    #[test]
    fn each_unevaluated_field_adds_its_note() {
        let policy = cilium(json!({
            "endpointSelector": { "matchLabels": { "app": "api" } },
            "ingress": [{
                "fromEndpoints": [{ "matchLabels": { "app": "web" } }],
                "fromRequires": [{ "matchLabels": { "env": "prod" } }],
                "toPorts": [{
                    "ports": [{ "port": "8080", "protocol": "TCP" }],
                    "rules": { "kafka": [{ "topic": "orders" }] },
                }],
                "icmps": [{ "fields": [{ "type": 8 }] }],
                "authentication": { "mode": "required" },
            }],
            "egress": [
                {
                    "toEndpoints": [{ "matchLabels": { "k8s-app": "kube-dns", "k8s:io.kubernetes.pod.namespace": "kube-system" } }],
                    "toServices": [{ "k8sService": { "serviceName": "db", "namespace": "payments" } }],
                    "toGroups": [{ "aws": { "securityGroupsIds": ["sg-1"] } }],
                    "toRequires": [{ "matchLabels": { "env": "prod" } }],
                    "toNodes": [{}],
                    "toPorts": [{
                        "ports": [{ "port": "53", "protocol": "UDP" }, { "protocol": "ICMP" }],
                        "rules": { "dns": [{ "matchPattern": "*" }] },
                    }],
                },
                {
                    "toPorts": [{
                        "ports": [{ "port": "9000", "protocol": "TCP" }],
                        "rules": { "l7proto": "envoy.filters.network.redis", "l7": [{ "command": "GET" }] },
                    }],
                },
                { "toCIDRSet": [{ "cidrGroupRef": "partners" }, { "cidr": "10.0.0.0/8" }] },
                { "toEntities": ["world-ipv4", "world"] },
                { "toServices": [{ "k8sService": { "serviceName": "cache" } }], "toCIDR": ["192.168.0.0/16"] },
            ],
        }));
        assert_eq!(
            policy.notes,
            [
                "fromRequires",
                "rules.kafka",
                "icmps",
                "authentication",
                "toServices",
                "toGroups",
                "toRequires",
                "toNodes",
                "rules.dns",
                "protocol ICMP",
                "rules.l7proto",
                "cidrGroupRef",
                "entity world-ipv4",
            ],
            "each note once, in the order found"
        );
        let only = only_rule(&policy);
        assert_eq!(
            only.ingress,
            [rule(
                vec![cilium_pods(selector(&[
                    ("app", "web"),
                    (NAMESPACE_LABEL, "payments")
                ]))],
                vec![tcp(8080)],
            )],
            "with toPorts, icmps leave the entry; kafka leaves no L7 limit"
        );
        assert_eq!(
            only.egress,
            [
                rule(
                    vec![cilium_pods(selector(&[
                        ("k8s-app", "kube-dns"),
                        (NAMESPACE_LABEL, "kube-system")
                    ]))],
                    vec![number(Protocol::Udp, 53)],
                ),
                rule(Vec::new(), vec![tcp(9000)]),
                rule(vec![cidr("10.0.0.0/8", &[])], Vec::new()),
                rule(vec![Peer::Entity(Entity::World)], Vec::new()),
                rule(vec![cidr("192.168.0.0/16", &[])], Vec::new()),
            ],
            "the peers that are evaluated stay"
        );
    }

    #[test]
    fn an_entry_with_only_unevaluated_peers_is_dropped_with_its_notes() {
        let https = json!([{ "ports": [{ "port": "443", "protocol": "TCP" }] }]);
        let icmp = json!([{ "fields": [{ "type": 8 }] }]);
        let policy = cilium(json!({
            "endpointSelector": { "matchLabels": { "app": "api" } },
            "ingress": [
                { "fromRequires": [{ "matchLabels": { "env": "prod" } }] },
                { "fromEndpoints": [{ "matchLabels": { "cidr:10.0.0.0/8": "" } }], "toPorts": https },
                { "fromEndpoints": [{ "matchExpressions": [{ "key": "app", "operator": "Matches", "values": ["web"] }] }] },
                { "fromEntities": ["cluster-mesh"] },
                { "fromGroups": [{ "aws": {} }], "fromNodes": [{ "matchLabels": { "role": "edge" } }] },
                { "fromEndpoints": [], "toPorts": https },
                { "fromEndpoints": [{ "matchLabels": { "app": "web" } }], "icmps": icmp },
                { "icmps": icmp },
                {},
            ],
            "egress": [
                { "toServices": [{ "k8sService": { "serviceName": "db", "namespace": "payments" } }], "toPorts": https },
                { "toGroups": [{ "aws": {} }], "toServices": [{ "k8sServiceSelector": {} }] },
                { "toPorts": [{ "ports": [{ "protocol": "ICMP" }] }] },
                { "toCIDRSet": [{ "cidrGroupSelector": { "matchLabels": { "team": "a" } } }] },
            ],
        }));
        let only = only_rule(&policy);
        assert!(only.ingress.is_empty(), "no entry becomes every peer");
        assert!(only.egress.is_empty());
        assert!(
            only.isolates_ingress && only.isolates_egress,
            "the sections still isolate"
        );
        assert_eq!(
            policy.notes,
            [
                "fromRequires",
                "label source cidr",
                "operator Matches",
                "entity cluster-mesh",
                "fromGroups",
                "fromNodes",
                "icmps",
                "toServices",
                "toGroups",
                "protocol ICMP",
                "cidrGroupSelector",
            ]
        );

        let network = network_policy(json!({
            "podSelector": {},
            "ingress": [{
                "from": [
                    { "podSelector": { "matchExpressions": [{ "key": "app", "operator": "In", "values": [] }] } },
                    { "namespaceSelector": { "matchExpressions": [{ "key": "team", "operator": "Near" }] } },
                ],
            }],
        }));
        let only = only_rule(&network);
        assert!(only.isolates_ingress);
        assert!(
            only.ingress.is_empty(),
            "peers that select nothing drop the rule"
        );
        assert_eq!(network.notes, ["operator In", "operator Near"]);
    }

    #[test]
    fn odd_fields_are_read_as_absent() {
        let network = network_policy(json!({
            "podSelector": "app=web",
            "policyTypes": "Egress",
            "ingress": [
                {
                    "from": "everyone",
                    "ports": [
                        { "port": "80" },
                        { "port": "http" },
                        { "port": true },
                        { "port": 70000 },
                        { "port": -1 },
                        { "port": 8080, "endPort": 80 },
                        { "port": "metrics", "endPort": 90 },
                        { "port": 9000, "endPort": "9100" },
                        { "protocol": 6, "port": 22 },
                        "443",
                    ],
                },
                { "ports": [true, { "port": 1.5 }] },
                { "from": [{ "podSelector": "app=web" }, { "ipBlock": { "except": ["10.1.0.0/16"] } }, 7] },
                "not a rule",
            ],
            "egress": { "to": [] },
        }));
        let only = only_rule(&network);
        assert_eq!(
            only.subject,
            Subject::Pods {
                namespace: Some("payments".to_owned()),
                selector: LabelSelector::default(),
                cilium: false,
            },
            "a podSelector that is a string selects every Pod, as an empty one does"
        );
        assert!(
            only.isolates_ingress && !only.isolates_egress,
            "policyTypes that is not a list counts as absent"
        );
        assert_eq!(
            only.ingress,
            [rule(
                Vec::new(),
                vec![
                    tcp(80),
                    named(Protocol::Tcp, "http"),
                    tcp(8080),
                    named(Protocol::Tcp, "metrics"),
                    PortRule {
                        end_port: Some(9100),
                        ..tcp(9000)
                    },
                    tcp(22),
                ],
            )],
            "\"80\" is port 80; unreadable ports are left out; an endPort below its port is ignored"
        );
        assert!(network.notes.is_empty());

        let object = json!({
            "metadata": { "name": "odd", "namespace": "payments" },
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "api" } },
                "enableDefaultDeny": "no",
                "ingress": { "fromEndpoints": [{}] },
                "egress": [
                    { "toEndpoints": ["app=db"] },
                    { "toEndpoints": [{ "matchLabels": { "app": "db" } }], "toPorts": "5432" },
                    {
                        "toEntities": "world",
                        "toPorts": [
                            { "ports": "5432" },
                            "x",
                            { "ports": [{ "port": "5432", "endPort": 5000 }], "rules": { "http": "GET" } },
                        ],
                    },
                    { "toFQDNs": [{ "matchName": 5 }], "toCIDR": [7, ""], "toCIDRSet": [{ "cidr": 9 }] },
                ],
            },
            "specs": { "endpointSelector": {} },
        });
        let odd = parse_policy(PolicySource::Cilium, &object).expect("a named policy");
        let only = only_rule(&odd);
        assert!(
            !only.isolates_ingress && only.isolates_egress,
            "a section that is not a list is absent; so is enableDefaultDeny that is not an object"
        );
        assert!(only.ingress.is_empty());
        assert_eq!(
            only.egress,
            [
                rule(
                    vec![cilium_pods(selector(&[
                        ("app", "db"),
                        (NAMESPACE_LABEL, "payments")
                    ]))],
                    Vec::new(),
                ),
                rule(
                    Vec::new(),
                    vec![port(Protocol::Any, None), number(Protocol::Any, 5432)],
                ),
            ]
        );
        assert!(odd.notes.is_empty());

        let no_selector = cilium(json!({ "endpointSelector": "app=api", "ingress": [{}] }));
        assert!(
            no_selector.rules.is_empty(),
            "a rule with no selector object selects nothing"
        );
        let odd_host = cilium(json!({ "nodeSelector": "x", "endpointSelector": {} }));
        assert!(
            !odd_host.is_host(),
            "a nodeSelector that is not an object is absent"
        );
    }

    #[test]
    fn a_policy_without_a_name_is_none() {
        let sources = [
            PolicySource::Kubernetes,
            PolicySource::Cilium,
            PolicySource::CiliumClusterwide,
        ];
        let objects = [
            json!({}),
            json!({ "metadata": {} }),
            json!({ "metadata": { "name": "" } }),
            json!({ "metadata": { "name": 5 } }),
            json!({ "metadata": "p" }),
            json!(null),
            json!("p"),
            json!([1]),
        ];
        for source in sources {
            for object in &objects {
                assert_eq!(parse_policy(source, object), None, "{source:?} {object}");
            }
        }
        let bare = parse_policy(
            PolicySource::Kubernetes,
            &json!({ "metadata": { "name": "p" } }),
        )
        .expect("a named policy");
        assert_eq!(bare.id.namespace, "");
        assert!(only_rule(&bare).isolates_ingress, "read as far as it goes");
    }

    /// The canvas sample namespace's ten policies (plan contract C13).
    fn sample_policies() -> Vec<(PolicySource, Value)> {
        let metadata = |name: &str| json!({ "name": name, "namespace": "payments" });
        let web_api_db = json!({
            "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web", "api", "db"] }],
        });
        vec![
            (
                PolicySource::Kubernetes,
                json!({
                    "metadata": metadata("default-deny"),
                    "spec": { "podSelector": web_api_db, "policyTypes": ["Ingress", "Egress"] },
                }),
            ),
            (
                PolicySource::Kubernetes,
                json!({
                    "metadata": metadata("allow-web-from-ingress"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "web" } },
                        "ingress": [{
                            "from": [{ "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "ingress-nginx" } } }],
                            "ports": [{ "protocol": "TCP", "port": 8080 }],
                        }],
                    },
                }),
            ),
            (
                PolicySource::Kubernetes,
                json!({
                    "metadata": metadata("allow-db-from-api"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "db" } },
                        "ingress": [{
                            "from": [{ "podSelector": { "matchLabels": { "app": "api" } } }],
                            "ports": [{ "protocol": "TCP", "port": 5432 }],
                        }],
                    },
                }),
            ),
            (
                PolicySource::Kubernetes,
                json!({
                    "metadata": metadata("allow-web-to-api"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "web" } },
                        "policyTypes": ["Egress"],
                        "egress": [{
                            "to": [{ "podSelector": { "matchLabels": { "app": "api" } } }],
                            "ports": [{ "protocol": "TCP", "port": 8080 }],
                        }],
                    },
                }),
            ),
            (
                PolicySource::Kubernetes,
                json!({
                    "metadata": metadata("allow-api-to-db"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "api" } },
                        "policyTypes": ["Egress"],
                        "egress": [{
                            "to": [{ "podSelector": { "matchLabels": { "app": "db" } } }],
                            "ports": [{ "protocol": "TCP", "port": 5432 }],
                        }],
                    },
                }),
            ),
            (
                PolicySource::Kubernetes,
                json!({
                    "metadata": metadata("allow-dns"),
                    "spec": {
                        "podSelector": web_api_db,
                        "policyTypes": ["Egress"],
                        "egress": [{
                            "to": [{
                                "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "kube-system" } },
                                "podSelector": { "matchLabels": { "k8s-app": "kube-dns" } },
                            }],
                            "ports": [{ "protocol": "UDP", "port": 53 }, { "protocol": "TCP", "port": 53 }],
                        }],
                    },
                }),
            ),
            (
                PolicySource::Cilium,
                json!({
                    "metadata": metadata("allow-api-from-web"),
                    "spec": {
                        "endpointSelector": { "matchLabels": { "app": "api" } },
                        "ingress": [{
                            "fromEndpoints": [{ "matchLabels": { "app": "web" } }],
                            "toPorts": [{
                                "ports": [{ "port": "8080", "protocol": "TCP" }],
                                "rules": { "http": [{ "method": "GET", "path": "/api/.*" }] },
                            }],
                        }],
                    },
                }),
            ),
            (
                PolicySource::Cilium,
                json!({
                    "metadata": metadata("api-egress-stripe"),
                    "spec": {
                        "endpointSelector": { "matchLabels": { "app": "api" } },
                        "egress": [
                            {
                                "toFQDNs": [{ "matchName": "api.stripe.com" }],
                                "toPorts": [{ "ports": [{ "port": "443", "protocol": "TCP" }] }],
                            },
                            {
                                "toEndpoints": [{
                                    "matchLabels": { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" },
                                }],
                                "toPorts": [{
                                    "ports": [{ "port": "53", "protocol": "UDP" }],
                                    "rules": { "dns": [{ "matchPattern": "*" }] },
                                }],
                            },
                        ],
                    },
                }),
            ),
            (
                PolicySource::Cilium,
                json!({
                    "metadata": metadata("db-no-internet"),
                    "spec": {
                        "endpointSelector": { "matchLabels": { "app": "db" } },
                        "egressDeny": [{ "toEntities": ["world"] }],
                    },
                }),
            ),
            (
                PolicySource::CiliumClusterwide,
                json!({
                    "metadata": { "name": "allow-prometheus-scrape" },
                    "spec": {
                        "endpointSelector": {
                            "matchLabels": { "k8s:io.kubernetes.pod.namespace": "payments" },
                            "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web", "api", "db"] }],
                        },
                        "ingress": [{
                            "fromEndpoints": [{
                                "matchLabels": { "k8s:io.kubernetes.pod.namespace": "monitoring", "app": "prometheus" },
                            }],
                            "toPorts": [{ "ports": [{ "port": "9090", "protocol": "TCP" }] }],
                        }],
                    },
                }),
            ),
        ]
    }

    #[test]
    fn the_sample_namespace_policies_parse() {
        let policies: Vec<Policy> = sample_policies()
            .iter()
            .map(|(source, object)| parse_policy(*source, object).expect("a named policy"))
            .collect();
        // Name, source, namespace, types, selector text and notes of each policy.
        let summary = |policy: &Policy| {
            format!(
                "{} {:?} {:?} [{}] [{}] [{}]",
                policy.id.name,
                policy.id.source,
                policy.id.namespace,
                policy.types().join(", "),
                policy.selector_text(),
                policy.notes.join(", "),
            )
        };
        assert_eq!(
            policies.iter().map(summary).collect::<Vec<_>>(),
            [
                r#"default-deny Kubernetes "payments" [Ingress, Egress] [app in (web, api, db)] []"#,
                r#"allow-web-from-ingress Kubernetes "payments" [Ingress] [app=web] []"#,
                r#"allow-db-from-api Kubernetes "payments" [Ingress] [app=db] []"#,
                r#"allow-web-to-api Kubernetes "payments" [Egress] [app=web] []"#,
                r#"allow-api-to-db Kubernetes "payments" [Egress] [app=api] []"#,
                r#"allow-dns Kubernetes "payments" [Egress] [app in (web, api, db)] []"#,
                r#"allow-api-from-web Cilium "payments" [Ingress] [app=api, io.kubernetes.pod.namespace=payments] []"#,
                r#"api-egress-stripe Cilium "payments" [Egress] [app=api, io.kubernetes.pod.namespace=payments] [rules.dns]"#,
                r#"db-no-internet Cilium "payments" [Egress] [app=db, io.kubernetes.pod.namespace=payments] []"#,
                r#"allow-prometheus-scrape CiliumClusterwide "" [Ingress] [app in (web, api, db), io.kubernetes.pod.namespace=payments] []"#,
            ]
        );
        assert!(policies.iter().all(|policy| !policy.is_host()));

        let allow_dns = &policies[5];
        assert_eq!(
            allow_dns.rules,
            [PolicyRule {
                subject: Subject::Pods {
                    namespace: Some("payments".to_owned()),
                    selector: within("app", &["web", "api", "db"]),
                    cilium: false,
                },
                ingress: Vec::new(),
                egress: vec![rule(
                    vec![Peer::Pods {
                        namespaces: NamespaceScope::Selected(selector(&[(
                            "kubernetes.io/metadata.name",
                            "kube-system",
                        )])),
                        pods: selector(&[("k8s-app", "kube-dns")]),
                        cilium: false,
                    }],
                    vec![number(Protocol::Udp, 53), tcp(53)],
                )],
                ingress_deny: Vec::new(),
                egress_deny: Vec::new(),
                isolates_ingress: false,
                isolates_egress: true,
            }]
        );

        let stripe = &policies[7];
        assert_eq!(
            stripe.rules,
            [PolicyRule {
                subject: Subject::Pods {
                    namespace: Some("payments".to_owned()),
                    selector: selector(&[("app", "api"), (NAMESPACE_LABEL, "payments")]),
                    cilium: true,
                },
                ingress: Vec::new(),
                egress: vec![
                    rule(
                        vec![Peer::Fqdn {
                            name: Some("api.stripe.com".to_owned()),
                            pattern: None,
                        }],
                        vec![tcp(443)],
                    ),
                    rule(
                        vec![cilium_pods(selector(&[
                            ("k8s-app", "kube-dns"),
                            (NAMESPACE_LABEL, "kube-system"),
                        ]))],
                        vec![number(Protocol::Udp, 53)],
                    ),
                ],
                ingress_deny: Vec::new(),
                egress_deny: Vec::new(),
                isolates_ingress: false,
                isolates_egress: true,
            }],
            "the DNS rule leaves port 53 without an L7 limit"
        );
    }
}
