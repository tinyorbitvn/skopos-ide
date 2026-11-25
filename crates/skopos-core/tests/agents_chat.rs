//! Chats end to end (agents spec §4.1, §4.3, §4.8, §6): fakekube, and the fake agent as a
//! custom agent behind a shell that notes its process id and environment. The sandbox is off
//! (R2) except in the last test, which runs only with `SKOPOS_SANDBOX_TEST=1`.
#![cfg(unix)]

mod support;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use skopos_core::agents::approvals::{ChangeAnswer, ChangeCard, ChangeState};
use skopos_core::agents::chat::{ChatInfo, ChatScope, ChatStart};
use skopos_core::agents::cli_login::{now_ms, KeychainLogin, KeychainSource};
use skopos_core::agents::editor_tab::{EditorTab, EditorTabMode};
use skopos_core::agents::events::{ChatEvent, ChatItem, ChatItemBody, ObjectRef};
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
/// Notes the shell's process id, which `exec` keeps for the agent, and the agent's environment.
const WRAPPER: &str = "echo $$ > agent.pid; env > agent.env; exec \"$@\"";
const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}"#;

/// How a test starts the agent.
enum Sandbox {
    /// R2: directly, with the same environment, proxy and MCP endpoint.
    Off,
    /// Inside the machine's sandbox.
    On,
    /// The sandbox reads as not ready.
    Unready,
}

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
        Bench::with(script, Sandbox::Off).await
    }

    async fn with(script: Value, sandbox: Sandbox) -> Bench {
        let (core, fake, cluster, root) = connected_fake(FakeKubeConfig::default()).await;
        match sandbox {
            Sandbox::Off => core.agent_sandbox_off_for_test(),
            Sandbox::On => {}
            Sandbox::Unready => core.agent_sandbox_unready_for_test(),
        }
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

    /// The process id of the agent started last.
    fn agent_pid(&self) -> u32 {
        let text = std::fs::read_to_string(self.agent_dir().join("agent.pid")).unwrap();
        text.trim().parse().unwrap()
    }

    /// The environment of the agent started last, as `env` prints it.
    fn agent_env(&self) -> String {
        std::fs::read_to_string(self.agent_dir().join("agent.env")).unwrap()
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

/// The fake agent's script and log are relative to its working directory, the agent's folder.
/// They go as arguments: the agent's environment holds only spec §4.6's variables.
fn fake_agent_command() -> String {
    shell_words::join([
        "sh",
        "-c",
        WRAPPER,
        "sh",
        env!("CARGO_BIN_EXE_skopos-fakeagent"),
        "--script",
        SCRIPT,
        "--log",
        LOG,
    ])
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

fn notice_of(event: &ChatEvent) -> Option<&str> {
    match event {
        ChatEvent::Item {
            item:
                ChatItem {
                    body: ChatItemBody::Notice { text, .. },
                    ..
                },
        } => Some(text.as_str()),
        _ => None,
    }
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

/// The proxy's port and token from the agent's `HTTPS_PROXY`.
fn proxy_of(env: &str) -> (u16, String) {
    let url = env
        .lines()
        .find_map(|line| line.strip_prefix("HTTPS_PROXY="))
        .unwrap();
    let (token, address) = url
        .strip_prefix("http://skopos:")
        .unwrap()
        .split_once('@')
        .unwrap();
    let port = address
        .strip_prefix("127.0.0.1:")
        .unwrap()
        .trim_end_matches('/')
        .parse()
        .unwrap();
    (port, token.to_owned())
}

/// The first line of the proxy's answer to a `CONNECT <host>:443` with the chat's token.
async fn connect_through(port: u16, token: &str, host: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let credentials = STANDARD.encode(format!("skopos:{token}"));
    let head = format!(
        "CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\nProxy-Authorization: Basic {credentials}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut lines = BufReader::new(stream).lines();
    tokio::time::timeout(WAIT, lines.next_line())
        .await
        .expect("the proxy answers")
        .unwrap()
        .unwrap_or_default()
}

/// Whether `pid` runs; a zombie has ended.
fn is_running(pid: u32) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
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

#[tokio::test]
async fn the_agent_s_permission_requests_are_answered_allow_once() {
    let own_tool = json!({ "ownTool": { "title": "Run ls", "permission": true } });
    let bench = Bench::new(script(vec![turn(vec![own_tool, say("Done.")])])).await;
    let (info, mut events) = bench.start(MAIN).await;
    bench.ask(&info.chat_id, "List the folder.").await;
    let log = bench.log();
    let mut chosen = Vec::new();
    for line in &log {
        values_of(line, "optionId", &mut chosen);
    }
    assert!(!chosen.is_empty(), "{log:#?}");
    assert!(
        chosen.iter().all(|id| id.as_str() == Some("allow_once")),
        "{chosen:?}"
    );
    let items = events.items();
    assert!(
        items.iter().any(
            |item| matches!(&item.body, ChatItemBody::AgentTool { title, .. } if title == "Run ls")
        ),
        "{items:#?}"
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
            "You are running inside SkoposIDE, a Kubernetes desktop app. You can reach fake only \
             through the tools of the skopos MCP server"
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

/// The fake agent's sign-in, as a keychain item that `security` in `dir` prints.
const FAKE_LOGIN: KeychainLogin = KeychainLogin {
    service: "Fake-credentials",
    var: "FAKE_OAUTH_TOKEN",
    hint: "Run fake login, then send your message again.",
};
const HOUR_MS: i64 = 3_600_000;

/// Has the chats read the fake agent's sign-in from a `security` in `dir`, which prints the
/// item that `write_item` last wrote.
fn fake_keychain(core: &AppCore, dir: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let security = dir.join("security");
    let script = format!(
        "#!/bin/sh\n[ \"$*\" = 'find-generic-password -s Fake-credentials -w' ] || exit 44\n\
         cat '{}'\n",
        dir.join("item").display()
    );
    std::fs::write(&security, script).unwrap();
    std::fs::set_permissions(&security, std::fs::Permissions::from_mode(0o755)).unwrap();
    core.set_agent_keychain_for_test(KeychainSource {
        security,
        login: FAKE_LOGIN,
    });
}

fn write_item(dir: &std::path::Path, token: &str, ends_ms: i64) {
    let item = json!({
        "claudeAiOauth": { "accessToken": token, "refreshToken": "refresh", "expiresAt": ends_ms }
    });
    std::fs::write(dir.join("item"), item.to_string()).unwrap();
}

#[tokio::test]
async fn a_chat_whose_sign_in_ran_out_reopens_with_the_keychain_s_new_one() {
    let bench = Bench::new(script(vec![turn(vec![json!("signIn")])])).await;
    let keychain = bench.root.path().join("keychain");
    std::fs::create_dir_all(&keychain).unwrap();
    fake_keychain(&bench.core, &keychain);
    write_item(&keychain, "old-token", now_ms() - HOUR_MS);
    let (info, mut events) = bench.start(MAIN).await;
    assert!(!bench.agent_env().contains("FAKE_OAUTH_TOKEN"));
    let first_agent = bench.agent_pid();
    // Nothing newer in the keychain: the same agent answers, and the chat says how to renew.
    bench.ask(&info.chat_id, "First question").await;
    assert_eq!(
        events.notices(),
        ["Fake needs you to sign in. Run fake login, then send your message again."]
    );
    assert!(requests(&bench.log(), "session/load").is_empty());
    assert_eq!(bench.agent_pid(), first_agent);
    // The CLI renewed its sign-in: the next message reopens the agent with it, in this chat.
    write_item(&keychain, "new-token", now_ms() + 8 * HOUR_MS);
    bench.write_script(&script(vec![turn(vec![say("An answer.")])]));
    bench.ask(&info.chat_id, "Second question").await;
    let loads = requests(&bench.log(), "session/load");
    assert_eq!(loads.len(), 1);
    assert_eq!(
        loads[0]["sessionId"],
        bench
            .core
            .chat_get(&info.chat_id)
            .unwrap()
            .session_id
            .unwrap()
            .as_str()
    );
    assert!(bench
        .agent_env()
        .lines()
        .any(|line| line == "FAKE_OAUTH_TOKEN=new-token"));
    assert_ne!(bench.agent_pid(), first_agent);
    wait_gone(first_agent).await;
    assert_eq!(agent_texts(&events.items()), ["An answer."]);
    assert_eq!(prompts(&bench.log()).last().unwrap(), &["Second question"]);
    // The window saw one chat throughout.
    events.drain();
    assert!(!events
        .seen
        .iter()
        .any(|event| matches!(event, ChatEvent::Closed { .. })));
    // A token with time left is kept.
    bench.ask(&info.chat_id, "Third question").await;
    assert_eq!(requests(&bench.log(), "session/load").len(), 1);
    let users = bench
        .core
        .chat_get(&info.chat_id)
        .unwrap()
        .items
        .into_iter()
        .filter(|item| matches!(item.body, ChatItemBody::User { .. }))
        .count();
    assert_eq!(users, 3);
}

#[tokio::test]
async fn a_chat_whose_agent_refused_its_sign_in_reopens_with_another_one() {
    let bench = Bench::new(script(vec![turn(vec![json!("signIn")])])).await;
    let keychain = bench.root.path().join("keychain");
    std::fs::create_dir_all(&keychain).unwrap();
    fake_keychain(&bench.core, &keychain);
    write_item(&keychain, "first-token", now_ms() + 8 * HOUR_MS);
    let (info, mut events) = bench.start(MAIN).await;
    assert!(bench
        .agent_env()
        .lines()
        .any(|line| line == "FAKE_OAUTH_TOKEN=first-token"));
    // Signed out elsewhere, say: the agent refuses a token that has time left.
    bench.ask(&info.chat_id, "First question").await;
    assert_eq!(
        events.notices(),
        ["Fake needs you to sign in. Run fake login, then send your message again."]
    );
    // The keychain still holds that token: the same agent gets the next message.
    bench.ask(&info.chat_id, "Second question").await;
    assert!(requests(&bench.log(), "session/load").is_empty());
    // Signed in again: another token, and the chat reopens with it.
    write_item(&keychain, "second-token", now_ms() + 8 * HOUR_MS);
    bench.write_script(&script(vec![turn(vec![say("An answer.")])]));
    bench.ask(&info.chat_id, "Third question").await;
    assert_eq!(requests(&bench.log(), "session/load").len(), 1);
    assert!(bench
        .agent_env()
        .lines()
        .any(|line| line == "FAKE_OAUTH_TOKEN=second-token"));
    assert_eq!(agent_texts(&events.items()), ["An answer."]);
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
async fn a_blocked_host_reaches_the_stream_as_one_notice() {
    let bench = Bench::new(script(vec![turn(vec![say("Hi.")])])).await;
    let (info, mut events) = bench.start(MAIN).await;
    let env = bench.agent_env();
    let (port, token) = proxy_of(&env);
    let refused = connect_through(port, &token, "blocked.example").await;
    assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
    events
        .until("the blocked-host notice", |event| {
            notice_of(event) == Some("The sandbox blocked blocked.example.")
        })
        .await;
    let again = connect_through(port, &token, "blocked.example").await;
    assert!(again.starts_with("HTTP/1.1 403"), "{again}");
    bench.ask(&info.chat_id, "Hello").await;
    assert_eq!(events.notices(), ["The sandbox blocked blocked.example."]);
    // Spec §6.2: what the agent's environment holds.
    let home = format!("HOME={}", bench.root.path().join("home").display());
    let lines: Vec<&str> = env.lines().collect();
    assert!(lines.contains(&"TERM=dumb"), "{env}");
    assert!(lines.contains(&"NO_PROXY=localhost,127.0.0.1,::1"), "{env}");
    assert!(lines.contains(&home.as_str()), "{env}");
    assert!(
        !lines
            .iter()
            .any(|line| line.starts_with("KUBECONFIG=") || line.starts_with("SKOPOS_AGENT_TOKEN=")),
        "{env}"
    );
}

#[tokio::test]
async fn a_chat_does_not_start_without_a_ready_sandbox() {
    let bench = Bench::with(script(Vec::new()), Sandbox::Unready).await;
    let (sender, _events) = Events::new();
    let error = bench
        .core
        .chat_start(bench.start_of(None), sender, MAIN)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.message, "The agent sandbox isn't ready.");
    assert!(bench.log().is_empty());
    assert!(!bench.agent_dir().join("agent.pid").exists());
    assert_eq!(bench.run_folders(), 0);
    assert_eq!(bench.core.session_count(), 0);
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
async fn a_sandboxed_chat_reaches_the_tools_through_the_bridge() {
    if std::env::var("SKOPOS_SANDBOX_TEST").as_deref() != Ok("1") {
        eprintln!("skipped: set SKOPOS_SANDBOX_TEST=1");
        return;
    }
    let bench = Bench::with(script(vec![turn(vec![list_pods()])]), Sandbox::On).await;
    bench.fake.add_pod("default", "api-1");
    let (info, mut events) = bench.start(MAIN).await;
    let (address, _) = mcp_entry(&bench.log());
    if cfg!(target_os = "linux") {
        // R3: the agent dials the bridge's fixed port inside its own network namespace.
        assert_eq!(address, "127.0.0.1:3129");
    }
    bench.ask(&info.chat_id, "Which Pods run?").await;
    let items = events.items();
    assert_eq!(
        tool_results(&items),
        [("List Pods · default".to_owned(), "1 Pod".to_owned())]
    );
    assert!(
        agent_texts(&items)
            .iter()
            .any(|text| text.starts_with("tool:list_objects:")),
        "{items:#?}"
    );
    bench.core.chat_close(&info.chat_id).await;
    assert_eq!(bench.run_folders(), 0);
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
