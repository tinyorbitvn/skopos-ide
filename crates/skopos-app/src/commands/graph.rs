//! The resource graph (spec E §4.1).

use std::sync::Arc;

use serde::{Serialize, Serializer};
use skopos_core::error::IpcError;
use skopos_core::graph::GraphEvent;
use skopos_core::kubeconfig::ClusterId;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use crate::state::AppState;

/// Snapshots wait here while the webview catches up.
const FORWARD_BACKLOG: usize = 8;

/// An event the hub shares between subscriptions. serde's `rc` feature is off, so an `Arc`
/// has no `Serialize` of its own; this writes the event it holds, which the webview sees
/// exactly as before.
pub struct SharedEvent(pub Arc<GraphEvent>);

impl Serialize for SharedEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(serializer)
    }
}

/// Streams the cluster's graph to `on_event` and returns the subscription id. The
/// subscription belongs to the window that asks and ends when its page loads again or it
/// closes, so its graph does not outlive the page; so does one whose channel can no longer
/// be written.
#[tauri::command]
pub async fn resource_graph_subscribe(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespaces: Option<Vec<String>>,
    on_event: Channel<SharedEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(FORWARD_BACKLOG);
    let id = state
        .core
        .resource_graph_subscribe(&cluster_id, namespaces, tx, window.label())?;
    let core = state.core.clone();
    let subscription = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(SharedEvent(event)).is_err() {
                core.resource_graph_unsubscribe(&subscription);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn resource_graph_unsubscribe(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), IpcError> {
    state.core.resource_graph_unsubscribe(&subscription_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shared_event_serializes_as_the_event_it_holds() {
        for event in [
            GraphEvent::Failure {
                message: "discovery failed".to_owned(),
            },
            GraphEvent::Snapshot {
                nodes: Vec::new(),
                edges: Vec::new(),
                counts: Vec::new(),
                missing: vec!["gateways".to_owned()],
                gateway_api: true,
            },
        ] {
            let shared = SharedEvent(Arc::new(event.clone()));
            assert_eq!(
                serde_json::to_value(&shared).unwrap(),
                serde_json::to_value(&event).unwrap()
            );
        }
    }
}
