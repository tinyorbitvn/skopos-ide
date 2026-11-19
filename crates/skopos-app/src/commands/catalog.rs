use skopos_core::blocking::blocking;
use skopos_core::catalog::folders::{CatalogFolder, CatalogFolders};
use skopos_core::catalog::ClusterEntry;
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::{ClusterId, SyncWarning};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn catalog_list(state: State<'_, AppState>) -> Result<Vec<ClusterEntry>, IpcError> {
    Ok(state.core.catalog_list())
}

#[tauri::command]
pub async fn catalog_warnings(state: State<'_, AppState>) -> Result<Vec<SyncWarning>, IpcError> {
    Ok(state.core.catalog_warnings())
}

#[tauri::command]
pub async fn catalog_add_pasted(
    state: State<'_, AppState>,
    yaml: String,
) -> Result<Vec<ClusterId>, IpcError> {
    state.core.catalog_add_pasted(&yaml)
}

#[tauri::command]
pub async fn catalog_remove_pasted(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<(), IpcError> {
    state.core.catalog_remove_pasted(&id)
}

#[tauri::command]
pub async fn catalog_folders(state: State<'_, AppState>) -> Result<CatalogFolders, IpcError> {
    Ok(state.core.catalog_folders())
}

/// `parent` `None`: at the top level.
#[tauri::command]
pub async fn catalog_folder_create(
    state: State<'_, AppState>,
    parent: Option<String>,
    name: String,
) -> Result<CatalogFolder, IpcError> {
    let core = state.core.clone();
    blocking(move || core.catalog_folder_create(parent.as_deref(), &name)).await
}

#[tauri::command]
pub async fn catalog_folder_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.catalog_folder_rename(&id, &name)).await
}

/// `parent` `None`: to the top level.
#[tauri::command]
pub async fn catalog_folder_move(
    state: State<'_, AppState>,
    id: String,
    parent: Option<String>,
) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.catalog_folder_move(&id, parent.as_deref())).await
}

/// Its clusters and subfolders move to its parent.
#[tauri::command]
pub async fn catalog_folder_delete(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.catalog_folder_delete(&id)).await
}

/// `folder` `None`: to the top level.
#[tauri::command]
pub async fn catalog_cluster_place(
    state: State<'_, AppState>,
    cluster: ClusterId,
    folder: Option<String>,
) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.catalog_cluster_place(&cluster, folder.as_deref())).await
}
