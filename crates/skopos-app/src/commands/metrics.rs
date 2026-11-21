//! Metrics (F16). Each command delegates to `AppCore`.

use skopos_core::blocking::blocking;
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{
    MetricsProvider, MetricsProviderSetting, MetricsRange, MetricsResult, MetricsTarget,
    NodeDiskSnapshot, UsageOf, UsageSnapshot,
};
use skopos_core::secrets::Secret;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn metrics_provider(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    refresh: bool,
) -> Result<MetricsProvider, IpcError> {
    state.core.metrics_provider(&cluster_id, refresh).await
}

#[tauri::command]
pub async fn metrics_query(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    target: MetricsTarget,
    range: MetricsRange,
) -> Result<MetricsResult, IpcError> {
    state.core.metrics_query(&cluster_id, &target, range).await
}

#[tauri::command]
pub async fn metrics_usage(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    of: UsageOf,
    namespace: Option<String>,
) -> Result<UsageSnapshot, IpcError> {
    state
        .core
        .metrics_usage(&cluster_id, of, namespace.as_deref())
        .await
}

#[tauri::command]
pub async fn nodes_disk_usage(
    state: State<'_, AppState>,
    id: ClusterId,
    names: Vec<String>,
) -> Result<NodeDiskSnapshot, IpcError> {
    state.core.nodes_disk_usage(&id, &names).await
}

/// The only command a secret crosses IPC in (spec I49).
#[tauri::command]
pub async fn metrics_secret_set(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    secret: Secret,
    provider: MetricsProviderSetting,
) -> Result<(), IpcError> {
    // The keychain can wait on its user, so it is not asked on an async thread.
    let core = state.core.clone();
    blocking(move || core.metrics_secret_set_for(&cluster_id, secret, provider)).await
}

#[tauri::command]
pub async fn metrics_secret_saved(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<bool, IpcError> {
    let core = state.core.clone();
    blocking(move || core.metrics_secret_saved(&cluster_id)).await
}
