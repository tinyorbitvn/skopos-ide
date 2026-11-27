//! Clusters behind a proxy tunnel, on the `skopos-e2e` kind cluster (tunnels spec §5.10).
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.
//!
//! The kubeconfig names the API server `skopos-e2e-control-plane:6443`, which the host cannot
//! resolve. Only the test proxy resolves it, to the address kind publishes on 127.0.0.1, so
//! whatever reaches the cluster went through the tunnel.

mod support;

use std::collections::HashMap;

use k8s_openapi::api::core::v1::Namespace;
use kube::api::ListParams;
use kube::{Api, Client};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::{ConnectionState, FailureKind};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::ClusterSettings;
use skopos_core::secrets::Secret;
use skopos_core::tunnels::{TunnelInput, TunnelKind};
use skopos_fakekube::proxy::{http_proxy, socks5_proxy, ProxyOptions, TestProxy};
use support::tunnel::{carries_the_cluster, internal_core, internal_kubeconfig, INTERNAL_HOST};
use tempfile::TempDir;

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
    let (core, id) = internal_core(root.path(), &kubeconfig).await;
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

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn an_http_proxy_tunnel_carries_lists_watches_exec_port_forwards_and_helm() {
    let (t, client) = connected_behind("http").await;
    carries_the_cluster(
        &t.core,
        &t.id,
        &client,
        "skopos-test-tunnel-http",
        t.root.path(),
    )
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
