//! In-app updates (in-app update spec §5.2). The state reaches the windows as `update://state`.

use skopos_core::blocking::blocking;
use skopos_core::error::IpcError;
use skopos_core::updates::UpdateState;
use tauri::{AppHandle, State};

use crate::state::AppState;

#[tauri::command]
pub async fn update_state_get(state: State<'_, AppState>) -> Result<UpdateState, IpcError> {
    Ok(state.core.update_state())
}

#[tauri::command]
pub async fn update_check(state: State<'_, AppState>) -> Result<UpdateState, IpcError> {
    Ok(state.core.update_check().await)
}

/// Downloads, verifies and installs the update, then restarts into it through the normal
/// exit path. On Windows the installer ends the app instead and starts the new one.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.core.update_install().await?;
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub async fn update_cancel(state: State<'_, AppState>) -> Result<(), IpcError> {
    state.core.update_cancel();
    Ok(())
}

#[tauri::command]
pub async fn update_skip(state: State<'_, AppState>, version: String) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.update_skip(version)).await
}
