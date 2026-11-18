//! Forwards core events to the windows as Tauri events.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use skopos_core::app_core::{AppCore, CoreEvent};
use skopos_core::cluster::ConnectionState;
use skopos_core::kubeconfig::{ClusterId, SyncWarning};
use skopos_core::portforward::PortForward;
use skopos_core::windows::WindowLayout;
use tauri::{AppHandle, Emitter, EventTarget};
use tokio::sync::broadcast::error::RecvError;

const CATALOG_CHANGED: &str = "catalog://changed";
const CATALOG_FOLDERS_CHANGED: &str = "catalog://folders-changed";
const CLUSTER_STATE: &str = "cluster://state";
const KUBECONFIG_WARNINGS: &str = "kubeconfig://warnings";
const STORE_WARNING: &str = "store://warning";
const PORTFORWARD_CHANGED: &str = "portforward://changed";
const TOOLS_PROGRESS: &str = "tools://progress";
const WINDOW_LAYOUT: &str = "window://layout";

/// The page has loaded by the time this starts, but its listeners register
/// asynchronously afterwards, and an event sent before that is lost.
const LISTENER_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Serialize)]
struct ClusterStatePayload {
    id: ClusterId,
    state: ConnectionState,
}

/// Where a core event goes: its Tauri name, the windows that get it and its payload.
/// Shared state reaches every window; a layout reaches only its own window (P36).
fn route(event: CoreEvent) -> serde_json::Result<(&'static str, EventTarget, Value)> {
    let to_all = |name, payload| Ok((name, EventTarget::Any, payload));
    match event {
        CoreEvent::CatalogChanged => to_all(CATALOG_CHANGED, Value::Null),
        CoreEvent::ClusterState { id, state } => to_all(
            CLUSTER_STATE,
            serde_json::to_value(ClusterStatePayload { id, state })?,
        ),
        CoreEvent::KubeconfigWarnings { warnings } => {
            to_all(KUBECONFIG_WARNINGS, serde_json::to_value(warnings)?)
        }
        CoreEvent::StoreWarning { warning } => {
            to_all(STORE_WARNING, serde_json::to_value(warning)?)
        }
        CoreEvent::PortForwardsChanged { forwards } => {
            to_all(PORTFORWARD_CHANGED, serde_json::to_value(forwards)?)
        }
        CoreEvent::ToolProgress { progress } => {
            to_all(TOOLS_PROGRESS, serde_json::to_value(progress)?)
        }
        CoreEvent::CatalogFoldersChanged => to_all(CATALOG_FOLDERS_CHANGED, Value::Null),
        CoreEvent::WindowLayoutChanged { layout } => Ok((
            WINDOW_LAYOUT,
            EventTarget::webview_window(layout.label.clone()),
            serde_json::to_value(layout)?,
        )),
    }
}

fn emit(app: &AppHandle, event: CoreEvent) {
    let sent = match route(event) {
        Ok((name, target, payload)) => app.emit_to(target, name, payload),
        Err(e) => {
            tracing::warn!("cannot encode an event for the window: {e}");
            return;
        }
    };
    if let Err(e) = sent {
        tracing::warn!("cannot send an event to the window: {e}");
    }
}

/// What a window must read again after the forwarder missed events: the shared state,
/// and each open window's own layout.
fn resync_events(
    warnings: Vec<SyncWarning>,
    forwards: Vec<PortForward>,
    layouts: Vec<WindowLayout>,
) -> Vec<CoreEvent> {
    let shared = [
        CoreEvent::CatalogChanged,
        CoreEvent::CatalogFoldersChanged,
        CoreEvent::KubeconfigWarnings { warnings },
        CoreEvent::PortForwardsChanged { forwards },
    ];
    let layouts = layouts
        .into_iter()
        .map(|layout| CoreEvent::WindowLayoutChanged { layout });
    shared.into_iter().chain(layouts).collect()
}

pub fn spawn_forwarder(app: AppHandle, core: AppCore) {
    let mut events = core.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => emit(&app, event),
                // Events were missed, so have the UI read the current state again.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("missed {missed} core events");
                    let resync = resync_events(
                        core.catalog_warnings(),
                        core.portforward_list(),
                        core.windows_list(),
                    );
                    for event in resync {
                        emit(&app, event);
                    }
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

/// Call once the page has loaded. Each warning is sent only once, so a reload
/// does not repeat them, and logged in case the page was not listening yet.
pub fn send_startup_warnings(app: &AppHandle, core: &AppCore) {
    let warnings = core.take_startup_warnings();
    if warnings.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LISTENER_GRACE).await;
        for warning in warnings {
            tracing::warn!("{}: {}", warning.file, warning.message);
            emit(&app, CoreEvent::StoreWarning { warning });
        }
    });
}

#[cfg(test)]
mod tests {
    use skopos_core::windows::{start_layout, WindowLayout};

    use super::*;

    fn layout(label: &str) -> WindowLayout {
        WindowLayout {
            label: label.to_owned(),
            ..start_layout()
        }
    }

    #[test]
    fn a_window_layout_goes_only_to_its_window() {
        let (name, target, payload) = route(CoreEvent::WindowLayoutChanged {
            layout: layout("window-2"),
        })
        .unwrap();

        assert_eq!(name, "window://layout");
        assert_eq!(target, EventTarget::webview_window("window-2"));
        assert_eq!(payload["label"], "window-2");
        assert_eq!(payload["panes"][0]["tabs"][0]["history"][0], "/catalog");
    }

    #[test]
    fn shared_state_goes_to_every_window() {
        let (name, target, payload) = route(CoreEvent::CatalogFoldersChanged).unwrap();
        assert_eq!(name, "catalog://folders-changed");
        assert_eq!(target, EventTarget::Any);
        assert_eq!(payload, serde_json::Value::Null);

        let (name, target, payload) = route(CoreEvent::PortForwardsChanged {
            forwards: Vec::new(),
        })
        .unwrap();
        assert_eq!(name, "portforward://changed");
        assert_eq!(target, EventTarget::Any);
        assert_eq!(payload, serde_json::json!([]));
    }

    #[test]
    fn after_missed_events_every_window_gets_its_layout_again() {
        let events = resync_events(
            Vec::new(),
            Vec::new(),
            vec![layout("main"), layout("window-3")],
        );

        let routes: Vec<(&str, EventTarget)> = events
            .into_iter()
            .map(|event| {
                let (name, target, _) = route(event).unwrap();
                (name, target)
            })
            .collect();
        assert_eq!(
            routes,
            [
                ("catalog://changed", EventTarget::Any),
                ("catalog://folders-changed", EventTarget::Any),
                ("kubeconfig://warnings", EventTarget::Any),
                ("portforward://changed", EventTarget::Any),
                ("window://layout", EventTarget::webview_window("main")),
                ("window://layout", EventTarget::webview_window("window-3")),
            ]
        );
    }
}
