//! The ACP client (spec §4.3): it starts an agent, speaks ACP v1 to it over the child's
//! stdio, forwards its permission requests to the chat, hides its calls to the `skopos` MCP
//! server and turns the rest of its updates into the chat's.
//!
//! `agent-client-protocol` runs a connection as one future whose handlers and spawned tasks
//! are `Send`, and its `ConnectionTo` handle is `Clone + Send + Sync`. The connection runs as
//! a tokio task of its own (`run_connection`) and a session sends its requests through the
//! handle from the caller's task, so every future here is `Send`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    self as wire, CancelNotification, ClientCapabilities, ContentBlock, EnvVariable,
    FileSystemCapabilities, Implementation, InitializeRequest, LoadSessionRequest, McpServer,
    McpServerStdio, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, StopReason, ToolCallContent, ToolCallStatus,
};
use agent_client_protocol::v1::ConnectionTo;
use agent_client_protocol::{Agent, ByteStreams, Client, Error as AcpError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use ts_rs::TS;

use crate::agents::permissions::{permission_card, Permissions};
use crate::error::sanitize_text;
use crate::process::configure_agent;
#[cfg(windows)]
use crate::process::JobGuard;
use crate::process::{stop, KILL_GRACE};

/// The client's name in `initialize`'s `clientInfo`.
const CLIENT_NAME: &str = "SkoposIDE";
/// The MCP server every chat gives its agent (spec §4.4).
pub const SKOPOS_SERVER: &str = "skopos";
/// The tools of the `skopos` server (spec §4.4).
pub const SKOPOS_TOOLS: [&str; 15] = [
    "list_clusters",
    "list_kinds",
    "list_objects",
    "get_object",
    "get_events",
    "get_logs",
    "get_usage",
    "list_helm_releases",
    "get_helm_release",
    "apply_object",
    "patch_object",
    "scale",
    "restart",
    "delete_object",
    "exec",
];
/// The start error of `load` when the agent's `loadSession` capability is false.
pub const CANNOT_LOAD: &str = "The agent can't reopen old chats.";
/// The stderr kept per agent, and the most of it that reaches the log (spec §4.3).
const STDERR_CAP: usize = 64 * 1024;
const STDERR_CHUNK: usize = 8 * 1024;
/// How long stderr may take to drain once the agent has exited.
const STDERR_DRAIN: Duration = Duration::from_secs(2);
/// How long a failed request waits for the exit reason once the agent's stdout has closed.
const EXIT_GRACE: Duration = Duration::from_secs(5);
/// How long `close` waits for the connection task once the agent has ended.
const CLOSE_LIMIT: Duration = Duration::from_secs(2);

/// One entry of the agent's plan, as the Plan card shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanEntry {
    pub content: String,
    pub status: PlanStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
}

/// The state of one of the agent's own tool calls. `AgentToolStatus` in TypeScript, where
/// `ToolStatus` is already the CLI tools' status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "AgentToolStatus")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// What a session forwards to its chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpUpdate {
    /// A chunk of the agent's message.
    AgentText(String),
    /// The whole plan, which replaces the Plan card.
    Plan(Vec<PlanEntry>),
    /// One of the agent's own tool calls, whole, each time it changes.
    AgentTool {
        id: String,
        title: String,
        status: ToolStatus,
        details: String,
    },
    /// A call to the `skopos` server began; its card comes from the MCP server (spec §4.4).
    HiddenTool,
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEnd {
    EndTurn,
    Cancelled,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    /// The agent answered the prompt with an error: its message.
    Error(String),
    /// The agent answered the prompt with ACP's authentication-required error.
    SignInNeeded,
    /// The agent exited: the reason (its last stderr line, or the exit code).
    Exited(String),
}

/// The `skopos` entry of `session/new`'s `mcpServers`. No `Debug`: `env` holds the chat's
/// token.
#[derive(Clone)]
pub struct McpEntry {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Why a session did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    /// `session/new` failed with ACP's authentication-required error.
    SignInNeeded,
    /// Any other failure, an exit before the session, or a load the agent cannot do: the
    /// reason.
    Failed(String),
}

/// Why a request got no answer.
enum Failure {
    Exited(String),
    Error(AcpError),
}

/// One agent process and its ACP session.
pub struct AcpSession {
    running: Running,
    session_id: SessionId,
    can_load: bool,
}

impl AcpSession {
    /// Starts `command` (stdin, stdout and stderr are piped, it is killed when dropped and
    /// gets its own process group), then `initialize` and `session/new` with `cwd` and the
    /// `skopos` entry. Updates go to `updates`, which must be read while a turn runs. The
    /// agent's permission requests wait on `permissions`; without it they are cancelled.
    pub async fn start(
        command: Command,
        cwd: &Path,
        mcp: McpEntry,
        updates: mpsc::Sender<AcpUpdate>,
        permissions: Option<Arc<Permissions>>,
    ) -> Result<AcpSession, StartError> {
        Self::open(command, cwd, Some(mcp), None, updates, permissions).await
    }

    /// As `start`, but continues the chat `session_id` with `session/load`. The agent's
    /// replay is dropped: the chat keeps its stored transcript.
    pub async fn load(
        command: Command,
        cwd: &Path,
        mcp: McpEntry,
        updates: mpsc::Sender<AcpUpdate>,
        session_id: &str,
        permissions: Option<Arc<Permissions>>,
    ) -> Result<AcpSession, StartError> {
        Self::open(
            command,
            cwd,
            Some(mcp),
            Some(session_id),
            updates,
            permissions,
        )
        .await
    }

    /// `start` or `load`; a probe passes no MCP entry.
    pub(crate) async fn open(
        command: Command,
        cwd: &Path,
        mcp: Option<McpEntry>,
        load: Option<&str>,
        updates: mpsc::Sender<AcpUpdate>,
        permissions: Option<Arc<Permissions>>,
    ) -> Result<AcpSession, StartError> {
        let live = Arc::new(AtomicBool::new(false));
        let running = Running::spawn(command, updates, permissions, Arc::clone(&live)).await?;
        match handshake(&running, cwd, mcp, load).await {
            Ok((session_id, can_load)) => {
                live.store(true, Ordering::SeqCst);
                Ok(AcpSession {
                    running,
                    session_id,
                    can_load,
                })
            }
            Err(error) => {
                running.close().await;
                Err(error)
            }
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id.0
    }

    /// The agent's `loadSession` capability.
    pub fn can_load(&self) -> bool {
        self.can_load
    }

    /// Sends one `session/prompt` with `blocks` as text blocks, in order, and waits for the
    /// turn to end. Its updates arrive on `updates` before it returns.
    pub async fn prompt(&self, blocks: Vec<String>) -> TurnEnd {
        let prompt: Vec<ContentBlock> = blocks.into_iter().map(ContentBlock::from).collect();
        let request = PromptRequest::new(self.session_id.clone(), prompt);
        let reply = self.running.connection.send_request(request).block_task();
        match self.running.answer(reply).await {
            Ok(answer) => turn_end(answer.stop_reason),
            Err(Failure::Exited(reason)) => TurnEnd::Exited(reason),
            Err(Failure::Error(error)) => turn_error(&error),
        }
    }

    /// Sends `session/cancel`; the running turn then ends `Cancelled`.
    pub fn cancel(&self) {
        let notification = CancelNotification::new(self.session_id.clone());
        if let Err(error) = self.running.connection.send_notification(notification) {
            tracing::debug!(
                "cannot send session/cancel: {}",
                sanitize_text(&error.message)
            );
        }
    }

    /// Ends the agent's process group and the connection.
    pub async fn close(self) {
        self.running.close().await;
    }
}

/// The process, its watcher and the connection task.
struct Running {
    connection: ConnectionTo<Agent>,
    /// The exit reason, once the agent has exited and its stderr has drained.
    exit: watch::Receiver<Option<String>>,
    /// Sent, or dropped, to end the process group.
    kill: oneshot::Sender<()>,
    process: JoinHandle<()>,
    /// Dropped to end the connection.
    done: oneshot::Sender<()>,
    driver: JoinHandle<()>,
    /// The job that holds the agent and what it starts; dropped with the session, it ends
    /// them all (spec §4.2).
    #[cfg(windows)]
    _job: JobGuard,
}

impl Running {
    async fn spawn(
        mut command: Command,
        updates: mpsc::Sender<AcpUpdate>,
        permissions: Option<Arc<Permissions>>,
        live: Arc<AtomicBool>,
    ) -> Result<Running, StartError> {
        configure_agent(&mut command);
        let program = command
            .as_std()
            .get_program()
            .to_string_lossy()
            .into_owned();
        let mut child = command
            .spawn()
            .map_err(|error| StartError::Failed(format!("{program}: {error}")))?;
        #[cfg(windows)]
        let job = match JobGuard::contain(&child) {
            Ok(job) => job,
            Err(error) => {
                stop(&mut child, KILL_GRACE).await;
                return Err(StartError::Failed(format!("{program}: {error}")));
            }
        };
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            stop(&mut child, KILL_GRACE).await;
            return Err(StartError::Failed(format!("{program}: no stdin or stdout")));
        };
        let stderr = child.stderr.take();
        let (kill, killed) = oneshot::channel();
        let (exited, exit) = watch::channel(None);
        let process = tokio::spawn(watch_process(child, stderr, killed, exited));
        let (connected, done, driver) = run_connection(stdin, stdout, updates, permissions, live);
        let Ok(connection) = connected.await else {
            let _ = kill.send(());
            let _ = process.await;
            driver.abort();
            let reason = exit.borrow().clone().unwrap_or_default();
            return Err(StartError::Failed(reason));
        };
        Ok(Running {
            connection,
            exit,
            kill,
            process,
            done,
            driver,
            #[cfg(windows)]
            _job: job,
        })
    }

    /// Waits for the agent's answer, or for its exit. A request that fails because the
    /// agent's stdout closed waits a little for the exit reason, which says more.
    async fn answer<T>(
        &self,
        reply: impl Future<Output = Result<T, AcpError>>,
    ) -> Result<T, Failure> {
        let mut exit = self.exit.clone();
        tokio::select! {
            biased;
            result = reply => match result {
                Ok(answer) => Ok(answer),
                Err(error)
                if self.connection.is_incoming_closed()
                    || agent_client_protocol::is_connection_terminated(&error)
                    || agent_client_protocol::is_incoming_transport_closed(&error) =>
            {
                    match tokio::time::timeout(EXIT_GRACE, exited(&mut exit)).await {
                        Ok(reason) => Err(Failure::Exited(reason)),
                        Err(_) => Err(Failure::Error(error)),
                    }
                }
                Err(error) => Err(Failure::Error(error)),
            },
            reason = exited(&mut exit) => Err(Failure::Exited(reason)),
        }
    }

    async fn close(self) {
        let _ = self.kill.send(());
        let _ = self.process.await;
        drop(self.done);
        let mut driver = self.driver;
        if tokio::time::timeout(CLOSE_LIMIT, &mut driver)
            .await
            .is_err()
        {
            driver.abort();
        }
    }
}

/// `initialize`, then `session/new` or `session/load`: the session's id and `loadSession`.
async fn handshake(
    running: &Running,
    cwd: &Path,
    mcp: Option<McpEntry>,
    load: Option<&str>,
) -> Result<(SessionId, bool), StartError> {
    let capabilities = ClientCapabilities::new()
        .fs(FileSystemCapabilities::new()
            .read_text_file(false)
            .write_text_file(false))
        .terminal(false);
    let initialize = InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(capabilities)
        .client_info(Implementation::new(CLIENT_NAME, crate::VERSION));
    let reply = running.connection.send_request(initialize).block_task();
    let answer = running.answer(reply).await.map_err(start_error)?;
    let can_load = answer.agent_capabilities.load_session;
    let servers: Vec<McpServer> = mcp.into_iter().map(mcp_server).collect();
    match load {
        None => {
            let request = NewSessionRequest::new(cwd).mcp_servers(servers);
            let reply = running.connection.send_request(request).block_task();
            let answer = running.answer(reply).await.map_err(start_error)?;
            Ok((answer.session_id, can_load))
        }
        Some(session_id) => {
            if !can_load {
                return Err(StartError::Failed(CANNOT_LOAD.to_owned()));
            }
            let session_id = SessionId::from(session_id.to_owned());
            let request = LoadSessionRequest::new(session_id.clone(), cwd).mcp_servers(servers);
            let reply = running.connection.send_request(request).block_task();
            running.answer(reply).await.map_err(start_error)?;
            Ok((session_id, can_load))
        }
    }
}

/// Runs the connection over the child's pipes until `done` is dropped or the agent's
/// stdout closes. Returns the handle once the connection is up, `done`, and the task.
fn run_connection(
    stdin: ChildStdin,
    stdout: ChildStdout,
    updates: mpsc::Sender<AcpUpdate>,
    permissions: Option<Arc<Permissions>>,
    live: Arc<AtomicBool>,
) -> (
    oneshot::Receiver<ConnectionTo<Agent>>,
    oneshot::Sender<()>,
    JoinHandle<()>,
) {
    let (connected, connection) = oneshot::channel();
    let (done, until_done) = oneshot::channel::<()>();
    let tracker = Mutex::new(Tracker::default());
    let driver = tokio::spawn(async move {
        let result = Client
            .v1()
            .name(CLIENT_NAME)
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    // A `session/load` replay arrives before the handshake is done.
                    if !live.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    let update = lock(&tracker).apply(notification.update);
                    if let Some(update) = update {
                        let _ = updates.send(update).await;
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                // Native agents spec §4.2: the request waits for the person's choice. It is
                // answered from a task of its own, so the connection keeps reading the agent's
                // other messages while the person decides.
                async move |request: RequestPermissionRequest, responder, _cx| {
                    let permissions = permissions.clone();
                    tokio::spawn(async move {
                        let chosen = match permissions {
                            Some(permissions) if !request.options.is_empty() => {
                                let card = permission_card(permissions.next_id(), &request);
                                permissions.ask(card).await
                            }
                            Some(_) => {
                                tracing::warn!("the agent asked for permission with no options");
                                None
                            }
                            None => None,
                        };
                        let outcome = match chosen {
                            Some(option_id) => RequestPermissionOutcome::Selected(
                                SelectedPermissionOutcome::new(option_id),
                            ),
                            None => RequestPermissionOutcome::Cancelled,
                        };
                        if let Err(error) =
                            responder.respond(RequestPermissionResponse::new(outcome))
                        {
                            tracing::debug!(
                                "cannot answer a permission request: {}",
                                sanitize_text(&error.message)
                            );
                        }
                    });
                    Ok(())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(
                ByteStreams::new(stdin.compat_write(), stdout.compat()),
                move |cx: ConnectionTo<Agent>| async move {
                    let _ = connected.send(cx.clone());
                    tokio::select! {
                        _ = until_done => {}
                        _ = cx.incoming_closed() => {}
                    }
                    Ok::<(), AcpError>(())
                },
            )
            .await;
        if let Err(error) = result {
            tracing::debug!("agent connection ended: {}", sanitize_text(&error.message));
        }
    });
    (connection, done, driver)
}

/// Owns the child: ends it when `killed` fires or is dropped, then publishes the exit reason
/// once stderr has drained.
async fn watch_process(
    mut child: Child,
    stderr: Option<ChildStderr>,
    mut killed: oneshot::Receiver<()>,
    exited: watch::Sender<Option<String>>,
) {
    let tail = Arc::new(Mutex::new(StderrTail::default()));
    let reader = stderr.map(|stderr| tokio::spawn(read_stderr(stderr, Arc::clone(&tail))));
    let code = tokio::select! {
        status = child.wait() => status.ok().and_then(|status| status.code()),
        _ = &mut killed => {
            stop(&mut child, KILL_GRACE).await;
            None
        }
    };
    if let Some(mut reader) = reader {
        if tokio::time::timeout(STDERR_DRAIN, &mut reader)
            .await
            .is_err()
        {
            reader.abort();
        }
    }
    let last_line = lock(&tail).last_line();
    let reason = exit_reason(last_line, code);
    exited.send_modify(|exit| *exit = Some(reason));
}

async fn read_stderr(mut stderr: ChildStderr, tail: Arc<Mutex<StderrTail>>) {
    let mut buffer = vec![0u8; STDERR_CHUNK];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let lines = lock(&tail).push(&buffer[..read]);
                for line in lines {
                    tracing::info!("agent stderr: {}", sanitize_text(&line));
                }
            }
        }
    }
}

/// The exit reason once the process task has published it.
async fn exited(exit: &mut watch::Receiver<Option<String>>) -> String {
    match exit.wait_for(Option::is_some).await {
        Ok(reason) => reason.clone().unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// The last non-blank stderr line without its trailing periods, sanitized; else the exit
/// code; else a signal.
fn exit_reason(last_line: Option<String>, code: Option<i32>) -> String {
    if let Some(line) = last_line {
        let line = sanitize_text(line.trim().trim_end_matches('.'));
        if !line.is_empty() {
            return line;
        }
    }
    match code {
        Some(code) => format!("exited with code {code}"),
        None => "stopped by a signal".to_owned(),
    }
}

/// The agent's stderr: its last 64 KiB, and the lines still to log until 64 KiB have been
/// logged.
#[derive(Default)]
struct StderrTail {
    kept: Vec<u8>,
    logged: usize,
    pending: Vec<u8>,
}

impl StderrTail {
    /// Keeps `bytes` and returns the complete, non-blank lines to log. A line longer than
    /// what may still be logged is cut there.
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.kept.extend_from_slice(bytes);
        let extra = self.kept.len().saturating_sub(STDERR_CAP);
        self.kept.drain(..extra);
        let mut lines = Vec::new();
        if self.logged >= STDERR_CAP {
            return lines;
        }
        self.pending.extend_from_slice(bytes);
        while self.logged < STDERR_CAP {
            let room = STDERR_CAP - self.logged;
            let end = match self.pending.iter().position(|&byte| byte == b'\n') {
                Some(end) if end < room => end + 1,
                _ if self.pending.len() >= room => room,
                _ => break,
            };
            let line: Vec<u8> = self.pending.drain(..end).collect();
            self.logged += line.len();
            let text = String::from_utf8_lossy(&line).trim_end().to_owned();
            if !text.is_empty() {
                lines.push(text);
            }
        }
        if self.logged >= STDERR_CAP {
            self.pending = Vec::new();
        }
        lines
    }

    fn last_line(&self) -> Option<String> {
        let text = String::from_utf8_lossy(&self.kept);
        text.lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned)
    }
}

/// Whether an ACP tool call is a call to the `skopos` server, which the client hides
/// (spec §4.3). Only a whole title in one of the agents' forms counts, so an agent's own tool
/// that merely mentions a skopos tool stays visible:
/// - Claude (`claude-agent-acp`): `mcp__skopos__<tool>`;
/// - Codex (`codex-acp`): `Tool: skopos/<tool>`, and a `rawInput` with `server` and `tool`;
/// - OpenCode: `skopos_<tool>`;
/// - Gemini CLI: `<tool> (skopos MCP Server)`, and `<tool> (skopos)`;
/// - the dotted `skopos.<tool>` and the bare `skopos/<tool>`.
///
/// `<tool>` is one of `SKOPOS_TOOLS`. A `rawInput` names the server and the tool as `server` /
/// `serverName` / `server_name` and `tool` / `toolName` / `tool_name`.
pub fn is_skopos_tool(title: &str, raw_input: Option<&Value>) -> bool {
    let title = title.trim();
    let title = title.strip_prefix("Tool: ").unwrap_or(title).trim();
    if SKOPOS_TOOLS.iter().any(|tool| title_names(title, tool)) {
        return true;
    }
    raw_input.is_some_and(|raw| {
        string_field(raw, &["server", "serverName", "server_name"]) == Some(SKOPOS_SERVER)
            && string_field(raw, &["tool", "toolName", "tool_name"])
                .is_some_and(|tool| SKOPOS_TOOLS.contains(&tool))
    })
}

fn title_names(title: &str, tool: &str) -> bool {
    [
        format!("mcp__{SKOPOS_SERVER}__{tool}"),
        format!("{SKOPOS_SERVER}/{tool}"),
        format!("{SKOPOS_SERVER}.{tool}"),
        format!("{SKOPOS_SERVER}_{tool}"),
        format!("{tool} ({SKOPOS_SERVER})"),
        format!("{tool} ({SKOPOS_SERVER} MCP Server)"),
    ]
    .iter()
    .any(|form| form == title)
}

fn string_field<'a>(raw: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| raw.get(*name).and_then(Value::as_str))
}

/// Turns ACP updates into the chat's, keeping each own tool's card and the hidden calls.
#[derive(Default)]
struct Tracker {
    tools: HashMap<String, OwnTool>,
    hidden: HashSet<String>,
}

struct OwnTool {
    title: String,
    status: ToolStatus,
    details: String,
}

impl Tracker {
    fn apply(&mut self, update: SessionUpdate) -> Option<AcpUpdate> {
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => match chunk.content {
                ContentBlock::Text(text) => Some(AcpUpdate::AgentText(text.text)),
                _ => None,
            },
            SessionUpdate::Plan(plan) => Some(AcpUpdate::Plan(
                plan.entries.into_iter().map(plan_entry).collect(),
            )),
            SessionUpdate::ToolCall(call) => {
                let id = call.tool_call_id.0.to_string();
                if is_skopos_tool(&call.title, call.raw_input.as_ref()) {
                    self.hidden.insert(id);
                    return Some(AcpUpdate::HiddenTool);
                }
                let mut details = content_text(&call.content);
                if details.is_empty() {
                    details = raw_text(call.raw_input.as_ref());
                }
                let tool = OwnTool {
                    title: call.title,
                    status: tool_status(call.status),
                    details,
                };
                Some(self.show(id, tool))
            }
            SessionUpdate::ToolCallUpdate(update) => {
                let id = update.tool_call_id.0.to_string();
                if self.hidden.contains(&id) {
                    return None;
                }
                let fields = update.fields;
                if !self.tools.contains_key(&id)
                    && is_skopos_tool(
                        fields.title.as_deref().unwrap_or_default(),
                        fields.raw_input.as_ref(),
                    )
                {
                    self.hidden.insert(id);
                    return Some(AcpUpdate::HiddenTool);
                }
                let mut tool = self.tools.remove(&id).unwrap_or_else(|| OwnTool {
                    title: String::new(),
                    status: ToolStatus::Pending,
                    details: String::new(),
                });
                if let Some(title) = fields.title {
                    tool.title = title;
                }
                if let Some(status) = fields.status {
                    tool.status = tool_status(status);
                }
                let text = fields
                    .content
                    .as_deref()
                    .map(content_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    tool.details = text;
                } else if tool.details.is_empty() {
                    tool.details = raw_text(fields.raw_input.as_ref());
                }
                Some(self.show(id, tool))
            }
            _ => None,
        }
    }

    fn show(&mut self, id: String, tool: OwnTool) -> AcpUpdate {
        let update = AcpUpdate::AgentTool {
            id: id.clone(),
            title: tool.title.clone(),
            status: tool.status,
            details: tool.details.clone(),
        };
        self.tools.insert(id, tool);
        update
    }
}

/// A card's details: its text blocks, and each diff as its path and new text.
fn content_text(content: &[ToolCallContent]) -> String {
    let parts: Vec<String> = content
        .iter()
        .filter_map(|item| match item {
            ToolCallContent::Content(content) => match &content.content {
                ContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            },
            ToolCallContent::Diff(diff) => {
                Some(format!("{}\n{}", diff.path.display(), diff.new_text))
            }
            _ => None,
        })
        .collect();
    parts.join("\n")
}

/// The tool's input as indented JSON, for a card with no content yet.
fn raw_text(raw: Option<&Value>) -> String {
    raw.and_then(|raw| serde_json::to_string_pretty(raw).ok())
        .unwrap_or_default()
}

fn plan_entry(entry: wire::PlanEntry) -> PlanEntry {
    let status = match entry.status {
        wire::PlanEntryStatus::InProgress => PlanStatus::InProgress,
        wire::PlanEntryStatus::Completed => PlanStatus::Completed,
        _ => PlanStatus::Pending,
    };
    PlanEntry {
        content: entry.content,
        status,
    }
}

fn tool_status(status: ToolCallStatus) -> ToolStatus {
    match status {
        ToolCallStatus::InProgress => ToolStatus::InProgress,
        ToolCallStatus::Completed => ToolStatus::Completed,
        ToolCallStatus::Failed => ToolStatus::Failed,
        _ => ToolStatus::Pending,
    }
}

fn turn_end(reason: StopReason) -> TurnEnd {
    match reason {
        StopReason::Cancelled => TurnEnd::Cancelled,
        StopReason::MaxTokens => TurnEnd::MaxTokens,
        StopReason::MaxTurnRequests => TurnEnd::MaxTurnRequests,
        StopReason::Refusal => TurnEnd::Refusal,
        _ => TurnEnd::EndTurn,
    }
}

/// How a turn the agent answered with `error` ended: a sign-in for authentication required,
/// else the error's message.
fn turn_error(error: &AcpError) -> TurnEnd {
    if error.code == AcpError::auth_required().code {
        TurnEnd::SignInNeeded
    } else {
        TurnEnd::Error(error_text(error))
    }
}

fn start_error(failure: Failure) -> StartError {
    match failure {
        Failure::Exited(reason) => StartError::Failed(reason),
        Failure::Error(error) if error.code == AcpError::auth_required().code => {
            StartError::SignInNeeded
        }
        Failure::Error(error) => StartError::Failed(error_text(&error)),
    }
}

/// An error answer's message, with its `data` when that is text, without trailing periods
/// (the notice adds its own) and sanitized.
fn error_text(error: &AcpError) -> String {
    let mut text = error.message.trim().trim_end_matches('.').to_owned();
    if let Some(data) = error.data.as_ref().and_then(Value::as_str) {
        let data = data.trim().trim_end_matches('.');
        if !data.is_empty() {
            text = if text.is_empty() {
                data.to_owned()
            } else {
                format!("{text}: {data}")
            };
        }
    }
    sanitize_text(&text)
}

fn mcp_server(entry: McpEntry) -> McpServer {
    let env: Vec<EnvVariable> = entry
        .env
        .into_iter()
        .map(|(name, value)| EnvVariable::new(name, value))
        .collect();
    McpServer::Stdio(
        McpServerStdio::new(SKOPOS_SERVER, entry.command)
            .args(entry.args)
            .env(env),
    )
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::v1::schema::{
        ContentChunk, Plan, PlanEntryPriority, ToolCall, ToolCallUpdate, ToolCallUpdateFields,
    };
    use serde_json::json;

    use super::*;

    fn chunk(text: &str) -> ContentChunk {
        ContentChunk::new(ContentBlock::from(text))
    }

    fn tool(id: &str, title: &str, status: ToolStatus, details: &str) -> Option<AcpUpdate> {
        Some(AcpUpdate::AgentTool {
            id: id.to_owned(),
            title: title.to_owned(),
            status,
            details: details.to_owned(),
        })
    }

    fn update(id: &'static str, fields: ToolCallUpdateFields) -> SessionUpdate {
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(id, fields))
    }

    #[test]
    fn the_title_forms_of_each_agent_name_a_skopos_tool() {
        for title in [
            "mcp__skopos__list_objects",
            "Tool: skopos/get_logs",
            "skopos/get_logs",
            "skopos.scale",
            "skopos_patch_object",
            "get_object (skopos)",
            "get_object (skopos MCP Server)",
            "  mcp__skopos__exec  ",
        ] {
            assert!(is_skopos_tool(title, None), "{title}");
        }
        for name in SKOPOS_TOOLS {
            assert!(
                is_skopos_tool(&format!("mcp__skopos__{name}"), None),
                "{name}"
            );
        }
    }

    #[test]
    fn a_title_that_only_mentions_a_tool_or_names_another_server_is_shown() {
        for title in [
            "list_objects",
            "mcp__github__list_objects",
            "Run mcp__skopos__list_objects and more",
            "skopos/unknown_tool",
            "Tool: other/get_logs",
            "get_object (other)",
            "mcp__skopos__",
            "",
        ] {
            assert!(!is_skopos_tool(title, None), "{title}");
        }
        for raw in [
            json!({ "server": "skopos" }),
            json!({ "server": "github", "tool": "get_logs" }),
            json!({ "server": "skopos", "tool": "rm" }),
            json!("skopos/get_logs"),
        ] {
            assert!(!is_skopos_tool("Run tool", Some(&raw)), "{raw}");
        }
    }

    #[test]
    fn a_raw_input_naming_the_server_and_a_tool_hides_the_call() {
        for raw in [
            json!({ "server": "skopos", "tool": "get_logs" }),
            json!({ "serverName": "skopos", "toolName": "scale" }),
            json!({ "server_name": "skopos", "tool_name": "exec", "arguments": { "pod": "api" } }),
        ] {
            assert!(is_skopos_tool("Run tool", Some(&raw)), "{raw}");
        }
    }

    #[test]
    fn text_chunks_and_plans_become_updates_and_other_kinds_do_not() {
        let mut tracker = Tracker::default();
        assert_eq!(
            tracker.apply(SessionUpdate::AgentMessageChunk(chunk("Looking"))),
            Some(AcpUpdate::AgentText("Looking".to_owned()))
        );
        let plan = Plan::new(vec![
            wire::PlanEntry::new(
                "Find the api Pods",
                PlanEntryPriority::High,
                wire::PlanEntryStatus::Completed,
            ),
            wire::PlanEntry::new(
                "Read their logs",
                PlanEntryPriority::Medium,
                wire::PlanEntryStatus::InProgress,
            ),
            wire::PlanEntry::new(
                "Explain",
                PlanEntryPriority::Low,
                wire::PlanEntryStatus::Pending,
            ),
        ]);
        assert_eq!(
            tracker.apply(SessionUpdate::Plan(plan)),
            Some(AcpUpdate::Plan(vec![
                PlanEntry {
                    content: "Find the api Pods".to_owned(),
                    status: PlanStatus::Completed,
                },
                PlanEntry {
                    content: "Read their logs".to_owned(),
                    status: PlanStatus::InProgress,
                },
                PlanEntry {
                    content: "Explain".to_owned(),
                    status: PlanStatus::Pending,
                },
            ]))
        );
        assert_eq!(
            tracker.apply(SessionUpdate::AgentThoughtChunk(chunk("Hmm"))),
            None
        );
        assert_eq!(
            tracker.apply(SessionUpdate::UserMessageChunk(chunk("replayed"))),
            None
        );
    }

    #[test]
    fn an_own_tool_card_is_resent_whole_as_it_changes() {
        let mut tracker = Tracker::default();
        assert_eq!(
            tracker.apply(SessionUpdate::ToolCall(ToolCall::new("t1", "Run ls"))),
            tool("t1", "Run ls", ToolStatus::Pending, "")
        );
        let running = ToolCallUpdateFields::new().status(ToolCallStatus::InProgress);
        assert_eq!(
            tracker.apply(update("t1", running)),
            tool("t1", "Run ls", ToolStatus::InProgress, "")
        );
        let done = ToolCallUpdateFields::new()
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::from("a.txt\nb.txt")]);
        assert_eq!(
            tracker.apply(update("t1", done)),
            tool("t1", "Run ls", ToolStatus::Completed, "a.txt\nb.txt")
        );
        let renamed = ToolCallUpdateFields::new().title("Run ls -l".to_owned());
        assert_eq!(
            tracker.apply(update("t1", renamed)),
            tool("t1", "Run ls -l", ToolStatus::Completed, "a.txt\nb.txt")
        );

        let edit = ToolCall::new("t2", "Edit a.txt").raw_input(json!({ "path": "a.txt" }));
        let raw = "{\n  \"path\": \"a.txt\"\n}";
        assert_eq!(
            tracker.apply(SessionUpdate::ToolCall(edit)),
            tool("t2", "Edit a.txt", ToolStatus::Pending, raw)
        );
        let failed = ToolCallUpdateFields::new().status(ToolCallStatus::Failed);
        assert_eq!(
            tracker.apply(update("t2", failed)),
            tool("t2", "Edit a.txt", ToolStatus::Failed, raw)
        );
    }

    #[test]
    fn a_hidden_call_stays_hidden_through_its_updates() {
        let mut tracker = Tracker::default();
        let call = ToolCall::new("s1", "mcp__skopos__get_logs").status(ToolCallStatus::InProgress);
        assert_eq!(
            tracker.apply(SessionUpdate::ToolCall(call)),
            Some(AcpUpdate::HiddenTool)
        );
        let done = ToolCallUpdateFields::new()
            .status(ToolCallStatus::Completed)
            .title("Read logs".to_owned());
        assert_eq!(tracker.apply(update("s1", done)), None);

        // An update for a call never announced is judged by its own fields.
        let first = ToolCallUpdateFields::new().title("Tool: skopos/scale".to_owned());
        assert_eq!(
            tracker.apply(update("s2", first)),
            Some(AcpUpdate::HiddenTool)
        );
        let more = ToolCallUpdateFields::new().status(ToolCallStatus::Failed);
        assert_eq!(tracker.apply(update("s2", more)), None);

        let codex = ToolCall::new("s3", "Run tool").raw_input(json!({
            "server": "skopos", "tool": "list_objects", "arguments": {}
        }));
        assert_eq!(
            tracker.apply(SessionUpdate::ToolCall(codex)),
            Some(AcpUpdate::HiddenTool)
        );
    }

    #[test]
    fn stderr_keeps_its_last_64_kib_and_its_last_line() {
        let mut tail = StderrTail::default();
        assert_eq!(tail.last_line(), None);
        tail.push(&vec![b'a'; 70 * 1024]);
        tail.push(b"\nfirst\nlast line\r\n\n");
        assert_eq!(tail.kept.len(), 64 * 1024);
        assert!(tail.kept.ends_with(b"last line\r\n\n"));
        assert_eq!(tail.last_line().as_deref(), Some("last line"));
        tail.push(b"no newline yet");
        assert_eq!(tail.last_line().as_deref(), Some("no newline yet"));
    }

    #[test]
    fn only_64_kib_of_stderr_reach_the_log() {
        let mut tail = StderrTail::default();
        assert!(tail.push(b"part").is_empty());
        assert_eq!(tail.push(b"ial\n\n"), vec!["partial".to_owned()]);

        let mut tail = StderrTail::default();
        let line = format!("{}\n", "y".repeat(1023));
        let logged: usize = (0..100).map(|_| tail.push(line.as_bytes()).len()).sum();
        assert_eq!(logged, 64);
        assert!(tail.push(b"more\n").is_empty());
        assert_eq!(tail.kept.len(), 64 * 1024);
        assert!(tail.kept.ends_with(b"more\n"));

        let mut tail = StderrTail::default();
        let lines = tail.push(&vec![b'z'; 100 * 1024]);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 64 * 1024);
        assert!(tail.push(b"\nafter\n").is_empty());
    }

    #[test]
    fn the_exit_reason_is_the_last_stderr_line_or_the_exit_code() {
        assert_eq!(
            exit_reason(Some("broken setup.".to_owned()), Some(1)),
            "broken setup"
        );
        assert_eq!(exit_reason(None, Some(3)), "exited with code 3");
        assert_eq!(
            exit_reason(Some("...".to_owned()), None),
            "stopped by a signal"
        );
        let reason = exit_reason(Some("login failed: token=abc123def".to_owned()), Some(1));
        assert!(reason.starts_with("login failed: token="), "{reason}");
        assert!(!reason.contains("abc123def"), "{reason}");
    }

    #[test]
    fn a_prompt_answered_with_auth_required_asks_to_sign_in() {
        assert_eq!(
            turn_error(&AcpError::auth_required()),
            TurnEnd::SignInNeeded
        );
        let mut error = AcpError::internal_error();
        error.message = "Overloaded.".to_owned();
        assert_eq!(turn_error(&error), TurnEnd::Error("Overloaded".to_owned()));
    }

    #[test]
    fn an_error_answer_reads_as_its_message_and_auth_required_is_sign_in_needed() {
        let mut error = AcpError::internal_error();
        error.message = "Rate limited.".to_owned();
        error.data = Some(json!("try again in 30 s."));
        assert_eq!(error_text(&error), "Rate limited: try again in 30 s");
        error.data = Some(json!({ "retry": 30 }));
        assert_eq!(error_text(&error), "Rate limited");
        assert_eq!(
            start_error(Failure::Error(AcpError::auth_required())),
            StartError::SignInNeeded
        );
        assert_eq!(
            start_error(Failure::Error(error)),
            StartError::Failed("Rate limited".to_owned())
        );
        assert_eq!(
            start_error(Failure::Exited("broken setup".to_owned())),
            StartError::Failed("broken setup".to_owned())
        );
    }

    #[test]
    fn a_plan_entry_and_a_tool_status_cross_in_camel_case() {
        let entry = PlanEntry {
            content: "Read logs".to_owned(),
            status: PlanStatus::InProgress,
        };
        let wire_form = json!({ "content": "Read logs", "status": "inProgress" });
        assert_eq!(serde_json::to_value(&entry).unwrap(), wire_form);
        assert_eq!(
            serde_json::from_value::<PlanEntry>(wire_form).unwrap(),
            entry
        );
        assert_eq!(
            serde_json::to_value(ToolStatus::InProgress).unwrap(),
            json!("inProgress")
        );
    }
}
