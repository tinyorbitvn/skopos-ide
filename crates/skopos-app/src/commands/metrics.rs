//! Metrics (F16). Each command delegates to `AppCore`.

use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{
    MetricsProvider, MetricsRange, MetricsResult, MetricsTarget, UsageOf, UsageSnapshot,
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

/// The only command a secret crosses IPC in (spec I49).
#[tauri::command]
pub async fn metrics_secret_set(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    secret: Secret,
) -> Result<(), IpcError> {
    state.core.metrics_secret_set(&cluster_id, secret)
}

#[tauri::command]
pub async fn metrics_secret_saved(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<bool, IpcError> {
    state.core.metrics_secret_saved(&cluster_id)
}
