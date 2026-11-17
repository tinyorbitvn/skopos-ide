//! The secret of a cluster's metrics URL (spec §10): the Basic password or the Bearer token,
//! kept in a store the app provides, the OS keychain, and in memory once read.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use dashmap::DashMap;
use serde::Deserialize;

use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::metrics::MetricsProviderSetting;

/// A password or a token. Its `Debug` never shows it, and it is never serialized (spec I49).
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value, for the request that sends it and the store that keeps it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("‹redacted›")
    }
}

/// Where each cluster's secret is kept (spec I47): the OS keychain in the app, memory in
/// tests. One entry per cluster.
pub trait SecretStore: Send + Sync {
    fn get(&self, cluster: &ClusterId) -> CoreResult<Option<Secret>>;
    /// Replaces the cluster's secret.
    fn set(&self, cluster: &ClusterId, secret: &Secret) -> CoreResult<()>;
    /// Succeeds when there is nothing to delete.
    fn delete(&self, cluster: &ClusterId) -> CoreResult<()>;
}

/// What a store answers when the keychain cannot be used, such as on a Linux desktop
/// without Secret Service (spec I51). `reason` must not hold the secret.
pub fn keychain_unavailable(reason: &str) -> IpcError {
    IpcError::new(
        ErrorCode::Unreachable,
        format!(
            "The system keychain is not available ({reason}). Use a client certificate or no authentication."
        ),
    )
}

/// Secrets kept for this process only: the core's default, and the tests' store.
#[derive(Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<ClusterId, Secret>>,
}

impl MemorySecretStore {
    fn secrets(&self) -> MutexGuard<'_, HashMap<ClusterId, Secret>> {
        self.secrets.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl SecretStore for MemorySecretStore {
    fn get(&self, cluster: &ClusterId) -> CoreResult<Option<Secret>> {
        Ok(self.secrets().get(cluster).cloned())
    }

    fn set(&self, cluster: &ClusterId, secret: &Secret) -> CoreResult<()> {
        self.secrets().insert(cluster.clone(), secret.clone());
        Ok(())
    }

    fn delete(&self, cluster: &ClusterId) -> CoreResult<()> {
        self.secrets().remove(cluster);
        Ok(())
    }
}

/// The store, and the secrets read from it or set during this session (spec I51).
pub(crate) struct Secrets {
    store: Arc<dyn SecretStore>,
    read: DashMap<ClusterId, Secret>,
}

impl Secrets {
    pub(crate) fn new(store: Arc<dyn SecretStore>) -> Self {
        Self {
            store,
            read: DashMap::new(),
        }
    }

    /// The cluster's secret, from memory once read.
    pub(crate) fn get(&self, id: &ClusterId) -> CoreResult<Option<Secret>> {
        if let Some(secret) = self.read.get(id) {
            return Ok(Some(secret.clone()));
        }
        let secret = self.store.get(id)?;
        if let Some(secret) = &secret {
            self.read.insert(id.clone(), secret.clone());
        }
        Ok(secret)
    }

    fn set(&self, id: &ClusterId, secret: Secret) -> CoreResult<()> {
        self.store.set(id, &secret)?;
        self.read.insert(id.clone(), secret);
        Ok(())
    }

    /// Forgets the cluster's secret. A store that cannot delete it only logs, so it never
    /// keeps the settings from being saved or the cluster from being removed (spec I50).
    pub(crate) fn delete(&self, id: &ClusterId) {
        self.read.remove(id);
        if let Err(e) = self.store.delete(id) {
            tracing::warn!(
                "the metrics secret of cluster {id} could not be deleted: {}",
                e.message
            );
        }
    }
}

impl AppCore {
    /// Saves the password or token of the cluster's metrics URL, replacing the one saved
    /// (spec I49, I51). `Unreachable` when the keychain cannot be used.
    pub fn metrics_secret_set(&self, id: &ClusterId, secret: Secret) -> CoreResult<()> {
        self.secrets().set(id, secret)
    }

    /// `metrics_secret_set` for the page's save: the metrics setting the secret belongs to is
    /// validated first, certificate files included, so a setting the core refuses leaves the
    /// keychain as it was (spec I45, I58, I59).
    pub fn metrics_secret_set_for(
        &self,
        id: &ClusterId,
        secret: Secret,
        intended: MetricsProviderSetting,
    ) -> CoreResult<()> {
        intended.normalized()?;
        self.secrets().set(id, secret)
    }

    /// Whether a password or token is saved for the cluster (spec I51).
    pub fn metrics_secret_saved(&self, id: &ClusterId) -> CoreResult<bool> {
        Ok(self.secrets().get(id)?.is_some())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::app_core::AppCore;
    use crate::error::ErrorCode;
    use crate::metrics::{MetricsProviderSetting, RemoteAuth};
    use crate::paths::AppPaths;
    use crate::prefs::ClusterSettings;

    /// The memory store, counting the reads that reach it.
    #[derive(Default)]
    struct CountingStore {
        inner: MemorySecretStore,
        reads: AtomicUsize,
    }

    impl CountingStore {
        fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }
    }

    impl SecretStore for CountingStore {
        fn get(&self, cluster: &ClusterId) -> CoreResult<Option<Secret>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.inner.get(cluster)
        }

        fn set(&self, cluster: &ClusterId, secret: &Secret) -> CoreResult<()> {
            self.inner.set(cluster, secret)
        }

        fn delete(&self, cluster: &ClusterId) -> CoreResult<()> {
            self.inner.delete(cluster)
        }
    }

    /// A Linux desktop without Secret Service.
    struct NoKeychain;

    impl SecretStore for NoKeychain {
        fn get(&self, _: &ClusterId) -> CoreResult<Option<Secret>> {
            Err(keychain_unavailable("no Secret Service"))
        }

        fn set(&self, _: &ClusterId, _: &Secret) -> CoreResult<()> {
            Err(keychain_unavailable("no Secret Service"))
        }

        fn delete(&self, _: &ClusterId) -> CoreResult<()> {
            Err(keychain_unavailable("no Secret Service"))
        }
    }

    async fn core_with(store: Arc<dyn SecretStore>) -> (AppCore, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
        let core = AppCore::start_with_secret_store(paths, None, store)
            .await
            .unwrap();
        (core, root)
    }

    fn cluster() -> ClusterId {
        "c".repeat(32)
    }

    fn with_provider(metrics_provider: MetricsProviderSetting) -> ClusterSettings {
        ClusterSettings {
            metrics_provider,
            ..ClusterSettings::default()
        }
    }

    fn remote(auth: RemoteAuth) -> MetricsProviderSetting {
        MetricsProviderSetting::Remote {
            url: "https://mimir.example.com/prometheus".to_owned(),
            tenant: None,
            matcher: None,
            auth,
            ca_path: None,
        }
    }

    #[test]
    fn a_secret_never_shows_in_debug_output() {
        let secret = Secret::new("hunter2");
        assert_eq!(format!("{secret:?}"), "‹redacted›");
        assert_eq!(format!("{:?}", Some(&secret)), "Some(‹redacted›)");
        assert_eq!(secret.expose(), "hunter2");
        let read: Secret = serde_json::from_value(json!("hunter2")).unwrap();
        assert_eq!(read, secret);
    }

    #[test]
    fn the_memory_store_keeps_one_secret_per_cluster() {
        let store = MemorySecretStore::default();
        let (one, two) = ("1".repeat(32), "2".repeat(32));
        assert_eq!(store.get(&one).unwrap(), None);
        store.set(&one, &Secret::new("a")).unwrap();
        store.set(&two, &Secret::new("b")).unwrap();
        store.set(&one, &Secret::new("c")).unwrap();
        assert_eq!(store.get(&one).unwrap(), Some(Secret::new("c")));
        store.delete(&one).unwrap();
        store.delete(&one).unwrap();
        assert_eq!(store.get(&one).unwrap(), None);
        assert_eq!(store.get(&two).unwrap(), Some(Secret::new("b")));
    }

    #[test]
    fn a_secret_read_from_the_store_is_kept_for_the_session() {
        let store = Arc::new(CountingStore::default());
        let secrets = Secrets::new(store.clone());
        let id = cluster();
        assert_eq!(secrets.get(&id).unwrap(), None);
        assert_eq!(store.reads(), 1);

        store.inner.set(&id, &Secret::new("saved earlier")).unwrap();
        assert_eq!(
            secrets.get(&id).unwrap(),
            Some(Secret::new("saved earlier"))
        );
        assert_eq!(
            secrets.get(&id).unwrap(),
            Some(Secret::new("saved earlier"))
        );
        assert_eq!(store.reads(), 2);

        secrets.set(&id, Secret::new("typed now")).unwrap();
        assert_eq!(secrets.get(&id).unwrap(), Some(Secret::new("typed now")));
        assert_eq!(
            store.inner.get(&id).unwrap(),
            Some(Secret::new("typed now"))
        );
        assert_eq!(store.reads(), 2);

        secrets.delete(&id);
        assert_eq!(store.inner.get(&id).unwrap(), None);
        assert_eq!(secrets.get(&id).unwrap(), None);
        assert_eq!(store.reads(), 3);
    }

    #[tokio::test]
    async fn the_core_saves_a_secret_and_says_whether_one_is_saved() {
        let store = Arc::new(CountingStore::default());
        let (core, _root) = core_with(store.clone()).await;
        let id = cluster();
        assert!(!core.metrics_secret_saved(&id).unwrap());

        core.metrics_secret_set(&id, Secret::new("pw-1")).unwrap();
        assert_eq!(store.inner.get(&id).unwrap(), Some(Secret::new("pw-1")));
        let reads = store.reads();
        assert!(core.metrics_secret_saved(&id).unwrap());
        assert_eq!(
            store.reads(),
            reads,
            "the secret just set is kept in memory"
        );

        core.metrics_secret_set(&id, Secret::new("pw-2")).unwrap();
        assert_eq!(store.inner.get(&id).unwrap(), Some(Secret::new("pw-2")));
    }

    #[tokio::test]
    async fn a_refused_setting_leaves_the_saved_secret_alone() {
        let store = Arc::new(MemorySecretStore::default());
        let (core, _root) = core_with(store.clone()).await;
        let id = cluster();
        core.metrics_secret_set(&id, Secret::new("old")).unwrap();
        let bad_ca = MetricsProviderSetting::Remote {
            url: "https://b.example".into(),
            tenant: None,
            matcher: None,
            auth: RemoteAuth::Basic {
                username: "u".into(),
            },
            ca_path: Some("/nonexistent/ca.pem".into()),
        };
        assert!(core
            .metrics_secret_set_for(&id, Secret::new("new"), bad_ca)
            .is_err());
        assert_eq!(store.get(&id).unwrap(), Some(Secret::new("old")));
    }

    #[tokio::test]
    async fn a_setting_that_needs_no_secret_deletes_it_and_one_that_needs_it_keeps_it() {
        let store = Arc::new(MemorySecretStore::default());
        let (core, root) = core_with(store.clone()).await;
        let id = cluster();
        let cert = root.path().join("client.pem");
        let key = root.path().join("client.key");
        std::fs::write(
            &cert,
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        std::fs::write(
            &key,
            "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
        )
        .unwrap();
        let mtls = RemoteAuth::Mtls {
            cert_path: cert.to_str().unwrap().to_owned(),
            key_path: key.to_str().unwrap().to_owned(),
        };
        let basic = RemoteAuth::Basic {
            username: "me".to_owned(),
        };

        for kept in [remote(basic.clone()), remote(RemoteAuth::Bearer)] {
            core.metrics_secret_set(&id, Secret::new("pw")).unwrap();
            core.cluster_settings_set(&id, with_provider(kept.clone()))
                .unwrap();
            assert_eq!(store.get(&id).unwrap(), Some(Secret::new("pw")), "{kept:?}");
        }
        for dropped in [
            remote(RemoteAuth::Anonymous),
            remote(mtls),
            MetricsProviderSetting::Auto,
            MetricsProviderSetting::MetricsServer,
            MetricsProviderSetting::Off,
        ] {
            core.metrics_secret_set(&id, Secret::new("pw")).unwrap();
            core.cluster_settings_set(&id, with_provider(dropped.clone()))
                .unwrap();
            assert_eq!(store.get(&id).unwrap(), None, "{dropped:?}");
            assert!(!core.metrics_secret_saved(&id).unwrap(), "{dropped:?}");
        }
        // A refused setting deletes nothing.
        core.metrics_secret_set(&id, Secret::new("pw")).unwrap();
        let refused = MetricsProviderSetting::Remote {
            url: "ftp://mimir.example.com".to_owned(),
            tenant: None,
            matcher: None,
            auth: RemoteAuth::Anonymous,
            ca_path: None,
        };
        assert!(core
            .cluster_settings_set(&id, with_provider(refused))
            .is_err());
        assert_eq!(store.get(&id).unwrap(), Some(Secret::new("pw")));
    }

    #[tokio::test]
    async fn removing_a_pasted_cluster_deletes_its_secret() {
        let store = Arc::new(MemorySecretStore::default());
        let (core, _root) = core_with(store.clone()).await;
        let yaml = "apiVersion: v1\nkind: Config\n\
             clusters:\n- { name: c1, cluster: { server: \"https://x\" } }\n\
             users:\n- { name: u1, user: { token: t } }\n\
             contexts:\n- { name: one, context: { cluster: c1, user: u1 } }\n\
             - { name: two, context: { cluster: c1, user: u1 } }\n";
        let ids = core.catalog_add_pasted(yaml).unwrap();
        for id in &ids {
            core.metrics_secret_set(id, Secret::new("pw")).unwrap();
        }
        core.catalog_remove_pasted(&ids[0]).unwrap();
        assert_eq!(store.get(&ids[0]).unwrap(), None);
        assert!(!core.metrics_secret_saved(&ids[0]).unwrap());
        assert_eq!(store.get(&ids[1]).unwrap(), Some(Secret::new("pw")));
    }

    #[tokio::test]
    async fn without_a_keychain_saving_a_secret_names_the_reason_and_settings_still_save() {
        let (core, _root) = core_with(Arc::new(NoKeychain)).await;
        let id = cluster();
        let err = core.metrics_secret_set(&id, Secret::new("pw")).unwrap_err();
        assert_eq!(err.code, ErrorCode::Unreachable);
        assert_eq!(
            err.message,
            "The system keychain is not available (no Secret Service). Use a client certificate or no authentication."
        );
        assert!(!err.message.contains("pw"));
        core.cluster_settings_set(&id, with_provider(MetricsProviderSetting::Off))
            .unwrap();
    }

    /// Review Focus 3: without a keychain, "is one saved?" is the keychain's error, not `false`.
    #[tokio::test]
    async fn without_a_keychain_asking_whether_a_secret_is_saved_names_the_reason() {
        let (core, _root) = core_with(Arc::new(NoKeychain)).await;
        let err = core.metrics_secret_saved(&cluster()).unwrap_err();
        assert_eq!(err.code, ErrorCode::Unreachable);
        assert_eq!(
            err.message,
            "The system keychain is not available (no Secret Service). Use a client certificate or no authentication."
        );
    }
}
