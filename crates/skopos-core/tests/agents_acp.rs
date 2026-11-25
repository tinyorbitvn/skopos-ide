//! The ACP client and the probes against the scripted fake agent (`skopos-fakeagent`),
//! started natively, on every OS. The fake names its script and log on its command line, so a
//! test does not depend on the environment it runs in.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::agents::acp::{
    AcpSession, AcpUpdate, McpEntry, PlanEntry, PlanStatus, StartError, ToolStatus, TurnEnd,
};
use skopos_core::agents::permissions::{PermissionState, Permissions};
use skopos_core::agents::probe::probe_within;
use skopos_core::agents::prompt::{hidden_block, object_line, PromptContext};
use skopos_core::agents::registry::AgentStatus;
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::ClusterAgentSettings;
use tempfile::TempDir;
use tokio::process::Command;
use tokio::sync::mpsc;

const FAKE_AGENT: &str = env!("CARGO_BIN_EXE_skopos-fakeagent");
const AGENT_HOST: &str = env!("CARGO_BIN_EXE_skopos-agent-host");
/// Far above what any step here takes; a hang fails the test instead of the run.
const WAIT: Duration = Duration::from_secs(30);

/// One fake agent: its script, its log and its folders in a temp dir.
struct Fake {
    root: TempDir,
}

impl Fake {
    fn new(script: Value) -> Fake {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("script.json"), script.to_string()).unwrap();
        for dir in ["work", "home", "bin"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        Fake { root }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn work(&self) -> PathBuf {
        self.path("work")
    }

    fn args(&self) -> Vec<String> {
        vec![
            "--script".to_owned(),
            self.path("script.json").display().to_string(),
            "--log".to_owned(),
            self.path("agent.log").display().to_string(),
        ]
    }

    /// The fake agent in its work folder, with a small environment of its own.
    fn command(&self) -> Command {
        let mut command = Command::new(FAKE_AGENT);
        command.args(self.args()).env_clear();
        // Windows starts no networking process without it.
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.path("home"))
            .current_dir(self.work())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    /// The command line of a custom agent that runs this fake.
    fn command_line(&self) -> String {
        let mut words = vec![FAKE_AGENT.to_owned()];
        words.extend(self.args());
        command_line(&words)
    }

    /// A shell script in the fake's `bin/`.
    #[cfg(unix)]
    fn executable(&self, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = self.path("bin").join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// A batch file `<name>.cmd` in the fake's `bin/` that does what the shell `body` does:
    /// `echo <text> >&2` lines and an `exit <code>` line.
    #[cfg(windows)]
    fn executable(&self, name: &str, body: &str) -> PathBuf {
        let path = self.path("bin").join(format!("{name}.cmd"));
        let mut script = "@echo off\r\n".to_owned();
        for line in body.lines() {
            if let Some(text) = line
                .strip_prefix("echo ")
                .and_then(|l| l.strip_suffix(" >&2"))
            {
                script.push_str(&format!(">&2 echo {text}\r\n"));
            } else if let Some(code) = line.strip_prefix("exit ") {
                script.push_str(&format!("exit /b {code}\r\n"));
            } else {
                panic!("no batch line for {line:?}");
            }
        }
        std::fs::write(&path, script).unwrap();
        path
    }

    fn log(&self) -> Vec<Value> {
        match std::fs::read_to_string(self.path("agent.log")) {
            Ok(text) => text
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// The params of each request named `method`, in order.
    fn requests(&self, method: &str) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter(|line| line["method"] == method)
            .map(|line| line["params"].clone())
            .collect()
    }

    fn permission_answers(&self) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter(|line| line["answer"] == "session/request_permission")
            .map(|line| line["optionId"].clone())
            .collect()
    }

    fn pid(&self) -> u64 {
        self.log()
            .iter()
            .find_map(|line| line["started"].as_u64())
            .expect("the fake agent started")
    }
}

/// `words` as a custom agent's command: as a shell quotes them on Unix; on Windows each in
/// double quotes, since backslashes there are literal.
fn command_line<S: AsRef<str>>(words: &[S]) -> String {
    if cfg!(windows) {
        let quoted: Vec<String> = words
            .iter()
            .map(|word| format!("\"{}\"", word.as_ref()))
            .collect();
        quoted.join(" ")
    } else {
        shell_words::join(words.iter().map(AsRef::as_ref))
    }
}

#[cfg(unix)]
fn alive(pid: u64) -> bool {
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("kill -0 {pid} 2>/dev/null"))
        .status()
        .unwrap()
        .success()
}

#[cfg(windows)]
fn alive(pid: u64) -> bool {
    let filter = format!("PID eq {pid}");
    let out = std::process::Command::new("tasklist")
        .args(["/FI", filter.as_str(), "/FO", "CSV", "/NH"])
        .output()
        .unwrap();
    // A row is `"name","<pid>",…`; without one tasklist prints an INFO line.
    String::from_utf8_lossy(&out.stdout).contains(&format!(",\"{pid}\","))
}

/// A `skopos` entry like a chat's, aimed at a port where nothing listens.
fn mcp_entry() -> McpEntry {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    McpEntry {
        command: PathBuf::from(AGENT_HOST),
        args: vec!["--agent-mcp".to_owned(), format!("127.0.0.1:{port}")],
        env: vec![("SKOPOS_AGENT_TOKEN".to_owned(), "chat-token".to_owned())],
    }
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, future)
        .await
        .expect("the agent answers within 30 s")
}

async fn start(fake: &Fake) -> (AcpSession, mpsc::Receiver<AcpUpdate>) {
    let (updates, received) = mpsc::channel(64);
    let started = within(AcpSession::start(
        fake.command(),
        "Fake",
        &fake.work(),
        mcp_entry(),
        updates,
        None,
    ))
    .await;
    match started {
        Ok(session) => (session, received),
        Err(error) => panic!("the fake agent did not start: {error:?}"),
    }
}

async fn start_error(command: Command, cwd: &Path) -> StartError {
    let (updates, _received) = mpsc::channel(64);
    match within(AcpSession::start(
        command,
        "Fake",
        cwd,
        mcp_entry(),
        updates,
        None,
    ))
    .await
    {
        Ok(session) => {
            session.close().await;
            panic!("the agent started")
        }
        Err(error) => error,
    }
}

fn drain(received: &mut mpsc::Receiver<AcpUpdate>) -> Vec<AcpUpdate> {
    let mut updates = Vec::new();
    while let Ok(update) = received.try_recv() {
        updates.push(update);
    }
    updates
}

fn own_tool(status: ToolStatus, details: &str) -> AcpUpdate {
    AcpUpdate::AgentTool {
        id: "own-1".to_owned(),
        title: "Run ls".to_owned(),
        status,
        details: details.to_owned(),
    }
}

async fn test_core() -> (AppCore, TempDir) {
    let root = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    (core, root)
}

fn state(status: &AgentStatus) -> Value {
    serde_json::to_value(&status.state).unwrap()
}

#[tokio::test]
async fn a_session_starts_with_the_skopos_server_and_offers_no_files_or_terminal() {
    let fake = Fake::new(json!({ "loadSession": true }));
    let (session, _updates) = start(&fake).await;
    assert_eq!(session.session_id(), "fake-session-1");
    assert!(session.can_load());
    session.close().await;

    let initialize = &fake.requests("initialize")[0];
    assert_eq!(initialize["protocolVersion"], 1);
    let capabilities = &initialize["clientCapabilities"];
    assert_ne!(capabilities["fs"]["readTextFile"], true);
    assert_ne!(capabilities["fs"]["writeTextFile"], true);
    assert_ne!(capabilities["terminal"], true);
    assert_eq!(initialize["clientInfo"]["name"], "SkoposIDE");
    assert_eq!(initialize["clientInfo"]["version"], skopos_core::VERSION);

    let new = &fake.requests("session/new")[0];
    assert_eq!(new["cwd"], fake.work().display().to_string());
    assert_eq!(new["mcpServers"].as_array().map(Vec::len), Some(1));
    let server = &new["mcpServers"][0];
    assert_eq!(server["name"], "skopos");
    assert_eq!(server["command"], AGENT_HOST);
    assert_eq!(server["args"][0], "--agent-mcp");
    assert_eq!(server["env"][0]["name"], "SKOPOS_AGENT_TOKEN");
    assert_eq!(server["env"][0]["value"], "chat-token");
}

#[tokio::test]
async fn a_turn_streams_the_plan_the_text_and_the_agents_own_tool() {
    let fake = Fake::new(json!({ "turns": [ { "steps": [
        { "plan": [
            { "content": "Find the api Pods", "status": "completed" },
            { "content": "Read their logs", "status": "in_progress" }
        ] },
        { "say": "Looking at " },
        { "ownTool": { "title": "Run ls" } },
        { "say": "payments." }
    ] } ] }));
    let (session, mut updates) = start(&fake).await;
    let end = within(session.prompt(vec!["Why?".to_owned()])).await;
    assert_eq!(end, TurnEnd::EndTurn);
    assert_eq!(
        drain(&mut updates),
        vec![
            AcpUpdate::Plan(vec![
                PlanEntry {
                    content: "Find the api Pods".to_owned(),
                    status: PlanStatus::Completed,
                },
                PlanEntry {
                    content: "Read their logs".to_owned(),
                    status: PlanStatus::InProgress,
                },
            ]),
            AcpUpdate::AgentText("Looking at ".to_owned()),
            own_tool(ToolStatus::Pending, ""),
            own_tool(ToolStatus::Completed, "ran Run ls"),
            AcpUpdate::AgentText("payments.".to_owned()),
        ]
    );
    session.close().await;
}

#[tokio::test]
async fn a_permission_request_waits_for_the_answer_given_through_permissions() {
    let fake = Fake::new(json!({ "turns": [ { "steps": [
        { "ownTool": { "title": "Run ls", "permission": true } }
    ] } ] }));
    let (cards_sender, mut cards) = mpsc::channel(8);
    let permissions = Permissions::new(cards_sender);
    let (updates, mut received) = mpsc::channel(64);
    let started = within(AcpSession::start(
        fake.command(),
        "Fake",
        &fake.work(),
        mcp_entry(),
        updates,
        Some(permissions.clone()),
    ))
    .await;
    let session = match started {
        Ok(session) => session,
        Err(error) => panic!("the fake agent did not start: {error:?}"),
    };
    let prompt = session.prompt(vec!["List the files".to_owned()]);
    let answer = async {
        let card = cards.recv().await.expect("a permission card");
        assert_eq!(card.state, PermissionState::Waiting);
        assert_eq!(card.tool_call_id, "own-1");
        assert_eq!(card.title, "Run ls");
        assert!(fake.permission_answers().is_empty());
        permissions.answer(&card.id, "allow_always").unwrap();
    };
    let (end, ()) = within(async { tokio::join!(prompt, answer) }).await;
    assert_eq!(end, TurnEnd::EndTurn);
    assert_eq!(fake.permission_answers(), vec![json!("allow_always")]);
    assert_eq!(
        drain(&mut received),
        vec![
            own_tool(ToolStatus::Pending, ""),
            own_tool(ToolStatus::Completed, "ran Run ls"),
        ]
    );
    session.close().await;
}

#[tokio::test]
async fn without_permissions_a_permission_request_is_cancelled() {
    let fake = Fake::new(json!({ "turns": [ { "steps": [
        { "ownTool": { "title": "Run ls", "permission": true } }
    ] } ] }));
    let (session, mut updates) = start(&fake).await;
    let end = within(session.prompt(vec!["List the files".to_owned()])).await;
    assert_eq!(end, TurnEnd::EndTurn);
    assert_eq!(fake.permission_answers(), vec![json!("cancelled")]);
    assert_eq!(
        drain(&mut updates),
        vec![
            own_tool(ToolStatus::Pending, ""),
            own_tool(ToolStatus::Failed, "refused Run ls"),
        ]
    );
    session.close().await;
}

#[tokio::test]
async fn tool_calls_that_name_the_skopos_server_are_hidden() {
    let fake = Fake::new(json!({ "turns": [ { "steps": [
        { "tool": { "name": "list_objects", "args": { "kind": "Pod" } } },
        { "say": "done" }
    ] } ] }));
    let (session, mut updates) = start(&fake).await;
    let end = within(session.prompt(vec!["List the Pods".to_owned()])).await;
    assert_eq!(end, TurnEnd::EndTurn);
    assert_eq!(
        drain(&mut updates),
        vec![
            AcpUpdate::HiddenTool,
            AcpUpdate::AgentText("tool:list_objects:error: no skopos server".to_owned()),
            AcpUpdate::AgentText("done".to_owned()),
        ]
    );
    session.close().await;
}

#[tokio::test]
async fn the_prompt_blocks_reach_the_agent_in_order() {
    let fake = Fake::new(json!({}));
    let (session, _updates) = start(&fake).await;
    let block = hidden_block(&PromptContext {
        clusters: vec![("prod".to_owned(), ClusterAgentSettings::default())],
        global: false,
        kubeconfig: PathBuf::from("/run/chat/kubeconfig"),
    });
    let object = object_line("Pod", Some("payments"), "api-1", "prod");
    let end = within(session.prompt(vec![
        block.clone(),
        object.clone(),
        "Why does it restart?".to_owned(),
    ]))
    .await;
    assert_eq!(end, TurnEnd::EndTurn);
    let prompt = &fake.requests("session/prompt")[0];
    assert_eq!(prompt["sessionId"], "fake-session-1");
    let blocks = prompt["prompt"].as_array().unwrap();
    let texts: Vec<&str> = blocks
        .iter()
        .map(|block| block["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        vec![block.as_str(), object.as_str(), "Why does it restart?"]
    );
    assert!(blocks.iter().all(|block| block["type"] == "text"));
    session.close().await;
}

#[tokio::test]
async fn stop_reasons_end_the_turn() {
    let fake = Fake::new(json!({ "turns": [
        { "steps": [ { "stop": "max_tokens" } ] },
        { "steps": [ { "stop": "max_turn_requests" } ] },
        { "steps": [ { "stop": "refusal" } ] },
        { "steps": [ { "stop": "end_turn" } ] }
    ] }));
    let (session, _updates) = start(&fake).await;
    let mut ends = Vec::new();
    for _ in 0..5 {
        ends.push(within(session.prompt(vec!["Go on".to_owned()])).await);
    }
    assert_eq!(
        ends,
        vec![
            TurnEnd::MaxTokens,
            TurnEnd::MaxTurnRequests,
            TurnEnd::Refusal,
            TurnEnd::EndTurn,
            TurnEnd::EndTurn,
        ]
    );
    session.close().await;
}

#[tokio::test]
async fn cancel_ends_a_running_turn_as_cancelled() {
    let fake = Fake::new(json!({ "turns": [ { "steps": [
        { "say": "working" },
        { "sleep": 20000 },
        { "say": "never" }
    ] } ] }));
    let (session, mut updates) = start(&fake).await;
    let session = Arc::new(session);
    let turn = tokio::spawn({
        let session = Arc::clone(&session);
        async move { session.prompt(vec!["Wait".to_owned()]).await }
    });
    assert_eq!(
        within(updates.recv()).await,
        Some(AcpUpdate::AgentText("working".to_owned()))
    );
    session.cancel();
    let end = within(turn).await.unwrap();
    assert_eq!(end, TurnEnd::Cancelled);
    assert_eq!(drain(&mut updates), Vec::new());
    assert_eq!(
        fake.requests("session/cancel")[0]["sessionId"],
        "fake-session-1"
    );
    let Ok(session) = Arc::try_unwrap(session) else {
        panic!("the turn has let go of the session");
    };
    session.close().await;
}

#[tokio::test]
async fn an_agent_that_exits_mid_turn_ends_it_with_its_last_stderr_line() {
    let fake = Fake::new(json!({ "turns": [ { "steps": [
        { "say": "partial" },
        { "exit": 3 }
    ] } ] }));
    let (session, _updates) = start(&fake).await;
    let reason = "fake agent exits with code 3".to_owned();
    let end = within(session.prompt(vec!["Go".to_owned()])).await;
    assert_eq!(end, TurnEnd::Exited(reason.clone()));
    let again = within(session.prompt(vec!["Again".to_owned()])).await;
    assert_eq!(again, TurnEnd::Exited(reason));
    session.close().await;
}

#[tokio::test]
async fn an_agent_that_needs_sign_in_fails_to_start_with_sign_in_needed() {
    let fake = Fake::new(json!({ "auth": "required" }));
    assert_eq!(
        start_error(fake.command(), &fake.work()).await,
        StartError::SignInNeeded
    );
}

#[tokio::test]
async fn an_agent_that_does_not_speak_acp_fails_to_start_with_its_reason() {
    let fake = Fake::new(json!({}));
    let program = fake.executable(
        "not-acp",
        "echo starting >&2\necho not an agent. >&2\nexit 1",
    );
    assert_eq!(
        start_error(Command::new(program), &fake.work()).await,
        StartError::Failed("not an agent".to_owned())
    );
}

#[tokio::test]
async fn a_program_that_cannot_start_fails_with_its_path_and_error() {
    let fake = Fake::new(json!({}));
    let error = start_error(Command::new("/nonexistent/skopos-agent"), &fake.work()).await;
    match error {
        StartError::Failed(reason) => {
            assert!(
                reason.starts_with("/nonexistent/skopos-agent: "),
                "{reason}"
            )
        }
        StartError::SignInNeeded => panic!("a missing program needs no sign-in"),
    }
}

#[tokio::test]
async fn a_chat_reopens_with_session_load_when_the_agent_can_load() {
    let fake = Fake::new(json!({ "loadSession": true, "turns": [ { "steps": [
        { "say": "after load" }
    ] } ] }));
    let (updates, mut received) = mpsc::channel(64);
    let loaded = within(AcpSession::load(
        fake.command(),
        "Fake",
        &fake.work(),
        mcp_entry(),
        updates,
        "fake-session-7",
        None,
    ))
    .await;
    let session = match loaded {
        Ok(session) => session,
        Err(error) => panic!("the fake agent did not load: {error:?}"),
    };
    assert_eq!(session.session_id(), "fake-session-7");
    // The fake's replay (`replayed`) is dropped.
    assert_eq!(drain(&mut received), Vec::new());
    let end = within(session.prompt(vec!["Continue".to_owned()])).await;
    assert_eq!(end, TurnEnd::EndTurn);
    assert_eq!(
        drain(&mut received),
        vec![AcpUpdate::AgentText("after load".to_owned())]
    );
    let load = &fake.requests("session/load")[0];
    assert_eq!(load["sessionId"], "fake-session-7");
    assert_eq!(load["cwd"], fake.work().display().to_string());
    assert_eq!(load["mcpServers"][0]["name"], "skopos");
    assert!(fake.requests("session/new").is_empty());
    assert_eq!(
        fake.requests("session/prompt")[0]["sessionId"],
        "fake-session-7"
    );
    session.close().await;
}

#[tokio::test]
async fn load_is_refused_when_the_agent_cannot_load() {
    let fake = Fake::new(json!({}));
    let (updates, _received) = mpsc::channel(64);
    let loaded = within(AcpSession::load(
        fake.command(),
        "Fake",
        &fake.work(),
        mcp_entry(),
        updates,
        "fake-session-7",
        None,
    ))
    .await;
    match loaded {
        Ok(session) => {
            session.close().await;
            panic!("the session loaded")
        }
        Err(error) => assert_eq!(
            error,
            StartError::Failed("The agent can't reopen old chats.".to_owned())
        ),
    }
    assert!(fake.requests("session/load").is_empty());
}

#[tokio::test]
async fn closing_a_session_ends_the_agent_and_its_updates() {
    let fake = Fake::new(json!({}));
    let (session, mut updates) = start(&fake).await;
    let pid = fake.pid();
    assert!(alive(pid));
    session.close().await;
    assert!(!alive(pid));
    assert_eq!(within(updates.recv()).await, None);
}

#[tokio::test]
async fn a_probe_marks_an_agent_that_answers_ready() {
    let fake = Fake::new(json!({}));
    let (core, root) = test_core().await;
    let added = core.agent_custom_add("Fake", &fake.command_line()).unwrap();
    assert_eq!(state(&added), json!({ "state": "unknown" }));

    let probed = within(core.agent_probe(&added.id)).await.unwrap();
    assert_eq!(state(&probed), json!({ "state": "ready" }));
    let listed = core
        .agents_status()
        .unwrap()
        .into_iter()
        .find(|status| status.id == added.id)
        .unwrap();
    assert_eq!(state(&listed), json!({ "state": "ready" }));

    // A scratch folder, no MCP servers, nothing left running and no run folder left.
    let data = root.path().join("app").join("data").join("agents");
    let new = &fake.requests("session/new")[0];
    assert_eq!(
        new["cwd"],
        data.join("probe").join(&added.id).display().to_string()
    );
    assert_eq!(new["mcpServers"], json!([]));
    assert!(!alive(fake.pid()));
    let runs = std::fs::read_dir(data.join("run")).map(|entries| entries.count());
    assert_eq!(runs.unwrap_or(0), 0);
}

#[tokio::test]
async fn a_probe_reports_sign_in_needed() {
    let fake = Fake::new(json!({ "auth": "required" }));
    let (core, _root) = test_core().await;
    let added = core.agent_custom_add("Fake", &fake.command_line()).unwrap();
    let probed = within(core.agent_probe(&added.id)).await.unwrap();
    assert_eq!(state(&probed), json!({ "state": "signInNeeded" }));
}

#[tokio::test]
async fn a_probe_of_an_agent_that_exits_reports_its_last_stderr_line() {
    let fake = Fake::new(json!({}));
    let program = fake.executable(
        "broken-agent",
        "echo starting >&2\necho broken setup. >&2\nexit 1",
    );
    let (core, _root) = test_core().await;
    let added = core
        .agent_custom_add("Broken", &command_line(&[program.display().to_string()]))
        .unwrap();
    let probed = within(core.agent_probe(&added.id)).await.unwrap();
    assert_eq!(
        state(&probed),
        json!({ "state": "doesNotStart", "reason": "broken setup" })
    );
}

#[tokio::test]
async fn a_probe_with_no_answer_gives_up_after_the_limit() {
    let fake = Fake::new(json!({}));
    let command = if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/C", "ping -n 30 127.0.0.1 > NUL"]);
        command
    } else {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        command
    };
    let started = Instant::now();
    let state = probe_within(command, &fake.work(), "Sleepy", Duration::from_secs(2)).await;
    assert_eq!(
        serde_json::to_value(&state).unwrap(),
        json!({ "state": "doesNotStart", "reason": "Sleepy didn't answer within 2 seconds." })
    );
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn probing_an_agent_whose_command_is_gone_needs_no_probe() {
    let fake = Fake::new(json!({}));
    let program = fake.executable("gone-agent", "exit 0");
    let (core, root) = test_core().await;
    let added = core
        .agent_custom_add("Gone", &command_line(&[program.display().to_string()]))
        .unwrap();
    std::fs::remove_file(&program).unwrap();
    let probed = within(core.agent_probe(&added.id)).await.unwrap();
    assert_eq!(state(&probed), json!({ "state": "notInstalled" }));
    let scratch = root.path().join("app/data/agents/probe").join(&added.id);
    assert!(!scratch.exists());
}

#[tokio::test]
async fn probing_an_unknown_agent_is_not_found() {
    let (core, _root) = test_core().await;
    match core.agent_probe("nobody").await {
        Ok(status) => panic!("probed {}", status.id),
        Err(error) => assert_eq!(error.code, ErrorCode::NotFound),
    }
}
