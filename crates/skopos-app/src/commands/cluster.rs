use skopos_core::cluster::{
    ConnectionLogEntry, ConnectionState, ControlPlane, ExecRequest, ExecRequestDetails,
};
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn cluster_connect(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ConnectionState, IpcError> {
    state.core.cluster_connect(&id).await
}

#[tauri::command]
pub async fn cluster_disconnect(state: State<'_, AppState>, id: ClusterId) -> Result<(), IpcError> {
    state.core.cluster_disconnect(&id).await
}

#[tauri::command]
pub async fn cluster_exec_request(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ExecRequest, IpcError> {
    state.core.cluster_exec_request(&id)
}

#[tauri::command]
pub async fn cluster_exec_request_details(
    state: State<'_, AppState>,
    id: ClusterId,
    request_id: u32,
) -> Result<ExecRequestDetails, IpcError> {
    state.core.cluster_exec_request_details(&id, request_id)
}

#[tauri::command]
pub async fn cluster_exec_allow(
    state: State<'_, AppState>,
    id: ClusterId,
    request_id: u32,
) -> Result<(), IpcError> {
    state.core.cluster_exec_allow(&id, request_id)
}

#[tauri::command]
pub async fn cluster_exec_forget(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<(), IpcError> {
    state.core.cluster_exec_forget(&id).await
}

#[tauri::command]
pub async fn cluster_state(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ConnectionState, IpcError> {
    Ok(state.core.cluster_state(&id))
}

#[tauri::command]
pub async fn cluster_control_plane(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ControlPlane, IpcError> {
    state.core.cluster_control_plane(&id).await
}

#[tauri::command]
pub async fn cluster_log(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<Vec<ConnectionLogEntry>, IpcError> {
    Ok(state.core.cluster_log(&id))
}
