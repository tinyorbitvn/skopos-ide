use std::path::PathBuf;

use skopos_core::error::{ErrorCode, IpcError};
use skopos_core::map_export::{decode_png_base64, write_map, MapFormat};

/// Saves the map the webview drew (spec O §6.4). `png` is base64 without a `data:` prefix.
/// Returns the path written.
#[tauri::command]
pub async fn map_export(
    path: PathBuf,
    format: MapFormat,
    png: String,
    scale: f64,
) -> Result<PathBuf, IpcError> {
    let png = decode_png_base64(&png)?;
    tauri::async_runtime::spawn_blocking(move || write_map(&path, format, &png, scale))
        .await
        .map_err(|error| {
            IpcError::new(ErrorCode::Internal, format!("the export stopped: {error}"))
        })?
}
