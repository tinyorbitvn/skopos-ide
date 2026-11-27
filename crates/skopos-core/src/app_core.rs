//! `AppCore`, the handle the desktop app and the tests drive everything through.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use dashmap::DashMap;
use kube::config::Kubeconfig;
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use crate::agents::registry::AgentProbes;
use crate::catalog::folders::CatalogFolders;
use crate::catalog::{build_entries, ClusterEntry, PastedConfigs};
use crate::cluster::{
    exec_command, ClusterManager, ConnectTimeouts, ConnectionLogEntry, ConnectionState,
    ExecConsent, ExecRequest, ExecRequestDetails, HeldExec,
};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::graph::GraphHub;
use crate::helm::Helm;
use crate::kubeconfig::{
    default_sources, ClusterId, ContextEntry, KubeconfigSync, SyncSnapshot, SyncSource, SyncWarning,
};
use crate::metrics::Metrics;
use crate::openapi::ApiDocs;
use crate::paths::AppPaths;
use crate::portforward::{PortForward, PortForwards};
use crate::prefs::{ClusterSettings, Prefs};
use crate::quit::QuitWatch;
use crate::reachability::ReachabilityHub;
use crate::resources::{ApiResourceInfo, RunningCertUser, RunningDrain, SingleFlight, WatchHub};
use crate::secrets::{MemorySecretStore, SecretStore, Secrets};
use crate::sessions::SessionRegistry;
use crate::store::{JsonStore, StoreWarning};
use crate::tools::{ToolProgress, Tools};
use crate::topology::TopologyHub;
use crate::ui_state::UiState;
use crate::updates::{UpdateMemory, UpdateSource, UpdateState, Updates};
use crate::windows::{WindowLayout, Windows, MAIN_WINDOW};

const STORE_VERSION: u32 = 1;
const PREFS_FILE: &str = "prefs.json";
pub(crate) const CLUSTERS_FILE: &str = "clusters.json";
const HOTBAR_FILE: &str = "hotbar.json";
const PORTFORWARDS_FILE: &str = "portforwards.json";
const UI_STATE_FILE: &str = "ui-state.json";
const CATALOG_FOLDERS_FILE: &str = "catalog-folders.json";
const WINDOWS_FILE: &str = "windows.json";
const UPDATES_FILE: &str = "updates.json";
const EXEC_CONSENTS_FILE: &str = "exec-consents.json";
/// The safety net under file events, which some filesystems never deliver.
const SYNC_POLL: Duration = Duration::from_secs(10);
const EVENT_BACKLOG: usize = 64;
/// A sync stuck reading a dead mount must not keep the app from exiting.
const SHUTDOWN_LIMIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum CoreEvent {
    CatalogChanged,
    ClusterState {
        id: ClusterId,
        state: ConnectionState,
    },
    KubeconfigWarnings {
        warnings: Vec<SyncWarning>,
    },
    StoreWarning {
        warning: StoreWarning,
    },
    PortForwardsChanged {
        forwards: Vec<PortForward>,
    },
    /// The tunnels or one tunnel's state changed (tunnels spec §5.2, §5.9).
    TunnelsChanged,
    ToolProgress {
        progress: ToolProgress,
    },
    /// The catalog folder tree or a placement changed; read `catalog_folders` again.
    CatalogFoldersChanged,
    /// The core changed a window's layout, as a move between windows does; only that
    /// window (`layout.label`) needs it.
    WindowLayoutChanged {
        layout: WindowLayout,
    },
    /// The in-app update state changed (in-app update spec §5.1). `state.toast_window` is set
    /// only on the change that announces a release for the first time.
    UpdateState {
        state: UpdateState,
    },
}

/// A cheap handle to the running core; clones share everything.
#[derive(Clone)]
pub struct AppCore {
    inner: Arc<Inner>,
}

/// A handle that does not keep the core alive, for the tasks the core starts.
#[derive(Clone)]
pub(crate) struct WeakCore(std::sync::Weak<Inner>);

impl WeakCore {
    pub(crate) fn upgrade(&self) -> Option<AppCore> {
        self.0.upgrade().map(|inner| AppCore { inner })
    }

    /// A handle whose core is gone.
    #[cfg(test)]
    pub(crate) fn none() -> WeakCore {
        WeakCore(std::sync::Weak::new())
    }
}

struct Inner {
    prefs: JsonStore<Prefs>,
    clusters: JsonStore<HashMap<ClusterId, ClusterSettings>>,
    hotbar: JsonStore<Vec<ClusterId>>,
    /// The exec commands the user allowed, by cluster. Changed only by its own calls,
    /// never with a cluster's settings, which the window replaces whole.
    exec_consents: JsonStore<HashMap<ClusterId, ExecConsent>>,
    folders: JsonStore<CatalogFolders>,
    tunnels: JsonStore<Vec<crate::tunnels::model::TunnelDef>>,
    windows: Windows,
    ui_state: UiState,
    pasted: PastedConfigs,
    connections: Arc<ClusterManager>,
    watches: Arc<WatchHub>,
    graphs: Arc<GraphHub>,
    topologies: Arc<TopologyHub>,
    reachabilities: Arc<ReachabilityHub>,
    drains: DashMap<(ClusterId, String), RunningDrain>,
    next_drain: AtomicU64,
    /// The create runs of client-certificate users, by run id.
    cert_users: DashMap<String, RunningCertUser>,
    next_cert_user: AtomicU64,
    /// The discovery run of each cluster, shared by its `refresh` callers.
    discoveries: DashMap<ClusterId, Arc<SingleFlight<Vec<ApiResourceInfo>>>>,
    sessions: Arc<SessionRegistry>,
    /// The running chats and the stored ones (agents spec §4.8).
    chats: crate::agents::chat::Chats,
    home: PathBuf,
    /// The app's data folder; agents keep their folders and run folders under it.
    data: PathBuf,
    portforwards: Arc<PortForwards>,
    tools: Tools,
    helm: Helm,
    metrics: Metrics,
    /// The passwords and tokens of metrics URLs (spec §10).
    secrets: Secrets,
    tunnel_secrets: crate::tunnels::secrets::TunnelSecrets,
    tunnel_runtime: crate::tunnels::runtime::TunnelRuntime,
    /// The API docs read from each cluster, until it disconnects (spec L5).
    api_docs: ApiDocs,
    /// Held across a preferences write and the matching source change, so
    /// concurrent calls cannot leave the sync on sources that were not saved last.
    sync: Mutex<Option<KubeconfigSync>>,
    snapshots: watch::Receiver<SyncSnapshot>,
    sync_events: Mutex<Option<JoinHandle<()>>>,
    events: broadcast::Sender<CoreEvent>,
    startup_warnings: Mutex<Vec<StoreWarning>>,
    /// The in-app updates (in-app update spec §5.1).
    updates: Updates,
    /// The steps of the app's quit, once it has begun.
    quit: QuitWatch,
    /// The agents' probe results of this app run (agents spec §4.2).
    agent_probes: AgentProbes,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Opens the preferences and returns the sources to sync. First run means the
/// file was absent or unusable; a saved list, even an empty one, is respected.
/// A file that could not be moved aside may still hold the saved sources, so the
/// defaults then apply to this session only and nothing is written over it.
fn open_prefs(
    paths: &AppPaths,
    kubeconfig_env: Option<&OsStr>,
    warnings: &mut Vec<StoreWarning>,
) -> (JsonStore<Prefs>, Vec<SyncSource>) {
    let path = paths.config.join(PREFS_FILE);
    let absent = !path.exists();
    let (prefs, warning) = JsonStore::<Prefs>::open(path.clone(), STORE_VERSION);
    let first_run = absent || warning.is_some();
    warnings.extend(warning);
    if !first_run {
        let sources = prefs.get().sync_sources;
        return (prefs, sources);
    }
    let sources = default_sources(&paths.home, kubeconfig_env);
    // When existence cannot be checked, assume the file is there.
    if path.try_exists().unwrap_or(true) {
        return (prefs, sources);
    }
    if let Err(e) = prefs.update(|p| p.sync_sources = sources.clone()) {
        warnings.push(StoreWarning {
            file: PREFS_FILE.to_owned(),
            message: format!("the default kubeconfig sources could not be saved: {e}"),
        });
    }
    (prefs, sources)
}

/// The folder tree, repaired if someone edited the file into a shape the UI cannot show.
fn open_folders(paths: &AppPaths, warnings: &mut Vec<StoreWarning>) -> JsonStore<CatalogFolders> {
    let store: JsonStore<CatalogFolders> = open_store(paths, CATALOG_FOLDERS_FILE, warnings);
    let loaded = store.get();
    let repaired = loaded.clone().repaired();
    if repaired != loaded {
        tracing::warn!("{CATALOG_FOLDERS_FILE}: repaired a folder tree the UI cannot show");
        // A failed save keeps the repaired tree in memory (P44).
        if let Ok(((), Some(failed))) = store.try_update_kept(|all| {
            *all = repaired;
            Ok(())
        }) {
            warnings.push(failed);
        }
    }
    store
}

fn open_store<T>(paths: &AppPaths, file: &str, warnings: &mut Vec<StoreWarning>) -> JsonStore<T>
where
    T: Serialize + serde::de::DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    let (store, warning) = JsonStore::open(paths.config.join(file), STORE_VERSION);
    warnings.extend(warning);
    store
}

/// Pasted files come first, so they stay `Pasted` when a user source overlaps them.
fn all_sources(pasted: &PastedConfigs, sources: Vec<SyncSource>) -> Vec<SyncSource> {
    let mut all = vec![pasted.source()];
    all.extend(sources);
    all
}

/// Turns sync snapshots into events until the sync stops, and disconnects
/// clusters that left the catalog.
async fn publish_sync_changes(
    mut snapshots: watch::Receiver<SyncSnapshot>,
    events: broadcast::Sender<CoreEvent>,
    connections: Arc<ClusterManager>,
) {
    let mut last = SyncSnapshot::default();
    while snapshots.changed().await.is_ok() {
        let current = snapshots.borrow_and_update().clone();
        // Sending fails only while nobody is subscribed, and they read the current state.
        if current.entries != last.entries {
            connections.disconnect_unlisted(&current.entries);
            let _ = events.send(CoreEvent::CatalogChanged);
        }
        if current.warnings != last.warnings {
            let _ = events.send(CoreEvent::KubeconfigWarnings {
                warnings: current.warnings.clone(),
            });
        }
        last = current;
    }
}

fn source_path(source: &SyncSource) -> &str {
    match source {
        SyncSource::File(path) | SyncSource::Dir(path) => path,
    }
}

impl AppCore {
    /// Reads `KUBECONFIG` from the environment, for use only on first run.
    pub async fn start(paths: AppPaths) -> CoreResult<AppCore> {
        Self::start_with_kubeconfig_env(paths, std::env::var_os("KUBECONFIG")).await
    }

    /// `start` with the `KUBECONFIG` value passed in, so tests never see a real one.
    /// Secrets are kept in memory.
    pub async fn start_with_kubeconfig_env(
        paths: AppPaths,
        kubeconfig_env: Option<OsString>,
    ) -> CoreResult<AppCore> {
        let secrets = Arc::new(MemorySecretStore::default());
        Self::start_with_secret_store(paths, kubeconfig_env, secrets).await
    }

    /// `start_with_kubeconfig_env` with the store that keeps the secrets of metrics URLs:
    /// the app passes the OS keychain.
    pub async fn start_with_secret_store(
        paths: AppPaths,
        kubeconfig_env: Option<OsString>,
        secrets: Arc<dyn SecretStore>,
    ) -> CoreResult<AppCore> {
        Self::start_with_secret_stores(
            paths,
            kubeconfig_env,
            secrets,
            Arc::new(MemorySecretStore::default()),
        )
        .await
    }

    /// As `start_with_secret_store`, with the keychain of tunnel passwords (tunnels spec §5.3).
    pub async fn start_with_secret_stores(
        paths: AppPaths,
        kubeconfig_env: Option<OsString>,
        secrets: Arc<dyn SecretStore>,
        tunnel_secrets: Arc<dyn SecretStore>,
    ) -> CoreResult<AppCore> {
        paths.ensure_dirs()?;
        let (events, _) = broadcast::channel(EVENT_BACKLOG);
        let connections = Arc::new(ClusterManager::start(&paths.data, events.clone()));
        let helm = Helm::new(connections.runtime_dir().to_path_buf());
        let mut warnings = Vec::new();
        let (prefs, sources) = open_prefs(&paths, kubeconfig_env.as_deref(), &mut warnings);
        let clusters = open_store(&paths, CLUSTERS_FILE, &mut warnings);
        let hotbar = open_store(&paths, HOTBAR_FILE, &mut warnings);
        let exec_consents = open_store(&paths, EXEC_CONSENTS_FILE, &mut warnings);
        let folders = open_folders(&paths, &mut warnings);
        let tunnels = open_store(&paths, crate::tunnels::store::TUNNELS_FILE, &mut warnings);
        let (windows, windows_warning) = Windows::open(
            paths.config.join(WINDOWS_FILE),
            STORE_VERSION,
            events.clone(),
        );
        warnings.extend(windows_warning);
        let portforward_definitions = open_store(&paths, PORTFORWARDS_FILE, &mut warnings);
        let (ui_state, ui_warning) = UiState::open(paths.config.join(UI_STATE_FILE), STORE_VERSION);
        warnings.extend(ui_warning);
        let pasted = PastedConfigs::open(&paths.data)?;
        let update_memory: JsonStore<UpdateMemory> =
            open_store(&paths, UPDATES_FILE, &mut warnings);
        let updates = Updates::new(update_memory, events.clone(), env!("CARGO_PKG_VERSION"));

        let (sync, snapshots) = KubeconfigSync::start(all_sources(&pasted, sources), SYNC_POLL);
        let sync_events = tokio::spawn(publish_sync_changes(
            snapshots.clone(),
            events.clone(),
            connections.clone(),
        ));

        let core = AppCore {
            inner: Arc::new(Inner {
                prefs,
                clusters,
                hotbar,
                exec_consents,
                folders,
                tunnels,
                windows,
                ui_state,
                pasted,
                connections,
                watches: Arc::new(WatchHub::default()),
                graphs: Arc::new(GraphHub::default()),
                topologies: Arc::new(TopologyHub::default()),
                reachabilities: Arc::new(ReachabilityHub::default()),
                drains: DashMap::new(),
                next_drain: AtomicU64::new(1),
                cert_users: DashMap::new(),
                next_cert_user: AtomicU64::new(1),
                discoveries: DashMap::new(),
                sessions: Arc::new(SessionRegistry::default()),
                chats: crate::agents::chat::Chats::new(&paths.data),
                home: paths.home.clone(),
                data: paths.data.clone(),
                portforwards: Arc::new(PortForwards::new(portforward_definitions, events.clone())),
                tools: Tools::new(&paths.data),
                helm,
                metrics: Metrics::default(),
                secrets: Secrets::new(secrets),
                tunnel_secrets: crate::tunnels::secrets::TunnelSecrets::new(tunnel_secrets),
                tunnel_runtime: crate::tunnels::runtime::TunnelRuntime::new(
                    tokio::runtime::Handle::current(),
                ),
                api_docs: ApiDocs::default(),
                sync: Mutex::new(Some(sync)),
                snapshots,
                sync_events: Mutex::new(Some(sync_events)),
                events,
                startup_warnings: Mutex::new(warnings),
                updates,
                quit: QuitWatch::default(),
                agent_probes: AgentProbes::default(),
            }),
        };
        // Before anything connects (tunnels spec §5.4).
        let migrating = core.clone();
        let moved = crate::blocking::blocking(move || Ok(migrating.migrate_proxy_urls())).await?;
        lock(&core.inner.startup_warnings).extend(moved);
        Ok(core)
    }

    /// Nobody may be subscribed yet; subscribers read the current state when they start.
    pub(crate) fn emit(&self, event: CoreEvent) {
        let _ = self.inner.events.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.inner.events.subscribe()
    }

    /// The steps of the app's quit, and its watch.
    pub fn quit(&self) -> &QuitWatch {
        &self.inner.quit
    }

    /// Store problems found while starting. They cannot be sent as events,
    /// which are lost until something subscribes. Later calls return nothing.
    pub fn take_startup_warnings(&self) -> Vec<StoreWarning> {
        std::mem::take(&mut *lock(&self.inner.startup_warnings))
    }

    pub fn catalog_list(&self) -> Vec<ClusterEntry> {
        let contexts = self.inner.snapshots.borrow().entries.clone();
        let allowed = self.inner.exec_consents.get();
        build_entries(
            contexts,
            &self.inner.clusters.get(),
            &self.inner.pasted,
            |id| self.inner.connections.state(id),
            |id| allowed.contains_key(id),
        )
    }

    pub fn catalog_warnings(&self) -> Vec<SyncWarning> {
        self.inner.snapshots.borrow().warnings.clone()
    }

    pub fn catalog_add_pasted(&self, yaml: &str) -> CoreResult<Vec<ClusterId>> {
        self.inner.pasted.add(yaml)
    }

    /// Also deletes the secret of the cluster's metrics URL (spec I50).
    pub fn catalog_remove_pasted(&self, id: &ClusterId) -> CoreResult<()> {
        if self.inner.pasted.remove(id)? {
            self.inner.secrets.delete(id);
            self.catalog_folders_forget(id);
            // A consent left behind is harmless: it fits only the same file and context.
            let _ = self.inner.exec_consents.update(|all| {
                all.remove(id);
            });
            return Ok(());
        }
        // A pasted entry can still be listed here until the sync catches up.
        let synced = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .any(|entry| entry.id == *id && !self.inner.pasted.holds(&entry.source_path));
        Err(if synced {
            IpcError::new(
                ErrorCode::InvalidInput,
                "only pasted clusters can be removed from the catalog",
            )
        } else {
            IpcError::new(ErrorCode::NotFound, format!("no pasted cluster {id}"))
        })
    }

    /// Whether the catalog lists `id` right now.
    pub(crate) fn catalog_lists(&self, id: &ClusterId) -> bool {
        self.inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .any(|entry| entry.id == *id)
    }

    pub(crate) fn folders(&self) -> &JsonStore<CatalogFolders> {
        &self.inner.folders
    }

    pub(crate) fn tunnels_store(&self) -> &JsonStore<Vec<crate::tunnels::model::TunnelDef>> {
        &self.inner.tunnels
    }

    pub(crate) fn cluster_settings_store(&self) -> &JsonStore<HashMap<ClusterId, ClusterSettings>> {
        &self.inner.clusters
    }

    /// The catalog's contexts as the last sync saw them.
    // Used by the consumers of the next tasks.
    #[allow(dead_code)]
    pub(crate) fn context_entries(&self) -> Vec<ContextEntry> {
        self.inner.snapshots.borrow().entries.clone()
    }

    pub(crate) fn windows(&self) -> &Windows {
        &self.inner.windows
    }

    pub fn ui_state_get(&self, key: &str) -> Option<serde_json::Value> {
        self.inner.ui_state.get(key)
    }

    pub fn ui_state_set(&self, key: &str, value: serde_json::Value) -> CoreResult<()> {
        self.inner.ui_state.set(key, value)
    }

    pub(crate) fn ui_state_remove(&self, key: &str) -> CoreResult<()> {
        self.inner.ui_state.remove(key)
    }

    pub fn cluster_settings_get(&self, id: &ClusterId) -> ClusterSettings {
        self.inner
            .clusters
            .get()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    /// A metrics setting that needs no password or token deletes the saved one (spec I50).
    /// The agent settings are tidied, or refused, as `ClusterAgentSettings::normalized` says.
    pub fn cluster_settings_set(&self, id: &ClusterId, mut s: ClusterSettings) -> CoreResult<()> {
        s.metrics_provider = s.metrics_provider.normalized()?;
        s.agent = s.agent.normalized()?;
        let metrics_changed = self.cluster_settings_get(id).metrics_provider != s.metrics_provider;
        let needs_secret = s.metrics_provider.needs_secret();
        self.inner.clusters.update(|all| {
            all.insert(id.clone(), s);
        })?;
        // A save reads a URL's certificate files again.
        self.metrics().forget_remote(id);
        if !needs_secret {
            self.inner.secrets.delete(id);
        }
        if metrics_changed {
            self.metrics().forget(id);
        }
        // Entries carry the display name and icon.
        let _ = self.inner.events.send(CoreEvent::CatalogChanged);
        Ok(())
    }

    /// Changes one cluster's saved settings with none of `cluster_settings_set`'s side
    /// effects: no event, and the metrics caches and the keychain are left alone.
    pub(crate) fn cluster_settings_update(
        &self,
        id: &ClusterId,
        f: impl FnOnce(&mut ClusterSettings),
    ) -> CoreResult<()> {
        self.inner.clusters.try_update(|all| {
            f(all.entry(id.clone()).or_default());
            Ok(())
        })
    }

    /// The pinned clusters in the catalog right now. Others stay saved, so a
    /// pin survives its file being briefly gone.
    pub fn hotbar_get(&self) -> Vec<ClusterId> {
        let listed: HashSet<ClusterId> = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        let mut pinned = self.inner.hotbar.get();
        pinned.retain(|id| listed.contains(id));
        pinned
    }

    pub fn hotbar_set(&self, ids: Vec<ClusterId>) -> CoreResult<()> {
        let listed: HashSet<ClusterId> = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        // Pins the catalog does not list right now are kept, at their relative positions.
        self.inner.hotbar.update(|stored| {
            let mut merged = ids;
            let mut anchor: Option<ClusterId> = None;
            for id in stored.iter() {
                if listed.contains(id) || merged.contains(id) {
                    if merged.contains(id) {
                        anchor = Some(id.clone());
                    }
                    continue;
                }
                let at = anchor
                    .as_ref()
                    .and_then(|a| merged.iter().position(|m| m == a))
                    .map_or(0, |i| i + 1);
                merged.insert(at, id.clone());
                anchor = Some(id.clone());
            }
            *stored = merged;
        })?;
        Ok(())
    }

    /// Idempotent, and concurrent calls join one attempt. A failed attempt is
    /// `Ok(Failed)`; the error case is an id the catalog does not list.
    pub async fn cluster_connect(&self, id: &ClusterId) -> CoreResult<ConnectionState> {
        let entry = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .find(|entry| entry.id == *id)
            .cloned()
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("no cluster {id}")))?;
        let settings = self.cluster_settings_get(id);
        let allowed = self
            .inner
            .exec_consents
            .get()
            .get(id)
            .map(|consent| consent.fingerprint.clone());
        let route = self.cluster_route(id)?;
        Ok(self
            .inner
            .connections
            .connect(entry, settings, allowed, route)
            .await)
    }

    /// What the last blocked connect refused to run, for the consent dialog.
    pub fn cluster_exec_request(&self, id: &ClusterId) -> CoreResult<ExecRequest> {
        self.inner
            .connections
            .held_exec(id)
            .map(|held| held.summary())
            .ok_or_else(|| {
                IpcError::new(
                    ErrorCode::NotFound,
                    format!("no exec command is waiting for cluster {id}"),
                )
            })
    }

    /// The held request `request_id`. Another attempt since then makes it a `Conflict`,
    /// so nobody acts on something other than what they were shown.
    fn held_exec(&self, id: &ClusterId, request_id: u32) -> CoreResult<HeldExec> {
        self.inner
            .connections
            .held_exec(id)
            .filter(|held| held.request_id == request_id)
            .ok_or_else(|| {
                IpcError::new(
                    ErrorCode::Conflict,
                    "the kubeconfig was read again since this was shown; review it again",
                )
            })
    }

    /// Remembers the held request's fingerprint for the cluster. It does not connect.
    pub fn cluster_exec_allow(&self, id: &ClusterId, request_id: u32) -> CoreResult<()> {
        let held = self.held_exec(id, request_id)?;
        let fingerprint = held.command.fingerprint;
        self.inner.exec_consents.update(|all| {
            all.insert(id.clone(), ExecConsent { fingerprint });
        })?;
        // Entries say whether their exec command is allowed.
        let _ = self.inner.events.send(CoreEvent::CatalogChanged);
        Ok(())
    }

    /// The arguments and environment of the held request `request_id`.
    pub fn cluster_exec_request_details(
        &self,
        id: &ClusterId,
        request_id: u32,
    ) -> CoreResult<ExecRequestDetails> {
        Ok(self.held_exec(id, request_id)?.details())
    }

    /// Takes the consent back. The cluster is disconnected too: a live connection
    /// would run the program again whenever its credential expires.
    pub async fn cluster_exec_forget(&self, id: &ClusterId) -> CoreResult<()> {
        self.inner.exec_consents.update(|all| {
            all.remove(id);
        })?;
        self.cluster_disconnect(id).await?;
        let _ = self.inner.events.send(CoreEvent::CatalogChanged);
        Ok(())
    }

    pub async fn cluster_disconnect(&self, id: &ClusterId) -> CoreResult<()> {
        self.inner.connections.disconnect(id);
        self.inner.api_docs.forget(id);
        Ok(())
    }

    pub fn cluster_state(&self, id: &ClusterId) -> ConnectionState {
        self.inner.connections.state(id)
    }

    pub fn cluster_log(&self, id: &ClusterId) -> Vec<ConnectionLogEntry> {
        self.inner.connections.log(id)
    }

    pub fn cluster_client(&self, id: &ClusterId) -> CoreResult<kube::Client> {
        self.inner.connections.client(id)
    }

    pub(crate) fn cluster_server_url(&self, id: &ClusterId) -> CoreResult<String> {
        self.inner.connections.server_url(id)
    }

    pub fn cluster_kubeconfig_path(&self, id: &ClusterId) -> CoreResult<PathBuf> {
        self.inner.connections.kubeconfig_path(id)
    }

    /// Writes a single-context kubeconfig for a catalog cluster from its source file, for a
    /// chat's kubeconfig. It needs no connection, so a chat can start while the cluster is
    /// offline. A kubeconfig that runs a command for its credentials is kept only when the
    /// person allowed exactly that command, as a connect requires; otherwise the file is removed
    /// and the answer is `false`.
    pub(crate) fn cluster_chat_kubeconfig(&self, id: &ClusterId, dest: &Path) -> CoreResult<bool> {
        let entry = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .find(|entry| entry.id == *id)
            .cloned()
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("no cluster {id}")))?;
        let tunnel = self.cluster_tunnel(id);
        let gateway = tunnel
            .as_ref()
            .map(|def| self.tunnel_url(def))
            .transpose()?;
        crate::kubeconfig::extract_context(
            Path::new(&entry.source_path),
            &entry.context_name,
            dest,
        )?;
        let Ok(kubeconfig) = Kubeconfig::read_from(dest) else {
            let _ = std::fs::remove_file(dest);
            // The parser's message can quote the file, so it is not passed on.
            return Err(IpcError::new(
                ErrorCode::InvalidInput,
                format!("cannot read the kubeconfig of {}", entry.context_name),
            ));
        };
        if let Some(url) = &gateway {
            if let Err(e) = crate::cluster::write_proxy_url(dest, url.expose()) {
                let _ = std::fs::remove_file(dest);
                return Err(e);
            }
        }
        // The approval covers the tunnel's target, not this run's gateway URL (spec §5.7).
        let trust = tunnel
            .as_ref()
            .map(|def| crate::cluster::with_proxy_url(&kubeconfig, &def.kind.trust_marker()));
        let Some(command) = exec_command(trust.as_ref().unwrap_or(&kubeconfig)) else {
            return Ok(true);
        };
        let allowed = self
            .inner
            .exec_consents
            .get()
            .get(id)
            .is_some_and(|consent| consent.fingerprint == command.fingerprint);
        if !allowed {
            let _ = std::fs::remove_file(dest);
        }
        Ok(allowed)
    }

    pub fn cluster_cancel_token(&self, id: &ClusterId) -> CoreResult<CancellationToken> {
        self.inner.connections.cancel_token(id)
    }

    pub fn cluster_discovery(&self, id: &ClusterId) -> CoreResult<Arc<kube::Discovery>> {
        self.inner.connections.discovery(id)
    }

    pub(crate) fn connections(&self) -> &ClusterManager {
        &self.inner.connections
    }

    pub(crate) fn watches(&self) -> &Arc<WatchHub> {
        &self.inner.watches
    }

    pub(crate) fn graphs(&self) -> &Arc<GraphHub> {
        &self.inner.graphs
    }

    pub(crate) fn topologies(&self) -> &Arc<TopologyHub> {
        &self.inner.topologies
    }

    pub(crate) fn reachabilities(&self) -> &Arc<ReachabilityHub> {
        &self.inner.reachabilities
    }

    pub(crate) fn drains(&self) -> &DashMap<(ClusterId, String), RunningDrain> {
        &self.inner.drains
    }

    pub(crate) fn next_drain_id(&self) -> String {
        let number = self.inner.next_drain.fetch_add(1, Ordering::Relaxed);
        format!("drain-{number}")
    }

    pub(crate) fn cert_users(&self) -> &DashMap<String, RunningCertUser> {
        &self.inner.cert_users
    }

    pub(crate) fn next_cert_user_id(&self) -> String {
        let number = self.inner.next_cert_user.fetch_add(1, Ordering::Relaxed);
        format!("cert-user-{number}")
    }

    pub(crate) fn portforwards(&self) -> &Arc<PortForwards> {
        &self.inner.portforwards
    }

    pub(crate) fn home_dir(&self) -> &Path {
        &self.inner.home
    }

    /// The app's data folder.
    pub(crate) fn data_dir(&self) -> &Path {
        &self.inner.data
    }

    pub(crate) fn tools(&self) -> &Tools {
        &self.inner.tools
    }

    pub(crate) fn helm(&self) -> &Helm {
        &self.inner.helm
    }

    pub(crate) fn updates(&self) -> &Updates {
        &self.inner.updates
    }

    /// Starts the in-app updates with the app's source (in-app update spec §5.1).
    /// `automatic` is false in debug and e2e builds. Call it inside the Tokio runtime.
    pub fn updates_start(&self, source: Arc<dyn UpdateSource>, automatic: bool) {
        // Weak: the scheduler must not keep the core alive.
        let core = Arc::downgrade(&self.inner);
        let toast_window = move || {
            core.upgrade().map_or_else(
                || MAIN_WINDOW.to_owned(),
                |inner| AppCore { inner }.window_last_focused(),
            )
        };
        self.inner.updates.start(
            source,
            automatic,
            self.inner.prefs.subscribe(),
            toast_window,
        );
    }

    /// A Microsoft Store copy: no update source and no checks (Store spec §3). Called by the
    /// app instead of `updates_start`.
    pub fn updates_start_store_managed(&self) {
        self.inner.updates.start_store_managed();
    }

    /// Where `resources_discover(refresh)` calls of this cluster share their runs.
    pub(crate) fn discovery_flight(
        &self,
        id: &ClusterId,
    ) -> Arc<SingleFlight<Vec<ApiResourceInfo>>> {
        Arc::clone(
            self.inner
                .discoveries
                .entry(id.clone())
                .or_insert_with(|| Arc::new(SingleFlight::new()))
                .value(),
        )
    }

    pub(crate) fn metrics(&self) -> &Metrics {
        &self.inner.metrics
    }

    pub(crate) fn secrets(&self) -> &Secrets {
        &self.inner.secrets
    }

    pub(crate) fn tunnel_secrets(&self) -> &crate::tunnels::secrets::TunnelSecrets {
        &self.inner.tunnel_secrets
    }

    pub(crate) fn tunnel_runtime(&self) -> &crate::tunnels::runtime::TunnelRuntime {
        &self.inner.tunnel_runtime
    }

    pub(crate) fn downgrade(&self) -> WeakCore {
        WeakCore(Arc::downgrade(&self.inner))
    }

    pub(crate) fn api_docs(&self) -> &ApiDocs {
        &self.inner.api_docs
    }

    pub(crate) fn sessions(&self) -> &Arc<SessionRegistry> {
        &self.inner.sessions
    }

    pub(crate) fn chats(&self) -> &crate::agents::chat::Chats {
        &self.inner.chats
    }

    pub(crate) fn agent_probes(&self) -> &AgentProbes {
        &self.inner.agent_probes
    }

    pub fn set_connect_timeouts_for_test(&self, t: ConnectTimeouts) {
        self.inner.connections.set_timeouts(t);
    }

    /// Shortens the 30 s that `resources_names` keeps an answer.
    pub fn set_names_ttl_for_test(&self, ttl: Duration) {
        self.inner.connections.set_names_ttl(ttl);
    }

    pub fn prefs_get(&self) -> Prefs {
        self.inner.prefs.get()
    }

    /// Changes the saved preferences in place; an error from `f` leaves them as they were.
    /// For the fields the kubeconfig sync does not read, such as the agent settings.
    pub(crate) fn prefs_try_update<R>(
        &self,
        f: impl FnOnce(&mut Prefs) -> CoreResult<R>,
    ) -> CoreResult<R> {
        self.inner.prefs.try_update(f)
    }

    /// Saves `p` and applies its sync sources immediately. The agent settings stay as
    /// saved: only the agent calls change them, so a page that read the preferences before
    /// one of those calls cannot undo it.
    pub fn prefs_set(&self, p: Prefs) -> CoreResult<()> {
        let p = p.normalized()?;
        // Cluster ids hash the path, so a relative one would change between launches.
        if let Some(path) = p
            .sync_sources
            .iter()
            .map(source_path)
            .find(|path| !Path::new(path).is_absolute())
        {
            return Err(IpcError::new(
                ErrorCode::InvalidInput,
                format!("a kubeconfig source must be an absolute path: {path}"),
            ));
        }
        let sync = lock(&self.inner.sync);
        let sources = p.sync_sources.clone();
        self.inner.prefs.update(|prefs| {
            let agents = std::mem::take(&mut prefs.agents);
            *prefs = Prefs { agents, ..p };
        })?;
        if let Some(sync) = sync.as_ref() {
            sync.set_sources(all_sources(&self.inner.pasted, sources));
        }
        Ok(())
    }

    /// Stops every session and waits for their cleanup, which a node shell needs the
    /// network for. Then disconnects every cluster and stops background work. The last
    /// snapshot stays readable.
    pub async fn shutdown(&self) {
        let quit = &self.inner.quit;
        self.inner.updates.stop();
        self.sessions_stop_all();
        quit.step("updates and sessions asked to stop");
        if !self.sessions_wait_idle(SHUTDOWN_LIMIT).await {
            tracing::warn!("some sessions did not stop within {SHUTDOWN_LIMIT:?}");
        }
        quit.step("sessions idle");
        self.inner.connections.disconnect_all();
        quit.step("clusters disconnected");
        self.ssh_stop_all().await;
        quit.step("ssh tunnels stopped");
        let sync = lock(&self.inner.sync).take();
        let sync_events = lock(&self.inner.sync_events).take();
        let stopped = async {
            if let Some(sync) = sync {
                // Stopping joins a thread, which must not block the runtime.
                let _ = tokio::task::spawn_blocking(move || sync.stop()).await;
            }
            if let Some(sync_events) = sync_events {
                let _ = sync_events.await;
            }
        };
        if tokio::time::timeout(SHUTDOWN_LIMIT, stopped).await.is_err() {
            tracing::warn!("the kubeconfig sync did not stop within {SHUTDOWN_LIMIT:?}");
        }
        quit.step("kubeconfig sync stopped");
    }
}
