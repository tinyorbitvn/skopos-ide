//! The fake ACP agent on its own: raw JSON-RPC lines over its stdio, as a client sends them.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const FAKE_AGENT: &str = env!("CARGO_BIN_EXE_skopos-fakeagent");

struct Wire {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}

impl Wire {
    fn start(dir: &Path, script: Value) -> Wire {
        let script_file = dir.join("script.json");
        std::fs::write(&script_file, script.to_string()).unwrap();
        let mut command = Command::new(FAKE_AGENT);
        command.env_clear();
        // Windows starts no networking process without it.
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        let mut child = command
            .arg("--script")
            .arg(&script_file)
            .arg("--log")
            .arg(log_file(dir))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Wire {
            _child: child,
            stdin,
            lines,
        }
    }

    async fn send(&mut self, message: Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(20), self.lines.next_line())
            .await
            .expect("the fake agent writes within 20 s")
            .unwrap()
            .expect("the fake agent keeps its stdout open");
        serde_json::from_str(&line).unwrap()
    }

    /// The messages up to the answer to request `id`, that answer last.
    async fn until_answer(&mut self, id: u64) -> Vec<Value> {
        let mut messages = Vec::new();
        loop {
            let message = self.next().await;
            let answer = message["id"] == id && message.get("method").is_none();
            messages.push(message);
            if answer {
                return messages;
            }
        }
    }
}

fn log_file(dir: &Path) -> PathBuf {
    dir.join("agent.log")
}

fn log(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(log_file(dir))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn initialize(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "initialize", "params": {
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false
        }
    } })
}

fn session_new(id: u64, cwd: &Path) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "session/new", "params": {
        "cwd": cwd,
        "mcpServers": []
    } })
}

#[tokio::test]
async fn it_answers_initialize_with_version_1_load_session_and_one_auth_method() {
    let dir = tempfile::tempdir().unwrap();
    let mut wire = Wire::start(dir.path(), json!({ "loadSession": true }));
    wire.send(initialize(1)).await;
    let answer = wire.until_answer(1).await.pop().unwrap();
    assert_eq!(answer["result"]["protocolVersion"], 1);
    assert_eq!(answer["result"]["agentCapabilities"]["loadSession"], true);
    assert_eq!(
        answer["result"]["authMethods"].as_array().map(Vec::len),
        Some(1)
    );
}

#[tokio::test]
async fn session_new_fails_with_auth_required_when_the_script_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let mut wire = Wire::start(dir.path(), json!({ "auth": "required" }));
    wire.send(initialize(1)).await;
    wire.until_answer(1).await;
    wire.send(session_new(2, dir.path())).await;
    let answer = wire.until_answer(2).await.pop().unwrap();
    assert_eq!(answer["error"]["code"], -32000);
    assert!(answer.get("result").is_none());
}

#[tokio::test]
async fn a_prompt_plays_its_turn_and_ends_with_the_scripts_stop_reason() {
    let dir = tempfile::tempdir().unwrap();
    let mut wire = Wire::start(
        dir.path(),
        json!({ "turns": [ { "steps": [
            { "plan": [ { "content": "Find the api Pods", "status": "completed" } ] },
            { "say": "hello" },
            { "stop": "max_tokens" }
        ] } ] }),
    );
    wire.send(initialize(1)).await;
    wire.until_answer(1).await;
    wire.send(session_new(2, dir.path())).await;
    let answer = wire.until_answer(2).await.pop().unwrap();
    assert_eq!(answer["result"]["sessionId"], "fake-session-1");

    wire.send(
        json!({ "jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {
        "sessionId": "fake-session-1",
        "prompt": [ { "type": "text", "text": "Hi" } ]
    } }),
    )
    .await;
    let mut messages = wire.until_answer(3).await;
    let answer = messages.pop().unwrap();
    assert_eq!(answer["result"]["stopReason"], "max_tokens");
    let kinds: Vec<&str> = messages
        .iter()
        .map(|message| {
            message["params"]["update"]["sessionUpdate"]
                .as_str()
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(kinds, vec!["plan", "agent_message_chunk"]);
    assert_eq!(messages[0]["method"], "session/update");
    assert_eq!(messages[0]["params"]["sessionId"], "fake-session-1");
    let entry = &messages[0]["params"]["update"]["entries"][0];
    assert_eq!(entry["content"], "Find the api Pods");
    assert_eq!(entry["status"], "completed");
    assert_eq!(messages[1]["params"]["update"]["content"]["text"], "hello");

    let log = log(dir.path());
    let methods: Vec<&str> = log
        .iter()
        .filter_map(|line| line["method"].as_str())
        .collect();
    assert_eq!(methods, vec!["initialize", "session/new", "session/prompt"]);
    let prompt = log
        .iter()
        .find(|line| line["method"] == "session/prompt")
        .unwrap();
    assert_eq!(prompt["params"]["prompt"][0]["text"], "Hi");
}
