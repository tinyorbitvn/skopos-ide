//! Clusters behind a proxy tunnel, on the `skopos-e2e` kind cluster (tunnels spec §5.10).
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.
//!
//! The kubeconfig names the API server `skopos-e2e-control-plane:6443`, which the host cannot
//! resolve. Only the test proxy resolves it, to the address kind publishes on 127.0.0.1, so
//! whatever reaches the cluster went through the tunnel.

mod support;

use std::collections::HashMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod};
use kube::api::{AttachParams, ListParams, PostParams, WatchEvent, WatchParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::{ConnectionState, FailureKind};
use skopos_core::helm::HelmHomes;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::portforward::{
    PortForwardKind, PortForwardPort, PortForwardSpec, PortForwardState, PortForwardTarget,
};
use skopos_core::prefs::ClusterSettings;
use skopos_core::secrets::{MemorySecretStore, Secret};
use skopos_core::tools::{ToolName, ToolsConfig};
use skopos_core::tunnels::{TunnelInput, TunnelKind};
use skopos_fakekube::proxy::{http_proxy, socks5_proxy, ProxyOptions, TestProxy};
use support::{create_pod, in_namespace, TEST_IMAGE};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const INTERNAL_HOST: &str = "skopos-e2e-control-plane";
const CONTEXT: &str = "kind-skopos-e2e";
const WAIT: Duration = Duration::from_secs(120);

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `e2e/.tmp/kubeconfig` with the server named as inside the kind network, and the address
/// kind publishes the API server on.
fn internal_kubeconfig() -> (String, SocketAddr) {
    let text = std::fs::read_to_string(repo_root().join("e2e/.tmp/kubeconfig")).unwrap();
    let mut config: Value = serde_yaml_ng::from_str(&text).unwrap();
    let server = &mut config["clusters"][0]["cluster"]["server"];
    let published: SocketAddr = server
        .as_str()
        .and_then(|url| url.strip_prefix("https://"))
        .and_then(|address| address.parse().ok())
        .expect("the kind kubeconfig's server is https://127.0.0.1:<port>");
    *server = json!(format!("https://{INTERNAL_HOST}:6443"));
    (serde_yaml_ng::to_string(&config).unwrap(), published)
}

struct Tunneled {
    core: AppCore,
    id: ClusterId,
    proxy: TestProxy,
    root: TempDir,
}

/// A core whose only cluster is the kind cluster behind a `scheme` proxy that wants `me` and
/// `p@ss`, with `password` saved for its tunnel. Not connected yet.
async fn behind(scheme: &str, password: &str) -> Tunneled {
    let (kubeconfig, published) = internal_kubeconfig();
    let hosts = HashMap::from([(INTERNAL_HOST.to_owned(), published)]);
    let options = ProxyOptions {
        credentials: Some(("me".into(), "p@ss".into())),
        hosts,
        ..ProxyOptions::default()
    };
    let proxy = match scheme {
        "socks5" => socks5_proxy(options).await,
        _ => http_proxy(options).await,
    };
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home/.kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::write(kube_dir.join("config"), kubeconfig).unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_secret_stores(
        paths,
        None,
        Arc::new(MemorySecretStore::default()),
        Arc::new(MemorySecretStore::default()),
    )
    .await
    .unwrap();
    let started = Instant::now();
    let id = loop {
        if let Some(entry) = core
            .catalog_list()
            .into_iter()
            .find(|e| e.context_name == CONTEXT)
        {
            break entry.id;
        }
        assert!(started.elapsed() < WAIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let tunnel = core
        .tunnel_save(TunnelInput {
            id: None,
            name: format!("{scheme} proxy"),
            kind: TunnelKind::Proxy {
                url: format!("{scheme}://{}", proxy.addr),
                username: Some("me".into()),
            },
        })
        .unwrap();
    core.tunnel_set_password(&tunnel.id, Secret::new(password))
        .unwrap();
    let settings = ClusterSettings {
        tunnel: Some(tunnel.id),
        ..ClusterSettings::default()
    };
    core.cluster_settings_set(&id, settings).unwrap();
    Tunneled {
        core,
        id,
        proxy,
        root,
    }
}

/// `behind`, connected; the proxy saw the API server's internal name.
async fn connected_behind(scheme: &str) -> (Tunneled, Client) {
    let t = behind(scheme, "p@ss").await;
    let state = t.core.cluster_connect(&t.id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    let target = format!("{INTERNAL_HOST}:6443");
    assert!(
        t.proxy.seen.targets().contains(&target),
        "{:?}",
        t.proxy.seen.targets()
    );
    let client = t.core.cluster_client(&t.id).unwrap();
    (t, client)
}

fn web_pod() -> Value {
    json!({
        "metadata": { "name": "web", "labels": { "app": "web" } },
        "spec": {
            "terminationGracePeriodSeconds": 0,
            "containers": [{
                "name": "web",
                "image": TEST_IMAGE,
                "args": ["netexec", "--http-port=8080"],
                "ports": [{ "name": "http", "containerPort": 8080 }],
                "readinessProbe": { "httpGet": { "path": "/", "port": 8080 }, "periodSeconds": 1 },
            }],
        },
    })
}

/// Waits until the pod's Ready condition is true.
async fn wait_ready(client: &Client, namespace: &str, name: &str) {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let started = Instant::now();
    loop {
        let pod = serde_json::to_value(pods.get(name).await.unwrap()).unwrap();
        let ready = pod
            .pointer("/status/conditions")
            .and_then(Value::as_array)
            .is_some_and(|all| {
                all.iter()
                    .any(|c| c["type"] == "Ready" && c["status"] == "True")
            });
        if ready {
            return;
        }
        assert!(started.elapsed() < WAIT, "{name} never became ready");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// One HTTP request over its own connection. Returns the response body.
async fn get(port: u16, path: &str) -> String {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    let (_, body) = response
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("not a response: {response:?}"));
    body.to_owned()
}

/// The managed helm 4, downloaded into `e2e/.tmp/tools` on the first run (as `kind_helm`).
async fn managed_helm() -> String {
    let home = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&repo_root().join("e2e/.tmp/tools"), home.path());
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(OsString::new()),
        ..ToolsConfig::default()
    });
    let status = core.tools_download(ToolName::Helm).await.unwrap();
    core.shutdown().await;
    status.path.unwrap()
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn an_http_proxy_tunnel_carries_lists_watches_exec_port_forwards_and_helm() {
    const NAMESPACE: &str = "skopos-test-tunnel-http";
    let (t, client) = connected_behind("http").await;
    in_namespace(&client, NAMESPACE, async {
        let maps: Api<ConfigMap> = Api::namespaced(client.clone(), NAMESPACE);
        let mut events = maps
            .watch(&WatchParams::default().timeout(60), "0")
            .await
            .unwrap()
            .boxed();
        let map: ConfigMap =
            serde_json::from_value(json!({ "metadata": { "name": "through" } })).unwrap();
        maps.create(&PostParams::default(), &map).await.unwrap();
        let watched = tokio::time::timeout(WAIT, async {
            while let Some(event) = events.try_next().await.unwrap() {
                if let WatchEvent::Added(added) = event {
                    if added.metadata.name.as_deref() == Some("through") {
                        return;
                    }
                }
            }
            panic!("the watch ended before the ConfigMap showed");
        })
        .await;
        assert!(watched.is_ok(), "no watch event within {WAIT:?}");
        let listed = maps.list(&ListParams::default()).await.unwrap();
        assert!(listed
            .items
            .iter()
            .any(|m| m.metadata.name.as_deref() == Some("through")));

        create_pod(&client, NAMESPACE, web_pod()).await;
        wait_ready(&client, NAMESPACE, "web").await;
        let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
        let mut attached = pods
            .exec(
                "web",
                ["/bin/sh", "-c", "echo tunneled"],
                &AttachParams::default().stdout(true).stderr(false),
            )
            .await
            .unwrap();
        let mut out = String::new();
        attached
            .stdout()
            .unwrap()
            .read_to_string(&mut out)
            .await
            .unwrap();
        attached.join().await.unwrap();
        assert_eq!(out.trim(), "tunneled");

        let added = t
            .core
            .portforward_add(PortForwardSpec {
                cluster_id: t.id.clone(),
                target: PortForwardTarget {
                    kind: PortForwardKind::Pod,
                    namespace: NAMESPACE.to_owned(),
                    name: "web".to_owned(),
                },
                target_port: PortForwardPort::Number(8080),
                local_port: None,
            })
            .unwrap();
        let running = t.core.portforward_start(&added.id).await.unwrap();
        assert_eq!(running.state, PortForwardState::Running);
        assert_eq!(get(running.bound_port.unwrap(), "/hostname").await, "web");

        // helm reads `{id}.yaml`, whose proxy-url is the gateway.
        let helm = managed_helm().await;
        t.core.set_tools_config_for_test(ToolsConfig {
            search_path: Some(Path::new(&helm).parent().unwrap().as_os_str().to_owned()),
            ..ToolsConfig::default()
        });
        let homes = t.root.path().join("helm");
        t.core.set_helm_homes_for_test(HelmHomes {
            config: homes.join("config"),
            cache: homes.join("cache"),
            data: homes.join("data"),
        });
        let list = t
            .core
            .helm_release_list(&t.id, Some(vec![NAMESPACE.to_owned()]))
            .await
            .unwrap();
        assert!(!list.partial);
        assert!(list.releases.is_empty());
    })
    .await;
    t.core.shutdown().await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_socks5_proxy_tunnel_with_a_password_carries_the_cluster() {
    let (t, client) = connected_behind("socks5").await;
    let namespaces: Api<Namespace> = Api::all(client);
    let names: Vec<String> = namespaces
        .list(&ListParams::default())
        .await
        .unwrap()
        .items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .collect();
    assert!(names.iter().any(|n| n == "kube-system"), "{names:?}");
    t.core.shutdown().await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_wrong_proxy_password_fails_the_connect_with_the_proxy_answer() {
    let t = behind("http", "wrong").await;
    let state = t.core.cluster_connect(&t.id).await.unwrap();
    let ConnectionState::Failed { kind, message } = state else {
        panic!("connected through a proxy that wants another password: {state:?}");
    };
    assert_eq!(kind, FailureKind::Tunnel);
    assert!(message.starts_with("Tunnel \"http proxy\": "), "{message}");
    assert!(message.contains("407"), "{message}");
    assert!(!message.contains("wrong"), "the password leaked: {message}");
    t.core.shutdown().await;
}
