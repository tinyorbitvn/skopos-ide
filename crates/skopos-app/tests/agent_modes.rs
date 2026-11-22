//! The app binary's hidden `--agent-mcp` mode (agents spec §4.1, §5.2): the MCP server entry
//! an agent launches inside the sandbox. `main` must hand it to the core before the login
//! shell environment, the runtime or a window starts.
#![cfg(unix)]

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::time::timeout;

const APP: &str = env!("CARGO_BIN_EXE_skopos-app");
const TOKEN: &str = "0123456789abcdef0123456789abcdef";
/// The app binary loads its GUI libraries before `main` runs, which takes a moment.
const WAIT: Duration = Duration::from_secs(20);

#[tokio::test]
async fn agent_mcp_sends_the_token_then_pipes_stdio_to_the_endpoint() {
    let endpoint = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = endpoint.local_addr().unwrap().to_string();
    // Were the mode not handled, the app would start: keep it off the real home and display.
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("agent-mcp");
    std::fs::create_dir_all(&root).unwrap();
    let mut child = Command::new(APP)
        .args(["--agent-mcp", target.as_str()])
        .env_clear()
        .env("SKOPOS_AGENT_TOKEN", TOKEN)
        .env("SKOPOS_CONFIG_DIR", &root)
        .env("HOME", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let (socket, _) = timeout(WAIT, endpoint.accept())
        .await
        .expect("the app binary never connected: main does not run --agent-mcp")
        .unwrap();
    let (from_bridge, mut to_bridge) = socket.into_split();
    let mut from_bridge = BufReader::new(from_bridge);
    let mut line = String::new();
    timeout(WAIT, from_bridge.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line, format!("{TOKEN}\n"), "the token comes first");

    let request = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n";
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(request.as_bytes()).await.unwrap();
    line.clear();
    timeout(WAIT, from_bridge.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line, request, "the agent's stdin reaches the endpoint");

    let reply = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n";
    to_bridge.write_all(reply.as_bytes()).await.unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut answer = String::new();
    timeout(WAIT, stdout.read_line(&mut answer))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        answer, reply,
        "the endpoint's reply reaches the agent's stdout"
    );

    drop(stdin);
    drop(to_bridge);
    drop(from_bridge);
    let status = timeout(WAIT, child.wait()).await.unwrap().unwrap();
    assert_eq!(
        status.code(),
        Some(0),
        "a clean close ends the bridge with 0"
    );
}
