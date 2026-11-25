//! The fake agent's ACP side. It answers `initialize`, `session/new`, `session/load`,
//! `session/prompt` and `session/cancel` as the script says, and logs every request it gets.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    AgentCapabilities, AuthMethod, AuthMethodAgent, CancelNotification, ContentBlock, ContentChunk,
    InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse, McpServer,
    NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionKind, Plan, PlanEntry,
    PlanEntryPriority, PlanEntryStatus, PromptRequest, PromptResponse, RequestPermissionOutcome,
    RequestPermissionRequest, SessionId, SessionNotification, SessionUpdate, StopReason, ToolCall,
    ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use agent_client_protocol::v1::ConnectionTo;
use agent_client_protocol::{Agent, Client, Error, Stdio};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::mcp_client::McpClient;
use crate::script::{
    Auth, OwnToolStep, PermissionStep, PlanItem, PlanItemStatus, Script, Step, StopKind, ToolStep,
};

/// How long an `exit` step waits before the process ends, so the updates sent before it
/// leave stdout.
const EXIT_PAUSE: Duration = Duration::from_millis(200);

/// How a played turn ends its prompt.
enum Played {
    Stop(StopReason),
    /// With ACP's authentication-required error.
    SignIn,
}

pub struct Fake {
    script: Script,
    log: Option<Mutex<File>>,
    next_turn: AtomicUsize,
    sessions: AtomicUsize,
    tool_calls: AtomicUsize,
    /// The `skopos` server of the last session that named one.
    mcp: Mutex<Option<Arc<McpClient>>>,
    /// Set by `session/cancel`, cleared by each `session/prompt`.
    cancelled: watch::Sender<bool>,
}

impl Fake {
    /// The agent for `script`, appending its log to `log` when given.
    pub fn new(script: Script, log: Option<&Path>) -> Result<Fake, String> {
        let log = match log {
            Some(path) => {
                let file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                Some(Mutex::new(file))
            }
            None => None,
        };
        let (cancelled, _) = watch::channel(false);
        Ok(Fake {
            script,
            log,
            next_turn: AtomicUsize::new(0),
            sessions: AtomicUsize::new(0),
            tool_calls: AtomicUsize::new(0),
            mcp: Mutex::new(None),
            cancelled,
        })
    }

    /// Appends one line to the log, in one write.
    fn record(&self, line: Value) {
        let Some(log) = &self.log else {
            return;
        };
        let mut text = line.to_string();
        text.push('\n');
        let _ = lock(log).write_all(text.as_bytes());
    }

    fn record_request(&self, method: &str, params: &impl Serialize) {
        let params = serde_json::to_value(params).unwrap_or(Value::Null);
        self.record(json!({ "method": method, "params": params }));
    }

    fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    fn next_tool_id(&self) -> usize {
        self.tool_calls.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Starts the client's `skopos` server, if it named one. One that does not start leaves
    /// the `tool` steps to report `error: no skopos server`.
    async fn connect_mcp(&self, servers: &[McpServer]) {
        let Some(server) = servers.iter().find_map(|server| match server {
            McpServer::Stdio(stdio) if stdio.name == "skopos" => Some(stdio),
            _ => None,
        }) else {
            return;
        };
        match McpClient::connect(server).await {
            Ok(client) => *lock(&self.mcp) = Some(Arc::new(client)),
            Err(error) => eprintln!("cannot start the skopos MCP server: {error}"),
        }
    }

    fn send(
        &self,
        cx: &ConnectionTo<Client>,
        session: &SessionId,
        update: SessionUpdate,
    ) -> Result<(), Error> {
        cx.send_notification(SessionNotification::new(session.clone(), update))
    }

    fn say(&self, cx: &ConnectionTo<Client>, session: &SessionId, text: &str) -> Result<(), Error> {
        let chunk = ContentChunk::new(ContentBlock::from(text));
        self.send(cx, session, SessionUpdate::AgentMessageChunk(chunk))
    }

    /// Plays the next turn of the script and returns how it ended.
    async fn play_turn(
        &self,
        cx: &ConnectionTo<Client>,
        session: &SessionId,
    ) -> Result<Played, Error> {
        let index = self.next_turn.fetch_add(1, Ordering::SeqCst);
        let steps = self
            .script
            .turns
            .get(index)
            .map(|turn| turn.steps.clone())
            .unwrap_or_default();
        for step in steps {
            if self.is_cancelled() {
                return Ok(Played::Stop(StopReason::Cancelled));
            }
            match step {
                Step::Plan(items) => self.send(cx, session, SessionUpdate::Plan(plan(&items)))?,
                Step::Say(text) => self.say(cx, session, &text)?,
                Step::Tool(tool) => self.call_skopos(cx, session, tool).await?,
                Step::OwnTool(tool) => self.own_tool(cx, session, tool).await?,
                Step::Permission(step) => self.permission(cx, session, step).await?,
                Step::Permissions(steps) => {
                    let asked = steps
                        .into_iter()
                        .map(|step| self.permission(cx, session, step));
                    for result in futures::future::join_all(asked).await {
                        result?;
                    }
                }
                Step::Exit(code) => {
                    tokio::time::sleep(EXIT_PAUSE).await;
                    eprintln!("fake agent exits with code {code}");
                    std::process::exit(code);
                }
                Step::Sleep(millis) => self.sleep(Duration::from_millis(millis)).await,
                Step::Stop(kind) => return Ok(Played::Stop(stop_reason(kind))),
                Step::SignIn => return Ok(Played::SignIn),
            }
        }
        Ok(Played::Stop(if self.is_cancelled() {
            StopReason::Cancelled
        } else {
            StopReason::EndTurn
        }))
    }

    /// Waits `time`, or until `session/cancel` arrives.
    async fn sleep(&self, time: Duration) {
        let mut cancelled = self.cancelled.subscribe();
        let _ = tokio::time::timeout(time, cancelled.wait_for(|cancelled| *cancelled)).await;
    }

    /// A `tool` step: the call's hidden `tool_call` and `tool_call_update`, then the chunk
    /// the tests read.
    async fn call_skopos(
        &self,
        cx: &ConnectionTo<Client>,
        session: &SessionId,
        tool: ToolStep,
    ) -> Result<(), Error> {
        let id = format!("skopos-{}", self.next_tool_id());
        let call = ToolCall::new(id.clone(), format!("mcp__skopos__{}", tool.name))
            .status(ToolCallStatus::InProgress)
            .raw_input(Value::Object(tool.args.clone()));
        self.send(cx, session, SessionUpdate::ToolCall(call))?;
        let client = lock(&self.mcp).clone();
        let result = match client {
            Some(client) => client.call(&tool.name, tool.args).await,
            None => Err("no skopos server".to_owned()),
        };
        let (status, text) = match &result {
            Ok(text) => (ToolCallStatus::Completed, text.clone()),
            Err(error) => (ToolCallStatus::Failed, error.clone()),
        };
        let fields = ToolCallUpdateFields::new()
            .status(status)
            .content(vec![ToolCallContent::from(text)]);
        self.send(
            cx,
            session,
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(id, fields)),
        )?;
        let line = match result {
            Ok(text) => first_line(&text),
            Err(error) => format!("error: {}", first_line(&error)),
        };
        self.say(cx, session, &format!("tool:{}:{line}", tool.name))
    }

    /// An `ownTool` step: a `tool_call` of the agent's own, a permission request when asked,
    /// then its result.
    async fn own_tool(
        &self,
        cx: &ConnectionTo<Client>,
        session: &SessionId,
        tool: OwnToolStep,
    ) -> Result<(), Error> {
        let id = format!("own-{}", self.next_tool_id());
        let call = ToolCall::new(id.clone(), tool.title.clone()).status(ToolCallStatus::Pending);
        self.send(cx, session, SessionUpdate::ToolCall(call))?;
        let allowed = if tool.permission {
            let fields = ToolCallUpdateFields::new().title(tool.title.clone());
            self.ask_permission(cx, session, &id, fields).await?
        } else {
            true
        };
        self.finish_own_tool(cx, session, id, &tool.title, allowed)
    }

    /// A `permission` step: a pending `tool_call` of the agent's own with its kind and
    /// command, a permission request with the same, then its result.
    async fn permission(
        &self,
        cx: &ConnectionTo<Client>,
        session: &SessionId,
        step: PermissionStep,
    ) -> Result<(), Error> {
        let id = format!("own-{}", self.next_tool_id());
        let kind: ToolKind = step
            .kind
            .as_deref()
            .and_then(|kind| serde_json::from_value(json!(kind)).ok())
            .unwrap_or_default();
        let raw_input = json!({ "command": step.command });
        let call = ToolCall::new(id.clone(), step.title.clone())
            .status(ToolCallStatus::Pending)
            .kind(kind)
            .raw_input(raw_input.clone());
        self.send(cx, session, SessionUpdate::ToolCall(call))?;
        let fields = ToolCallUpdateFields::new()
            .title(step.title.clone())
            .kind(kind)
            .raw_input(raw_input);
        let allowed = self.ask_permission(cx, session, &id, fields).await?;
        self.finish_own_tool(cx, session, id, &step.title, allowed)
    }

    /// The result of a tool of the agent's own: ran when `allowed`, else refused.
    fn finish_own_tool(
        &self,
        cx: &ConnectionTo<Client>,
        session: &SessionId,
        id: String,
        title: &str,
        allowed: bool,
    ) -> Result<(), Error> {
        let (status, text) = if allowed {
            (ToolCallStatus::Completed, format!("ran {title}"))
        } else {
            (ToolCallStatus::Failed, format!("refused {title}"))
        };
        let fields = ToolCallUpdateFields::new()
            .status(status)
            .content(vec![ToolCallContent::from(text)]);
        self.send(
            cx,
            session,
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(id, fields)),
        )
    }

    /// Asks about the tool call `id` described by `fields` with all four option kinds,
    /// `allow_once` neither first nor last, and logs the answer. `true` when an allow option
    /// was picked.
    async fn ask_permission(
        &self,
        cx: &ConnectionTo<Client>,
        session: &SessionId,
        id: &str,
        fields: ToolCallUpdateFields,
    ) -> Result<bool, Error> {
        let options = vec![
            PermissionOption::new("reject_once", "Reject", PermissionOptionKind::RejectOnce),
            PermissionOption::new(
                "allow_always",
                "Always allow",
                PermissionOptionKind::AllowAlways,
            ),
            PermissionOption::new("allow_once", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new(
                "reject_always",
                "Never allow",
                PermissionOptionKind::RejectAlways,
            ),
        ];
        let tool_call = ToolCallUpdate::new(id.to_owned(), fields);
        let request = RequestPermissionRequest::new(session.clone(), tool_call, options);
        let response = cx.send_request(request).block_task().await?;
        let answer = match response.outcome {
            RequestPermissionOutcome::Selected(selected) => selected.option_id.0.to_string(),
            _ => "cancelled".to_owned(),
        };
        self.record(json!({ "answer": "session/request_permission", "optionId": answer }));
        Ok(answer.starts_with("allow"))
    }
}

/// Serves ACP on stdio until the client closes it.
pub async fn run(fake: Arc<Fake>) -> Result<(), Error> {
    fake.record(json!({ "started": std::process::id() }));
    let on_initialize = Arc::clone(&fake);
    let on_new = Arc::clone(&fake);
    let on_load = Arc::clone(&fake);
    let on_prompt = Arc::clone(&fake);
    let on_cancel = fake;
    Agent
        .v1()
        .name("skopos-fakeagent")
        .on_receive_request(
            async move |request: InitializeRequest, responder, _cx| {
                on_initialize.record_request("initialize", &request);
                let capabilities =
                    AgentCapabilities::new().load_session(on_initialize.script.load_session);
                let sign_in = AuthMethodAgent::new("fake-login", "Sign in to the fake agent");
                responder.respond(
                    InitializeResponse::new(ProtocolVersion::V1)
                        .agent_capabilities(capabilities)
                        .auth_methods(vec![AuthMethod::Agent(sign_in)]),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: NewSessionRequest, responder, _cx| {
                on_new.record_request("session/new", &request);
                if on_new.script.auth == Auth::Required {
                    return responder.respond_with_error(Error::auth_required());
                }
                on_new.connect_mcp(&request.mcp_servers).await;
                let number = on_new.sessions.fetch_add(1, Ordering::SeqCst) + 1;
                responder.respond(NewSessionResponse::new(format!("fake-session-{number}")))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: LoadSessionRequest, responder, cx: ConnectionTo<Client>| {
                on_load.record_request("session/load", &request);
                if !on_load.script.load_session {
                    return responder.respond_with_error(Error::method_not_found());
                }
                on_load.connect_mcp(&request.mcp_servers).await;
                // A real agent replays the chat here; the client ignores it (spec §4.3).
                on_load.say(&cx, &request.session_id, "replayed")?;
                responder.respond(LoadSessionResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: PromptRequest, responder, cx: ConnectionTo<Client>| {
                on_prompt.record_request("session/prompt", &request);
                on_prompt
                    .cancelled
                    .send_modify(|cancelled| *cancelled = false);
                let fake = Arc::clone(&on_prompt);
                let turn_cx = cx.clone();
                // The turn runs beside the dispatch loop, which stays free for
                // `session/cancel` and the answers to permission requests.
                cx.spawn(async move {
                    match fake.play_turn(&turn_cx, &request.session_id).await? {
                        Played::Stop(stop) => responder.respond(PromptResponse::new(stop)),
                        Played::SignIn => responder.respond_with_error(Error::auth_required()),
                    }
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: CancelNotification, _cx| {
                on_cancel.record_request("session/cancel", &notification);
                on_cancel
                    .cancelled
                    .send_modify(|cancelled| *cancelled = true);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_to(Stdio::new())
        .await
}

fn plan(items: &[PlanItem]) -> Plan {
    Plan::new(
        items
            .iter()
            .map(|item| {
                let status = match item.status {
                    PlanItemStatus::Pending => PlanEntryStatus::Pending,
                    PlanItemStatus::InProgress => PlanEntryStatus::InProgress,
                    PlanItemStatus::Completed => PlanEntryStatus::Completed,
                };
                PlanEntry::new(item.content.clone(), PlanEntryPriority::Medium, status)
            })
            .collect(),
    )
}

fn stop_reason(kind: StopKind) -> StopReason {
    match kind {
        StopKind::EndTurn => StopReason::EndTurn,
        StopKind::MaxTokens => StopReason::MaxTokens,
        StopKind::MaxTurnRequests => StopReason::MaxTurnRequests,
        StopKind::Refusal => StopReason::Refusal,
    }
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_owned()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
