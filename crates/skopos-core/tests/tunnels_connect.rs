//! Connects through a proxy tunnel (tunnels spec §5.7, §5.10).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::{ConnectionState, FailureKind};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::ClusterSettings;
use skopos_core::secrets::Secret;
use skopos_core::tunnels::{TunnelInput, TunnelKind, TunnelState};
use skopos_fakekube::proxy::{http_proxy, socks5_proxy, ProxyOptions};
use skopos_fakekube::{FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;

const CONTEXT: &str = "fake";
const LIMIT: Duration = Duration::from_secs(5);

fn paths_in(root: &TempDir) -> AppPaths {
    AppPaths::under(&root.path().join("app"), &root.path().join("home"))
}

fn kube_config(root: &TempDir) -> PathBuf {
    let dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("config")
}

async fn wait_until<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let started = Instant::now();
    while !check().await {
        assert!(started.elapsed() < LIMIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn start(root: &TempDir) -> (AppCore, ClusterId) {
    let core = AppCore::start_with_kubeconfig_env(paths_in(root), None)
        .await
        .unwrap();
    wait_until("the catalog entry", || async {
        core.catalog_list()
            .iter()
            .any(|e| e.context_name == CONTEXT)
    })
    .await;
    let id = core
        .catalog_list()
        .into_iter()
        .find(|e| e.context_name == CONTEXT)
        .unwrap()
        .id;
    (core, id)
}

async fn fake_core() -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    fake.write_kubeconfig(&kube_config(&root), CONTEXT).unwrap();
    let (core, id) = start(&root).await;
    (core, fake, id, root)
}

/// Saves a proxy tunnel and makes the cluster use it. Returns the tunnel's id.
fn use_tunnel(core: &AppCore, id: &ClusterId, url: &str, username: Option<&str>) -> String {
    let view = core
        .tunnel_save(TunnelInput {
            id: None,
            name: "corp".into(),
            kind: TunnelKind::Proxy {
                url: url.into(),
                username: username.map(Into::into),
            },
        })
        .unwrap();
    core.cluster_settings_set(
        id,
        ClusterSettings {
            tunnel: Some(view.id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    view.id
}

fn failure(state: &ConnectionState) -> (FailureKind, String) {
    match state {
        ConnectionState::Failed { kind, message } => (*kind, message.clone()),
        other => panic!("expected Failed, got {other:?}"),
    }
}

fn yaml(path: &Path) -> serde_yaml_ng::Value {
    serde_yaml_ng::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The fake API server's `host:port`, as a proxy is asked for it (its URL is `http://`).
fn fake_target(fake: &FakeKube) -> String {
    let url = fake.url();
    url.split_once("://")
        .map_or(url.clone(), |(_, rest)| rest.to_owned())
}

#[tokio::test]
async fn a_cluster_with_a_proxy_tunnel_connects_through_the_gateway() {
    let (core, fake, id, _root) = fake_core().await;
    let proxy = http_proxy(ProxyOptions::default()).await;
    let tunnel = use_tunnel(&core, &id, &format!("http://{}", proxy.addr), None);

    let state = core.cluster_connect(&id).await.unwrap();

    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    assert!(proxy.seen.targets().contains(&fake_target(&fake)));
    let file = yaml(&core.cluster_kubeconfig_path(&id).unwrap());
    let proxy_url = file["clusters"][0]["cluster"]["proxy-url"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        proxy_url.starts_with(&format!("http://{tunnel}:")),
        "the file names the tunnel"
    );
    assert!(proxy_url.contains("@127.0.0.1:"));
    assert_eq!(core.tunnel_list()[0].state, TunnelState::Up);
}

#[tokio::test]
async fn socks5_with_a_password_connects() {
    let (core, fake, id, _root) = fake_core().await;
    let proxy = socks5_proxy(ProxyOptions {
        credentials: Some(("me".into(), "pw".into())),
        ..Default::default()
    })
    .await;
    let tunnel = use_tunnel(&core, &id, &format!("socks5://{}", proxy.addr), Some("me"));
    core.tunnel_set_password(&tunnel, Secret::new("pw"))
        .unwrap();

    let state = core.cluster_connect(&id).await.unwrap();

    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    assert!(proxy.seen.targets().contains(&fake_target(&fake)));
}

#[tokio::test]
async fn a_proxy_that_refuses_fails_the_connect_with_its_reason() {
    let (core, fake, id, _root) = fake_core().await;
    let proxy = http_proxy(ProxyOptions {
        refuse_with: Some("403 Forbidden by policy".into()),
        ..Default::default()
    })
    .await;
    use_tunnel(&core, &id, &format!("http://{}", proxy.addr), None);

    let (kind, message) = failure(&core.cluster_connect(&id).await.unwrap());

    assert_eq!(kind, FailureKind::Tunnel);
    assert_eq!(
        message,
        "Tunnel \"corp\": the proxy answered 403 Forbidden by policy"
    );
    assert_eq!(fake.request_count("/version"), 0);
}

#[tokio::test]
async fn a_username_without_a_password_says_where_to_enter_it() {
    let (core, _fake, id, _root) = fake_core().await;
    let proxy = http_proxy(ProxyOptions::default()).await;
    use_tunnel(&core, &id, &format!("http://{}", proxy.addr), Some("me"));

    let (kind, message) = failure(&core.cluster_connect(&id).await.unwrap());

    assert_eq!(kind, FailureKind::Tunnel);
    assert_eq!(
        message,
        "Tunnel \"corp\": No password is saved for this tunnel: enter it in Preferences › Tunnels"
    );
}

#[tokio::test]
async fn a_failed_tunnel_connect_never_quotes_the_token() {
    let (core, _fake, id, _root) = fake_core().await;
    let proxy = http_proxy(ProxyOptions {
        credentials: Some(("me".into(), "pw".into())),
        ..Default::default()
    })
    .await;
    let tunnel = use_tunnel(&core, &id, &format!("http://{}", proxy.addr), Some("me"));
    core.tunnel_set_password(&tunnel, Secret::new("pw"))
        .unwrap();
    assert!(matches!(
        core.cluster_connect(&id).await.unwrap(),
        ConnectionState::Connected { .. }
    ));
    let file = yaml(&core.cluster_kubeconfig_path(&id).unwrap());
    let gateway = url::Url::parse(
        file["clusters"][0]["cluster"]["proxy-url"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let token = gateway.password().unwrap().to_owned();
    core.cluster_disconnect(&id).await.unwrap();
    core.tunnel_set_password(&tunnel, Secret::new("hunter2"))
        .unwrap();

    let (kind, message) = failure(&core.cluster_connect(&id).await.unwrap());

    assert_eq!(kind, FailureKind::Tunnel);
    assert!(
        message.contains("refused the user name or password"),
        "{message}"
    );
    let log: Vec<String> = core
        .cluster_log(&id)
        .into_iter()
        .map(|e| e.message)
        .collect();
    let views = serde_json::to_string(&core.tunnel_list()).unwrap();
    for text in [message.as_str(), &log.join("\n"), &views] {
        assert!(!text.contains(&token), "{text}");
        assert!(!text.contains("hunter2"), "{text}");
    }
}

#[tokio::test]
async fn a_missing_tunnel_connects_directly() {
    let (core, _fake, id, _root) = fake_core().await;
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            tunnel: Some("gone".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let state = core.cluster_connect(&id).await.unwrap();

    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    let file = yaml(&core.cluster_kubeconfig_path(&id).unwrap());
    assert!(file["clusters"][0]["cluster"].get("proxy-url").is_none());
}

#[tokio::test]
async fn an_export_keeps_the_source_proxy_url() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let config = kube_config(&root);
    fake.write_kubeconfig(&config, CONTEXT).unwrap();
    let mut source = yaml(&config);
    source["clusters"][0]["cluster"]["proxy-url"] = "http://corp-proxy.example:3128".into();
    std::fs::write(&config, serde_yaml_ng::to_string(&source).unwrap()).unwrap();
    let (core, id) = start(&root).await;
    let proxy = http_proxy(ProxyOptions::default()).await;
    use_tunnel(&core, &id, &format!("http://{}", proxy.addr), None);
    assert!(matches!(
        core.cluster_connect(&id).await.unwrap(),
        ConnectionState::Connected { .. }
    ));
    fake.serve_resource(FakeResource::new(
        "",
        "v1",
        "ServiceAccount",
        "serviceaccounts",
        true,
    ));
    fake.upsert(
        "serviceaccounts",
        json!({ "metadata": { "name": "sa", "namespace": "default" } }),
    );
    let dest = root.path().join("sa.kubeconfig");

    core.service_account_kubeconfig_save(&id, "default", "sa", &dest, None)
        .await
        .unwrap();

    let exported: Value =
        serde_yaml_ng::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
    assert_eq!(
        exported["clusters"][0]["cluster"]["proxy-url"],
        "http://corp-proxy.example:3128"
    );
}

#[tokio::test]
async fn the_exec_approval_survives_a_restart_and_follows_the_tunnel() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        kube_config(&root),
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- {{ name: c, cluster: {{ server: \"https://127.0.0.1:1\" }} }}\n\
             users:\n- {{ name: u, user: {{ exec: {{ apiVersion: client.authentication.k8s.io/v1, command: \"skopos-no-such-plugin\" }} }} }}\n\
             contexts:\n- {{ name: {CONTEXT}, context: {{ cluster: c, user: u }} }}\ncurrent-context: {CONTEXT}\n"
        ),
    )
    .unwrap();
    let (core, id) = start(&root).await;
    let tunnel = use_tunnel(&core, &id, "http://127.0.0.1:9", None);
    assert_eq!(
        failure(&core.cluster_connect(&id).await.unwrap()).0,
        FailureKind::ExecNotAllowed
    );
    let request = core.cluster_exec_request(&id).unwrap();
    core.cluster_exec_allow(&id, request.request_id).unwrap();
    assert_eq!(
        failure(&core.cluster_connect(&id).await.unwrap()).0,
        FailureKind::Tunnel
    );
    core.shutdown().await;
    drop(core);

    let (core, id) = start(&root).await;
    assert_eq!(
        failure(&core.cluster_connect(&id).await.unwrap()).0,
        FailureKind::Tunnel
    );
    core.tunnel_save(TunnelInput {
        id: Some(tunnel),
        name: "corp".into(),
        kind: TunnelKind::Proxy {
            url: "http://127.0.0.1:10".into(),
            username: None,
        },
    })
    .unwrap();
    assert_eq!(
        failure(&core.cluster_connect(&id).await.unwrap()).0,
        FailureKind::ExecNotAllowed
    );
}
