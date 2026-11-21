//! The node topology (topology spec §4.2).

use std::sync::Arc;

use serde::{Serialize, Serializer};
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::topology::TopologyEvent;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use crate::state::AppState;

/// Snapshots wait here while the webview catches up.
const FORWARD_BACKLOG: usize = 8;

/// An event the topology shares between subscriptions, written as the event it holds (as
/// `graph::SharedEvent`: serde's `rc` feature is off).
pub struct SharedTopologyEvent(pub Arc<TopologyEvent>);

impl Serialize for SharedTopologyEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(serializer)
    }
}

/// Streams the cluster's node topology to `on_event` and returns the subscription id. The
/// subscription belongs to the window that asks and ends when its page loads again or it
/// closes; so does one whose channel can no longer be written.
#[tauri::command]
pub async fn node_topology_subscribe(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    on_event: Channel<SharedTopologyEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(FORWARD_BACKLOG);
    let id = state
        .core
        .node_topology_subscribe(&cluster_id, tx, window.label())?;
    let core = state.core.clone();
    let subscription = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(SharedTopologyEvent(event)).is_err() {
                core.node_topology_unsubscribe(&subscription);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn node_topology_unsubscribe(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), IpcError> {
    state.core.node_topology_unsubscribe(&subscription_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use skopos_core::topology::TopologySnapshot;

    use super::*;

    #[test]
    fn a_shared_event_serializes_as_the_event_it_holds() {
        for event in [
            TopologyEvent::Failure {
                message: "Listing nodes is not allowed".to_owned(),
            },
            TopologyEvent::Snapshot {
                snapshot: TopologySnapshot {
                    regions: Vec::new(),
                    node_count: 0,
                    pod_count: 0,
                    pods_hidden: true,
                },
            },
        ] {
            let shared = SharedTopologyEvent(Arc::new(event.clone()));
            assert_eq!(
                serde_json::to_value(&shared).unwrap(),
                serde_json::to_value(&event).unwrap()
            );
        }
    }
}
