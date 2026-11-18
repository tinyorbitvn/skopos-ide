//! `AppCore` window layouts against real files in temp dirs (spec P31 to P39).

use skopos_core::app_core::{AppCore, CoreEvent};
use skopos_core::error::ErrorCode;
use skopos_core::paths::AppPaths;
use skopos_core::windows::{
    MoveOutcome, MoveTarget, PaneState, ScreenRect, TabState, WindowBounds, WindowLayout,
    MAIN_WINDOW,
};
use tempfile::TempDir;
use tokio::sync::broadcast::Receiver;

struct Fixture {
    _root: TempDir,
    _home: TempDir,
    paths: AppPaths,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(root.path(), home.path());
        Self {
            _root: root,
            _home: home,
            paths,
        }
    }

    fn windows_file(&self) -> std::path::PathBuf {
        self.paths.config.join("windows.json")
    }

    async fn start(&self) -> AppCore {
        AppCore::start_with_kubeconfig_env(self.paths.clone(), None)
            .await
            .unwrap()
    }
}

fn tab(id: &str, path: &str) -> TabState {
    TabState {
        id: id.to_owned(),
        pinned: false,
        history: vec!["/catalog".to_owned(), path.to_owned()],
        index: 1,
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

/// main: two panes, "a" pinned and "b" in the first, "c" in the second, focused.
fn two_panes() -> WindowLayout {
    let mut a = tab("a", "/cluster/kind-a/map");
    a.pinned = true;
    WindowLayout {
        label: MAIN_WINDOW.to_owned(),
        bounds: None,
        panes: vec![
            pane(
                "pane-a",
                0.4,
                vec![a, tab("b", "/cluster/kind-a/workloads")],
            ),
            pane("pane-b", 0.6, vec![tab("c", "/preferences")]),
        ],
        focused_pane: 1,
    }
}

fn tab_ids(layout: &WindowLayout) -> Vec<Vec<&str>> {
    layout
        .panes
        .iter()
        .map(|p| p.tabs.iter().map(|t| t.id.as_str()).collect())
        .collect()
}

/// The layouts sent as `WindowLayoutChanged`, by label, in order.
fn layout_events(events: &mut Receiver<CoreEvent>) -> Vec<WindowLayout> {
    let mut sent = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let CoreEvent::WindowLayoutChanged { layout } = event {
            sent.push(layout);
        }
    }
    sent
}

fn labels(layouts: &[WindowLayout]) -> Vec<&str> {
    layouts.iter().map(|l| l.label.as_str()).collect()
}

const BOUNDS: WindowBounds = WindowBounds {
    x: 40,
    y: 30,
    width: 1200,
    height: 800,
    maximized: false,
};

#[tokio::test]
async fn a_first_start_has_one_main_window_with_a_catalog_tab() {
    let fixture = Fixture::new();
    let core = fixture.start().await;

    let windows = core.windows_restore();

    assert_eq!(labels(&windows), [MAIN_WINDOW]);
    assert_eq!(windows[0].panes[0].tabs[0].history, ["/catalog"]);
    assert_eq!(core.window_layout(MAIN_WINDOW).unwrap(), windows[0]);
    let err = core.window_layout("window-2").unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.message, "That window is closed.");
    core.shutdown().await;
}

#[tokio::test]
async fn layouts_and_bounds_come_back_after_a_restart() {
    let fixture = Fixture::new();
    let core = fixture.start().await;

    core.window_layout_set(two_panes()).unwrap();
    core.window_bounds_set(MAIN_WINDOW, BOUNDS).unwrap();
    core.window_tab_move(MAIN_WINDOW, "b", MoveTarget::NewWindow { x: 900, y: 500 })
        .unwrap();
    let saved = core.windows_list();
    core.shutdown().await;

    let text = std::fs::read_to_string(fixture.windows_file()).unwrap();
    assert!(text.contains("\"version\": 1"), "{text}");
    let restarted = fixture.start().await;
    assert_eq!(restarted.windows_restore(), saved);
    assert_eq!(labels(&saved), [MAIN_WINDOW, "window-2"]);
    assert_eq!(saved[0].bounds, Some(BOUNDS));
    restarted.shutdown().await;
}

#[tokio::test]
async fn a_bad_windows_file_gives_the_start_layout_and_a_warning() {
    for text in ["{ nope", r#"{"version":2,"data":{"windows":[]}}"#] {
        let fixture = Fixture::new();
        std::fs::create_dir_all(&fixture.paths.config).unwrap();
        std::fs::write(fixture.windows_file(), text).unwrap();

        let core = fixture.start().await;

        let warnings = core.take_startup_warnings();
        let files: Vec<&str> = warnings.iter().map(|w| w.file.as_str()).collect();
        assert_eq!(files, ["windows.json"], "{text}");
        let windows = core.windows_restore();
        assert_eq!(labels(&windows), [MAIN_WINDOW]);
        assert_eq!(windows[0].panes[0].tabs[0].history, ["/catalog"]);
        // The next save replaces the file.
        core.window_layout_set(two_panes()).unwrap();
        let saved = std::fs::read_to_string(fixture.windows_file()).unwrap();
        assert!(saved.contains("pane-b"), "{saved}");
        core.shutdown().await;
    }
}

#[tokio::test]
async fn a_tab_moves_into_a_new_window_with_its_history_and_pin() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.window_layout_set(two_panes()).unwrap();
    core.window_bounds_set(MAIN_WINDOW, BOUNDS).unwrap();
    let mut events = core.subscribe();

    let outcome = core
        .window_tab_move(MAIN_WINDOW, "a", MoveTarget::NewWindow { x: 900, y: 500 })
        .unwrap();

    assert_eq!(
        outcome,
        MoveOutcome {
            target: "window-2".to_owned(),
            created: true,
            source_empty: false,
        }
    );
    let main = core.window_layout(MAIN_WINDOW).unwrap();
    assert_eq!(tab_ids(&main), [vec!["b"], vec!["c"]]);
    assert_eq!(main.panes[0].selected, "b");
    let new = core.window_layout("window-2").unwrap();
    assert_eq!(tab_ids(&new), [vec!["a"]]);
    assert_eq!(new.panes[0].selected, "a");
    assert_eq!(new.panes[0].width, 1.0);
    assert_eq!(new.panes[0].tabs[0], two_panes().panes[0].tabs[0]);
    // At the drop point, the size of the window it came from.
    assert_eq!(
        new.bounds,
        Some(WindowBounds {
            x: 900,
            y: 500,
            ..BOUNDS
        })
    );
    let sent = layout_events(&mut events);
    assert_eq!(labels(&sent), [MAIN_WINDOW, "window-2"]);
    assert_eq!(sent[0], main);
    assert_eq!(sent[1], new);
    core.shutdown().await;
}

#[tokio::test]
async fn a_tab_moves_to_the_end_of_another_windows_focused_pane() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.window_layout_set(two_panes()).unwrap();
    core.window_tab_move(MAIN_WINDOW, "b", MoveTarget::NewWindow { x: 0, y: 0 })
        .unwrap();
    let mut events = core.subscribe();

    let back = core
        .window_tab_move(
            "window-2",
            "b",
            MoveTarget::Window {
                label: MAIN_WINDOW.to_owned(),
            },
        )
        .unwrap();

    assert_eq!(
        back,
        MoveOutcome {
            target: MAIN_WINDOW.to_owned(),
            created: false,
            source_empty: true,
        }
    );
    let main = core.window_layout(MAIN_WINDOW).unwrap();
    assert_eq!(tab_ids(&main), [vec!["a"], vec!["c", "b"]]);
    assert_eq!(main.panes[1].selected, "b");
    assert_eq!(main.focused_pane, 1);
    let emptied = core.window_layout("window-2").unwrap();
    assert_eq!(tab_ids(&emptied), [Vec::<&str>::new()]);
    assert_eq!(
        labels(&layout_events(&mut events)),
        ["window-2", MAIN_WINDOW]
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_move_to_a_closed_window_or_of_an_unknown_tab_changes_nothing() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.window_layout_set(two_panes()).unwrap();
    let before = core.windows_list();
    let mut events = core.subscribe();

    let closed = core
        .window_tab_move(
            MAIN_WINDOW,
            "b",
            MoveTarget::Window {
                label: "window-7".to_owned(),
            },
        )
        .unwrap_err();
    let unknown = core
        .window_tab_move(MAIN_WINDOW, "zz", MoveTarget::NewWindow { x: 0, y: 0 })
        .unwrap_err();
    let from_closed = core
        .window_tab_move("window-7", "b", MoveTarget::NewWindow { x: 0, y: 0 })
        .unwrap_err();

    assert_eq!(closed.code, ErrorCode::NotFound);
    assert_eq!(closed.message, "That window is closed.");
    assert_eq!(unknown.code, ErrorCode::NotFound);
    assert_eq!(from_closed.code, ErrorCode::NotFound);
    assert_eq!(core.windows_list(), before);
    assert!(layout_events(&mut events).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn a_move_into_the_same_window_does_nothing() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.window_layout_set(two_panes()).unwrap();
    let mut events = core.subscribe();

    let outcome = core
        .window_tab_move(
            MAIN_WINDOW,
            "b",
            MoveTarget::Window {
                label: MAIN_WINDOW.to_owned(),
            },
        )
        .unwrap();

    assert_eq!(outcome.target, MAIN_WINDOW);
    assert!(!outcome.created && !outcome.source_empty);
    assert_eq!(
        tab_ids(&core.window_layout(MAIN_WINDOW).unwrap()),
        [vec!["a", "b"], vec!["c"]]
    );
    assert!(layout_events(&mut events).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn closing_a_window_drops_its_layout_and_frees_its_label() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.window_layout_set(two_panes()).unwrap();
    for id in ["a", "b"] {
        core.window_tab_move(MAIN_WINDOW, id, MoveTarget::NewWindow { x: 0, y: 0 })
            .unwrap();
    }
    assert_eq!(
        labels(&core.windows_list()),
        [MAIN_WINDOW, "window-2", "window-3"]
    );

    core.window_closed("window-2").unwrap();
    core.window_closed("window-2").unwrap();
    core.window_closed(MAIN_WINDOW).unwrap();

    assert_eq!(labels(&core.windows_list()), [MAIN_WINDOW, "window-3"]);
    // A save that arrives after the close is refused, so the window does not come back.
    let mut late = two_panes();
    late.label = "window-2".to_owned();
    late.panes.truncate(1);
    late.panes[0].tabs.truncate(1);
    late.panes[0].tabs[0].id = "a2".to_owned();
    late.panes[0].selected = "a2".to_owned();
    late.focused_pane = 0;
    assert_eq!(
        core.window_layout_set(late).unwrap_err().code,
        ErrorCode::NotFound
    );
    let outcome = core
        .window_tab_move(MAIN_WINDOW, "c", MoveTarget::NewWindow { x: 0, y: 0 })
        .unwrap();
    assert_eq!(outcome.target, "window-2");
    core.shutdown().await;
}

#[tokio::test]
async fn a_layout_save_keeps_the_bounds_and_drops_tabs_another_window_holds() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.window_layout_set(two_panes()).unwrap();
    core.window_bounds_set(MAIN_WINDOW, BOUNDS).unwrap();
    core.window_tab_move(MAIN_WINDOW, "b", MoveTarget::NewWindow { x: 0, y: 0 })
        .unwrap();
    let mut events = core.subscribe();

    // main's UI saves a layout from before the move, which still holds "b".
    let mut stale = two_panes();
    stale.bounds = None;
    core.window_layout_set(stale).unwrap();

    let main = core.window_layout(MAIN_WINDOW).unwrap();
    assert_eq!(tab_ids(&main), [vec!["a"], vec!["c"]]);
    assert_eq!(main.bounds, Some(BOUNDS));
    let sent = layout_events(&mut events);
    assert_eq!(
        sent,
        std::slice::from_ref(&main),
        "the corrected layout goes back to main"
    );

    // A save the core keeps as it is sends nothing back.
    core.window_layout_set(main).unwrap();
    assert!(layout_events(&mut events).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn bounds_of_a_closed_window_are_refused() {
    let fixture = Fixture::new();
    let core = fixture.start().await;

    let err = core.window_bounds_set("window-4", BOUNDS).unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
    core.shutdown().await;
}

#[tokio::test]
async fn the_window_at_a_point_follows_the_focus_order() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.window_layout_set(two_panes()).unwrap();
    core.window_tab_move(MAIN_WINDOW, "b", MoveTarget::NewWindow { x: 0, y: 0 })
        .unwrap();
    let both = [
        (
            MAIN_WINDOW.to_owned(),
            ScreenRect {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
        ),
        (
            "window-2".to_owned(),
            ScreenRect {
                x: 100,
                y: 100,
                width: 800,
                height: 600,
            },
        ),
    ];

    core.window_focused("window-2");
    core.window_focused(MAIN_WINDOW);
    assert_eq!(
        core.window_at(&both, 200, 200).as_deref(),
        Some(MAIN_WINDOW)
    );
    core.window_focused("window-2");
    assert_eq!(core.window_at(&both, 200, 200).as_deref(), Some("window-2"));
    core.window_closed("window-2").unwrap();
    assert_eq!(core.window_at(&both[1..], 200, 200), None);
    core.shutdown().await;
}
