use std::path::PathBuf;

use skopos_core::error::{ErrorCode, IpcError};
use skopos_core::map_export::{decode_png_base64, write_map, MapFormat};
use tauri::WebviewWindow;

use super::save::ask_save_path;

/// Saves the map the webview drew (spec O §6.4). `png` is base64 without a `data:` prefix.
/// The user chooses the place in the save dialog, which opens once the image is read.
/// Returns the path written, or `None` when they cancel.
#[tauri::command]
pub async fn map_export(
    window: WebviewWindow,
    suggested_name: String,
    format: MapFormat,
    png: String,
    scale: f64,
) -> Result<Option<PathBuf>, IpcError> {
    let png = decode_png_base64(&png)?;
    let Some(path) = ask_save_path(&window, format.save_kind(), &suggested_name).await? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || write_map(&path, format, &png, scale))
        .await
        .map_err(|error| {
            IpcError::new(ErrorCode::Internal, format!("the export stopped: {error}"))
        })?
        .map(Some)
}
