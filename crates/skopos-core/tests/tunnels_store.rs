//! Tunnels: the store and its editing (tunnels spec §5.2).

use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::ClusterSettings;
use skopos_core::tunnels::{TunnelInput, TunnelKind};
use tempfile::TempDir;

async fn start(root: &TempDir) -> AppCore {
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap()
}

fn proxy(name: &str, url: &str) -> TunnelInput {
    TunnelInput {
        id: None,
        name: name.into(),
        kind: TunnelKind::Proxy {
            url: url.into(),
            username: None,
        },
    }
}

#[tokio::test]
async fn a_saved_tunnel_is_listed_by_name_and_kept_across_a_restart() {
    let root = tempfile::tempdir().unwrap();
    let core = start(&root).await;
    core.tunnel_save(proxy("zeta", "socks5://z:1080")).unwrap();
    let alpha = core
        .tunnel_save(proxy(" Alpha ", "http://a:3128/"))
        .unwrap();
    assert_eq!(alpha.name, "Alpha");
    assert_eq!(
        alpha.kind,
        TunnelKind::Proxy {
            url: "http://a:3128".into(),
            username: None
        }
    );
    drop(core);
    let again = start(&root).await;
    let names: Vec<String> = again.tunnel_list().into_iter().map(|t| t.name).collect();
    assert_eq!(names, ["Alpha", "zeta"]);
}

#[tokio::test]
async fn names_are_unique_ignoring_case_and_edits_keep_the_id() {
    let root = tempfile::tempdir().unwrap();
    let core = start(&root).await;
    let corp = core.tunnel_save(proxy("corp", "http://a:1")).unwrap();
    let err = core.tunnel_save(proxy("CORP", "http://b:1")).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    let edited = core
        .tunnel_save(TunnelInput {
            id: Some(corp.id.clone()),
            ..proxy("Corp", "http://b:2")
        })
        .unwrap();
    assert_eq!(edited.id, corp.id);
    assert_eq!(core.tunnel_list().len(), 1);
}

#[tokio::test]
async fn deleting_a_tunnel_clears_the_clusters_that_use_it() {
    let root = tempfile::tempdir().unwrap();
    let core = start(&root).await;
    let corp = core.tunnel_save(proxy("corp", "http://a:1")).unwrap();
    let id = "some-cluster".to_owned();
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            tunnel: Some(corp.id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(core.tunnel_list()[0].cluster_count, 1);
    core.tunnel_delete(&corp.id).unwrap();
    assert_eq!(core.cluster_settings_get(&id).tunnel, None);
    assert_eq!(
        core.tunnel_delete(&corp.id).unwrap_err().code,
        ErrorCode::NotFound
    );
}

use std::sync::Arc;

use skopos_core::error::CoreResult;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::secrets::{keychain_unavailable, MemorySecretStore, Secret, SecretStore};

/// A keychain that refuses every write, as a Linux desktop without Secret Service does.
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

async fn start_with(root: &TempDir, tunnel_store: Arc<dyn SecretStore>) -> AppCore {
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    AppCore::start_with_secret_stores(
        paths,
        None,
        Arc::new(MemorySecretStore::default()),
        tunnel_store,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_proxy_password_goes_to_the_keychain_and_never_to_the_store_file() {
    let root = tempfile::tempdir().unwrap();
    let keychain = Arc::new(MemorySecretStore::default());
    let core = start_with(&root, keychain.clone()).await;
    let corp = core.tunnel_save(proxy("corp", "http://a:1")).unwrap();
    let view = core
        .tunnel_set_password(&corp.id, Secret::new("hunter2"))
        .unwrap();
    assert!(view.has_password);
    assert_eq!(view.password_note, None);
    let account = format!("{}:proxy-password", corp.id);
    assert_eq!(
        keychain.get(&account).unwrap(),
        Some(Secret::new("hunter2"))
    );
    let file = std::fs::read_to_string(root.path().join("app/config/tunnels.json")).unwrap();
    assert!(!file.contains("hunter2"));
    let view = core.tunnel_clear_password(&corp.id).unwrap();
    assert!(!view.has_password);
    assert_eq!(keychain.get(&account).unwrap(), None);
}

#[tokio::test]
async fn a_refusing_keychain_keeps_the_password_in_memory_and_says_so() {
    let root = tempfile::tempdir().unwrap();
    let core = start_with(&root, Arc::new(RefusingStore)).await;
    let corp = core.tunnel_save(proxy("corp", "http://a:1")).unwrap();
    let view = core
        .tunnel_set_password(&corp.id, Secret::new("pw"))
        .unwrap();
    assert!(view.has_password);
    assert_eq!(
        view.password_note.as_deref(),
        Some(
            "Kept until SkoposIDE quits: the system keychain is not available (no Secret Service)"
        )
    );
}

#[tokio::test]
async fn deleting_a_tunnel_deletes_its_password() {
    let root = tempfile::tempdir().unwrap();
    let keychain = Arc::new(MemorySecretStore::default());
    let core = start_with(&root, keychain.clone()).await;
    let corp = core.tunnel_save(proxy("corp", "http://a:1")).unwrap();
    core.tunnel_set_password(&corp.id, Secret::new("pw"))
        .unwrap();
    core.tunnel_delete(&corp.id).unwrap();
    assert_eq!(
        keychain
            .get(&format!("{}:proxy-password", corp.id))
            .unwrap(),
        None
    );
}
