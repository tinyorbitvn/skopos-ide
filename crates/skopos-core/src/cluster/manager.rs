//! One handle per cluster, holding its state, log and live connection.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use kube::config::Kubeconfig;
use kube::{Client, Discovery};
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::connect::{
    connect_limit, establish, prepare_kubeconfig, run_discovery, with_proxy_url, ConnectTimeouts,
    Established, Failure, Prepared, ProxyOrigin,
};
use super::exec_command::{exec_command, ExecCommand, ExecEnvVar, ExecRequest, ExecRequestDetails};
use super::state::{ConnectionState, FailureKind};
use crate::app_core::CoreEvent;
use crate::error::{sanitize_text, CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{ClusterId, ContextEntry};
use crate::paths::create_private_dir;
use crate::prefs::ClusterSettings;
use crate::resources::{ApiResourceInfo, ObjectNames, NAMES_TTL};
use crate::tunnels::route::TunnelRoute;

const RUNTIME_DIR: &str = "runtime";
const LOG_CAPACITY: usize = 500;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionLogEntry {
    #[ts(type = "number")]
    pub ts_ms: i64,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_connected(id: &ClusterId) -> IpcError {
    IpcError::new(
        ErrorCode::Unreachable,
        format!("cluster {id} is not connected"),
    )
}

fn remove_kubeconfig(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("cannot delete {}: {e}", path.display());
        }
    }
}

/// Files left by a crash hold credentials. A failure here must not stop the app,
/// and writing the per-context file later reports its own errors.
fn reset_runtime_dir(dir: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("cannot clear {}: {e}", dir.display());
        }
    }
    if let Err(e) = create_private_dir(dir) {
        tracing::warn!("cannot create {}: {e}", dir.display());
    }
}

struct Live {
    client: Client,
    discovery: Arc<Discovery>,
    /// The kubeconfig's server URL for the context.
    server: Option<String>,
    /// Where the `proxy-url` of `{id}.yaml` came from, for exports.
    proxy_origin: ProxyOrigin,
    /// Told apart from the connection that replaces this one, so a late result
    /// of the old one is not stored.
    epoch: u64,
    /// Dropped with the connection, so a reconnect starts without it.
    resources: Option<Arc<Vec<ApiResourceInfo>>>,
    /// The palette's names and when they were read. Dropped with the connection.
    names: Option<(Instant, Arc<ObjectNames>)>,
}

static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

static NEXT_EXEC_REQUEST: AtomicU32 = AtomicU32::new(1);

/// What a blocked attempt refused to run, kept for the consent dialog. In memory only.
#[derive(Debug, Clone)]
pub(crate) struct HeldExec {
    pub(crate) request_id: u32,
    pub(crate) command: ExecCommand,
    /// A consent for another fingerprint existed.
    pub(crate) changed: bool,
    pub(crate) source_path: String,
    pub(crate) context_name: String,
}

impl HeldExec {
    /// What the window may show without being asked: no argument, no environment value.
    pub(crate) fn summary(&self) -> ExecRequest {
        ExecRequest {
            request_id: self.request_id,
            kind: self.command.kind,
            command: self.command.command.clone(),
            arg_count: u32::try_from(self.command.args.len()).unwrap_or(u32::MAX),
            env_names: self
                .command
                .env
                .iter()
                .map(|(name, _)| name.clone())
                .collect(),
            server: self.command.server.clone(),
            source_path: self.source_path.clone(),
            context_name: self.context_name.clone(),
            changed: self.changed,
        }
    }

    /// Everything that would run. Sent only when the user asks to see it.
    pub(crate) fn details(&self) -> ExecRequestDetails {
        ExecRequestDetails {
            args: self.command.args.clone(),
            env: self
                .command
                .env
                .iter()
                .map(|(name, value)| ExecEnvVar {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
        }
    }

    /// The failure of the attempt that was blocked. It names the command only.
    fn failure(&self) -> Failure {
        let command = &self.command.command;
        let message = if self.changed {
            format!(
                "The program this kubeconfig runs for credentials (\"{command}\"), the \
                 cluster address or its TLS and proxy settings changed since you allowed it."
            )
        } else {
            format!(
                "This kubeconfig runs \"{command}\" to get credentials, \
                 and you have not allowed that yet."
            )
        };
        Failure::new(FailureKind::ExecNotAllowed, message)
    }
}

/// What the kubeconfig would run, unless the user allowed exactly that.
fn refused_exec(
    kubeconfig: &Kubeconfig,
    entry: &ContextEntry,
    allowed: Option<&str>,
) -> Option<HeldExec> {
    let command = exec_command(kubeconfig)?;
    if allowed == Some(command.fingerprint.as_str()) {
        return None;
    }
    Some(HeldExec {
        request_id: NEXT_EXEC_REQUEST.fetch_add(1, Ordering::Relaxed),
        command,
        changed: allowed.is_some(),
        source_path: entry.source_path.clone(),
        context_name: entry.context_name.clone(),
    })
}

struct Shared {
    log: VecDeque<ConnectionLogEntry>,
    /// Replaced for each attempt, since a cancelled token stays cancelled.
    token: CancellationToken,
    live: Option<Live>,
    /// What the last attempt refused to run. The next attempt and a disconnect drop it.
    held_exec: Option<HeldExec>,
}

impl Shared {
    fn push_log(&mut self, level: LogLevel, message: String) {
        if self.log.len() == LOG_CAPACITY {
            self.log.pop_front();
        }
        self.log.push_back(ConnectionLogEntry {
            ts_ms: now_ms(),
            level,
            message,
        });
    }
}

pub(crate) struct ClusterHandle {
    id: ClusterId,
    kubeconfig_path: PathBuf,
    events: broadcast::Sender<CoreEvent>,
    /// Held by a running attempt. A cancelled attempt can still be writing the
    /// kubeconfig, so the next one waits for it rather than racing it for the file.
    attempt: tokio::sync::Mutex<()>,
    /// Written only while `shared` is locked, so that cancelling and a late
    /// completion cannot interleave and events go out in state order.
    state: watch::Sender<ConnectionState>,
    shared: Mutex<Shared>,
}

impl ClusterHandle {
    fn new(id: &ClusterId, runtime_dir: &Path, events: broadcast::Sender<CoreEvent>) -> Self {
        Self {
            id: id.clone(),
            kubeconfig_path: runtime_dir.join(format!("{id}.yaml")),
            events,
            attempt: tokio::sync::Mutex::new(()),
            state: watch::Sender::new(ConnectionState::Disconnected),
            shared: Mutex::new(Shared {
                log: VecDeque::new(),
                token: CancellationToken::new(),
                live: None,
                held_exec: None,
            }),
        }
    }

    pub(crate) fn log(&self, level: LogLevel, message: impl Into<String>) {
        lock(&self.shared).push_log(level, sanitize_text(&message.into()));
    }

    /// Takes the guard to show that `shared` is locked.
    fn set_state(&self, _shared: &mut MutexGuard<'_, Shared>, state: ConnectionState) {
        self.state.send_replace(state.clone());
        // Sending fails only while nobody is subscribed, and they read the current state.
        let _ = self.events.send(CoreEvent::ClusterState {
            id: self.id.clone(),
            state,
        });
    }

    /// Moves to `Connecting` and returns the new attempt's token, or `None` when
    /// there is already an attempt or a connection for the caller to share.
    fn begin_attempt(&self) -> Option<CancellationToken> {
        let mut shared = lock(&self.shared);
        let idle = matches!(
            *self.state.borrow(),
            ConnectionState::Disconnected | ConnectionState::Failed { .. }
        );
        if !idle {
            return None;
        }
        let token = CancellationToken::new();
        shared.token = token.clone();
        shared.held_exec = None;
        self.set_state(&mut shared, ConnectionState::Connecting);
        Some(token)
    }

    /// Waits for the current attempt, if any, to end.
    async fn settled(&self) -> ConnectionState {
        let mut state = self.state.subscribe();
        let settled = state
            .wait_for(|state| *state != ConnectionState::Connecting)
            .await;
        // `self` keeps the sender alive, so this cannot fail.
        settled.map_or(ConnectionState::Disconnected, |state| state.clone())
    }

    fn finish_attempt(
        &self,
        token: &CancellationToken,
        outcome: Result<Established, Failure>,
        held_exec: Option<HeldExec>,
    ) {
        let mut shared = lock(&self.shared);
        // Disconnect already set the state. It cannot have deleted a file written
        // after it ran, and the next attempt waits for this one, so the file is ours.
        if token.is_cancelled() {
            remove_kubeconfig(&self.kubeconfig_path);
            return;
        }
        // Set with the state, so the request is there when the window hears of the failure.
        shared.held_exec = held_exec;
        let state = match outcome {
            Ok(established) => {
                shared.live = Some(Live {
                    client: established.client,
                    discovery: established.discovery,
                    server: established.server,
                    proxy_origin: established.proxy_origin,
                    epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
                    resources: None,
                    names: None,
                });
                shared.push_log(LogLevel::Info, "connected".to_owned());
                ConnectionState::Connected {
                    info: established.info,
                }
            }
            Err(failure) => {
                remove_kubeconfig(&self.kubeconfig_path);
                let detail = failure.detail.as_ref().unwrap_or(&failure.message);
                shared.push_log(LogLevel::Error, detail.clone());
                ConnectionState::Failed {
                    kind: failure.kind,
                    message: failure.message,
                }
            }
        };
        self.set_state(&mut shared, state);
    }

    fn disconnect(&self) {
        let mut shared = lock(&self.shared);
        shared.token.cancel();
        shared.live = None;
        shared.held_exec = None;
        // Inside the lock, so it cannot delete the file of an attempt begun after this.
        remove_kubeconfig(&self.kubeconfig_path);
        if *self.state.borrow() != ConnectionState::Disconnected {
            shared.push_log(LogLevel::Info, "disconnected".to_owned());
            self.set_state(&mut shared, ConnectionState::Disconnected);
        }
    }
}

async fn run_attempt(
    handle: Arc<ClusterHandle>,
    token: CancellationToken,
    entry: ContextEntry,
    settings: ClusterSettings,
    allowed: Option<String>,
    timeouts: ConnectTimeouts,
    route: Option<TunnelRoute>,
) {
    let _running = handle.attempt.lock().await;
    if token.is_cancelled() {
        return;
    }
    handle.log(LogLevel::Info, "building client");
    // Not raced against the token: this could otherwise write the file after the
    // attempt ended, leaving credentials behind. It is only stuck on a dead mount,
    // and then disconnecting still works and the next attempt just waits.
    let prepared = {
        let entry = entry.clone();
        let path = handle.kubeconfig_path.clone();
        let proxy = route.as_ref().map(|route| route.url.expose().to_owned());
        tokio::task::spawn_blocking(move || prepare_kubeconfig(&entry, &path, proxy.as_deref()))
            .await
    };
    let mut held_exec = None;
    let outcome = match prepared {
        Ok(Ok(prepared)) => {
            // The approval covers the tunnel's target, not this run's gateway URL (spec §5.7).
            let trust = route
                .as_ref()
                .map(|route| with_proxy_url(&prepared.source, &route.trust_marker()));
            match refused_exec(
                trust.as_ref().unwrap_or(&prepared.source),
                &entry,
                allowed.as_deref(),
            ) {
                // Before `establish`, where `kube` would run the program.
                Some(refused) => {
                    let failure = refused.failure();
                    held_exec = Some(refused);
                    Err(failure)
                }
                None => tokio::select! {
                    biased;
                    () = token.cancelled() => Err(Failure::new(FailureKind::Other, "cancelled")),
                    outcome = establish_routed(
                        &handle,
                        prepared,
                        &entry,
                        &settings,
                        &timeouts,
                        route.as_ref(),
                    ) => outcome,
                },
            }
        }
        Ok(Err(failure)) => Err(failure),
        Err(e) => Err(Failure::new(
            FailureKind::Other,
            format!("reading the kubeconfig failed: {e}"),
        )),
    };
    handle.finish_attempt(&token, outcome, held_exec);
}

/// Probes the tunnel when the cluster has one, then establishes (tunnels spec §5.7).
async fn establish_routed(
    handle: &ClusterHandle,
    prepared: Prepared,
    entry: &ContextEntry,
    settings: &ClusterSettings,
    timeouts: &ConnectTimeouts,
    route: Option<&TunnelRoute>,
) -> Result<Established, Failure> {
    let limit = connect_limit(entry, timeouts);
    let deadline = tokio::time::Instant::now() + limit;
    if let Some(route) = route {
        handle.log(LogLevel::Info, format!("opening tunnel {}", route.name()));
        let probed = tokio::time::timeout_at(deadline, route.probe(entry.server.as_deref()))
            .await
            .unwrap_or_else(|_| Err(format!("timed out after {}s", limit.as_secs())));
        if let Err(reason) = probed {
            return Err(Failure::new(
                FailureKind::Tunnel,
                format!("Tunnel \"{}\": {reason}", route.name()),
            ));
        }
    }
    let proxy = route.map(|route| route.url.expose().to_owned());
    let established = establish(
        handle,
        prepared.source,
        entry,
        settings,
        timeouts,
        proxy.as_deref(),
        deadline,
    )
    .await?;
    Ok(Established {
        proxy_origin: prepared.proxy_origin,
        ..established
    })
}

pub(crate) struct ClusterManager {
    handles: DashMap<ClusterId, Arc<ClusterHandle>>,
    runtime_dir: PathBuf,
    events: broadcast::Sender<CoreEvent>,
    timeouts: Mutex<ConnectTimeouts>,
    names_ttl: Mutex<Duration>,
}

impl ClusterManager {
    /// Removes everything a previous run left under `<data>/runtime/`.
    pub(crate) fn start(data_dir: &Path, events: broadcast::Sender<CoreEvent>) -> Self {
        let runtime_dir = data_dir.join(RUNTIME_DIR);
        reset_runtime_dir(&runtime_dir);
        Self {
            handles: DashMap::new(),
            runtime_dir,
            events,
            timeouts: Mutex::new(ConnectTimeouts::default()),
            names_ttl: Mutex::new(NAMES_TTL),
        }
    }

    /// `<data>/runtime`, emptied at every start.
    pub(crate) fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    fn handle(&self, id: &ClusterId) -> Option<Arc<ClusterHandle>> {
        self.handles.get(id).map(|handle| handle.value().clone())
    }

    fn all_handles(&self) -> Vec<Arc<ClusterHandle>> {
        self.handles
            .iter()
            .map(|handle| handle.value().clone())
            .collect()
    }

    /// Returns once the attempt this call began or joined has ended. The attempt
    /// runs in its own task, so a caller going away neither stops it nor leaves it stuck.
    /// `allowed` is the fingerprint of the exec command the user allowed for this cluster;
    /// `route` is the cluster's tunnel, dropped when this call joins a running attempt.
    pub(crate) async fn connect(
        &self,
        entry: ContextEntry,
        settings: ClusterSettings,
        allowed: Option<String>,
        route: Option<TunnelRoute>,
    ) -> ConnectionState {
        let handle = self
            .handles
            .entry(entry.id.clone())
            .or_insert_with(|| {
                Arc::new(ClusterHandle::new(
                    &entry.id,
                    &self.runtime_dir,
                    self.events.clone(),
                ))
            })
            .value()
            .clone();
        if let Some(token) = handle.begin_attempt() {
            let timeouts = lock(&self.timeouts).clone();
            tokio::spawn(run_attempt(
                handle.clone(),
                token,
                entry,
                settings,
                allowed,
                timeouts,
                route,
            ));
        }
        handle.settled().await
    }

    pub(crate) fn disconnect(&self, id: &ClusterId) {
        if let Some(handle) = self.handle(id) {
            handle.disconnect();
        }
    }

    pub(crate) fn disconnect_all(&self) {
        for handle in self.all_handles() {
            handle.disconnect();
        }
    }

    pub(crate) fn disconnect_unlisted(&self, entries: &[ContextEntry]) {
        let listed: HashSet<&ClusterId> = entries.iter().map(|entry| &entry.id).collect();
        for handle in self.all_handles() {
            if !listed.contains(&handle.id) {
                handle.disconnect();
            }
        }
    }

    pub(crate) fn state(&self, id: &ClusterId) -> ConnectionState {
        self.handle(id)
            .map_or(ConnectionState::Disconnected, |h| h.state.borrow().clone())
    }

    /// What the last blocked attempt for `id` refused to run.
    pub(crate) fn held_exec(&self, id: &ClusterId) -> Option<HeldExec> {
        self.handle(id)
            .and_then(|handle| lock(&handle.shared).held_exec.clone())
    }

    pub(crate) fn log(&self, id: &ClusterId) -> Vec<ConnectionLogEntry> {
        self.handle(id).map_or_else(Vec::new, |handle| {
            lock(&handle.shared).log.iter().cloned().collect()
        })
    }

    pub(crate) fn set_timeouts(&self, timeouts: ConnectTimeouts) {
        *lock(&self.timeouts) = timeouts;
    }

    /// Reads from the connection's live resources, which exist only while connected.
    fn with_live<T>(
        &self,
        id: &ClusterId,
        read: impl FnOnce(&Live, &ClusterHandle, &Shared) -> T,
    ) -> CoreResult<T> {
        let handle = self.handle(id).ok_or_else(|| not_connected(id))?;
        let shared = lock(&handle.shared);
        let live = shared.live.as_ref().ok_or_else(|| not_connected(id))?;
        Ok(read(live, &handle, &shared))
    }

    pub(crate) fn client(&self, id: &ClusterId) -> CoreResult<Client> {
        self.with_live(id, |live, _, _| live.client.clone())
    }

    pub(crate) fn discovery(&self, id: &ClusterId) -> CoreResult<Arc<Discovery>> {
        self.with_live(id, |live, _, _| live.discovery.clone())
    }

    /// The context's server URL from the kubeconfig, `""` when it has none.
    pub(crate) fn server_url(&self, id: &ClusterId) -> CoreResult<String> {
        self.with_live(id, |live, _, _| live.server.clone().unwrap_or_default())
    }

    pub(crate) fn kubeconfig_path(&self, id: &ClusterId) -> CoreResult<PathBuf> {
        self.with_live(id, |_, handle, _| handle.kubeconfig_path.clone())
    }

    /// Where the `proxy-url` of `{id}.yaml` came from (tunnels spec §5.7).
    pub(crate) fn proxy_origin(&self, id: &ClusterId) -> CoreResult<ProxyOrigin> {
        self.with_live(id, |live, _, _| live.proxy_origin.clone())
    }

    /// The connection's identity, for `store_resources`.
    pub(crate) fn epoch(&self, id: &ClusterId) -> CoreResult<u64> {
        self.with_live(id, |live, _, _| live.epoch)
    }

    pub(crate) fn cached_resources(
        &self,
        id: &ClusterId,
    ) -> CoreResult<Option<Arc<Vec<ApiResourceInfo>>>> {
        self.with_live(id, |live, _, _| live.resources.clone())
    }

    /// Runs discovery again on the live client. Nothing is replaced yet.
    pub(crate) async fn rediscover(&self, id: &ClusterId) -> CoreResult<Discovery> {
        let handle = self.handle(id).ok_or_else(|| not_connected(id))?;
        let client = self.client(id)?;
        Ok(run_discovery(&handle, client).await?)
    }

    /// Keeps the result for the connection with this epoch and returns whether
    /// it did. A disconnect or reconnect since the epoch was read drops it.
    pub(crate) fn store_resources(
        &self,
        id: &ClusterId,
        epoch: u64,
        discovery: Option<Discovery>,
        resources: Arc<Vec<ApiResourceInfo>>,
    ) -> bool {
        let Some(handle) = self.handle(id) else {
            return false;
        };
        let mut shared = lock(&handle.shared);
        match shared.live.as_mut() {
            Some(live) if live.epoch == epoch => {
                if let Some(discovery) = discovery {
                    live.discovery = Arc::new(discovery);
                }
                live.resources = Some(resources);
                true
            }
            _ => false,
        }
    }

    pub(crate) fn set_names_ttl(&self, ttl: Duration) {
        *lock(&self.names_ttl) = ttl;
    }

    /// The palette's names read for this connection less than the TTL ago.
    pub(crate) fn cached_names(&self, id: &ClusterId) -> CoreResult<Option<Arc<ObjectNames>>> {
        let ttl = *lock(&self.names_ttl);
        self.with_live(id, |live, _, _| {
            live.names
                .as_ref()
                .filter(|(read_at, _)| read_at.elapsed() < ttl)
                .map(|(_, names)| names.clone())
        })
    }

    /// Keeps the names for the connection with this epoch and returns whether it
    /// did, like `store_resources`.
    pub(crate) fn store_names(&self, id: &ClusterId, epoch: u64, names: Arc<ObjectNames>) -> bool {
        let Some(handle) = self.handle(id) else {
            return false;
        };
        let mut shared = lock(&handle.shared);
        match shared.live.as_mut() {
            Some(live) if live.epoch == epoch => {
                live.names = Some((Instant::now(), names));
                true
            }
            _ => false,
        }
    }

    /// A child of the connection's token: disconnecting cancels it, and whoever
    /// holds it can cancel only their own work.
    pub(crate) fn cancel_token(&self, id: &ClusterId) -> CoreResult<CancellationToken> {
        self.with_live(id, |_, _, shared| shared.token.child_token())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_keeps_the_newest_entries() {
        let (events, _) = broadcast::channel(1);
        let handle = ClusterHandle::new(&"id".to_owned(), Path::new("/nowhere"), events);

        for n in 0..LOG_CAPACITY + 5 {
            handle.log(LogLevel::Info, n.to_string());
        }

        let shared = lock(&handle.shared);
        assert_eq!(shared.log.len(), LOG_CAPACITY);
        assert_eq!(shared.log[0].message, "5");
    }

    #[test]
    fn log_entry_serializes_for_the_ui() {
        let entry = ConnectionLogEntry {
            ts_ms: 7,
            level: LogLevel::Warn,
            message: "m".to_owned(),
        };

        let v = serde_json::to_value(&entry).unwrap();

        assert_eq!(v["tsMs"], 7);
        assert_eq!(v["level"], "warn");
    }
}
