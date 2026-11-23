//! Which connections the policies allow, deny or leave open (spec §4.4, §4.5). `Index` reads
//! once which rules select which Pods; `verdict` then answers for two ends, a Pod or a peer
//! outside the namespace's Pods. Pure, and nothing here panics on what the policies hold.

use std::collections::{BTreeMap, HashMap};

use super::model::{
    Entity, HttpRule, NamespaceScope, Peer, Policy, PolicyId, PortValue, Protocol, Rule, Subject,
};
use super::pods::{NamespaceInfo, PodInfo};

/// The label Kubernetes puts on every namespace, holding its name. A Pod whose Namespace was
/// not read still carries it, so a `namespaceSelector` on the name keeps working.
pub(crate) const NAME_LABEL: &str = "kubernetes.io/metadata.name";
/// The CIDRs that hold every address: a rule naming one names "Outside the cluster".
const ALL_ADDRESSES: [&str; 2] = ["0.0.0.0/0", "::/0"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Isolation {
    pub ingress: bool,
    pub egress: bool,
}

/// A peer outside the namespace's Pods. `OtherPods` and `World` are the two catch-alls.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Outside {
    Cidr {
        cidr: String,
        except: Vec<String>,
    },
    Entity(Entity),
    Fqdn {
        name: Option<String>,
        pattern: Option<String>,
    },
    OtherPods,
    World,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum End {
    Pod(usize),
    Outside(Outside),
}

/// Ordered from least to most permissive, so `max` is the most permissive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum VerdictKind {
    Denied,
    Blocked,
    Allowed,
    Open,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Direction {
    Ingress,
    Egress,
}

/// `side` is set only when both sides limit L7 on the port.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct SideHttp {
    pub side: Option<Direction>,
    pub rule: HttpRule,
}

/// `port: None` is every port of `protocol`; `name` is a named port that did not resolve.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct PortSpan {
    pub protocol: Protocol,
    pub port: Option<u16>,
    pub end_port: Option<u16>,
    pub name: Option<String>,
    pub http: Vec<SideHttp>,
}

/// `ports` is empty for Open, Denied and Blocked. `policies`: for Allowed the allowing ones,
/// for Denied the denying ones, for Blocked the isolating ones, for Open none; sorted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Verdict {
    pub kind: VerdictKind,
    pub ports: Vec<PortSpan>,
    pub policies: Vec<PolicyId>,
}

/// The ports of a span: all of them, a range (one port is `start == end`), or a named port
/// that did not resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Ports {
    All,
    Range(u16, u16),
    Name(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Shape {
    protocol: Protocol,
    ports: Ports,
}

impl Shape {
    const EVERYTHING: Shape = Shape {
        protocol: Protocol::Any,
        ports: Ports::All,
    };

    fn of(span: &PortSpan) -> Shape {
        let ports = match (span.port, &span.name) {
            (Some(port), _) => Ports::Range(port, span.end_port.unwrap_or(port).max(port)),
            (None, Some(name)) => Ports::Name(name.clone()),
            (None, None) => Ports::All,
        };
        Shape {
            protocol: span.protocol,
            ports,
        }
    }

    /// What both shapes take in, if anything. `Any` is TCP, UDP and SCTP.
    fn meet(&self, other: &Shape) -> Option<Shape> {
        let protocol = match (self.protocol, other.protocol) {
            (Protocol::Any, protocol) | (protocol, Protocol::Any) => protocol,
            (one, two) if one == two => one,
            _ => return None,
        };
        let ports = match (&self.ports, &other.ports) {
            (Ports::All, ports) | (ports, Ports::All) => ports.clone(),
            (Ports::Range(a, b), Ports::Range(c, d)) => {
                let (start, end) = ((*a).max(*c), (*b).min(*d));
                if start > end {
                    return None;
                }
                Ports::Range(start, end)
            }
            (Ports::Name(one), Ports::Name(two)) if one == two => Ports::Name(one.clone()),
            _ => return None,
        };
        Some(Shape { protocol, ports })
    }

    /// Whether this shape takes in all of `other`.
    fn covers(&self, other: &Shape) -> bool {
        let protocol = self.protocol == Protocol::Any || self.protocol == other.protocol;
        let ports = match (&self.ports, &other.ports) {
            (Ports::All, _) => true,
            (Ports::Range(a, b), Ports::Range(c, d)) => a <= c && d <= b,
            (Ports::Name(one), Ports::Name(two)) => one == two,
            _ => false,
        };
        protocol && ports
    }

    fn span(&self, http: Vec<SideHttp>) -> PortSpan {
        let (port, end_port, name) = match &self.ports {
            Ports::All => (None, None, None),
            Ports::Range(start, end) => (Some(*start), (end > start).then_some(*end), None),
            Ports::Name(name) => (None, None, Some(name.clone())),
        };
        PortSpan {
            protocol: self.protocol,
            port,
            end_port,
            name,
            http,
        }
    }
}

/// What one allowing rule lets through on its ports. `http: None` is every request.
#[derive(Debug, Clone)]
struct Atom {
    shape: Shape,
    http: Option<Vec<HttpRule>>,
}

/// What one Pod's policies say of a connection in one direction.
struct Side {
    isolated: bool,
    /// Each policy with an allowing rule that names the other end, and what its rules let
    /// through, by policy index ascending.
    allows: Vec<(usize, Vec<Atom>)>,
    /// The policies with a deny rule that names the other end.
    denies: Vec<usize>,
    /// The policies that isolate the Pod in this direction.
    isolating: Vec<usize>,
}

impl Side {
    /// What the side lets through: `None` when it is not isolated, so everything passes.
    fn atoms(&self) -> Option<Vec<Atom>> {
        self.isolated.then(|| {
            self.allows
                .iter()
                .flat_map(|(_, atoms)| atoms.iter().cloned())
                .collect()
        })
    }
}

/// Owns its inputs. `new` precomputes which rules select which Pods.
#[derive(Debug)]
pub(crate) struct Index {
    policies: Vec<Policy>,
    pods: Vec<PodInfo>,
    namespaces: Vec<NamespaceInfo>,
    /// The labels of each namespace a Pod is in, and which of them each Pod's is.
    namespace_labels: Vec<BTreeMap<String, String>>,
    pod_namespace: Vec<usize>,
    /// Each Pod's labels as Cilium sees them (spec §4.1).
    cilium_labels: Vec<BTreeMap<String, String>>,
    /// Pods with the same signature get the same verdicts (spec §5.1).
    signatures: Vec<usize>,
    selected: Vec<Vec<usize>>,
    policies_of: Vec<Vec<usize>>,
    /// The (policy, rule) pairs whose subject selects each Pod, ascending.
    rules_of: Vec<Vec<(usize, usize)>>,
    isolation: Vec<Isolation>,
    /// The policies that isolate each Pod for ingress, then for egress.
    isolating: Vec<[Vec<usize>; 2]>,
}

/// Two indexes are equal when they were made from equal inputs: the rest follows from them.
impl PartialEq for Index {
    fn eq(&self, other: &Self) -> bool {
        self.policies == other.policies
            && self.pods == other.pods
            && self.namespaces == other.namespaces
    }
}

fn push_once(list: &mut Vec<usize>, value: usize) {
    if list.last() != Some(&value) {
        list.push(value);
    }
}

/// A peer that takes in every Pod of the cluster: the entities `all` and `cluster`, or every
/// Pod of every namespace. Only such a peer names "Other Pods in the cluster".
pub(crate) fn names_every_pod(peer: &Peer) -> bool {
    match peer {
        Peer::Entity(entity) => matches!(entity, Entity::All | Entity::Cluster),
        Peer::Pods {
            namespaces, pods, ..
        } => {
            pods.is_everything()
                && match namespaces {
                    NamespaceScope::Any => true,
                    NamespaceScope::Selected(selector) => selector.is_everything(),
                    NamespaceScope::Only(_) => false,
                }
        }
        Peer::Cidr { .. } | Peer::Fqdn { .. } => false,
    }
}

/// Whether `peer` names the outside end (spec §4.4). A CIDR, entity or DNS name end is named
/// only by rules that name it, by `world` (for every address outside the cluster) and by
/// `all`; a CIDR end matches a rule with the same `cidr`, whatever its `except`.
fn names_outside(peer: &Peer, outside: &Outside) -> bool {
    match (peer, outside) {
        (Peer::Entity(Entity::All), _) => true,
        (peer, Outside::OtherPods) => names_every_pod(peer),
        (
            Peer::Entity(Entity::World),
            Outside::World | Outside::Cidr { .. } | Outside::Fqdn { .. },
        ) => true,
        (Peer::Cidr { cidr, .. }, Outside::World) => ALL_ADDRESSES.contains(&cidr.as_str()),
        (Peer::Cidr { cidr, .. }, Outside::Cidr { cidr: end, .. }) => cidr == end,
        (Peer::Entity(entity), Outside::Entity(end)) => entity == end,
        (
            Peer::Fqdn { name, pattern },
            Outside::Fqdn {
                name: end_name,
                pattern: end_pattern,
            },
        ) => name == end_name && pattern == end_pattern,
        _ => false,
    }
}

/// The union of HTTP rules, where an empty list (every request) wins.
fn join_http(one: &[SideHttp], two: &[SideHttp]) -> Vec<SideHttp> {
    if one.is_empty() || two.is_empty() {
        return Vec::new();
    }
    let mut http: Vec<SideHttp> = one.iter().chain(two).cloned().collect();
    http.sort();
    http.dedup();
    http
}

/// Port spans united (contract C13): spans of the same protocol and ports become one, a span
/// that another one takes in with the same or no HTTP rules leaves (so an ANY span absorbs the
/// TCP, UDP and SCTP spans of its range), and the rest are sorted by port, then protocol.
pub(crate) fn unite(spans: Vec<PortSpan>) -> Vec<PortSpan> {
    let mut united: Vec<PortSpan> = Vec::new();
    for span in spans {
        let shape = Shape::of(&span);
        match united.iter_mut().find(|kept| Shape::of(kept) == shape) {
            Some(kept) => kept.http = join_http(&kept.http, &span.http),
            None => united.push(span),
        }
    }
    let shapes: Vec<Shape> = united.iter().map(Shape::of).collect();
    let mut kept: Vec<PortSpan> = united
        .iter()
        .enumerate()
        .filter(|(i, span)| {
            !united.iter().enumerate().any(|(j, other)| {
                j != *i
                    && shapes[j].covers(&shapes[*i])
                    && (other.http.is_empty() || other.http == span.http)
            })
        })
        .map(|(_, span)| span.clone())
        .collect();
    kept.sort_by(|a, b| {
        (a.port, a.end_port, &a.name, a.protocol).cmp(&(b.port, b.end_port, &b.name, b.protocol))
    });
    kept
}

/// What a side lets through of HTTP on `shape`: `None` when a rule that covers it has no HTTP
/// rules (spec §4.5, last bullet), else the union of their HTTP rules.
fn http_on(atoms: &[Atom], shape: &Shape) -> Option<Vec<HttpRule>> {
    let mut rules = Vec::new();
    for atom in atoms.iter().filter(|atom| atom.shape.covers(shape)) {
        rules.extend(atom.http.as_ref()?.iter().cloned());
    }
    (!rules.is_empty()).then_some(rules)
}

/// The spans both sides let through. `None` is a side that is not isolated, or that does not
/// count: it lets everything through.
fn allowed(source: Option<&[Atom]>, destination: Option<&[Atom]>) -> Vec<PortSpan> {
    let candidates: Vec<Shape> = match (source, destination) {
        (Some(source), Some(destination)) => source
            .iter()
            .flat_map(|one| {
                destination
                    .iter()
                    .filter_map(move |two| one.shape.meet(&two.shape))
            })
            .collect(),
        (Some(atoms), None) | (None, Some(atoms)) => {
            atoms.iter().map(|atom| atom.shape.clone()).collect()
        }
        (None, None) => vec![Shape::EVERYTHING],
    };
    let mut shapes: Vec<Shape> = Vec::new();
    for shape in candidates {
        if !shapes.contains(&shape) {
            shapes.push(shape);
        }
    }
    let spans = shapes
        .iter()
        .map(|shape| {
            let egress = source.and_then(|atoms| http_on(atoms, shape));
            let ingress = destination.and_then(|atoms| http_on(atoms, shape));
            let both = egress.is_some() && ingress.is_some();
            let mut http: Vec<SideHttp> = Vec::new();
            for (direction, rules) in [(Direction::Egress, egress), (Direction::Ingress, ingress)] {
                for rule in rules.into_iter().flatten() {
                    let side = both.then_some(direction);
                    http.push(SideHttp { side, rule });
                }
            }
            http.sort();
            http.dedup();
            shape.span(http)
        })
        .collect();
    unite(spans)
}

impl Index {
    /// Reads once which rules select which Pods, each Pod's isolation, its namespace's labels,
    /// its Cilium labels (spec §4.1) and its signature.
    pub(crate) fn new(
        policies: Vec<Policy>,
        pods: Vec<PodInfo>,
        namespaces: Vec<NamespaceInfo>,
    ) -> Index {
        let mut namespace_labels: Vec<BTreeMap<String, String>> = Vec::new();
        let mut slots: HashMap<String, usize> = HashMap::new();
        for namespace in &namespaces {
            let mut labels = namespace.labels.clone();
            labels
                .entry(NAME_LABEL.to_owned())
                .or_insert_with(|| namespace.name.clone());
            slots.entry(namespace.name.clone()).or_insert_with(|| {
                namespace_labels.push(labels);
                namespace_labels.len() - 1
            });
        }
        let mut pod_namespace = Vec::with_capacity(pods.len());
        let mut cilium_labels = Vec::with_capacity(pods.len());
        let mut classes = HashMap::new();
        let mut signatures = Vec::with_capacity(pods.len());
        for pod in &pods {
            let slot = *slots.entry(pod.namespace.clone()).or_insert_with(|| {
                let labels = BTreeMap::from([(NAME_LABEL.to_owned(), pod.namespace.clone())]);
                namespace_labels.push(labels);
                namespace_labels.len() - 1
            });
            pod_namespace.push(slot);
            let namespace = NamespaceInfo {
                name: pod.namespace.clone(),
                labels: namespace_labels[slot].clone(),
            };
            cilium_labels.push(pod.cilium_labels(Some(&namespace)));
            let ports: Vec<(Option<String>, u16, Protocol)> = pod
                .ports
                .iter()
                .map(|port| (port.name.clone(), port.port, port.protocol))
                .collect();
            let key = (
                pod.namespace.clone(),
                pod.labels.clone(),
                pod.service_account.clone(),
                ports,
            );
            let next = classes.len();
            signatures.push(*classes.entry(key).or_insert(next));
        }

        let mut selected = vec![Vec::new(); policies.len()];
        let mut policies_of = vec![Vec::new(); pods.len()];
        let mut rules_of = vec![Vec::new(); pods.len()];
        let mut isolation = vec![Isolation::default(); pods.len()];
        let mut isolating = vec![[Vec::new(), Vec::new()]; pods.len()];
        for (p, policy) in policies.iter().enumerate() {
            for (r, rule) in policy.rules.iter().enumerate() {
                let Subject::Pods {
                    namespace,
                    selector,
                    cilium,
                } = &rule.subject
                else {
                    continue;
                };
                for (d, pod) in pods.iter().enumerate() {
                    if namespace
                        .as_ref()
                        .is_some_and(|name| *name != pod.namespace)
                    {
                        continue;
                    }
                    let labels = if *cilium {
                        &cilium_labels[d]
                    } else {
                        &pod.labels
                    };
                    if !selector.matches(labels) {
                        continue;
                    }
                    selected[p].push(d);
                    push_once(&mut policies_of[d], p);
                    rules_of[d].push((p, r));
                    if rule.isolates_ingress {
                        isolation[d].ingress = true;
                        push_once(&mut isolating[d][0], p);
                    }
                    if rule.isolates_egress {
                        isolation[d].egress = true;
                        push_once(&mut isolating[d][1], p);
                    }
                }
            }
        }
        for pods in &mut selected {
            pods.sort_unstable();
            pods.dedup();
        }
        Index {
            policies,
            pods,
            namespaces,
            namespace_labels,
            pod_namespace,
            cilium_labels,
            signatures,
            selected,
            policies_of,
            rules_of,
            isolation,
            isolating,
        }
    }

    pub(crate) fn policies(&self) -> &[Policy] {
        &self.policies
    }

    pub(crate) fn pods(&self) -> &[PodInfo] {
        &self.pods
    }

    /// The Namespace named `name`, when it was read. Only tests call it.
    #[cfg(test)]
    pub(crate) fn namespace(&self, name: &str) -> Option<&NamespaceInfo> {
        self.namespaces
            .iter()
            .find(|namespace| namespace.name == name)
    }

    /// Indices of the Pods a Pod rule of `policy` selects, ascending. Host rules select none.
    pub(crate) fn selected_pods(&self, policy: usize) -> &[usize] {
        self.selected.get(policy).map_or(&[], Vec::as_slice)
    }

    /// Indices of the policies with a rule that selects `pod`, ascending.
    pub(crate) fn policies_of(&self, pod: usize) -> &[usize] {
        self.policies_of.get(pod).map_or(&[], Vec::as_slice)
    }

    /// The (policy, rule) pairs whose subject selects `pod`, ascending.
    pub(crate) fn rules_of(&self, pod: usize) -> &[(usize, usize)] {
        self.rules_of.get(pod).map_or(&[], Vec::as_slice)
    }

    pub(crate) fn isolation(&self, pod: usize) -> Isolation {
        self.isolation.get(pod).copied().unwrap_or_default()
    }

    /// Pods of one signature (namespace, labels, service account and container ports) get the
    /// same verdicts, so a group evaluates one of them (spec §5.1).
    pub(crate) fn signature(&self, pod: usize) -> usize {
        self.signatures.get(pod).copied().unwrap_or(usize::MAX)
    }

    /// Whether `peer` takes in the Pod (spec §4.2 to §4.4).
    pub(crate) fn peer_selects(&self, peer: &Peer, pod: usize) -> bool {
        let Some(info) = self.pods.get(pod) else {
            return false;
        };
        match peer {
            Peer::Pods {
                namespaces,
                pods,
                cilium,
            } => {
                let in_scope = match namespaces {
                    NamespaceScope::Only(name) => *name == info.namespace,
                    NamespaceScope::Selected(selector) => {
                        selector.matches(&self.namespace_labels[self.pod_namespace[pod]])
                    }
                    NamespaceScope::Any => true,
                };
                let labels = if *cilium {
                    &self.cilium_labels[pod]
                } else {
                    &info.labels
                };
                in_scope && pods.matches(labels)
            }
            Peer::Entity(entity) => matches!(entity, Entity::All | Entity::Cluster),
            Peer::Cidr { .. } | Peer::Fqdn { .. } => false,
        }
    }

    /// An entry with no peers names every end.
    fn names(&self, entry: &Rule, end: &End) -> bool {
        entry.peers.is_empty()
            || entry.peers.iter().any(|peer| match end {
                End::Pod(pod) => self.peer_selects(peer, *pod),
                End::Outside(outside) => names_outside(peer, outside),
            })
    }

    /// What an entry lets through toward `destination`. No ports is every port and protocol.
    /// A named port resolves against the destination Pod's container ports, by name and
    /// protocol, and lets nothing through when none has it; toward an outside end it stays a
    /// name. An `endPort` below `port` is ignored.
    fn atoms(&self, entry: &Rule, destination: Option<usize>) -> Vec<Atom> {
        if entry.ports.is_empty() {
            let atom = Atom {
                shape: Shape::EVERYTHING,
                http: None,
            };
            return vec![atom];
        }
        let mut atoms = Vec::new();
        for rule in &entry.ports {
            let http = (!rule.http.is_empty()).then(|| rule.http.clone());
            let mut push = |protocol: Protocol, ports: Ports| {
                let shape = Shape { protocol, ports };
                let http = http.clone();
                atoms.push(Atom { shape, http });
            };
            match (&rule.port, destination) {
                (None, _) => push(rule.protocol, Ports::All),
                (Some(PortValue::Number(port)), _) => {
                    let end = rule.end_port.filter(|end| end > port).unwrap_or(*port);
                    push(rule.protocol, Ports::Range(*port, end));
                }
                (Some(PortValue::Name(name)), None) => {
                    push(rule.protocol, Ports::Name(name.clone()))
                }
                (Some(PortValue::Name(name)), Some(pod)) => {
                    let ports = self.pods.get(pod).map_or(&[][..], |pod| &pod.ports[..]);
                    for port in ports {
                        let protocol =
                            rule.protocol == Protocol::Any || rule.protocol == port.protocol;
                        if protocol && port.name.as_deref() == Some(name.as_str()) {
                            push(port.protocol, Ports::Range(port.port, port.port));
                        }
                    }
                }
            }
        }
        atoms
    }

    /// The side of `pod` in `direction` toward the other end.
    fn side(&self, pod: usize, direction: Direction, other: &End) -> Side {
        let destination = match (direction, other) {
            (Direction::Ingress, _) => Some(pod),
            (Direction::Egress, End::Pod(other)) => Some(*other),
            (Direction::Egress, End::Outside(_)) => None,
        };
        let mut allows: Vec<(usize, Vec<Atom>)> = Vec::new();
        let mut denies = Vec::new();
        for &(p, r) in self.rules_of(pod) {
            let rule = &self.policies[p].rules[r];
            let (allow, deny) = match direction {
                Direction::Ingress => (&rule.ingress, &rule.ingress_deny),
                Direction::Egress => (&rule.egress, &rule.egress_deny),
            };
            for entry in allow.iter().filter(|entry| self.names(entry, other)) {
                let atoms = self.atoms(entry, destination);
                if atoms.is_empty() {
                    continue;
                }
                match allows.last_mut() {
                    Some((last, list)) if *last == p => list.extend(atoms),
                    _ => allows.push((p, atoms)),
                }
            }
            let denying = deny.iter().any(|entry| {
                self.names(entry, other) && !self.atoms(entry, destination).is_empty()
            });
            if denying {
                push_once(&mut denies, p);
            }
        }
        let isolation = self.isolation(pod);
        let (isolated, isolating) = match direction {
            Direction::Ingress => (isolation.ingress, 0),
            Direction::Egress => (isolation.egress, 1),
        };
        Side {
            isolated,
            allows,
            denies,
            isolating: self
                .isolating
                .get(pod)
                .map_or_else(Vec::new, |lists| lists[isolating].clone()),
        }
    }

    fn ids(&self, policies: impl IntoIterator<Item = usize>) -> Vec<PolicyId> {
        let mut ids: Vec<PolicyId> = policies
            .into_iter()
            .filter_map(|p| self.policies.get(p).map(|policy| policy.id.clone()))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Spec §4.5. Between two Pods both sides count; with an `Outside` end only the Pod's side.
    /// A deny rule that names the other end, on a port the destination has, denies the pair
    /// whatever else passes: the matrix has one verdict per pair. Two outside ends are not
    /// evaluated and read as Open.
    pub(crate) fn verdict(&self, from: &End, to: &End) -> Verdict {
        let source = match from {
            End::Pod(pod) => Some(self.side(*pod, Direction::Egress, to)),
            End::Outside(_) => None,
        };
        let destination = match to {
            End::Pod(pod) => Some(self.side(*pod, Direction::Ingress, from)),
            End::Outside(_) => None,
        };
        let sides: Vec<&Side> = source.iter().chain(destination.iter()).collect();
        let verdict = |kind: VerdictKind, policies: Vec<PolicyId>| Verdict {
            kind,
            ports: Vec::new(),
            policies,
        };
        let denying: Vec<usize> = sides.iter().flat_map(|side| side.denies.clone()).collect();
        if !denying.is_empty() {
            return verdict(VerdictKind::Denied, self.ids(denying));
        }
        if sides.iter().all(|side| !side.isolated) {
            return verdict(VerdictKind::Open, Vec::new());
        }
        let blocked = || {
            let isolating = sides
                .iter()
                .filter(|side| side.isolated)
                .flat_map(|side| side.isolating.clone());
            verdict(VerdictKind::Blocked, self.ids(isolating))
        };
        if sides
            .iter()
            .any(|side| side.isolated && side.allows.is_empty())
        {
            return blocked();
        }
        let source_atoms = source.as_ref().and_then(Side::atoms);
        let destination_atoms = destination.as_ref().and_then(Side::atoms);
        let ports = allowed(source_atoms.as_deref(), destination_atoms.as_deref());
        if ports.is_empty() {
            return blocked();
        }
        let shapes: Vec<Shape> = ports.iter().map(Shape::of).collect();
        let allowing = sides.iter().flat_map(|side| {
            side.allows
                .iter()
                .filter(|(_, atoms)| {
                    atoms
                        .iter()
                        .any(|atom| shapes.iter().any(|shape| atom.shape.meet(shape).is_some()))
                })
                .map(|(p, _)| *p)
        });
        Verdict {
            kind: VerdictKind::Allowed,
            policies: self.ids(allowing),
            ports,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::netpol::model::PolicySource;
    use crate::netpol::parse::parse_policy;
    use crate::netpol::pods::ContainerPort;

    fn k8s(object: Value) -> Policy {
        parse_policy(PolicySource::Kubernetes, &object).unwrap()
    }

    fn cilium(object: Value) -> Policy {
        parse_policy(PolicySource::Cilium, &object).unwrap()
    }

    fn cluster(object: Value) -> Policy {
        parse_policy(PolicySource::CiliumClusterwide, &object).unwrap()
    }

    fn meta(namespace: &str, name: &str) -> Value {
        json!({ "name": name, "namespace": namespace })
    }

    fn pod(namespace: &str, name: &str, labels: &[(&str, &str)]) -> PodInfo {
        PodInfo {
            namespace: namespace.into(),
            name: name.into(),
            labels: labels
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            service_account: "default".into(),
            ports: Vec::new(),
            owner: None,
            finished: false,
        }
    }

    fn with_port(mut pod: PodInfo, name: &str, port: u16, protocol: Protocol) -> PodInfo {
        pod.ports.push(ContainerPort {
            name: Some(name.into()),
            port,
            protocol,
        });
        pod
    }

    fn namespace(name: &str, labels: &[(&str, &str)]) -> NamespaceInfo {
        NamespaceInfo {
            name: name.into(),
            labels: labels
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        }
    }

    fn tcp(port: u16) -> PortSpan {
        span(Protocol::Tcp, Some(port), None)
    }

    fn span(protocol: Protocol, port: Option<u16>, end_port: Option<u16>) -> PortSpan {
        PortSpan {
            protocol,
            port,
            end_port,
            name: None,
            http: Vec::new(),
        }
    }

    fn http(method: &str, path: &str) -> HttpRule {
        HttpRule {
            method: Some(method.into()),
            path: Some(path.into()),
            host: None,
            headers: Vec::new(),
        }
    }

    fn get(path: &str, side: Option<Direction>) -> SideHttp {
        SideHttp {
            side,
            rule: http("GET", path),
        }
    }

    /// Each verdict as (kind, ports, policy names).
    fn said(verdict: &Verdict) -> (VerdictKind, Vec<PortSpan>, Vec<&str>) {
        let names = verdict.policies.iter().map(|id| id.name.as_str()).collect();
        (verdict.kind, verdict.ports.clone(), names)
    }

    fn between(index: &Index, from: usize, to: usize) -> Verdict {
        index.verdict(&End::Pod(from), &End::Pod(to))
    }

    fn to_outside(index: &Index, from: usize, to: Outside) -> VerdictKind {
        index.verdict(&End::Pod(from), &End::Outside(to)).kind
    }

    fn from_outside(index: &Index, from: Outside, to: usize) -> VerdictKind {
        index.verdict(&End::Outside(from), &End::Pod(to)).kind
    }

    /// web (0) and api (1) in `a`, and other (2) in `b`.
    fn three_pods() -> Vec<PodInfo> {
        vec![
            pod("a", "web", &[("app", "web")]),
            with_port(
                pod("a", "api", &[("app", "api")]),
                "http",
                8080,
                Protocol::Tcp,
            ),
            pod("b", "other", &[("app", "web")]),
        ]
    }

    fn deny_all_ingress(name: &str, app: &str) -> Policy {
        k8s(json!({
            "metadata": meta("a", name),
            "spec": { "podSelector": { "matchLabels": { "app": app } }, "policyTypes": ["Ingress"] },
        }))
    }

    /// Spec §5.1: Pods alike in namespace, labels, service account and container ports share a
    /// signature, so a group evaluates one of them.
    #[test]
    fn pods_alike_share_a_signature() {
        let mut other_account = pod("a", "api-5", &[("app", "api")]);
        other_account.service_account = "api".into();
        let pods = vec![
            with_port(
                pod("a", "api-1", &[("app", "api")]),
                "http",
                8080,
                Protocol::Tcp,
            ),
            with_port(
                pod("a", "api-2", &[("app", "api")]),
                "http",
                8080,
                Protocol::Tcp,
            ),
            with_port(
                pod("a", "api-3", &[("app", "api")]),
                "http",
                8081,
                Protocol::Tcp,
            ),
            with_port(
                pod("b", "api-4", &[("app", "api")]),
                "http",
                8080,
                Protocol::Tcp,
            ),
            with_port(other_account, "http", 8080, Protocol::Tcp),
            with_port(
                pod("a", "api-6", &[("app", "api"), ("v", "2")]),
                "http",
                8080,
                Protocol::Tcp,
            ),
        ];
        let index = Index::new(Vec::new(), pods, Vec::new());
        assert_eq!(index.pods().len(), 6);
        assert_eq!(index.pods()[2].name, "api-3");
        let signatures: Vec<usize> = (0..6).map(|pod| index.signature(pod)).collect();
        assert_eq!(signatures[0], signatures[1]);
        for other in 2..6 {
            assert_ne!(signatures[0], signatures[other], "{other}");
        }
    }

    /// Spec §4.2, §4.3, §4.5: a Pod is isolated in a direction when any rule that selects it
    /// isolates it there; a policy of another namespace does not select it.
    #[test]
    fn isolation_follows_every_rule_that_selects_a_pod() {
        let index = Index::new(
            vec![
                deny_all_ingress("in", "api"),
                cilium(json!({
                    "metadata": meta("a", "out"),
                    "spec": {
                        "endpointSelector": { "matchLabels": { "app": "api" } },
                        "egress": [],
                    },
                })),
                k8s(json!({
                    "metadata": meta("b", "web-elsewhere"),
                    "spec": { "podSelector": {}, "policyTypes": ["Ingress", "Egress"] },
                })),
            ],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(index.isolation(0), Isolation::default());
        assert_eq!(
            index.isolation(1),
            Isolation {
                ingress: true,
                egress: true
            }
        );
        assert_eq!(
            index.isolation(2),
            Isolation {
                ingress: true,
                egress: true
            }
        );
        assert_eq!(index.selected_pods(0), [1]);
        assert_eq!(index.selected_pods(2), [2]);
        assert_eq!(index.policies_of(1), [0, 1]);
        assert_eq!(index.policies_of(0), [] as [usize; 0]);
        assert_eq!(between(&index, 0, 0).kind, VerdictKind::Open);
        assert_eq!(
            said(&between(&index, 0, 1)),
            (VerdictKind::Blocked, vec![], vec!["in"])
        );
        assert_eq!(
            said(&between(&index, 1, 0)),
            (VerdictKind::Blocked, vec![], vec!["out"])
        );
    }

    #[test]
    fn selected_pods_are_ascending_however_many_rules_select_them() {
        let index = Index::new(
            vec![cilium(json!({
                "metadata": meta("a", "two"),
                "specs": [
                    { "endpointSelector": { "matchLabels": { "app": "api" } }, "ingress": [{}] },
                    { "endpointSelector": { "matchLabels": { "app": "web" } }, "ingress": [{}] },
                ],
            }))],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(index.selected_pods(0), [0, 1]);
        assert_eq!(index.rules_of(0), [(0, 1)]);
        assert_eq!(index.rules_of(1), [(0, 0)]);
        assert_eq!(index.selected_pods(5), [] as [usize; 0]);
    }

    /// Spec §4.5: the allowed set of a side is the union of every allowing rule of every
    /// policy that selects the Pod, NetworkPolicies and Cilium policies alike.
    #[test]
    fn allowed_ports_unite_across_policies_of_both_kinds() {
        let index = Index::new(
            vec![
                k8s(json!({
                    "metadata": meta("a", "k8s-8080"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "api" } },
                        "ingress": [{
                            "from": [{ "podSelector": { "matchLabels": { "app": "web" } } }],
                            "ports": [{ "port": 8080 }],
                        }],
                    },
                })),
                cilium(json!({
                    "metadata": meta("a", "cilium-9090"),
                    "spec": {
                        "endpointSelector": { "matchLabels": { "app": "api" } },
                        "ingress": [{
                            "fromEndpoints": [{ "matchLabels": { "app": "web" } }],
                            "toPorts": [{ "ports": [{ "port": "9090", "protocol": "TCP" }] }],
                        }],
                    },
                })),
            ],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(
            said(&between(&index, 0, 1)),
            (
                VerdictKind::Allowed,
                vec![tcp(8080), tcp(9090)],
                vec!["k8s-8080", "cilium-9090"]
            )
        );
        // The Pod of `b` has the same labels, but neither rule names its namespace.
        assert_eq!(between(&index, 2, 1).kind, VerdictKind::Blocked);
    }

    /// Spec §4.5: both sides must allow, and the ports are the intersection of both sides'.
    #[test]
    fn both_sides_must_allow_and_the_ports_intersect() {
        let egress = |name: &str, ports: Value| {
            k8s(json!({
                "metadata": meta("a", name),
                "spec": {
                    "podSelector": { "matchLabels": { "app": "web" } },
                    "policyTypes": ["Egress"],
                    "egress": [{ "to": [{ "podSelector": { "matchLabels": { "app": "api" } } }], "ports": ports }],
                },
            }))
        };
        let ingress = |name: &str, ports: Value| {
            k8s(json!({
                "metadata": meta("a", name),
                "spec": {
                    "podSelector": { "matchLabels": { "app": "api" } },
                    "ingress": [{ "from": [{ "podSelector": { "matchLabels": { "app": "web" } } }], "ports": ports }],
                },
            }))
        };
        let index = Index::new(
            vec![
                egress(
                    "web-out",
                    json!([{ "port": 8000, "endPort": 8100 }, { "port": 443 }]),
                ),
                ingress("api-in", json!([{ "port": 8080 }, { "port": 9000 }])),
            ],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(
            said(&between(&index, 0, 1)),
            (
                VerdictKind::Allowed,
                vec![tcp(8080)],
                vec!["api-in", "web-out"]
            )
        );

        let index = Index::new(
            vec![
                egress("web-out", json!([{ "port": 80 }])),
                ingress("api-in", json!([{ "port": 443 }])),
            ],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(
            said(&between(&index, 0, 1)),
            (VerdictKind::Blocked, vec![], vec!["api-in", "web-out"])
        );

        // A side that is not isolated lets everything through: the other side's ports stand.
        let index = Index::new(
            vec![ingress("api-in", json!([{ "port": 443 }]))],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(
            said(&between(&index, 0, 1)),
            (VerdictKind::Allowed, vec![tcp(443)], vec!["api-in"])
        );
    }

    /// Review Focus 4: a named port resolves against each destination Pod's container ports,
    /// by name and protocol.
    #[test]
    fn a_named_port_resolves_against_each_destination_pod() {
        let pods = vec![
            pod("a", "web", &[("app", "web")]),
            with_port(
                pod("a", "api-1", &[("app", "api")]),
                "http",
                8080,
                Protocol::Tcp,
            ),
            with_port(
                pod("a", "api-2", &[("app", "api")]),
                "http",
                8081,
                Protocol::Tcp,
            ),
            pod("a", "api-3", &[("app", "api")]),
            with_port(
                pod("a", "api-4", &[("app", "api")]),
                "http",
                8082,
                Protocol::Udp,
            ),
        ];
        let index = Index::new(
            vec![k8s(json!({
                "metadata": meta("a", "api-http"),
                "spec": {
                    "podSelector": { "matchLabels": { "app": "api" } },
                    "ingress": [{
                        "from": [{ "podSelector": { "matchLabels": { "app": "web" } } }],
                        "ports": [{ "port": "http" }],
                    }],
                },
            }))],
            pods,
            Vec::new(),
        );
        assert_eq!(
            said(&between(&index, 0, 1)),
            (VerdictKind::Allowed, vec![tcp(8080)], vec!["api-http"])
        );
        assert_eq!(
            said(&between(&index, 0, 2)),
            (VerdictKind::Allowed, vec![tcp(8081)], vec!["api-http"])
        );
        assert_eq!(
            said(&between(&index, 0, 3)),
            (VerdictKind::Blocked, vec![], vec!["api-http"])
        );
        // The policy's port is TCP; the container's `http` is UDP.
        assert_eq!(between(&index, 0, 4).kind, VerdictKind::Blocked);
    }

    /// Review Focus 4: on egress toward a CIDR, a named port stays a name.
    #[test]
    fn a_named_port_to_a_cidr_stays_a_name() {
        let index = Index::new(
            vec![k8s(json!({
                "metadata": meta("a", "web-out"),
                "spec": {
                    "podSelector": { "matchLabels": { "app": "web" } },
                    "policyTypes": ["Egress"],
                    "egress": [{
                        "to": [{ "ipBlock": { "cidr": "10.0.0.0/8" } }],
                        "ports": [{ "port": "https" }],
                    }],
                },
            }))],
            three_pods(),
            Vec::new(),
        );
        let cidr = Outside::Cidr {
            cidr: "10.0.0.0/8".into(),
            except: Vec::new(),
        };
        let verdict = index.verdict(&End::Pod(0), &End::Outside(cidr));
        let mut https = span(Protocol::Tcp, None, None);
        https.name = Some("https".into());
        assert_eq!(
            said(&verdict),
            (VerdictKind::Allowed, vec![https], vec!["web-out"])
        );
    }

    /// Spec §4.2: `endPort` makes a range, and ranges intersect as ranges.
    #[test]
    fn an_end_port_makes_a_range_and_ranges_intersect() {
        let index = Index::new(
            vec![
                k8s(json!({
                    "metadata": meta("a", "web-out"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "web" } },
                        "policyTypes": ["Egress"],
                        "egress": [{ "ports": [{ "port": 8000, "endPort": 8080 }] }],
                    },
                })),
                k8s(json!({
                    "metadata": meta("a", "api-in"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "api" } },
                        "ingress": [{ "ports": [{ "port": 8050, "endPort": 9000 }, { "port": 7000, "endPort": 6000 }] }],
                    },
                })),
            ],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(
            said(&between(&index, 0, 1)),
            (
                VerdictKind::Allowed,
                vec![span(Protocol::Tcp, Some(8050), Some(8080))],
                vec!["api-in", "web-out"]
            )
        );
        // An `endPort` below `port` is the port alone.
        assert_eq!(
            said(&between(&index, 2, 1)),
            (
                VerdictKind::Allowed,
                vec![tcp(7000), span(Protocol::Tcp, Some(8050), Some(9000))],
                vec!["api-in"]
            )
        );
    }

    /// Spec §4.2: `podSelector` alone is the policy's namespace, `namespaceSelector` alone is
    /// every Pod of the matching namespaces, both are matching Pods there.
    #[test]
    fn namespace_selectors_match_the_namespace_labels() {
        let peer_policy = |name: &str, peer: Value| {
            k8s(json!({
                "metadata": meta("a", name),
                "spec": {
                    "podSelector": { "matchLabels": { "app": "api" } },
                    "ingress": [{ "from": [peer] }],
                },
            }))
        };
        let pods = vec![
            with_port(
                pod("a", "api", &[("app", "api")]),
                "http",
                8080,
                Protocol::Tcp,
            ),
            pod("team-a", "client", &[("app", "client")]),
            pod("team-a", "other", &[("app", "other")]),
            pod("team-b", "client", &[("app", "client")]),
            pod("unlisted", "client", &[("app", "client")]),
        ];
        let namespaces = vec![
            namespace("team-a", &[("team", "a")]),
            namespace("team-b", &[("team", "b")]),
        ];
        let both = peer_policy(
            "both",
            json!({
                "namespaceSelector": { "matchLabels": { "team": "a" } },
                "podSelector": { "matchLabels": { "app": "client" } },
            }),
        );
        let index = Index::new(vec![both], pods.clone(), namespaces.clone());
        let kinds: Vec<VerdictKind> = (1..5).map(|from| between(&index, from, 0).kind).collect();
        assert_eq!(
            kinds,
            [
                VerdictKind::Allowed,
                VerdictKind::Blocked,
                VerdictKind::Blocked,
                VerdictKind::Blocked
            ]
        );

        let alone = peer_policy(
            "alone",
            json!({ "namespaceSelector": { "matchLabels": { "team": "a" } } }),
        );
        let index = Index::new(vec![alone], pods.clone(), namespaces.clone());
        let kinds: Vec<VerdictKind> = (1..5).map(|from| between(&index, from, 0).kind).collect();
        assert_eq!(
            kinds,
            [
                VerdictKind::Allowed,
                VerdictKind::Allowed,
                VerdictKind::Blocked,
                VerdictKind::Blocked
            ]
        );

        // A namespace that was not listed still has its name label.
        let by_name = peer_policy(
            "by-name",
            json!({ "namespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "unlisted" } } }),
        );
        let index = Index::new(vec![by_name], pods.clone(), namespaces.clone());
        assert_eq!(between(&index, 4, 0).kind, VerdictKind::Allowed);
        assert_eq!(between(&index, 1, 0).kind, VerdictKind::Blocked);
        assert_eq!(index.namespace("team-b"), Some(&namespaces[1]));
        assert_eq!(index.namespace("unlisted"), None);
    }

    /// Spec §4.2, §4.3: a CIDR end matches the rules with its `cidr`; the `except` is kept on
    /// the peer. Only the all-address CIDRs name "Outside the cluster".
    #[test]
    fn a_cidr_end_matches_rules_with_its_cidr() {
        let index = Index::new(
            vec![
                k8s(json!({
                    "metadata": meta("a", "web-out"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "web" } },
                        "policyTypes": ["Egress"],
                        "egress": [{ "to": [{ "ipBlock": { "cidr": "10.0.0.0/8", "except": ["10.1.0.0/16"] } }] }],
                    },
                })),
                cilium(json!({
                    "metadata": meta("a", "api-out"),
                    "spec": {
                        "endpointSelector": { "matchLabels": { "app": "api" } },
                        "egress": [{ "toCIDRSet": [{ "cidr": "0.0.0.0/0", "except": ["10.0.0.0/8"] }] }],
                    },
                })),
            ],
            three_pods(),
            Vec::new(),
        );
        let cidr = |cidr: &str, except: &[&str]| Outside::Cidr {
            cidr: cidr.into(),
            except: except.iter().map(|text| (*text).to_owned()).collect(),
        };
        assert_eq!(
            to_outside(&index, 0, cidr("10.0.0.0/8", &["10.1.0.0/16"])),
            VerdictKind::Allowed
        );
        assert_eq!(
            to_outside(&index, 0, cidr("10.0.0.0/8", &[])),
            VerdictKind::Allowed
        );
        assert_eq!(
            to_outside(&index, 0, cidr("192.168.0.0/16", &[])),
            VerdictKind::Blocked
        );
        assert_eq!(to_outside(&index, 0, Outside::World), VerdictKind::Blocked);
        assert_eq!(between(&index, 0, 1).kind, VerdictKind::Blocked);
        assert_eq!(to_outside(&index, 1, Outside::World), VerdictKind::Allowed);
        assert_eq!(
            to_outside(&index, 1, cidr("10.0.0.0/8", &[])),
            VerdictKind::Blocked
        );
        assert_eq!(
            to_outside(&index, 1, Outside::OtherPods),
            VerdictKind::Blocked
        );
    }

    /// Spec §4.4: `all` names every end; `cluster` every Pod and the other Pods; `world`
    /// everything outside the cluster; the other entities only themselves.
    #[test]
    fn entities_name_their_own_ends() {
        let egress_to = |name: &str, app: &str, entities: Value| {
            cilium(json!({
                "metadata": meta("a", name),
                "spec": {
                    "endpointSelector": { "matchLabels": { "app": app } },
                    "egress": [{ "toEntities": entities }],
                },
            }))
        };
        let pods = vec![
            pod("a", "host", &[("app", "host")]),
            pod("a", "world", &[("app", "world")]),
            pod("a", "cluster", &[("app", "cluster")]),
            pod("a", "all", &[("app", "all")]),
            pod("b", "target", &[("app", "target")]),
        ];
        let index = Index::new(
            vec![
                egress_to("to-host", "host", json!(["host"])),
                egress_to("to-world", "world", json!(["world"])),
                egress_to("to-cluster", "cluster", json!(["cluster"])),
                egress_to("to-all", "all", json!(["all"])),
            ],
            pods,
            Vec::new(),
        );
        let ends = [
            End::Pod(4),
            End::Outside(Outside::OtherPods),
            End::Outside(Outside::World),
            End::Outside(Outside::Entity(Entity::Host)),
            End::Outside(Outside::Entity(Entity::RemoteNode)),
            End::Outside(Outside::Cidr {
                cidr: "10.0.0.0/8".into(),
                except: Vec::new(),
            }),
            End::Outside(Outside::Fqdn {
                name: Some("api.stripe.com".into()),
                pattern: None,
            }),
        ];
        let allowed = |from: usize| -> Vec<bool> {
            ends.iter()
                .map(|end| index.verdict(&End::Pod(from), end).kind == VerdictKind::Allowed)
                .collect()
        };
        assert_eq!(allowed(0), [false, false, false, true, false, false, false]);
        assert_eq!(allowed(1), [false, false, true, false, false, true, true]);
        assert_eq!(allowed(2), [true, true, false, false, false, false, false]);
        assert_eq!(allowed(3), [true; 7]);
    }

    /// Spec §4.3: a DNS name end is named by the rules that name it, as written.
    #[test]
    fn an_fqdn_end_matches_rules_naming_it() {
        let index = Index::new(
            vec![cilium(json!({
                "metadata": meta("a", "stripe"),
                "spec": {
                    "endpointSelector": { "matchLabels": { "app": "api" } },
                    "egress": [{
                        "toFQDNs": [{ "matchName": "api.stripe.com" }, { "matchPattern": "*.example.com" }],
                        "toPorts": [{ "ports": [{ "port": "443", "protocol": "TCP" }] }],
                    }],
                },
            }))],
            three_pods(),
            Vec::new(),
        );
        let fqdn = |name: Option<&str>, pattern: Option<&str>| Outside::Fqdn {
            name: name.map(str::to_owned),
            pattern: pattern.map(str::to_owned),
        };
        let verdict = index.verdict(
            &End::Pod(1),
            &End::Outside(fqdn(Some("api.stripe.com"), None)),
        );
        assert_eq!(
            said(&verdict),
            (VerdictKind::Allowed, vec![tcp(443)], vec!["stripe"])
        );
        assert_eq!(
            to_outside(&index, 1, fqdn(None, Some("*.example.com"))),
            VerdictKind::Allowed
        );
        assert_eq!(
            to_outside(&index, 1, fqdn(None, Some("*.stripe.com"))),
            VerdictKind::Blocked
        );
        assert_eq!(to_outside(&index, 1, Outside::World), VerdictKind::Blocked);
    }

    /// Spec §4.5: a Cilium deny rule wins over a NetworkPolicy that allows, on either side.
    #[test]
    fn deny_over_allow() {
        let allow = k8s(json!({
            "metadata": meta("a", "allow-web"),
            "spec": {
                "podSelector": { "matchLabels": { "app": "api" } },
                "ingress": [{ "from": [{ "podSelector": { "matchLabels": { "app": "web" } } }] }],
            },
        }));
        let deny_in = cilium(json!({
            "metadata": meta("a", "deny-web"),
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "api" } },
                "ingressDeny": [{ "fromEndpoints": [{ "matchLabels": { "app": "web" } }] }],
            },
        }));
        let index = Index::new(vec![allow.clone(), deny_in], three_pods(), Vec::new());
        assert_eq!(
            said(&between(&index, 0, 1)),
            (VerdictKind::Denied, vec![], vec!["deny-web"])
        );
        // The deny names Pods of `a` only (R2).
        assert_eq!(between(&index, 2, 1).kind, VerdictKind::Blocked);

        let deny_out = cilium(json!({
            "metadata": meta("a", "web-no-api"),
            "spec": {
                "endpointSelector": { "matchLabels": { "app": "web" } },
                "egressDeny": [{
                    "toEndpoints": [{ "matchLabels": { "app": "api" } }],
                    "toPorts": [{ "ports": [{ "port": "22", "protocol": "TCP" }] }],
                }],
            },
        }));
        let index = Index::new(vec![allow, deny_out], three_pods(), Vec::new());
        assert_eq!(
            said(&between(&index, 0, 1)),
            (VerdictKind::Denied, vec![], vec!["web-no-api"])
        );
    }

    /// Spec §4.3: with `enableDefaultDeny` off a section does not isolate, so the connection
    /// stays open; deny rules still apply.
    #[test]
    fn enable_default_deny_off_does_not_isolate() {
        let index = Index::new(
            vec![cilium(json!({
                "metadata": meta("a", "audit"),
                "spec": {
                    "endpointSelector": { "matchLabels": { "app": "api" } },
                    "enableDefaultDeny": { "ingress": false },
                    "ingress": [{ "fromEndpoints": [{ "matchLabels": { "app": "web" } }] }],
                    "ingressDeny": [{ "fromEntities": ["world"] }],
                },
            }))],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(index.isolation(1), Isolation::default());
        assert_eq!(between(&index, 2, 1).kind, VerdictKind::Open);
        assert_eq!(between(&index, 0, 1).kind, VerdictKind::Open);
        assert_eq!(from_outside(&index, Outside::World, 1), VerdictKind::Denied);
    }

    /// Spec §4.5: a side's HTTP rules on a port are the union of its rules', and a side whose
    /// rules both limit L7 names its side; one side limiting leaves `side` unset.
    #[test]
    fn l7_rules_unite_on_a_side() {
        let l7 = |name: &str, app: &str, section: &str, peers: Value, rules: Value| {
            let mut entry = json!({
                "toPorts": [{ "ports": [{ "port": "8080", "protocol": "TCP" }], "rules": { "http": rules } }],
            });
            entry[if section == "ingress" {
                "fromEndpoints"
            } else {
                "toEndpoints"
            }] = peers;
            cilium(json!({
                "metadata": meta("a", name),
                "spec": { "endpointSelector": { "matchLabels": { "app": app } }, section: [entry] },
            }))
        };
        let web = json!([{ "matchLabels": { "app": "web" } }]);
        let api = json!([{ "matchLabels": { "app": "api" } }]);
        let policies = vec![
            l7(
                "api-get",
                "api",
                "ingress",
                web.clone(),
                json!([{ "method": "GET", "path": "/a" }]),
            ),
            l7(
                "api-post",
                "api",
                "ingress",
                web.clone(),
                json!([{ "method": "POST", "path": "/b" }]),
            ),
        ];
        let index = Index::new(policies.clone(), three_pods(), Vec::new());
        let mut ports = tcp(8080);
        ports.http = vec![
            get("/a", None),
            SideHttp {
                side: None,
                rule: http("POST", "/b"),
            },
        ];
        assert_eq!(
            said(&between(&index, 0, 1)),
            (
                VerdictKind::Allowed,
                vec![ports],
                vec!["api-get", "api-post"]
            )
        );

        let mut both = policies;
        both.push(l7(
            "web-get",
            "web",
            "egress",
            api,
            json!([{ "method": "GET", "path": "/x" }]),
        ));
        let index = Index::new(both, three_pods(), Vec::new());
        let mut ports = tcp(8080);
        ports.http = vec![
            get("/a", Some(Direction::Ingress)),
            SideHttp {
                side: Some(Direction::Ingress),
                rule: http("POST", "/b"),
            },
            get("/x", Some(Direction::Egress)),
        ];
        assert_eq!(
            said(&between(&index, 0, 1)),
            (
                VerdictKind::Allowed,
                vec![ports],
                vec!["api-get", "api-post", "web-get"]
            )
        );
    }

    /// Spec §4.5: a rule on the port with no HTTP rules lets every request through.
    #[test]
    fn no_http_rules_wins() {
        let index = Index::new(
            vec![
                cilium(json!({
                    "metadata": meta("a", "api-get"),
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
                })),
                k8s(json!({
                    "metadata": meta("a", "api-8080"),
                    "spec": {
                        "podSelector": { "matchLabels": { "app": "api" } },
                        "ingress": [{ "ports": [{ "port": 8080 }] }],
                    },
                })),
            ],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(
            said(&between(&index, 0, 1)),
            (
                VerdictKind::Allowed,
                vec![tcp(8080)],
                vec!["api-8080", "api-get"]
            )
        );
    }

    /// Spec §4.3: a host policy selects no Pod and isolates none.
    #[test]
    fn host_policies_isolate_nothing() {
        let index = Index::new(
            vec![cluster(json!({
                "metadata": { "name": "nodes" },
                "spec": {
                    "nodeSelector": {},
                    "ingress": [{ "fromEntities": ["cluster"] }],
                    "egressDeny": [{ "toEntities": ["world"] }],
                },
            }))],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(index.selected_pods(0), [] as [usize; 0]);
        assert_eq!(index.isolation(1), Isolation::default());
        assert_eq!(between(&index, 0, 1).kind, VerdictKind::Open);
        assert_eq!(to_outside(&index, 1, Outside::World), VerdictKind::Open);
    }

    /// Review Focus 1 and R3: an entry dropped for its unevaluated peers still isolates the Pod
    /// through its section, and allows nothing; it never reads as "every peer".
    #[test]
    fn a_dropped_entry_allows_nothing() {
        let index = Index::new(
            vec![cilium(json!({
                "metadata": meta("a", "to-service"),
                "spec": {
                    "endpointSelector": { "matchLabels": { "app": "web" } },
                    "egress": [{ "toServices": [{ "k8sService": { "serviceName": "api", "namespace": "a" } }] }],
                },
            }))],
            three_pods(),
            Vec::new(),
        );
        assert_eq!(index.policies()[0].notes, ["toServices"]);
        assert!(index.isolation(0).egress);
        assert_eq!(
            said(&between(&index, 0, 1)),
            (VerdictKind::Blocked, vec![], vec!["to-service"])
        );
        assert_eq!(to_outside(&index, 0, Outside::World), VerdictKind::Blocked);
        assert_eq!(
            to_outside(&index, 0, Outside::OtherPods),
            VerdictKind::Blocked
        );
    }

    /// Spec §5.2: "Other Pods in the cluster" is named only by peers that take in every Pod,
    /// and "Outside the cluster" by empty peers, `all`, `world` and the all-address CIDRs.
    #[test]
    fn the_catch_alls_are_named_only_by_peers_that_take_in_everything() {
        let from = |name: &str, peers: Value| {
            k8s(json!({
                "metadata": meta("a", name),
                "spec": {
                    "podSelector": { "matchLabels": { "app": name } },
                    "ingress": [{ "from": peers }],
                },
            }))
        };
        let from_endpoints = |name: &str| {
            json!({
                "endpointSelector": { "matchLabels": { "app": name } },
                "ingress": [{ "fromEndpoints": [{}] }],
            })
        };
        let names = [
            "every-ns",
            "own-ns",
            "no-peers",
            "namespaced",
            "clusterwide",
        ];
        let pods: Vec<PodInfo> = names
            .iter()
            .map(|name| pod("a", name, &[("app", name)]))
            .collect();
        let index = Index::new(
            vec![
                from("every-ns", json!([{ "namespaceSelector": {} }])),
                from("own-ns", json!([{ "podSelector": {} }])),
                k8s(json!({
                    "metadata": meta("a", "no-peers"),
                    "spec": { "podSelector": { "matchLabels": { "app": "no-peers" } }, "ingress": [{}] },
                })),
                cilium(
                    json!({ "metadata": meta("a", "namespaced"), "spec": from_endpoints("namespaced") }),
                ),
                cluster(
                    json!({ "metadata": { "name": "clusterwide" }, "spec": from_endpoints("clusterwide") }),
                ),
            ],
            pods,
            Vec::new(),
        );
        let other_pods: Vec<VerdictKind> = (0..5)
            .map(|to| from_outside(&index, Outside::OtherPods, to))
            .collect();
        assert_eq!(
            other_pods,
            [
                VerdictKind::Allowed,
                VerdictKind::Blocked,
                VerdictKind::Allowed,
                VerdictKind::Blocked,
                VerdictKind::Allowed
            ]
        );
        let world: Vec<VerdictKind> = (0..5)
            .map(|to| from_outside(&index, Outside::World, to))
            .collect();
        assert_eq!(
            world,
            [
                VerdictKind::Blocked,
                VerdictKind::Blocked,
                VerdictKind::Allowed,
                VerdictKind::Blocked,
                VerdictKind::Blocked
            ]
        );
        // Two outside ends are not evaluated.
        let both = index.verdict(
            &End::Outside(Outside::World),
            &End::Outside(Outside::OtherPods),
        );
        assert_eq!(said(&both), (VerdictKind::Open, vec![], vec![]));
    }

    /// Spec §4.5: toward or from an outside end only the Pod's side counts.
    #[test]
    fn an_outside_end_counts_only_the_pod_side() {
        let index = Index::new(
            vec![k8s(json!({
                "metadata": meta("a", "api-in"),
                "spec": {
                    "podSelector": { "matchLabels": { "app": "api" } },
                    "ingress": [{ "ports": [{ "port": "http" }] }],
                },
            }))],
            three_pods(),
            Vec::new(),
        );
        let verdict = index.verdict(&End::Outside(Outside::World), &End::Pod(1));
        assert_eq!(
            said(&verdict),
            (VerdictKind::Allowed, vec![tcp(8080)], vec!["api-in"])
        );
        assert_eq!(to_outside(&index, 1, Outside::World), VerdictKind::Open);
    }

    /// Contract C13: equal spans become one, an ANY span absorbs the TCP, UDP and SCTP spans
    /// of its range, and spans sort by port, then protocol.
    #[test]
    fn port_spans_unite_and_sort() {
        let mut limited = tcp(8080);
        limited.http = vec![get("/a", None)];
        let mut other = tcp(8080);
        other.http = vec![get("/b", None)];
        let united = unite(vec![
            tcp(9090),
            span(Protocol::Udp, Some(53), None),
            limited.clone(),
            tcp(53),
            span(Protocol::Any, Some(5000), None),
            span(Protocol::Udp, Some(5000), None),
            span(Protocol::Sctp, Some(5000), None),
            other,
            tcp(9090),
        ]);
        let mut both = tcp(8080);
        both.http = vec![get("/a", None), get("/b", None)];
        assert_eq!(
            united,
            vec![
                tcp(53),
                span(Protocol::Udp, Some(53), None),
                span(Protocol::Any, Some(5000), None),
                both,
                tcp(9090),
            ]
        );
        // A span without HTTP rules takes in the same span with them.
        assert_eq!(unite(vec![limited, tcp(8080)]), vec![tcp(8080)]);
        // An all-ports span takes in the ports of its protocol.
        assert_eq!(
            unite(vec![
                tcp(8080),
                span(Protocol::Tcp, None, None),
                span(Protocol::Udp, Some(53), None)
            ]),
            vec![
                span(Protocol::Tcp, None, None),
                span(Protocol::Udp, Some(53), None)
            ]
        );
    }
}
