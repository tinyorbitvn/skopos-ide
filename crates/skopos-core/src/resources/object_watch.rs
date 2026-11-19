//! A watch of one object, outside the hub's groups. A drawer follows its object with this
//! instead of holding a table's watcher: the API server filters by name, so nothing but that
//! object ever crosses. Rows are whole objects, stamped and stripped as the hub's rows are.

use std::sync::Arc;

use futures::StreamExt;
use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher;
use kube::{Api, Client};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::hub::{
    api_version, describe, object_key, pause, still_served, stripped_object, validate, WatchHub,
    MAX_BACKOFF, MIN_BACKOFF,
};
use super::ops::{invalid, is_path_segment};
use super::types::{ResourceRef, Row, WatchEvent, WatchStatus};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

/// What is watched.
struct Target {
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
}

/// The field selector for one name. A name is a path segment, which may still hold the
/// characters a selector reads as syntax, so those are escaped as the API server expects.
fn name_selector(name: &str) -> String {
    let mut selector = String::from("metadata.name=");
    for c in name.chars() {
        if matches!(c, '\\' | ',' | '=') {
            selector.push('\\');
        }
        selector.push(c);
    }
    selector
}

fn status(status: WatchStatus, message: Option<String>) -> WatchEvent {
    WatchEvent::Status { status, message }
}

/// Sends one event. False when the watch must end: it was stopped or the receiver is gone.
async fn deliver(
    tx: &mpsc::Sender<WatchEvent>,
    stop: &CancellationToken,
    event: WatchEvent,
) -> bool {
    tokio::select! {
        () = stop.cancelled() => false,
        sent = tx.send(event) => sent.is_ok(),
    }
}

fn row_of(object: &DynamicObject, resource: &ResourceRef) -> Option<Row> {
    let (_, value) = stripped_object(object, resource)?;
    Row::new(&value).ok()
}

/// Runs the watch, then forgets its id.
async fn run(
    hub: Arc<WatchHub>,
    subscription: String,
    client: Client,
    target: Target,
    tx: mpsc::Sender<WatchEvent>,
    stop: CancellationToken,
) {
    watch_object(&client, &target, &tx, &stop).await;
    hub.deregister(&subscription);
}

/// Watches until stopped, until the receiver closes or until a final status was sent.
/// A snapshot of zero or one rows comes once each listing ends, then one batch per change.
/// After a failure it starts over with a new list, as a hub watcher does.
async fn watch_object(
    client: &Client,
    target: &Target,
    tx: &mpsc::Sender<WatchEvent>,
    stop: &CancellationToken,
) {
    let resource = &target.resource;
    let api_resource = ApiResource {
        group: resource.group.clone(),
        version: resource.version.clone(),
        api_version: api_version(resource),
        kind: resource.kind.clone(),
        plural: resource.plural.clone(),
    };
    let api: Api<DynamicObject> = match &target.namespace {
        Some(namespace) => Api::namespaced_with(client.clone(), namespace, &api_resource),
        None => Api::all_with(client.clone(), &api_resource),
    };
    let config = watcher::Config::default().fields(&name_selector(&target.name));
    if !deliver(tx, stop, status(WatchStatus::Syncing, None)).await {
        return;
    }
    let mut backoff = MIN_BACKOFF;
    let mut got_snapshot = false;
    // The failure message the subscriber was told last, so a repeat is not sent again.
    let mut reported: Option<String> = None;
    loop {
        let mut stream = Box::pin(watcher(api.clone(), config.clone()));
        let mut listed: Option<Row> = None;
        let mut live_since = None;
        let end_of_stream = loop {
            let item = tokio::select! {
                () = stop.cancelled() => return,
                item = stream.next() => item,
            };
            let err = match item {
                Some(Ok(watcher::Event::Init)) => {
                    listed = None;
                    continue;
                }
                Some(Ok(watcher::Event::InitApply(object))) => {
                    listed = row_of(&object, resource);
                    continue;
                }
                Some(Ok(watcher::Event::InitDone)) => {
                    let snapshot = WatchEvent::Snapshot {
                        items: listed.take().into_iter().collect(),
                    };
                    let live = status(WatchStatus::Live, None);
                    // As the hub orders them: the first data is a snapshot, and after an
                    // outage the status that ends it comes before the snapshot.
                    let events = if got_snapshot {
                        [live, snapshot]
                    } else {
                        [snapshot, live]
                    };
                    for event in events {
                        if !deliver(tx, stop, event).await {
                            return;
                        }
                    }
                    got_snapshot = true;
                    reported = None;
                    live_since = Some(Instant::now());
                    continue;
                }
                Some(Ok(watcher::Event::Apply(object))) => {
                    if let Some(row) = row_of(&object, resource) {
                        let batch = WatchEvent::Batch {
                            upserts: vec![row],
                            deletes: Vec::new(),
                        };
                        if !deliver(tx, stop, batch).await {
                            return;
                        }
                    }
                    continue;
                }
                Some(Ok(watcher::Event::Delete(object))) => {
                    if let Some(key) = object_key(&object) {
                        let batch = WatchEvent::Batch {
                            upserts: Vec::new(),
                            deletes: vec![key],
                        };
                        if !deliver(tx, stop, batch).await {
                            return;
                        }
                    }
                    continue;
                }
                Some(Err(err)) => err,
                None => break None,
            };
            if live_since.is_some_and(|since: Instant| since.elapsed() >= MAX_BACKOFF) {
                backoff = MIN_BACKOFF;
            }
            // An expired resource version is routine: this stream lists again by itself.
            if matches!(&err, watcher::Error::WatchError(status) if status.code == 410) {
                if !pause(&mut backoff, stop).await {
                    return;
                }
                continue;
            }
            break Some(describe(err));
        };
        if let Some(failure) = end_of_stream {
            if failure.code == Some(403) {
                deliver(
                    tx,
                    stop,
                    status(WatchStatus::Forbidden, Some(failure.message)),
                )
                .await;
                return;
            }
            if matches!(failure.code, Some(404 | 410)) {
                let served = tokio::select! {
                    () = stop.cancelled() => return,
                    served = still_served(client, resource) => served,
                };
                if !served {
                    let message = format!("the cluster no longer serves {}", resource.plural);
                    deliver(tx, stop, status(WatchStatus::NotServed, Some(message))).await;
                    return;
                }
            }
            // `WatchStatus` has no failed state: a failure that is not final is a reconnect.
            if failure.code != Some(410) && reported.as_deref() != Some(failure.message.as_str()) {
                tracing::debug!(name = %target.name, "object watch failed: {}", failure.message);
                let told = status(WatchStatus::Reconnecting, Some(failure.message.clone()));
                if !deliver(tx, stop, told).await {
                    return;
                }
                reported = Some(failure.message);
            }
        }
        if !pause(&mut backoff, stop).await {
            return;
        }
    }
}

impl AppCore {
    /// Delivers one object to `tx` until unsubscribed with `resources_unsubscribe`, the
    /// cluster disconnects, the receiver closes or a final status has been sent. Returns the
    /// subscription id. A namespaced resource needs `namespace`, and a cluster-scoped one
    /// takes none.
    pub async fn resources_subscribe_object(
        &self,
        id: &ClusterId,
        resource: ResourceRef,
        namespace: Option<String>,
        name: String,
        tx: mpsc::Sender<WatchEvent>,
    ) -> CoreResult<String> {
        validate(&resource)?;
        if !is_path_segment(&name) {
            return Err(invalid("the object name is not valid"));
        }
        match (&namespace, resource.namespaced) {
            (Some(namespace), true) if is_path_segment(namespace) => {}
            (None, false) => {}
            (Some(_), true) => return Err(invalid("the namespace is not valid")),
            (None, true) => return Err(invalid("a namespaced resource needs a namespace")),
            (Some(_), false) => return Err(invalid("a cluster-scoped resource has no namespace")),
        }
        let connection = self.connection_of(id)?;
        // A disconnect that just happened would leave this watch with a token already gone.
        if connection.token.is_cancelled() {
            return Err(IpcError::new(
                ErrorCode::Unreachable,
                format!("cluster {id} is not connected"),
            ));
        }
        let stop = connection.token.child_token();
        let subscription = self.watches().register(stop.clone());
        tokio::spawn(run(
            self.watches().clone(),
            subscription.clone(),
            connection.client,
            Target {
                resource,
                namespace,
                name,
            },
            tx,
            stop,
        ));
        Ok(subscription)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_escaped_for_the_field_selector() {
        assert_eq!(name_selector("web-1"), "metadata.name=web-1");
        assert_eq!(name_selector("system:node"), "metadata.name=system:node");
        assert_eq!(
            name_selector(r"a,spec.x=b\c"),
            r"metadata.name=a\,spec.x\=b\\c"
        );
    }
}
