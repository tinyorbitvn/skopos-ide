//! Which served resource a tool's `kind` argument names (spec §4.4): a Kind, a plural, a
//! short name or `<plural>.<group>`, in any case, as the cluster's discovery serves them.

use crate::resources::{ApiResourceInfo, ResourceRef};

/// An error lists at most this many candidates.
const MAX_CANDIDATES: usize = 5;

/// The name that names `r` alone: its plural, and its group unless it is the core group.
pub fn resource_name(r: &ResourceRef) -> String {
    if r.group.is_empty() {
        r.plural.clone()
    } else {
        format!("{}.{}", r.plural, r.group)
    }
}

/// `v1` for the core group, `<group>/<version>` for the others.
pub fn group_version(r: &ResourceRef) -> String {
    if r.group.is_empty() {
        r.version.clone()
    } else {
        format!("{}/{}", r.group, r.version)
    }
}

/// Whether `r` is the core Namespaces resource, which the namespace limit filters by name.
pub fn is_namespaces(r: &ResourceRef) -> bool {
    r.group.is_empty() && r.plural == "namespaces"
}

/// The resource `input` names among `served`. A name that matches several groups resolves
/// to the core group's when it has one; otherwise the error lists the candidates.
pub fn resolve_kind(input: &str, served: &[ApiResourceInfo]) -> Result<ResourceRef, String> {
    let wanted = input.trim();
    let lower = wanted.to_lowercase();
    let mut matches: Vec<&ResourceRef> = served
        .iter()
        .filter(|info| named(info, &lower))
        .map(|info| &info.resource)
        .collect();
    if matches.is_empty() {
        if let Some((plural, group)) = lower.split_once('.') {
            matches = served
                .iter()
                .map(|info| &info.resource)
                .filter(|r| {
                    r.group.to_lowercase() == group
                        && (r.plural.to_lowercase() == plural || r.kind.to_lowercase() == plural)
                })
                .collect();
        }
    }
    match matches.as_slice() {
        [] => Err(unknown(wanted, &lower, served)),
        [one] => Ok((*one).clone()),
        several => {
            let core: Vec<&ResourceRef> = several
                .iter()
                .copied()
                .filter(|r| r.group.is_empty())
                .collect();
            if let [one] = core.as_slice() {
                return Ok((*one).clone());
            }
            let candidates: Vec<String> = several
                .iter()
                .copied()
                .take(MAX_CANDIDATES)
                .map(resource_name)
                .collect();
            Err(format!(
                "Kind {wanted} matches several kinds: {}. Use one of these names.",
                candidates.join(", ")
            ))
        }
    }
}

/// Whether `lower` is the resource's Kind, plural or one of its short names.
fn named(info: &ApiResourceInfo, lower: &str) -> bool {
    let r = &info.resource;
    r.kind.to_lowercase() == lower
        || r.plural.to_lowercase() == lower
        || info
            .short_names
            .iter()
            .any(|short| short.to_lowercase() == lower)
}

/// `Unknown kind <input>.`, with up to five served kinds whose Kind or plural holds it.
fn unknown(wanted: &str, lower: &str, served: &[ApiResourceInfo]) -> String {
    let similar: Vec<String> = if lower.is_empty() {
        Vec::new()
    } else {
        served
            .iter()
            .map(|info| &info.resource)
            .filter(|r| {
                r.kind.to_lowercase().contains(lower) || r.plural.to_lowercase().contains(lower)
            })
            .take(MAX_CANDIDATES)
            .map(resource_name)
            .collect()
    };
    if similar.is_empty() {
        format!("Unknown kind {wanted}.")
    } else {
        format!(
            "Unknown kind {wanted}. Similar kinds: {}.",
            similar.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn served(
        group: &str,
        plural: &str,
        kind: &str,
        namespaced: bool,
        short_names: &[&str],
    ) -> ApiResourceInfo {
        ApiResourceInfo {
            resource: ResourceRef {
                group: group.to_owned(),
                version: "v1".to_owned(),
                plural: plural.to_owned(),
                kind: kind.to_owned(),
                namespaced,
            },
            verbs: vec!["get".to_owned(), "list".to_owned()],
            short_names: short_names
                .iter()
                .map(|short| (*short).to_owned())
                .collect(),
            can_list: true,
            can_watch: true,
            can_create: false,
            can_update: false,
            can_patch: false,
            can_delete: false,
        }
    }

    fn cluster() -> Vec<ApiResourceInfo> {
        vec![
            served("", "pods", "Pod", true, &["po"]),
            served("", "configmaps", "ConfigMap", true, &["cm"]),
            served("", "nodes", "Node", false, &["no"]),
            served("apps", "deployments", "Deployment", true, &["deploy"]),
            served("", "events", "Event", true, &["ev"]),
            served("events.k8s.io", "events", "Event", true, &["ev"]),
            served("a.example", "widgets", "Widget", true, &[]),
            served("b.example", "widgets", "Widget", true, &[]),
        ]
    }

    fn resolved(input: &str) -> Result<(String, String), String> {
        resolve_kind(input, &cluster()).map(|r| (r.group, r.plural))
    }

    fn found(group: &str, plural: &str) -> Result<(String, String), String> {
        Ok((group.to_owned(), plural.to_owned()))
    }

    #[test]
    fn a_kind_resolves_by_kind_plural_or_short_name_in_any_case() {
        for input in [
            "Deployment",
            "deployments",
            "deploy",
            "DEPLOY",
            " deployment ",
        ] {
            assert_eq!(resolved(input), found("apps", "deployments"), "{input}");
        }
        assert_eq!(resolved("po"), found("", "pods"));
    }

    #[test]
    fn a_plural_with_its_group_names_that_group() {
        assert_eq!(
            resolved("events.events.k8s.io"),
            found("events.k8s.io", "events")
        );
        assert_eq!(resolved("Widgets.B.Example"), found("b.example", "widgets"));
        assert_eq!(resolved("deployments.apps"), found("apps", "deployments"));
    }

    #[test]
    fn the_core_group_wins_when_a_name_matches_several_groups() {
        assert_eq!(resolved("Event"), found("", "events"));
        assert_eq!(resolved("ev"), found("", "events"));
    }

    #[test]
    fn a_name_of_several_groups_outside_the_core_group_is_ambiguous() {
        assert_eq!(
            resolved("widget"),
            Err("Kind widget matches several kinds: widgets.a.example, widgets.b.example. Use one of these names.".to_owned())
        );
    }

    #[test]
    fn an_unknown_kind_lists_at_most_five_similar_kinds() {
        assert_eq!(
            resolved("deploymen"),
            Err("Unknown kind deploymen. Similar kinds: deployments.apps.".to_owned())
        );
        assert_eq!(resolved("Gadget"), Err("Unknown kind Gadget.".to_owned()));
        assert_eq!(
            resolved("e"),
            Err("Unknown kind e. Similar kinds: nodes, deployments.apps, events, events.events.k8s.io, widgets.a.example.".to_owned())
        );
    }

    #[test]
    fn names_and_versions_name_one_resource() {
        let deployments = &cluster()[3].resource;
        assert_eq!(resource_name(deployments), "deployments.apps");
        assert_eq!(group_version(deployments), "apps/v1");
        let pods = &cluster()[0].resource;
        assert_eq!(resource_name(pods), "pods");
        assert_eq!(group_version(pods), "v1");
        assert!(!is_namespaces(pods));
        assert!(is_namespaces(
            &served("", "namespaces", "Namespace", false, &["ns"]).resource
        ));
    }
}
