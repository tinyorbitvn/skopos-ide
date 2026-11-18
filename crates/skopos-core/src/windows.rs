//! The layouts of every window (spec P31 to P39): each window's panes, tabs and
//! bounds, saved in `windows.json`, the move of a tab between windows, the window
//! under a point and the bounds clamp. The core does not know the UI's routes; a
//! window's UI drops the tabs it cannot show when it loads its layout.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::app_core::{AppCore, CoreEvent};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::store::{JsonStore, StoreWarning};

pub const MAIN_WINDOW: &str = "main";
/// Panes side by side in one window (P18).
pub const MAX_PANES: usize = 3;
/// Entries a tab's history keeps; older ones drop (P7).
pub const MAX_HISTORY: usize = 50;
const START_PATH: &str = "/catalog";
const WINDOW_PREFIX: &str = "window-";
const PANE_PREFIX: &str = "pane-";
/// The ui-state key of a window's dock layout is this and the label (P37).
const DOCK_LAYOUT_PREFIX: &str = "dock:layout:";
/// The size of a new window when the one its tab came from has no bounds yet, as
/// `main`'s entry in `tauri.conf.json`.
const DEFAULT_SIZE: (u32, u32) = (1360, 860);
/// How far apart two width sums may be and still count as 1.
const WIDTH_EPSILON: f64 = 1e-6;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TabState {
    pub id: String,
    pub pinned: bool,
    /// Paths with their query, oldest first.
    pub history: Vec<String>,
    /// The entry shown, into `history`.
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaneState {
    pub id: String,
    /// The pane's share of the window width; the shares of a window add up to 1.
    pub width: f64,
    /// The selected tab's id, or empty in a pane without tabs.
    pub selected: String,
    pub tabs: Vec<TabState>,
}

/// Outer position and size in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WindowLayout {
    pub label: String,
    /// Unknown until the app reports them; the window then opens at its default size.
    pub bounds: Option<WindowBounds>,
    pub panes: Vec<PaneState>,
    pub focused_pane: u32,
}

/// A rectangle on the desktop in physical pixels: a window's outer bounds or a
/// monitor's work area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Where `window_tab_move` puts a tab: another window, or a new one whose top-left
/// corner is at `x`, `y` (physical pixels).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum MoveTarget {
    Window { label: String },
    NewWindow { x: i32, y: i32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MoveOutcome {
    /// The label of the window that got the tab.
    pub target: String,
    /// True when that window is new, so the app must open it.
    pub created: bool,
    /// True when the source window has no tab left; the app closes it unless it is `main`.
    pub source_empty: bool,
}

/// The data of `windows.json`, inside the store's `{ "version": 1, "data": … }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct WindowsFile {
    pub(crate) windows: Vec<WindowLayout>,
}

fn closed() -> IpcError {
    IpcError::new(ErrorCode::NotFound, "That window is closed.")
}

fn invalid(message: &str) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

/// One `main` window with one pane and one Catalog tab (P39).
pub fn start_layout() -> WindowLayout {
    WindowLayout {
        label: MAIN_WINDOW.to_owned(),
        bounds: None,
        panes: vec![PaneState {
            id: "pane-1".to_owned(),
            width: 1.0,
            selected: "tab-1".to_owned(),
            tabs: vec![TabState {
                id: "tab-1".to_owned(),
                pinned: false,
                history: vec![START_PATH.to_owned()],
                index: 0,
            }],
        }],
        focused_pane: 0,
    }
}

fn contains(rect: &ScreenRect, x: i32, y: i32) -> bool {
    let (x, y) = (i64::from(x), i64::from(y));
    let (left, top) = (i64::from(rect.x), i64::from(rect.y));
    x >= left && x < left + i64::from(rect.width) && y >= top && y < top + i64::from(rect.height)
}

/// The window under a point (P31): of the candidates containing it, the one focused
/// most recently. Tauri has no z-order, so the focus order stands in for it; a
/// window never focused ranks after the others, in candidate order.
pub fn window_at_point(
    candidates: &[(String, ScreenRect)],
    focus_order: &[String],
    x: i32,
    y: i32,
) -> Option<String> {
    candidates
        .iter()
        .enumerate()
        .filter(|(_, (_, rect))| contains(rect, x, y))
        .min_by_key(|(at, (label, _))| {
            let rank = focus_order.iter().position(|l| l == label);
            (rank.unwrap_or(usize::MAX), *at)
        })
        .map(|(_, (label, _))| label.clone())
}

/// The area two rectangles share, in square pixels.
fn overlap(bounds: &WindowBounds, area: &ScreenRect) -> i64 {
    let span = |a: i32, a_len: u32, b: i32, b_len: u32| {
        let start = i64::from(a).max(i64::from(b));
        let end = (i64::from(a) + i64::from(a_len)).min(i64::from(b) + i64::from(b_len));
        (end - start).max(0)
    };
    span(bounds.x, bounds.width, area.x, area.width)
        * span(bounds.y, bounds.height, area.y, area.height)
}

/// `start` moved so that `len` fits inside `[area_start, area_start + area_len)`.
fn slide_into(start: i32, len: u32, area_start: i32, area_len: u32) -> i32 {
    let last = i64::from(area_start) + i64::from(area_len) - i64::from(len);
    i64::from(start).clamp(i64::from(area_start), last.max(i64::from(area_start))) as i32
}

/// Saved bounds made safe for the monitors there are now (P35). A window that
/// touches no monitor's work area moves to the centre of the primary one; a window
/// larger than the monitor it is mostly on shrinks to fit inside it. Anything else,
/// even a window partly off screen, stays where the user put it.
pub fn clamp_bounds(
    bounds: WindowBounds,
    monitors: &[ScreenRect],
    primary: ScreenRect,
) -> WindowBounds {
    let areas = if monitors.is_empty() {
        std::slice::from_ref(&primary)
    } else {
        monitors
    };
    let home = areas
        .iter()
        .map(|area| (overlap(&bounds, area), area))
        .filter(|(shared, _)| *shared > 0)
        .max_by_key(|(shared, _)| *shared)
        .map(|(_, area)| *area);
    match home {
        None => {
            let width = bounds.width.min(primary.width);
            let height = bounds.height.min(primary.height);
            WindowBounds {
                x: primary.x + ((primary.width - width) / 2) as i32,
                y: primary.y + ((primary.height - height) / 2) as i32,
                width,
                height,
                maximized: bounds.maximized,
            }
        }
        Some(area) if bounds.width > area.width || bounds.height > area.height => {
            let width = bounds.width.min(area.width);
            let height = bounds.height.min(area.height);
            WindowBounds {
                x: slide_into(bounds.x, width, area.x, area.width),
                y: slide_into(bounds.y, height, area.y, area.height),
                width,
                height,
                maximized: bounds.maximized,
            }
        }
        Some(_) => bounds,
    }
}

/// Removes a tab from a window. The pane's selection goes to the next tab, else the
/// previous one. A pane left empty closes, unless it is the window's last: its width
/// goes half to each neighbour, or all to its one neighbour, and its focus to the
/// pane on its left.
pub(crate) fn take_tab(layout: &mut WindowLayout, tab_id: &str) -> Option<TabState> {
    let (pane_at, tab_at) = layout.panes.iter().enumerate().find_map(|(p, pane)| {
        let t = pane.tabs.iter().position(|t| t.id == tab_id)?;
        Some((p, t))
    })?;
    let pane = &mut layout.panes[pane_at];
    let tab = pane.tabs.remove(tab_at);
    if pane.selected == tab.id {
        pane.selected = pane
            .tabs
            .get(tab_at)
            .or_else(|| pane.tabs.get(tab_at.wrapping_sub(1)))
            .map(|t| t.id.clone())
            .unwrap_or_default();
    }
    if pane.tabs.is_empty() && layout.panes.len() > 1 {
        let width = layout.panes.remove(pane_at).width;
        let left = pane_at.checked_sub(1);
        let right = (pane_at < layout.panes.len()).then_some(pane_at);
        match (left, right) {
            (Some(l), Some(r)) => {
                layout.panes[l].width += width / 2.0;
                layout.panes[r].width += width / 2.0;
            }
            (Some(only), None) | (None, Some(only)) => layout.panes[only].width += width,
            (None, None) => {}
        }
        let focused = layout.focused_pane as usize;
        if focused > pane_at || (focused == pane_at && pane_at > 0) {
            layout.focused_pane -= 1;
        }
    }
    Some(tab)
}

/// Adds a tab at the end of the window's focused pane and selects it (P33). A pinned
/// tab goes after the pane's pinned tabs, which stay first (P14).
pub(crate) fn put_tab(layout: &mut WindowLayout, tab: TabState) {
    let at = (layout.focused_pane as usize).min(layout.panes.len().saturating_sub(1));
    let Some(pane) = layout.panes.get_mut(at) else {
        return;
    };
    pane.selected = tab.id.clone();
    if tab.pinned {
        let after = pane.tabs.iter().take_while(|t| t.pinned).count();
        pane.tabs.insert(after, tab);
    } else {
        pane.tabs.push(tab);
    }
}

/// A layout made whole: tabs whose id is in `held` (another window has them) or
/// appears twice, and tabs with no history, are dropped; a history keeps its last
/// `MAX_HISTORY` entries and its index points into it; pinned tabs come first; a pane
/// left empty closes unless it is the last; the selection, the focused pane and the
/// widths are valid. No pane, or more than 3, is refused.
pub(crate) fn normalized(
    mut layout: WindowLayout,
    held: &HashSet<String>,
) -> CoreResult<WindowLayout> {
    if layout.panes.is_empty() {
        return Err(invalid("A window needs at least one pane."));
    }
    if layout.panes.len() > MAX_PANES {
        return Err(invalid("A window has at most 3 panes."));
    }
    let mut seen = HashSet::new();
    for pane in &mut layout.panes {
        pane.tabs.retain(|t| {
            !held.contains(&t.id) && !t.history.is_empty() && seen.insert(t.id.clone())
        });
        for tab in &mut pane.tabs {
            let extra = tab.history.len().saturating_sub(MAX_HISTORY);
            tab.history.drain(..extra);
            let index = (tab.index as usize).saturating_sub(extra);
            tab.index = index.min(tab.history.len() - 1) as u32;
        }
        let (pinned, unpinned): (Vec<TabState>, Vec<TabState>) = std::mem::take(&mut pane.tabs)
            .into_iter()
            .partition(|t| t.pinned);
        pane.tabs = pinned.into_iter().chain(unpinned).collect();
        if !pane.tabs.iter().any(|t| t.id == pane.selected) {
            pane.selected = pane.tabs.first().map(|t| t.id.clone()).unwrap_or_default();
        }
    }
    let focused = layout
        .panes
        .get(layout.focused_pane as usize)
        .map(|p| p.id.clone());
    if layout.panes.iter().any(|p| !p.tabs.is_empty()) {
        layout.panes.retain(|p| !p.tabs.is_empty());
    } else {
        layout.panes.truncate(1);
    }
    layout.focused_pane = focused
        .and_then(|id| layout.panes.iter().position(|p| p.id == id))
        .unwrap_or(0) as u32;
    let usable = layout
        .panes
        .iter()
        .all(|p| p.width.is_finite() && p.width > 0.0);
    let sum: f64 = layout.panes.iter().map(|p| p.width).sum();
    if !usable {
        let share = 1.0 / layout.panes.len() as f64;
        layout.panes.iter_mut().for_each(|p| p.width = share);
    } else if (sum - 1.0).abs() > WIDTH_EPSILON {
        layout.panes.iter_mut().for_each(|p| p.width /= sum);
    }
    Ok(layout)
}

/// `window-<n>` with the smallest n from 2 that no window uses.
pub(crate) fn next_window_label(file: &WindowsFile) -> String {
    (2..)
        .map(|n| format!("{WINDOW_PREFIX}{n}"))
        .find(|label| !file.windows.iter().any(|w| w.label == *label))
        .unwrap_or_default()
}

/// `pane-<n>` with the smallest n from 1 that no pane of any window uses.
fn next_pane_id(file: &WindowsFile) -> String {
    let used: HashSet<&str> = file
        .windows
        .iter()
        .flat_map(|w| w.panes.iter().map(|p| p.id.as_str()))
        .collect();
    (1..)
        .map(|n| format!("{PANE_PREFIX}{n}"))
        .find(|id| !used.contains(id.as_str()))
        .unwrap_or_default()
}

/// `main` first, then the others by their number.
fn sort_windows(file: &mut WindowsFile) {
    file.windows.sort_by_key(|w| {
        let number = w
            .label
            .strip_prefix(WINDOW_PREFIX)
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(u64::MAX);
        (w.label != MAIN_WINDOW, number, w.label.clone())
    });
}

/// The file with a `main` window, which every start has.
fn with_main(mut file: WindowsFile) -> WindowsFile {
    if !file.windows.iter().any(|w| w.label == MAIN_WINDOW) {
        file.windows.insert(0, start_layout());
    }
    file
}

/// A label the app can open a window for: `main`, or `window-<n>` with n from 2
/// written as `next_window_label` writes it (digits only, no leading zero).
fn is_window_label(label: &str) -> bool {
    if label == MAIN_WINDOW {
        return true;
    }
    label.strip_prefix(WINDOW_PREFIX).is_some_and(|n| {
        !n.starts_with('0')
            && n.bytes().all(|b| b.is_ascii_digit())
            && n.parse::<u64>().is_ok_and(|n| n >= 2)
    })
}

/// Gives each later use of a pane id the smallest `pane-<n>` no pane uses.
fn fresh_pane_ids(windows: &mut [WindowLayout]) {
    let mut used: HashSet<String> = windows
        .iter()
        .flat_map(|w| w.panes.iter().map(|p| p.id.clone()))
        .collect();
    let mut seen = HashSet::new();
    for pane in windows.iter_mut().flat_map(|w| w.panes.iter_mut()) {
        if seen.insert(pane.id.clone()) {
            continue;
        }
        let id = (1..)
            .map(|n| format!("{PANE_PREFIX}{n}"))
            .find(|id| !used.contains(id))
            .unwrap_or_default();
        used.insert(id.clone());
        pane.id = id;
    }
}

/// The file as read from disk made whole (P39), `main` first: a window whose label
/// the app cannot open (not `main` nor `window-<n>`) or that repeats a label is
/// dropped; a pane id used twice gets a fresh id for its later uses; each layout is
/// normalized with no tab in two windows; a layout that cannot be made whole, or a
/// window other than `main` left with no tab, is dropped.
fn repaired(mut file: WindowsFile) -> WindowsFile {
    sort_windows(&mut file);
    let mut labels = HashSet::new();
    let mut openable: Vec<WindowLayout> = file
        .windows
        .into_iter()
        .filter(|w| is_window_label(&w.label) && labels.insert(w.label.clone()))
        .collect();
    fresh_pane_ids(&mut openable);
    let mut held = HashSet::new();
    let mut windows = Vec::new();
    for layout in openable {
        let Ok(layout) = normalized(layout, &held) else {
            continue;
        };
        let tabs: Vec<String> = layout
            .panes
            .iter()
            .flat_map(|p| p.tabs.iter().map(|t| t.id.clone()))
            .collect();
        if tabs.is_empty() && layout.label != MAIN_WINDOW {
            continue;
        }
        held.extend(tabs);
        windows.push(layout);
    }
    WindowsFile { windows }
}

fn tab_ids_except(file: &WindowsFile, label: &str) -> HashSet<String> {
    file.windows
        .iter()
        .filter(|w| w.label != label)
        .flat_map(|w| {
            w.panes
                .iter()
                .flat_map(|p| p.tabs.iter().map(|t| t.id.clone()))
        })
        .collect()
}

fn find<'a>(file: &'a WindowsFile, label: &str) -> CoreResult<&'a WindowLayout> {
    file.windows
        .iter()
        .find(|w| w.label == label)
        .ok_or_else(closed)
}

fn find_mut<'a>(file: &'a mut WindowsFile, label: &str) -> CoreResult<&'a mut WindowLayout> {
    file.windows
        .iter_mut()
        .find(|w| w.label == label)
        .ok_or_else(closed)
}

fn holds_tab(layout: &WindowLayout, tab_id: &str) -> bool {
    layout
        .panes
        .iter()
        .any(|p| p.tabs.iter().any(|t| t.id == tab_id))
}

fn tab_gone() -> IpcError {
    IpcError::new(ErrorCode::NotFound, "That tab is closed.")
}

/// The layouts of every window, saved in `windows.json`, and the order the windows
/// were focused in, which is not saved.
pub(crate) struct Windows {
    store: JsonStore<WindowsFile>,
    /// Labels, the most recently focused first.
    focus: Mutex<Vec<String>>,
    /// Where a failed save is reported (P44).
    events: broadcast::Sender<CoreEvent>,
}

impl Windows {
    /// A missing, unreadable or newer file gives the start layout and, but for a
    /// missing one, a warning; a file with a damaged layout is repaired and saved.
    /// A save that fails keeps the change in memory and warns once (P44).
    pub(crate) fn open(
        path: PathBuf,
        version: u32,
        events: broadcast::Sender<CoreEvent>,
    ) -> (Self, Option<StoreWarning>) {
        let (store, mut warning) = JsonStore::<WindowsFile>::open(path, version);
        let loaded = store.get();
        let fixed = repaired(loaded.clone());
        if fixed != loaded {
            tracing::warn!("windows.json: repaired window layouts the UI could not show");
            if let Ok(((), Some(failed))) = store.try_update_kept(|file| {
                *file = fixed;
                Ok(())
            }) {
                warning.get_or_insert(failed);
            }
        }
        let windows = Self {
            store,
            focus: Mutex::new(Vec::new()),
            events,
        };
        (windows, warning)
    }

    fn get(&self) -> WindowsFile {
        with_main(self.store.get())
    }

    /// A change that `f` accepts stays in memory even when `windows.json` cannot be
    /// written; the first failure of a run is sent as a `StoreWarning` (P44).
    fn change<R>(&self, f: impl FnOnce(&mut WindowsFile) -> CoreResult<R>) -> CoreResult<R> {
        let (out, warning) = self.store.try_update_kept(|file| {
            *file = with_main(std::mem::take(file));
            let out = f(file)?;
            sort_windows(file);
            Ok(out)
        })?;
        if let Some(warning) = warning {
            let _ = self.events.send(CoreEvent::StoreWarning { warning });
        }
        Ok(out)
    }

    fn focus(&self) -> MutexGuard<'_, Vec<String>> {
        self.focus.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl AppCore {
    /// Every saved layout, `main` first; the app opens a window for each at start.
    pub fn windows_restore(&self) -> Vec<WindowLayout> {
        self.windows_list()
    }

    /// The layouts of the open windows, `main` first.
    pub fn windows_list(&self) -> Vec<WindowLayout> {
        self.windows().get().windows
    }

    pub fn window_layout(&self, label: &str) -> CoreResult<WindowLayout> {
        find(&self.windows().get(), label).cloned()
    }

    /// Keeps a window's layout as its UI sends it, made whole (see `normalized`). The
    /// bounds stay the core's. When the core had to change the layout, for example to
    /// drop a tab that moved to another window while the save was on its way, it sends
    /// the result back to that window.
    pub fn window_layout_set(&self, layout: WindowLayout) -> CoreResult<()> {
        let label = layout.label.clone();
        let (kept, changed) = self.windows().change(|file| {
            let held = tab_ids_except(file, &label);
            let stored = find_mut(file, &label)?;
            let mut sent = layout;
            sent.bounds = stored.bounds;
            let kept = normalized(sent.clone(), &held)?;
            *stored = kept.clone();
            let changed = kept != sent;
            Ok((kept, changed))
        })?;
        if changed {
            self.emit(CoreEvent::WindowLayoutChanged { layout: kept });
        }
        Ok(())
    }

    /// The app reports a window's bounds when it moves, resizes, maximizes or closes.
    pub fn window_bounds_set(&self, label: &str, bounds: WindowBounds) -> CoreResult<()> {
        if find(&self.windows().get(), label)?.bounds == Some(bounds) {
            return Ok(());
        }
        self.windows().change(|file| {
            find_mut(file, label)?.bounds = Some(bounds);
            Ok(())
        })
    }

    /// Puts a window first in the focus order that `window_at` reads.
    pub fn window_focused(&self, label: &str) {
        if find(&self.windows().get(), label).is_err() {
            return;
        }
        let mut order = self.windows().focus();
        order.retain(|l| l != label);
        order.insert(0, label.to_owned());
    }

    /// The window under a point, of those with a layout (see `window_at_point`).
    pub fn window_at(&self, candidates: &[(String, ScreenRect)], x: i32, y: i32) -> Option<String> {
        let file = self.windows().get();
        let known: Vec<(String, ScreenRect)> = candidates
            .iter()
            .filter(|(label, _)| find(&file, label).is_ok())
            .cloned()
            .collect();
        let order = self.windows().focus().clone();
        window_at_point(&known, &order, x, y)
    }

    /// Moves a tab to another window, or to a new one, in one step (P33): it leaves
    /// its pane (an emptied pane closes), goes last in the target's focused pane,
    /// selected, with its history and pin, and both windows get their new layout. A
    /// new window is `window-<n>` with the smallest free n from 2, at the given point,
    /// the size of the window the tab came from. A move into the tab's own window
    /// changes nothing.
    pub fn window_tab_move(
        &self,
        from: &str,
        tab_id: &str,
        target: MoveTarget,
    ) -> CoreResult<MoveOutcome> {
        if let MoveTarget::Window { label } = &target {
            if label == from {
                let file = self.windows().get();
                if !holds_tab(find(&file, from)?, tab_id) {
                    return Err(tab_gone());
                }
                return Ok(MoveOutcome {
                    target: from.to_owned(),
                    created: false,
                    source_empty: false,
                });
            }
        }
        let (outcome, source, destination) = self.windows().change(|file| {
            let source = find(file, from)?;
            if !holds_tab(source, tab_id) {
                return Err(tab_gone());
            }
            let source_bounds = source.bounds;
            let (target_label, created) = match target {
                MoveTarget::Window { label } => {
                    find(file, &label)?;
                    (label, false)
                }
                MoveTarget::NewWindow { x, y } => {
                    let label = next_window_label(file);
                    let (width, height) =
                        source_bounds.map_or(DEFAULT_SIZE, |b| (b.width, b.height));
                    let pane = PaneState {
                        id: next_pane_id(file),
                        width: 1.0,
                        selected: String::new(),
                        tabs: Vec::new(),
                    };
                    file.windows.push(WindowLayout {
                        label: label.clone(),
                        bounds: Some(WindowBounds {
                            x,
                            y,
                            width,
                            height,
                            maximized: false,
                        }),
                        panes: vec![pane],
                        focused_pane: 0,
                    });
                    (label, true)
                }
            };
            let source = find_mut(file, from)?;
            let tab = take_tab(source, tab_id).ok_or_else(tab_gone)?;
            let source_empty = source.panes.iter().all(|p| p.tabs.is_empty());
            let source = source.clone();
            let destination = find_mut(file, &target_label)?;
            put_tab(destination, tab);
            let destination = destination.clone();
            let outcome = MoveOutcome {
                target: target_label,
                created,
                source_empty,
            };
            Ok((outcome, source, destination))
        })?;
        self.emit(CoreEvent::WindowLayoutChanged { layout: source });
        self.emit(CoreEvent::WindowLayoutChanged {
            layout: destination,
        });
        Ok(outcome)
    }

    /// Drops the layout and the dock layout of a closed window other than `main`
    /// (P34, P37), so a later window with its label starts with an empty dock.
    /// Closing `main` quits the app, and every layout stays for the next start.
    /// Closing a window twice is fine.
    pub fn window_closed(&self, label: &str) -> CoreResult<()> {
        if label == MAIN_WINDOW {
            return Ok(());
        }
        if find(&self.windows().get(), label).is_ok() {
            self.windows().change(|file| {
                file.windows.retain(|w| w.label != label);
                Ok(())
            })?;
            self.windows().focus().retain(|l| l != label);
        }
        // The window is gone either way; a dock layout left behind is logged.
        if let Err(e) = self.ui_state_remove(&format!("{DOCK_LAYOUT_PREFIX}{label}")) {
            tracing::warn!("ui-state.json: cannot drop the dock layout of {label}: {e}");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> TabState {
        TabState {
            id: id.to_owned(),
            pinned: false,
            history: vec![format!("/cluster/{id}")],
            index: 0,
        }
    }

    fn pinned(id: &str) -> TabState {
        TabState {
            pinned: true,
            ..tab(id)
        }
    }

    fn pane(id: &str, width: f64, tabs: Vec<TabState>) -> PaneState {
        PaneState {
            id: id.to_owned(),
            width,
            selected: tabs.first().map(|t| t.id.clone()).unwrap_or_default(),
            tabs,
        }
    }

    fn window(label: &str, panes: Vec<PaneState>, focused_pane: u32) -> WindowLayout {
        WindowLayout {
            label: label.to_owned(),
            bounds: None,
            panes,
            focused_pane,
        }
    }

    /// "p1:*a,b^ | p2:*c @1": `*` marks the selected tab, `^` a pinned one, `@` the
    /// focused pane.
    fn shape(layout: &WindowLayout) -> String {
        let panes: Vec<String> = layout
            .panes
            .iter()
            .map(|p| {
                let tabs: Vec<String> = p
                    .tabs
                    .iter()
                    .map(|t| {
                        let mark = if t.id == p.selected { "*" } else { "" };
                        let pin = if t.pinned { "^" } else { "" };
                        format!("{mark}{}{pin}", t.id)
                    })
                    .collect();
                format!("{}:{}", p.id, tabs.join(","))
            })
            .collect();
        format!("{} @{}", panes.join(" | "), layout.focused_pane)
    }

    fn widths(layout: &WindowLayout) -> Vec<f64> {
        layout.panes.iter().map(|p| p.width).collect()
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn bounds(x: i32, y: i32, width: u32, height: u32) -> WindowBounds {
        WindowBounds {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    #[test]
    fn the_start_layout_is_one_main_window_with_a_catalog_tab() {
        let layout = start_layout();

        assert_eq!(layout.label, MAIN_WINDOW);
        assert_eq!(layout.bounds, None);
        assert_eq!(shape(&layout), "pane-1:*tab-1 @0");
        assert_eq!(layout.panes[0].tabs[0].history, ["/catalog"]);
        assert_eq!(widths(&layout), [1.0]);
    }

    #[test]
    fn layouts_serialize_for_the_ui() {
        let value = serde_json::to_value(start_layout()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "label": "main",
                "bounds": null,
                "panes": [{
                    "id": "pane-1",
                    "width": 1.0,
                    "selected": "tab-1",
                    "tabs": [{ "id": "tab-1", "pinned": false, "history": ["/catalog"], "index": 0 }],
                }],
                "focusedPane": 0,
            })
        );
        let target: MoveTarget =
            serde_json::from_value(serde_json::json!({ "kind": "newWindow", "x": 5, "y": -3 }))
                .unwrap();
        assert_eq!(target, MoveTarget::NewWindow { x: 5, y: -3 });
        let target: MoveTarget =
            serde_json::from_value(serde_json::json!({ "kind": "window", "label": "main" }))
                .unwrap();
        assert_eq!(
            target,
            MoveTarget::Window {
                label: "main".to_owned()
            }
        );
    }

    #[test]
    fn the_window_at_a_point_is_the_most_recently_focused_one_containing_it() {
        let candidates = [
            ("main".to_owned(), rect(0, 0, 800, 600)),
            ("window-2".to_owned(), rect(400, 300, 800, 600)),
            ("window-3".to_owned(), rect(500, 400, 100, 100)),
        ];
        let order = ["window-2".to_owned(), "main".to_owned()];

        // Only main holds (10, 10); both main and window-2 hold (500, 350).
        assert_eq!(
            window_at_point(&candidates, &order, 10, 10).as_deref(),
            Some("main")
        );
        assert_eq!(
            window_at_point(&candidates, &order, 500, 350).as_deref(),
            Some("window-2")
        );
        let main_first = ["main".to_owned(), "window-2".to_owned()];
        assert_eq!(
            window_at_point(&candidates, &main_first, 500, 350).as_deref(),
            Some("main")
        );
        // A window never focused ranks after the focused ones.
        assert_eq!(
            window_at_point(&candidates, &order, 550, 450).as_deref(),
            Some("window-2")
        );
        assert_eq!(
            window_at_point(&candidates, &[], 550, 450).as_deref(),
            Some("main")
        );
        // The right and bottom edges are outside.
        assert_eq!(window_at_point(&candidates, &order, 1200, 100), None);
        assert_eq!(window_at_point(&candidates, &order, -1, 0), None);
    }

    #[test]
    fn bounds_on_a_monitor_stay_as_they_are() {
        let primary = rect(0, 0, 1920, 1040);
        let second = rect(1920, 0, 1280, 1024);
        let partly_off = bounds(1800, -20, 1000, 700);

        assert_eq!(
            clamp_bounds(partly_off, &[primary, second], primary),
            partly_off
        );
    }

    #[test]
    fn a_window_on_a_missing_monitor_moves_to_the_centre_of_the_primary() {
        let primary = rect(0, 0, 1920, 1040);
        // Saved on a monitor right of the primary that is no longer there.
        let lost = WindowBounds {
            maximized: true,
            ..bounds(2200, 100, 1000, 700)
        };

        let clamped = clamp_bounds(lost, &[primary], primary);

        assert_eq!(
            clamped,
            WindowBounds {
                maximized: true,
                ..bounds(460, 170, 1000, 700)
            }
        );
    }

    #[test]
    fn a_window_larger_than_its_monitor_shrinks_to_fit_it() {
        let primary = rect(0, 0, 1920, 1040);
        let small = rect(1920, 0, 1280, 1024);

        let clamped = clamp_bounds(bounds(1900, 10, 1600, 1200), &[primary, small], primary);

        // Most of it was on the small monitor, so it fits that one.
        assert_eq!(clamped, bounds(1920, 0, 1280, 1024));
        // Off every monitor and too large: it shrinks to the primary and is centred.
        let primary_at = rect(100, 50, 1000, 800);
        assert_eq!(
            clamp_bounds(bounds(-5000, 0, 1600, 600), &[], primary_at),
            bounds(100, 150, 1000, 600)
        );
    }

    #[test]
    fn a_moved_tab_goes_last_in_the_focused_pane_and_is_selected() {
        let mut target = window(
            "main",
            vec![
                pane("p1", 0.5, vec![tab("a")]),
                pane("p2", 0.5, vec![tab("b")]),
            ],
            1,
        );

        put_tab(&mut target, tab("t"));

        assert_eq!(shape(&target), "p1:*a | p2:b,*t @1");
    }

    #[test]
    fn a_moved_pinned_tab_goes_after_the_pinned_ones() {
        let mut target = window(
            "main",
            vec![pane("p1", 1.0, vec![pinned("a"), tab("b")])],
            0,
        );

        put_tab(&mut target, pinned("t"));

        assert_eq!(shape(&target), "p1:a^,*t^,b @0");
    }

    #[test]
    fn taking_the_selected_tab_selects_the_next_one_else_the_previous() {
        let mut source = window(
            "main",
            vec![pane("p1", 1.0, vec![tab("a"), tab("b"), tab("c")])],
            0,
        );
        source.panes[0].selected = "b".to_owned();

        let taken = take_tab(&mut source, "b").unwrap();
        assert_eq!(taken, tab("b"));
        assert_eq!(shape(&source), "p1:a,*c @0");

        take_tab(&mut source, "c").unwrap();
        assert_eq!(shape(&source), "p1:*a @0");
        take_tab(&mut source, "a").unwrap();
        // The last pane stays, empty.
        assert_eq!(shape(&source), "p1: @0");
        assert_eq!(take_tab(&mut source, "a"), None);
    }

    #[test]
    fn a_pane_left_empty_closes_and_its_width_goes_to_its_neighbours() {
        let mut middle = window(
            "main",
            vec![
                pane("p1", 0.25, vec![tab("a")]),
                pane("p2", 0.5, vec![tab("b")]),
                pane("p3", 0.25, vec![tab("c")]),
            ],
            1,
        );

        take_tab(&mut middle, "b").unwrap();

        assert_eq!(shape(&middle), "p1:*a | p3:*c @0");
        assert_eq!(widths(&middle), [0.5, 0.5]);

        let mut edge = window(
            "main",
            vec![
                pane("p1", 0.2, vec![tab("a")]),
                pane("p2", 0.3, vec![tab("b")]),
                pane("p3", 0.5, vec![tab("c")]),
            ],
            2,
        );

        take_tab(&mut edge, "a").unwrap();

        assert_eq!(shape(&edge), "p2:*b | p3:*c @1");
        assert_eq!(widths(&edge), [0.5, 0.5]);
    }

    #[test]
    fn a_layout_is_made_whole_before_it_is_kept() {
        let mut long = tab("long");
        long.history = (0..60).map(|i| format!("/p{i}")).collect();
        long.index = 59;
        let mut ahead = tab("ahead");
        ahead.index = 7;
        let mut empty = tab("empty");
        empty.history.clear();
        let mut layout = window(
            "main",
            vec![
                pane("p1", 2.0, vec![tab("a"), pinned("pin"), long, ahead]),
                pane("p2", 2.0, vec![tab("held"), empty, tab("a")]),
            ],
            5,
        );
        layout.panes[0].selected = "gone".to_owned();
        let held = std::collections::HashSet::from(["held".to_owned()]);

        let whole = normalized(layout, &held).unwrap();

        // Pinned first, duplicates, tabs another window holds and empty histories dropped.
        assert_eq!(shape(&whole), "p1:*pin^,a,long,ahead @0");
        assert_eq!(widths(&whole), [1.0]);
        let long = &whole.panes[0].tabs[2];
        assert_eq!(long.history.len(), MAX_HISTORY);
        assert_eq!(long.history[0], "/p10");
        assert_eq!(long.index, 49);
        assert_eq!(whole.panes[0].tabs[3].index, 0);
    }

    #[test]
    fn a_layout_without_panes_or_with_four_is_refused() {
        let none = window("main", vec![], 0);
        let four = window(
            "main",
            (1..=4)
                .map(|i| pane(&format!("p{i}"), 0.25, vec![tab(&format!("t{i}"))]))
                .collect(),
            0,
        );
        let held = std::collections::HashSet::new();

        assert!(normalized(none, &held).is_err());
        assert!(normalized(four, &held).is_err());
    }

    #[test]
    fn widths_that_do_not_add_up_are_scaled_or_made_equal() {
        let held = std::collections::HashSet::new();
        let scaled = window(
            "main",
            vec![
                pane("p1", 1.0, vec![tab("a")]),
                pane("p2", 3.0, vec![tab("b")]),
            ],
            0,
        );
        let broken = window(
            "main",
            vec![
                pane("p1", f64::NAN, vec![tab("a")]),
                pane("p2", 0.5, vec![tab("b")]),
            ],
            0,
        );

        assert_eq!(widths(&normalized(scaled, &held).unwrap()), [0.25, 0.75]);
        assert_eq!(widths(&normalized(broken, &held).unwrap()), [0.5, 0.5]);
    }

    #[test]
    fn new_windows_take_the_smallest_free_number_from_2() {
        let mut file = WindowsFile {
            windows: vec![start_layout()],
        };
        assert_eq!(next_window_label(&file), "window-2");
        file.windows
            .push(window("window-3", vec![pane("p9", 1.0, vec![])], 0));
        assert_eq!(next_window_label(&file), "window-2");
        file.windows
            .push(window("window-2", vec![pane("p8", 1.0, vec![])], 0));
        assert_eq!(next_window_label(&file), "window-4");
    }

    fn file_labels(file: &WindowsFile) -> Vec<&str> {
        file.windows.iter().map(|w| w.label.as_str()).collect()
    }

    fn one_tab(label: &str, tab_id: &str) -> WindowLayout {
        window(
            label,
            vec![pane(&format!("pane-{tab_id}"), 1.0, vec![tab(tab_id)])],
            0,
        )
    }

    #[test]
    fn only_main_and_numbered_windows_from_2_are_kept() {
        let labels = [
            "main",
            "foo",
            "window-1",
            "window-02",
            "window-2x",
            "window-",
            "Window-3",
            "window-+4",
            "window-99999999999999999999999",
            "window-3",
            "window-2",
        ];
        let windows = labels
            .iter()
            .enumerate()
            .map(|(at, label)| one_tab(label, &format!("t{at}")))
            .collect();

        let fixed = repaired(WindowsFile { windows });

        assert_eq!(file_labels(&fixed), ["main", "window-2", "window-3"]);
    }

    #[test]
    fn a_window_other_than_main_left_without_tabs_is_dropped() {
        let no_history = TabState {
            history: Vec::new(),
            ..tab("x")
        };
        let windows = vec![
            window("main", vec![pane("p1", 1.0, vec![])], 0),
            window("window-2", vec![pane("p2", 1.0, vec![])], 0),
            window("window-3", vec![pane("p3", 1.0, vec![no_history])], 0),
            one_tab("window-4", "a"),
            // Its one tab is window-4's.
            one_tab("window-5", "a"),
        ];

        let fixed = repaired(WindowsFile { windows });

        assert_eq!(file_labels(&fixed), ["main", "window-4"]);
        assert_eq!(shape(&fixed.windows[0]), "p1: @0");
    }

    #[test]
    fn a_pane_id_used_twice_gets_a_fresh_one_for_its_later_uses() {
        let windows = vec![
            window("window-3", vec![pane("pane-2", 1.0, vec![tab("d")])], 0),
            window(
                "main",
                vec![
                    pane("pane-1", 0.5, vec![tab("a")]),
                    pane("pane-1", 0.5, vec![tab("b")]),
                ],
                1,
            ),
            window("window-2", vec![pane("pane-1", 1.0, vec![tab("c")])], 0),
        ];

        let fixed = repaired(WindowsFile { windows });

        let shapes: Vec<String> = fixed.windows.iter().map(shape).collect();
        assert_eq!(
            shapes,
            ["pane-1:*a | pane-3:*b @1", "pane-4:*c @0", "pane-2:*d @0"]
        );
    }
}
