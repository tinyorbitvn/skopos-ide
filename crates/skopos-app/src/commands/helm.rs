//! Helm (F15). Each command delegates to `AppCore`.

use skopos_core::error::IpcError;
use skopos_core::helm::{
    ChartSearch, ChartVersion, HelmInfo, HelmInstallRequest, HelmPreview, HelmReleaseDetail,
    HelmReleaseList, HelmReleasesEvent, HelmRepo, HelmRepoAdd, HelmRevision, HelmUpgradeRequest,
};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::sessions::SessionEvent;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use crate::commands::sessions::{forward_output, OUTPUT_BACKLOG};
use crate::state::AppState;

/// Events wait here while the webview catches up. A `changed` is never queued twice.
const RELEASES_BACKLOG: usize = 8;

#[tauri::command]
pub async fn helm_version(state: State<'_, AppState>) -> Result<HelmInfo, IpcError> {
    state.core.helm_version().await
}

#[tauri::command]
pub async fn helm_repo_list(state: State<'_, AppState>) -> Result<Vec<HelmRepo>, IpcError> {
    state.core.helm_repo_list().await
}

#[tauri::command]
pub async fn helm_repo_add(state: State<'_, AppState>, repo: HelmRepoAdd) -> Result<(), IpcError> {
    state.core.helm_repo_add(repo).await
}

#[tauri::command]
pub async fn helm_repo_remove(state: State<'_, AppState>, name: String) -> Result<(), IpcError> {
    state.core.helm_repo_remove(&name).await
}

#[tauri::command]
pub async fn helm_repo_update(
    state: State<'_, AppState>,
    names: Option<Vec<String>>,
) -> Result<(), IpcError> {
    state.core.helm_repo_update(names).await
}

#[tauri::command]
pub async fn helm_chart_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<ChartSearch, IpcError> {
    state.core.helm_chart_search(&query, limit).await
}

#[tauri::command]
pub async fn helm_chart_versions(
    state: State<'_, AppState>,
    repo: String,
    chart: String,
) -> Result<Vec<ChartVersion>, IpcError> {
    state.core.helm_chart_versions(&repo, &chart).await
}

#[tauri::command]
pub async fn helm_chart_readme(
    state: State<'_, AppState>,
    repo: String,
    chart: String,
    version: String,
) -> Result<String, IpcError> {
    state.core.helm_chart_readme(&repo, &chart, &version).await
}

#[tauri::command]
pub async fn helm_chart_values(
    state: State<'_, AppState>,
    repo: String,
    chart: String,
    version: String,
) -> Result<String, IpcError> {
    state.core.helm_chart_values(&repo, &chart, &version).await
}

#[tauri::command]
pub async fn helm_release_list(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespaces: Option<Vec<String>>,
) -> Result<HelmReleaseList, IpcError> {
    state.core.helm_release_list(&cluster_id, namespaces).await
}

#[tauri::command]
pub async fn helm_release_get(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<HelmReleaseDetail, IpcError> {
    state
        .core
        .helm_release_get(&cluster_id, &namespace, &name)
        .await
}

#[tauri::command]
pub async fn helm_release_values(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    all: bool,
) -> Result<String, IpcError> {
    state
        .core
        .helm_release_values(&cluster_id, &namespace, &name, all)
        .await
}

#[tauri::command]
pub async fn helm_release_history(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<Vec<HelmRevision>, IpcError> {
    state
        .core
        .helm_release_history(&cluster_id, &namespace, &name)
        .await
}

/// Sends `changed` to `on_event` when a release changes, and returns the subscription id.
/// The subscription belongs to the window that asks and ends when its page loads again or
/// it closes, so its watch does not outlive the page; so does one whose channel can no
/// longer be written.
#[tauri::command]
pub async fn helm_releases_subscribe(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    on_event: Channel<HelmReleasesEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(RELEASES_BACKLOG);
    let id = state
        .core
        .helm_releases_subscribe(&cluster_id, tx, window.label())?;
    let core = state.core.clone();
    let subscription = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                core.helm_releases_unsubscribe(&subscription);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn helm_releases_unsubscribe(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), IpcError> {
    state.core.helm_releases_unsubscribe(&subscription_id);
    Ok(())
}

#[tauri::command]
pub async fn helm_install_preview(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    request: HelmInstallRequest,
) -> Result<HelmPreview, IpcError> {
    state.core.helm_install_preview(&cluster_id, &request).await
}

#[tauri::command]
pub async fn helm_upgrade_preview(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    request: HelmUpgradeRequest,
) -> Result<HelmPreview, IpcError> {
    state.core.helm_upgrade_preview(&cluster_id, &request).await
}

#[tauri::command]
pub async fn helm_install_start(
    state: State<'_, AppState>,
    window: WebviewWindow,
    cluster_id: ClusterId,
    request: HelmInstallRequest,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(OUTPUT_BACKLOG);
    let id = state
        .core
        .helm_install_start(&cluster_id, &request, tx, window.label())
        .await?;
    forward_output(state.core.clone(), id.clone(), rx, on_data, on_event);
    Ok(id)
}

#[tauri::command]
pub async fn helm_upgrade_start(
    state: State<'_, AppState>,
    window: WebviewWindow,
    cluster_id: ClusterId,
    request: HelmUpgradeRequest,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(OUTPUT_BACKLOG);
    let id = state
        .core
        .helm_upgrade_start(&cluster_id, &request, tx, window.label())
        .await?;
    forward_output(state.core.clone(), id.clone(), rx, on_data, on_event);
    Ok(id)
}

// The IPC contract fixes these arguments, and a command takes them one by one.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn helm_rollback_start(
    state: State<'_, AppState>,
    window: WebviewWindow,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    revision: u32,
    wait: bool,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(OUTPUT_BACKLOG);
    let id = state
        .core
        .helm_rollback_start(
            &cluster_id,
            &namespace,
            &release,
            revision,
            wait,
            tx,
            window.label(),
        )
        .await?;
    forward_output(state.core.clone(), id.clone(), rx, on_data, on_event);
    Ok(id)
}

// The IPC contract fixes these arguments, and a command takes them one by one.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn helm_uninstall_start(
    state: State<'_, AppState>,
    window: WebviewWindow,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    wait: bool,
    keep_history: bool,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(OUTPUT_BACKLOG);
    let id = state
        .core
        .helm_uninstall_start(
            &cluster_id,
            &namespace,
            &release,
            wait,
            keep_history,
            tx,
            window.label(),
        )
        .await?;
    forward_output(state.core.clone(), id.clone(), rx, on_data, on_event);
    Ok(id)
}
