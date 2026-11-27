//! What tunnels hold while the app runs (tunnels spec §5.5, §5.9): the gateway's port, each
//! tunnel's token and state, and the connections it carries.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::model::{TunnelDef, TunnelKind};
use super::state::TunnelState;
use super::store::{gone, TunnelView};
use super::upstream::{DialError, ProxyUpstream, Stream};
use crate::agents::endpoint::{new_token, same_bytes};
use crate::app_core::{AppCore, CoreEvent};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::metrics::MetricsProviderSetting;
use crate::secrets::Secret;

/// How long a proxy tunnel stays `Up` without a new connection or an open one (spec §5.9).
pub(crate) const IDLE_AFTER: Duration = Duration::from_secs(5 * 60);
pub(crate) const NO_PASSWORD: &str =
    "No password is saved for this tunnel: enter it in Preferences › Tunnels";

pub(crate) struct TunnelRuntime {
    runtime: Handle,
    /// The gateway's port, once bound.
    port: Mutex<Option<u16>>,
    /// Each tunnel's token for this run.
    tokens: DashMap<String, Secret>,
    /// Each tunnel's state and when it last changed or was used.
    states: DashMap<String, (TunnelState, Instant)>,
    /// How many gateway connections each tunnel carries.
    open: DashMap<String, Arc<AtomicUsize>>,
    /// Ends a tunnel's gateway connections.
    cancels: DashMap<String, CancellationToken>,
    /// Ends the gateway when the core goes.
    shutdown: CancellationToken,
}

impl Drop for TunnelRuntime {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

/// One gateway connection of a tunnel, counted until dropped.
pub(crate) struct OpenGuard(Arc<AtomicUsize>);

impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl TunnelRuntime {
    pub(crate) fn new(runtime: Handle) -> Self {
        Self {
            runtime,
            port: Mutex::new(None),
            tokens: DashMap::new(),
            states: DashMap::new(),
            open: DashMap::new(),
            cancels: DashMap::new(),
            shutdown: CancellationToken::new(),
        }
    }

    pub(crate) fn cancel_token(&self, id: &str) -> CancellationToken {
        self.cancels.entry(id.to_owned()).or_default().clone()
    }

    pub(crate) fn open_guard(&self, id: &str) -> OpenGuard {
        let count = self.open.entry(id.to_owned()).or_default().clone();
        count.fetch_add(1, Ordering::Relaxed);
        OpenGuard(count)
    }

    fn open_count(&self, id: &str) -> usize {
        self.open
            .get(id)
            .map_or(0, |count| count.load(Ordering::Relaxed))
    }

    /// Ends the tunnel's gateway connections and makes it `Idle`; the next use starts it.
    pub(crate) fn reset(&self, id: &str) {
        if let Some((_, token)) = self.cancels.remove(id) {
            token.cancel();
        }
        self.states.remove(id);
    }

    /// Forgets a deleted tunnel: its token stops working at once.
    pub(crate) fn forget(&self, id: &str) {
        self.reset(id);
        self.tokens.remove(id);
        self.open.remove(id);
    }
}

/// A URL's host, without brackets, and its port or its scheme's default.
pub(crate) fn host_port(url: &str) -> Option<(String, u16)> {
    let parsed = Url::parse(url.trim()).ok()?;
    let host = parsed
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    Some((host, parsed.port_or_known_default()?))
}

impl AppCore {
    /// `U(T)`: the gateway URL with the tunnel's token (spec §5.5). Binds the gateway the
    /// first time; handing out the URL does not start the tunnel.
    pub(crate) fn tunnel_url(&self, def: &TunnelDef) -> CoreResult<Secret> {
        let runtime = self.tunnel_runtime();
        let port = {
            let mut port = runtime.port.lock().unwrap_or_else(|e| e.into_inner());
            match *port {
                Some(bound) => bound,
                None => {
                    let bound = super::gateway::start(
                        self.downgrade(),
                        &runtime.runtime,
                        runtime.shutdown.clone(),
                    )
                    .map_err(|e| {
                        IpcError::new(
                            ErrorCode::Internal,
                            format!("cannot start the tunnel gateway: {e}"),
                        )
                    })?;
                    *port = Some(bound);
                    bound
                }
            }
        };
        let token = runtime
            .tokens
            .entry(def.id.clone())
            .or_insert_with(|| Secret::new(new_token()))
            .clone();
        Ok(Secret::new(format!(
            "http://{}:{}@127.0.0.1:{port}",
            def.id,
            token.expose()
        )))
    }

    /// Whether `token` is this run's token of tunnel `id`, compared in constant time.
    pub(crate) fn tunnel_token_matches(&self, id: &str, token: &str) -> bool {
        self.tunnel_runtime()
            .tokens
            .get(id)
            .is_some_and(|kept| same_bytes(kept.expose().as_bytes(), token.as_bytes()))
    }

    /// The API servers of the clusters that use the tunnel, without metrics hosts.
    fn tunnel_api_targets(&self, id: &str) -> HashSet<(String, u16)> {
        let entries = self.context_entries();
        let mut targets = HashSet::new();
        for (cluster, own) in self.cluster_settings_store().get().iter() {
            if own.tunnel.as_deref() != Some(id) {
                continue;
            }
            let server = entries
                .iter()
                .find(|entry| &entry.id == cluster)
                .and_then(|entry| entry.server.as_deref());
            targets.extend(server.and_then(host_port));
        }
        targets
    }

    /// The `host:port` the gateway may open for a tunnel: the API server of each cluster that
    /// picked it and that cluster's remote metrics URL (spec §5.5).
    pub(crate) fn tunnel_targets(&self, id: &str) -> HashSet<(String, u16)> {
        let entries = self.context_entries();
        let mut targets = HashSet::new();
        for (cluster, own) in self.cluster_settings_store().get().iter() {
            if own.tunnel.as_deref() != Some(id) {
                continue;
            }
            let server = entries
                .iter()
                .find(|entry| &entry.id == cluster)
                .and_then(|entry| entry.server.as_deref());
            targets.extend(server.and_then(host_port));
            if let MetricsProviderSetting::Remote { url, .. } = &own.metrics_provider {
                targets.extend(host_port(url));
            }
        }
        targets
    }

    /// The tunnel's state. `Up` reads `Idle` once nothing used it for `IDLE_AFTER`.
    pub(crate) fn tunnel_state(&self, id: &str) -> TunnelState {
        let runtime = self.tunnel_runtime();
        let kept = runtime.states.get(id).map(|entry| entry.value().clone());
        match kept {
            Some((TunnelState::Up { .. }, at))
                if at.elapsed() >= IDLE_AFTER && runtime.open_count(id) == 0 =>
            {
                TunnelState::Idle
            }
            Some((state, _)) => state,
            None => TunnelState::Idle,
        }
    }

    /// Keeps the state and the time; tells the windows only when the state changed.
    pub(crate) fn tunnel_set_state(&self, id: &str, state: TunnelState) {
        let before = self.tunnel_state(id);
        self.tunnel_runtime()
            .states
            .insert(id.to_owned(), (state.clone(), Instant::now()));
        if before != state {
            self.emit(CoreEvent::TunnelsChanged);
        }
    }

    /// `Up`, keeping `since` while it stays up, and refreshing when it was last used.
    pub(crate) fn tunnel_mark_up(&self, id: &str) {
        let state = match self.tunnel_state(id) {
            up @ TunnelState::Up { .. } => up,
            _ => TunnelState::up_now(),
        };
        self.tunnel_set_state(id, state);
    }

    /// Dials `host:port` through the tunnel and keeps its state (spec §5.6, §5.9).
    pub(crate) async fn tunnel_dial(
        &self,
        def: &TunnelDef,
        host: &str,
        port: u16,
    ) -> Result<Box<dyn Stream>, DialError> {
        if !self.tunnel_state(&def.id).is_up() {
            self.tunnel_set_state(&def.id, TunnelState::Starting);
        }
        let outcome = self.tunnel_dial_now(def, host, port).await;
        match &outcome {
            Ok(_) => self.tunnel_mark_up(&def.id),
            Err(e) => self.tunnel_set_state(
                &def.id,
                TunnelState::Failed {
                    message: e.reason(),
                },
            ),
        }
        outcome
    }

    async fn tunnel_upstream(&self, def: &TunnelDef) -> Result<ProxyUpstream, DialError> {
        match &def.kind {
            TunnelKind::Proxy { url, username } => {
                let credentials = match username {
                    None => None,
                    Some(user) => match self.tunnel_password(&def.id).await {
                        Ok(Some(password)) => Some((user.clone(), password)),
                        Ok(None) => return Err(DialError::Failed(NO_PASSWORD.to_owned())),
                        Err(e) => return Err(DialError::Failed(e.message)),
                    },
                };
                ProxyUpstream::new(url, credentials)
            }
            TunnelKind::Ssh { .. } => {
                Err(DialError::Failed("SSH tunnels cannot start yet".to_owned()))
            }
        }
    }

    async fn tunnel_dial_now(
        &self,
        def: &TunnelDef,
        host: &str,
        port: u16,
    ) -> Result<Box<dyn Stream>, DialError> {
        self.tunnel_upstream(def).await?.dial(host, port).await
    }

    /// `Test connection` (spec §5.1): dials the API server of a cluster that uses the tunnel,
    /// or, when none does, reaches the proxy itself.
    pub async fn tunnel_test(&self, id: &str) -> CoreResult<TunnelView> {
        let def = self.tunnel_def(id).ok_or_else(gone)?;
        let mut targets: Vec<(String, u16)> = self.tunnel_api_targets(id).into_iter().collect();
        if targets.is_empty() {
            targets = self.tunnel_targets(id).into_iter().collect();
        }
        targets.sort();
        if let Some((host, port)) = targets.first() {
            // The outcome is in the state the view carries.
            let _ = self.tunnel_dial(&def, host, *port).await;
        } else {
            self.tunnel_set_state(&def.id, TunnelState::Starting);
            let outcome = match self.tunnel_upstream(&def).await {
                Ok(upstream) => upstream.reach_proxy().await,
                Err(e) => Err(e),
            };
            match outcome {
                Ok(()) => self.tunnel_mark_up(&def.id),
                Err(e) => self.tunnel_set_state(
                    &def.id,
                    TunnelState::Failed {
                        message: e.reason(),
                    },
                ),
            }
        }
        Ok(self.tunnel_view(&def))
    }

    /// `Stop` (spec §5.1): ends the tunnel's gateway connections. The next use starts it.
    pub fn tunnel_stop(&self, id: &str) -> CoreResult<TunnelView> {
        let def = self.tunnel_def(id).ok_or_else(gone)?;
        self.tunnel_runtime().reset(id);
        self.emit(CoreEvent::TunnelsChanged);
        Ok(self.tunnel_view(&def))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_strip_brackets_and_default_ports() {
        assert_eq!(host_port("https://[::1]:6443"), Some(("::1".into(), 6443)));
        assert_eq!(
            host_port("https://API.example.com"),
            Some(("api.example.com".into(), 443))
        );
        assert_eq!(
            host_port("http://mimir.internal/prometheus"),
            Some(("mimir.internal".into(), 80))
        );
        assert_eq!(host_port("not a url"), None);
    }
}
