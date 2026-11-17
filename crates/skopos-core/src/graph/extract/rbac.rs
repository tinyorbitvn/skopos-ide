//! Roles, ClusterRoles, RoleBindings and ClusterRoleBindings (spec O §4.2, §4.4). A binding
//! gives `binds` edges to its ServiceAccounts and a `grants` edge to its role. All four are
//! `neutral`, with no `statusText`.

use serde_json::Value;

use super::{items, text, Item, Target};
use crate::graph::kinds::{Kind, RBAC_GROUP};
use crate::graph::types::GraphRel;

/// A role shows at most this many rules; "More rules" counts the rest.
const SHOWN_RULES: usize = 5;

/// The subject kinds "Subjects" counts, in its order. Other kinds are not counted.
const SUBJECT_KINDS: [&str; 3] = ["ServiceAccount", "User", "Group"];

/// The strings of the array at `pointer`, leaving out empty ones and other values.
fn strings(value: &Value, pointer: &str) -> Vec<String> {
    items(value, pointer)
        .iter()
        .filter_map(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A rule as a fact: its resources, with their names in brackets, or else its URLs, and its
/// verbs. A rule with neither resources nor URLs gives none.
fn rule_fact(rule: &Value) -> Option<(String, String)> {
    let resources = strings(rule, "/resources");
    let label = if resources.is_empty() {
        let urls = strings(rule, "/nonResourceURLs");
        if urls.is_empty() {
            return None;
        }
        urls.join(", ")
    } else {
        let names = strings(rule, "/resourceNames");
        if names.is_empty() {
            resources.join(", ")
        } else {
            format!("{} ({})", resources.join(", "), names.join(", "))
        }
    };
    Some((label, strings(rule, "/verbs").join(", ")))
}

pub(super) fn role(item: &mut Item, object: &Value) {
    let rules: Vec<(String, String)> = items(object, "/rules")
        .iter()
        .filter_map(rule_fact)
        .collect();
    if rules.is_empty() {
        item.fact("Rules", "None");
    }
    let hidden = rules.len().saturating_sub(SHOWN_RULES);
    for (label, verbs) in rules.into_iter().take(SHOWN_RULES) {
        item.fact(&label, verbs);
    }
    if hidden > 0 {
        item.fact("More rules", format!("{hidden} more"));
    }
    let aggregated = object
        .pointer("/aggregationRule")
        .is_some_and(Value::is_object);
    if item.kind == Kind::ClusterRole && aggregated {
        item.fact("Aggregated", "Yes");
    }
}

/// "1 ServiceAccount, 2 Groups", or "None".
fn subject_counts(subjects: &[Value]) -> String {
    let counts: Vec<String> = SUBJECT_KINDS
        .iter()
        .filter_map(|kind| {
            let count = subjects.iter().filter(|s| s["kind"] == *kind).count();
            match count {
                0 => None,
                1 => Some(format!("1 {kind}")),
                _ => Some(format!("{count} {kind}s")),
            }
        })
        .collect();
    if counts.is_empty() {
        "None".to_owned()
    } else {
        counts.join(", ")
    }
}

/// A ServiceAccount subject's account. A subject without a namespace is in a RoleBinding's
/// own; a ClusterRoleBinding has none to give, so the subject is skipped, as the API server's
/// `appliesToServiceAccount` does.
fn bound_account(item: &Item, subject: &Value) -> Option<Target> {
    let group = subject
        .get("apiGroup")
        .and_then(Value::as_str)
        .unwrap_or("");
    if subject["kind"] != "ServiceAccount" || !group.is_empty() {
        return None;
    }
    let namespace = text(subject, "/namespace")
        .or_else(|| (item.kind == Kind::RoleBinding).then(|| item.namespace.clone()))?;
    Some(Target {
        kind: Kind::ServiceAccount,
        namespace,
        name: text(subject, "/name")?,
    })
}

/// The kind of role `roleRef` grants: a Role, in a RoleBinding's own namespace, or a
/// ClusterRole. Any other group or kind grants nothing the graph shows.
fn granted_role(item: &Item, object: &Value) -> Option<Kind> {
    if text(object, "/roleRef/apiGroup").as_deref() != Some(RBAC_GROUP) {
        return None;
    }
    match text(object, "/roleRef/kind").as_deref() {
        Some("Role") if item.kind == Kind::RoleBinding => Some(Kind::Role),
        Some("ClusterRole") => Some(Kind::ClusterRole),
        _ => None,
    }
}

pub(super) fn binding(item: &mut Item, object: &Value) {
    let role_kind = text(object, "/roleRef/kind");
    let role_name = text(object, "/roleRef/name");
    if let (Some(kind), Some(name)) = (&role_kind, &role_name) {
        item.fact("Role", format!("{kind} {name}"));
    }
    let subjects = items(object, "/subjects");
    item.fact("Subjects", subject_counts(subjects));

    for subject in subjects {
        if let Some(account) = bound_account(item, subject) {
            item.refer_to(GraphRel::Binds, account, false);
        }
    }
    if let (Some(kind), Some(name)) = (granted_role(item, object), &role_name) {
        item.refer(GraphRel::Grants, kind, name);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::graph::extract::test_support::{facts, item, refs};
    use crate::graph::kinds::Kind;
    use crate::graph::types::{GraphRel, GraphStatus};

    fn role_with(kind: Kind, rules: Value) -> crate::graph::extract::Item {
        item(
            kind,
            json!({ "metadata": { "name": "r", "namespace": "a" }, "rules": rules }),
        )
    }

    fn rule(resources: &[&str], verbs: &[&str]) -> Value {
        json!({ "apiGroups": [""], "resources": resources, "verbs": verbs })
    }

    #[test]
    fn a_rule_names_its_resources_or_urls_and_gives_its_verbs() {
        let role = role_with(
            Kind::Role,
            json!([
                rule(&["pods", "services"], &["get", "list", "watch"]),
                { "apiGroups": [""], "resources": ["configmaps"], "resourceNames": ["app-config"], "verbs": ["get"] },
                { "nonResourceURLs": ["/healthz"], "verbs": ["get"] },
                { "apiGroups": [""], "verbs": ["get"] },
            ]),
        );
        assert_eq!(
            (role.status, role.status_text.as_deref()),
            (GraphStatus::Neutral, None)
        );
        assert_eq!(
            facts(&role),
            [
                ("pods, services", "get, list, watch"),
                ("configmaps (app-config)", "get"),
                ("/healthz", "get"),
            ]
        );
        assert!(role.refs.is_empty());
    }

    #[test]
    fn a_role_shows_five_rules_then_counts_the_rest() {
        let mut rules: Vec<Value> = ["a", "b", "c", "d", "e", "f", "g"]
            .iter()
            .map(|resource| rule(&[resource], &["get"]))
            .collect();
        rules.insert(2, json!({ "verbs": ["get"] }));
        let role = role_with(Kind::ClusterRole, Value::Array(rules));
        assert_eq!(
            facts(&role),
            [
                ("a", "get"),
                ("b", "get"),
                ("c", "get"),
                ("d", "get"),
                ("e", "get"),
                ("More rules", "2 more"),
            ]
        );
    }

    #[test]
    fn a_role_with_no_rule_to_show_says_none() {
        for rules in [json!(null), json!([]), json!([{ "verbs": ["get"] }])] {
            let role = role_with(Kind::Role, rules.clone());
            assert_eq!(facts(&role), [("Rules", "None")], "{rules}");
        }
    }

    #[test]
    fn an_aggregated_cluster_role_says_so_last() {
        let aggregated = item(
            Kind::ClusterRole,
            json!({
                "metadata": { "name": "view" },
                "aggregationRule": { "clusterRoleSelectors": [{ "matchLabels": { "rbac.example.com/aggregate-to-view": "true" } }] },
                "rules": [rule(&["pods"], &["get"])],
            }),
        );
        assert_eq!(aggregated.id(), "ClusterRole//view");
        assert_eq!(facts(&aggregated), [("pods", "get"), ("Aggregated", "Yes")]);
        let empty = item(
            Kind::ClusterRole,
            json!({ "metadata": { "name": "e" }, "aggregationRule": {} }),
        );
        assert_eq!(facts(&empty), [("Rules", "None"), ("Aggregated", "Yes")]);
        let plain = role_with(Kind::ClusterRole, json!([rule(&["pods"], &["get"])]));
        assert_eq!(facts(&plain), [("pods", "get")]);
    }

    fn binding(kind: Kind, role_ref: Value, subjects: Value) -> crate::graph::extract::Item {
        item(
            kind,
            json!({
                "metadata": { "name": "b", "namespace": "a" },
                "roleRef": role_ref,
                "subjects": subjects,
            }),
        )
    }

    fn role_ref(kind: &str, name: &str) -> Value {
        json!({ "apiGroup": "rbac.authorization.k8s.io", "kind": kind, "name": name })
    }

    fn account(name: &str, namespace: Option<&str>) -> Value {
        json!({ "kind": "ServiceAccount", "name": name, "namespace": namespace })
    }

    #[test]
    fn a_role_binding_subject_without_a_namespace_takes_the_bindings() {
        let binding = binding(
            Kind::RoleBinding,
            role_ref("Role", "reader"),
            json!([
                account("web", None),
                account("api", Some("b")),
                account("web", Some("a")),
                { "kind": "ServiceAccount", "apiGroup": "example.com", "name": "odd" },
                { "kind": "User", "apiGroup": "rbac.authorization.k8s.io", "name": "alice" },
                { "kind": "Group", "apiGroup": "rbac.authorization.k8s.io", "name": "devs" },
            ]),
        );
        assert_eq!(
            (binding.status, binding.status_text.as_deref()),
            (GraphStatus::Neutral, None)
        );
        assert_eq!(
            refs(&binding),
            [
                (GraphRel::Binds, "ServiceAccount/a/web".to_owned(), false),
                (GraphRel::Binds, "ServiceAccount/b/api".to_owned(), false),
                (GraphRel::Grants, "Role/a/reader".to_owned(), false),
            ]
        );
        assert_eq!(
            facts(&binding),
            [
                ("Role", "Role reader"),
                ("Subjects", "4 ServiceAccounts, 1 User, 1 Group"),
            ]
        );
    }

    #[test]
    fn a_cluster_role_binding_subject_without_a_namespace_is_skipped() {
        let binding = binding(
            Kind::ClusterRoleBinding,
            role_ref("ClusterRole", "view"),
            json!([account("web", None), account("api", Some("b"))]),
        );
        assert_eq!(binding.id(), "ClusterRoleBinding//b");
        assert_eq!(
            refs(&binding),
            [
                (GraphRel::Binds, "ServiceAccount/b/api".to_owned(), false),
                (GraphRel::Grants, "ClusterRole//view".to_owned(), false),
            ]
        );
    }

    #[test]
    fn a_binding_grants_only_what_its_kind_may_reference() {
        let grants = |kind: Kind, role_ref: Value| {
            let binding = binding(kind, role_ref, json!([]));
            refs(&binding)
                .into_iter()
                .map(|(rel, target, _)| {
                    assert_eq!(rel, GraphRel::Grants);
                    target
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            grants(Kind::RoleBinding, role_ref("Role", "reader")),
            ["Role/a/reader"]
        );
        assert_eq!(
            grants(Kind::RoleBinding, role_ref("ClusterRole", "view")),
            ["ClusterRole//view"]
        );
        assert!(grants(Kind::ClusterRoleBinding, role_ref("Role", "reader")).is_empty());
        let foreign = json!({ "apiGroup": "example.com", "kind": "ClusterRole", "name": "view" });
        assert!(grants(Kind::RoleBinding, foreign).is_empty());
        let no_group = json!({ "kind": "ClusterRole", "name": "view" });
        assert!(grants(Kind::RoleBinding, no_group).is_empty());
        assert!(grants(Kind::RoleBinding, role_ref("Thing", "x")).is_empty());
        assert!(grants(Kind::RoleBinding, role_ref("Role", "")).is_empty());
    }

    #[test]
    fn a_binding_names_its_role_and_counts_its_subjects_by_kind() {
        let subjects = |subjects: Value| {
            let binding = binding(
                Kind::ClusterRoleBinding,
                role_ref("ClusterRole", "view"),
                subjects,
            );
            facts(&binding)
                .into_iter()
                .map(|(label, value)| (label.to_owned(), value.to_owned()))
                .collect::<Vec<_>>()
        };
        let pair = |label: &str, value: &str| (label.to_owned(), value.to_owned());
        assert_eq!(
            subjects(json!([
                { "kind": "Group", "name": "g1" },
                account("web", Some("a")),
                { "kind": "Group", "name": "g2" },
            ])),
            [
                pair("Role", "ClusterRole view"),
                pair("Subjects", "1 ServiceAccount, 2 Groups"),
            ]
        );
        assert_eq!(
            subjects(json!([{ "kind": "User", "name": "u1" }, { "kind": "User", "name": "u2" }])),
            [
                pair("Role", "ClusterRole view"),
                pair("Subjects", "2 Users")
            ]
        );
        for none in [
            json!(null),
            json!([]),
            json!([{ "kind": "Robot", "name": "r" }]),
        ] {
            assert_eq!(
                subjects(none.clone()),
                [pair("Role", "ClusterRole view"), pair("Subjects", "None")],
                "{none}"
            );
        }
        let bare = item(
            Kind::RoleBinding,
            json!({ "metadata": { "name": "b", "namespace": "a" } }),
        );
        assert_eq!(facts(&bare), [("Subjects", "None")]);
    }
}
