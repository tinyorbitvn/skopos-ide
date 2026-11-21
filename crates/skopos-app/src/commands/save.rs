//! The save dialog. A command that writes a file asks for its place here, so the page
//! never names the path (see `skopos_core::save_file`).

use std::path::PathBuf;

use skopos_core::error::{ErrorCode, IpcError};
use skopos_core::save_file::{suggested_file_name, SaveKind};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

/// Where a build for the end-to-end tests saves instead of asking, since no test can
/// answer the system's dialog. Only that build reads it.
#[cfg(feature = "e2e")]
const E2E_SAVE_DIR: &str = "SKOPOS_E2E_SAVE_DIR";

/// Asks where to save a file of this kind, in the system's dialog over the window that
/// asked. `suggested` is the page's name for it, which the dialog starts with once it is
/// checked. `None` when the user cancels.
pub(crate) async fn ask_save_path(
    window: &WebviewWindow,
    kind: SaveKind,
    suggested: &str,
) -> Result<Option<PathBuf>, IpcError> {
    let name = suggested_file_name(suggested, &kind);
    #[cfg(feature = "e2e")]
    if let Some(dir) = std::env::var_os(E2E_SAVE_DIR) {
        return Ok(Some(PathBuf::from(dir).join(name)));
    }
    let dialog = window
        .dialog()
        .file()
        .set_parent(window)
        .set_file_name(name)
        .add_filter(kind.label, kind.extensions);
    // The dialog holds its thread until it is answered.
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|error| {
            IpcError::new(
                ErrorCode::Internal,
                format!("the save dialog stopped: {error}"),
            )
        })?;
    picked
        .map(|file| file.into_path())
        .transpose()
        .map_err(|error| {
            IpcError::new(
                ErrorCode::Internal,
                format!("the chosen place is not a file path: {error}"),
            )
        })
}
