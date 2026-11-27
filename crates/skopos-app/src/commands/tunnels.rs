//! Tunnels (tunnels spec §5.2). A proxy password crosses IPC inward only, in
//! `tunnel_set_password` (spec T1).

use skopos_core::blocking::blocking;
use skopos_core::error::IpcError;
use skopos_core::secrets::Secret;
use skopos_core::tunnels::{TunnelInput, TunnelView};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn tunnel_list(state: State<'_, AppState>) -> Result<Vec<TunnelView>, IpcError> {
    Ok(state.core.tunnel_list())
}

#[tauri::command]
pub async fn tunnel_save(
    state: State<'_, AppState>,
    tunnel: TunnelInput,
) -> Result<TunnelView, IpcError> {
    let core = state.core.clone();
    blocking(move || core.tunnel_save(tunnel)).await
}

#[tauri::command]
pub async fn tunnel_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    // Deleting reaches the keychain, which can wait on its user.
    let core = state.core.clone();
    blocking(move || core.tunnel_delete(&id)).await
}

#[tauri::command]
pub async fn tunnel_test(state: State<'_, AppState>, id: String) -> Result<TunnelView, IpcError> {
    state.core.tunnel_test(&id).await
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, AppState>, id: String) -> Result<TunnelView, IpcError> {
    state.core.tunnel_stop(&id).await
}

/// The only command a tunnel secret crosses IPC in.
#[tauri::command]
pub async fn tunnel_set_password(
    state: State<'_, AppState>,
    id: String,
    password: Secret,
) -> Result<TunnelView, IpcError> {
    let core = state.core.clone();
    blocking(move || core.tunnel_set_password(&id, password)).await
}

#[tauri::command]
pub async fn tunnel_clear_password(
    state: State<'_, AppState>,
    id: String,
) -> Result<TunnelView, IpcError> {
    let core = state.core.clone();
    blocking(move || core.tunnel_clear_password(&id)).await
}
