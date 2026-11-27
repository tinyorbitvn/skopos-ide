//! What the kind tunnel tests share (tunnels spec §5.10, §6.6). The kubeconfig names the API
//! server `skopos-e2e-control-plane:6443`, which the host cannot resolve: only the test proxy
//! or SSH server resolves it, to the address kind publishes on 127.0.0.1, so whatever reaches
//! the cluster went through the tunnel. Only `e2e/.tmp/kubeconfig` is read.

use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{StreamExt, TryStreamExt};
use k8s_openapi::api::core::v1::{ConfigMap, Pod};
use kube::api::{AttachParams, ListParams, PostParams, WatchEvent, WatchParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::helm::HelmHomes;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::portforward::{
    PortForwardKind, PortForwardPort, PortForwardSpec, PortForwardState, PortForwardTarget,
};
use skopos_core::secrets::MemorySecretStore;
use skopos_core::tools::{ToolName, ToolsConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::{create_pod, in_namespace, TEST_IMAGE};

pub const INTERNAL_HOST: &str = "skopos-e2e-control-plane";
pub const CONTEXT: &str = "kind-skopos-e2e";
pub const WAIT: Duration = Duration::from_secs(120);

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `e2e/.tmp/kubeconfig` with the server named as inside the kind network, and the address
/// kind publishes the API server on.
pub fn internal_kubeconfig() -> (String, SocketAddr) {
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

/// A core under `root` whose only cluster is the kind context of `kubeconfig`, with keychains
/// in memory. Not connected yet.
pub async fn internal_core(root: &Path, kubeconfig: &str) -> (AppCore, ClusterId) {
    let kube_dir = root.join("home/.kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::write(kube_dir.join("config"), kubeconfig).unwrap();
    let paths = AppPaths::under(&root.join("app"), &root.join("home"));
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
    (core, id)
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

/// The managed `helm` or `kubectl`, downloaded into `e2e/.tmp/tools` on the first run (as
/// `kind_tools`). Returns its path.
pub async fn managed_tool(tool: ToolName) -> String {
    let home = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&repo_root().join("e2e/.tmp/tools"), home.path());
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(OsString::new()),
        ..ToolsConfig::default()
    });
    let status = core.tools_download(tool).await.unwrap();
    core.shutdown().await;
    status.path.unwrap()
}

/// In a fresh `namespace`: a watch sees a new ConfigMap, a list shows it, an exec answers, a
/// port forward reaches a pod, and `helm list` answers with `{id}.yaml`. Every request goes
/// through the cluster's tunnel. `root` holds helm's homes.
pub async fn carries_the_cluster(
    core: &AppCore,
    id: &ClusterId,
    client: &Client,
    namespace: &str,
    root: &Path,
) {
    in_namespace(client, namespace, async {
        let maps: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
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

        create_pod(client, namespace, web_pod()).await;
        wait_ready(client, namespace, "web").await;
        let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
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

        let added = core
            .portforward_add(PortForwardSpec {
                cluster_id: id.clone(),
                target: PortForwardTarget {
                    kind: PortForwardKind::Pod,
                    namespace: namespace.to_owned(),
                    name: "web".to_owned(),
                },
                target_port: PortForwardPort::Number(8080),
                local_port: None,
            })
            .unwrap();
        let running = core.portforward_start(&added.id).await.unwrap();
        assert_eq!(running.state, PortForwardState::Running);
        assert_eq!(get(running.bound_port.unwrap(), "/hostname").await, "web");

        // helm reads `{id}.yaml`, whose proxy-url is the gateway.
        let helm = managed_tool(ToolName::Helm).await;
        core.set_tools_config_for_test(ToolsConfig {
            search_path: Some(Path::new(&helm).parent().unwrap().as_os_str().to_owned()),
            ..ToolsConfig::default()
        });
        let homes = root.join("helm");
        core.set_helm_homes_for_test(HelmHomes {
            config: homes.join("config"),
            cache: homes.join("cache"),
            data: homes.join("data"),
        });
        let list = core
            .helm_release_list(id, Some(vec![namespace.to_owned()]))
            .await
            .unwrap();
        assert!(!list.partial);
        assert!(list.releases.is_empty());
    })
    .await;
}
