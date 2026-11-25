//! Chats end to end (agents spec §4.1, §4.3, §4.8, §6): fakekube, and the fake agent as a
//! custom agent that notes its process id and environment in a file. Agents run natively, on
//! every OS (native agents spec §4.2).

mod support;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::agents::approvals::{ChangeAnswer, ChangeCard, ChangeState};
use skopos_core::agents::chat::{ChatInfo, ChatScope, ChatStart};
use skopos_core::agents::editor_tab::{EditorTab, EditorTabMode};
use skopos_core::agents::events::{ChatEvent, ChatItem, ChatItemBody, ObjectRef};
use skopos_core::agents::permissions::{ChoiceKind, PermissionCard, PermissionState};
use skopos_core::agents::registry::AgentState;
use skopos_core::agents::tabs::ProposalState;
use skopos_core::app_core::AppCore;
use skopos_core::error::{CoreResult, ErrorCode};
use skopos_core::kubeconfig::ClusterId;
use skopos_fakekube::{FakeKube, FakeKubeConfig};
use support::connected_fake;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

const WAIT: Duration = Duration::from_secs(30);
const MAIN: &str = "main";
const SCRIPT: &str = "script.json";
const LOG: &str = "agent.log";
const SCALE_PATH: &str = "/apis/apps/v1/namespaces/default/deployments/api/scale";
const CANNOT_REOPEN: &str = "Fake can't reopen old chats. Start a new chat to continue.";
/// Where the fake agent notes its process id and its environment when it starts.
const ENV_FILE: &str = "agent.env";
const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}"#;

struct Bench {
    core: AppCore,
    fake: FakeKube,
    cluster: ClusterId,
    root: TempDir,
    /// The fake agent's id, `custom-<8 hex>`.
    agent: String,
}

impl Bench {
    async fn new(script: Value) -> Bench {
        let (core, fake, cluster, root) = connected_fake(FakeKubeConfig::default()).await;
        core.set_agent_app_binary_for_test(PathBuf::from(env!("CARGO_BIN_EXE_skopos-agent-host")));
        let agent = core
            .agent_custom_add("Fake", &fake_agent_command())
            .unwrap()
            .id;
        let bench = Bench {
            core,
            fake,
            cluster,
            root,
            agent,
        };
        std::fs::create_dir_all(bench.agent_dir()).unwrap();
        bench.write_script(&script);
        bench
    }

    /// `<data>/agents/work/<agent id>/`, the agent's working directory.
    fn agent_dir(&self) -> PathBuf {
        self.root
            .path()
            .join("app/data/agents/work")
            .join(&self.agent)
    }

    fn write_script(&self, script: &Value) {
        std::fs::write(self.agent_dir().join(SCRIPT), script.to_string()).unwrap();
    }

    /// Every request the fake agent received, one JSON value per line.
    fn log(&self) -> Vec<Value> {
        let Ok(text) = std::fs::read_to_string(self.agent_dir().join(LOG)) else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// What the agent started last noted: `pid=<id>`, then one `NAME=value` line per variable.
    fn env_file(&self) -> String {
        std::fs::read_to_string(self.agent_dir().join(ENV_FILE)).unwrap()
    }

    /// The process id of the agent started last.
    fn agent_pid(&self) -> u32 {
        let text = self.env_file();
        let pid = text
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("pid="));
        pid.expect("a pid line").parse().unwrap()
    }

    /// The environment of the agent started last, one `NAME=value` line per variable.
    fn agent_env(&self) -> String {
        let text = self.env_file();
        text.split_once('\n')
            .map(|(_, env)| env.to_owned())
            .unwrap_or_default()
    }

    /// The catalog name of the chat's cluster.
    fn scope_cluster_name(&self) -> String {
        self.core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.id == self.cluster)
            .map(|entry| entry.name)
            .expect("cluster in the catalog")
    }

    /// How many chat run folders exist.
    fn run_folders(&self) -> usize {
        std::fs::read_dir(self.root.path().join("app/data/agents/run"))
            .map(|dir| dir.count())
            .unwrap_or(0)
    }

    fn scope(&self) -> ChatScope {
        ChatScope {
            clusters: vec![self.cluster.clone()],
            global: false,
        }
    }

    fn start_of(&self, continue_chat: Option<String>) -> ChatStart {
        ChatStart {
            scope: self.scope(),
            agent: Some(self.agent.clone()),
            continue_chat,
        }
    }

    async fn start(&self, owner: &str) -> (ChatInfo, Events) {
        let (sender, events) = Events::new();
        let info = self
            .core
            .chat_start(self.start_of(None), sender, owner)
            .await
            .unwrap();
        (info, events)
    }

    async fn ask(&self, chat: &str, text: &str) {
        self.core
            .chat_prompt(chat, text.to_owned(), None, None)
            .await
            .unwrap();
    }

    /// A turn that the test answers or stops while it runs.
    fn ask_in_background(&self, chat: &str, text: &str) -> JoinHandle<CoreResult<()>> {
        let core = self.core.clone();
        let chat = chat.to_owned();
        let text = text.to_owned();
        tokio::spawn(async move { core.chat_prompt(&chat, text, None, None).await })
    }
}

/// A chat's channel, with every event it has given so far.
struct Events {
    receiver: mpsc::Receiver<ChatEvent>,
    seen: Vec<ChatEvent>,
}

impl Events {
    fn new() -> (mpsc::Sender<ChatEvent>, Events) {
        let (sender, receiver) = mpsc::channel(256);
        let events = Events {
            receiver,
            seen: Vec::new(),
        };
        (sender, events)
    }

    /// The first event, seen or still to come, that `wanted` accepts.
    async fn until(&mut self, what: &str, wanted: impl Fn(&ChatEvent) -> bool) -> ChatEvent {
        if let Some(event) = self.seen.iter().find(|event| wanted(event)) {
            return event.clone();
        }
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let next = tokio::time::timeout_at(deadline, self.receiver.recv()).await;
            let event = match next {
                Ok(Some(event)) => event,
                Ok(None) => panic!("the chat's events ended before {what}: {:#?}", self.seen),
                Err(_) => panic!("no {what} within {WAIT:?}: {:#?}", self.seen),
            };
            self.seen.push(event.clone());
            if wanted(&event) {
                return event;
            }
        }
    }

    /// Takes what has been sent so far, without waiting.
    fn drain(&mut self) {
        while let Ok(event) = self.receiver.try_recv() {
            self.seen.push(event);
        }
    }

    /// The latest version of each item, in the order the items first came.
    fn items(&mut self) -> Vec<ChatItem> {
        self.drain();
        let mut items: Vec<ChatItem> = Vec::new();
        for event in &self.seen {
            if let ChatEvent::Item { item } = event {
                match items.iter_mut().find(|known| known.id == item.id) {
                    Some(known) => *known = item.clone(),
                    None => items.push(item.clone()),
                }
            }
        }
        items
    }

    fn notices(&mut self) -> Vec<String> {
        self.items()
            .into_iter()
            .filter_map(|item| match item.body {
                ChatItemBody::Notice { text, .. } => Some(text),
                _ => None,
            })
            .collect()
    }

    fn working(&mut self) -> Vec<bool> {
        self.drain();
        self.seen
            .iter()
            .filter_map(|event| match event {
                ChatEvent::Working { working } => Some(*working),
                _ => None,
            })
            .collect()
    }

    /// How many times the item `id` was sent.
    fn sends_of(&mut self, id: &str) -> usize {
        self.drain();
        self.seen
            .iter()
            .filter(|event| matches!(event, ChatEvent::Item { item } if item.id == id))
            .count()
    }
}

/// The fake agent's script, log and env file are relative to its working directory, the
/// agent's folder. They go as arguments, so they do not depend on the agent's environment.
fn fake_agent_command() -> String {
    let program = env!("CARGO_BIN_EXE_skopos-fakeagent");
    let args = format!("--script {SCRIPT} --env-file {ENV_FILE} --log {LOG}");
    // Windows splits a custom command on unquoted whitespace and keeps backslashes.
    if cfg!(windows) {
        format!("\"{program}\" {args}")
    } else {
        format!("{} {args}", shell_words::quote(program))
    }
}

fn script(turns: Vec<Value>) -> Value {
    json!({ "auth": "ok", "loadSession": true, "turns": turns })
}

fn turn(steps: Vec<Value>) -> Value {
    json!({ "steps": steps })
}

fn say(text: &str) -> Value {
    json!({ "say": text })
}

fn tool(name: &str, args: Value) -> Value {
    json!({ "tool": { "name": name, "args": args } })
}

fn list_pods() -> Value {
    tool(
        "list_objects",
        json!({ "kind": "Pod", "namespace": "default" }),
    )
}

fn scale_api_to_3() -> Value {
    tool(
        "scale",
        json!({
            "kind": "Deployment", "namespace": "default", "name": "api", "replicas": 3,
            "summary": "Scale api to 3",
        }),
    )
}

fn deployment(name: &str, replicas: i32) -> Value {
    json!({ "metadata": { "name": name, "namespace": "default" }, "spec": { "replicas": replicas } })
}

/// The bodies of the scale writes that were not dry runs.
fn scales(fake: &FakeKube) -> Vec<Value> {
    fake.writes("PATCH", SCALE_PATH)
        .into_iter()
        .filter(|write| !write.query.contains_key("dryRun"))
        .map(|write| write.body)
        .collect()
}

fn change_of(event: &ChatEvent) -> Option<&ChangeCard> {
    match event {
        ChatEvent::Item {
            item:
                ChatItem {
                    body: ChatItemBody::Change { card },
                    ..
                },
        } => Some(card.as_ref()),
        _ => None,
    }
}

fn is_waiting(event: &ChatEvent) -> bool {
    change_of(event).is_some_and(|card| card.state == ChangeState::Waiting)
}

fn agent_texts(items: &[ChatItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| match &item.body {
            ChatItemBody::Agent { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

/// The title and result of each SkoposIDE tool card.
fn tool_results(items: &[ChatItem]) -> Vec<(String, String)> {
    items
        .iter()
        .filter_map(|item| match &item.body {
            ChatItemBody::Tool { card } => Some((card.title.clone(), card.result.clone())),
            _ => None,
        })
        .collect()
}

/// The `params` of each request the agent received under `method`.
fn requests(log: &[Value], method: &str) -> Vec<Value> {
    log.iter()
        .filter(|line| line["method"] == method)
        .map(|line| line["params"].clone())
        .collect()
}

/// The text blocks of each `session/prompt`, in order.
fn prompts(log: &[Value]) -> Vec<Vec<String>> {
    requests(log, "session/prompt")
        .iter()
        .map(|params| {
            params["prompt"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|block| block["text"].as_str())
                .map(str::to_owned)
                .collect()
        })
        .collect()
}

/// Every value under `key`, at any depth.
fn values_of<'a>(value: &'a Value, key: &str, found: &mut Vec<&'a Value>) {
    match value {
        Value::Object(map) => {
            for (name, inner) in map {
                if name == key {
                    found.push(inner);
                }
                values_of(inner, key, found);
            }
        }
        Value::Array(items) => {
            for item in items {
                values_of(item, key, found);
            }
        }
        _ => {}
    }
}

/// The `skopos` entry of the agent's `session/new`: its address and its token.
fn mcp_entry(log: &[Value]) -> (String, String) {
    let new = requests(log, "session/new");
    let servers = new[0]["mcpServers"].as_array().unwrap();
    let entry = servers
        .iter()
        .find(|entry| entry["name"] == "skopos")
        .unwrap();
    assert_eq!(entry["args"][0], "--agent-mcp");
    let address = entry["args"][1].as_str().unwrap().to_owned();
    let token = entry["env"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| pair["name"] == "SKOPOS_AGENT_TOKEN")
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .to_owned();
    (address, token)
}

/// What the MCP endpoint answers to an `initialize` after `first_line`: `None` when it
/// closes the connection, or nothing listens.
async fn mcp_answer(address: &str, first_line: &str) -> Option<String> {
    let mut stream = TcpStream::connect(address).await.ok()?;
    let request = format!("{first_line}\n{INITIALIZE}\n");
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut lines = BufReader::new(stream).lines();
    match tokio::time::timeout(WAIT, lines.next_line()).await {
        Ok(Ok(line)) => line,
        Ok(Err(_)) => None,
        Err(_) => panic!("the MCP endpoint neither answered nor closed within {WAIT:?}"),
    }
}

/// Whether `pid` runs; a zombie has ended.
#[cfg(unix)]
fn is_running(pid: u32) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
}

/// Whether `pid` runs.
#[cfg(windows)]
fn is_running(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let out = std::process::Command::new("tasklist")
        .args(["/FI", filter.as_str(), "/FO", "CSV", "/NH"])
        .output()
        .unwrap();
    // A row is `"name","<pid>",…`; without one tasklist prints an INFO line.
    String::from_utf8_lossy(&out.stdout).contains(&format!(",\"{pid}\","))
}

async fn wait_gone(pid: u32) {
    let started = Instant::now();
    while is_running(pid) {
        assert!(started.elapsed() < WAIT, "process {pid} still runs");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_turn_streams_its_plan_and_one_growing_agent_message() {
    let plan = json!({ "plan": [
        { "content": "Find the api Pods", "status": "completed" },
        { "content": "Read their logs", "status": "pending" },
    ] });
    let steps = vec![plan, say("The api "), say("looks fine.")];
    let bench = Bench::new(script(vec![turn(steps)])).await;
    let (info, mut events) = bench.start(MAIN).await;
    assert_eq!(info.agent, bench.agent);
    let empty = bench
        .core
        .chat_prompt(&info.chat_id, "  ".to_owned(), None, None)
        .await
        .unwrap_err();
    assert_eq!(empty.code, ErrorCode::InvalidInput);
    bench.ask(&info.chat_id, "How is api?").await;
    let items = events.items();
    assert!(
        matches!(&items[0].body, ChatItemBody::User { text, object: None, .. } if text == "How is api?"),
        "{items:#?}"
    );
    let plans: Vec<Vec<String>> = items
        .iter()
        .filter_map(|item| match &item.body {
            ChatItemBody::Plan { entries } => {
                Some(entries.iter().map(|entry| entry.content.clone()).collect())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        plans,
        [vec![
            "Find the api Pods".to_owned(),
            "Read their logs".to_owned()
        ]]
    );
    assert_eq!(agent_texts(&items), ["The api looks fine."]);
    let message = items
        .iter()
        .find(|item| matches!(item.body, ChatItemBody::Agent { .. }))
        .unwrap();
    assert!(events.sends_of(&message.id) >= 2);
    assert_eq!(events.working(), [true, false]);
    assert!(events.notices().is_empty());
    let history = bench.core.chat_list(&bench.scope()).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].title, "How is api?");
    assert_eq!(history[0].agent, "Fake");
    let running = bench.core.chat_get(&info.chat_id).unwrap();
    assert_eq!(running.items.len(), items.len());
}

#[tokio::test]
async fn a_skopos_tool_call_is_a_tool_card_and_not_an_agent_tool() {
    let bench = Bench::new(script(vec![turn(vec![list_pods(), say(" One Pod runs.")])])).await;
    bench.fake.add_pod("default", "api-1");
    let (info, mut events) = bench.start(MAIN).await;
    bench.ask(&info.chat_id, "Which Pods run?").await;
    let items = events.items();
    assert_eq!(
        tool_results(&items),
        [("List Pods · default".to_owned(), "1 Pod".to_owned())]
    );
    assert!(items.iter().all(|item| match &item.body {
        ChatItemBody::Tool { card } => !card.running,
        _ => true,
    }));
    assert!(
        !items
            .iter()
            .any(|item| matches!(item.body, ChatItemBody::AgentTool { .. })),
        "{items:#?}"
    );
    let texts = agent_texts(&items);
    assert!(
        texts
            .iter()
            .any(|text| text.starts_with("tool:list_objects:")),
        "{texts:?}"
    );
}

fn permission(title: &str, command: &str) -> Value {
    json!({ "permission": { "title": title, "kind": "execute", "command": command } })
}

fn permission_of(event: &ChatEvent) -> Option<&PermissionCard> {
    match event {
        ChatEvent::Item { item } => match &item.body {
            ChatItemBody::Permission { card } => Some(card),
            _ => None,
        },
        _ => None,
    }
}

fn is_waiting_permission(event: &ChatEvent) -> bool {
    permission_of(event).is_some_and(|card| card.state == PermissionState::Waiting)
}

fn chosen_options(log: &[Value]) -> Vec<String> {
    let mut found = Vec::new();
    for line in log {
        values_of(line, "optionId", &mut found);
    }
    found
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn permission_state(items: &[ChatItem]) -> Option<PermissionState> {
    items.iter().rev().find_map(|item| match &item.body {
        ChatItemBody::Permission { card } => Some(card.state.clone()),
        _ => None,
    })
}

#[tokio::test]
async fn the_agent_s_permission_request_waits_for_the_person_s_choice() {
    let bench = Bench::new(script(vec![turn(vec![
        permission("Run ls", "ls -la"),
        say("Done."),
    ])]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "List the folder.");
    let waiting = events
        .until("a waiting permission card", is_waiting_permission)
        .await;
    let card = permission_of(&waiting).unwrap().clone();
    assert_eq!(card.title, "Run ls");
    assert_eq!(card.kind, "execute");
    assert_eq!(card.command.as_deref(), Some("ls -la"));
    assert_eq!(
        card.options
            .iter()
            .map(|option| option.name.as_str())
            .collect::<Vec<_>>(),
        ["Reject", "Always allow", "Allow", "Never allow"]
    );
    assert!(
        chosen_options(&bench.log()).is_empty(),
        "answered before the person chose"
    );
    bench
        .core
        .chat_permission(&info.chat_id, &card.id, "allow_once")
        .unwrap();
    turn.await.unwrap().unwrap();
    assert_eq!(chosen_options(&bench.log()), ["allow_once"]);
    assert_eq!(
        permission_state(&events.items()),
        Some(PermissionState::Chosen {
            option_id: "allow_once".into(),
            kind: ChoiceKind::AllowOnce
        })
    );
    assert!(agent_texts(&events.items()).contains(&"Done.".to_owned()));
    let again = bench
        .core
        .chat_permission(&info.chat_id, &card.id, "allow_once")
        .unwrap_err();
    assert_eq!(again.message, "This request was already answered.");
}

#[tokio::test]
async fn an_unknown_option_is_refused_and_the_card_keeps_waiting() {
    let bench = Bench::new(script(vec![turn(vec![permission("Run ls", "ls")])])).await;
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "List the folder.");
    let waiting = events
        .until("a waiting permission card", is_waiting_permission)
        .await;
    let id = permission_of(&waiting).unwrap().id.clone();
    let refused = bench
        .core
        .chat_permission(&info.chat_id, &id, "maybe")
        .unwrap_err();
    assert_eq!(refused.message, "That option is not on this request.");
    bench
        .core
        .chat_permission(&info.chat_id, &id, "reject_always")
        .unwrap();
    turn.await.unwrap().unwrap();
    assert_eq!(chosen_options(&bench.log()), ["reject_always"]);
}

#[tokio::test]
async fn stop_cancels_a_waiting_permission_request() {
    let bench = Bench::new(script(vec![turn(vec![
        permission("Run ls", "ls"),
        say("Done."),
    ])]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "List the folder.");
    events
        .until("a waiting permission card", is_waiting_permission)
        .await;
    bench.core.chat_stop(&info.chat_id);
    let _ = turn.await.unwrap();
    events
        .until("a cancelled card", |event| {
            permission_of(event).is_some_and(|card| card.state == PermissionState::Cancelled)
        })
        .await;
    assert_eq!(chosen_options(&bench.log()), ["cancelled"]);
}

#[tokio::test]
async fn close_cancels_a_waiting_permission_request_and_history_keeps_it_cancelled() {
    let bench = Bench::new(script(vec![turn(vec![
        permission("Run ls", "ls"),
        say("Done."),
    ])]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "List the folder.");
    events
        .until("a waiting permission card", is_waiting_permission)
        .await;
    bench.core.chat_close(&info.chat_id).await;
    let _ = turn.await.unwrap();
    let stored = bench.core.chat_get(&info.chat_id).unwrap();
    assert_eq!(
        permission_state(&stored.items),
        Some(PermissionState::Cancelled)
    );
}

#[tokio::test]
async fn two_waiting_requests_are_answered_one_by_one() {
    let both = json!({ "permissions": [
        { "title": "Run a", "kind": "execute", "command": "a" },
        { "title": "Run b", "kind": "execute", "command": "b" }
    ] });
    let bench = Bench::new(script(vec![turn(vec![both, say("Done.")])])).await;
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "Run both.");
    let mut ids: Vec<String> = Vec::new();
    while ids.len() < 2 {
        let event = events
            .until("two waiting cards", |event| {
                permission_of(event).is_some_and(|card| {
                    card.state == PermissionState::Waiting && !ids.contains(&card.id)
                })
            })
            .await;
        ids.push(permission_of(&event).unwrap().id.clone());
    }
    assert!(chosen_options(&bench.log()).is_empty());
    bench
        .core
        .chat_permission(&info.chat_id, &ids[1], "reject_once")
        .unwrap();
    bench
        .core
        .chat_permission(&info.chat_id, &ids[0], "allow_once")
        .unwrap();
    turn.await.unwrap().unwrap();
    let mut chosen = chosen_options(&bench.log());
    chosen.sort();
    assert_eq!(chosen, ["allow_once", "reject_once"]);
}

#[tokio::test]
async fn a_stored_chat_keeps_its_permission_card() {
    let bench = Bench::new(script(vec![turn(vec![
        permission("Run ls", "ls"),
        say("Done."),
    ])]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "List.");
    let event = events
        .until("a waiting permission card", is_waiting_permission)
        .await;
    let id = permission_of(&event).unwrap().id.clone();
    bench
        .core
        .chat_permission(&info.chat_id, &id, "reject_once")
        .unwrap();
    turn.await.unwrap().unwrap();
    bench.core.chat_close(&info.chat_id).await;
    let stored = bench.core.chat_get(&info.chat_id).unwrap();
    assert_eq!(
        permission_state(&stored.items),
        Some(PermissionState::Chosen {
            option_id: "reject_once".into(),
            kind: ChoiceKind::RejectOnce
        })
    );
}

#[tokio::test]
async fn the_hidden_block_and_the_object_line_reach_the_agent_first() {
    let turns = vec![turn(vec![say("Looking.")]), turn(vec![say("Still fine.")])];
    let bench = Bench::new(script(turns)).await;
    let mut settings = bench.core.cluster_settings_get(&bench.cluster);
    settings.agent.notes = "Deploys go through Argo CD.".to_owned();
    bench
        .core
        .cluster_settings_set(&bench.cluster, settings)
        .unwrap();
    let (info, mut events) = bench.start(MAIN).await;
    let object = ObjectRef {
        cluster: bench.cluster.clone(),
        kind: "Deployment".to_owned(),
        namespace: Some("default".to_owned()),
        name: "api".to_owned(),
    };
    bench
        .core
        .chat_prompt(
            &info.chat_id,
            "Why is it slow?".to_owned(),
            Some(object.clone()),
            None,
        )
        .await
        .unwrap();
    bench.ask(&info.chat_id, "And now?").await;
    let prompts = prompts(&bench.log());
    assert_eq!(prompts.len(), 2, "{prompts:#?}");
    let first = &prompts[0];
    assert_eq!(first.len(), 3, "{first:#?}");
    assert!(
        first[0].starts_with(
            "You are running inside SkoposIDE, a Kubernetes desktop app, on the person's computer. \
             You can reach fake through the tools of the skopos MCP server"
        ),
        "{}",
        first[0]
    );
    assert!(first[0].contains("Notes from the person about fake:"));
    assert!(first[0].contains("Deploys go through Argo CD."));
    assert_eq!(
        first[1],
        "The person is asking about Deployment default/api on fake."
    );
    assert_eq!(first[2], "Why is it slow?");
    assert_eq!(prompts[1], ["And now?"]);
    let items = events.items();
    assert!(
        matches!(&items[0].body, ChatItemBody::User { text, object: Some(attached), .. }
            if text == "Why is it slow?" && *attached == object),
        "{items:#?}"
    );
}

#[tokio::test]
async fn a_change_waits_for_the_person_and_runs_once_approved() {
    let bench = Bench::new(script(vec![turn(vec![scale_api_to_3()])])).await;
    bench.fake.upsert("deployments", deployment("api", 1));
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "Scale api to 3.");
    let waiting = events.until("a waiting change", is_waiting).await;
    let card = change_of(&waiting).unwrap().clone();
    assert_eq!(card.title, "Scale Deployment default/api to 3");
    assert!(scales(&bench.fake).is_empty());
    let busy = bench
        .core
        .chat_prompt(&info.chat_id, "Hurry up.".to_owned(), None, None)
        .await
        .unwrap_err();
    assert_eq!(busy.code, ErrorCode::Conflict);
    bench
        .core
        .chat_answer(&info.chat_id, &card.id, ChangeAnswer::Approve)
        .unwrap();
    turn.await.unwrap().unwrap();
    assert_eq!(scales(&bench.fake), [json!({ "spec": { "replicas": 3 } })]);
    let items = events.items();
    let done = items
        .iter()
        .find_map(|item| match &item.body {
            ChatItemBody::Change { card: done } if done.id == card.id => Some(done.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        matches!(
            done.state,
            ChangeState::Approved {
                standing: false,
                ..
            }
        ),
        "{done:?}"
    );
    assert!(
        agent_texts(&items)
            .iter()
            .any(|text| text.starts_with("tool:scale:Applied.")),
        "{items:#?}"
    );
    let gone = bench
        .core
        .chat_answer(&info.chat_id, &card.id, ChangeAnswer::Approve)
        .unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn stop_ends_the_turn_and_answers_a_waiting_change_as_stopped() {
    let turns = vec![turn(vec![scale_api_to_3()]), turn(vec![say("Back.")])];
    let bench = Bench::new(script(turns)).await;
    bench.fake.upsert("deployments", deployment("api", 1));
    let (info, mut events) = bench.start(MAIN).await;
    let turn = bench.ask_in_background(&info.chat_id, "Scale api to 3.");
    let waiting = events.until("a waiting change", is_waiting).await;
    let card_id = change_of(&waiting).unwrap().id.clone();
    bench.core.chat_stop(&info.chat_id);
    turn.await.unwrap().unwrap();
    events
        .until("the stopped card", |event| {
            change_of(event)
                .is_some_and(|card| card.id == card_id && card.state == ChangeState::Stopped)
        })
        .await;
    assert!(scales(&bench.fake).is_empty());
    assert_eq!(events.notices(), ["Stopped."]);
    assert_eq!(events.working(), [true, false]);
    bench.ask(&info.chat_id, "Go on.").await;
    assert_eq!(events.notices(), ["Stopped."]);
    assert_eq!(events.working(), [true, false, true, false]);
}

#[tokio::test]
async fn an_agent_that_exits_mid_turn_leaves_a_notice_and_closes_the_chat() {
    let steps = vec![say("Let me look."), json!({ "exit": 3 })];
    let bench = Bench::new(script(vec![turn(steps)])).await;
    let (info, mut events) = bench.start(MAIN).await;
    bench.ask(&info.chat_id, "Look.").await;
    let closed = events
        .until("the chat's end", |event| {
            matches!(event, ChatEvent::Closed { .. })
        })
        .await;
    let notices = events.notices();
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(
        notices[0].starts_with("Fake stopped unexpectedly: "),
        "{notices:?}"
    );
    assert!(notices[0].ends_with('.'), "{notices:?}");
    match closed {
        ChatEvent::Closed { reason } => assert_eq!(reason.as_deref(), Some(notices[0].as_str())),
        other => panic!("{other:?}"),
    }
    let after = bench
        .core
        .chat_prompt(&info.chat_id, "Hello?".to_owned(), None, None)
        .await
        .unwrap_err();
    assert_eq!(after.code, ErrorCode::NotFound);
    assert_eq!(bench.run_folders(), 0);
    assert_eq!(bench.core.session_count(), 0);
    let stored = bench.core.chat_get(&info.chat_id).unwrap();
    assert!(stored.items.iter().any(
        |item| matches!(&item.body, ChatItemBody::Notice { text, .. } if *text == notices[0])
    ));
}

#[tokio::test]
async fn a_signed_out_agent_fails_the_start_with_its_sign_in_hint() {
    let signed_out = json!({ "auth": "required", "loadSession": true, "turns": [] });
    let bench = Bench::new(signed_out).await;
    let (sender, _events) = Events::new();
    let error = bench
        .core
        .chat_start(bench.start_of(None), sender, MAIN)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(
        error.message.starts_with("Fake needs you to sign in."),
        "{}",
        error.message
    );
    let status = bench
        .core
        .agents_status()
        .unwrap()
        .into_iter()
        .find(|status| status.id == bench.agent)
        .unwrap();
    assert!(matches!(status.state, AgentState::SignInNeeded));
    assert_eq!(bench.run_folders(), 0);
    assert_eq!(bench.core.session_count(), 0);
}

#[tokio::test]
async fn a_stored_chat_continues_through_session_load() {
    let bench = Bench::new(script(vec![turn(vec![say("An answer.")])])).await;
    let (info, mut events) = bench.start(MAIN).await;
    assert!(info.can_load);
    bench.ask(&info.chat_id, "First question").await;
    let first_items = events.items();
    bench.core.chat_close(&info.chat_id).await;
    let session = bench
        .core
        .chat_get(&info.chat_id)
        .unwrap()
        .session_id
        .unwrap();
    let (sender, mut again) = Events::new();
    let continued = bench
        .core
        .chat_start(bench.start_of(Some(info.chat_id.clone())), sender, MAIN)
        .await
        .unwrap();
    assert_eq!(continued.chat_id, info.chat_id);
    let loads = requests(&bench.log(), "session/load");
    assert_eq!(loads.len(), 1);
    assert_eq!(loads[0]["sessionId"], session.as_str());
    bench.ask(&continued.chat_id, "Second question").await;
    let prompts = prompts(&bench.log());
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[1], ["Second question"]);
    let new_items = again.items();
    assert!(new_items
        .iter()
        .all(|item| first_items.iter().all(|old| old.id != item.id)));
    let stored = bench.core.chat_get(&info.chat_id).unwrap();
    assert_eq!(stored.items.len(), first_items.len() + new_items.len());
    assert_eq!(stored.title, "First question");
    assert_eq!(bench.core.chat_list(&bench.scope()).unwrap().len(), 1);
}

#[tokio::test]
async fn an_agent_that_cannot_reopen_chats_is_not_continued() {
    let no_load = json!({ "auth": "ok", "loadSession": false, "turns": [turn(vec![say("Hi.")])] });
    let bench = Bench::new(no_load).await;
    let (info, _events) = bench.start(MAIN).await;
    assert!(!info.can_load);
    bench.ask(&info.chat_id, "Hello").await;
    bench.core.chat_close(&info.chat_id).await;
    assert!(!bench.core.chat_get(&info.chat_id).unwrap().can_load);
    let (sender, _again) = Events::new();
    let error = bench
        .core
        .chat_start(bench.start_of(Some(info.chat_id.clone())), sender, MAIN)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.message, CANNOT_REOPEN);
    assert_eq!(requests(&bench.log(), "initialize").len(), 1);
}

#[tokio::test]
async fn a_chat_whose_load_fails_is_marked_as_not_reopenable() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (info, _events) = bench.start(MAIN).await;
    bench.ask(&info.chat_id, "Hello").await;
    bench.core.chat_close(&info.chat_id).await;
    bench.write_script(&json!({ "auth": "ok", "loadSession": false, "turns": [] }));
    let (sender, _again) = Events::new();
    let error = bench
        .core
        .chat_start(bench.start_of(Some(info.chat_id.clone())), sender, MAIN)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.message, CANNOT_REOPEN);
    assert!(!bench.core.chat_get(&info.chat_id).unwrap().can_load);
    assert_eq!(bench.run_folders(), 0);
    assert_eq!(bench.core.session_count(), 0);
}

#[tokio::test]
async fn a_second_chat_of_the_same_window_closes_the_first() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (first, mut first_events) = bench.start(MAIN).await;
    let first_pid = bench.agent_pid();
    let (other, _other_events) = bench.start("other").await;
    let other_pid = bench.agent_pid();
    let (second, _second_events) = bench.start(MAIN).await;
    first_events
        .until("the first chat's end", |event| {
            matches!(event, ChatEvent::Closed { reason: None })
        })
        .await;
    wait_gone(first_pid).await;
    assert!(is_running(other_pid));
    let closed = bench
        .core
        .chat_prompt(&first.chat_id, "Hi".to_owned(), None, None)
        .await
        .unwrap_err();
    assert_eq!(closed.code, ErrorCode::NotFound);
    bench.ask(&other.chat_id, "Hi").await;
    bench.ask(&second.chat_id, "Hi").await;
    assert_eq!(bench.core.session_count(), 2);
    assert_eq!(bench.run_folders(), 2);
}

#[tokio::test]
async fn closing_the_window_ends_the_agent_and_removes_its_run_folder() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (info, mut events) = bench.start(MAIN).await;
    let pid = bench.agent_pid();
    let (address, token) = mcp_entry(&bench.log());
    assert_eq!(bench.run_folders(), 1);
    assert_eq!(bench.core.session_count(), 1);
    bench.ask(&info.chat_id, "Hello").await;
    bench.core.sessions_stop_owned(MAIN);
    events
        .until("the chat's end", |event| {
            matches!(event, ChatEvent::Closed { .. })
        })
        .await;
    wait_gone(pid).await;
    assert_eq!(bench.run_folders(), 0);
    assert_eq!(bench.core.session_count(), 0);
    // Spec §6.7: the endpoint goes with the chat's process.
    assert_eq!(mcp_answer(&address, &token).await, None);
    assert_eq!(bench.core.chat_list(&bench.scope()).unwrap().len(), 1);
}

#[tokio::test]
async fn the_mcp_endpoint_refuses_a_wrong_token() {
    let bench = Bench::new(script(Vec::new())).await;
    let (_info, _events) = bench.start(MAIN).await;
    let (address, token) = mcp_entry(&bench.log());
    assert!(address.starts_with("127.0.0.1:"), "{address}");
    assert_eq!(mcp_answer(&address, &"0".repeat(32)).await, None);
    assert_eq!(mcp_answer(&address, "").await, None);
    let answer = mcp_answer(&address, &token)
        .await
        .expect("an answer after the chat's token");
    assert!(answer.contains("\"id\":1"), "{answer}");
}

#[tokio::test]
async fn a_chat_without_an_agent_starts_the_cluster_s_default() {
    let bench = Bench::new(script(Vec::new())).await;
    let mut settings = bench.core.cluster_settings_get(&bench.cluster);
    settings.agent.default_agent = Some(bench.agent.clone());
    bench
        .core
        .cluster_settings_set(&bench.cluster, settings)
        .unwrap();
    let (sender, _events) = Events::new();
    let start = ChatStart {
        scope: bench.scope(),
        agent: None,
        continue_chat: None,
    };
    let info = bench.core.chat_start(start, sender, MAIN).await.unwrap();
    assert_eq!(info.agent, bench.agent);
    assert_eq!(requests(&bench.log(), "session/new").len(), 1);
}

#[tokio::test]
async fn calls_on_a_chat_that_is_not_running_say_not_found() {
    let bench = Bench::new(script(Vec::new())).await;
    let missing = "0badc0de";
    let prompt = bench
        .core
        .chat_prompt(missing, "Hi".to_owned(), None, None)
        .await
        .unwrap_err();
    assert_eq!(prompt.code, ErrorCode::NotFound);
    let answer = bench
        .core
        .chat_answer(missing, "change-1", ChangeAnswer::Approve)
        .unwrap_err();
    assert_eq!(answer.code, ErrorCode::NotFound);
    let undo = bench
        .core
        .chat_undo_standing(missing, &bench.cluster)
        .unwrap_err();
    assert_eq!(undo.code, ErrorCode::NotFound);
    assert_eq!(
        bench.core.chat_get(missing).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        bench.core.chat_get("../../prefs").unwrap_err().code,
        ErrorCode::NotFound
    );
    bench.core.chat_stop(missing);
    bench.core.chat_close(missing).await;
    assert_eq!(bench.core.session_count(), 0);
}

#[tokio::test]
async fn a_chat_s_agent_runs_natively_with_the_app_s_environment() {
    // A variable only this test sets, so parallel tests do not see it.
    std::env::set_var("SKOPOS_NATIVE_MARKER_7F3A", "seen");
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (info, _events) = bench.start(MAIN).await;
    bench.ask(&info.chat_id, "Hello").await;
    let env = bench.agent_env();
    assert!(env.contains("SKOPOS_NATIVE_MARKER_7F3A=seen"), "{env}");
    // The home folder, under the name this OS gives it.
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var(home_var).unwrap();
    assert!(
        env.lines().any(|line| line == format!("{home_var}={home}")),
        "{env}"
    );
    assert!(
        !env.lines().any(|line| line.starts_with("HTTPS_PROXY=")),
        "{env}"
    );
    assert!(
        env.lines()
            .any(|line| line.starts_with("SKOPOS_AGENT_TOKEN=")),
        "{env}"
    );
}

fn create_tab(cluster: &ClusterId, yaml: &str) -> EditorTab {
    EditorTab {
        tab_id: "create-1".into(),
        title: "Create".into(),
        cluster: cluster.clone(),
        mode: EditorTabMode::Create,
        yaml: yaml.into(),
        target: None,
        default_namespace: "default".into(),
    }
}

#[tokio::test]
async fn a_prompt_with_a_tab_sends_its_text_and_shows_the_chip() {
    let bench = Bench::new(script(vec![turn(vec![say("ok")])])).await;
    let (info, mut events) = bench.start(MAIN).await;
    let tab = create_tab(
        &bench.cluster,
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n",
    );
    bench
        .core
        .chat_prompt(&info.chat_id, "add a key".into(), None, Some(tab))
        .await
        .unwrap();
    let user = events.items().into_iter().find_map(|item| match item.body {
        ChatItemBody::User { tab, .. } => tab,
        _ => None,
    });
    assert_eq!(user.map(|chip| chip.title), Some("Create".to_owned()));
    let prompt = prompts(&bench.log()).remove(0).join("\n");
    assert!(
        prompt.contains("```yaml\napiVersion: v1\nkind: ConfigMap"),
        "{prompt}"
    );
    assert!(prompt.ends_with("add a key"), "{prompt}");
}

#[tokio::test]
async fn a_tab_outside_the_namespace_limit_or_too_large_is_refused() {
    let bench = Bench::new(script(vec![turn(vec![say("ok")])])).await;
    let (info, _events) = bench.start(MAIN).await;
    let mut settings = bench.core.cluster_settings_get(&bench.cluster);
    settings.agent.namespaces = Some(vec!["default".into()]);
    bench
        .core
        .cluster_settings_set(&bench.cluster, settings)
        .unwrap();
    let outside = create_tab(
        &bench.cluster,
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  namespace: payments\n",
    );
    let error = bench
        .core
        .chat_prompt(&info.chat_id, "hi".into(), None, Some(outside))
        .await
        .unwrap_err();
    assert!(
        error
            .message
            .starts_with("The agent may not read namespace payments on "),
        "{}",
        error.message
    );
    let large = create_tab(&bench.cluster, &"a: b\n".repeat(20_000));
    let error = bench
        .core
        .chat_prompt(&info.chat_id, "hi".into(), None, Some(large))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "The tab's text is over 64 KiB, so it was not sent."
    );
    assert!(prompts(&bench.log()).is_empty());
}

#[tokio::test]
async fn propose_yaml_shows_a_proposal_for_the_attached_tab() {
    let proposal = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  a: b\n";
    let bench = Bench::new(script(vec![
        turn(vec![tool(
            "propose_yaml",
            json!({ "yaml": "kind: ConfigMap", "summary": "x" }),
        )]),
        turn(vec![tool(
            "propose_yaml",
            json!({ "yaml": proposal, "summary": "Add key a\nmore" }),
        )]),
    ]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    bench.ask(&info.chat_id, "no tab").await;
    let tab = create_tab(
        &bench.cluster,
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n",
    );
    bench
        .core
        .chat_prompt(&info.chat_id, "add a key".into(), None, Some(tab))
        .await
        .unwrap();
    let items = events.items();
    let texts = agent_texts(&items);
    assert!(
        texts[0].starts_with("tool:propose_yaml:error: No YAML tab is attached to this chat"),
        "{texts:?}"
    );
    assert_eq!(texts[1], "tool:propose_yaml:Shown to the person as a proposal for \"Create\"; they accept or reject it.");
    let card = items
        .iter()
        .find_map(|item| match &item.body {
            ChatItemBody::Proposal { card } => Some(card.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        (
            card.summary.as_str(),
            card.added,
            card.removed,
            card.yaml.as_str()
        ),
        ("Add key a", 2, 0, proposal)
    );
    assert_eq!(card.state, ProposalState::Waiting);
    bench
        .core
        .chat_proposal_answer(&info.chat_id, &card.id, true)
        .await
        .unwrap();
    events.until("accepted", |event| matches!(event, ChatEvent::Item { item } if matches!(&item.body, ChatItemBody::Proposal { card } if card.state == ProposalState::Accepted))).await;
}

#[tokio::test]
async fn a_proposal_the_server_refuses_returns_its_message() {
    let bench = Bench::new(script(vec![turn(vec![tool(
        "propose_yaml",
        json!({ "yaml": "apiVersion: e2e.invalid/v1\nkind: Nothing\nmetadata:\n  name: x\n", "summary": "x" }),
    )])]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    let tab = create_tab(&bench.cluster, "");
    bench
        .core
        .chat_prompt(&info.chat_id, "go".into(), None, Some(tab))
        .await
        .unwrap();
    let texts = agent_texts(&events.items());
    assert!(
        texts[0].starts_with("tool:propose_yaml:error: Document 1 (Nothing x): "),
        "{texts:?}"
    );
}

#[tokio::test]
async fn a_proposal_with_aliases_is_refused_when_the_tab_has_hidden_values() {
    // `labels: *d` would copy the Secret's data, put back from the tab, into the labels.
    let proposal =
        "apiVersion: v1\nkind: Secret\ndata: &d\n  password: (hidden)\nmetadata:\n  name: s\n  labels: *d\n";
    let bench = Bench::new(script(vec![turn(vec![tool(
        "propose_yaml",
        json!({ "yaml": proposal, "summary": "x" }),
    )])]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    let tab = create_tab(
        &bench.cluster,
        "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  password: c2VjcmV0\n",
    );
    bench
        .core
        .chat_prompt(&info.chat_id, "go".into(), None, Some(tab))
        .await
        .unwrap();
    let texts = agent_texts(&events.items());
    assert!(
        texts[0].starts_with("tool:propose_yaml:error: The proposal uses YAML anchors or aliases"),
        "{texts:?}"
    );
}

#[tokio::test]
async fn a_proposal_outside_the_namespace_limit_is_refused_before_the_dry_run() {
    let bench = Bench::new(script(vec![turn(vec![tool(
        "propose_yaml",
        json!({ "yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  namespace: payments\n", "summary": "x" }),
    )])]))
    .await;
    let (info, mut events) = bench.start(MAIN).await;
    let mut settings = bench.core.cluster_settings_get(&bench.cluster);
    settings.agent.namespaces = Some(vec!["default".into()]);
    bench
        .core
        .cluster_settings_set(&bench.cluster, settings)
        .unwrap();
    let tab = create_tab(&bench.cluster, "");
    bench
        .core
        .chat_prompt(&info.chat_id, "go".into(), None, Some(tab))
        .await
        .unwrap();
    let texts = agent_texts(&events.items());
    assert!(
        texts[0].starts_with("tool:propose_yaml:error: ")
            && texts[0].ends_with(" limits agents to these namespaces: default."),
        "{texts:?}"
    );
}

#[tokio::test]
async fn the_agent_gets_the_chat_s_kubeconfig_which_goes_with_the_chat() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (info, _events) = bench.start(MAIN).await;
    bench.ask(&info.chat_id, "Hello").await;
    let env = bench.agent_env();
    let path = env
        .lines()
        .find_map(|line| line.strip_prefix("KUBECONFIG="))
        .map(PathBuf::from)
        .expect("KUBECONFIG");
    assert!(path.ends_with("kubeconfig"), "{path:?}");
    let doc: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let cluster_name = bench.scope_cluster_name();
    assert_eq!(doc["current-context"].as_str(), Some(cluster_name.as_str()));
    assert_eq!(doc["contexts"].as_sequence().unwrap().len(), 1);
    bench.core.chat_close(&info.chat_id).await;
    assert!(!path.exists(), "{path:?}");
}

#[tokio::test]
async fn a_global_chat_starts_while_one_of_its_clusters_is_not_connected() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let kube_dir = bench.root.path().join("home/.kube");
    bench
        .fake
        .write_kubeconfig(&kube_dir.join("offline.yaml"), "offline")
        .unwrap();
    let started = Instant::now();
    let offline = loop {
        let found = bench
            .core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == "offline");
        if let Some(entry) = found {
            break entry.id;
        }
        assert!(started.elapsed() < WAIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let (sender, _events) = Events::new();
    let start = ChatStart {
        scope: ChatScope {
            clusters: vec![bench.cluster.clone(), offline],
            global: true,
        },
        agent: Some(bench.agent.clone()),
        continue_chat: None,
    };
    let info = bench.core.chat_start(start, sender, MAIN).await.unwrap();
    bench.ask(&info.chat_id, "Hello").await;
    let env = bench.agent_env();
    let path = env
        .lines()
        .find_map(|line| line.strip_prefix("KUBECONFIG="))
        .map(PathBuf::from)
        .expect("KUBECONFIG");
    let doc: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(doc["contexts"].as_sequence().unwrap().len(), 2);
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "{leftovers:?}");
}

/// Writes a kubeconfig whose user runs `skopos-test-credentials` for its token, and waits for
/// its catalog entry.
async fn exec_cluster(bench: &Bench, context: &str) -> (ClusterId, String) {
    let path = bench.root.path().join(format!("home/.kube/{context}.yaml"));
    let text = format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- name: {context}\n  cluster:\n    server: https://127.0.0.1:1\nusers:\n- name: {context}\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: skopos-test-credentials\n      args: [token]\n      interactiveMode: Never\ncontexts:\n- name: {context}\n  context:\n    cluster: {context}\n    user: {context}\ncurrent-context: {context}\n"
    );
    std::fs::write(&path, text).unwrap();
    let started = Instant::now();
    loop {
        let found = bench
            .core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == context);
        if let Some(entry) = found {
            return (entry.id, entry.name);
        }
        assert!(started.elapsed() < WAIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Starts a global chat over the bench's cluster and `other`, asks once, and returns the
/// chat's kubeconfig text and the first prompt's blocks joined.
async fn global_chat_with(bench: &Bench, other: ClusterId) -> (String, String) {
    let (sender, _events) = Events::new();
    let start = ChatStart {
        scope: ChatScope {
            clusters: vec![bench.cluster.clone(), other],
            global: true,
        },
        agent: Some(bench.agent.clone()),
        continue_chat: None,
    };
    let info = bench.core.chat_start(start, sender, MAIN).await.unwrap();
    bench.ask(&info.chat_id, "Hello").await;
    let env = bench.agent_env();
    let path = env
        .lines()
        .find_map(|line| line.strip_prefix("KUBECONFIG="))
        .map(PathBuf::from)
        .expect("KUBECONFIG");
    let text = std::fs::read_to_string(&path).unwrap();
    let first = prompts(&bench.log()).into_iter().next().unwrap_or_default();
    (text, first.join("\n"))
}

fn context_names(text: &str) -> Vec<String> {
    let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(text).unwrap();
    doc["contexts"]
        .as_sequence()
        .unwrap()
        .iter()
        .map(|context| context["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_cluster_whose_exec_command_is_not_allowed_stays_out_of_the_chat_kubeconfig() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (eks, eks_name) = exec_cluster(&bench, "eks").await;
    let (text, prompt) = global_chat_with(&bench, eks).await;
    assert_eq!(context_names(&text), [bench.scope_cluster_name()]);
    assert!(!text.contains("skopos-test-credentials"), "{text}");
    assert!(
        prompt.contains(&format!("Reach {eks_name} only through the skopos tools.")),
        "{prompt}"
    );
}

#[tokio::test]
async fn an_allowed_exec_command_puts_its_cluster_in_the_chat_kubeconfig() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (eks, eks_name) = exec_cluster(&bench, "eks").await;
    // A connect holds the command for the consent dialog; allowing it stores its fingerprint.
    bench.core.cluster_connect(&eks).await.unwrap();
    let request = bench.core.cluster_exec_request(&eks).unwrap();
    bench
        .core
        .cluster_exec_allow(&eks, request.request_id)
        .unwrap();
    let (text, prompt) = global_chat_with(&bench, eks).await;
    assert_eq!(context_names(&text), [bench.scope_cluster_name(), eks_name]);
    assert!(text.contains("skopos-test-credentials"), "{text}");
    assert!(
        !prompt.contains("only through the skopos tools"),
        "{prompt}"
    );
}

#[tokio::test]
async fn starting_the_app_removes_the_run_folders_a_crash_left() {
    let root = tempfile::tempdir().unwrap();
    let stale = root.path().join("app/data/agents/run/old-chat");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("kubeconfig"), "token: secret").unwrap();
    let paths =
        skopos_core::paths::AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let _core = AppCore::start(paths).await.unwrap();
    assert!(!stale.exists());
    assert!(root.path().join("app/data/agents/run").is_dir());
}
