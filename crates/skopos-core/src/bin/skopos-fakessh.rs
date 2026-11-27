//! Stands in for `ssh` in the tunnel tests (tunnels spec §6.6); it never ships.
//!
//! `-V` prints `$SKOPOS_FAKESSH_VERSION` (default `OpenSSH_9.6p1 fake`) to stderr. Any other
//! call follows `$SKOPOS_FAKESSH_PLAN`: run N follows line N (the last line repeats), with
//! steps separated by ` ; `:
//! - `say <text>`: writes `<text>` to stderr;
//! - `ask <prompt>` / `confirm <prompt>`: runs `$SSH_ASKPASS <prompt>` (with
//!   `SSH_ASKPASS_PROMPT=confirm` for `confirm`) and keeps its answer;
//! - `expect <text>`: unless the last answer was `<text>`, says
//!   `me@bastion: Permission denied (password).` and exits 255;
//! - `listen`: serves SOCKS5 without authentication on the `-D` address; a target it cannot
//!   reach gets `channel N: open failed: connect failed: <reason>` on stderr, as `ssh` writes;
//! - `sleep <ms>`, `exit <code>`, `wait` (until killed).
//!
//! Each run appends its arguments, space-joined, as one line to `<plan>.args` and a line to
//! `<plan>.runs`.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "-V") {
        let version = std::env::var("SKOPOS_FAKESSH_VERSION")
            .unwrap_or_else(|_| "OpenSSH_9.6p1 fake".to_owned());
        eprintln!("{version}");
        return;
    }
    let Some(plan) = std::env::var_os("SKOPOS_FAKESSH_PLAN").map(PathBuf::from) else {
        eprintln!("skopos-fakessh: SKOPOS_FAKESSH_PLAN is not set");
        std::process::exit(2);
    };
    let run =
        std::fs::read_to_string(plan.with_extension("runs")).map_or(0, |runs| runs.lines().count());
    append(&plan.with_extension("runs"), "run\n");
    append(
        &plan.with_extension("args"),
        &format!("{}\n", args.join(" ")),
    );
    let text = std::fs::read_to_string(&plan).unwrap_or_default();
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let Some(line) = lines.get(run.min(lines.len().saturating_sub(1))) else {
        return;
    };
    let forward = args
        .windows(2)
        .find(|pair| pair[0] == "-D")
        .map(|pair| pair[1].clone());
    let mut answer: Option<String> = None;
    for step in line.split(" ; ") {
        let step = step.trim();
        let (word, rest) = step.split_once(' ').unwrap_or((step, ""));
        match word {
            "say" => eprintln!("{rest}"),
            "ask" => answer = ask(rest, None),
            "confirm" => answer = ask(rest, Some("confirm")),
            "expect" => {
                if answer.as_deref() != Some(rest) {
                    eprintln!("me@bastion: Permission denied (password).");
                    std::process::exit(255);
                }
            }
            "listen" => listen(forward.as_deref()),
            "sleep" => std::thread::sleep(Duration::from_millis(rest.parse().unwrap_or(0))),
            "exit" => std::process::exit(rest.parse().unwrap_or(255)),
            "wait" => loop {
                std::thread::sleep(Duration::from_secs(3600));
            },
            other => {
                eprintln!("skopos-fakessh: unknown step {other}");
                std::process::exit(2);
            }
        }
    }
}

fn append(path: &Path, text: &str) {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path);
    if let Ok(mut file) = file {
        let _ = file.write_all(text.as_bytes());
    }
}

/// Runs `$SSH_ASKPASS` as `ssh` does; `None` when it fails or says no.
fn ask(prompt: &str, hint: Option<&str>) -> Option<String> {
    let askpass = std::env::var_os("SSH_ASKPASS")?;
    let mut command = Command::new(askpass);
    command
        .arg(prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(hint) = hint {
        command.env("SSH_ASKPASS_PROMPT", hint);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_owned(),
    )
}

fn listen(forward: Option<&str>) {
    let Some(addr) = forward else {
        eprintln!("skopos-fakessh: no -D address");
        std::process::exit(2);
    };
    let listener = match TcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("bind [{addr}]: {e}");
            std::process::exit(255);
        }
    };
    std::thread::spawn(move || {
        for (n, client) in listener.incoming().flatten().enumerate() {
            std::thread::spawn(move || socks(client, n + 1));
        }
    });
}

/// One SOCKS5 CONNECT without authentication.
fn socks(mut client: TcpStream, channel: usize) {
    let mut head = [0u8; 2];
    if client.read_exact(&mut head).is_err() || head[0] != 5 {
        return;
    }
    let mut methods = vec![0u8; usize::from(head[1])];
    if client.read_exact(&mut methods).is_err() || client.write_all(&[5, 0]).is_err() {
        return;
    }
    let mut request = [0u8; 4];
    if client.read_exact(&mut request).is_err() || request[1] != 1 {
        return;
    }
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            if client.read_exact(&mut ip).is_err() {
                return;
            }
            Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            if client.read_exact(&mut len).is_err() {
                return;
            }
            let mut name = vec![0u8; usize::from(len[0])];
            if client.read_exact(&mut name).is_err() {
                return;
            }
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut ip = [0u8; 16];
            if client.read_exact(&mut ip).is_err() {
                return;
            }
            Ipv6Addr::from(ip).to_string()
        }
        _ => return,
    };
    let mut port = [0u8; 2];
    if client.read_exact(&mut port).is_err() {
        return;
    }
    let port = u16::from_be_bytes(port);
    let target = match TcpStream::connect((host.as_str(), port)) {
        Ok(target) => target,
        Err(e) => {
            eprintln!("channel {channel}: open failed: connect failed: {e}");
            let _ = client.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
            return;
        }
    };
    if client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).is_err() {
        return;
    }
    pipe(client, target);
}

fn pipe(client: TcpStream, target: TcpStream) {
    let (Ok(mut from_client), Ok(mut from_target)) = (client.try_clone(), target.try_clone())
    else {
        return;
    };
    let (mut to_client, mut to_target) = (client, target);
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut from_client, &mut to_target);
        let _ = to_target.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut from_target, &mut to_client);
    let _ = to_client.shutdown(Shutdown::Write);
    let _ = up.join();
}
