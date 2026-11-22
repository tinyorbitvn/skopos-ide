//! The read tools of spec §4.4. A call checks its arguments and names its cluster, sends
//! its card as running, reads through the core, trims and caps what it read, and sends
//! the card again as done. Namespaced reads keep to the cluster's namespace limit and
//! Secret values follow its setting (§4.5); both come from the settings saved now, so a
//! change applies to the next call.

use rmcp::model::{CallToolResult, ContentBlock, Tool};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::cards::{
    cluster_list_title, count_result, events_result, failed_result, found_result, helm_list_title,
    helm_release_result, helm_release_title, kinds_label, list_title, logs_title,
    namespace_events_title, not_connected, object_events_title, object_path, object_title,
    outside_note, selector_text, table, text_details, usage_result, usage_title, CardDetails,
    CardTone, ToolCard, LIST_CLUSTERS_TITLE, LIST_KINDS_TITLE,
};
use super::kinds::{group_version, is_namespaces, resolve_kind, resource_name};
use super::trim::{cap_lines, cap_text, list_text, namespace_allowed, trim_object};
use super::{ScopeCluster, ToolContext, ToolScope};
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::helm::HelmReleaseDetail;
use crate::metrics::{UsageItem, UsageOf};
use crate::prefs::{AgentChanges, ClusterAgentSettings};
use crate::resources::{state_name, ResourceRef};
use crate::sessions::random_hex;

const LIST_CLUSTERS: &str = "list_clusters";
const LIST_KINDS: &str = "list_kinds";
const LIST_OBJECTS: &str = "list_objects";
const GET_OBJECT: &str = "get_object";
const GET_EVENTS: &str = "get_events";
const GET_LOGS: &str = "get_logs";
const GET_USAGE: &str = "get_usage";
const LIST_HELM_RELEASES: &str = "list_helm_releases";
const GET_HELM_RELEASE: &str = "get_helm_release";

const DEFAULT_LIST_LIMIT: u32 = 100;
const MAX_LIST_LIMIT: u32 = 500;
const DEFAULT_TAIL_LINES: u32 = 100;
const MAX_TAIL_LINES: u32 = 1_000;

const CLUSTER_DESCRIPTION: &str = "The cluster, by its name in this chat.";
const KIND_DESCRIPTION: &str = "A Kind (Deployment), a plural (deployments), a short name (deploy) or <plural>.<group>, as list_kinds shows them.";

/// The read tools of a chat, `list_clusters` first in a global chat.
pub(crate) fn read_tools(scope: &ToolScope) -> Vec<Tool> {
    let mut tools = Vec::new();
    if scope.global {
        tools.push(Tool::new(
            LIST_CLUSTERS,
            "Lists the clusters of this chat, with their state and what agents may do on each.",
            schema(Map::new(), Vec::new()),
        ));
    }
    tools.push(scoped(
        scope,
        LIST_KINDS,
        "Lists the kinds of objects the cluster serves, with the names the kind argument takes.",
        Vec::new(),
        &[],
    ));
    tools.push(scoped(
        scope,
        LIST_OBJECTS,
        "Lists objects of one kind as YAML, trimmed. A result holds at most 64 KiB.",
        vec![
            ("kind", text_param(KIND_DESCRIPTION)),
            (
                "namespace",
                text_param("Only this namespace. Without it, every namespace this chat may read."),
            ),
            (
                "label_selector",
                text_param("A label selector, such as app=web."),
            ),
            (
                "field_selector",
                text_param("A field selector, such as status.phase=Running."),
            ),
            (
                "limit",
                count_param(
                    "At most this many objects: 100 when left out, at most 500.",
                    MAX_LIST_LIMIT,
                ),
            ),
        ],
        &["kind"],
    ));
    tools.push(scoped(
        scope,
        GET_OBJECT,
        "Reads one object as YAML, trimmed.",
        vec![
            ("kind", text_param(KIND_DESCRIPTION)),
            (
                "namespace",
                text_param("The object's namespace; leave it out for a cluster-scoped kind."),
            ),
            ("name", text_param("The object's name.")),
        ],
        &["kind", "name"],
    ));
    tools.push(scoped(
        scope,
        GET_EVENTS,
        "Reads events, newest first: about one object, about objects of one kind, or in a namespace.",
        vec![
            ("kind", text_param("The kind of the objects the events are about.")),
            ("namespace", text_param("Only events in this namespace.")),
            (
                "name",
                text_param("The name of the object the events are about; needs kind."),
            ),
        ],
        &[],
    ));
    tools.push(scoped(
        scope,
        GET_LOGS,
        "Reads the last lines of a container's log, each with its timestamp.",
        vec![
            ("namespace", text_param("The Pod's namespace.")),
            ("pod", text_param("The Pod's name.")),
            (
                "container",
                text_param("The container; needed when the Pod has several."),
            ),
            (
                "previous",
                json!({
                    "type": "boolean",
                    "description": "The log of the container that ran before the last restart.",
                }),
            ),
            (
                "tail_lines",
                count_param(
                    "The last this many lines: 100 when left out, at most 1,000.",
                    MAX_TAIL_LINES,
                ),
            ),
            (
                "since_seconds",
                json!({
                    "type": "integer",
                    "minimum": 1,
                    "description": "Only lines written in the last this many seconds.",
                }),
            ),
        ],
        &["namespace", "pod"],
    ));
    tools.push(scoped(
        scope,
        GET_USAGE,
        "Reads the CPU and memory Pods or nodes use now, from metrics-server.",
        vec![
            (
                "of",
                json!({
                    "type": "string",
                    "enum": ["pods", "nodes"],
                    "description": "pods or nodes.",
                }),
            ),
            ("namespace", text_param("Only Pods in this namespace.")),
        ],
        &["of"],
    ));
    tools.push(scoped(
        scope,
        LIST_HELM_RELEASES,
        "Lists Helm releases.",
        vec![("namespace", text_param("Only releases in this namespace."))],
        &[],
    ));
    tools.push(scoped(
        scope,
        GET_HELM_RELEASE,
        "Reads a Helm release: its status, then its rendered manifest.",
        vec![
            ("namespace", text_param("The release's namespace.")),
            ("name", text_param("The release's name.")),
        ],
        &["namespace", "name"],
    ));
    tools
}

/// A tool that acts on one cluster: in a global chat it takes a required `cluster`, an
/// enum of the chat's cluster names, before its own arguments.
fn scoped(
    scope: &ToolScope,
    name: &'static str,
    description: &'static str,
    params: Vec<(&'static str, Value)>,
    required: &[&'static str],
) -> Tool {
    let mut properties = Map::new();
    let mut needed: Vec<&str> = Vec::new();
    if scope.global {
        let names: Vec<&str> = scope
            .clusters
            .iter()
            .map(|cluster| cluster.name.as_str())
            .collect();
        properties.insert(
            "cluster".to_owned(),
            json!({ "type": "string", "enum": names, "description": CLUSTER_DESCRIPTION }),
        );
        needed.push("cluster");
    }
    for (key, value) in params {
        properties.insert(key.to_owned(), value);
    }
    needed.extend_from_slice(required);
    Tool::new(name, description, schema(properties, needed))
}

fn schema(properties: Map<String, Value>, required: Vec<&str>) -> Map<String, Value> {
    let mut schema = Map::new();
    schema.insert("type".to_owned(), json!("object"));
    schema.insert("properties".to_owned(), Value::Object(properties));
    schema.insert("required".to_owned(), json!(required));
    schema
}

fn text_param(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn count_param(description: &str, maximum: u32) -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": maximum, "description": description })
}

/// Runs a read tool, or returns `None` when this chat has no read tool of that name.
pub(crate) async fn call_read(
    ctx: &ToolContext,
    name: &str,
    arguments: Map<String, Value>,
) -> Option<CallToolResult> {
    let arguments = Value::Object(arguments);
    let result = match name {
        LIST_CLUSTERS if ctx.scope.global => list_clusters(ctx).await,
        LIST_KINDS => list_kinds(ctx, arguments).await,
        LIST_OBJECTS => list_objects(ctx, arguments).await,
        GET_OBJECT => get_object(ctx, arguments).await,
        GET_EVENTS => get_events(ctx, arguments).await,
        GET_LOGS => get_logs(ctx, arguments).await,
        GET_USAGE => get_usage(ctx, arguments).await,
        LIST_HELM_RELEASES => list_helm_releases(ctx, arguments).await,
        GET_HELM_RELEASE => get_helm_release(ctx, arguments).await,
        _ => return None,
    };
    Some(result)
}

#[derive(Deserialize)]
struct ListObjectsArgs {
    kind: String,
    namespace: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
struct GetObjectArgs {
    kind: String,
    namespace: Option<String>,
    name: String,
}

#[derive(Deserialize)]
struct GetEventsArgs {
    kind: Option<String>,
    namespace: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GetLogsArgs {
    namespace: String,
    pod: String,
    container: Option<String>,
    previous: Option<bool>,
    tail_lines: Option<u32>,
    since_seconds: Option<u32>,
}

#[derive(Deserialize)]
struct GetUsageArgs {
    of: UsageOf,
    namespace: Option<String>,
}

#[derive(Deserialize)]
struct ListHelmReleasesArgs {
    namespace: Option<String>,
}

#[derive(Deserialize)]
struct GetHelmReleaseArgs {
    namespace: String,
    name: String,
}

/// The cluster one call acts on, with its agent settings as saved now.
struct Target {
    cluster: ScopeCluster,
    settings: ClusterAgentSettings,
    /// The cluster's name on the card, in a global chat.
    chip: Option<String>,
}

/// Which namespaces a namespaced read may read.
enum Namespaces<'a> {
    /// Every namespace: there is no limit and none was named.
    All,
    /// The named one, which the limit allows.
    One(&'a str),
    /// None was named, so each one the limit allows.
    Each(&'a [String]),
    /// The named one is outside the limit: this note, and nothing read.
    Outside(String),
}

impl Target {
    fn sees(&self, namespace: &str) -> bool {
        namespace_allowed(&self.settings, namespace)
    }

    fn outside(&self, namespace: &str) -> String {
        outside_note(
            namespace,
            &self.cluster.name,
            self.settings.namespaces.as_deref().unwrap_or_default(),
        )
    }

    fn plan<'a>(&'a self, namespace: Option<&'a str>) -> Namespaces<'a> {
        match (namespace, self.settings.namespaces.as_deref()) {
            (Some(namespace), _) if self.sees(namespace) => Namespaces::One(namespace),
            (Some(namespace), _) => Namespaces::Outside(self.outside(namespace)),
            (None, None) => Namespaces::All,
            (None, Some(allowed)) => Namespaces::Each(allowed),
        }
    }
}

/// What a read gives the agent and the card.
struct ReadOutcome {
    text: String,
    result: String,
    details: CardDetails,
}

impl ReadOutcome {
    /// A read that returns a note and nothing else, such as a namespace outside the limit.
    fn note(text: String) -> ReadOutcome {
        ReadOutcome {
            result: text.clone(),
            text,
            details: CardDetails::None,
        }
    }
}

/// An optional argument as given, `None` when it is missing or blank.
fn given(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// A tool error for a call that never reached a cluster, so it has no card.
fn refused(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

/// The cluster a call names: the chat's own, or in a global chat its `cluster` argument.
fn target(ctx: &ToolContext, arguments: &Value) -> Result<Target, String> {
    let cluster = if ctx.scope.global {
        let names: Vec<&str> = ctx
            .scope
            .clusters
            .iter()
            .map(|cluster| cluster.name.as_str())
            .collect();
        let Some(wanted) = given(arguments.get("cluster").and_then(Value::as_str)) else {
            return Err(format!(
                "Name the cluster with the cluster argument: one of {}.",
                names.join(", ")
            ));
        };
        let Some(cluster) = ctx
            .scope
            .clusters
            .iter()
            .find(|cluster| cluster.name == wanted)
        else {
            return Err(format!(
                "No cluster named {wanted} in this chat. Use one of: {}.",
                names.join(", ")
            ));
        };
        cluster
    } else {
        let Some(cluster) = ctx.scope.clusters.first() else {
            return Err("This chat has no cluster.".to_owned());
        };
        cluster
    };
    Ok(Target {
        cluster: cluster.clone(),
        settings: ctx.core.cluster_agent_settings(&cluster.id),
        chip: ctx.scope.global.then(|| cluster.name.clone()),
    })
}

/// The call's arguments and its cluster, or the message of a tool error.
fn prepare<T: DeserializeOwned>(
    ctx: &ToolContext,
    tool: &str,
    arguments: Value,
) -> Result<(T, Target), String> {
    let target = target(ctx, &arguments)?;
    let args = serde_json::from_value(arguments)
        .map_err(|error| format!("The arguments of {tool} are not valid: {error}."))?;
    Ok((args, target))
}

fn connected(ctx: &ToolContext, target: &Target) -> CoreResult<()> {
    match ctx.core.cluster_state(&target.cluster.id) {
        ConnectionState::Connected { .. } => Ok(()),
        _ => Err(IpcError::new(
            ErrorCode::Unreachable,
            not_connected(&target.cluster.name),
        )),
    }
}

/// The served resource `kind` names on the target's cluster.
async fn resolve(ctx: &ToolContext, target: &Target, kind: &str) -> CoreResult<ResourceRef> {
    connected(ctx, target)?;
    let served = ctx
        .core
        .resources_discover(&target.cluster.id, false)
        .await?;
    resolve_kind(kind, &served).map_err(|message| IpcError::new(ErrorCode::InvalidInput, message))
}

/// Sends the card as running and returns it.
async fn start(ctx: &ToolContext, chip: Option<String>, title: String) -> ToolCard {
    let card = ToolCard {
        id: random_hex(),
        cluster: chip,
        title,
        result: String::new(),
        tone: CardTone::Normal,
        details: CardDetails::None,
        running: true,
    };
    // A chat that no longer draws cards does not stop its tools.
    let _ = ctx.cards.send(card.clone()).await;
    card
}

/// Sends the card again, done, and turns the outcome into the tool's result: the read's
/// text (its card result when the text is empty), or a tool error with the app's message
/// and a danger card (spec §8).
async fn finish(
    ctx: &ToolContext,
    mut card: ToolCard,
    outcome: CoreResult<ReadOutcome>,
) -> CallToolResult {
    card.running = false;
    let result = match outcome {
        Ok(read) => {
            let text = if read.text.is_empty() {
                read.result.clone()
            } else {
                read.text
            };
            card.result = read.result;
            card.details = read.details;
            CallToolResult::success(vec![ContentBlock::text(text)])
        }
        Err(error) => {
            card.result = failed_result(&error);
            card.tone = CardTone::Danger;
            CallToolResult::error(vec![ContentBlock::text(error.message)])
        }
    };
    let _ = ctx.cards.send(card).await;
    result
}

fn to_yaml<T: Serialize>(value: &T) -> String {
    serde_yaml_ng::to_string(value).unwrap_or_default()
}

fn name_of(object: &Value) -> &str {
    object
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn namespace_of(object: &Value) -> &str {
    object
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Whether an object read as `r` may leave the app under the namespace limit: a namespaced
/// object by its namespace, a Namespace by its name; other cluster-scoped objects always.
fn object_seen(target: &Target, r: &ResourceRef, object: &Value) -> bool {
    if is_namespaces(r) {
        target.sees(name_of(object))
    } else if r.namespaced {
        target.sees(namespace_of(object))
    } else {
        true
    }
}

fn object_row(r: &ResourceRef, object: &Value) -> Vec<String> {
    let name = name_of(object).to_owned();
    if r.namespaced {
        vec![namespace_of(object).to_owned(), name]
    } else {
        vec![name]
    }
}

async fn list_clusters(ctx: &ToolContext) -> CallToolResult {
    let card = start(ctx, None, LIST_CLUSTERS_TITLE.to_owned()).await;
    let mut documents = Vec::new();
    let mut rows = Vec::new();
    for cluster in &ctx.scope.clusters {
        let state = ctx.core.cluster_state(&cluster.id);
        let settings = ctx.core.cluster_agent_settings(&cluster.id);
        documents.push(to_yaml(&cluster_entry(cluster, &state, &settings)));
        rows.push(vec![cluster.name.clone(), state_name(&state).to_owned()]);
    }
    let total = documents.len();
    let outcome = ReadOutcome {
        text: list_text(documents, total),
        result: count_result(total, "cluster", "clusters"),
        details: table(&["Cluster", "State"], rows),
    };
    finish(ctx, card, Ok(outcome)).await
}

/// One cluster as `list_clusters` describes it, in the words of the settings (spec §3.6).
fn cluster_entry(
    cluster: &ScopeCluster,
    state: &ConnectionState,
    settings: &ClusterAgentSettings,
) -> Value {
    let mut entry = Map::new();
    entry.insert("name".to_owned(), json!(cluster.name));
    entry.insert("state".to_owned(), json!(state_name(state)));
    if let ConnectionState::Connected { info } = state {
        entry.insert("version".to_owned(), json!(info.version));
    }
    entry.insert("changes".to_owned(), json!(changes_label(settings.changes)));
    let namespaces = match &settings.namespaces {
        Some(namespaces) => json!(namespaces),
        None => json!("all"),
    };
    entry.insert("namespaces".to_owned(), namespaces);
    let secret_values = if settings.secret_values {
        "readable"
    } else {
        "hidden"
    };
    entry.insert("secretValues".to_owned(), json!(secret_values));
    let commands = if settings.exec { "on" } else { "off" };
    entry.insert("commandsInContainers".to_owned(), json!(commands));
    Value::Object(entry)
}

fn changes_label(changes: AgentChanges) -> &'static str {
    match changes {
        AgentChanges::Ask => "Ask every time",
        AgentChanges::ReadOnly => "Read only",
        AgentChanges::DontAsk => "Don't ask",
    }
}

async fn list_kinds(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let target = match target(ctx, &arguments) {
        Ok(target) => target,
        Err(message) => return refused(message),
    };
    let card = start(ctx, target.chip.clone(), LIST_KINDS_TITLE.to_owned()).await;
    let outcome = list_kinds_read(ctx, &target).await;
    finish(ctx, card, outcome).await
}

async fn list_kinds_read(ctx: &ToolContext, target: &Target) -> CoreResult<ReadOutcome> {
    connected(ctx, target)?;
    let served = ctx
        .core
        .resources_discover(&target.cluster.id, false)
        .await?;
    let mut documents = Vec::new();
    let mut rows = Vec::new();
    for info in &served {
        let r = &info.resource;
        let mut entry = json!({
            "kind": r.kind,
            "name": resource_name(r),
            "apiVersion": group_version(r),
            "namespaced": r.namespaced,
        });
        if !info.short_names.is_empty() {
            entry["shortNames"] = json!(info.short_names);
        }
        documents.push(to_yaml(&entry));
        rows.push(vec![r.kind.clone(), resource_name(r)]);
    }
    let total = documents.len();
    Ok(ReadOutcome {
        text: list_text(documents, total),
        result: count_result(total, "kind", "kinds"),
        details: table(&["Kind", "Name"], rows),
    })
}

async fn list_objects(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let (args, target) = match prepare::<ListObjectsArgs>(ctx, LIST_OBJECTS, arguments) {
        Ok(prepared) => prepared,
        Err(message) => return refused(message),
    };
    let namespace = given(args.namespace.as_deref());
    let selector = selector_text(
        given(args.label_selector.as_deref()),
        given(args.field_selector.as_deref()),
    );
    let resolved = resolve(ctx, &target, &args.kind).await;
    let title = match &resolved {
        Ok(r) if !r.namespaced => cluster_list_title(&kinds_label(r), selector.as_deref()),
        Ok(r) => list_title(&kinds_label(r), namespace, selector.as_deref()),
        Err(_) => list_title(args.kind.trim(), namespace, selector.as_deref()),
    };
    let card = start(ctx, target.chip.clone(), title).await;
    let outcome = match resolved {
        Ok(r) => list_objects_read(ctx, &target, &r, &args).await,
        Err(error) => Err(error),
    };
    finish(ctx, card, outcome).await
}

async fn list_objects_read(
    ctx: &ToolContext,
    target: &Target,
    r: &ResourceRef,
    args: &ListObjectsArgs,
) -> CoreResult<ReadOutcome> {
    let id = &target.cluster.id;
    let labels = given(args.label_selector.as_deref());
    let fields = given(args.field_selector.as_deref());
    let plan = if r.namespaced {
        target.plan(given(args.namespace.as_deref()))
    } else {
        Namespaces::All
    };
    let mut items = match plan {
        Namespaces::All => {
            ctx.core
                .resources_list_raw(id, r, None, labels, fields)
                .await?
        }
        Namespaces::One(namespace) => {
            ctx.core
                .resources_list_raw(id, r, Some(namespace), labels, fields)
                .await?
        }
        Namespaces::Each(allowed) => {
            let mut items = Vec::new();
            for namespace in allowed {
                items.extend(
                    ctx.core
                        .resources_list_raw(id, r, Some(namespace.as_str()), labels, fields)
                        .await?,
                );
            }
            items
        }
        Namespaces::Outside(note) => return Ok(ReadOutcome::note(note)),
    };
    items.retain(|item| object_seen(target, r, item));
    let total = items.len();
    let limit = args
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT) as usize;
    items.truncate(limit);
    let head: &[&str] = if r.namespaced {
        &["Namespace", "Name"]
    } else {
        &["Name"]
    };
    let mut rows = Vec::new();
    let mut documents = Vec::new();
    for mut item in items {
        trim_object(&mut item, target.settings.secret_values);
        rows.push(object_row(r, &item));
        documents.push(to_yaml(&item));
    }
    Ok(ReadOutcome {
        text: list_text(documents, total),
        result: count_result(total, &r.kind, &kinds_label(r)),
        details: table(head, rows),
    })
}

async fn get_object(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let (args, target) = match prepare::<GetObjectArgs>(ctx, GET_OBJECT, arguments) {
        Ok(prepared) => prepared,
        Err(message) => return refused(message),
    };
    let namespace = given(args.namespace.as_deref());
    let name = args.name.trim();
    let resolved = resolve(ctx, &target, &args.kind).await;
    let title = match &resolved {
        Ok(r) if !r.namespaced => object_title(&r.kind, None, name),
        Ok(r) => object_title(&r.kind, namespace, name),
        Err(_) => object_title(args.kind.trim(), namespace, name),
    };
    let card = start(ctx, target.chip.clone(), title).await;
    let outcome = match resolved {
        Ok(r) => get_object_read(ctx, &target, &r, namespace, name).await,
        Err(error) => Err(error),
    };
    finish(ctx, card, outcome).await
}

async fn get_object_read(
    ctx: &ToolContext,
    target: &Target,
    r: &ResourceRef,
    namespace: Option<&str>,
    name: &str,
) -> CoreResult<ReadOutcome> {
    if is_namespaces(r) && !target.sees(name) {
        return Ok(ReadOutcome::note(target.outside(name)));
    }
    let namespace = if r.namespaced {
        match target.plan(namespace) {
            Namespaces::One(namespace) => Some(namespace),
            Namespaces::Outside(note) => return Ok(ReadOutcome::note(note)),
            Namespaces::All | Namespaces::Each(_) => None,
        }
    } else {
        None
    };
    match ctx
        .core
        .resource_get_raw(&target.cluster.id, r, namespace, name)
        .await
    {
        Ok(mut object) => {
            trim_object(&mut object, target.settings.secret_values);
            let text = cap_text(to_yaml(&object));
            Ok(ReadOutcome {
                details: text_details(&text),
                text,
                result: found_result(true),
            })
        }
        Err(error) if error.code == ErrorCode::NotFound => Ok(ReadOutcome {
            text: format!(
                "No {} {} on {}.",
                r.kind,
                object_path(namespace, name),
                target.cluster.name
            ),
            result: found_result(false),
            details: CardDetails::None,
        }),
        Err(error) => Err(error),
    }
}

async fn get_events(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let (args, target) = match prepare::<GetEventsArgs>(ctx, GET_EVENTS, arguments) {
        Ok(prepared) => prepared,
        Err(message) => return refused(message),
    };
    let kind = given(args.kind.as_deref());
    let namespace = given(args.namespace.as_deref());
    let name = given(args.name.as_deref());
    if name.is_some() && kind.is_none() {
        return refused("get_events needs kind when it names an object.".to_owned());
    }
    let resolved = match kind {
        Some(kind) => Some(resolve(ctx, &target, kind).await),
        None => None,
    };
    let title = match (name, &resolved) {
        (Some(name), Some(Ok(r))) => object_events_title(&r.kind, name),
        (Some(name), _) => object_events_title(kind.unwrap_or_default(), name),
        (None, _) => namespace_events_title(namespace),
    };
    let card = start(ctx, target.chip.clone(), title).await;
    let outcome = match resolved {
        Some(Err(error)) => Err(error),
        Some(Ok(r)) => get_events_read(ctx, &target, Some(&r), namespace, name).await,
        None => get_events_read(ctx, &target, None, namespace, name).await,
    };
    finish(ctx, card, outcome).await
}

async fn get_events_read(
    ctx: &ToolContext,
    target: &Target,
    r: Option<&ResourceRef>,
    namespace: Option<&str>,
    name: Option<&str>,
) -> CoreResult<ReadOutcome> {
    connected(ctx, target)?;
    let id = &target.cluster.id;
    let kind = r.map(|r| r.kind.as_str());
    let events = match target.plan(namespace) {
        Namespaces::All => ctx.core.events_in(id, None, kind, name).await?,
        Namespaces::One(namespace) => {
            let one = vec![namespace.to_owned()];
            ctx.core
                .events_in(id, Some(one.as_slice()), kind, name)
                .await?
        }
        Namespaces::Each(allowed) => ctx.core.events_in(id, Some(allowed), kind, name).await?,
        Namespaces::Outside(note) => return Ok(ReadOutcome::note(note)),
    };
    let total = events.len();
    let result = events_result(&events);
    let rows = events.iter().map(event_row).collect();
    let documents = events.iter().map(to_yaml).collect();
    Ok(ReadOutcome {
        text: list_text(documents, total),
        result,
        details: table(&["Type", "Reason", "Object"], rows),
    })
}

fn event_row(event: &Value) -> Vec<String> {
    let field = |pointer: &str| {
        event
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    vec![
        field("/type"),
        field("/reason"),
        format!(
            "{} {}",
            field("/involvedObject/kind"),
            field("/involvedObject/name")
        ),
    ]
}

async fn get_logs(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let (args, target) = match prepare::<GetLogsArgs>(ctx, GET_LOGS, arguments) {
        Ok(prepared) => prepared,
        Err(message) => return refused(message),
    };
    let tail = args
        .tail_lines
        .unwrap_or(DEFAULT_TAIL_LINES)
        .clamp(1, MAX_TAIL_LINES);
    let title = logs_title(
        args.pod.trim(),
        given(args.container.as_deref()),
        args.previous.unwrap_or(false),
        tail,
    );
    let card = start(ctx, target.chip.clone(), title).await;
    let outcome = get_logs_read(ctx, &target, &args, tail).await;
    finish(ctx, card, outcome).await
}

async fn get_logs_read(
    ctx: &ToolContext,
    target: &Target,
    args: &GetLogsArgs,
    tail: u32,
) -> CoreResult<ReadOutcome> {
    connected(ctx, target)?;
    let namespace = args.namespace.trim();
    if !target.sees(namespace) {
        return Ok(ReadOutcome::note(target.outside(namespace)));
    }
    let since = args.since_seconds.filter(|seconds| *seconds > 0);
    let lines = ctx
        .core
        .pod_logs_text(
            &target.cluster.id,
            namespace,
            args.pod.trim(),
            given(args.container.as_deref()),
            args.previous.unwrap_or(false),
            tail,
            since,
        )
        .await?;
    let count = lines.len();
    let text = cap_lines(lines);
    Ok(ReadOutcome {
        details: text_details(&text),
        text,
        result: count_result(count, "line", "lines"),
    })
}

async fn get_usage(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let (args, target) = match prepare::<GetUsageArgs>(ctx, GET_USAGE, arguments) {
        Ok(prepared) => prepared,
        Err(message) => return refused(message),
    };
    let namespace = given(args.namespace.as_deref());
    let card = start(ctx, target.chip.clone(), usage_title(args.of, namespace)).await;
    let outcome = get_usage_read(ctx, &target, args.of, namespace).await;
    finish(ctx, card, outcome).await
}

async fn get_usage_read(
    ctx: &ToolContext,
    target: &Target,
    of: UsageOf,
    namespace: Option<&str>,
) -> CoreResult<ReadOutcome> {
    connected(ctx, target)?;
    let id = &target.cluster.id;
    let mut items: Vec<UsageItem> = match of {
        UsageOf::Nodes => {
            ctx.core
                .metrics_usage(id, UsageOf::Nodes, None)
                .await?
                .items
        }
        UsageOf::Pods => match target.plan(namespace) {
            Namespaces::All => ctx.core.metrics_usage(id, UsageOf::Pods, None).await?.items,
            Namespaces::One(namespace) => {
                ctx.core
                    .metrics_usage(id, UsageOf::Pods, Some(namespace))
                    .await?
                    .items
            }
            Namespaces::Each(allowed) => {
                let mut items = Vec::new();
                for namespace in allowed {
                    items.extend(
                        ctx.core
                            .metrics_usage(id, UsageOf::Pods, Some(namespace.as_str()))
                            .await?
                            .items,
                    );
                }
                items
            }
            Namespaces::Outside(note) => return Ok(ReadOutcome::note(note)),
        },
    };
    if matches!(of, UsageOf::Pods) {
        items.retain(|item| {
            item.namespace
                .as_deref()
                .is_some_and(|namespace| target.sees(namespace))
        });
    }
    let head: &[&str] = match of {
        UsageOf::Nodes => &["Name"],
        UsageOf::Pods => &["Namespace", "Name"],
    };
    let total = items.len();
    let rows = items
        .iter()
        .map(|item| match &item.namespace {
            Some(namespace) => vec![namespace.clone(), item.name.clone()],
            None => vec![item.name.clone()],
        })
        .collect();
    let documents = items.iter().map(to_yaml).collect();
    Ok(ReadOutcome {
        text: list_text(documents, total),
        result: usage_result(of, total),
        details: table(head, rows),
    })
}

async fn list_helm_releases(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let (args, target) = match prepare::<ListHelmReleasesArgs>(ctx, LIST_HELM_RELEASES, arguments) {
        Ok(prepared) => prepared,
        Err(message) => return refused(message),
    };
    let namespace = given(args.namespace.as_deref());
    let card = start(ctx, target.chip.clone(), helm_list_title(namespace)).await;
    let outcome = list_helm_releases_read(ctx, &target, namespace).await;
    finish(ctx, card, outcome).await
}

async fn list_helm_releases_read(
    ctx: &ToolContext,
    target: &Target,
    namespace: Option<&str>,
) -> CoreResult<ReadOutcome> {
    connected(ctx, target)?;
    let namespaces = match target.plan(namespace) {
        Namespaces::All => None,
        Namespaces::One(namespace) => Some(vec![namespace.to_owned()]),
        Namespaces::Each(allowed) => Some(allowed.to_vec()),
        Namespaces::Outside(note) => return Ok(ReadOutcome::note(note)),
    };
    let list = ctx
        .core
        .helm_release_list(&target.cluster.id, namespaces)
        .await?;
    let mut releases = list.releases;
    releases.retain(|release| {
        target.sees(&release.namespace)
            && namespace.is_none_or(|namespace| release.namespace == namespace)
    });
    let total = releases.len();
    let rows = releases
        .iter()
        .map(|release| vec![release.namespace.clone(), release.name.clone()])
        .collect();
    let documents = releases.iter().map(to_yaml).collect();
    let mut text = list_text(documents, total);
    if !list.failed_namespaces.is_empty() {
        text.push_str("---\n");
        text.push_str(&format!(
            "These namespaces could not be listed: {}.\n",
            list.failed_namespaces.join(", ")
        ));
    }
    Ok(ReadOutcome {
        text: cap_text(text),
        result: count_result(total, "release", "releases"),
        details: table(&["Namespace", "Name"], rows),
    })
}

async fn get_helm_release(ctx: &ToolContext, arguments: Value) -> CallToolResult {
    let (args, target) = match prepare::<GetHelmReleaseArgs>(ctx, GET_HELM_RELEASE, arguments) {
        Ok(prepared) => prepared,
        Err(message) => return refused(message),
    };
    let namespace = args.namespace.trim();
    let name = args.name.trim();
    let card = start(
        ctx,
        target.chip.clone(),
        helm_release_title(namespace, name),
    )
    .await;
    let outcome = get_helm_release_read(ctx, &target, namespace, name).await;
    finish(ctx, card, outcome).await
}

async fn get_helm_release_read(
    ctx: &ToolContext,
    target: &Target,
    namespace: &str,
    name: &str,
) -> CoreResult<ReadOutcome> {
    connected(ctx, target)?;
    if !target.sees(namespace) {
        return Ok(ReadOutcome::note(target.outside(namespace)));
    }
    let detail = ctx
        .core
        .helm_release_get(&target.cluster.id, namespace, name)
        .await?;
    let result = helm_release_result(detail.release.revision, &detail.release.status);
    let text = cap_text(release_text(&detail));
    Ok(ReadOutcome {
        details: text_details(&text),
        text,
        result,
    })
}

/// The release without its manifest and resource list, then the manifest as helm stored
/// it: `helm_release_get` has already blanked its Secret values.
fn release_text(detail: &HelmReleaseDetail) -> String {
    let mut summary = serde_json::to_value(detail).unwrap_or_default();
    if let Some(fields) = summary.as_object_mut() {
        fields.remove("manifest");
        fields.remove("resources");
    }
    let mut text = to_yaml(&summary);
    if !detail.manifest.is_empty() {
        if !detail.manifest.starts_with("---") {
            text.push_str("---\n");
        }
        text.push_str(&detail.manifest);
        if !detail.manifest.ends_with('\n') {
            text.push('\n');
        }
    }
    text
}
