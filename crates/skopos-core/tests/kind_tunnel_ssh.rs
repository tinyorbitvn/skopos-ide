//! A cluster behind an SSH tunnel, on the `skopos-e2e` kind cluster (tunnels spec §6.6). Needs
//! `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.
//!
//! The system `ssh` runs against the in-process `skopos-fakesshd`, the only one that resolves
//! `skopos-e2e-control-plane:6443`, to the address kind publishes on 127.0.0.1. `ssh` reads
//! only the test's own config (`-F`), never `~/.ssh/config`, `known_hosts` or ssh-agent.

mod support;

use std::collections::HashMap;
use std::time::Duration;

use skopos_core::cluster::ConnectionState;
use skopos_core::prefs::ClusterSettings;
use skopos_core::secrets::Secret;
use skopos_core::tools::ToolName;
use skopos_core::tunnels::{PromptKind, TunnelInput, TunnelKind};
use skopos_fakesshd::{FakeSshd, FakeSshdOptions};
use support::ssh::{system_ssh, use_system_ssh, write_ssh_config};
use support::tunnel::{
    carries_the_cluster, internal_core, internal_kubeconfig, managed_tool, INTERNAL_HOST, WAIT,
};

const NAMESPACE: &str = "skopos-test-tunnel-ssh";
const PASSWORD: &str = "kind-through-ssh";

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn an_ssh_tunnel_carries_lists_watches_exec_port_forwards_helm_and_kubectl() {
    let Some(ssh) = system_ssh() else { return };
    let (kubeconfig, published) = internal_kubeconfig();
    let target = format!("{INTERNAL_HOST}:6443");
    let server = FakeSshd::start(FakeSshdOptions {
        password: PASSWORD.into(),
        hosts: HashMap::from([(target.clone(), published)]),
        ..FakeSshdOptions::default()
    })
    .await
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let ssh_dir = root.path().join("ssh");
    std::fs::create_dir_all(&ssh_dir).unwrap();
    let (config, _) = write_ssh_config(&ssh_dir, &format!("{}\n", server.known_hosts_line()));
    let (core, id) = internal_core(root.path(), &kubeconfig).await;
    use_system_ssh(&core, &ssh, config);
    let tunnel = core
        .tunnel_save(TunnelInput {
            id: None,
            name: "bastion".into(),
            kind: TunnelKind::Ssh {
                host: "127.0.0.1".into(),
                user: Some("me".into()),
                port: Some(server.port()),
                jump: None,
                identity_file: None,
            },
        })
        .unwrap();
    let settings = ClusterSettings {
        tunnel: Some(tunnel.id.clone()),
        ..ClusterSettings::default()
    };
    core.cluster_settings_set(&id, settings).unwrap();

    // The connect starts ssh, which asks for the password once.
    let connecting = {
        let (core, id) = (core.clone(), id.clone());
        tokio::spawn(async move { core.cluster_connect(&id).await.unwrap() })
    };
    let prompt = tokio::time::timeout(WAIT, async {
        loop {
            let asked = core
                .tunnel_list()
                .into_iter()
                .find(|t| t.id == tunnel.id)
                .and_then(|t| t.prompt);
            if let Some(prompt) = asked {
                break prompt;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("ssh never asked for the password");
    assert_eq!(prompt.kind, PromptKind::Password);
    assert!(prompt.opens_at_once, "a connect is the person's action");
    core.tunnel_prompt_answer(&prompt.id, Secret::new(PASSWORD), false)
        .unwrap();
    let state = tokio::time::timeout(WAIT, connecting)
        .await
        .expect("the connect never ended")
        .unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    assert!(server.opened().contains(&target), "{:?}", server.opened());

    let client = core.cluster_client(&id).unwrap();
    carries_the_cluster(&core, &id, &client, NAMESPACE, root.path()).await;

    // kubectl reads `{id}.yaml`, whose proxy-url is the gateway.
    let kubectl = managed_tool(ToolName::Kubectl).await;
    let path = core.cluster_kubeconfig_path(&id).unwrap();
    let output = tokio::process::Command::new(&kubectl)
        .arg("--kubeconfig")
        .arg(&path)
        .args(["get", "ns", "-o", "name"])
        .output()
        .await
        .unwrap();
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "kubectl failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        out.lines().any(|line| line == "namespace/kube-system"),
        "{out}"
    );

    core.shutdown().await;
    server.stop().await;
}
