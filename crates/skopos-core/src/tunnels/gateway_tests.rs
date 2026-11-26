//! The gateway with a core, a test proxy and an echo server (tunnels spec §5.5, §5.10).

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use skopos_fakekube::proxy::{echo_server, http_proxy, ProxyOptions, TestServer};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use url::Url;

use super::model::{TunnelInput, TunnelKind};
use super::state::TunnelState;
use crate::app_core::AppCore;
use crate::kubeconfig::ClusterId;
use crate::paths::AppPaths;
use crate::prefs::ClusterSettings;

/// A core whose catalog has one context, `ctx`, with this server.
async fn core_with_cluster(server: &str) -> (AppCore, ClusterId, TempDir) {
    let root = tempfile::tempdir().unwrap();
    let kube = root.path().join("home/.kube");
    std::fs::create_dir_all(&kube).unwrap();
    std::fs::write(
        kube.join("config"),
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- {{ name: c, cluster: {{ server: \"{server}\" }} }}\n\
             users:\n- {{ name: u, user: {{ token: t }} }}\n\
             contexts:\n- {{ name: ctx, context: {{ cluster: c, user: u }} }}\ncurrent-context: ctx\n"
        ),
    )
    .unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let started = Instant::now();
    let id = loop {
        if let Some(entry) = core
            .catalog_list()
            .into_iter()
            .find(|e| e.context_name == "ctx")
        {
            break entry.id;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "no catalog entry"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    (core, id, root)
}

struct Setup {
    core: AppCore,
    tunnel: super::model::TunnelDef,
    echo: TestServer,
    proxy: skopos_fakekube::proxy::TestProxy,
    _root: TempDir,
}

/// A cluster whose server is an echo server, using a tunnel through an HTTP test proxy.
async fn setup(options: ProxyOptions) -> Setup {
    let echo = echo_server().await;
    let proxy = http_proxy(options).await;
    let (core, id, root) =
        core_with_cluster(&format!("https://127.0.0.1:{}", echo.addr.port())).await;
    let view = core
        .tunnel_save(TunnelInput {
            id: None,
            name: "corp".into(),
            kind: TunnelKind::Proxy {
                url: format!("http://{}", proxy.addr),
                username: None,
            },
        })
        .unwrap();
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            tunnel: Some(view.id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let tunnel = core.tunnel_def(&view.id).unwrap();
    Setup {
        core,
        tunnel,
        echo,
        proxy,
        _root: root,
    }
}

/// Sends a CONNECT to the gateway of `url` and returns the stream and the status line.
async fn connect(url: &str, target: &str, password: Option<&str>) -> (TcpStream, String) {
    let parsed = Url::parse(url).unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", parsed.port().unwrap()))
        .await
        .unwrap();
    let token = password.unwrap_or_else(|| parsed.password().unwrap());
    let auth = STANDARD.encode(format!("{}:{token}", parsed.username()));
    let head = format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: Basic {auth}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let head = super::http::read_head(&mut stream, 8192).await.unwrap();
    (stream, head.lines().next().unwrap().to_owned())
}

#[tokio::test]
async fn the_gateway_carries_an_allowed_target_through_the_proxy() {
    let s = setup(ProxyOptions::default()).await;
    let url = s.core.tunnel_url(&s.tunnel).unwrap();
    let target = format!("127.0.0.1:{}", s.echo.addr.port());
    let (mut stream, status) = connect(url.expose(), &target, None).await;
    assert_eq!(status, "HTTP/1.1 200 Connection established");
    stream.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");
    assert_eq!(s.proxy.seen.targets(), [target]);
    assert_eq!(s.core.tunnel_state(&s.tunnel.id), TunnelState::Up);
}

#[tokio::test]
async fn a_wrong_token_gets_407_and_another_target_403() {
    let s = setup(ProxyOptions::default()).await;
    let url = s.core.tunnel_url(&s.tunnel).unwrap();
    let allowed = format!("127.0.0.1:{}", s.echo.addr.port());
    let (_, status) = connect(url.expose(), &allowed, Some("wrong")).await;
    assert_eq!(status, "HTTP/1.1 407 Proxy Authentication Required");
    let (_, status) = connect(url.expose(), "10.0.0.1:443", None).await;
    assert_eq!(status, "HTTP/1.1 403 Forbidden");
    assert!(s.proxy.seen.targets().is_empty());
}

#[tokio::test]
async fn a_failed_dial_puts_the_reason_in_the_status_line_and_the_state() {
    let s = setup(ProxyOptions {
        refuse_with: Some("403 Forbidden by policy".into()),
        ..Default::default()
    })
    .await;
    let url = s.core.tunnel_url(&s.tunnel).unwrap();
    let target = format!("127.0.0.1:{}", s.echo.addr.port());
    let (_, status) = connect(url.expose(), &target, None).await;
    assert_eq!(
        status,
        "HTTP/1.1 502 Tunnel \"corp\": the proxy answered 403 Forbidden by policy"
    );
    assert_eq!(
        s.core.tunnel_state(&s.tunnel.id),
        TunnelState::Failed {
            message: "the proxy answered 403 Forbidden by policy".into()
        }
    );
}

#[tokio::test]
async fn a_deleted_tunnel_token_gets_407() {
    let s = setup(ProxyOptions::default()).await;
    let url = s.core.tunnel_url(&s.tunnel).unwrap();
    s.core.tunnel_delete(&s.tunnel.id).unwrap();
    let target = format!("127.0.0.1:{}", s.echo.addr.port());
    let (_, status) = connect(url.expose(), &target, None).await;
    assert_eq!(status, "HTTP/1.1 407 Proxy Authentication Required");
}

#[tokio::test]
async fn stop_ends_open_connections_and_test_reports_the_state() {
    let s = setup(ProxyOptions::default()).await;
    let url = s.core.tunnel_url(&s.tunnel).unwrap();
    let target = format!("127.0.0.1:{}", s.echo.addr.port());
    let (mut stream, _) = connect(url.expose(), &target, None).await;
    let view = s.core.tunnel_stop(&s.tunnel.id).unwrap();
    assert_eq!(view.state, TunnelState::Idle);
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut rest))
        .await
        .expect("Stop closes the connection")
        .unwrap();
    let view = s.core.tunnel_test(&s.tunnel.id).await.unwrap();
    assert_eq!(view.state, TunnelState::Up);
}

#[tokio::test]
async fn the_gateway_url_keeps_its_port_and_each_tunnel_its_token() {
    let s = setup(ProxyOptions::default()).await;
    let first = Url::parse(s.core.tunnel_url(&s.tunnel).unwrap().expose()).unwrap();
    let again = Url::parse(s.core.tunnel_url(&s.tunnel).unwrap().expose()).unwrap();
    assert_eq!(first, again);
    assert_eq!(first.host_str(), Some("127.0.0.1"));
    assert_eq!(first.username(), s.tunnel.id);
    assert_eq!(first.password().map(str::len), Some(32));
}
