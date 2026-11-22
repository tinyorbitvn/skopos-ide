//! The Linux sandbox's rules (spec §6.1, §6.2, §6.6), through bubblewrap and the app binary's
//! `--agent-init`, with `skopos-agent-host` standing in for the app binary (R1). Each test runs a
//! probe as the agent. They need a bubblewrap that can start a sandbox, so they run only with
//! `SKOPOS_SANDBOX_TEST=1` (CI sets it) and skip otherwise.
#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use skopos_core::agents::registry::AgentSpec;
use skopos_core::agents::sandbox::env::{agent_env, proxy_url};
use skopos_core::agents::sandbox::paths::{kubeconfig_files, real_path};
use skopos_core::agents::sandbox::spec::{MCP_SOCKET, PROXY_SOCKET};
use skopos_core::agents::sandbox::{
    build_spec, sandbox_command, sandbox_status, ChatPorts, SandboxKind, SandboxSpec,
    SandboxStatus, SpecInput,
};
use skopos_core::kubeconfig::SyncSource;

/// Stands in for the app binary.
const APP: &str = env!("CARGO_BIN_EXE_skopos-agent-host");
/// Prints `<file>=<its text>` for each file given, or `<file>=refused` when it cannot be read.
const PRINT_EACH: &str =
    r#"for f in "$@"; do printf '%s=' "$f"; cat "$f" 2>/dev/null || printf refused; echo; done"#;
/// Prints `wrote <file>` or `refused <file>` for each file given, then the file `mktemp` made.
const WRITE_EACH: &str = r#"for f in "$@"; do
  if (echo written > "$f") 2>/dev/null; then echo "wrote $f"; else echo "refused $f"; fi
done
t=$(mktemp) && echo "tmp $t""#;
/// Tries a Unix socket (the exit code is 100 and the errno when it fails), an inet socket and a
/// socket pair, then prints the filter mode the agent's children run under.
const SOCKETS: &str = r#"python3 -c '
import socket, sys
try:
    socket.socket(socket.AF_UNIX)
except OSError as error:
    sys.exit(100 + error.errno)
'
echo "unix=$?"
python3 -c 'import socket; socket.socket(socket.AF_INET)'
echo "inet=$?"
python3 -c 'import socket; socket.socketpair()'
echo "pair=$?"
grep "^Seccomp:" /proc/self/status"#;

/// Whether to run: only with `SKOPOS_SANDBOX_TEST=1`, and then bubblewrap must work.
async fn enabled() -> bool {
    if std::env::var("SKOPOS_SANDBOX_TEST").as_deref() != Ok("1") {
        eprintln!("skipped: set SKOPOS_SANDBOX_TEST=1");
        return false;
    }
    assert_eq!(
        sandbox_status().await,
        SandboxStatus::Ready {
            kind: SandboxKind::Bubblewrap
        },
        "bubblewrap cannot start a sandbox here"
    );
    true
}

fn text(path: impl AsRef<Path>) -> String {
    path.as_ref().display().to_string()
}

/// A person's machine in miniature: a home with a `.kube` folder, an SSH key and the agent's
/// settings; a kubeconfig and a folder outside home; the agent's folder; a run folder.
struct Machine {
    _root: tempfile::TempDir,
    _run: tempfile::TempDir,
    home: PathBuf,
    outside: PathBuf,
    agent_dir: PathBuf,
    run_dir: PathBuf,
}

fn machine() -> Machine {
    let root = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let base = real_path(root.path());
    let home = base.join("home");
    let outside = base.join("outside");
    let agent_dir = base.join("data/agents/work/probe");
    for (path, contents) in [
        (home.join(".kube/config"), "home kubeconfig"),
        (home.join(".kube/other.yaml"), "other kubeconfig"),
        (home.join(".ssh/id_ed25519"), "ssh key"),
        (home.join(".probe-settings/settings.json"), "{}"),
        (outside.join("kube/config"), "outside kubeconfig"),
        (outside.join("kube/notes.txt"), "notes"),
        (outside.join("folder/readme.txt"), "readme"),
    ] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    std::fs::create_dir_all(&agent_dir).unwrap();
    let run = tempfile::Builder::new()
        .prefix("skopos-run-")
        .tempdir()
        .unwrap();
    let run_dir = real_path(run.path());
    std::fs::create_dir_all(run_dir.join("tmp")).unwrap();
    Machine {
        _root: root,
        _run: run,
        home,
        outside,
        agent_dir,
        run_dir,
    }
}

impl Machine {
    /// The sandbox of an agent running `program` with `args`: its settings folder, the folder
    /// outside home, the home `.kube` folder and the outside kubeconfig as the app's sources,
    /// and only `PATH` from the app's environment.
    fn spec(&self, program: &str, args: Vec<String>) -> SandboxSpec {
        let agent = AgentSpec {
            id: "probe".to_owned(),
            name: "Probe".to_owned(),
            program: PathBuf::from(program),
            args,
            env: vec![("PROBE_SETTING".to_owned(), "on".to_owned())],
            detail: String::new(),
            settings: vec![
                self.home.join(".probe-settings"),
                self.home.join(".probe-missing"),
            ],
            hosts: Vec::new(),
            key_vars: vec!["PROBE_API_KEY".to_owned()],
            install_paths: vec![PathBuf::from(program)],
            custom: true,
        };
        let path = std::env::var("PATH").ok();
        let get = move |name: &str| if name == "PATH" { path.clone() } else { None };
        let env = agent_env(
            &get,
            &agent,
            &proxy_url("proxy-token", ChatPorts::LINUX_SANDBOX.proxy),
            &self.run_dir.join("tmp"),
            &self.home,
        );
        let kubeconfigs = kubeconfig_files(
            &[
                SyncSource::Dir(text(self.home.join(".kube"))),
                SyncSource::File(text(self.outside.join("kube/config"))),
            ],
            &[],
            None,
        );
        build_spec(SpecInput {
            agent: &agent,
            agent_dir: self.agent_dir.clone(),
            run_dir: self.run_dir.clone(),
            home: &self.home,
            folders: vec![self.outside.join("folder")],
            kubeconfigs,
            app_binary: PathBuf::from(APP),
            path_var: std::env::var_os("PATH"),
            env,
        })
    }

    /// The sandbox of an agent running `sh -c <script>` with `args` as `$1` onward.
    fn probe(&self, script: &str, args: &[String]) -> SandboxSpec {
        let mut words = vec!["-c".to_owned(), script.to_owned(), "probe".to_owned()];
        words.extend_from_slice(args);
        self.spec("/bin/sh", words)
    }
}

/// Runs `spec`'s agent in its sandbox and gives its exit code and stdout; stderr goes to the
/// test's output.
async fn run(spec: &SandboxSpec) -> (Option<i32>, String) {
    let mut command = sandbox_command(spec, ChatPorts::LINUX_SANDBOX).unwrap();
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .expect("the sandbox ran for over 60 s")
        .unwrap();
    eprintln!("{}", String::from_utf8_lossy(&output.stderr));
    (
        output.status.code(),
        String::from_utf8(output.stdout).unwrap(),
    )
}

#[tokio::test]
async fn the_agent_cannot_read_a_file_under_the_home_kube_folder() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let files: Vec<String> = [
        ".kube/config",
        ".kube/other.yaml",
        ".ssh/id_ed25519",
        ".probe-settings/settings.json",
    ]
    .iter()
    .map(|name| text(machine.home.join(name)))
    .collect();
    let (code, stdout) = run(&machine.probe(PRINT_EACH, &files)).await;
    assert_eq!(code, Some(0));
    assert_eq!(
        stdout.lines().collect::<Vec<_>>(),
        [
            format!("{}=refused", files[0]),
            format!("{}=refused", files[1]),
            format!("{}=refused", files[2]),
            format!("{}={{}}", files[3]),
        ]
    );
}

#[tokio::test]
async fn the_agent_cannot_read_a_kubeconfig_outside_home() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let files: Vec<String> = ["kube/config", "kube/notes.txt", "folder/readme.txt"]
        .iter()
        .map(|name| text(machine.outside.join(name)))
        .collect();
    let spec = machine.probe(PRINT_EACH, &files);
    assert_eq!(spec.hidden_files, [machine.outside.join("kube/config")]);
    let (code, stdout) = run(&spec).await;
    assert_eq!(code, Some(0));
    // The kubeconfig reads as empty; the file beside it and the person's folder read as usual.
    assert_eq!(
        stdout.lines().collect::<Vec<_>>(),
        [
            format!("{}=", files[0]),
            format!("{}=notes", files[1]),
            format!("{}=readme", files[2]),
        ]
    );
}

#[tokio::test]
async fn the_agent_cannot_write_outside_its_folder() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let files = [
        machine.agent_dir.join("inside.txt"),
        machine.home.join(".probe-settings/new.json"),
        machine.outside.join("folder/written.txt"),
        machine.outside.join("written.txt"),
        machine.home.join("written.txt"),
    ];
    let args: Vec<String> = files.iter().map(text).collect();
    let (code, stdout) = run(&machine.probe(WRITE_EACH, &args)).await;
    assert_eq!(code, Some(0));
    let lines: Vec<&str> = stdout.lines().collect();
    // A write elsewhere under home lands in the sandbox's own home and is lost with it.
    assert_eq!(
        lines[..5],
        [
            format!("wrote {}", args[0]),
            format!("wrote {}", args[1]),
            format!("refused {}", args[2]),
            format!("refused {}", args[3]),
            format!("wrote {}", args[4]),
        ]
    );
    let tmp_dir = machine.run_dir.join("tmp");
    assert!(
        lines[5].starts_with(&format!("tmp {}/", text(&tmp_dir))),
        "{stdout}"
    );
    assert!(files[0].exists() && files[1].exists());
    assert!(!files[2].exists() && !files[3].exists() && !files[4].exists());
    assert_eq!(std::fs::read_dir(&tmp_dir).unwrap().count(), 1);
}

#[tokio::test]
async fn the_agent_cannot_connect_to_a_tcp_listener_of_the_host() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let script = r#"SKOPOS_AGENT_TOKEN=t "$1" --agent-mcp "127.0.0.1:$2" </dev/null; echo "rc=$?""#;
    let (code, stdout) = run(&machine.probe(script, &[APP.to_owned(), port.to_string()])).await;
    assert_eq!(code, Some(0));
    assert_eq!(stdout, "rc=1\n");
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().map(|_| ()).unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn the_agent_cannot_create_a_unix_socket() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let (code, stdout) = run(&machine.probe(SOCKETS, &[])).await;
    assert_eq!(code, Some(0));
    // `unix=101` is EPERM; a missing python3 shows as 127.
    assert_eq!(
        stdout, "unix=101\ninet=0\npair=0\nSeccomp:\t2\n",
        "python3 is needed"
    );
}

#[tokio::test]
async fn the_agent_reaches_both_chat_ports_through_the_host_sockets() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let mut endpoints = Vec::new();
    for (name, socket) in [("proxy", PROXY_SOCKET), ("mcp", MCP_SOCKET)] {
        let endpoint = UnixListener::bind(machine.run_dir.join(socket)).unwrap();
        endpoints.push(std::thread::spawn(move || {
            let (stream, _) = endpoint.accept().unwrap();
            let mut reader = BufReader::new(&stream);
            let (mut token, mut request) = (String::new(), String::new());
            reader.read_line(&mut token).unwrap();
            reader.read_line(&mut request).unwrap();
            (&stream)
                .write_all(format!("pong from {name}\n").as_bytes())
                .unwrap();
            (token, request)
        }));
    }
    let script = r#"for port in 3128 3129; do
  printf 'ping\n' | SKOPOS_AGENT_TOKEN="tok-$port" "$1" --agent-mcp "127.0.0.1:$port"
  echo "rc=$?"
done"#;
    let (code, stdout) = run(&machine.probe(script, &[APP.to_owned()])).await;
    assert_eq!(code, Some(0));
    assert_eq!(stdout, "pong from proxy\nrc=0\npong from mcp\nrc=0\n");
    let heard: Vec<(String, String)> = endpoints
        .into_iter()
        .map(|endpoint| endpoint.join().unwrap())
        .collect();
    assert_eq!(
        heard,
        [
            ("tok-3128\n".to_owned(), "ping\n".to_owned()),
            ("tok-3129\n".to_owned(), "ping\n".to_owned()),
        ]
    );
}

#[tokio::test]
async fn the_agent_environment_holds_only_the_given_pairs() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let spec = machine.spec("/usr/bin/env", Vec::new());
    let (code, stdout) = run(&spec).await;
    assert_eq!(code, Some(0));
    let mut seen: BTreeMap<String, String> = stdout
        .lines()
        .map(|line| {
            let (name, value) = line.split_once('=').unwrap();
            (name.to_owned(), value.to_owned())
        })
        .collect();
    // bubblewrap may name the folder it changed to.
    if let Some(folder) = seen.remove("PWD") {
        assert_eq!(folder, text(&machine.agent_dir));
    }
    let given: BTreeMap<String, String> = spec.env.iter().cloned().collect();
    assert_eq!(seen, given);
    assert_eq!(given.get("PROBE_SETTING").map(String::as_str), Some("on"));
    assert_eq!(given.get("HOME"), Some(&text(&machine.home)));
}
