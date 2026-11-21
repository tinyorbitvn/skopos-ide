use serde_json::Value;
use skopos_core::app_core::AppCore;
use skopos_core::blocking::blocking;
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::openapi::KindSchema;
use skopos_core::resources::{
    ApiResourceInfo, ApplyResult, InvolvedRef, ObjectNames, Propagation, ResourceRef, WatchEvent,
};
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tokio::sync::mpsc;

use crate::state::AppState;

/// Events wait here while the webview catches up.
const FORWARD_BACKLOG: usize = 64;

#[tauri::command]
pub async fn resources_discover(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    refresh: bool,
) -> Result<Vec<ApiResourceInfo>, IpcError> {
    state.core.resources_discover(&cluster_id, refresh).await
}

/// The names of the palette's kinds (spec C §10.1).
#[tauri::command]
pub async fn resources_names(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<ObjectNames, IpcError> {
    state.core.resources_names(&cluster_id).await
}

/// Streams the resource to `on_event` and returns the subscription id. The subscription
/// belongs to the window that asks and ends when its page loads again or it closes, so
/// its watch does not outlive the page; so does one whose channel can no longer be written.
/// With `namespaces`, only the objects of those namespaces are sent; with none, all are.
#[tauri::command]
pub async fn resources_subscribe(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespaces: Vec<String>,
    on_event: Channel<WatchEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(FORWARD_BACKLOG);
    let id = state
        .core
        .resources_subscribe(&cluster_id, resource, namespaces, tx, window.label())
        .await?;
    forward(state.core.clone(), id.clone(), rx, on_event);
    Ok(id)
}

/// Streams one object to `on_event` and returns the subscription id, which
/// `resources_unsubscribe` ends. The rows are whole objects. It ends with the window's page
/// as `resources_subscribe` does.
#[tauri::command]
pub async fn resources_subscribe_object(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
    on_event: Channel<WatchEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(FORWARD_BACKLOG);
    let id = state
        .core
        .resources_subscribe_object(&cluster_id, resource, namespace, name, tx, window.label())
        .await?;
    forward(state.core.clone(), id.clone(), rx, on_event);
    Ok(id)
}

/// Streams the Pods bound to the node `node` to `on_event`, as the rows `resources_subscribe`
/// sends for Pods, and returns the subscription id, which `resources_unsubscribe` ends. The
/// API server picks the Pods, so those of the other nodes are never read. It ends with the
/// window's page as `resources_subscribe` does.
#[tauri::command]
pub async fn resources_subscribe_node_pods(
    window: WebviewWindow,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    node: String,
    on_event: Channel<WatchEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(FORWARD_BACKLOG);
    let id = state
        .core
        .resources_subscribe_node_pods(&cluster_id, node, tx, window.label())
        .await?;
    forward(state.core.clone(), id.clone(), rx, on_event);
    Ok(id)
}

/// Sends what the subscription delivers to the webview, and ends it when the webview is gone.
fn forward(
    core: AppCore,
    subscription: String,
    mut rx: mpsc::Receiver<WatchEvent>,
    on_event: Channel<WatchEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if !send_parts(&on_event, event) {
                core.resources_unsubscribe(&subscription);
                break;
            }
        }
    });
}

/// Sends `event` to the webview, a large snapshot a part at a time, so that no single
/// message takes the webview long to parse. The parts go one after another, with no other
/// event between them. False once the channel can no longer be written.
fn send_parts(on_event: &Channel<WatchEvent>, event: WatchEvent) -> bool {
    event
        .into_parts()
        .into_iter()
        .all(|part| on_event.send(part).is_ok())
}

#[tauri::command]
pub async fn resources_unsubscribe(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), IpcError> {
    state.core.resources_unsubscribe(&subscription_id);
    Ok(())
}

#[tauri::command]
pub async fn resources_list(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
) -> Result<Vec<Value>, IpcError> {
    state
        .core
        .resources_list(
            &cluster_id,
            &resource,
            namespace.as_deref(),
            label_selector.as_deref(),
            field_selector.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn resource_get(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
) -> Result<Value, IpcError> {
    state
        .core
        .resource_get(&cluster_id, &resource, namespace.as_deref(), &name)
        .await
}

#[tauri::command]
pub async fn resource_get_yaml(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
) -> Result<String, IpcError> {
    state
        .core
        .resource_get_yaml(&cluster_id, &resource, namespace.as_deref(), &name)
        .await
}

#[tauri::command]
pub async fn resource_replace(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
    yaml: String,
    force: bool,
) -> Result<Value, IpcError> {
    state
        .core
        .resource_replace(
            &cluster_id,
            &resource,
            namespace.as_deref(),
            &name,
            &yaml,
            force,
        )
        .await
}

#[tauri::command]
pub async fn resource_apply(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    yaml: String,
    default_namespace: String,
) -> Result<Vec<ApplyResult>, IpcError> {
    state
        .core
        .resource_apply(&cluster_id, &yaml, &default_namespace)
        .await
}

#[tauri::command]
pub async fn resource_delete(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
    propagation: Propagation,
) -> Result<(), IpcError> {
    state
        .core
        .resource_delete(
            &cluster_id,
            &resource,
            namespace.as_deref(),
            &name,
            propagation,
        )
        .await
}

#[tauri::command]
pub async fn resource_events(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    involved: InvolvedRef,
) -> Result<Vec<Value>, IpcError> {
    state.core.resource_events(&cluster_id, &involved).await
}

/// One kind's API docs from the cluster's OpenAPI v3 (spec L1).
#[tauri::command]
pub async fn api_schema(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    api_version: String,
    kind: String,
) -> Result<KindSchema, IpcError> {
    state
        .core
        .api_schema(&cluster_id, &api_version, &kind)
        .await
}

#[tauri::command]
pub async fn ui_state_get(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<Value>, IpcError> {
    Ok(state.core.ui_state_get(&key))
}

#[tauri::command]
pub async fn ui_state_set(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Result<(), IpcError> {
    let core = state.core.clone();
    blocking(move || core.ui_state_set(&key, value)).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use skopos_core::resources::{Row, SNAPSHOT_PART_ROWS};
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    use super::*;

    /// A snapshot of many rows would be one long text for the webview to parse in one go.
    #[test]
    fn a_large_snapshot_crosses_the_channel_a_part_at_a_time() {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let seen = bodies.clone();
        let channel = Channel::new(move |body| {
            let InvokeResponseBody::Json(text) = body else {
                panic!("the event did not cross as JSON");
            };
            seen.lock().unwrap().push(text);
            Ok(())
        });
        let items = (0..=SNAPSHOT_PART_ROWS)
            .map(|n| Row::new(&json!({ "n": n })).unwrap())
            .collect();

        assert!(send_parts(&channel, WatchEvent::Snapshot { items }));

        let sent: Vec<Value> = bodies
            .lock()
            .unwrap()
            .iter()
            .map(|text| serde_json::from_str(text).unwrap())
            .collect();
        let shape: Vec<(&str, usize)> = sent
            .iter()
            .map(|event| {
                let rows = event["items"].as_array().unwrap().len();
                (event["type"].as_str().unwrap(), rows)
            })
            .collect();
        assert_eq!(
            shape,
            [("snapshotPart", SNAPSHOT_PART_ROWS), ("snapshot", 1)]
        );
        assert_eq!(sent[1]["items"][0], json!({ "n": SNAPSHOT_PART_ROWS }));
    }

    /// A row is kept as text, and must still reach the webview as the object.
    #[test]
    fn a_watched_row_crosses_the_channel_as_its_object() {
        let object =
            json!({ "kind": "Pod", "metadata": { "name": "web", "labels": { "app": "web" } } });
        let event = WatchEvent::Snapshot {
            items: vec![Row::new(&object).unwrap()],
        };
        let InvokeResponseBody::Json(body) = event.body().unwrap() else {
            panic!("the event did not cross as JSON");
        };
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent, json!({ "type": "snapshot", "items": [object] }));
    }
}
