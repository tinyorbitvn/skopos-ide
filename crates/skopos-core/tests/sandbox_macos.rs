//! The macOS sandbox's rules (spec §6.1, §6.2, §6.6), through `sandbox-exec` and the chat's
//! Seatbelt profile, with `skopos-agent-host` standing in for the app binary (R1). Each test runs
//! a probe as the agent. They run only with `SKOPOS_SANDBOX_TEST=1` (CI sets it) and skip
//! otherwise.
#![cfg(target_os = "macos")]

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, UdpSocket};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use skopos_core::agents::endpoint::{Endpoint, Listen};
use skopos_core::agents::proxy::{self, ProxyConfig, Resolver};
use skopos_core::agents::registry::AgentSpec;
use skopos_core::agents::sandbox::env::{agent_env, proxy_url};
use skopos_core::agents::sandbox::paths::{kubeconfig_files, real_path};
use skopos_core::agents::sandbox::{
    build_spec, sandbox_command, sandbox_status, ChatPorts, SandboxKind, SandboxSpec,
    SandboxStatus, SpecInput,
};
use skopos_core::kubeconfig::SyncSource;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

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

/// Whether to run: only with `SKOPOS_SANDBOX_TEST=1`, and then Seatbelt must work.
async fn enabled() -> bool {
    if std::env::var("SKOPOS_SANDBOX_TEST").as_deref() != Ok("1") {
        eprintln!("skipped: set SKOPOS_SANDBOX_TEST=1");
        return false;
    }
    assert_eq!(
        sandbox_status().await,
        SandboxStatus::Ready {
            kind: SandboxKind::Seatbelt
        },
        "Seatbelt cannot start a sandbox here"
    );
    true
}

fn text(path: impl AsRef<Path>) -> String {
    path.as_ref().display().to_string()
}

/// A person's machine in miniature: a home with a `.kube` folder, an SSH key and the agent's
/// settings; a kubeconfig and a folder outside home; the agent's folder; a run folder; and the
/// chat's two listeners, whose ports the profile allows.
struct Machine {
    _root: tempfile::TempDir,
    home: PathBuf,
    outside: PathBuf,
    agent_dir: PathBuf,
    run_dir: PathBuf,
    proxy: TcpListener,
    mcp: TcpListener,
    ports: ChatPorts,
}

fn machine() -> Machine {
    let root = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let base = real_path(root.path());
    let home = base.join("home");
    let outside = base.join("outside");
    let agent_dir = base.join("data/agents/work/probe");
    let run_dir = base.join("data/agents/run/0a1b2c3d");
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
    std::fs::create_dir_all(run_dir.join("tmp")).unwrap();
    let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
    let mcp = TcpListener::bind("127.0.0.1:0").unwrap();
    let ports = ChatPorts {
        proxy: proxy.local_addr().unwrap().port(),
        mcp: mcp.local_addr().unwrap().port(),
    };
    Machine {
        _root: root,
        home,
        outside,
        agent_dir,
        run_dir,
        proxy,
        mcp,
        ports,
    }
}

impl Machine {
    /// The sandbox of an agent running `program` with `args`: its settings folder, the folder
    /// outside home, the home `.kube` folder and the outside kubeconfig as the app's sources,
    /// and only `PATH` from the app's environment.
    fn spec(&self, program: &str, args: Vec<String>) -> SandboxSpec {
        self.spec_with(program, args, vec![self.outside.join("folder")])
    }

    /// `spec` with `folders` as the person's folders.
    fn spec_with(&self, program: &str, args: Vec<String>, folders: Vec<PathBuf>) -> SandboxSpec {
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
            path_dirs: Vec::new(),
            custom: true,
        };
        let path = std::env::var("PATH").ok();
        let get = move |name: &str| if name == "PATH" { path.clone() } else { None };
        let env = agent_env(
            &get,
            &agent,
            &proxy_url("proxy-token", self.ports.proxy),
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
            folders,
            kubeconfigs,
            app_binary: PathBuf::from(APP),
            path_var: std::env::var_os("PATH"),
            env,
        })
    }

    /// The sandbox of an agent running `sh -c <script>` with `args` as `$1` onward.
    fn probe(&self, script: &str, args: &[String]) -> SandboxSpec {
        self.spec("/bin/sh", sh_words(script, args))
    }

    /// Runs `spec`'s agent in its sandbox with this machine's chat ports and gives its exit
    /// code and stdout; stderr goes to the test's output.
    async fn run(&self, spec: &SandboxSpec) -> (Option<i32>, String) {
        let mut command = sandbox_command(spec, self.ports).unwrap();
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
    let (code, stdout) = machine.run(&machine.probe(PRINT_EACH, &files)).await;
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
    let (code, stdout) = machine.run(&spec).await;
    assert_eq!(code, Some(0));
    assert_eq!(
        stdout.lines().collect::<Vec<_>>(),
        [
            format!("{}=refused", files[0]),
            format!("{}=notes", files[1]),
            format!("{}=readme", files[2]),
        ]
    );
}

/// `sh -c <script>` with `args` as `$1` onward, as the agent's arguments.
fn sh_words(script: &str, args: &[String]) -> Vec<String> {
    let mut words = vec!["-c".to_owned(), script.to_owned(), "probe".to_owned()];
    words.extend_from_slice(args);
    words
}

#[tokio::test]
async fn a_kubeconfig_in_a_folder_reached_through_a_link_stays_hidden() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    // A link the home's cover hides, and one outside home that shows as it is; both absolute.
    let link = machine.home.join("kube-link");
    let shown = machine.outside.join("kube-shown");
    for at in [&link, &shown] {
        std::os::unix::fs::symlink(machine.outside.join("kube"), at).unwrap();
    }
    let files: Vec<String> = [
        link.join("config"),
        link.join("notes.txt"),
        machine.outside.join("kube/config"),
        shown.join("config"),
    ]
    .iter()
    .map(text)
    .collect();
    let folders = vec![link.clone(), shown.clone()];
    let spec = machine.spec_with("/bin/sh", sh_words(PRINT_EACH, &files), folders);
    let (code, stdout) = machine.run(&spec).await;
    assert_eq!(code, Some(0));
    // Through either link and at its real path, the kubeconfig is covered; the file beside it
    // reads.
    assert_eq!(
        stdout.lines().collect::<Vec<_>>(),
        [
            format!("{}=refused", files[0]),
            format!("{}=notes", files[1]),
            format!("{}=refused", files[2]),
            format!("{}=refused", files[3]),
        ]
    );
}

#[tokio::test]
async fn the_agent_cannot_read_the_shared_or_its_persons_temporary_folders() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let folder = |name: &str| {
        let output = std::process::Command::new("/usr/bin/getconf")
            .arg(name)
            .output()
            .unwrap();
        let path = String::from_utf8(output.stdout).unwrap();
        tempfile::tempdir_in(path.trim()).unwrap()
    };
    let shared = tempfile::tempdir_in("/private/tmp").unwrap();
    let personal = folder("DARWIN_USER_TEMP_DIR");
    let user = folder("DARWIN_USER_DIR");
    let own = machine.run_dir.join("tmp");
    let mut files = Vec::new();
    for dir in [shared.path(), personal.path(), user.path(), own.as_path()] {
        let file = dir.join("note.txt");
        std::fs::write(&file, "note").unwrap();
        files.push(text(file));
    }
    let (code, stdout) = machine.run(&machine.probe(PRINT_EACH, &files)).await;
    assert_eq!(code, Some(0));
    // The chat's own temporary folder reads as usual.
    assert_eq!(
        stdout.lines().collect::<Vec<_>>(),
        [
            format!("{}=refused", files[0]),
            format!("{}=refused", files[1]),
            format!("{}=refused", files[2]),
            format!("{}=note", files[3]),
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
    let (code, stdout) = machine.run(&machine.probe(WRITE_EACH, &args)).await;
    assert_eq!(code, Some(0));
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        lines[..5],
        [
            format!("wrote {}", args[0]),
            format!("wrote {}", args[1]),
            format!("refused {}", args[2]),
            format!("refused {}", args[3]),
            format!("refused {}", args[4]),
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

/// Claude Code keeps its temporary files in `claude-<uid>` under `CLAUDE_CODE_TMPDIR`, else
/// under `/tmp`, where the person's own Claude Code may have made that folder already: there
/// `mkdir` fails, since the agent may not see the folder. In the chat's own folder it works.
#[tokio::test]
async fn claude_codes_temporary_folder_is_made_in_the_chats_own() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    // Stands in for the `/tmp/claude-<uid>` of the person's own Claude Code.
    let persons = tempfile::tempdir_in("/private/tmp").unwrap();
    let script = r#"if mkdir -p "$1" 2>/dev/null; then echo "shared made"; else echo "shared refused"; fi
own="$CLAUDE_CODE_TMPDIR/claude-test"
mkdir -p "$own" && echo note > "$own/note" && echo "own made $own""#;
    let (code, stdout) = machine
        .run(&machine.probe(script, &[text(persons.path())]))
        .await;
    assert_eq!(code, Some(0));
    let own = machine.run_dir.join("tmp/claude-test");
    assert_eq!(
        stdout.lines().collect::<Vec<_>>(),
        [
            "shared refused".to_owned(),
            format!("own made {}", text(&own))
        ]
    );
    assert_eq!(std::fs::read_to_string(own.join("note")).unwrap(), "note\n");
}

/// Every item of the login keychain that `/usr/bin/security` made opens to any process that
/// runs it and reads the keychain's file, such as another CLI's token. The agent may not read
/// the keychains; the app hands Claude its own sign-in instead.
#[tokio::test]
async fn the_agent_cannot_read_the_keychains() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let keychain = machine.home.join("Library/Keychains/login.keychain-db");
    std::fs::create_dir_all(keychain.parent().unwrap()).unwrap();
    std::fs::write(&keychain, "keychain").unwrap();
    let read = [text(&keychain)];
    let (code, stdout) = machine.run(&machine.probe(PRINT_EACH, &read)).await;
    assert_eq!(code, Some(0));
    assert_eq!(
        stdout.lines().collect::<Vec<_>>(),
        [format!("{}=refused", read[0])]
    );
}

#[tokio::test]
async fn the_agent_cannot_connect_to_a_unix_socket_of_the_host() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let socket = machine.outside.join("host.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let script = r#"nc -U -w 2 "$1" </dev/null; echo "rc=$?""#;
    let (code, stdout) = machine.run(&machine.probe(script, &[text(&socket)])).await;
    assert_eq!(code, Some(0));
    assert!(stdout.starts_with("rc=") && stdout != "rc=0\n", "{stdout}");
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().map(|_| ()).unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn the_agent_reaches_both_chat_ports_and_no_other_local_port() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let other = TcpListener::bind("127.0.0.1:0").unwrap();
    let other_port = other.local_addr().unwrap().port();
    let mut endpoints = Vec::new();
    for (name, listener) in [("proxy", &machine.proxy), ("mcp", &machine.mcp)] {
        let endpoint = listener.try_clone().unwrap();
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
    let script = r#"for port in "$2" "$3" "$4"; do
  printf 'ping\n' | SKOPOS_AGENT_TOKEN="tok-$port" "$1" --agent-mcp "127.0.0.1:$port"
  echo "rc=$?"
done"#;
    let args = [
        APP.to_owned(),
        machine.ports.proxy.to_string(),
        machine.ports.mcp.to_string(),
        other_port.to_string(),
    ];
    let (code, stdout) = machine.run(&machine.probe(script, &args)).await;
    assert_eq!(code, Some(0));
    assert_eq!(stdout, "pong from proxy\nrc=0\npong from mcp\nrc=0\nrc=1\n");
    let heard: Vec<(String, String)> = endpoints
        .into_iter()
        .map(|endpoint| endpoint.join().unwrap())
        .collect();
    assert_eq!(
        heard,
        [
            (
                format!("tok-{}\n", machine.ports.proxy),
                "ping\n".to_owned()
            ),
            (format!("tok-{}\n", machine.ports.mcp), "ping\n".to_owned()),
        ]
    );
    other.set_nonblocking(true).unwrap();
    assert_eq!(
        other.accept().map(|_| ()).unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn the_agent_environment_holds_only_the_given_pairs() {
    if !enabled().await {
        return;
    }
    let machine = machine();
    let spec = machine.spec("/usr/bin/env", Vec::new());
    let (code, stdout) = machine.run(&spec).await;
    assert_eq!(code, Some(0));
    let mut seen: BTreeMap<String, String> = stdout
        .lines()
        .map(|line| {
            let (name, value) = line.split_once('=').unwrap();
            (name.to_owned(), value.to_owned())
        })
        .collect();
    if let Some(folder) = seen.remove("PWD") {
        assert_eq!(folder, text(&machine.agent_dir));
    }
    let given: BTreeMap<String, String> = spec.env.iter().cloned().collect();
    assert_eq!(seen, given);
    assert_eq!(given.get("PROBE_SETTING").map(String::as_str), Some("on"));
    assert_eq!(given.get("HOME"), Some(&text(&machine.home)));
}

/// The token of the proxy URL `Machine::spec` gives the agent.
const PROXY_TOKEN: &str = "proxy-token";
/// The name the chat's proxy allows, and one off its list.
const ALLOWED: &str = "api.example.com";
const ELSEWHERE: &str = "elsewhere.example.org";
/// The proxy's answers to an allowed and to a refused `CONNECT`.
const ESTABLISHED: &str = "HTTP/1.1 200 Connection established\r\n\r\n";
const FORBIDDEN: &str = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
/// Tries `$1:$2` directly and prints `direct rc=<nc's exit code>`; then, for each name from
/// `$3` on, asks the proxy `$HTTPS_PROXY` names for a tunnel to its port 443 and prints
/// `== <name>` and the raw answer up to the close.
const CONNECT_EACH: &str = r#"login=${HTTPS_PROXY#http://}
login=${login%@*}
address=${HTTPS_PROXY##*@}
auth=$(printf %s "$login" | base64)
nc -w 5 "$1" "$2" </dev/null >/dev/null 2>&1
echo "direct rc=$?"
shift 2
for name in "$@"; do
  echo "== $name"
  printf 'CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\nProxy-Authorization: Basic %s\r\n\r\n' \
    "$name" "$name" "$auth" | nc -w 5 "${address%:*}" "${address##*:}"
  echo
done"#;

/// The address this machine would send from, found without sending anything: connecting a
/// UDP socket only picks a route. `None` when there is none, or only one the proxy refuses.
fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if proxy::address_allowed(IpAddr::V4(ip)) => Some(ip),
        _ => None,
    }
}

#[tokio::test]
async fn a_sandboxed_agent_reaches_an_allowed_host_only_through_the_proxy() {
    if !enabled().await {
        return;
    }
    let Some(ip) = local_ipv4() else {
        eprintln!("skipped: this machine has no non-loopback IPv4 address");
        return;
    };
    let mut machine = machine();
    // The chat's proxy, on a port that becomes the chat's proxy port: the profile allows it,
    // and the agent's proxy URL names it.
    let endpoint = Endpoint::bind(Listen::Tcp).await.unwrap();
    machine.ports.proxy = endpoint.port().expect("a TCP endpoint has a port");
    // The allowed host's stand-in: it answers each connection with `pong` and closes it.
    let server = tokio::net::TcpListener::bind((ip, 0)).await.unwrap();
    let server_port = server.local_addr().unwrap().port();
    let (accepted, mut connections) = mpsc::unbounded_channel();
    let serving = tokio::spawn(async move {
        while let Ok((mut stream, _)) = server.accept().await {
            let _ = stream.write_all(b"pong").await;
            let _ = accepted.send(());
        }
    });
    let config = ProxyConfig {
        token: PROXY_TOKEN.to_owned(),
        hosts: vec![ALLOWED.to_owned()],
        resolve: Resolver::Fixed(HashMap::from([(ALLOWED.to_owned(), vec![IpAddr::V4(ip)])])),
    };
    let (reports, mut blocked) = mpsc::channel(16);
    let cancel = CancellationToken::new();
    let proxying = tokio::spawn(proxy::serve_for_test(
        endpoint,
        config,
        reports,
        cancel.clone(),
        server_port,
    ));

    let args = [
        ip.to_string(),
        server_port.to_string(),
        ALLOWED.to_owned(),
        ELSEWHERE.to_owned(),
        ELSEWHERE.to_owned(),
    ];
    let (code, stdout) = machine.run(&machine.probe(CONNECT_EACH, &args)).await;
    cancel.cancel();
    proxying.await.unwrap();
    serving.abort();

    // The profile refuses the server's address; the proxy tunnels to it for the allowed name only.
    let (direct, answers) = stdout.split_once('\n').unwrap_or_default();
    assert!(
        direct.starts_with("direct rc=") && direct != "direct rc=0",
        "{stdout}"
    );
    assert_eq!(
        answers,
        format!(
            "== {ALLOWED}\n{ESTABLISHED}pong\n\
             == {ELSEWHERE}\n{FORBIDDEN}\n== {ELSEWHERE}\n{FORBIDDEN}\n"
        )
    );
    assert_eq!(code, Some(0));
    assert_eq!(blocked.try_recv().ok().as_deref(), Some(ELSEWHERE));
    assert!(
        blocked.try_recv().is_err(),
        "a refused name is reported once"
    );
    let mut tunnels = 0;
    while connections.try_recv().is_ok() {
        tunnels += 1;
    }
    assert_eq!(tunnels, 1, "only the proxy's tunnel reached the server");
}
