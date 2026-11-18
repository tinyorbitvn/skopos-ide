//! The app's OS windows (spec P31 to P36): where they are on the desktop. The
//! layouts and the choice of a window live in the core.

use skopos_core::windows::ScreenRect;
use tauri::{AppHandle, Manager, Runtime};

/// A point in a window's logical pixels, in physical pixels by that window's scale factor.
pub fn to_physical(x: f64, y: f64, scale: f64) -> (i32, i32) {
    let physical = |v: f64| (v * scale).round() as i32;
    (physical(x), physical(y))
}

/// The outer bounds of every window that is on the desktop, minimized ones left out,
/// for the core to find the window under a point.
pub fn outer_rects<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, ScreenRect)> {
    app.webview_windows()
        .into_iter()
        .filter(|(_, window)| !window.is_minimized().unwrap_or(false))
        .filter_map(|(label, window)| {
            let position = window.outer_position().ok()?;
            let size = window.outer_size().ok()?;
            let rect = ScreenRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            };
            Some((label, rect))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_logical_point_becomes_physical_with_the_scale_factor() {
        assert_eq!(to_physical(100.4, -20.0, 1.5), (151, -30));
        assert_eq!(to_physical(800.0, 600.0, 1.0), (800, 600));
        assert_eq!(to_physical(-0.2, 0.2, 2.0), (0, 0));
    }
}
