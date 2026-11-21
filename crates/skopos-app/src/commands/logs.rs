use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::save_file;
use skopos_core::sessions::{LogDownload, LogEvent, LogOptions, LogTarget};
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use super::save::ask_save_path;
use crate::state::AppState;

/// Batches wait here while the webview catches up.
const LOG_BACKLOG: usize = 16;

#[tauri::command]
pub async fn logs_start(
    state: State<'_, AppState>,
    window: WebviewWindow,
    cluster_id: ClusterId,
    target: LogTarget,
    options: LogOptions,
    on_event: Channel<LogEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(LOG_BACKLOG);
    let id = state
        .core
        .logs_start(&cluster_id, target, options, tx, window.label())?;
    let core = state.core.clone();
    let session = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                core.logs_stop(&session);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn logs_stop(state: State<'_, AppState>, session_id: String) -> Result<(), IpcError> {
    state.core.logs_stop(&session_id);
    Ok(())
}

/// Saves the target's logs where the user chooses in the save dialog. `None` when they
/// cancel, and then nothing is read from the cluster.
#[tauri::command]
pub async fn logs_download(
    state: State<'_, AppState>,
    window: WebviewWindow,
    cluster_id: ClusterId,
    target: LogTarget,
    options: LogOptions,
    suggested_name: String,
) -> Result<Option<LogDownload>, IpcError> {
    let Some(dest_path) = ask_save_path(&window, save_file::LOG, &suggested_name).await? else {
        return Ok(None);
    };
    state
        .core
        .logs_download(&cluster_id, target, options, &dest_path, window.label())
        .await
        .map(Some)
}
