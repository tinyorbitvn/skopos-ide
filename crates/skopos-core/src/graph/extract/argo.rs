//! Argo CD Applications, ApplicationSets and AppProjects (network policies spec §3.3, §6.1).
//! An Application `manages` each object of `status.resources` of a kind the map draws and
//! counts the others, and points at its AppProject with `project`. An ApplicationSet owns its
//! Applications through their owner references, as any owner does.

use serde_json::Value;

use super::{condition, items, said, text, Item, Said, Target};
use crate::graph::kinds::Kind;
use crate::graph::types::{GraphRel, GraphStatus};

/// The project of an Application without `spec.project`, as Argo CD reads it.
const DEFAULT_PROJECT: &str = "default";

/// The in-cluster destination, by URL and by name: "Destination" names only the namespace
/// there.
const IN_CLUSTER_SERVER: &str = "https://kubernetes.default.svc";
const IN_CLUSTER_NAME: &str = "in-cluster";

/// Spec §6.1: health decides first, then sync.
fn application_status(health: Option<&str>, sync: Option<&str>) -> GraphStatus {
    match (health, sync) {
        (Some("Degraded" | "Missing"), _) => GraphStatus::Critical,
        (Some("Progressing" | "Suspended"), _) | (_, Some("OutOfSync")) => GraphStatus::Warning,
        (Some("Healthy"), Some("Synced")) => GraphStatus::Nominal,
        _ => GraphStatus::Neutral,
    }
}

/// A git SHA (40 hex characters) is cut to its first 7; anything else is kept as written.
fn short_revision(revision: &str) -> String {
    if revision.len() == 40 && revision.chars().all(|c| c.is_ascii_hexdigit()) {
        revision.chars().take(7).collect()
    } else {
        revision.to_owned()
    }
}

/// `status.sync.revision`, or each of `status.sync.revisions` for several sources.
fn revision(object: &Value) -> Option<String> {
    if let Some(revision) = text(object, "/status/sync/revision") {
        return Some(short_revision(&revision));
    }
    let revisions: Vec<String> = items(object, "/status/sync/revisions")
        .iter()
        .filter_map(Value::as_str)
        .filter(|revision| !revision.is_empty())
        .map(short_revision)
        .collect();
    (!revisions.is_empty()).then(|| revisions.join(", "))
}

/// Spec §3.3: the namespace, and the cluster's name or URL when it is not the in-cluster one.
fn destination(object: &Value) -> Option<String> {
    let namespace = text(object, "/spec/destination/namespace");
    let name = text(object, "/spec/destination/name");
    let server = text(object, "/spec/destination/server");
    let in_cluster = name.as_deref().is_none_or(|name| name == IN_CLUSTER_NAME)
        && server
            .as_deref()
            .is_none_or(|server| server == IN_CLUSTER_SERVER);
    let cluster = name.or(server).filter(|_| !in_cluster);
    let parts: Vec<String> = namespace.into_iter().chain(cluster).collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// A kind the map draws an Application's object of. Namespaces are never nodes, and roles and
/// bindings show only on a ServiceAccount's access chain.
fn drawn(kind: Kind) -> bool {
    kind != Kind::Namespace && !kind.is_access()
}

pub(super) fn application(item: &mut Item, object: &Value) {
    let health = text(object, "/status/health/status");
    let sync = text(object, "/status/sync/status");
    item.status = application_status(health.as_deref(), sync.as_deref());
    let parts: Vec<&str> = health
        .iter()
        .chain(sync.iter())
        .map(String::as_str)
        .collect();
    item.status_text = (!parts.is_empty()).then(|| parts.join(" · "));

    let project = text(object, "/spec/project").unwrap_or_else(|| DEFAULT_PROJECT.to_owned());
    item.fact("Project", project.clone());
    item.fact_if("Health", health);
    item.fact_if("Sync", sync);
    item.fact_if("Revision", revision(object));
    item.fact_if("Destination", destination(object));

    // An entry without a kind or a name names nothing. A namespaced object Argo CD wrote no
    // namespace for is in the destination's namespace.
    let mut others: Vec<String> = Vec::new();
    for entry in items(object, "/status/resources") {
        let (Some(kind), Some(name)) = (text(entry, "/kind"), text(entry, "/name")) else {
            continue;
        };
        let group = text(entry, "/group").unwrap_or_default();
        let Some(drawn_kind) = Kind::from_group_kind(&group, &kind).filter(|k| drawn(*k)) else {
            others.push(kind);
            continue;
        };
        let namespace = if drawn_kind.namespaced() {
            let namespace =
                text(entry, "/namespace").or_else(|| text(object, "/spec/destination/namespace"));
            let Some(namespace) = namespace else {
                continue;
            };
            namespace
        } else {
            String::new()
        };
        let target = Target {
            kind: drawn_kind,
            namespace,
            name,
        };
        item.refer_to(GraphRel::Manages, target, false);
    }
    if !others.is_empty() {
        let count = others.len();
        others.sort();
        others.dedup();
        item.fact(
            "Other resources",
            format!("{count} ({})", others.join(", ")),
        );
    }
    item.refer(GraphRel::Project, Kind::AppProject, &project);
}

/// Spec §6.1: critical with what the `ErrorOccurred` condition says while it is true.
pub(super) fn application_set(item: &mut Item, object: &Value) {
    let error = condition(object, "ErrorOccurred");
    if said(error) == Said::True {
        item.status = GraphStatus::Critical;
        item.status_text =
            error.and_then(|error| text(error, "/message").or_else(|| text(error, "/reason")));
    } else {
        item.status = GraphStatus::Nominal;
    }
}

/// Spec §6.1: neutral, with how many destinations and source repositories it allows.
pub(super) fn app_project(item: &mut Item, object: &Value) {
    let destinations = items(object, "/spec/destinations").len();
    let repos = items(object, "/spec/sourceRepos").len();
    item.fact("Destinations", destinations.to_string());
    item.fact("Source repos", repos.to_string());
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::graph::extract::test_support::{facts, item, refs};
    use crate::graph::kinds::Kind;
    use crate::graph::types::{GraphRel, GraphStatus};

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn application(spec: Value, status: Value) -> crate::graph::extract::Item {
        item(
            Kind::Application,
            json!({
                "metadata": { "name": "shop", "namespace": "argocd" },
                "spec": spec,
                "status": status,
            }),
        )
    }

    fn fact<'a>(facts: &[(&'a str, &'a str)], label: &str) -> Option<&'a str> {
        facts
            .iter()
            .find(|(l, _)| *l == label)
            .map(|(_, value)| *value)
    }

    #[test]
    fn an_application_has_its_status_facts_and_managed_objects() {
        let app = application(
            json!({
                "project": "team-a",
                "destination": { "server": "https://kubernetes.default.svc", "namespace": "shop" },
            }),
            json!({
                "health": { "status": "Degraded" },
                "sync": { "status": "Synced", "revision": SHA },
                "resources": [
                    { "group": "apps", "kind": "Deployment", "namespace": "shop", "name": "web" },
                    { "kind": "Service", "namespace": "shop", "name": "web" },
                    { "kind": "Secret", "name": "creds" },
                    { "group": "argoproj.io", "kind": "Application", "namespace": "argocd", "name": "child" },
                    { "group": "cilium.io", "kind": "CiliumClusterwideNetworkPolicy", "name": "base" },
                    { "kind": "Namespace", "name": "shop" },
                    { "group": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "reader" },
                    { "group": "rbac.authorization.k8s.io", "kind": "RoleBinding", "namespace": "shop", "name": "read" },
                    { "group": "apiextensions.k8s.io", "kind": "CustomResourceDefinition", "name": "widgets.example.com" },
                    { "group": "example.com", "kind": "Widget", "namespace": "shop", "name": "w" },
                    { "kind": "Namespace", "name": "shop-extra" },
                ],
            }),
        );
        assert_eq!(
            (app.status, app.status_text.as_deref()),
            (GraphStatus::Critical, Some("Degraded · Synced"))
        );
        assert_eq!(
            facts(&app),
            [
                ("Project", "team-a"),
                ("Health", "Degraded"),
                ("Sync", "Synced"),
                ("Revision", "0123456"),
                ("Destination", "shop"),
                (
                    "Other resources",
                    "6 (ClusterRole, CustomResourceDefinition, Namespace, RoleBinding, Widget)"
                ),
            ]
        );
        assert_eq!(
            refs(&app),
            [
                (GraphRel::Manages, "Deployment/shop/web".to_owned(), false),
                (GraphRel::Manages, "Service/shop/web".to_owned(), false),
                (GraphRel::Manages, "Secret/shop/creds".to_owned(), false),
                (
                    GraphRel::Manages,
                    "Application/argocd/child".to_owned(),
                    false
                ),
                (
                    GraphRel::Manages,
                    "CiliumClusterwideNetworkPolicy//base".to_owned(),
                    false
                ),
                (
                    GraphRel::Project,
                    "AppProject/argocd/team-a".to_owned(),
                    false
                ),
            ]
        );
    }

    #[test]
    fn an_application_s_health_decides_before_its_sync() {
        for (health, sync, status, text) in [
            (
                Some("Healthy"),
                Some("Synced"),
                GraphStatus::Nominal,
                Some("Healthy · Synced"),
            ),
            (
                Some("Degraded"),
                Some("Synced"),
                GraphStatus::Critical,
                Some("Degraded · Synced"),
            ),
            (
                Some("Missing"),
                Some("OutOfSync"),
                GraphStatus::Critical,
                Some("Missing · OutOfSync"),
            ),
            (
                Some("Progressing"),
                Some("Synced"),
                GraphStatus::Warning,
                Some("Progressing · Synced"),
            ),
            (
                Some("Suspended"),
                Some("Synced"),
                GraphStatus::Warning,
                Some("Suspended · Synced"),
            ),
            (
                Some("Healthy"),
                Some("OutOfSync"),
                GraphStatus::Warning,
                Some("Healthy · OutOfSync"),
            ),
            (
                Some("Unknown"),
                Some("Synced"),
                GraphStatus::Neutral,
                Some("Unknown · Synced"),
            ),
            (
                Some("Healthy"),
                Some("Unknown"),
                GraphStatus::Neutral,
                Some("Healthy · Unknown"),
            ),
            (Some("Healthy"), None, GraphStatus::Neutral, Some("Healthy")),
            (None, None, GraphStatus::Neutral, None),
        ] {
            let mut said = json!({});
            if let Some(health) = health {
                said["health"] = json!({ "status": health });
            }
            if let Some(sync) = sync {
                said["sync"] = json!({ "status": sync });
            }
            let app = application(json!({ "project": "p" }), said);
            assert_eq!(
                (app.status, app.status_text.as_deref()),
                (status, text),
                "{health:?} {sync:?}"
            );
        }
    }

    #[test]
    fn revision_and_destination_read_as_the_board_shows_them() {
        for (sync, revision) in [
            (json!({ "revision": SHA }), Some("0123456")),
            (json!({ "revision": "v1.2.0" }), Some("v1.2.0")),
            (json!({ "revision": &SHA[..39] }), Some(&SHA[..39])),
            (
                json!({ "revision": SHA.replace('a', "g") }),
                Some("0123456789gbcdef0123456789gbcdef01234567"),
            ),
            (json!({ "revisions": [SHA, "main"] }), Some("0123456, main")),
            (json!({}), None),
        ] {
            let app = application(json!({}), json!({ "sync": sync }));
            assert_eq!(fact(&facts(&app), "Revision"), revision, "{sync}");
        }
        for (destination, text) in [
            (
                json!({ "server": "https://kubernetes.default.svc", "namespace": "shop" }),
                Some("shop"),
            ),
            (
                json!({ "name": "in-cluster", "namespace": "shop" }),
                Some("shop"),
            ),
            (
                json!({ "name": "prod", "namespace": "shop" }),
                Some("shop · prod"),
            ),
            (
                json!({ "server": "https://10.0.0.1:6443", "namespace": "shop" }),
                Some("shop · https://10.0.0.1:6443"),
            ),
            (
                json!({ "name": "prod", "server": "https://10.0.0.1:6443" }),
                Some("prod"),
            ),
            (json!({ "server": "https://kubernetes.default.svc" }), None),
            (json!({}), None),
        ] {
            let app = application(json!({ "destination": destination }), json!({}));
            assert_eq!(fact(&facts(&app), "Destination"), text, "{destination}");
        }
    }

    /// Review Focus 3: odd fields count as absent; nothing panics and nothing is invented.
    #[test]
    fn an_application_with_odd_status_fields() {
        for status in [
            json!({ "resources": { "kind": "Deployment", "name": "web" }, "health": "Healthy", "sync": ["Synced"] }),
            json!({ "resources": "all", "health": { "status": 3 }, "sync": { "status": null, "revision": 7 } }),
            json!({ "resources": [
                7, "web", null, {},
                { "kind": "Deployment" },
                { "name": "web" },
                { "kind": 5, "name": "x" },
                { "group": "apps", "kind": "Deployment", "name": "web", "namespace": 4 },
            ] }),
            json!("Synced"),
            json!(null),
        ] {
            let app = application(
                json!({ "project": ["x"], "destination": "in-cluster" }),
                status.clone(),
            );
            assert_eq!(
                (app.status, app.status_text.as_deref()),
                (GraphStatus::Neutral, None),
                "{status}"
            );
            assert_eq!(facts(&app), [("Project", "default")], "{status}");
            assert_eq!(
                refs(&app),
                [(
                    GraphRel::Project,
                    "AppProject/argocd/default".to_owned(),
                    false
                )],
                "{status}"
            );
        }
    }

    #[test]
    fn an_application_set_is_critical_while_an_error_occurred() {
        let set = |conditions: Value| {
            item(
                Kind::ApplicationSet,
                json!({
                    "metadata": { "name": "apps", "namespace": "argocd" },
                    "status": { "conditions": conditions },
                }),
            )
        };
        let failed = set(json!([
            { "type": "ResourcesUpToDate", "status": "True" },
            { "type": "ErrorOccurred", "status": "True", "message": "failed to render template", "reason": "ApplicationGenerationFromParamsError" },
        ]));
        assert_eq!(
            (failed.status, failed.status_text.as_deref()),
            (GraphStatus::Critical, Some("failed to render template"))
        );
        let no_message =
            set(json!([{ "type": "ErrorOccurred", "status": "True", "reason": "RenderError" }]));
        assert_eq!(
            (no_message.status, no_message.status_text.as_deref()),
            (GraphStatus::Critical, Some("RenderError"))
        );
        for fine in [
            json!([{ "type": "ErrorOccurred", "status": "False", "message": "Successfully generated parameters" }]),
            json!([]),
            json!("ErrorOccurred"),
        ] {
            let set = set(fine.clone());
            assert_eq!(
                (set.status, set.status_text.as_deref()),
                (GraphStatus::Nominal, None),
                "{fine}"
            );
            assert!(set.facts.is_empty() && set.refs.is_empty());
        }
    }

    #[test]
    fn an_app_project_counts_its_destinations_and_source_repos() {
        let project = item(
            Kind::AppProject,
            json!({
                "metadata": { "name": "team-a", "namespace": "argocd" },
                "spec": {
                    "destinations": [{ "server": "*", "namespace": "shop" }, { "name": "prod", "namespace": "*" }],
                    "sourceRepos": ["https://example.com/shop.git"],
                },
            }),
        );
        assert_eq!(
            (project.status, project.status_text.as_deref()),
            (GraphStatus::Neutral, None)
        );
        assert_eq!(
            facts(&project),
            [("Destinations", "2"), ("Source repos", "1")]
        );
        let odd = item(
            Kind::AppProject,
            json!({ "metadata": { "name": "odd", "namespace": "argocd" }, "spec": { "destinations": "all" } }),
        );
        assert_eq!(facts(&odd), [("Destinations", "0"), ("Source repos", "0")]);
    }
}
