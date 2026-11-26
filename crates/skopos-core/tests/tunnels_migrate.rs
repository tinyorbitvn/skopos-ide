//! The migration of the old `proxyUrl` setting at start (tunnels spec §5.4).

use std::sync::Arc;

use skopos_core::app_core::AppCore;
use skopos_core::error::CoreResult;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::secrets::{keychain_unavailable, MemorySecretStore, Secret, SecretStore};
use skopos_core::tunnels::TunnelKind;
use tempfile::TempDir;

struct RefusingStore;

impl SecretStore for RefusingStore {
    fn get(&self, _: &ClusterId) -> CoreResult<Option<Secret>> {
        Ok(None)
    }
    fn set(&self, _: &ClusterId, _: &Secret) -> CoreResult<()> {
        Err(keychain_unavailable("no Secret Service"))
    }
    fn delete(&self, _: &ClusterId) -> CoreResult<()> {
        Ok(())
    }
}

fn write_clusters(root: &TempDir) {
    let config = root.path().join("app/config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("clusters.json"),
        r#"{"version":1,"data":{
            "cluster-a":{"proxyUrl":"http://me:p%40ss@proxy.corp:3128","displayName":"Prod"},
            "cluster-b":{"proxyUrl":"http://me:p%40ss@proxy.corp:3128/"},
            "cluster-c":{"proxyUrl":"not a url","displayName":"Lab"}
        }}"#,
    )
    .unwrap();
}

async fn start(root: &TempDir, keychain: Arc<dyn SecretStore>) -> AppCore {
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    AppCore::start_with_secret_stores(
        paths,
        None,
        Arc::new(MemorySecretStore::default()),
        keychain,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn proxy_urls_become_tunnels_once() {
    let root = tempfile::tempdir().unwrap();
    write_clusters(&root);
    let keychain = Arc::new(MemorySecretStore::default());
    let core = start(&root, keychain.clone()).await;

    let tunnels = core.tunnel_list();
    assert_eq!(tunnels.len(), 1);
    let tunnel = &tunnels[0];
    assert_eq!(tunnel.name, "proxy.corp:3128");
    assert_eq!(
        tunnel.kind,
        TunnelKind::Proxy {
            url: "http://proxy.corp:3128".into(),
            username: Some("me".into())
        }
    );
    assert!(tunnel.has_password);
    assert_eq!(tunnel.cluster_count, 2);
    let account = format!("{}:proxy-password", tunnel.id);
    assert_eq!(keychain.get(&account).unwrap(), Some(Secret::new("p@ss")));
    for id in ["cluster-a", "cluster-b"] {
        let settings = core.cluster_settings_get(&id.to_owned());
        assert_eq!(settings.tunnel.as_deref(), Some(tunnel.id.as_str()));
        assert_eq!(settings.proxy_url, None);
    }
    assert_eq!(
        core.cluster_settings_get(&"cluster-c".to_owned()).tunnel,
        None
    );
    let warnings = core.take_startup_warnings();
    assert_eq!(warnings.len(), 1);
    assert_eq!(
        warnings[0].message,
        "The proxy URL of cluster \"Lab\" is not a proxy URL and was removed; pick a tunnel in its settings"
    );
    let file = std::fs::read_to_string(root.path().join("app/config/clusters.json")).unwrap();
    assert!(!file.contains("proxyUrl"), "{file}");
    assert!(!file.contains("p%40ss"), "{file}");
    core.shutdown().await;
    drop(core);

    let again = start(&root, keychain).await;
    assert_eq!(again.tunnel_list().len(), 1);
    assert!(again.take_startup_warnings().is_empty());
}

#[tokio::test]
async fn a_refusing_keychain_keeps_the_password_for_this_run_and_warns() {
    let root = tempfile::tempdir().unwrap();
    write_clusters(&root);
    let core = start(&root, Arc::new(RefusingStore)).await;

    let tunnel = &core.tunnel_list()[0];
    assert!(tunnel.has_password);
    let messages: Vec<String> = core
        .take_startup_warnings()
        .into_iter()
        .map(|w| w.message)
        .collect();
    assert!(
        messages.contains(
            &"The password of proxy tunnel \"proxy.corp:3128\" could not be saved in the keychain \
          (no Secret Service); enter it again after a restart"
                .to_owned()
        ),
        "{messages:?}"
    );
}
