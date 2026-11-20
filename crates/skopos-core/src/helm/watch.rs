//! `helm_releases_subscribe` (perf spec §2b): says when a Helm release changes, so the
//! releases screen lists again. helm 3 and 4 keep each revision in a Secret labelled
//! `owner=helm`; a metadata-only watch on those never fetches a payload. The watch runs
//! by itself, not through the watch hub.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::core::v1::Secret;
use kube::core::PartialObjectMeta;
use kube::runtime::watcher;
use kube::{Api, Client};
use serde::Serialize;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::Sender;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::lock;
use crate::app_core::AppCore;
use crate::error::{CoreResult, IpcError};
use crate::kubeconfig::ClusterId;
use crate::subscriptions::Subscriptions;

/// What Helm labels its release Secrets with.
const HELM_OWNER: &str = "owner=helm";
const DEFAULT_DEBOUNCE: Duration = Duration::from_secs(1);

/// What a releases subscription sends. No event comes at start: the UI lists once itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum HelmReleasesEvent {
    /// A release changed; list again. One per burst of changes.
    Changed,
    /// The Secrets may not be watched (a 403). The subscription has ended; poll instead.
    Forbidden { message: String },
    /// Any other terminal error. The subscription has ended.
    Failed { message: String },
}

/// The running subscriptions, `helm-N`.
pub(crate) struct ReleaseWatches {
    /// What stops each subscription. Shared with the tasks, which remove their own entry.
    subscriptions: Arc<Subscriptions>,
    next: AtomicU64,
    debounce: Mutex<Duration>,
}

impl ReleaseWatches {
    pub(crate) fn new() -> Self {
        Self {
            subscriptions: Arc::new(Subscriptions::default()),
            next: AtomicU64::new(1),
            debounce: Mutex::new(DEFAULT_DEBOUNCE),
        }
    }
}

impl AppCore {
    /// Sends `Changed` to `tx` when a Helm release Secret changes, until unsubscribed, the
    /// cluster disconnects, the receiver closes or a `Forbidden` or `Failed` event has been
    /// sent. Returns the subscription id. `owner` is the label of the window that asks.
    pub fn helm_releases_subscribe(
        &self,
        id: &ClusterId,
        tx: Sender<HelmReleasesEvent>,
        owner: &str,
    ) -> CoreResult<String> {
        let client = self.cluster_client(id)?;
        let stop = self.cluster_cancel_token(id)?;
        let watches = &self.helm().watches;
        let subscription = format!("helm-{}", watches.next.fetch_add(1, Ordering::Relaxed));
        watches
            .subscriptions
            .insert(subscription.clone(), stop.clone(), Some(owner));
        let debounce = *lock(&watches.debounce);
        tokio::spawn(run(
            client,
            stop,
            tx,
            debounce,
            Arc::clone(&watches.subscriptions),
            subscription.clone(),
        ));
        Ok(subscription)
    }

    /// An id that is unknown or already ended is ignored.
    pub fn helm_releases_unsubscribe(&self, subscription: &str) {
        self.helm().watches.subscriptions.stop(subscription);
    }

    /// Ends the release subscriptions the window `owner` asked for.
    pub(crate) fn helm_releases_stop_owned(&self, owner: &str) {
        self.helm().watches.subscriptions.stop_owned(owner);
    }

    /// The trailing debounce of later subscriptions; tests shorten it.
    pub fn set_helm_debounce_for_test(&self, debounce: Duration) {
        *lock(&self.helm().watches.debounce) = debounce.max(Duration::from_millis(1));
    }
}

async fn run(
    client: Client,
    stop: CancellationToken,
    tx: Sender<HelmReleasesEvent>,
    debounce: Duration,
    subscriptions: Arc<Subscriptions>,
    subscription: String,
) {
    let last = watch_releases(client, &stop, &tx, debounce).await;
    subscriptions.forget(&subscription);
    if let Some(event) = last {
        // A terminal event is sent once; an unsubscribe in the meantime wins.
        tokio::select! {
            () = stop.cancelled() => {}
            _ = tx.send(event) => {}
        }
    }
}

/// Runs until something ends the subscription. `Some` is the one terminal event to send;
/// `None` is a silent end.
async fn watch_releases(
    client: Client,
    stop: &CancellationToken,
    tx: &Sender<HelmReleasesEvent>,
    debounce: Duration,
) -> Option<HelmReleasesEvent> {
    let api: Api<PartialObjectMeta<Secret>> = Api::all(client);
    let mut stream = Box::pin(watcher(api, watcher::Config::default().labels(HELM_OWNER)));
    // Whether the first listing has finished. Later listings follow a 410 and count.
    let mut listed = false;
    let mut due: Option<Instant> = None;
    loop {
        tokio::select! {
            () = stop.cancelled() => return None,
            () = tx.closed() => return None,
            () = until(due) => {
                due = None;
                match tx.try_send(HelmReleasesEvent::Changed) {
                    Err(TrySendError::Closed(_)) => return None,
                    // Full: a `changed` is already waiting and says the same.
                    Ok(()) | Err(TrySendError::Full(_)) => {}
                }
            }
            item = stream.next() => match item {
                None => return None,
                Some(Ok(event)) => {
                    let changed = match event {
                        watcher::Event::Init | watcher::Event::InitApply(_) => false,
                        watcher::Event::InitDone => std::mem::replace(&mut listed, true),
                        watcher::Event::Apply(_) | watcher::Event::Delete(_) => true,
                    };
                    if changed {
                        due = Some(Instant::now() + debounce);
                    }
                }
                Some(Err(error)) => {
                    let (code, message) = describe(error);
                    // An expired resource version is routine: the watcher lists again.
                    if code == Some(410) {
                        continue;
                    }
                    return Some(if code == Some(403) {
                        HelmReleasesEvent::Forbidden { message }
                    } else {
                        HelmReleasesEvent::Failed { message }
                    });
                }
            }
        }
    }
}

/// Ready at `at`; never ready for `None`.
async fn until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// The HTTP status of a watcher error, when it has one, and its text for the webview.
fn describe(error: watcher::Error) -> (Option<u16>, String) {
    let source = match error {
        watcher::Error::InitialListFailed(source)
        | watcher::Error::WatchStartFailed(source)
        | watcher::Error::WatchFailed(source) => source,
        watcher::Error::WatchError(status) => kube::Error::Api(status),
        watcher::Error::NoResourceVersion => {
            return (None, "the API server sent no resource version".to_owned())
        }
    };
    let code = match &source {
        kube::Error::Api(status) => Some(status.code),
        _ => None,
    };
    (code, IpcError::from(source).message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_with_a_type_tag() {
        assert_eq!(
            serde_json::to_value(HelmReleasesEvent::Changed).unwrap(),
            serde_json::json!({ "type": "changed" })
        );
        assert_eq!(
            serde_json::to_value(HelmReleasesEvent::Forbidden {
                message: "no".into()
            })
            .unwrap(),
            serde_json::json!({ "type": "forbidden", "message": "no" })
        );
        assert_eq!(
            serde_json::to_value(HelmReleasesEvent::Failed {
                message: "boom".into()
            })
            .unwrap(),
            serde_json::json!({ "type": "failed", "message": "boom" })
        );
    }
}
