//! The app binary's askpass mode (tunnels spec §6.3): a tunnel's `ssh` runs the binary with the
//! prompt as its only argument and `SKOPOS_ASKPASS_TOKEN` set. `main` must hand it to the core
//! before the login shell environment, the runtime or a window starts.
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

/// The app binary as `ssh` runs it. Were the mode not handled, the app would start: keep it
/// off the real home and display.
fn askpass(addr: &str, prompt: &str) -> Command {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("askpass");
    std::fs::create_dir_all(&root).unwrap();
    let mut command = Command::new(APP);
    command
        .arg(prompt)
        .env_clear()
        .env("SKOPOS_ASKPASS_ADDR", addr)
        .env("SKOPOS_ASKPASS_TOKEN", TOKEN)
        .env("SKOPOS_CONFIG_DIR", &root)
        .env("HOME", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    command
}

/// Accepts the mode's connection, checks the token line, reads the request and sends `reply`.
async fn answer(endpoint: &TcpListener, reply: &str) -> serde_json::Value {
    let (socket, _) = timeout(WAIT, endpoint.accept())
        .await
        .expect("the app binary never connected: main does not run the askpass mode")
        .unwrap();
    let (from, mut to) = socket.into_split();
    let mut from = BufReader::new(from);
    let mut line = String::new();
    timeout(WAIT, from.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line, format!("{TOKEN}\n"), "the token comes first");
    line.clear();
    timeout(WAIT, from.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    to.write_all(reply.as_bytes()).await.unwrap();
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn askpass_relays_the_prompt_and_prints_the_answer() {
    let endpoint = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = endpoint.local_addr().unwrap().to_string();
    let child = askpass(&addr, "me@bastion's password: ").spawn().unwrap();
    let request = answer(&endpoint, "{\"reply\":\"answer\",\"text\":\"hunter2\"}\n").await;
    assert_eq!(request["prompt"], "me@bastion's password: ");
    let output = timeout(WAIT, child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "hunter2\n");
}

#[tokio::test]
async fn no_exits_1_and_a_notice_asks_nothing() {
    let endpoint = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = endpoint.local_addr().unwrap().to_string();
    let child = askpass(
        &addr,
        "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
    )
    .spawn()
    .unwrap();
    answer(&endpoint, "{\"reply\":\"no\"}\n").await;
    let output = timeout(WAIT, child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());

    // Nothing listens on port 1: a notice must not even try.
    let mut notice = askpass("127.0.0.1:1", "Confirm user presence for key");
    notice.env("SSH_ASKPASS_PROMPT", "none");
    let status = timeout(WAIT, notice.status()).await.unwrap().unwrap();
    assert_eq!(status.code(), Some(0));
}
