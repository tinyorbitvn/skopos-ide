//! What a tool call's card shows (spec §4.4): its title, its result and its details. The
//! panel draws a card from these as they are, so every visible string is built here.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::error::{ErrorCode, IpcError};
use crate::metrics::UsageOf;
use crate::resources::ResourceRef;

pub const LIST_CLUSTERS_TITLE: &str = "List clusters";
pub const LIST_KINDS_TITLE: &str = "List kinds";
/// A list's table shows at most this many rows.
pub const DETAIL_ROWS: usize = 20;
/// An object's or a log's details show at most this many lines.
pub const DETAIL_LINES: usize = 40;
const ALL_NAMESPACES: &str = "all namespaces";

/// One tool call as the chat shows it. Sent with `running: true` when the call starts and
/// again, under the same `id`, when it ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolCard {
    pub id: String,
    /// The cluster's name in a global chat, shown as a chip; `None` in a per-cluster chat.
    pub cluster: Option<String>,
    pub title: String,
    /// Empty while running.
    pub result: String,
    pub tone: CardTone,
    pub details: CardDetails,
    pub running: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CardTone {
    Normal,
    Danger,
}

/// What a card shows when opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum CardDetails {
    None,
    Table {
        head: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Text {
        text: String,
    },
}

/// `<n> <plural>`, or `1 <singular>`.
pub fn count_result(n: usize, singular: &str, plural: &str) -> String {
    format!("{n} {}", if n == 1 { singular } else { plural })
}

/// The plural a title shows: the Kind's casing with the plural's ending (`ConfigMaps`,
/// `NetworkPolicies`), or the plural as served when the two do not line up.
pub fn kinds_label(r: &ResourceRef) -> String {
    let kind = r.kind.as_str();
    if let Some(head) = r.plural.get(..kind.len()) {
        if head.eq_ignore_ascii_case(kind) {
            return format!("{kind}{}", &r.plural[kind.len()..]);
        }
    }
    if let Some(stem) = kind.strip_suffix(['y', 'Y']) {
        if r.plural.eq_ignore_ascii_case(&format!("{stem}ies")) {
            return format!("{stem}ies");
        }
    }
    r.plural.clone()
}

/// The selectors a list was asked with, label selector first.
pub fn selector_text(label: Option<&str>, field: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = [label, field].into_iter().flatten().collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// `List <Kinds> · <namespace or all namespaces>[ · <selector>]`.
pub fn list_title(kinds: &str, namespace: Option<&str>, selector: Option<&str>) -> String {
    let mut title = format!("List {kinds} · {}", namespace.unwrap_or(ALL_NAMESPACES));
    if let Some(selector) = selector {
        title.push_str(" · ");
        title.push_str(selector);
    }
    title
}

/// A cluster-scoped kind's list title, which has no namespace: `List <Kinds>[ · <selector>]`.
pub fn cluster_list_title(kinds: &str, selector: Option<&str>) -> String {
    match selector {
        Some(selector) => format!("List {kinds} · {selector}"),
        None => format!("List {kinds}"),
    }
}

/// `<namespace>/<name>`, or the name alone for a cluster-scoped object.
pub fn object_path(namespace: Option<&str>, name: &str) -> String {
    match namespace {
        Some(namespace) => format!("{namespace}/{name}"),
        None => name.to_owned(),
    }
}

/// `Read <Kind> <namespace>/<name>`.
pub fn object_title(kind: &str, namespace: Option<&str>, name: &str) -> String {
    format!("Read {kind} {}", object_path(namespace, name))
}

pub fn found_result(found: bool) -> String {
    if found { "Found" } else { "Not found" }.to_owned()
}

/// `Read events · <Kind> <name>`.
pub fn object_events_title(kind: &str, name: &str) -> String {
    format!("Read events · {kind} {name}")
}

/// `Read events · <namespace or all namespaces>`.
pub fn namespace_events_title(namespace: Option<&str>) -> String {
    format!("Read events · {}", namespace.unwrap_or(ALL_NAMESPACES))
}

/// `<n> events`, plus `, <reason> <count> times` for the Warning reason seen most often,
/// counting each event's `count` (or `series.count`, or once). A tie keeps the first.
pub fn events_result(events: &[Value]) -> String {
    let mut text = count_result(events.len(), "event", "events");
    let mut warnings: Vec<(String, usize)> = Vec::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("Warning") {
            continue;
        }
        let Some(reason) = event.get("reason").and_then(Value::as_str) else {
            continue;
        };
        let count = event
            .get("count")
            .and_then(Value::as_u64)
            .or_else(|| event.pointer("/series/count").and_then(Value::as_u64))
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or(1);
        match warnings.iter_mut().find(|(seen, _)| seen == reason) {
            Some((_, total)) => *total += count,
            None => warnings.push((reason.to_owned(), count)),
        }
    }
    let mut top: Option<&(String, usize)> = None;
    for warning in &warnings {
        if top.is_none_or(|best| warning.1 > best.1) {
            top = Some(warning);
        }
    }
    if let Some((reason, count)) = top {
        text.push_str(&format!(
            ", {reason} {}",
            count_result(*count, "time", "times")
        ));
    }
    text
}

/// `Read logs · <pod>[ · <container>][ · previous container] · last <n> lines`.
pub fn logs_title(pod: &str, container: Option<&str>, previous: bool, tail_lines: u32) -> String {
    let mut parts = vec!["Read logs".to_owned(), pod.to_owned()];
    if let Some(container) = container {
        parts.push(container.to_owned());
    }
    if previous {
        parts.push("previous container".to_owned());
    }
    parts.push(format!(
        "last {}",
        count_result(tail_lines as usize, "line", "lines")
    ));
    parts.join(" · ")
}

/// `Read usage · Pods · <namespace or all namespaces>` or `Read usage · Nodes`.
pub fn usage_title(of: UsageOf, namespace: Option<&str>) -> String {
    match of {
        UsageOf::Nodes => "Read usage · Nodes".to_owned(),
        UsageOf::Pods => format!(
            "Read usage · Pods · {}",
            namespace.unwrap_or(ALL_NAMESPACES)
        ),
    }
}

/// `<n> Pods` or `<n> nodes`.
pub fn usage_result(of: UsageOf, n: usize) -> String {
    match of {
        UsageOf::Nodes => count_result(n, "node", "nodes"),
        UsageOf::Pods => count_result(n, "Pod", "Pods"),
    }
}

/// `List Helm releases · <namespace or all namespaces>`.
pub fn helm_list_title(namespace: Option<&str>) -> String {
    format!(
        "List Helm releases · {}",
        namespace.unwrap_or(ALL_NAMESPACES)
    )
}

/// `Read Helm release <namespace>/<name>`.
pub fn helm_release_title(namespace: &str, name: &str) -> String {
    format!("Read Helm release {namespace}/{name}")
}

/// `Revision <n>, <status>`.
pub fn helm_release_result(revision: u32, status: &str) -> String {
    format!("Revision {revision}, {status}")
}

/// A failed read's card result: `Forbidden` when the API said 403, else `Failed: <message>`.
pub fn failed_result(error: &IpcError) -> String {
    if error.code == ErrorCode::Forbidden {
        "Forbidden".to_owned()
    } else {
        format!("Failed: {}", error.message)
    }
}

/// What a read of a namespace outside the cluster's limit returns (spec §4.5).
pub fn outside_note(namespace: &str, cluster: &str, allowed: &[String]) -> String {
    format!(
        "{namespace} is outside the namespaces the person lets agents see on {cluster}: {}.",
        allowed.join(", ")
    )
}

/// What every tool of a cluster that is not connected returns (spec §8).
pub fn not_connected(cluster: &str) -> String {
    format!("{cluster} is not connected. Ask the person to connect it.")
}

/// A table of the first `DETAIL_ROWS` rows, or nothing when there is no row.
pub fn table(head: &[&str], mut rows: Vec<Vec<String>>) -> CardDetails {
    if rows.is_empty() {
        return CardDetails::None;
    }
    rows.truncate(DETAIL_ROWS);
    CardDetails::Table {
        head: head.iter().map(|cell| (*cell).to_owned()).collect(),
        rows,
    }
}

/// The first `DETAIL_LINES` lines, or nothing for an empty text.
pub fn text_details(text: &str) -> CardDetails {
    if text.trim().is_empty() {
        return CardDetails::None;
    }
    CardDetails::Text {
        text: text
            .lines()
            .take(DETAIL_LINES)
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resource(kind: &str, plural: &str) -> ResourceRef {
        ResourceRef {
            group: String::new(),
            version: "v1".to_owned(),
            plural: plural.to_owned(),
            kind: kind.to_owned(),
            namespaced: true,
        }
    }

    fn event(kind: &str, reason: &str, count: Option<u64>) -> Value {
        let mut event = json!({ "type": kind, "reason": reason });
        if let Some(count) = count {
            event["count"] = json!(count);
        }
        event
    }

    #[test]
    fn counts_take_the_singular_for_one() {
        assert_eq!(count_result(1, "Pod", "Pods"), "1 Pod");
        assert_eq!(count_result(0, "Pod", "Pods"), "0 Pods");
        assert_eq!(count_result(2, "Pod", "Pods"), "2 Pods");
    }

    #[test]
    fn kinds_keep_the_kind_casing_with_the_plural_ending() {
        for (kind, plural, label) in [
            ("Pod", "pods", "Pods"),
            ("ConfigMap", "configmaps", "ConfigMaps"),
            ("Ingress", "ingresses", "Ingresses"),
            ("NetworkPolicy", "networkpolicies", "NetworkPolicies"),
            ("Endpoints", "endpoints", "Endpoints"),
            ("Person", "people", "people"),
        ] {
            assert_eq!(kinds_label(&resource(kind, plural)), label);
        }
    }

    #[test]
    fn list_titles_name_the_namespace_or_all_and_the_selector() {
        assert_eq!(list_title("Pods", Some("shop"), None), "List Pods · shop");
        assert_eq!(
            list_title("Pods", None, Some("app=web")),
            "List Pods · all namespaces · app=web"
        );
        assert_eq!(cluster_list_title("Nodes", None), "List Nodes");
        assert_eq!(
            cluster_list_title("Nodes", Some("kubernetes.io/os=linux")),
            "List Nodes · kubernetes.io/os=linux"
        );
        assert_eq!(
            selector_text(Some("app=web"), Some("status.phase=Running")).as_deref(),
            Some("app=web, status.phase=Running")
        );
        assert_eq!(selector_text(None, Some("a=b")).as_deref(), Some("a=b"));
        assert_eq!(selector_text(None, None), None);
    }

    #[test]
    fn object_titles_and_results() {
        assert_eq!(
            object_title("Deployment", Some("shop"), "web"),
            "Read Deployment shop/web"
        );
        assert_eq!(object_title("Node", None, "worker"), "Read Node worker");
        assert_eq!(found_result(true), "Found");
        assert_eq!(found_result(false), "Not found");
        assert_eq!(object_events_title("Pod", "web"), "Read events · Pod web");
        assert_eq!(namespace_events_title(Some("shop")), "Read events · shop");
        assert_eq!(namespace_events_title(None), "Read events · all namespaces");
    }

    #[test]
    fn event_results_name_the_most_frequent_warning() {
        let events = [
            event("Warning", "BackOff", Some(3)),
            event("Warning", "FailedMount", Some(2)),
            event("Warning", "BackOff", None),
            event("Normal", "Pulled", Some(9)),
        ];
        assert_eq!(events_result(&events), "4 events, BackOff 4 times");
        assert_eq!(events_result(&[]), "0 events");
        assert_eq!(
            events_result(&[event("Normal", "Pulled", Some(9))]),
            "1 event"
        );
        let series = json!({ "type": "Warning", "reason": "Unhealthy", "series": { "count": 2 } });
        assert_eq!(events_result(&[series]), "1 event, Unhealthy 2 times");
        let tie = [
            event("Warning", "A", Some(2)),
            event("Warning", "B", Some(2)),
        ];
        assert_eq!(events_result(&tie), "2 events, A 2 times");
        assert_eq!(
            events_result(&[event("Warning", "A", Some(1))]),
            "1 event, A 1 time"
        );
    }

    #[test]
    fn log_titles_list_what_was_asked() {
        assert_eq!(
            logs_title("web", None, false, 100),
            "Read logs · web · last 100 lines"
        );
        assert_eq!(
            logs_title("web", Some("main"), true, 1),
            "Read logs · web · main · previous container · last 1 line"
        );
    }

    #[test]
    fn usage_and_helm_titles_and_results() {
        assert_eq!(
            usage_title(UsageOf::Pods, Some("shop")),
            "Read usage · Pods · shop"
        );
        assert_eq!(
            usage_title(UsageOf::Pods, None),
            "Read usage · Pods · all namespaces"
        );
        assert_eq!(
            usage_title(UsageOf::Nodes, Some("shop")),
            "Read usage · Nodes"
        );
        assert_eq!(usage_result(UsageOf::Nodes, 1), "1 node");
        assert_eq!(usage_result(UsageOf::Pods, 2), "2 Pods");
        assert_eq!(helm_list_title(None), "List Helm releases · all namespaces");
        assert_eq!(helm_list_title(Some("shop")), "List Helm releases · shop");
        assert_eq!(
            helm_release_title("shop", "web"),
            "Read Helm release shop/web"
        );
        assert_eq!(helm_release_result(3, "deployed"), "Revision 3, deployed");
    }

    #[test]
    fn a_failed_read_says_forbidden_on_403() {
        assert_eq!(
            failed_result(&IpcError::new(ErrorCode::Forbidden, "pods is forbidden")),
            "Forbidden"
        );
        assert_eq!(
            failed_result(&IpcError::new(ErrorCode::NotFound, "gone")),
            "Failed: gone"
        );
    }

    #[test]
    fn notes_name_the_cluster() {
        assert_eq!(
            outside_note("default", "prod", &["a".to_owned(), "b".to_owned()]),
            "default is outside the namespaces the person lets agents see on prod: a, b."
        );
        assert_eq!(
            not_connected("prod"),
            "prod is not connected. Ask the person to connect it."
        );
    }

    #[test]
    fn details_keep_the_first_rows_and_lines() {
        assert_eq!(table(&["Name"], Vec::new()), CardDetails::None);
        let rows: Vec<Vec<String>> = (0..25).map(|n| vec![n.to_string()]).collect();
        match table(&["Name"], rows) {
            CardDetails::Table { head, rows } => {
                assert_eq!(head, ["Name"]);
                assert_eq!(rows.len(), DETAIL_ROWS);
                assert_eq!(rows[19], ["19"]);
            }
            other => panic!("not a table: {other:?}"),
        }
        assert_eq!(text_details(""), CardDetails::None);
        let text: String = (1..=50).map(|n| format!("line {n}\n")).collect();
        let first: Vec<String> = (1..=DETAIL_LINES).map(|n| format!("line {n}")).collect();
        assert_eq!(
            text_details(&text),
            CardDetails::Text {
                text: first.join("\n")
            }
        );
    }

    #[test]
    fn cards_serialize_in_camel_case_with_tagged_details() {
        let card = ToolCard {
            id: "a1".to_owned(),
            cluster: Some("prod".to_owned()),
            title: "List Pods · shop".to_owned(),
            result: "1 Pod".to_owned(),
            tone: CardTone::Danger,
            details: CardDetails::Table {
                head: vec!["Name".to_owned()],
                rows: vec![vec!["web".to_owned()]],
            },
            running: false,
        };
        assert_eq!(
            serde_json::to_value(&card).unwrap(),
            json!({
                "id": "a1",
                "cluster": "prod",
                "title": "List Pods · shop",
                "result": "1 Pod",
                "tone": "danger",
                "details": { "type": "table", "head": ["Name"], "rows": [["web"]] },
                "running": false,
            })
        );
        assert_eq!(
            serde_json::to_value(CardDetails::None).unwrap(),
            json!({ "type": "none" })
        );
        let back: ToolCard = serde_json::from_value(serde_json::to_value(&card).unwrap()).unwrap();
        assert_eq!(back, card);
    }
}
