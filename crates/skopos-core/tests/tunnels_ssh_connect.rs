//! Clusters and the gateway through an SSH tunnel whose `ssh` is the scripted
//! `skopos-fakessh` (tunnels spec §6.1, §6.2, §6.4). Its SOCKS5 server dials the targets
//! itself, as `ssh -D` would on the far side.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use skopos_core::app_core::AppCore;
use skopos_core::cluster::{ConnectTimeouts, ConnectionState};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::ClusterSettings;
use skopos_core::secrets::Secret;
use skopos_core::tunnels::{
    SshTestHooks, TunnelInput, TunnelKind, TunnelState, TunnelTimings, TunnelView,
};
use skopos_fakekube::{FakeKube, FakeKubeConfig};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const FAKE_SSH: &str = env!("CARGO_BIN_EXE_skopos-fakessh");
const ASKPASS: &str = env!("CARGO_BIN_EXE_skopos-agent-host");
const CONTEXT: &str = "fake";
const LIMIT: Duration = Duration::from_secs(15);

struct Setup {
    core: AppCore,
    cluster: ClusterId,
    tunnel: String,
    plan: PathBuf,
    /// The API server's `host:port`.
    target: String,
    _fake: Option<FakeKube>,
    _root: TempDir,
}

/// Where the cluster's API server is.
enum Server {
    Fake,
    /// A port nothing listens on.
    Closed,
}

fn timings() -> TunnelTimings {
    TunnelTimings {
        start: Duration::from_secs(10),
        prompt: Duration::from_secs(10),
        idle: Duration::from_secs(60),
        backoff: vec![Duration::from_millis(300)],
        reconnect_wait: Duration::from_millis(500),
    }
}

fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// A core whose one cluster uses the SSH tunnel `bastion`, whose `ssh` follows `plan`.
async fn setup(plan: &[&str], server: Server) -> Setup {
    let root = tempfile::tempdir().unwrap();
    let kube = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube).unwrap();
    let (fake, target) = match server {
        Server::Fake => {
            let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
            fake.write_kubeconfig(&kube.join("config"), CONTEXT)
                .unwrap();
            let url = fake.url();
            let target = url
                .split_once("://")
                .map_or(url.clone(), |(_, rest)| rest.to_owned());
            (Some(fake), target)
        }
        Server::Closed => {
            let target = format!("127.0.0.1:{}", closed_port());
            std::fs::write(
                kube.join("config"),
                format!(
                    "apiVersion: v1\nkind: Config\nclusters:\n- {{ name: c, cluster: {{ server: \"https://{target}\" }} }}\n\
                     users:\n- {{ name: u, user: {{ token: t }} }}\n\
                     contexts:\n- {{ name: {CONTEXT}, context: {{ cluster: c, user: u }} }}\ncurrent-context: {CONTEXT}\n"
                ),
            )
            .unwrap();
            (None, target)
        }
    };
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let started = Instant::now();
    let cluster = loop {
        if let Some(entry) = core
            .catalog_list()
            .into_iter()
            .find(|e| e.context_name == CONTEXT)
        {
            break entry.id;
        }
        assert!(started.elapsed() < LIMIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let plan_file = root.path().join("plan");
    std::fs::write(&plan_file, plan.join("\n")).unwrap();
    core.set_ssh_test_hooks(SshTestHooks {
        askpass: Some(ASKPASS.into()),
        config_file: None,
        env: vec![(
            OsString::from("SKOPOS_FAKESSH_PLAN"),
            plan_file.clone().into_os_string(),
        )],
    });
    core.set_tunnel_timings_for_test(timings());
    let mut prefs = core.prefs_get();
    prefs.ssh_path = Some(FAKE_SSH.into());
    core.prefs_set(prefs).unwrap();
    let view = core
        .tunnel_save(TunnelInput {
            id: None,
            name: "bastion".into(),
            kind: TunnelKind::Ssh {
                host: "bastion".into(),
                user: None,
                port: None,
                jump: None,
                identity_file: None,
            },
        })
        .unwrap();
    core.cluster_settings_set(
        &cluster,
        ClusterSettings {
            tunnel: Some(view.id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    Setup {
        core,
        cluster,
        tunnel: view.id,
        plan: plan_file,
        target,
        _fake: fake,
        _root: root,
    }
}

impl Setup {
    fn view(&self) -> TunnelView {
        self.core
            .tunnel_list()
            .into_iter()
            .find(|t| t.id == self.tunnel)
            .unwrap()
    }

    fn runs(&self) -> usize {
        std::fs::read_to_string(self.plan.with_extension("runs")).map_or(0, |t| t.lines().count())
    }

    /// The `-D` port of the last run.
    fn port(&self) -> u16 {
        let args = std::fs::read_to_string(self.plan.with_extension("args")).unwrap();
        let last = args.lines().last().unwrap();
        let words: Vec<&str> = last.split_whitespace().collect();
        let at = words.iter().position(|w| *w == "-D").unwrap();
        words[at + 1].rsplit(':').next().unwrap().parse().unwrap()
    }

    async fn until(&self, what: &str, check: impl Fn(&TunnelView) -> bool) -> TunnelView {
        let started = Instant::now();
        loop {
            let view = self.view();
            if check(&view) {
                return view;
            }
            assert!(
                started.elapsed() < LIMIT,
                "timed out waiting for {what}: {:?}",
                view.state
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn connected(&self) {
        let state = self.core.cluster_connect(&self.cluster).await.unwrap();
        assert!(
            matches!(state, ConnectionState::Connected { .. }),
            "{state:?}"
        );
    }

    /// The gateway URL the cluster's `{id}.yaml` names.
    fn proxy_url(&self) -> url::Url {
        let path = self.core.cluster_kubeconfig_path(&self.cluster).unwrap();
        let file: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        url::Url::parse(
            file["clusters"][0]["cluster"]["proxy-url"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    }
}

/// Sends a CONNECT for `target` to the gateway and returns its status line.
async fn connect_by_hand(proxy: &url::Url, target: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port().unwrap()))
        .await
        .unwrap();
    let auth = STANDARD.encode(format!(
        "{}:{}",
        proxy.username(),
        proxy.password().unwrap()
    ));
    let head = format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: Basic {auth}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    let mut byte = [0u8; 1];
    while !answer.ends_with(b"\r\n") {
        let read = tokio::time::timeout(LIMIT, stream.read(&mut byte))
            .await
            .expect("the gateway answers")
            .unwrap();
        if read == 0 {
            break;
        }
        answer.push(byte[0]);
    }
    String::from_utf8_lossy(&answer).trim_end().to_owned()
}

fn listening(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

#[tokio::test]
async fn a_cluster_connects_through_an_ssh_tunnel() {
    let s = setup(&["listen ; wait"], Server::Fake).await;
    s.connected().await;
    assert!(s.view().state.is_up(), "{:?}", s.view().state);
    let proxy = s.proxy_url();
    assert_eq!(proxy.username(), s.tunnel);
    assert_eq!(s.runs(), 1);
}

#[tokio::test]
async fn a_connect_waits_for_the_prompt_beyond_the_connect_limit() {
    let s = setup(&["ask Password: ; expect pw ; listen ; wait"], Server::Fake).await;
    s.core.set_connect_timeouts_for_test(ConnectTimeouts {
        version: Duration::from_secs(1),
        version_exec: Duration::from_secs(1),
    });
    let (core, cluster) = (s.core.clone(), s.cluster.clone());
    let connecting = tokio::spawn(async move { core.cluster_connect(&cluster).await.unwrap() });
    let prompt = s
        .until("a prompt", |v| v.prompt.is_some())
        .await
        .prompt
        .unwrap();
    assert!(prompt.opens_at_once, "a connect is the person's action");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    s.core
        .tunnel_prompt_answer(&prompt.id, Secret::new("pw"), false)
        .unwrap();
    let state = connecting.await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "the connect limit ran while the person typed: {state:?}"
    );
}

#[tokio::test]
async fn the_gateway_answers_503_while_ssh_reconnects() {
    let s = setup(
        &[
            "listen ; sleep 1500 ; say Connection reset by 10.0.0.1 port 22 ; exit 255",
            "say ssh: connect to host bastion port 22: Connection refused ; exit 255",
        ],
        Server::Fake,
    )
    .await;
    // In use however the cluster takes its watch errors.
    let _hold = s.core.tunnel_hold_for_test(&s.tunnel);
    s.connected().await;
    s.until("reconnecting", |v| {
        matches!(v.state, TunnelState::Reconnecting { .. })
    })
    .await;
    let started = Instant::now();
    let status = connect_by_hand(&s.proxy_url(), &s.target).await;
    assert_eq!(status, "HTTP/1.1 503 Tunnel \"bastion\" is reconnecting");
    assert!(
        started.elapsed() >= Duration::from_millis(400),
        "the connection did not wait for the reconnect"
    );
}

#[tokio::test]
async fn stop_disconnects_the_clusters_and_nothing_starts_it_again() {
    let s = setup(&["listen ; wait"], Server::Fake).await;
    s.connected().await;
    let port = s.port();

    let view = s.core.tunnel_stop(&s.tunnel).await.unwrap();

    assert_eq!(view.state, TunnelState::Idle);
    assert_eq!(
        s.core.cluster_state(&s.cluster),
        ConnectionState::Disconnected
    );
    assert!(!listening(port), "ssh still runs after Stop");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(s.runs(), 1, "something started the tunnel again");
}

#[tokio::test]
async fn quitting_stops_every_ssh() {
    let s = setup(&["listen ; wait"], Server::Fake).await;
    s.connected().await;
    let port = s.port();
    s.core.shutdown().await;
    assert!(!listening(port), "ssh outlived the app");
}

#[tokio::test]
async fn test_connection_gives_the_far_sides_reason() {
    let s = setup(&["listen ; wait"], Server::Closed).await;
    let error = s.core.tunnel_test(&s.tunnel).await.unwrap_err();
    let expected = format!("ssh could not open {}: connect failed: ", s.target);
    assert!(error.message.starts_with(&expected), "{}", error.message);
    assert!(
        s.view().state.is_up(),
        "a refused target leaves the tunnel up"
    );
}
