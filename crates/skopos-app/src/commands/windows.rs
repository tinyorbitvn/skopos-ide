//! Window layouts and moves between windows (spec P31 to P39). The calling window's
//! label comes from Tauri, never from the UI.

use skopos_core::error::{ErrorCode, IpcError};
use skopos_core::windows::{MoveOutcome, MoveTarget, WindowLayout};
use tauri::{Manager, State, WebviewWindow};

use crate::state::AppState;
use crate::windows;

/// One window must not save over another's layout.
fn own_layout(caller: &str, layout: &WindowLayout) -> Result<(), IpcError> {
    if layout.label == caller {
        Ok(())
    } else {
        Err(IpcError::new(
            ErrorCode::InvalidInput,
            "A window can save only its own layout.",
        ))
    }
}

fn internal(e: tauri::Error) -> IpcError {
    IpcError::new(ErrorCode::Internal, e.to_string())
}

/// The calling window's layout.
#[tauri::command]
pub async fn window_layout_get(
    state: State<'_, AppState>,
    window: WebviewWindow,
) -> Result<WindowLayout, IpcError> {
    state.core.window_layout(window.label())
}

/// Keeps the calling window's layout; the core keeps its own bounds. A window other
/// than `main` whose last tab has gone closes (P21).
#[tauri::command]
pub async fn window_layout_set(
    state: State<'_, AppState>,
    window: WebviewWindow,
    layout: WindowLayout,
) -> Result<(), IpcError> {
    own_layout(window.label(), &layout)?;
    state.core.window_layout_set(layout)?;
    windows::close_if_empty(&window, &state.core);
    Ok(())
}

/// The calling window has sent its last layout before the app quits (P34).
#[tauri::command]
pub async fn window_flushed(window: WebviewWindow) -> Result<(), IpcError> {
    windows::flushed(window.app_handle(), window.label());
    Ok(())
}

/// The layouts of every open window, `main` first (the "Move to window" list).
#[tauri::command]
pub async fn windows_list(state: State<'_, AppState>) -> Result<Vec<WindowLayout>, IpcError> {
    Ok(state.core.windows_list())
}

/// Moves a tab and settles the windows: a new window opens, an emptied one closes.
fn move_tab(
    state: &AppState,
    window: &WebviewWindow,
    tab_id: &str,
    target: MoveTarget,
) -> Result<MoveOutcome, IpcError> {
    let from = window.label();
    let outcome = state.core.window_tab_move(from, tab_id, target)?;
    windows::settle_move(window.app_handle(), &state.core, from, tab_id, &outcome)?;
    Ok(outcome)
}

/// Moves a tab of the calling window to another window or to a new one.
#[tauri::command]
pub async fn window_tab_move(
    state: State<'_, AppState>,
    window: WebviewWindow,
    tab_id: String,
    target: MoveTarget,
) -> Result<MoveOutcome, IpcError> {
    move_tab(&state, &window, &tab_id, target)
}

/// A tab let go outside the calling window at `screen_x`, `screen_y` (that window's
/// logical pixels): it moves into the window under that point, or into a new window
/// whose top-left corner is there (P31).
#[tauri::command]
pub async fn window_tab_drop(
    state: State<'_, AppState>,
    window: WebviewWindow,
    tab_id: String,
    screen_x: f64,
    screen_y: f64,
) -> Result<MoveOutcome, IpcError> {
    let scale = window.scale_factor().map_err(internal)?;
    let (x, y) = windows::to_physical(screen_x, screen_y, scale);
    let candidates = windows::outer_rects(window.app_handle());
    let target = match state.core.window_at(&candidates, x, y) {
        Some(label) => MoveTarget::Window { label },
        None => MoveTarget::NewWindow { x, y },
    };
    move_tab(&state, &window, &tab_id, target)
}

#[cfg(test)]
mod tests {
    use skopos_core::error::ErrorCode;
    use skopos_core::windows::{start_layout, WindowLayout};

    use super::*;

    #[test]
    fn a_window_saves_only_its_own_layout() {
        let main = start_layout();
        let other = WindowLayout {
            label: "window-2".to_owned(),
            ..start_layout()
        };

        assert!(own_layout("main", &main).is_ok());
        let refused = own_layout("main", &other).unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidInput);
        assert_eq!(refused.message, "A window can save only its own layout.");
    }
}
