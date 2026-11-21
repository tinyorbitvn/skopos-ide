//! The app's OS windows (spec P31 to P36): one webview of the same UI per label, opened
//! at the bounds the core keeps, their moves, resizes and focus reported to the core,
//! and the app quitting with `main`. The layouts and the choice of a window live in
//! the core.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use skopos_core::app_core::AppCore;
use skopos_core::error::{ErrorCode, IpcError};
use skopos_core::quit::{exit_now, QUIT_LIMIT};
use skopos_core::windows::{
    clamp_bounds, MoveOutcome, MoveTarget, ScreenRect, WindowBounds, WindowLayout, MAIN_WINDOW,
};
use tauri::utils::config::WindowConfig;
use tauri::window::Monitor;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
use tokio::sync::Notify;

use crate::state::AppState;

/// How long a window must stay still before its bounds are reported. Moves and resizes
/// arrive many times a second while the user drags.
const BOUNDS_SETTLE: Duration = Duration::from_millis(500);
/// Asks a window's UI to save its layout now; it answers with `window_flushed` (P34).
pub const WINDOW_FLUSH: &str = "window://flush";
/// How long the app waits for the windows to save before it quits all the same.
const FLUSH_LIMIT: Duration = Duration::from_millis(500);

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

/// A window other than `main`: `main`'s entry in `tauri.conf.json` (the same UI and
/// settings, P32) under its own label, hidden until it is in place.
pub fn config_for(main: &WindowConfig, label: &str) -> WindowConfig {
    WindowConfig {
        label: label.to_owned(),
        visible: false,
        ..main.clone()
    }
}

/// What a destroyed window means for its layout.
#[derive(Debug, PartialEq, Eq)]
pub enum Destroyed {
    /// `main` closed: the app quits and every layout stays (P34).
    Quit,
    /// Another window closed on its own: its tabs, sessions and layout go.
    Forget,
    /// The app is quitting: the layout stays for the next start.
    Keep,
}

pub fn on_destroyed(label: &str, quitting: bool) -> Destroyed {
    if label == MAIN_WINDOW {
        Destroyed::Quit
    } else if quitting {
        Destroyed::Keep
    } else {
        Destroyed::Forget
    }
}

/// The windows asked to save their layout before the app quits, until each answers.
#[derive(Default)]
pub struct Flushes {
    waiting: Mutex<BTreeSet<String>>,
    answer: Notify,
}

impl Flushes {
    fn waiting(&self) -> MutexGuard<'_, BTreeSet<String>> {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits for these windows from now on.
    pub fn expect(&self, labels: impl IntoIterator<Item = String>) {
        self.waiting().extend(labels);
    }

    /// A window has saved; one not waited for changes nothing.
    pub fn answered(&self, label: &str) {
        if self.waiting().remove(label) {
            self.answer.notify_waiters();
        }
    }

    /// Returns once every window waited for has answered, or after `limit`, with the
    /// labels of the windows that did not answer.
    pub async fn wait(&self, limit: Duration) -> Vec<String> {
        let all_answered = async {
            loop {
                let answer = self.answer.notified();
                tokio::pin!(answer);
                // Registered before the check, so an answer in between is not missed.
                answer.as_mut().enable();
                if self.waiting().is_empty() {
                    return;
                }
                answer.await;
            }
        };
        let _ = tokio::time::timeout(limit, all_answered).await;
        std::mem::take(&mut *self.waiting()).into_iter().collect()
    }
}

/// What the window events need between two events.
#[derive(Default)]
pub struct WindowTracker {
    /// Set once the app quits, so the windows it closes keep their layouts.
    quitting: AtomicBool,
    /// Per window, a count of its moves and resizes; a report goes once it stops changing.
    moves: Mutex<HashMap<String, u64>>,
    /// The windows' answers to the flush before quitting.
    flushes: Flushes,
    /// Set when `main` first asks to close: the windows are saving.
    flush_started: AtomicBool,
    /// Set once they have saved, or the wait gave up: `main` may close.
    flushed: AtomicBool,
}

impl WindowTracker {
    fn moves(&self) -> MutexGuard<'_, HashMap<String, u64>> {
        self.moves.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

/// Marks the app as quitting: from now on a closed window keeps its layout. The quit's
/// steps are logged from the first one, `step`, and a quit that stalls ends the process,
/// which would otherwise run on with no window (P34).
pub fn quitting<R: Runtime>(app: &AppHandle<R>, step: &str) {
    app.state::<WindowTracker>()
        .quitting
        .store(true, Ordering::SeqCst);
    let core = &app.state::<AppState>().core;
    core.quit().begin(step, QUIT_LIMIT, || exit_now(0));
}

/// A window's UI has sent its last layout before the app quits.
pub fn flushed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    app.state::<WindowTracker>().flushes.answered(label);
}

/// Asks every window to save its layout now and waits until all have answered or
/// `FLUSH_LIMIT` has passed, so the last changes before quitting are kept (P34, P38).
async fn flush_windows<R: Runtime>(app: &AppHandle<R>) {
    let tracker = app.state::<WindowTracker>();
    let labels: Vec<String> = app.webview_windows().into_keys().collect();
    tracker.flushes.expect(labels.iter().cloned());
    for label in &labels {
        let target = EventTarget::webview_window(label.clone());
        if let Err(e) = app.emit_to(target, WINDOW_FLUSH, ()) {
            tracing::warn!("cannot ask window {label} to save its layout: {e}");
            tracker.flushes.answered(label);
        }
    }
    let silent = tracker.flushes.wait(FLUSH_LIMIT).await;
    if !silent.is_empty() {
        tracing::warn!("windows that did not save their layout before quitting: {silent:?}");
    }
}

/// `main` asked to close: unless the windows have saved, the close waits while they
/// do, then `main` closes again and the app quits as before (P34).
fn close_main_after_flush<R: Runtime>(app: &AppHandle<R>) {
    let tracker = app.state::<WindowTracker>();
    if tracker.flush_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        flush_windows(&app).await;
        app.state::<WindowTracker>()
            .flushed
            .store(true, Ordering::SeqCst);
        let quit = app.state::<AppState>().core.quit().clone();
        quit.step("the windows saved their layout; main closes again");
        let closed = app.get_webview_window(MAIN_WINDOW).map(|main| main.close());
        if !matches!(closed, Some(Ok(()))) {
            tracing::warn!("cannot close the main window after the windows saved; quitting");
            quit.step("main could not close again; the app exits");
            app.exit(0);
        }
    });
}

/// Before the app restarts into an update: every window saves its layout and its bounds are
/// recorded, as when `main` closes (P34; in-app update R4).
pub async fn prepare_restart<R: Runtime>(app: &AppHandle<R>) {
    flush_windows(app).await;
    let state = app.state::<AppState>();
    for window in app.webview_windows().values() {
        report_bounds(&state.core, window);
    }
}

fn work_area(monitor: &Monitor) -> ScreenRect {
    let area = monitor.work_area();
    ScreenRect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}

/// Saved bounds made safe for the monitors there are now (P35).
fn clamped<R: Runtime>(app: &AppHandle<R>, bounds: WindowBounds) -> WindowBounds {
    let monitors: Vec<ScreenRect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(work_area)
        .collect();
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| work_area(&m))
        .or_else(|| monitors.first().copied());
    match primary {
        Some(primary) => clamp_bounds(bounds, &monitors, primary),
        None => bounds,
    }
}

/// Puts a window at its saved bounds, made safe for the monitors there are now.
fn place<R: Runtime>(window: &WebviewWindow<R>, bounds: WindowBounds) {
    let bounds = clamped(window.app_handle(), bounds);
    let placed = window
        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .and_then(|()| window.set_size(PhysicalSize::new(bounds.width, bounds.height)))
        .and_then(|()| {
            if bounds.maximized {
                window.maximize()
            } else {
                Ok(())
            }
        });
    if let Err(e) = placed {
        tracing::warn!("cannot place window {}: {e}", window.label());
    }
}

/// Opens the window `label` at `bounds`, or at `main`'s default size when there are none.
/// Only a window that cannot be created is an error; one that cannot be placed or shown
/// is logged and stays open.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    bounds: Option<WindowBounds>,
) -> tauri::Result<WebviewWindow<R>> {
    let main = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .unwrap_or_default();
    let window = WebviewWindowBuilder::from_config(app, &config_for(&main, label))?.build()?;
    if let Some(bounds) = bounds {
        place(&window, bounds);
    }
    if let Err(e) = window.show().and_then(|()| window.set_focus()) {
        tracing::warn!("cannot show window {label}: {e}");
    }
    Ok(window)
}

/// At start: `main` goes to its saved bounds and every other saved window opens (P35).
/// A window that cannot open is dropped from the layouts, so no list names it.
pub fn restore<R: Runtime>(app: &AppHandle<R>, core: &AppCore) {
    for layout in core.windows_restore() {
        if layout.label == MAIN_WINDOW {
            if let (Some(main), Some(bounds)) = (app.get_webview_window(MAIN_WINDOW), layout.bounds)
            {
                place(&main, bounds);
            }
        } else if let Err(e) = open(app, &layout.label, layout.bounds) {
            tracing::warn!("cannot reopen window {}: {e}", layout.label);
            if let Err(e) = core.window_closed(&layout.label) {
                tracing::warn!("cannot drop the layout of window {}: {e}", layout.label);
            }
        }
    }
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        let _ = main.set_focus();
    }
}

/// After a move between windows: opens the window the move created and closes the
/// window it emptied, unless that is `main` (P21, P31). When the new window cannot
/// open, the tab goes back to its window and the error says why (P44).
pub fn settle_move<R: Runtime>(
    app: &AppHandle<R>,
    core: &AppCore,
    from: &str,
    tab_id: &str,
    outcome: &MoveOutcome,
) -> Result<(), IpcError> {
    if outcome.created {
        let bounds = core.window_layout(&outcome.target)?.bounds;
        if let Err(e) = open(app, &outcome.target, bounds) {
            tracing::warn!("cannot open window {}: {e}", outcome.target);
            let back = MoveTarget::Window {
                label: from.to_owned(),
            };
            if let Err(e) = core.window_tab_move(&outcome.target, tab_id, back) {
                tracing::warn!("cannot move tab {tab_id} back to {from}: {e}");
            }
            if let Err(e) = core.window_closed(&outcome.target) {
                tracing::warn!("cannot drop the layout of {}: {e}", outcome.target);
            }
            let reason = e.to_string();
            return Err(IpcError::new(
                ErrorCode::Internal,
                format!(
                    "Could not open a new window: {}.",
                    reason.trim_end_matches('.')
                ),
            ));
        }
    }
    if outcome.source_empty && from != MAIN_WINDOW {
        if let Some(source) = app.get_webview_window(from) {
            if let Err(e) = source.close() {
                tracing::warn!("cannot close the emptied window {from}: {e}");
            }
        }
    }
    Ok(())
}

/// A window other than `main` with no tab left closes; `main` shows its empty state
/// instead (P21).
pub fn closes_when_empty(layout: &WindowLayout) -> bool {
    layout.label != MAIN_WINDOW && layout.panes.iter().all(|p| p.tabs.is_empty())
}

/// Closes the window once the layout the core keeps for it has no tab left.
pub fn close_if_empty<R: Runtime>(window: &WebviewWindow<R>, core: &AppCore) {
    let empty = core
        .window_layout(window.label())
        .is_ok_and(|layout| closes_when_empty(&layout));
    if empty {
        if let Err(e) = window.close() {
            tracing::warn!("cannot close the emptied window {}: {e}", window.label());
        }
    }
}

/// Reports where a window is and how large, unless it is minimized, whose bounds mean
/// nothing to a restore.
fn report_bounds<R: Runtime>(core: &AppCore, window: &WebviewWindow<R>) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size), Ok(maximized)) = (
        window.outer_position(),
        window.inner_size(),
        window.is_maximized(),
    ) else {
        return;
    };
    let bounds = WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    };
    if let Err(e) = core.window_bounds_set(window.label(), bounds) {
        tracing::debug!("bounds of window {} not kept: {e}", window.label());
    }
}

/// Reports a window's bounds once it has stopped moving for `BOUNDS_SETTLE`.
fn report_bounds_later<R: Runtime>(window: &Window<R>) {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let count = {
        let tracker = app.state::<WindowTracker>();
        let mut moves = tracker.moves();
        let count = moves.entry(label.clone()).or_default();
        *count += 1;
        *count
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(BOUNDS_SETTLE).await;
        let still = app.state::<WindowTracker>().moves().get(&label) == Some(&count);
        if let (true, Some(window)) = (still, app.get_webview_window(&label)) {
            report_bounds(&app.state::<AppState>().core, &window);
        }
    });
}

/// Every window's events (P34 to P36): focus orders the windows for a drop, bounds go
/// to the core once a window settles and when `main` closes, a window that closes on
/// its own stops its sessions and drains and drops its layout, and `main` closing
/// first lets every window save its layout, then quits the app with every layout kept.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let app = window.app_handle();
    let label = window.label();
    let core = &app.state::<AppState>().core;
    match event {
        WindowEvent::Focused(true) => core.window_focused(label),
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => report_bounds_later(window),
        WindowEvent::CloseRequested { api, .. } if label == MAIN_WINDOW => {
            if !app.state::<WindowTracker>().flushed.load(Ordering::SeqCst) {
                quitting(
                    app,
                    "main asked to close; the windows save their layout first",
                );
                api.prevent_close();
                close_main_after_flush(app);
                return;
            }
            quitting(app, "main closes");
            for other in app.webview_windows().values() {
                report_bounds(core, other);
            }
        }
        WindowEvent::Destroyed => {
            let tracker = app.state::<WindowTracker>();
            tracker.moves().remove(label);
            match on_destroyed(label, tracker.quitting()) {
                Destroyed::Quit => {
                    quitting(app, "main destroyed; the app exits");
                    app.exit(0);
                }
                Destroyed::Forget => {
                    core.sessions_stop_owned(label);
                    core.node_drain_cancel_owned(label);
                    core.subscriptions_stop_owned(label);
                    if let Err(e) = core.window_closed(label) {
                        tracing::warn!("cannot drop the layout of window {label}: {e}");
                    }
                }
                Destroyed::Keep => core.quit().step(&format!("window {label} destroyed")),
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use skopos_core::windows::{start_layout, PaneState, WindowLayout};

    use super::*;

    fn main_entry() -> WindowConfig {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        serde_json::from_value(config["app"]["windows"][0].clone()).unwrap()
    }

    #[test]
    fn another_window_is_main_with_its_own_label_shown_once_placed() {
        let main = main_entry();
        assert_eq!(main.label, MAIN_WINDOW);

        let other = config_for(&main, "window-2");

        assert_eq!(other.label, "window-2");
        assert!(!other.visible);
        let same = WindowConfig {
            label: main.label.clone(),
            visible: main.visible,
            ..other
        };
        assert_eq!(format!("{same:?}"), format!("{main:?}"));
    }

    #[test]
    fn only_closing_another_window_alone_forgets_its_layout() {
        assert_eq!(on_destroyed("window-2", false), Destroyed::Forget);
        // Closing main quits the app; every layout stays for the next start (P34).
        assert_eq!(on_destroyed(MAIN_WINDOW, false), Destroyed::Quit);
        assert_eq!(on_destroyed("window-2", true), Destroyed::Keep);
        assert_eq!(on_destroyed(MAIN_WINDOW, true), Destroyed::Quit);
    }

    #[test]
    fn a_window_other_than_main_closes_when_its_last_tab_has_gone() {
        let empty = |label: &str| WindowLayout {
            label: label.to_owned(),
            panes: vec![PaneState {
                tabs: Vec::new(),
                selected: String::new(),
                ..start_layout().panes[0].clone()
            }],
            ..start_layout()
        };
        let with_tab = WindowLayout {
            label: "window-2".to_owned(),
            ..start_layout()
        };

        assert!(closes_when_empty(&empty("window-2")));
        assert!(!closes_when_empty(&with_tab));
        // main shows its empty state instead (P21).
        assert!(!closes_when_empty(&empty(MAIN_WINDOW)));
    }

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[tokio::test]
    async fn a_flush_wait_returns_once_every_window_answered() {
        let flushes = std::sync::Arc::new(Flushes::default());
        flushes.expect(labels(&[MAIN_WINDOW, "window-2"]));
        let answering = flushes.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            answering.answered("window-2");
            answering.answered("window-9");
            tokio::time::sleep(Duration::from_millis(20)).await;
            answering.answered(MAIN_WINDOW);
        });
        let started = std::time::Instant::now();

        let missing = flushes.wait(Duration::from_secs(10)).await;

        assert!(missing.is_empty(), "{missing:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_flush_wait_gives_up_after_its_limit_and_names_the_silent_windows() {
        let flushes = Flushes::default();
        flushes.expect(labels(&[MAIN_WINDOW, "window-2", "window-3"]));
        flushes.answered(MAIN_WINDOW);
        flushes.answered("window-3");
        let started = std::time::Instant::now();

        let missing = flushes.wait(Duration::from_millis(50)).await;

        assert_eq!(missing, ["window-2"]);
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(Flushes::default()
            .wait(Duration::from_secs(10))
            .await
            .is_empty());
    }

    #[test]
    fn a_logical_point_becomes_physical_with_the_scale_factor() {
        assert_eq!(to_physical(100.4, -20.0, 1.5), (151, -30));
        assert_eq!(to_physical(800.0, 600.0, 1.0), (800, 600));
        assert_eq!(to_physical(-0.2, 0.2, 2.0), (0, 0));
    }
}
