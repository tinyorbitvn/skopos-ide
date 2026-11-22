//! The change tools (spec §4.4) and the gate every call to them goes through (§4.5, §6.3,
//! §6.4). The gate runs in core on each call and reads the cluster's saved settings again, so a
//! setting changed during a chat applies to the next call; it does not rest on the agent's own
//! permission prompts. A change tool reaches the gate whether or not the chat lists it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use k8s_openapi::jiff::Zoned;
use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::kinds::resolve_kind;
use super::trim::{namespace_allowed, trim_object};
use super::{
    ChangeGate, ChangeOutcome, ChangeRequest, ChangeTool, ScopeCluster, ToolContext, ToolScope,
};
use crate::agents::approvals::{
    Approvals, ChangeAnswer, ChangeAnswerOrStop, ChangeCard, ChangeState, RolloutTarget,
};
use crate::agents::diff::{yaml_diff, DiffKind, DiffLine};
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::prefs::{AgentChanges, ClusterAgentSettings};
use crate::resources::{restartable, scalable, PatchKind, Propagation, ResourceRef};
use crate::sessions::random_hex;

const APPLY_OBJECT: &str = "apply_object";
const PATCH_OBJECT: &str = "patch_object";
const SCALE: &str = "scale";
const RESTART: &str = "restart";
const DELETE_OBJECT: &str = "delete_object";
const EXEC: &str = "exec";
/// Every change tool, in the order a chat lists them.
pub const CHANGE_TOOLS: [&str; 6] = [
    APPLY_OBJECT,
    PATCH_OBJECT,
    SCALE,
    RESTART,
    DELETE_OBJECT,
    EXEC,
];

const APPLIED: &str = "Applied.";
const DENIED: &str = "The person denied this change.";
const STOPPED: &str = "The chat was stopped.";
const DELETED: &str = "Deleted.";
/// The longest summary a card shows (spec §4.4).
const SUMMARY_LIMIT: usize = 200;
const DEFAULT_EXEC_SECONDS: u64 = 30;
const MAX_EXEC_SECONDS: u64 = 120;
/// The lines of an exec's output its card shows.
const OUTPUT_LINES: usize = 20;

const APPLY_DESCRIPTION: &str = "Create or change one object with server-side apply. A namespaced object without metadata.namespace goes to the default namespace. The change may wait for the person's approval, and the person may deny it.";
const PATCH_DESCRIPTION: &str = "Patch one object. Read it first and say what you will change. The change may wait for the person's approval, and the person may deny it.";
const SCALE_DESCRIPTION: &str = "Set the replicas of a Deployment, StatefulSet or ReplicaSet. The change may wait for the person's approval, and the person may deny it.";
const RESTART_DESCRIPTION: &str = "Restart the Pods of a Deployment, StatefulSet or DaemonSet with a rolling restart. The change may wait for the person's approval, and the person may deny it.";
const DELETE_DESCRIPTION: &str =
    "Delete one object. The change may wait for the person's approval, and the person may deny it.";
const EXEC_DESCRIPTION: &str = "Run one command in a container, without a terminal or input, and get its exit code and output (at most 64 KiB). Each command counts as a change: it may wait for the person's approval, and the person may deny it.";

fn read_only_text(cluster: &str) -> String {
    format!("Changes to {cluster} are read only for agents.")
}

fn limit_text(cluster: &str, namespaces: &[String]) -> String {
    format!(
        "{cluster} limits agents to these namespaces: {}.",
        namespaces.join(", ")
    )
}

fn secrets_text(cluster: &str) -> String {
    format!("Secret values are hidden from agents on {cluster}, so they can't change Secrets.")
}

fn exec_off_text(cluster: &str) -> String {
    format!("{cluster} doesn't let agents run commands in containers.")
}

fn not_connected_text(cluster: &str) -> String {
    format!("{cluster} is not connected. Ask the person to connect it.")
}

#[derive(Deserialize)]
struct ApplyArgs {
    yaml: String,
}

#[derive(Deserialize)]
struct PatchArgs {
    kind: String,
    namespace: Option<String>,
    name: String,
    patch: Value,
    patch_type: PatchKind,
}

#[derive(Deserialize)]
struct ScaleArgs {
    kind: String,
    namespace: String,
    name: String,
    replicas: i32,
}

#[derive(Deserialize)]
struct RestartArgs {
    kind: String,
    namespace: String,
    name: String,
}

#[derive(Deserialize)]
struct DeleteArgs {
    kind: String,
    namespace: Option<String>,
    name: String,
}

#[derive(Deserialize)]
struct ExecArgs {
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Vec<String>,
    timeout_seconds: Option<u64>,
}

/// A JSON Schema object of these properties. A global chat adds a required `cluster`, one of
/// the chat's clusters by name (spec §4.4).
fn input_schema(properties: Value, required: &[&str], scope: &ToolScope) -> Arc<JsonObject> {
    let mut properties = match properties {
        Value::Object(properties) => properties,
        _ => JsonObject::new(),
    };
    let mut required: Vec<Value> = required.iter().map(|field| Value::from(*field)).collect();
    if scope.global {
        let names: Vec<Value> = scope
            .clusters
            .iter()
            .map(|cluster| Value::from(cluster.name.as_str()))
            .collect();
        properties.insert(
            "cluster".to_owned(),
            json!({ "type": "string", "enum": names, "description": "The cluster to change." }),
        );
        required.insert(0, Value::from("cluster"));
    }
    let mut schema = JsonObject::new();
    schema.insert("type".to_owned(), Value::from("object"));
    schema.insert("properties".to_owned(), Value::Object(properties));
    schema.insert("required".to_owned(), Value::Array(required));
    Arc::new(schema)
}

fn kind_property() -> Value {
    json!({
        "type": "string",
        "description": "A Kind (Deployment), a plural (deployments), a short name (deploy) or <plural>.<group>.",
    })
}

fn summary_property() -> Value {
    json!({
        "type": "string",
        "maxLength": SUMMARY_LIMIT,
        "description": "One line for the person: what this change does and why.",
    })
}

fn apply_tool(scope: &ToolScope) -> Tool {
    let properties = json!({
        "yaml": { "type": "string", "description": "One YAML document: the whole object." },
        "summary": summary_property(),
    });
    Tool::new(
        APPLY_OBJECT,
        APPLY_DESCRIPTION,
        input_schema(properties, &["yaml", "summary"], scope),
    )
}

fn patch_tool(scope: &ToolScope) -> Tool {
    let properties = json!({
        "kind": kind_property(),
        "namespace": { "type": "string", "description": "Leave it out for a cluster-scoped kind." },
        "name": { "type": "string" },
        "patch": { "description": "An object for merge and strategic patches, a list of operations for a JSON patch." },
        "patch_type": { "type": "string", "enum": ["merge", "strategic", "json"] },
        "summary": summary_property(),
    });
    Tool::new(
        PATCH_OBJECT,
        PATCH_DESCRIPTION,
        input_schema(
            properties,
            &["kind", "name", "patch", "patch_type", "summary"],
            scope,
        ),
    )
}

fn scale_tool(scope: &ToolScope) -> Tool {
    let properties = json!({
        "kind": kind_property(),
        "namespace": { "type": "string" },
        "name": { "type": "string" },
        "replicas": { "type": "integer", "minimum": 0 },
        "summary": summary_property(),
    });
    Tool::new(
        SCALE,
        SCALE_DESCRIPTION,
        input_schema(
            properties,
            &["kind", "namespace", "name", "replicas", "summary"],
            scope,
        ),
    )
}

fn restart_tool(scope: &ToolScope) -> Tool {
    let properties = json!({
        "kind": kind_property(),
        "namespace": { "type": "string" },
        "name": { "type": "string" },
        "summary": summary_property(),
    });
    Tool::new(
        RESTART,
        RESTART_DESCRIPTION,
        input_schema(properties, &["kind", "namespace", "name", "summary"], scope),
    )
}

fn delete_tool(scope: &ToolScope) -> Tool {
    let properties = json!({
        "kind": kind_property(),
        "namespace": { "type": "string", "description": "Leave it out for a cluster-scoped kind." },
        "name": { "type": "string" },
        "summary": summary_property(),
    });
    Tool::new(
        DELETE_OBJECT,
        DELETE_DESCRIPTION,
        input_schema(properties, &["kind", "name", "summary"], scope),
    )
}

fn exec_tool(scope: &ToolScope) -> Tool {
    let properties = json!({
        "namespace": { "type": "string" },
        "pod": { "type": "string" },
        "container": { "type": "string", "description": "Leave it out for the Pod's default container." },
        "command": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "The program and its arguments, word by word; no shell unless you run one." },
        "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": MAX_EXEC_SECONDS, "default": DEFAULT_EXEC_SECONDS },
        "summary": summary_property(),
    });
    Tool::new(
        EXEC,
        EXEC_DESCRIPTION,
        input_schema(
            properties,
            &["namespace", "pod", "command", "summary"],
            scope,
        ),
    )
}

/// The change tools this chat lists (spec §4.4, §4.5): none in a per-cluster chat on a Read only
/// cluster; otherwise all five, and `exec` when one of the chat's clusters that is not Read only
/// lets agents run commands.
pub fn change_tools(ctx: &ToolContext) -> Vec<Tool> {
    let settings: Vec<ClusterAgentSettings> = ctx
        .scope
        .clusters
        .iter()
        .map(|cluster| ctx.core.cluster_agent_settings(&cluster.id))
        .collect();
    let read_only = |s: &ClusterAgentSettings| matches!(s.changes, AgentChanges::ReadOnly);
    if !ctx.scope.global && settings.iter().all(read_only) {
        return Vec::new();
    }
    let scope = &ctx.scope;
    let mut tools = vec![
        apply_tool(scope),
        patch_tool(scope),
        scale_tool(scope),
        restart_tool(scope),
        delete_tool(scope),
    ];
    if settings.iter().any(|s| s.exec && !read_only(s)) {
        tools.push(exec_tool(scope));
    }
    tools
}

pub fn is_change_tool(name: &str) -> bool {
    CHANGE_TOOLS.contains(&name)
}

/// Runs a change tool through the chat's gate. What the gate refuses comes back as a tool error.
pub async fn call_change_tool(ctx: &ToolContext, name: &str, args: JsonObject) -> CallToolResult {
    let request = match change_request(&ctx.scope, name, &args) {
        Ok(request) => request,
        Err(text) => return tool_error(text),
    };
    match ctx.gate.decide(request).await {
        ChangeOutcome::Applied { text } => CallToolResult::success(vec![ContentBlock::text(text)]),
        ChangeOutcome::Refused { text } => tool_error(text),
    }
}

fn tool_error(text: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}

fn change_request(
    scope: &ToolScope,
    name: &str,
    args: &JsonObject,
) -> Result<ChangeRequest, String> {
    let cluster = target_cluster(scope, args)?;
    let summary = args
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let tool = change_tool(name, args)?;
    Ok(ChangeRequest {
        cluster,
        tool,
        summary,
    })
}

/// The cluster a call changes: the chat's own, or in a global chat the one it names.
fn target_cluster(scope: &ToolScope, args: &JsonObject) -> Result<ScopeCluster, String> {
    if !scope.global {
        return scope
            .clusters
            .first()
            .cloned()
            .ok_or_else(|| "This chat has no cluster.".to_owned());
    }
    let names = scope
        .clusters
        .iter()
        .map(|cluster| cluster.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let Some(wanted) = args.get("cluster").and_then(Value::as_str) else {
        return Err(format!("Name the cluster to change: one of {names}."));
    };
    scope
        .clusters
        .iter()
        .find(|cluster| cluster.name == wanted)
        .cloned()
        .ok_or_else(|| format!("{wanted} is not one of this chat's clusters: {names}."))
}

fn parsed<T: DeserializeOwned>(tool: &str, args: &JsonObject) -> Result<T, String> {
    serde_json::from_value(Value::Object(args.clone()))
        .map_err(|error| format!("The arguments of {tool} are not valid: {error}"))
}

fn given(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}

/// A patch the agent sent as text is read as JSON or YAML.
fn patch_value(patch: Value) -> Result<Value, String> {
    match patch {
        Value::String(text) => serde_yaml_ng::from_str(&text)
            .map_err(|_| "The patch is not valid JSON or YAML.".to_owned()),
        other => Ok(other),
    }
}

fn exec_seconds(asked: Option<u64>) -> u64 {
    asked
        .unwrap_or(DEFAULT_EXEC_SECONDS)
        .clamp(1, MAX_EXEC_SECONDS)
}

fn change_tool(name: &str, args: &JsonObject) -> Result<ChangeTool, String> {
    Ok(match name {
        APPLY_OBJECT => {
            let args: ApplyArgs = parsed(name, args)?;
            ChangeTool::Apply { yaml: args.yaml }
        }
        PATCH_OBJECT => {
            let args: PatchArgs = parsed(name, args)?;
            ChangeTool::Patch {
                kind: args.kind,
                namespace: given(args.namespace),
                name: args.name,
                patch: patch_value(args.patch)?,
                patch_type: args.patch_type,
            }
        }
        SCALE => {
            let args: ScaleArgs = parsed(name, args)?;
            ChangeTool::Scale {
                kind: args.kind,
                namespace: args.namespace,
                name: args.name,
                replicas: args.replicas,
            }
        }
        RESTART => {
            let args: RestartArgs = parsed(name, args)?;
            ChangeTool::Restart {
                kind: args.kind,
                namespace: args.namespace,
                name: args.name,
            }
        }
        DELETE_OBJECT => {
            let args: DeleteArgs = parsed(name, args)?;
            ChangeTool::Delete {
                kind: args.kind,
                namespace: given(args.namespace),
                name: args.name,
            }
        }
        EXEC => {
            let args: ExecArgs = parsed(name, args)?;
            ChangeTool::Exec {
                namespace: args.namespace,
                pod: args.pod,
                container: given(args.container),
                command: args.command,
                timeout_seconds: exec_seconds(args.timeout_seconds),
            }
        }
        _ => return Err(format!("{name} is not a change tool.")),
    })
}

/// The gate of one chat: Task 7's `ChangeGate` with the chat's approvals (spec §4.5).
pub struct ChatGate {
    pub core: AppCore,
    pub approvals: Arc<Approvals>,
    pub scope: ToolScope,
}

impl ChangeGate for ChatGate {
    fn decide(
        &self,
        request: ChangeRequest,
    ) -> Pin<Box<dyn Future<Output = ChangeOutcome> + Send + '_>> {
        Box::pin(self.run(request))
    }
}

/// What a change acts on, its kind resolved.
struct Target {
    resource: ResourceRef,
    /// `None` for a cluster-scoped object.
    namespace: Option<String>,
    name: String,
}

/// A change that passed steps 1 to 4.
struct Prepared {
    card: ChangeCard,
    target: Target,
    settings: ClusterAgentSettings,
}

#[derive(Clone, Copy)]
enum Decision {
    WithoutAsking { standing: bool },
    Approved { standing: bool },
}

/// What applying a change gave.
struct Done {
    /// For the agent.
    text: String,
    result: Option<String>,
    output: Option<String>,
}

impl Done {
    fn plain() -> Done {
        Done {
            text: APPLIED.to_owned(),
            result: None,
            output: None,
        }
    }

    /// `Applied.` and the object's new resource version.
    fn object(object: &Value) -> Done {
        let text = match object
            .pointer("/metadata/resourceVersion")
            .and_then(Value::as_str)
        {
            Some(version) => format!("{APPLIED}\nresourceVersion: {version}"),
            None => APPLIED.to_owned(),
        };
        Done {
            text,
            result: None,
            output: None,
        }
    }
}

impl ChatGate {
    async fn run(&self, request: ChangeRequest) -> ChangeOutcome {
        let ChangeRequest {
            cluster,
            tool,
            summary,
        } = request;
        let prepared = match self.prepare(&cluster, &tool, &summary).await {
            Ok(prepared) => prepared,
            Err(text) => return ChangeOutcome::Refused { text },
        };
        let Prepared {
            mut card,
            target,
            settings,
        } = prepared;
        let decision = if matches!(settings.changes, AgentChanges::DontAsk) {
            Decision::WithoutAsking { standing: false }
        } else if self.approvals.standing(&cluster.id) {
            Decision::WithoutAsking { standing: true }
        } else {
            match self.approvals.ask(card.clone()).await {
                ChangeAnswerOrStop::Answer(ChangeAnswer::Approve) => {
                    Decision::Approved { standing: false }
                }
                ChangeAnswerOrStop::Answer(ChangeAnswer::ApproveForChat) => {
                    self.approvals.grant_standing(&cluster.id);
                    Decision::Approved { standing: true }
                }
                ChangeAnswerOrStop::Answer(ChangeAnswer::Deny) => {
                    return self.ended(card, ChangeState::Denied, DENIED).await
                }
                ChangeAnswerOrStop::Stopped => {
                    return self.ended(card, ChangeState::Stopped, STOPPED).await
                }
            }
        };
        match self.apply(&cluster.id, &tool, &target).await {
            Ok(done) => {
                card.state = match decision {
                    Decision::WithoutAsking { standing } => {
                        ChangeState::AppliedWithoutAsking { standing }
                    }
                    Decision::Approved { standing } => ChangeState::Approved {
                        at: clock_time(),
                        standing,
                    },
                };
                card.result = done.result;
                card.output = done.output;
                self.approvals.show(card).await;
                ChangeOutcome::Applied { text: done.text }
            }
            Err(error) => {
                card.state = ChangeState::Failed {
                    message: error.message.clone(),
                };
                card.rollout = None;
                self.approvals.show(card).await;
                ChangeOutcome::Refused {
                    text: error.message,
                }
            }
        }
    }

    /// A change that ends unapplied: its card says how, and the agent is told.
    async fn ended(&self, mut card: ChangeCard, state: ChangeState, text: &str) -> ChangeOutcome {
        card.state = state;
        card.rollout = None;
        self.approvals.show(card).await;
        ChangeOutcome::Refused {
            text: text.to_owned(),
        }
    }

    /// Steps 1 to 4: the refusals, then the preview.
    async fn prepare(
        &self,
        cluster: &ScopeCluster,
        tool: &ChangeTool,
        summary: &str,
    ) -> Result<Prepared, String> {
        if !self
            .scope
            .clusters
            .iter()
            .any(|known| known.id == cluster.id)
        {
            return Err(format!(
                "{} is not one of this chat's clusters.",
                cluster.name
            ));
        }
        let settings = self.core.cluster_agent_settings(&cluster.id);
        if matches!(settings.changes, AgentChanges::ReadOnly) {
            return Err(read_only_text(&cluster.name));
        }
        if !matches!(
            self.core.cluster_state(&cluster.id),
            ConnectionState::Connected { .. }
        ) {
            return Err(not_connected_text(&cluster.name));
        }
        let target = self.target(&cluster.id, tool).await?;
        if let Some(allowed) = &settings.namespaces {
            let inside = target
                .namespace
                .as_deref()
                .is_some_and(|namespace| namespace_allowed(&settings, namespace));
            if !inside {
                return Err(limit_text(&cluster.name, allowed));
            }
        }
        if is_secret(&target.resource) && !settings.secret_values {
            return Err(secrets_text(&cluster.name));
        }
        if matches!(tool, ChangeTool::Exec { .. }) && !settings.exec {
            return Err(exec_off_text(&cluster.name));
        }
        let card = self
            .preview(cluster, tool, &target, summary, settings.secret_values)
            .await?;
        Ok(Prepared {
            card,
            target,
            settings,
        })
    }

    /// The resource, namespace and name a change acts on.
    async fn target(&self, id: &ClusterId, tool: &ChangeTool) -> Result<Target, String> {
        let (kind, namespace, name) = match tool {
            ChangeTool::Apply { yaml } => {
                let found = self.core.apply_target(id, yaml).await.map_err(message)?;
                return Ok(Target {
                    resource: found.resource,
                    namespace: found.namespace,
                    name: found.name,
                });
            }
            ChangeTool::Exec { namespace, pod, .. } => {
                return Ok(Target {
                    resource: pods(),
                    namespace: Some(namespace.clone()),
                    name: pod.clone(),
                });
            }
            ChangeTool::Patch {
                kind,
                namespace,
                name,
                ..
            }
            | ChangeTool::Delete {
                kind,
                namespace,
                name,
            } => (kind.clone(), namespace.clone(), name.clone()),
            ChangeTool::Scale {
                kind,
                namespace,
                name,
                ..
            }
            | ChangeTool::Restart {
                kind,
                namespace,
                name,
            } => (kind.clone(), Some(namespace.clone()), name.clone()),
        };
        let served = self
            .core
            .resources_discover(id, false)
            .await
            .map_err(message)?;
        let resource = resolve_kind(&kind, &served)?;
        let namespace = if resource.namespaced {
            Some(namespace.ok_or_else(|| format!("{} needs a namespace.", resource.kind))?)
        } else {
            None
        };
        Ok(Target {
            resource,
            namespace,
            name,
        })
    }

    /// Step 4: the card, from the live object and, for apply and patch, a server-side dry run.
    async fn preview(
        &self,
        cluster: &ScopeCluster,
        tool: &ChangeTool,
        target: &Target,
        summary: &str,
        reveal: bool,
    ) -> Result<ChangeCard, String> {
        let id = &cluster.id;
        let namespace = target.namespace.as_deref();
        let kind = target.resource.kind.clone();
        let path = object_path(namespace, &target.name);
        let mut command = None;
        let (title, diff) = match tool {
            ChangeTool::Apply { yaml } => {
                let before = self.live(id, target).await?;
                let (_, _, _, after) = self
                    .core
                    .resource_apply_one(id, yaml, true)
                    .await
                    .map_err(message)?;
                let verb = if before.is_some() { "Change" } else { "Create" };
                let before = before.unwrap_or(Value::Null);
                (
                    format!("{verb} {kind} {path}"),
                    trimmed_diff(before, after, reveal),
                )
            }
            ChangeTool::Patch {
                patch, patch_type, ..
            } => {
                let before = self.existing(id, target).await?;
                let after = self
                    .core
                    .resource_patch(
                        id,
                        &target.resource,
                        namespace,
                        &target.name,
                        patch,
                        *patch_type,
                        true,
                    )
                    .await
                    .map_err(message)?;
                (
                    format!("Change {kind} {path}"),
                    trimmed_diff(before, after, reveal),
                )
            }
            ChangeTool::Scale { replicas, .. } => {
                if !scalable(&target.resource) {
                    return Err(format!("{kind} cannot be scaled"));
                }
                if *replicas < 0 {
                    return Err("the replica count cannot be negative".to_owned());
                }
                let before = self.existing(id, target).await?;
                let old = before
                    .pointer("/spec/replicas")
                    .and_then(Value::as_i64)
                    .unwrap_or(1);
                let diff = vec![
                    diff_line(DiffKind::Removed, format!("replicas: {old}")),
                    diff_line(DiffKind::Added, format!("replicas: {replicas}")),
                ];
                (format!("Scale {kind} {path} to {replicas}"), diff)
            }
            ChangeTool::Restart { .. } => {
                if !restartable(&target.resource) {
                    return Err(format!("{kind} cannot be restarted"));
                }
                self.existing(id, target).await?;
                (format!("Restart {kind} {path}"), Vec::new())
            }
            ChangeTool::Delete { .. } => {
                self.existing(id, target).await?;
                (format!("Delete {kind} {path}"), Vec::new())
            }
            ChangeTool::Exec { command: words, .. } => {
                if words.is_empty() {
                    return Err(
                        "Give the command as a list of words, such as [\"ls\", \"/\"].".to_owned(),
                    );
                }
                self.existing(id, target).await?;
                command = Some(words.clone());
                (format!("Run a command in Pod {path}"), Vec::new())
            }
        };
        Ok(ChangeCard {
            id: random_hex(),
            cluster: cluster.name.clone(),
            title,
            summary: one_line(summary),
            diff,
            command,
            state: ChangeState::Waiting,
            result: None,
            rollout: rollout_of(id, tool, target),
            output: None,
        })
    }

    /// The object as it is now, or `None` when there is none yet.
    async fn live(&self, id: &ClusterId, target: &Target) -> Result<Option<Value>, String> {
        let read = self
            .core
            .resource_get_raw(
                id,
                &target.resource,
                target.namespace.as_deref(),
                &target.name,
            )
            .await;
        match read {
            Ok(object) => Ok(Some(object)),
            Err(error) if error.code == ErrorCode::NotFound => Ok(None),
            Err(error) => Err(error.message),
        }
    }

    /// The object as it is now. A change to an object that is not there is refused.
    async fn existing(&self, id: &ClusterId, target: &Target) -> Result<Value, String> {
        self.core
            .resource_get_raw(
                id,
                &target.resource,
                target.namespace.as_deref(),
                &target.name,
            )
            .await
            .map_err(message)
    }

    /// Steps 6 and 7: the change itself and what it gave.
    async fn apply(&self, id: &ClusterId, tool: &ChangeTool, target: &Target) -> CoreResult<Done> {
        let namespace = target.namespace.as_deref();
        let name = target.name.as_str();
        match tool {
            ChangeTool::Apply { yaml } => {
                let (_, _, _, object) = self.core.resource_apply_one(id, yaml, false).await?;
                Ok(Done::object(&object))
            }
            ChangeTool::Patch {
                patch, patch_type, ..
            } => {
                let object = self
                    .core
                    .resource_patch(
                        id,
                        &target.resource,
                        namespace,
                        name,
                        patch,
                        *patch_type,
                        false,
                    )
                    .await?;
                Ok(Done::object(&object))
            }
            ChangeTool::Scale { replicas, .. } => {
                self.core
                    .workload_scale(
                        id,
                        &target.resource,
                        namespace.unwrap_or_default(),
                        name,
                        *replicas,
                    )
                    .await?;
                Ok(self.reread(id, target).await)
            }
            ChangeTool::Restart { .. } => {
                self.core
                    .workload_restart(id, &target.resource, namespace.unwrap_or_default(), name)
                    .await?;
                Ok(self.reread(id, target).await)
            }
            ChangeTool::Delete { .. } => {
                self.core
                    .resource_delete(
                        id,
                        &target.resource,
                        namespace,
                        name,
                        Propagation::Background,
                    )
                    .await?;
                Ok(Done {
                    text: APPLIED.to_owned(),
                    result: Some(DELETED.to_owned()),
                    output: None,
                })
            }
            ChangeTool::Exec {
                container,
                command,
                timeout_seconds,
                ..
            } => {
                let timeout = Duration::from_secs((*timeout_seconds).clamp(1, MAX_EXEC_SECONDS));
                let ran = self
                    .core
                    .pod_exec_once(
                        id,
                        namespace.unwrap_or_default(),
                        name,
                        container.as_deref(),
                        command,
                        timeout,
                    )
                    .await?;
                let code = exit_line(ran.exit_code);
                Ok(Done {
                    text: format!("{APPLIED}\n{code}\n\n{}", ran.output),
                    result: Some(code),
                    output: Some(first_lines(&ran.output, OUTPUT_LINES)),
                })
            }
        }
    }

    /// The object's new resource version, after a change whose answer does not carry it.
    async fn reread(&self, id: &ClusterId, target: &Target) -> Done {
        match self.existing(id, target).await {
            Ok(object) => Done::object(&object),
            Err(_) => Done::plain(),
        }
    }
}

fn message(error: IpcError) -> String {
    error.message
}

fn pods() -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "pods".into(),
        kind: "Pod".into(),
        namespaced: true,
    }
}

/// A core `v1` Secret, by its resolved kind (spec §4.5).
fn is_secret(resource: &ResourceRef) -> bool {
    resource.group.is_empty() && resource.plural == "secrets"
}

/// `<namespace>/<name>`, or the name alone for a cluster-scoped object.
fn object_path(namespace: Option<&str>, name: &str) -> String {
    match namespace {
        Some(namespace) => format!("{namespace}/{name}"),
        None => name.to_owned(),
    }
}

/// The first line of the agent's summary, at most `SUMMARY_LIMIT` characters.
fn one_line(summary: &str) -> String {
    summary
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(SUMMARY_LIMIT)
        .collect()
}

fn diff_line(kind: DiffKind, text: String) -> DiffLine {
    DiffLine { kind, text }
}

/// The diff of the two objects trimmed as the tools trim what they return (Task 7).
fn trimmed_diff(mut before: Value, mut after: Value, reveal: bool) -> Vec<DiffLine> {
    for object in [&mut before, &mut after] {
        if object.is_object() {
            trim_object(object, reveal);
        }
    }
    yaml_diff(&before, &after)
}

/// The workload whose rollout the panel follows after this change (R5).
fn rollout_of(cluster: &ClusterId, tool: &ChangeTool, target: &Target) -> Option<RolloutTarget> {
    let rolls = matches!(
        tool,
        ChangeTool::Apply { .. }
            | ChangeTool::Patch { .. }
            | ChangeTool::Scale { .. }
            | ChangeTool::Restart { .. }
    );
    let workload = target.resource.group == "apps"
        && matches!(
            target.resource.plural.as_str(),
            "deployments" | "statefulsets" | "daemonsets"
        );
    match &target.namespace {
        Some(namespace) if rolls && workload => Some(RolloutTarget {
            cluster_id: cluster.clone(),
            resource: target.resource.clone(),
            namespace: namespace.clone(),
            name: target.name.clone(),
        }),
        _ => None,
    }
}

fn exit_line(code: Option<i32>) -> String {
    match code {
        Some(code) => format!("Exit code {code}"),
        None => "Exit code unknown".to_owned(),
    }
}

fn first_lines(text: &str, count: usize) -> String {
    text.lines().take(count).collect::<Vec<_>>().join("\n")
}

/// The local time, `HH:MM`, for `Approved. Applied at 14:02.`
fn clock_time() -> String {
    Zoned::now().strftime("%H:%M").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(global: bool) -> ToolScope {
        ToolScope {
            clusters: vec![
                ScopeCluster {
                    id: "id-prod".to_owned(),
                    name: "prod".to_owned(),
                },
                ScopeCluster {
                    id: "id-stage".to_owned(),
                    name: "stage".to_owned(),
                },
            ],
            global,
        }
    }

    fn args(value: Value) -> JsonObject {
        match value {
            Value::Object(args) => args,
            _ => JsonObject::new(),
        }
    }

    #[test]
    fn the_policy_texts_name_the_cluster() {
        assert_eq!(
            read_only_text("prod"),
            "Changes to prod are read only for agents."
        );
        assert_eq!(
            limit_text("prod", &["ingest".to_owned(), "payments".to_owned()]),
            "prod limits agents to these namespaces: ingest, payments."
        );
        assert_eq!(
            secrets_text("prod"),
            "Secret values are hidden from agents on prod, so they can't change Secrets."
        );
        assert_eq!(
            exec_off_text("prod"),
            "prod doesn't let agents run commands in containers."
        );
        assert_eq!(
            not_connected_text("prod"),
            "prod is not connected. Ask the person to connect it."
        );
    }

    #[test]
    fn a_summary_is_one_trimmed_line_of_at_most_200_characters() {
        assert_eq!(one_line("  Scale api to 3  \nbecause"), "Scale api to 3");
        assert_eq!(one_line(&"x".repeat(250)).chars().count(), 200);
        assert_eq!(one_line(""), "");
    }

    #[test]
    fn cluster_scoped_objects_are_named_without_a_namespace() {
        assert_eq!(object_path(Some("payments"), "api"), "payments/api");
        assert_eq!(object_path(None, "node-1"), "node-1");
    }

    #[test]
    fn a_command_waits_30_seconds_by_default_and_at_most_120() {
        assert_eq!(exec_seconds(None), 30);
        assert_eq!(exec_seconds(Some(500)), 120);
        assert_eq!(exec_seconds(Some(0)), 1);
    }

    #[test]
    fn a_patch_sent_as_text_is_read_as_json_or_yaml() {
        assert_eq!(
            patch_value(json!("{\"spec\": {\"replicas\": 2}}")).unwrap(),
            json!({ "spec": { "replicas": 2 } })
        );
        assert_eq!(
            patch_value(json!("spec:\n  replicas: 2\n")).unwrap(),
            json!({ "spec": { "replicas": 2 } })
        );
        assert!(patch_value(json!("{")).is_err());
        assert_eq!(patch_value(json!([1])).unwrap(), json!([1]));
    }

    #[test]
    fn an_exec_result_gives_the_exit_code_and_the_first_lines() {
        assert_eq!(exit_line(Some(3)), "Exit code 3");
        assert_eq!(exit_line(None), "Exit code unknown");
        assert_eq!(first_lines("a\nb\nc\n", 2), "a\nb");
    }

    #[test]
    fn a_global_chat_changes_the_cluster_it_names() {
        let named = target_cluster(&scope(true), &args(json!({ "cluster": "stage" }))).unwrap();
        assert_eq!(named.id, "id-stage");
        assert!(target_cluster(&scope(true), &JsonObject::new()).is_err());
        assert!(target_cluster(&scope(true), &args(json!({ "cluster": "dev" }))).is_err());
        let own = target_cluster(&scope(false), &args(json!({ "cluster": "stage" }))).unwrap();
        assert_eq!(own.id, "id-prod", "a per-cluster chat ignores the argument");
    }

    #[test]
    fn a_global_chat_adds_a_required_cluster_argument() {
        let global = input_schema(
            json!({ "name": { "type": "string" } }),
            &["name"],
            &scope(true),
        );
        assert_eq!(global["required"], json!(["cluster", "name"]));
        assert_eq!(
            global["properties"]["cluster"]["enum"],
            json!(["prod", "stage"])
        );
        let own = input_schema(
            json!({ "name": { "type": "string" } }),
            &["name"],
            &scope(false),
        );
        assert_eq!(own["required"], json!(["name"]));
        assert!(own["properties"].get("cluster").is_none());
    }

    #[test]
    fn arguments_are_read_per_tool() {
        let exec = change_tool(
            EXEC,
            &args(json!({
                "namespace": "default", "pod": "p", "container": "",
                "command": ["ls"], "timeout_seconds": 600,
            })),
        )
        .unwrap();
        assert!(matches!(
            exec,
            ChangeTool::Exec {
                container: None,
                timeout_seconds: 120,
                ..
            }
        ));
        let patch = change_tool(
            PATCH_OBJECT,
            &args(json!({
                "kind": "Deployment", "name": "api", "patch": {}, "patch_type": "strategic",
            })),
        )
        .unwrap();
        assert!(matches!(
            patch,
            ChangeTool::Patch {
                namespace: None,
                patch_type: PatchKind::Strategic,
                ..
            }
        ));
        assert!(change_tool(SCALE, &args(json!({ "kind": "Deployment" }))).is_err());
        assert!(change_tool("get_object", &JsonObject::new()).is_err());
        assert!(is_change_tool("delete_object"));
        assert!(!is_change_tool("get_object"));
    }
}
