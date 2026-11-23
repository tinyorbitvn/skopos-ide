//! Reachability of a namespace (network policies spec §7.4).

use std::sync::Arc;

use serde::{Serialize, Serializer};
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::reachability::ReachEvent;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use crate::state::AppState;

/// Snapshots wait here while the webview catches up.
const FORWARD_BACKLOG: usize = 8;

/// An event the reachability hub shares between subscriptions, written as the event it
/// holds (as `topology::SharedTopologyEvent`: serde's `rc` feature is off).
pub struct SharedReachEvent(pub Arc<ReachEvent>);

impl Serialize for SharedReachEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(serializer)
    }
}

/// Streams the reachability of `namespace` to `on_event` and returns the subscription id.
/// The subscription belongs to the window that asks and ends when its page loads again or
/// it closes; so does one whose channel can no longer be written.
#[tauri::command]
pub async fn network_reachability_subscribe(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    on_event: Channel<SharedReachEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(FORWARD_BACKLOG);
    let id =
        state
            .core
            .network_reachability_subscribe(&cluster_id, namespace, tx, window.label())?;
    let core = state.core.clone();
    let subscription = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(SharedReachEvent(event)).is_err() {
                core.network_reachability_unsubscribe(&subscription);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn network_reachability_unsubscribe(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), IpcError> {
    state
        .core
        .network_reachability_unsubscribe(&subscription_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use skopos_core::reachability::ReachCounts;

    use super::*;

    /// A snapshot of `payments` with no workloads, as the hub sends for an empty namespace.
    fn empty_snapshot() -> ReachEvent {
        ReachEvent::Snapshot {
            namespace: "payments".to_owned(),
            groups: Vec::new(),
            peers: Vec::new(),
            cells: Vec::new(),
            counts: ReachCounts {
                kubernetes: 6,
                cilium: 4,
            },
            not_evaluated: Vec::new(),
            missing: Vec::new(),
            cilium: true,
            truncated: 0,
        }
    }

    #[test]
    fn a_shared_event_serializes_as_the_event_it_holds() {
        for event in [
            ReachEvent::Failure {
                message: "Pods cannot be listed: pods is forbidden".to_owned(),
            },
            empty_snapshot(),
        ] {
            let shared = SharedReachEvent(Arc::new(event.clone()));
            assert_eq!(
                serde_json::to_value(&shared).unwrap(),
                serde_json::to_value(&event).unwrap()
            );
        }
    }

    #[test]
    fn a_snapshot_reaches_the_page_tagged_and_in_camel_case() {
        let shared = SharedReachEvent(Arc::new(empty_snapshot()));
        assert_eq!(
            serde_json::to_value(&shared).unwrap(),
            serde_json::json!({
                "type": "snapshot",
                "namespace": "payments",
                "groups": [],
                "peers": [],
                "cells": [],
                "counts": { "kubernetes": 6, "cilium": 4 },
                "notEvaluated": [],
                "missing": [],
                "cilium": true,
                "truncated": 0
            })
        );
    }
}
