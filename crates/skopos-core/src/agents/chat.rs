//! A chat with an agent (agents spec §4.1, §4.3): its scope, how it starts, and the calls the
//! panel makes. Chats run on Linux and macOS only; on Windows every call answers
//! `Unsupported` and nothing spawns.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use ts_rs::TS;

use super::approvals::ChangeAnswer;
use super::chats::{ChatSummary, StoredChat};
use super::events::{ChatEvent, ObjectRef};
use crate::app_core::AppCore;
use crate::error::CoreResult;
use crate::kubeconfig::ClusterId;

#[cfg(unix)]
pub(crate) use running::Chats;

/// The history key of a global chat.
pub const GLOBAL_KEY: &str = "global";

/// The clusters a chat reaches: one in a per-cluster chat, the chosen ones in a global chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatScope {
    pub clusters: Vec<ClusterId>,
    pub global: bool,
}

impl ChatScope {
    /// The history the chat belongs to: its cluster's id, or `global`.
    pub fn scope_key(&self) -> String {
        match self.clusters.first() {
            Some(cluster) if !self.global => cluster.clone(),
            _ => GLOBAL_KEY.to_owned(),
        }
    }
}

/// What starting a chat needs.
#[derive(Debug, Clone)]
pub struct ChatStart {
    pub scope: ChatScope,
    /// The agent's id; `None` takes the cluster's default, then the app's.
    pub agent: Option<String>,
    /// A stored chat to continue through `session/load`; its own scope and agent are used.
    pub continue_chat: Option<String>,
}

/// The chat that started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatInfo {
    pub chat_id: String,
    /// The agent's id.
    pub agent: String,
    /// Whether the agent can continue this chat later.
    pub can_load: bool,
}

impl AppCore {
    /// Starts a chat owned by the window `owner`, after closing the chat that window runs
    /// (spec §4.1). Its items go to `events`; nothing is sent before it returns.
    pub async fn chat_start(
        &self,
        start: ChatStart,
        events: mpsc::Sender<ChatEvent>,
        owner: &str,
    ) -> CoreResult<ChatInfo> {
        #[cfg(unix)]
        {
            running::start(self, start, events, owner).await
        }
        #[cfg(not(unix))]
        {
            let _ = (start, events, owner);
            Err(unsupported())
        }
    }

    /// Runs one turn: the person's item, then the agent's prompt (spec §4.3). It returns when
    /// the turn has ended; the turn's items stream meanwhile.
    pub async fn chat_prompt(
        &self,
        chat_id: &str,
        text: String,
        object: Option<ObjectRef>,
    ) -> CoreResult<()> {
        #[cfg(unix)]
        {
            running::prompt(self, chat_id, text, object).await
        }
        #[cfg(not(unix))]
        {
            let _ = (chat_id, text, object);
            Err(unsupported())
        }
    }

    /// `Stop`: cancels the turn and answers waiting changes as stopped. An id that is not
    /// running is ignored.
    pub fn chat_stop(&self, chat_id: &str) {
        #[cfg(unix)]
        running::stop(self, chat_id);
        #[cfg(not(unix))]
        let _ = chat_id;
    }

    /// Ends the chat: stops it, ends the agent's process group, removes its run folder and
    /// saves it. An id that is not running is ignored.
    pub async fn chat_close(&self, chat_id: &str) {
        #[cfg(unix)]
        running::close(self, chat_id).await;
        #[cfg(not(unix))]
        let _ = chat_id;
    }

    /// The person's answer to a waiting change card.
    pub fn chat_answer(
        &self,
        chat_id: &str,
        card_id: &str,
        answer: ChangeAnswer,
    ) -> CoreResult<()> {
        #[cfg(unix)]
        {
            running::answer(self, chat_id, card_id, answer)
        }
        #[cfg(not(unix))]
        {
            let _ = (chat_id, card_id, answer);
            Err(unsupported())
        }
    }

    /// `Undo` on a card approved for the chat: the cluster's changes ask again.
    pub fn chat_undo_standing(&self, chat_id: &str, cluster: &ClusterId) -> CoreResult<()> {
        #[cfg(unix)]
        {
            running::undo_standing(self, chat_id, cluster)
        }
        #[cfg(not(unix))]
        {
            let _ = (chat_id, cluster);
            Err(unsupported())
        }
    }

    /// The scope's history, newest first (spec §3.4).
    pub fn chat_list(&self, scope: &ChatScope) -> CoreResult<Vec<ChatSummary>> {
        #[cfg(unix)]
        {
            Ok(running::list(self, scope))
        }
        #[cfg(not(unix))]
        {
            let _ = scope;
            Err(unsupported())
        }
    }

    /// A chat: the running one as it stands, else the stored one.
    pub fn chat_get(&self, id: &str) -> CoreResult<StoredChat> {
        #[cfg(unix)]
        {
            running::get(self, id)
        }
        #[cfg(not(unix))]
        {
            let _ = id;
            Err(unsupported())
        }
    }

    /// Chats see the sandbox as not ready, whatever the machine has. Tests only.
    pub fn agent_sandbox_unready_for_test(&self) {
        #[cfg(unix)]
        self.chats().set_sandbox_unready();
    }

    /// The program the agent launches as its `skopos` MCP server and the sandbox shows, in
    /// place of the app's own binary. Tests pass `skopos-agent-host` (R1).
    pub fn set_agent_app_binary_for_test(&self, path: PathBuf) {
        #[cfg(unix)]
        self.chats().set_app_binary(path);
        #[cfg(not(unix))]
        let _ = path;
    }
}

/// What every chat call answers on Windows.
#[cfg(not(unix))]
fn unsupported() -> crate::error::IpcError {
    crate::error::IpcError::new(crate::error::ErrorCode::Unsupported, super::UNSUPPORTED)
}

/// The running chats, on Linux and macOS.
#[cfg(unix)]
mod running {
    use std::collections::{HashMap, HashSet};
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
    use std::time::Duration;

    use dashmap::DashMap;
    use k8s_openapi::jiff::Timestamp;
    use tokio::process::Command;
    use tokio::sync::{mpsc, oneshot};
    use tokio::task::{JoinHandle, JoinSet};
    use tokio_util::sync::{CancellationToken, DropGuard};

    use super::{ChatInfo, ChatScope, ChatStart};
    use crate::agents::acp::{AcpSession, AcpUpdate, McpEntry, PlanEntry, StartError, TurnEnd};
    use crate::agents::approvals::{Approvals, ChangeAnswer, ChangeCard};
    use crate::agents::chats::{ChatStore, ChatSummary, StoredChat};
    use crate::agents::endpoint::{new_token, read_token_line, AsyncStream, Endpoint, Listen};
    use crate::agents::events::{ChatEvent, ChatItem, ChatItemBody, ChatNotice, ObjectRef};
    use crate::agents::mcp::cards::ToolCard;
    use crate::agents::mcp::changes::ChatGate;
    use crate::agents::mcp::{scope_names, serve_mcp, ScopeCluster, ToolContext, ToolScope};
    use crate::agents::prompt::{hidden_block, object_line, PromptContext};
    use crate::agents::proxy::{self, ProxyConfig, Resolver};
    use crate::agents::registry::{default_agent, AgentSpec, AgentState};
    use crate::agents::sandbox::env::{agent_env, proxy_url};
    use crate::agents::sandbox::paths::kubeconfig_files;
    use crate::agents::sandbox::spec::{MCP_SOCKET, PROXY_SOCKET};
    use crate::agents::sandbox::{
        build_spec, direct_command, sandbox_command, ChatPorts, SandboxStatus, SpecInput, AGENT_MCP,
    };
    use crate::agents::settings::expand_home;
    use crate::app_core::AppCore;
    use crate::catalog::ClusterSource;
    use crate::error::{CoreResult, ErrorCode, IpcError};
    use crate::kubeconfig::ClusterId;
    use crate::paths::create_private_dir;
    use crate::resources::invalid;
    use crate::sessions::{random_hex, SessionGuard};

    /// Gives `--agent-mcp` the chat's token (spec §4.3).
    const TOKEN_VAR: &str = "SKOPOS_AGENT_TOKEN";
    const WORK: &str = "work";
    const RUN: &str = "run";
    const TMP: &str = "tmp";
    const SANDBOX_NOT_READY: &str = "The agent sandbox isn't ready.";
    const NO_AGENT: &str = "No agent is ready to chat.";
    const NO_CLUSTER: &str = "A chat needs at least one cluster.";
    const ONE_CLUSTER: &str = "A chat on one cluster names exactly one cluster.";
    const EMPTY_MESSAGE: &str = "Write a message first.";
    const STILL_ANSWERING: &str = "The agent is still answering.";
    const OTHER_CLUSTER: &str = "That object is on a cluster this chat does not reach.";
    const UPDATE_BACKLOG: usize = 256;
    const CARD_BACKLOG: usize = 64;
    const FEED_BACKLOG: usize = 16;
    const BLOCKED_BACKLOG: usize = 16;
    /// The longest title the history shows, in characters.
    const TITLE_MAX: usize = 200;
    /// How long a closing chat waits for its cancelled turn to end.
    const TURN_GRACE: Duration = Duration::from_secs(1);
    /// How long a closing chat waits for room on its events channel.
    const CLOSING_SEND: Duration = Duration::from_secs(1);
    const ACCEPT_PAUSE: Duration = Duration::from_millis(100);

    /// The running chats and the stored ones, kept in the core.
    pub(crate) struct Chats {
        store: Arc<ChatStore>,
        /// `<data>/agents`.
        dir: PathBuf,
        running: DashMap<String, Arc<Chat>>,
        /// One start at a time per window, so a window never runs two chats.
        owners: DashMap<String, Arc<tokio::sync::Mutex<()>>>,
        sandbox_unready: AtomicBool,
        app_binary: Mutex<Option<PathBuf>>,
    }

    impl Chats {
        pub(crate) fn new(data: &Path) -> Chats {
            let dir = data.join("agents");
            Chats {
                store: Arc::new(ChatStore::new(dir.join("chats"))),
                dir,
                running: DashMap::new(),
                owners: DashMap::new(),
                sandbox_unready: AtomicBool::new(false),
                app_binary: Mutex::new(None),
            }
        }

        pub(crate) fn set_sandbox_unready(&self) {
            self.sandbox_unready.store(true, Ordering::SeqCst);
        }

        pub(crate) fn set_app_binary(&self, path: PathBuf) {
            *lock(&self.app_binary) = Some(path);
        }

        /// The app's own binary, which the agent launches with `--agent-mcp`.
        fn app_binary(&self) -> CoreResult<PathBuf> {
            let kept = lock(&self.app_binary).clone();
            if let Some(path) = kept {
                return Ok(path);
            }
            std::env::current_exe().map_err(|error| {
                IpcError::new(
                    ErrorCode::Internal,
                    format!("cannot find the app's own program: {error}"),
                )
            })
        }
    }

    pub(super) async fn start(
        core: &AppCore,
        start: ChatStart,
        events: mpsc::Sender<ChatEvent>,
        owner: &str,
    ) -> CoreResult<ChatInfo> {
        let chats = core.chats();
        let window = chats.owners.entry(owner.to_owned()).or_default().clone();
        let _one_start_at_a_time = window.lock().await;
        // Spec §4.1: one running chat per window. A chat continued elsewhere ends there too.
        let ending: Vec<String> = chats
            .running
            .iter()
            .filter(|entry| {
                entry.value().owner == owner
                    || start.continue_chat.as_deref() == Some(entry.key().as_str())
            })
            .map(|entry| entry.key().clone())
            .collect();
        for id in ending {
            close_chat(chats, &id).await;
        }
        let stored = match &start.continue_chat {
            Some(id) => Some(chats.store.get(id)?),
            None => None,
        };
        let (scope, given) = match &stored {
            Some(stored) if !stored.can_load || stored.session_id.is_none() => {
                return Err(invalid(cannot_reopen(&stored.agent_name)));
            }
            Some(stored) => (stored.scope.clone(), Some(stored.agent.clone())),
            None => (start.scope, start.agent),
        };
        let clusters = scope_clusters(core, &scope)?;
        let scope = ChatScope {
            clusters: clusters.iter().map(|cluster| cluster.id.clone()).collect(),
            global: scope.global,
        };
        let agent = core.agent_spec(&pick_agent(core, given, &scope)?)?;
        // Spec §6.1: no agent runs outside the sandbox. R2's switch is Task 10's, which probes
        // read too.
        let sandboxed = !core.agent_sandbox_off();
        if sandboxed {
            sandbox_ready(core).await?;
        }
        let id = match &stored {
            Some(stored) => stored.id.clone(),
            None => new_chat_id(chats),
        };
        let agent_dir = chats.dir.join(WORK).join(&agent.id);
        create_private_dir(&agent_dir)?;
        let run_folder = RunFolder::create(chats.dir.join(RUN).join(&id))?;
        let unix_sockets = sandboxed && cfg!(target_os = "linux");
        let wiring = wire(
            core,
            &agent,
            &clusters,
            scope.global,
            &run_folder.path,
            unix_sockets,
        )
        .await?;
        let app_binary = chats.app_binary()?;
        let command = agent_command(
            core,
            &agent,
            &agent_dir,
            &run_folder.path,
            &wiring,
            &app_binary,
            sandboxed,
        )?;
        let mcp = McpEntry {
            command: app_binary,
            args: vec![
                AGENT_MCP.to_owned(),
                format!("127.0.0.1:{}", wiring.ports.mcp),
            ],
            env: vec![(TOKEN_VAR.to_owned(), wiring.token.clone())],
        };
        // Task 10 forwards nothing before the session is open, so a loaded session's replay
        // never reaches `updates` (spec §4.3).
        let (update_sender, updates) = mpsc::channel(UPDATE_BACKLOG);
        let started = match &stored {
            Some(stored) => {
                let session_id = stored.session_id.clone().unwrap_or_default();
                AcpSession::load(command, &agent_dir, mcp, update_sender, &session_id).await
            }
            None => AcpSession::start(command, &agent_dir, mcp, update_sender).await,
        };
        let session = match started {
            Ok(session) => session,
            Err(StartError::SignInNeeded) => {
                set_probe_state(core, &agent.id, AgentState::SignInNeeded);
                return Err(invalid(sign_in_needed(core, &agent)));
            }
            Err(StartError::Failed(reason)) => {
                let Some(mut stored) = stored else {
                    let state = AgentState::DoesNotStart {
                        reason: reason.clone(),
                    };
                    set_probe_state(core, &agent.id, state);
                    return Err(invalid(reason));
                };
                tracing::warn!("chat {id}: {} cannot reopen it: {reason}", agent.name);
                stored.can_load = false;
                save_chat(&chats.store, stored).await?;
                return Err(invalid(cannot_reopen(&agent.name)));
            }
        };
        set_probe_state(core, &agent.id, AgentState::Ready);
        let can_load = session.can_load();
        let continued = stored.is_some();
        let record = match stored {
            Some(mut stored) => {
                stored.session_id = Some(session.session_id().to_owned());
                stored.can_load = can_load;
                stored
            }
            None => {
                let now = Timestamp::now().to_string();
                StoredChat {
                    id: id.clone(),
                    scope: scope.clone(),
                    agent: agent.id.clone(),
                    agent_name: agent.name.clone(),
                    session_id: Some(session.session_id().to_owned()),
                    can_load,
                    title: String::new(),
                    created: now.clone(),
                    updated: now,
                    items: Vec::new(),
                }
            }
        };
        let life = CancellationToken::new();
        let guard = core.sessions().register(life.clone(), None, owner);
        let (feed, feed_receiver) = mpsc::channel(FEED_BACKLOG);
        let Wiring {
            approvals,
            cards,
            changes,
            blocked,
            cancel,
            guard: services_guard,
            tasks,
            ..
        } = wiring;
        let chat = Arc::new(Chat {
            id: id.clone(),
            owner: owner.to_owned(),
            agent_name: agent.name.clone(),
            clusters,
            global: scope.global,
            session: Mutex::new(Some(Arc::new(session))),
            approvals,
            feed,
            transcript: Mutex::new(Transcript::new(record)),
            store: chats.store.clone(),
            events,
            life,
            services: cancel,
            service_tasks: Mutex::new(tasks),
            done: CancellationToken::new(),
            turn: Mutex::new(TurnSlot::default()),
            pump: Mutex::new(None),
            guard: Mutex::new(Some(guard)),
            run_folder: Mutex::new(Some(run_folder)),
            close_reason: Mutex::new(None),
            working: AtomicBool::new(false),
            turn_open: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            // A continued chat's agent has had the hidden block in its first turn.
            hidden_sent: AtomicBool::new(continued),
        });
        let inputs = Inputs {
            updates,
            cards,
            changes,
            blocked,
            feed: feed_receiver,
        };
        *lock(&chat.pump) = Some(tokio::spawn(pump(chat.clone(), inputs)));
        chats.running.insert(id.clone(), chat.clone());
        tokio::spawn(supervise(core.clone(), chat));
        let _ = services_guard.disarm();
        Ok(ChatInfo {
            chat_id: id,
            agent: agent.id,
            can_load,
        })
    }

    pub(super) async fn prompt(
        core: &AppCore,
        chat_id: &str,
        text: String,
        object: Option<ObjectRef>,
    ) -> CoreResult<()> {
        if text.trim().is_empty() {
            return Err(invalid(EMPTY_MESSAGE));
        }
        let chat = running_chat(core.chats(), chat_id)?;
        let line = match &object {
            Some(object) => Some(chat.line_for(object)?),
            None => None,
        };
        if chat
            .working
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(IpcError::new(ErrorCode::Conflict, STILL_ANSWERING));
        }
        chat.turn_open.store(true, Ordering::SeqCst);
        chat.stop_requested.store(false, Ordering::SeqCst);
        // Spec §4.3, §6.8: the hidden block first in a chat's first turn, then the object
        // line, then the person's text.
        let mut blocks = Vec::new();
        if !chat.hidden_sent.swap(true, Ordering::SeqCst) {
            blocks.push(hidden_block(&chat.prompt_context(core)));
        }
        blocks.extend(line);
        blocks.push(text.clone());
        let (ack, acked) = oneshot::channel();
        let fed = chat
            .feed
            .send(Feed::User { text, object, ack })
            .await
            .is_ok()
            && acked.await.is_ok();
        let (done, finished) = oneshot::channel();
        if !fed || !chat.start_turn(blocks, done) {
            chat.end_turn(None).await;
            return Err(IpcError::new(
                ErrorCode::NotFound,
                format!("Chat {chat_id} has ended."),
            ));
        }
        // A turn cut short by a close drops `done`; the turn has ended either way.
        let _ = finished.await;
        Ok(())
    }

    pub(super) fn stop(core: &AppCore, chat_id: &str) {
        if let Some(chat) = find(core.chats(), chat_id) {
            chat.stop();
        }
    }

    pub(super) async fn close(core: &AppCore, chat_id: &str) {
        close_chat(core.chats(), chat_id).await;
    }

    pub(super) fn answer(
        core: &AppCore,
        chat_id: &str,
        card_id: &str,
        answer: ChangeAnswer,
    ) -> CoreResult<()> {
        running_chat(core.chats(), chat_id)?
            .approvals
            .answer(card_id, answer)
    }

    pub(super) fn undo_standing(
        core: &AppCore,
        chat_id: &str,
        cluster: &ClusterId,
    ) -> CoreResult<()> {
        let chat = running_chat(core.chats(), chat_id)?;
        if !chat.clusters.iter().any(|known| &known.id == cluster) {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                format!("Cluster {cluster} is not in this chat."),
            ));
        }
        chat.approvals.undo_standing(cluster);
        Ok(())
    }

    pub(super) fn list(core: &AppCore, scope: &ChatScope) -> Vec<ChatSummary> {
        core.chats().store.list(scope)
    }

    pub(super) fn get(core: &AppCore, id: &str) -> CoreResult<StoredChat> {
        match find(core.chats(), id) {
            Some(chat) => Ok(chat.apply(|transcript| transcript.chat.clone())),
            None => core.chats().store.get(id),
        }
    }

    /// One running chat.
    struct Chat {
        id: String,
        /// The window that started it.
        owner: String,
        agent_name: String,
        clusters: Vec<ScopeCluster>,
        global: bool,
        /// `None` once the chat closes.
        session: Mutex<Option<Arc<AcpSession>>>,
        approvals: Arc<Approvals>,
        feed: mpsc::Sender<Feed>,
        transcript: Mutex<Transcript>,
        store: Arc<ChatStore>,
        events: mpsc::Sender<ChatEvent>,
        /// Cancelled when the chat is to end; the supervisor then closes it.
        life: CancellationToken,
        /// Ends the proxy and the MCP endpoint.
        services: CancellationToken,
        service_tasks: Mutex<Vec<JoinHandle<()>>>,
        /// Cancelled once the chat has closed.
        done: CancellationToken,
        turn: Mutex<TurnSlot>,
        pump: Mutex<Option<JoinHandle<()>>>,
        guard: Mutex<Option<SessionGuard>>,
        run_folder: Mutex<Option<RunFolder>>,
        /// The notice of an agent that exited, for `Closed`.
        close_reason: Mutex<Option<String>>,
        /// From a prompt's start until the pump has drawn its end.
        working: AtomicBool,
        /// From a prompt's start until its end is fed to the pump, once.
        turn_open: AtomicBool,
        stop_requested: AtomicBool,
        hidden_sent: AtomicBool,
    }

    #[derive(Default)]
    struct TurnSlot {
        closing: bool,
        handle: Option<JoinHandle<()>>,
    }

    /// What the pump hears from the chat itself.
    enum Feed {
        User {
            text: String,
            object: Option<ObjectRef>,
            ack: oneshot::Sender<()>,
        },
        TurnEnded {
            notice: Option<ChatNotice>,
            ack: oneshot::Sender<()>,
        },
        Shutdown,
    }

    struct Inputs {
        updates: mpsc::Receiver<AcpUpdate>,
        cards: mpsc::Receiver<ToolCard>,
        changes: mpsc::Receiver<ChangeCard>,
        blocked: mpsc::Receiver<String>,
        feed: mpsc::Receiver<Feed>,
    }

    impl Chat {
        fn apply<R>(&self, change: impl FnOnce(&mut Transcript) -> R) -> R {
            change(&mut lock(&self.transcript))
        }

        /// Sends an event; a channel that fails ends the chat. While the chat closes, a full
        /// channel gets a short wait, so a window that has gone never holds the close up.
        async fn deliver(&self, event: ChatEvent) {
            let sent = if self.life.is_cancelled() {
                matches!(
                    tokio::time::timeout(CLOSING_SEND, self.events.send(event)).await,
                    Ok(Ok(()))
                )
            } else {
                tokio::select! {
                    sent = self.events.send(event) => sent.is_ok(),
                    () = self.life.cancelled() => false,
                }
            };
            if !sent {
                self.life.cancel();
            }
        }

        /// Returns `false` on `Shutdown`.
        async fn on_feed(&self, feed: Feed) -> bool {
            match feed {
                Feed::User { text, object, ack } => {
                    let item = self.apply(|transcript| transcript.user(text, object));
                    self.deliver(ChatEvent::Item { item }).await;
                    self.deliver(ChatEvent::Working { working: true }).await;
                    let _ = ack.send(());
                    true
                }
                Feed::TurnEnded { notice, ack } => {
                    if let Some(notice) = notice {
                        let item = self.apply(|transcript| transcript.notice(notice));
                        self.deliver(ChatEvent::Item { item }).await;
                    }
                    self.deliver(ChatEvent::Working { working: false }).await;
                    self.working.store(false, Ordering::SeqCst);
                    let _ = ack.send(());
                    true
                }
                Feed::Shutdown => false,
            }
        }

        /// Starts the turn's task, unless the chat is closing or has no session.
        fn start_turn(self: &Arc<Self>, blocks: Vec<String>, done: oneshot::Sender<()>) -> bool {
            let mut slot = lock(&self.turn);
            if slot.closing {
                return false;
            }
            let Some(session) = lock(&self.session).clone() else {
                return false;
            };
            slot.handle = Some(tokio::spawn(run_turn(self.clone(), session, blocks, done)));
            true
        }

        /// Feeds the turn's end to the pump, once per turn, and waits until it is drawn.
        async fn end_turn(&self, notice: Option<ChatNotice>) {
            if !self.turn_open.swap(false, Ordering::SeqCst) {
                return;
            }
            let (ack, acked) = oneshot::channel();
            if self
                .feed
                .send(Feed::TurnEnded { notice, ack })
                .await
                .is_ok()
            {
                let _ = acked.await;
            }
        }

        /// Spec §4.3: Stop answers waiting approvals as stopped and sends `session/cancel`.
        fn stop(&self) {
            self.approvals.stop_all();
            if self.working.load(Ordering::SeqCst) {
                self.stop_requested.store(true, Ordering::SeqCst);
                if let Some(session) = lock(&self.session).as_ref() {
                    session.cancel();
                }
            }
        }

        /// Ends the turn, the agent's process group, the proxy, the MCP endpoint and the
        /// pump, in that order, then saves the chat and removes its run folder.
        async fn close(&self) {
            self.stop();
            let turn = {
                let mut slot = lock(&self.turn);
                slot.closing = true;
                slot.handle.take()
            };
            if let Some(mut turn) = turn {
                if tokio::time::timeout(TURN_GRACE, &mut turn).await.is_err() {
                    turn.abort();
                    let _ = turn.await;
                }
            }
            self.end_turn(Some(ChatNotice::Stopped)).await;
            let session = lock(&self.session).take();
            if let Some(session) = session {
                match Arc::try_unwrap(session) {
                    Ok(session) => session.close().await,
                    Err(_) => tracing::warn!(
                        "chat {}: the agent's session is still in use; it ends when dropped",
                        self.id
                    ),
                }
            }
            self.services.cancel();
            let tasks = std::mem::take(&mut *lock(&self.service_tasks));
            for task in tasks {
                let _ = task.await;
            }
            let _ = self.feed.send(Feed::Shutdown).await;
            let pump = lock(&self.pump).take();
            if let Some(pump) = pump {
                let _ = pump.await;
            }
            self.save().await;
            drop(lock(&self.run_folder).take());
        }

        /// The last steps, once the chat is out of the running list.
        async fn finish(&self) {
            drop(lock(&self.guard).take());
            let reason = lock(&self.close_reason).take();
            let closed = ChatEvent::Closed { reason };
            let _ = tokio::time::timeout(CLOSING_SEND, self.events.send(closed)).await;
            self.done.cancel();
        }

        /// Spec §4.8: a chat is saved after each turn and when it closes.
        async fn save(&self) {
            let Some(chat) = self.apply(Transcript::take_save) else {
                return;
            };
            if let Err(error) = save_chat(&self.store, chat).await {
                tracing::warn!("chat {}: cannot save it: {}", self.id, error.message);
            }
        }

        fn line_for(&self, object: &ObjectRef) -> CoreResult<String> {
            let Some(cluster) = self
                .clusters
                .iter()
                .find(|cluster| cluster.id == object.cluster)
            else {
                return Err(invalid(OTHER_CLUSTER));
            };
            Ok(object_line(
                &object.kind,
                object.namespace.as_deref(),
                &object.name,
                &cluster.name,
            ))
        }

        /// The clusters' settings as saved now, so the first turn sees the latest notes.
        fn prompt_context(&self, core: &AppCore) -> PromptContext {
            PromptContext {
                clusters: self
                    .clusters
                    .iter()
                    .map(|cluster| {
                        (
                            cluster.name.clone(),
                            core.cluster_agent_settings(&cluster.id),
                        )
                    })
                    .collect(),
                global: self.global,
            }
        }
    }

    async fn run_turn(
        chat: Arc<Chat>,
        session: Arc<AcpSession>,
        blocks: Vec<String>,
        done: oneshot::Sender<()>,
    ) {
        let end = session.prompt(blocks).await;
        // The close takes the session back whole once the turn is over.
        drop(session);
        let exited = matches!(end, TurnEnd::Exited(_));
        let notice = turn_notice(
            &end,
            chat.stop_requested.load(Ordering::SeqCst),
            &chat.agent_name,
        );
        if exited {
            // Spec §8: waiting approvals close as stopped.
            chat.approvals.stop_all();
            *lock(&chat.close_reason) = notice.as_ref().map(ChatNotice::text);
        }
        chat.end_turn(notice).await;
        chat.save().await;
        if exited {
            chat.life.cancel();
        }
        let _ = done.send(());
    }

    /// The notice a turn's end leaves (spec §3.3). A Stop wins over how the agent ended,
    /// unless it exited.
    fn turn_notice(end: &TurnEnd, stopped: bool, agent: &str) -> Option<ChatNotice> {
        let agent = agent.to_owned();
        match end {
            TurnEnd::Exited(reason) => Some(ChatNotice::Exited {
                agent,
                reason: reason.clone(),
            }),
            _ if stopped => Some(ChatNotice::Stopped),
            TurnEnd::Cancelled => Some(ChatNotice::Stopped),
            TurnEnd::EndTurn => None,
            TurnEnd::MaxTokens => Some(ChatNotice::LengthLimit { agent }),
            TurnEnd::MaxTurnRequests => Some(ChatNotice::TooManySteps { agent }),
            TurnEnd::Refusal => Some(ChatNotice::Declined { agent }),
            TurnEnd::Error(message) => Some(ChatNotice::AgentError {
                agent,
                message: message.clone(),
            }),
        }
    }

    /// Turns what the chat hears into items, one at a time, in order (R6). The agent's and
    /// the tools' items go before the chat's own feed, so a turn's end follows its items.
    async fn pump(chat: Arc<Chat>, mut inputs: Inputs) {
        loop {
            tokio::select! {
                biased;
                Some(update) = inputs.updates.recv() => {
                    if let Some(item) = chat.apply(|transcript| transcript.update(update)) {
                        chat.deliver(ChatEvent::Item { item }).await;
                    }
                }
                Some(card) = inputs.cards.recv() => {
                    let item = chat.apply(|transcript| transcript.tool_card(card));
                    chat.deliver(ChatEvent::Item { item }).await;
                }
                Some(card) = inputs.changes.recv() => {
                    let item = chat.apply(|transcript| transcript.change_card(card));
                    chat.deliver(ChatEvent::Item { item }).await;
                }
                Some(host) = inputs.blocked.recv() => {
                    if let Some(item) = chat.apply(|transcript| transcript.blocked(host)) {
                        chat.deliver(ChatEvent::Item { item }).await;
                    }
                }
                feed = inputs.feed.recv() => {
                    let more = match feed {
                        Some(feed) => chat.on_feed(feed).await,
                        None => false,
                    };
                    if !more {
                        break;
                    }
                }
            }
        }
    }

    /// Closes the chat once it is to end: the window closed (`sessions_stop_owned`),
    /// `chat_close`, the agent exited, or its events channel failed.
    async fn supervise(core: AppCore, chat: Arc<Chat>) {
        chat.life.cancelled().await;
        chat.close().await;
        let _ = core
            .chats()
            .running
            .remove_if(&chat.id, |_, running| Arc::ptr_eq(running, &chat));
        chat.finish().await;
    }

    async fn close_chat(chats: &Chats, id: &str) {
        let Some(chat) = find(chats, id) else {
            return;
        };
        chat.life.cancel();
        chat.done.cancelled().await;
    }

    fn find(chats: &Chats, id: &str) -> Option<Arc<Chat>> {
        chats.running.get(id).map(|entry| entry.value().clone())
    }

    fn running_chat(chats: &Chats, id: &str) -> CoreResult<Arc<Chat>> {
        find(chats, id)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("No running chat {id}.")))
    }

    async fn save_chat(store: &Arc<ChatStore>, chat: StoredChat) -> CoreResult<()> {
        let store = store.clone();
        tokio::task::spawn_blocking(move || store.save(&chat))
            .await
            .map_err(|error| {
                IpcError::new(
                    ErrorCode::Internal,
                    format!("cannot save the chat: {error}"),
                )
            })?
    }

    /// The clusters of a scope by their catalog names, each once.
    fn scope_clusters(core: &AppCore, scope: &ChatScope) -> CoreResult<Vec<ScopeCluster>> {
        let catalog = core.catalog_list();
        let mut entries: Vec<(ClusterId, String)> = Vec::new();
        for id in &scope.clusters {
            if entries.iter().any(|(known, _)| known == id) {
                continue;
            }
            let Some(entry) = catalog.iter().find(|entry| &entry.id == id) else {
                return Err(IpcError::new(
                    ErrorCode::NotFound,
                    format!("No cluster {id}."),
                ));
            };
            entries.push((id.clone(), entry.name.clone()));
        }
        if entries.is_empty() {
            return Err(invalid(NO_CLUSTER));
        }
        if !scope.global && entries.len() != 1 {
            return Err(invalid(ONE_CLUSTER));
        }
        Ok(scope_names(&entries))
    }

    /// The agent asked for, else the cluster's default in a per-cluster chat when it is
    /// still listed, else the app's default.
    fn pick_agent(core: &AppCore, given: Option<String>, scope: &ChatScope) -> CoreResult<String> {
        if let Some(id) = given {
            return Ok(id);
        }
        let statuses = core.agents_status()?;
        let cluster_default = scope
            .clusters
            .first()
            .filter(|_| !scope.global)
            .and_then(|cluster| core.cluster_agent_settings(cluster).default_agent);
        if let Some(id) = cluster_default {
            if statuses.iter().any(|status| status.id == id) {
                return Ok(id);
            }
        }
        default_agent(&core.agent_prefs(), &statuses).ok_or_else(|| invalid(NO_AGENT))
    }

    async fn sandbox_ready(core: &AppCore) -> CoreResult<()> {
        let unready = core.chats().sandbox_unready.load(Ordering::SeqCst);
        if !unready
            && matches!(
                core.agent_sandbox_status(false).await,
                SandboxStatus::Ready { .. }
            )
        {
            return Ok(());
        }
        Err(invalid(SANDBOX_NOT_READY))
    }

    /// Spec §3.3: `<Agent> needs you to sign in.` and the agent's sign-in hint.
    fn sign_in_needed(core: &AppCore, agent: &AgentSpec) -> String {
        let hint = core
            .agents_status()
            .ok()
            .and_then(|statuses| statuses.into_iter().find(|status| status.id == agent.id))
            .and_then(|status| status.hint);
        match hint {
            Some(hint) => format!("{} needs you to sign in. {hint}", agent.name),
            None => format!("{} needs you to sign in.", agent.name),
        }
    }

    /// Spec §3.4.
    fn cannot_reopen(agent: &str) -> String {
        format!("{agent} can't reopen old chats. Start a new chat to continue.")
    }

    /// Spec §8: a start's outcome is the agent's state, as a probe's is.
    fn set_probe_state(core: &AppCore, agent: &str, state: AgentState) {
        core.agent_probes().set(agent, state);
    }

    /// 8 hex characters that no running or stored chat, and no probe's run folder, has
    /// (spec §4.8).
    fn new_chat_id(chats: &Chats) -> String {
        loop {
            let id: String = random_hex().chars().take(8).collect();
            let taken = chats.running.contains_key(&id)
                || chats.store.holds(&id)
                || chats.dir.join(RUN).join(&id).exists();
            if !taken {
                return id;
            }
        }
    }

    /// What the agent talks to: the chat's proxy and its tools, each on a listener of its own.
    struct Wiring {
        token: String,
        ports: ChatPorts,
        approvals: Arc<Approvals>,
        cards: mpsc::Receiver<ToolCard>,
        changes: mpsc::Receiver<ChangeCard>,
        blocked: mpsc::Receiver<String>,
        cancel: CancellationToken,
        /// Ends both services when the chat does not start.
        guard: DropGuard,
        tasks: Vec<JoinHandle<()>>,
    }

    /// Spec §4.1: on Linux in the sandbox, Unix sockets in the run folder, which the agent
    /// reaches on 127.0.0.1:3128 and :3129 (R3); elsewhere, ephemeral 127.0.0.1 ports.
    async fn wire(
        core: &AppCore,
        agent: &AgentSpec,
        clusters: &[ScopeCluster],
        global: bool,
        run: &Path,
        unix_sockets: bool,
    ) -> CoreResult<Wiring> {
        let (proxy_listen, tools_listen) = if unix_sockets {
            (
                Listen::Unix(run.join(PROXY_SOCKET)),
                Listen::Unix(run.join(MCP_SOCKET)),
            )
        } else {
            (Listen::Tcp, Listen::Tcp)
        };
        let proxy_endpoint = Endpoint::bind(proxy_listen).await?;
        let tools_endpoint = Endpoint::bind(tools_listen).await?;
        let ports = match (proxy_endpoint.port(), tools_endpoint.port()) {
            (Some(proxy), Some(mcp)) => ChatPorts { proxy, mcp },
            _ => ChatPorts::LINUX_SANDBOX,
        };
        let token = new_token();
        let cancel = CancellationToken::new();
        let guard = cancel.clone().drop_guard();
        // Spec §4.7: the agent's provider hosts and the person's domains.
        let mut hosts = agent.hosts.clone();
        hosts.extend(core.agent_prefs().domains);
        let config = ProxyConfig {
            token: token.clone(),
            hosts,
            resolve: Resolver::System,
        };
        let (blocked_sender, blocked) = mpsc::channel(BLOCKED_BACKLOG);
        let proxy_task = tokio::spawn(proxy::serve(
            proxy_endpoint,
            config,
            blocked_sender,
            cancel.clone(),
        ));
        let (change_sender, changes) = mpsc::channel(CARD_BACKLOG);
        let approvals = Approvals::new(change_sender);
        let scope = ToolScope {
            clusters: clusters.to_vec(),
            global,
        };
        let gate = Arc::new(ChatGate {
            core: core.clone(),
            approvals: approvals.clone(),
            scope: scope.clone(),
        });
        let (card_sender, cards) = mpsc::channel(CARD_BACKLOG);
        let context = Arc::new(ToolContext {
            core: core.clone(),
            scope,
            cards: card_sender,
            gate,
        });
        let tools_task = tokio::spawn(serve_tools(
            tools_endpoint,
            token.clone(),
            context,
            cancel.clone(),
        ));
        Ok(Wiring {
            token,
            ports,
            approvals,
            cards,
            changes,
            blocked,
            cancel,
            guard,
            tasks: vec![proxy_task, tools_task],
        })
    }

    /// The agent's command: inside the sandbox, or directly while it is off for tests (R2).
    /// Either way the agent gets only spec §4.6's environment.
    fn agent_command(
        core: &AppCore,
        agent: &AgentSpec,
        agent_dir: &Path,
        run: &Path,
        wiring: &Wiring,
        app_binary: &Path,
        sandboxed: bool,
    ) -> CoreResult<Command> {
        let home = core.home_dir().to_path_buf();
        let prefs = core.prefs_get();
        let proxy = proxy_url(&wiring.token, wiring.ports.proxy);
        let env = agent_env(
            &|name: &str| std::env::var(name).ok(),
            agent,
            &proxy,
            &run.join(TMP),
            &home,
        );
        let catalog: Vec<PathBuf> = core
            .catalog_list()
            .into_iter()
            .map(|entry| match entry.source {
                ClusterSource::Synced { path } | ClusterSource::Pasted { path } => {
                    PathBuf::from(path)
                }
            })
            .collect();
        let kubeconfig_env = std::env::var_os("KUBECONFIG");
        let spec = build_spec(SpecInput {
            agent,
            agent_dir: agent_dir.to_path_buf(),
            run_dir: run.to_path_buf(),
            home: &home,
            folders: prefs
                .agents
                .folders
                .iter()
                .map(|folder| expand_home(folder, &home))
                .collect(),
            kubeconfigs: kubeconfig_files(&prefs.sync_sources, &catalog, kubeconfig_env.as_deref()),
            app_binary: app_binary.to_path_buf(),
            path_var: std::env::var_os("PATH"),
            env,
        });
        if sandboxed {
            sandbox_command(&spec, wiring.ports)
        } else {
            Ok(direct_command(&spec))
        }
    }

    /// The chat's MCP endpoint (spec §4.1, §6.7): a connection speaks MCP after its first
    /// line, the chat's token. It ends with `cancel`, and its connections with it.
    async fn serve_tools(
        endpoint: Endpoint,
        token: String,
        context: Arc<ToolContext>,
        cancel: CancellationToken,
    ) {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                () = cancel.cancelled() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
                accepted = endpoint.accept() => match accepted {
                    Ok(stream) => {
                        connections.spawn(serve_connection(stream, token.clone(), context.clone()));
                    }
                    Err(error) => {
                        tracing::warn!("agent tools: cannot accept a connection: {error}");
                        tokio::time::sleep(ACCEPT_PAUSE).await;
                    }
                },
            }
        }
    }

    async fn serve_connection(
        mut stream: Box<dyn AsyncStream>,
        token: String,
        context: Arc<ToolContext>,
    ) {
        if !read_token_line(&mut stream, &token).await {
            tracing::warn!("agent tools: refused a connection without the chat's token");
            return;
        }
        if let Err(error) = serve_mcp(stream, context).await {
            tracing::debug!("agent tools: a connection ended: {}", error.message);
        }
    }

    /// `<data>/agents/run/<chat id>/` (`0700`) with its `tmp/`, removed when dropped.
    struct RunFolder {
        path: PathBuf,
    }

    impl RunFolder {
        fn create(path: PathBuf) -> CoreResult<RunFolder> {
            remove_folder(&path);
            create_private_dir(&path)?;
            let folder = RunFolder { path };
            create_private_dir(&folder.path.join(TMP))?;
            Ok(folder)
        }
    }

    impl Drop for RunFolder {
        fn drop(&mut self) {
            remove_folder(&self.path);
        }
    }

    fn remove_folder(path: &Path) {
        let Err(error) = std::fs::remove_dir_all(path) else {
            return;
        };
        if error.kind() != ErrorKind::NotFound {
            tracing::warn!("cannot remove {}: {error}", path.display());
        }
    }

    /// The chat's items as drawn, and what follows each source to its item.
    struct Transcript {
        chat: StoredChat,
        positions: HashMap<String, usize>,
        next: u64,
        /// A card's or an agent tool's key, to the item that draws it.
        keyed: HashMap<String, String>,
        /// The agent message that chunks still grow.
        message: Option<String>,
        /// This turn's plan.
        plan: Option<String>,
        blocked: HashSet<String>,
        changed: bool,
    }

    impl Transcript {
        fn new(chat: StoredChat) -> Transcript {
            let positions = chat
                .items
                .iter()
                .enumerate()
                .map(|(at, item)| (item.id.clone(), at))
                .collect();
            let next = chat
                .items
                .iter()
                .filter_map(|item| item.id.strip_prefix("item-")?.parse::<u64>().ok())
                .max()
                .map_or(1, |last| last + 1);
            Transcript {
                chat,
                positions,
                next,
                keyed: HashMap::new(),
                message: None,
                plan: None,
                blocked: HashSet::new(),
                changed: false,
            }
        }

        /// A new item. Anything new ends the agent message that chunks were growing.
        fn push(&mut self, body: ChatItemBody) -> ChatItem {
            let item = ChatItem {
                id: format!("item-{}", self.next),
                body,
            };
            self.next += 1;
            self.positions
                .insert(item.id.clone(), self.chat.items.len());
            self.chat.items.push(item.clone());
            self.message = None;
            self.changed = true;
            item
        }

        fn replace(&mut self, id: &str, body: ChatItemBody) -> ChatItem {
            let item = ChatItem {
                id: id.to_owned(),
                body,
            };
            if let Some(&at) = self.positions.get(id) {
                self.chat.items[at] = item.clone();
            }
            self.changed = true;
            item
        }

        fn keyed(&mut self, key: String, body: ChatItemBody) -> ChatItem {
            if let Some(id) = self.keyed.get(&key).cloned() {
                return self.replace(&id, body);
            }
            let item = self.push(body);
            self.keyed.insert(key, item.id.clone());
            item
        }

        fn user(&mut self, text: String, object: Option<ObjectRef>) -> ChatItem {
            if self.chat.title.is_empty() {
                self.chat.title = title_of(&text);
            }
            self.plan = None;
            self.push(ChatItemBody::User { text, object })
        }

        fn update(&mut self, update: AcpUpdate) -> Option<ChatItem> {
            match update {
                AcpUpdate::AgentText(chunk) if chunk.is_empty() => None,
                AcpUpdate::AgentText(chunk) => Some(self.agent_text(chunk)),
                AcpUpdate::Plan(entries) => Some(self.plan(entries)),
                AcpUpdate::AgentTool {
                    id,
                    title,
                    status,
                    details,
                } => Some(self.keyed(
                    format!("agent-tool:{id}"),
                    ChatItemBody::AgentTool {
                        title,
                        status,
                        details,
                    },
                )),
                // Its card comes from the MCP server; the agent's next chunk is a new message.
                AcpUpdate::HiddenTool => {
                    self.message = None;
                    None
                }
            }
        }

        fn agent_text(&mut self, chunk: String) -> ChatItem {
            let open = self
                .message
                .as_ref()
                .and_then(|id| self.positions.get(id))
                .copied();
            if let Some(at) = open {
                if let ChatItemBody::Agent { text } = &mut self.chat.items[at].body {
                    text.push_str(&chunk);
                    self.changed = true;
                    return self.chat.items[at].clone();
                }
            }
            let item = self.push(ChatItemBody::Agent { text: chunk });
            self.message = Some(item.id.clone());
            item
        }

        /// Spec §4.3: a plan replaces the turn's Plan card.
        fn plan(&mut self, entries: Vec<PlanEntry>) -> ChatItem {
            let body = ChatItemBody::Plan { entries };
            if let Some(id) = self.plan.clone() {
                return self.replace(&id, body);
            }
            let item = self.push(body);
            self.plan = Some(item.id.clone());
            item
        }

        fn tool_card(&mut self, card: ToolCard) -> ChatItem {
            self.keyed(
                format!("tool:{}", card.id),
                ChatItemBody::Tool {
                    card: Box::new(card),
                },
            )
        }

        fn change_card(&mut self, card: ChangeCard) -> ChatItem {
            self.keyed(
                format!("change:{}", card.id),
                ChatItemBody::Change {
                    card: Box::new(card),
                },
            )
        }

        fn notice(&mut self, notice: ChatNotice) -> ChatItem {
            self.push(ChatItemBody::notice(notice))
        }

        /// Spec §3.3: once per host per chat.
        fn blocked(&mut self, host: String) -> Option<ChatItem> {
            if !self.blocked.insert(host.clone()) {
                return None;
            }
            Some(self.notice(ChatNotice::BlockedHost { host }))
        }

        /// The chat to save, when something changed since the last save. A chat with no
        /// items is never saved.
        fn take_save(&mut self) -> Option<StoredChat> {
            if !self.changed || self.chat.items.is_empty() {
                return None;
            }
            self.changed = false;
            self.chat.updated = Timestamp::now().to_string();
            Some(self.chat.clone())
        }
    }

    /// The first line with text, at most 200 characters (spec §3.4).
    fn title_of(text: &str) -> String {
        let line = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or_default();
        line.chars().take(TITLE_MAX).collect()
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::agents::acp::{PlanStatus, ToolStatus};
        use crate::agents::mcp::cards::{CardDetails, CardTone};

        fn empty_chat() -> StoredChat {
            StoredChat {
                id: "0000000a".to_owned(),
                scope: ChatScope {
                    clusters: vec!["c1".to_owned()],
                    global: false,
                },
                agent: "custom-0000000a".to_owned(),
                agent_name: "Fake".to_owned(),
                session_id: Some("session-1".to_owned()),
                can_load: true,
                title: String::new(),
                created: "2026-11-22T10:00:00Z".to_owned(),
                updated: "2026-11-22T10:00:00Z".to_owned(),
                items: Vec::new(),
            }
        }

        fn tool_card(id: &str, running: bool) -> ToolCard {
            ToolCard {
                id: id.to_owned(),
                cluster: Some("fake".to_owned()),
                title: "List Pods · default".to_owned(),
                result: if running {
                    String::new()
                } else {
                    "1 Pod".to_owned()
                },
                tone: CardTone::Normal,
                details: CardDetails::None,
                running,
            }
        }

        fn text(chunk: &str) -> AcpUpdate {
            AcpUpdate::AgentText(chunk.to_owned())
        }

        fn text_of(item: &ChatItem) -> &str {
            match &item.body {
                ChatItemBody::Agent { text } => text,
                other => panic!("not an agent message: {other:?}"),
            }
        }

        fn entry(content: &str) -> PlanEntry {
            PlanEntry {
                content: content.to_owned(),
                status: PlanStatus::Pending,
            }
        }

        #[test]
        fn a_message_s_chunks_grow_one_item_until_another_item_comes() {
            let mut transcript = Transcript::new(empty_chat());
            transcript.user("Why?".to_owned(), None);
            let first = transcript.update(text("The api ")).unwrap();
            let grown = transcript.update(text("is fine.")).unwrap();
            assert_eq!(grown.id, first.id);
            assert_eq!(text_of(&grown), "The api is fine.");
            transcript.tool_card(tool_card("call-1", true));
            let after = transcript.update(text("More.")).unwrap();
            assert_ne!(after.id, first.id);
            assert_eq!(text_of(&after), "More.");
            assert_eq!(transcript.chat.items.len(), 4);
        }

        #[test]
        fn a_card_sent_again_replaces_its_item_and_keeps_the_message_open() {
            let mut transcript = Transcript::new(empty_chat());
            let running = transcript.tool_card(tool_card("call-1", true));
            let message = transcript.update(text("Reading.")).unwrap();
            let done = transcript.tool_card(tool_card("call-1", false));
            assert_eq!(done.id, running.id);
            assert_eq!(transcript.chat.items.len(), 2);
            match &transcript.chat.items[0].body {
                ChatItemBody::Tool { card } => assert_eq!(card.result, "1 Pod"),
                other => panic!("{other:?}"),
            }
            let grown = transcript.update(text(" Done.")).unwrap();
            assert_eq!(grown.id, message.id);
            assert_eq!(text_of(&grown), "Reading. Done.");
        }

        #[test]
        fn an_agent_tool_is_one_item_however_often_it_changes() {
            let mut transcript = Transcript::new(empty_chat());
            let tool = |status: ToolStatus| AcpUpdate::AgentTool {
                id: "t1".to_owned(),
                title: "Run ls".to_owned(),
                status,
                details: String::new(),
            };
            let pending = transcript.update(tool(ToolStatus::Pending)).unwrap();
            let completed = transcript.update(tool(ToolStatus::Completed)).unwrap();
            assert_eq!(completed.id, pending.id);
            assert_eq!(transcript.chat.items.len(), 1);
        }

        #[test]
        fn a_hidden_tool_call_draws_nothing_and_ends_the_message() {
            let mut transcript = Transcript::new(empty_chat());
            assert!(transcript.update(text("")).is_none());
            let before = transcript.update(text("Listing.")).unwrap();
            assert!(transcript.update(AcpUpdate::HiddenTool).is_none());
            let after = transcript.update(text("tool:list_objects:1 Pod")).unwrap();
            assert_ne!(after.id, before.id);
            assert_eq!(transcript.chat.items.len(), 2);
        }

        #[test]
        fn a_new_turn_starts_a_new_plan() {
            let mut transcript = Transcript::new(empty_chat());
            transcript.user("One".to_owned(), None);
            let first = transcript
                .update(AcpUpdate::Plan(vec![entry("a")]))
                .unwrap();
            let replaced = transcript
                .update(AcpUpdate::Plan(vec![entry("a"), entry("b")]))
                .unwrap();
            assert_eq!(replaced.id, first.id);
            transcript.user("Two".to_owned(), None);
            let second = transcript
                .update(AcpUpdate::Plan(vec![entry("c")]))
                .unwrap();
            assert_ne!(second.id, first.id);
        }

        #[test]
        fn a_blocked_host_is_noted_once_per_chat() {
            let mut transcript = Transcript::new(empty_chat());
            let first = transcript.blocked("evil.example".to_owned()).unwrap();
            assert!(
                matches!(&first.body, ChatItemBody::Notice { text, .. } if text == "The sandbox blocked evil.example."),
                "{first:?}"
            );
            assert!(transcript.blocked("evil.example".to_owned()).is_none());
            assert!(transcript.blocked("other.example".to_owned()).is_some());
        }

        #[test]
        fn a_continued_chat_numbers_new_items_after_the_stored_ones() {
            let mut chat = empty_chat();
            chat.items = vec![
                ChatItem {
                    id: "item-1".to_owned(),
                    body: ChatItemBody::User {
                        text: "Hi".to_owned(),
                        object: None,
                    },
                },
                ChatItem {
                    id: "item-7".to_owned(),
                    body: ChatItemBody::Agent {
                        text: "Hello.".to_owned(),
                    },
                },
            ];
            let mut transcript = Transcript::new(chat);
            assert_eq!(transcript.user("Again".to_owned(), None).id, "item-8");
        }

        #[test]
        fn the_first_message_names_the_chat() {
            let mut transcript = Transcript::new(empty_chat());
            transcript.user(
                "\n  Why does api restart?  \nIt began at noon.".to_owned(),
                None,
            );
            assert_eq!(transcript.chat.title, "Why does api restart?");
            transcript.user("Second".to_owned(), None);
            assert_eq!(transcript.chat.title, "Why does api restart?");
            let mut long = Transcript::new(empty_chat());
            long.user("é".repeat(300), None);
            assert_eq!(long.chat.title.chars().count(), TITLE_MAX);
        }

        #[test]
        fn a_chat_is_saved_only_when_it_changed() {
            let mut transcript = Transcript::new(empty_chat());
            assert!(transcript.take_save().is_none());
            transcript.user("Hi".to_owned(), None);
            let saved = transcript.take_save().unwrap();
            assert_eq!(saved.items.len(), 1);
            assert_ne!(saved.updated, "2026-11-22T10:00:00Z");
            assert!(transcript.take_save().is_none());
        }

        #[test]
        fn turn_ends_map_to_the_spec_s_notices() {
            let text = |end: TurnEnd, stopped: bool| {
                turn_notice(&end, stopped, "Fake").map(|notice| notice.text())
            };
            assert_eq!(text(TurnEnd::EndTurn, false), None);
            assert_eq!(text(TurnEnd::EndTurn, true).as_deref(), Some("Stopped."));
            assert_eq!(text(TurnEnd::Cancelled, false).as_deref(), Some("Stopped."));
            assert_eq!(
                text(TurnEnd::MaxTokens, false).as_deref(),
                Some("Fake stopped: the reply hit its length limit.")
            );
            assert_eq!(
                text(TurnEnd::MaxTurnRequests, false).as_deref(),
                Some("Fake stopped after too many steps.")
            );
            assert_eq!(
                text(TurnEnd::Refusal, false).as_deref(),
                Some("Fake declined to continue.")
            );
            assert_eq!(
                text(TurnEnd::Error("Overloaded".to_owned()), false).as_deref(),
                Some("Fake reported an error: Overloaded.")
            );
            assert_eq!(
                text(TurnEnd::Exited("killed".to_owned()), true).as_deref(),
                Some("Fake stopped unexpectedly: killed.")
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_chat_on_one_cluster_is_kept_under_that_cluster() {
        let scope = ChatScope {
            clusters: vec!["c1".to_owned()],
            global: false,
        };
        assert_eq!(scope.scope_key(), "c1");
    }

    #[test]
    fn a_global_chat_is_kept_under_global() {
        let scope = ChatScope {
            clusters: vec!["c1".to_owned(), "c2".to_owned()],
            global: true,
        };
        assert_eq!(scope.scope_key(), "global");
        let one = ChatScope {
            clusters: vec!["c1".to_owned()],
            global: true,
        };
        assert_eq!(one.scope_key(), "global");
    }

    #[test]
    fn a_scope_reads_the_panel_s_json() {
        let scope: ChatScope =
            serde_json::from_value(json!({ "clusters": ["c1"], "global": false })).unwrap();
        assert_eq!(
            scope,
            ChatScope {
                clusters: vec!["c1".to_owned()],
                global: false,
            }
        );
        let info = ChatInfo {
            chat_id: "0a1b2c3d".to_owned(),
            agent: "claude".to_owned(),
            can_load: true,
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({ "chatId": "0a1b2c3d", "agent": "claude", "canLoad": true })
        );
    }
}
