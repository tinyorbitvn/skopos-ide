//! Label selectors (spec §4.1): `matchLabels` and `matchExpressions` of a NetworkPolicy or a
//! Cilium policy, read leniently, matched against labels and written as text. Cilium keys may
//! carry a source (`k8s:app`); `reserved:<entity>` names an entity instead of a label.

use std::collections::BTreeMap;

use serde_json::Value;

use super::model::{push_unique, Entity};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Operator {
    In(Vec<String>),
    NotIn(Vec<String>),
    Exists,
    DoesNotExist,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Requirement {
    pub key: String,
    pub operator: Operator,
}

/// All requirements must hold. `matches_nothing` is set by an unknown operator, an `In` or
/// `NotIn` without values, or an unknown Cilium label source.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct LabelSelector {
    pub requirements: Vec<Requirement>,
    pub matches_nothing: bool,
}

/// What a Cilium label key names once its source is read (spec §4.1).
enum CiliumKey {
    /// A label of the Pod or one of its virtual labels: `k8s:`, `any:` or no source.
    Label(String),
    /// `reserved:<entity>`.
    Entity(Entity),
    /// Another source, or a reserved name that is not an entity: the note it adds.
    Unknown(String),
}

impl CiliumKey {
    fn read(key: &str) -> CiliumKey {
        match key.split_once(':') {
            None => CiliumKey::Label(key.to_owned()),
            Some(("k8s" | "any", label)) => CiliumKey::Label(label.to_owned()),
            Some(("reserved", name)) => match Entity::parse(name) {
                Some(entity) => CiliumKey::Entity(entity),
                None => CiliumKey::Unknown(format!("entity {name}")),
            },
            Some((source, _)) => CiliumKey::Unknown(format!("label source {source}")),
        }
    }
}

/// The operator of one `matchExpressions` entry, or `None` after adding its note when the
/// operator is unknown or an `In`/`NotIn` lists no value (spec §4.1). An operator that is
/// not a string is named by its JSON text (`operator null` when it is missing).
fn operator(expression: &Value, notes: &mut Vec<String>) -> Option<Operator> {
    let values: Vec<String> = expression["values"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let name = match &expression["operator"] {
        Value::String(name) => name.clone(),
        other => other.to_string(),
    };
    match name.as_str() {
        "In" if !values.is_empty() => Some(Operator::In(values)),
        "NotIn" if !values.is_empty() => Some(Operator::NotIn(values)),
        "Exists" => Some(Operator::Exists),
        "DoesNotExist" => Some(Operator::DoesNotExist),
        _ => {
            push_unique(notes, format!("operator {name}"));
            None
        }
    }
}

impl LabelSelector {
    /// `{ matchLabels, matchExpressions }`, leniently; anything not an object selects all.
    /// Pushes "operator <op>" to `notes` for an unknown operator.
    ///
    /// A field of another type than expected counts as absent: a `matchLabels` value that is
    /// not a string, an expression that is not an object or has no string `key`, and values
    /// that are not strings are left out.
    pub(crate) fn parse(value: &Value, notes: &mut Vec<String>) -> LabelSelector {
        Self::read(value, notes, false).0
    }

    /// As `parse`, with Cilium's key sources: `k8s:` and `any:` are stripped; a
    /// `reserved:<entity>` key becomes an entity and leaves the selector; any other source
    /// sets `matches_nothing` and pushes "label source <source>".
    ///
    /// A Pod never carries a reserved label, so `NotIn` and `DoesNotExist` on one hold for
    /// every Pod and are dropped without an entity. A reserved name that is not an entity
    /// (`reserved:world-ipv4`) sets `matches_nothing` and pushes "entity <name>".
    pub(crate) fn parse_cilium(
        value: &Value,
        notes: &mut Vec<String>,
    ) -> (LabelSelector, Vec<Entity>) {
        Self::read(value, notes, true)
    }

    fn read(value: &Value, notes: &mut Vec<String>, cilium: bool) -> (LabelSelector, Vec<Entity>) {
        let mut selector = LabelSelector::default();
        let mut entities = Vec::new();
        if !value.is_object() {
            return (selector, entities);
        }
        // `matchLabels` by key, so the order never depends on how the JSON map keeps its keys.
        let mut labels: Vec<(&String, &str)> = value["matchLabels"]
            .as_object()
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|(key, value)| Some((key, value.as_str()?)))
                    .collect()
            })
            .unwrap_or_default();
        labels.sort_unstable();
        let mut written: Vec<(String, Option<Operator>)> = labels
            .into_iter()
            .map(|(key, value)| (key.clone(), Some(Operator::In(vec![value.to_owned()]))))
            .collect();
        for expression in value["matchExpressions"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
        {
            if let Some(key) = expression["key"].as_str() {
                written.push((key.to_owned(), operator(expression, notes)));
            }
        }
        for (key, operator) in written {
            let Some(operator) = operator else {
                selector.matches_nothing = true;
                continue;
            };
            let key = if cilium {
                match CiliumKey::read(&key) {
                    CiliumKey::Label(label) => label,
                    CiliumKey::Entity(entity) => {
                        if matches!(operator, Operator::In(_) | Operator::Exists) {
                            push_unique(&mut entities, entity);
                        }
                        continue;
                    }
                    CiliumKey::Unknown(note) => {
                        push_unique(notes, note);
                        selector.matches_nothing = true;
                        continue;
                    }
                }
            } else {
                key
            };
            selector.requirements.push(Requirement { key, operator });
        }
        (selector, entities)
    }

    pub(crate) fn matches(&self, labels: &BTreeMap<String, String>) -> bool {
        !self.matches_nothing
            && self.requirements.iter().all(|requirement| {
                let value = labels.get(&requirement.key);
                match &requirement.operator {
                    Operator::In(values) => value.is_some_and(|value| values.contains(value)),
                    Operator::NotIn(values) => value.is_none_or(|value| !values.contains(value)),
                    Operator::Exists => value.is_some(),
                    Operator::DoesNotExist => value.is_none(),
                }
            })
    }

    /// No requirement and not `matches_nothing`.
    pub(crate) fn is_everything(&self) -> bool {
        self.requirements.is_empty() && !self.matches_nothing
    }

    /// Whether a requirement names `key`.
    pub(crate) fn constrains(&self, key: &str) -> bool {
        self.requirements
            .iter()
            .any(|requirement| requirement.key == key)
    }

    /// Adds `key In [value]`.
    pub(crate) fn with_label(mut self, key: &str, value: &str) -> LabelSelector {
        self.requirements.push(Requirement {
            key: key.to_owned(),
            operator: Operator::In(vec![value.to_owned()]),
        });
        self
    }

    /// "All Pods" when everything; "No Pods" when `matches_nothing`; else the requirements,
    /// sorted by key, joined with ", ": `app=web`, `tier in (a, b)`, `env notin (x)`, `team`
    /// (Exists), `!team` (DoesNotExist). Values keep their written order.
    pub(crate) fn text(&self) -> String {
        if self.matches_nothing {
            return "No Pods".to_owned();
        }
        if self.is_everything() {
            return "All Pods".to_owned();
        }
        let mut requirements: Vec<&Requirement> = self.requirements.iter().collect();
        requirements.sort_by(|a, b| a.key.cmp(&b.key));
        let parts: Vec<String> = requirements
            .into_iter()
            .map(|Requirement { key, operator }| match operator {
                Operator::In(values) => match values.as_slice() {
                    [value] => format!("{key}={value}"),
                    _ => format!("{key} in ({})", values.join(", ")),
                },
                Operator::NotIn(values) => format!("{key} notin ({})", values.join(", ")),
                Operator::Exists => key.clone(),
                Operator::DoesNotExist => format!("!{key}"),
            })
            .collect();
        parts.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{json, Value};

    use super::{LabelSelector, Operator, Requirement};
    use crate::netpol::Entity;

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn parse(value: Value) -> (LabelSelector, Vec<String>) {
        let mut notes = Vec::new();
        let selector = LabelSelector::parse(&value, &mut notes);
        (selector, notes)
    }

    fn parse_cilium(value: Value) -> (LabelSelector, Vec<Entity>, Vec<String>) {
        let mut notes = Vec::new();
        let (selector, entities) = LabelSelector::parse_cilium(&value, &mut notes);
        (selector, entities, notes)
    }

    fn expression(key: &str, operator: &str, values: &[&str]) -> Value {
        json!({ "matchExpressions": [{ "key": key, "operator": operator, "values": values }] })
    }

    fn requirement(key: &str, operator: Operator) -> Requirement {
        Requirement {
            key: key.to_owned(),
            operator,
        }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn each_operator_matches_as_kubernetes_does() {
        let (within, notes) = parse(expression("tier", "In", &["a", "b"]));
        assert_eq!(
            within.requirements,
            [requirement("tier", Operator::In(strings(&["a", "b"])))]
        );
        assert!(within.matches(&labels(&[("tier", "b")])));
        assert!(!within.matches(&labels(&[("tier", "c")])));
        assert!(!within.matches(&labels(&[])), "In needs the key");

        let (outside, _) = parse(expression("env", "NotIn", &["prod"]));
        assert!(outside.matches(&labels(&[("env", "dev")])));
        assert!(!outside.matches(&labels(&[("env", "prod")])));
        assert!(
            outside.matches(&labels(&[("app", "web")])),
            "NotIn holds when the key is missing"
        );

        let (exists, _) = parse(expression("team", "Exists", &[]));
        assert!(exists.matches(&labels(&[("team", "")])));
        assert!(!exists.matches(&labels(&[("app", "web")])));

        let (absent, _) = parse(expression("team", "DoesNotExist", &["ignored"]));
        assert_eq!(
            absent.requirements,
            [requirement("team", Operator::DoesNotExist)]
        );
        assert!(absent.matches(&labels(&[("app", "web")])));
        assert!(!absent.matches(&labels(&[("team", "a")])));
        assert!(notes.is_empty());
    }

    #[test]
    fn labels_and_expressions_must_all_hold() {
        let (selector, notes) = parse(json!({
            "matchLabels": { "tier": "backend", "app": "api" },
            "matchExpressions": [{ "key": "env", "operator": "NotIn", "values": ["prod"] }],
        }));
        assert_eq!(
            selector.requirements,
            [
                requirement("app", Operator::In(strings(&["api"]))),
                requirement("tier", Operator::In(strings(&["backend"]))),
                requirement("env", Operator::NotIn(strings(&["prod"]))),
            ]
        );
        assert!(selector.matches(&labels(&[("app", "api"), ("tier", "backend")])));
        assert!(!selector.matches(&labels(&[
            ("app", "api"),
            ("tier", "backend"),
            ("env", "prod")
        ])));
        assert!(!selector.matches(&labels(&[("app", "api")])));
        assert!(notes.is_empty());
    }

    #[test]
    fn an_empty_selector_selects_everything() {
        for value in [
            json!({}),
            json!({ "matchLabels": {} }),
            json!({ "matchLabels": {}, "matchExpressions": [] }),
        ] {
            let (selector, notes) = parse(value);
            assert!(selector.is_everything());
            assert!(selector.matches(&labels(&[])));
            assert!(selector.matches(&labels(&[("app", "web")])));
            assert_eq!(selector.text(), "All Pods");
            assert!(notes.is_empty());
        }
        assert!(LabelSelector::default().is_everything());
    }

    #[test]
    fn an_unknown_operator_or_missing_values_select_nothing_with_a_note() {
        let (selector, notes) = parse(json!({
            "matchLabels": { "app": "web" },
            "matchExpressions": [
                { "key": "tier", "operator": "Matches", "values": ["a"] },
                { "key": "env", "operator": "In", "values": [] },
                { "key": "team", "operator": "NotIn" },
                { "key": "zone", "operator": "Matches", "values": ["b"] },
            ],
        }));
        assert!(selector.matches_nothing);
        assert!(!selector.is_everything());
        assert!(!selector.matches(&labels(&[("app", "web"), ("tier", "a")])));
        assert_eq!(selector.text(), "No Pods");
        assert_eq!(
            selector.requirements,
            [requirement("app", Operator::In(strings(&["web"])))],
            "the readable requirements stay"
        );
        assert_eq!(
            notes,
            ["operator Matches", "operator In", "operator NotIn"],
            "each note once"
        );
    }

    #[test]
    fn cilium_keys_read_their_source() {
        let (selector, entities, notes) = parse_cilium(json!({
            "matchLabels": {
                "k8s:io.kubernetes.pod.namespace": "payments",
                "any:app": "web",
                "tier": "frontend",
            },
            "matchExpressions": [{ "key": "k8s:env", "operator": "Exists" }],
        }));
        assert_eq!(
            selector.requirements,
            [
                requirement("app", Operator::In(strings(&["web"]))),
                requirement(
                    "io.kubernetes.pod.namespace",
                    Operator::In(strings(&["payments"]))
                ),
                requirement("tier", Operator::In(strings(&["frontend"]))),
                requirement("env", Operator::Exists),
            ]
        );
        assert!(entities.is_empty());
        assert!(notes.is_empty());

        let (host, entities, notes) = parse_cilium(json!({
            "matchLabels": { "reserved:host": "", "app": "web" },
            "matchExpressions": [
                { "key": "reserved:kube-apiserver", "operator": "Exists" },
                { "key": "reserved:health", "operator": "DoesNotExist" },
                { "key": "reserved:host", "operator": "In", "values": [""] },
            ],
        }));
        assert_eq!(entities, [Entity::Host, Entity::KubeApiserver]);
        assert_eq!(
            host.requirements,
            [requirement("app", Operator::In(strings(&["web"])))],
            "reserved keys leave the selector"
        );
        assert!(!host.matches_nothing);
        assert!(notes.is_empty());

        let (other, entities, notes) = parse_cilium(json!({
            "matchLabels": { "cidr:10.0.0.0/8": "", "app": "web" },
            "matchExpressions": [
                { "key": "reserved:world-ipv4", "operator": "Exists" },
                { "key": "container:id", "operator": "Exists" },
                { "key": "cidr:10.1.0.0/16", "operator": "Exists" },
            ],
        }));
        assert!(other.matches_nothing);
        assert!(entities.is_empty());
        assert_eq!(
            notes,
            [
                "label source cidr",
                "entity world-ipv4",
                "label source container"
            ]
        );

        let (plain, notes) = parse(json!({ "matchLabels": { "k8s:app": "web" } }));
        assert_eq!(
            plain.requirements,
            [requirement("k8s:app", Operator::In(strings(&["web"])))],
            "a NetworkPolicy key has no source"
        );
        assert!(notes.is_empty());
    }

    #[test]
    fn text_writes_each_requirement_by_key() {
        let (selector, _) = parse(json!({
            "matchLabels": { "app": "web" },
            "matchExpressions": [
                { "key": "tier", "operator": "In", "values": ["b", "a"] },
                { "key": "env", "operator": "NotIn", "values": ["x"] },
                { "key": "team", "operator": "Exists" },
                { "key": "debug", "operator": "DoesNotExist" },
            ],
        }));
        assert_eq!(
            selector.text(),
            "app=web, !debug, env notin (x), team, tier in (b, a)"
        );
        assert_eq!(LabelSelector::default().text(), "All Pods");
        let nothing = LabelSelector {
            requirements: Vec::new(),
            matches_nothing: true,
        };
        assert_eq!(nothing.text(), "No Pods");
    }

    #[test]
    fn constrains_and_with_label_name_a_key() {
        let (selector, _) = parse(json!({
            "matchLabels": { "app": "web" },
            "matchExpressions": [{ "key": "io.kubernetes.pod.namespace", "operator": "Exists" }],
        }));
        assert!(selector.constrains("app"));
        assert!(selector.constrains("io.kubernetes.pod.namespace"));
        assert!(!selector.constrains("tier"));

        let narrowed =
            LabelSelector::default().with_label("io.kubernetes.pod.namespace", "payments");
        assert!(narrowed.constrains("io.kubernetes.pod.namespace"));
        assert_eq!(
            narrowed.requirements,
            [requirement(
                "io.kubernetes.pod.namespace",
                Operator::In(strings(&["payments"]))
            )]
        );
        assert!(narrowed.matches(&labels(&[("io.kubernetes.pod.namespace", "payments")])));
        assert!(!narrowed.matches(&labels(&[("io.kubernetes.pod.namespace", "other")])));
        assert!(!narrowed.is_everything());
    }

    #[test]
    fn odd_selector_fields_are_read_leniently() {
        let (numbers, notes) = parse(json!({
            "matchLabels": { "app": "web", "replicas": 3, "canary": true },
        }));
        assert_eq!(
            numbers.requirements,
            [requirement("app", Operator::In(strings(&["web"])))],
            "a value that is not a string is left out"
        );
        assert!(notes.is_empty());

        let (not_a_list, _) = parse(json!({
            "matchLabels": ["app", "web"],
            "matchExpressions": { "key": "tier", "operator": "Exists" },
        }));
        assert!(not_a_list.is_everything());

        let (values, notes) = parse(json!({
            "matchExpressions": [
                { "key": "tier", "operator": "In", "values": ["a", 1, null, ["b"]] },
                { "key": "env", "operator": "In", "values": "prod" },
                7,
                { "operator": "Exists" },
                { "key": 5, "operator": "Exists" },
            ],
        }));
        assert_eq!(
            values.requirements,
            [requirement("tier", Operator::In(strings(&["a"])))]
        );
        assert!(values.matches_nothing, "env lists no string value");
        assert_eq!(notes, ["operator In"]);

        let (operators, notes) = parse(json!({
            "matchExpressions": [
                { "key": "tier", "operator": 5, "values": ["a"] },
                { "key": "env", "values": ["a"] },
            ],
        }));
        assert!(operators.matches_nothing);
        assert_eq!(notes, ["operator 5", "operator null"]);

        for value in [json!("app=web"), json!(null), json!(["app"]), json!(3)] {
            let (selector, notes) = parse(value.clone());
            assert!(selector.is_everything(), "{value}");
            assert!(notes.is_empty());
            let (selector, entities, notes) = parse_cilium(value);
            assert!(selector.is_everything());
            assert!(entities.is_empty() && notes.is_empty());
        }
    }
}
