//! One reachability per cluster, shared by every subscription of that cluster (spec §7.3).
//!
//! A builder task reads Pods in their graph shape, ReplicaSets, Jobs, Namespaces and the policy
//! kinds the cluster serves through the watch hub into a graph store, and rebuilds at most once
//! per interval after a change. A build equal to the last one is not published. Each
//! subscription follows one namespace: its task sends that namespace's snapshot of a new build
//! when it differs from the one it sent last, and every subscription of a namespace sends the
//! one event made for that build.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::build::{build, snapshot, Built, REACH_KINDS};
use super::types::ReachEvent;
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::graph::{served_kinds, Kind, Store};
use crate::kubeconfig::ClusterId;
use crate::resources::{state_name, RowShape, Scope};
use crate::subscriptions::Subscriptions;

/// Spec §7.3: later snapshots at most once every 2 s.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);
/// Hub events wait here while a build runs.
const EVENT_BACKLOG: usize = 64;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// R6: without Pods nothing on the page holds, so once the Pod kind cannot be listed the
/// reachability fails with the reason the store keeps (R5).
fn pods_failure(store: &Store) -> Option<String> {
    store
        .missing_reasons()
        .into_iter()
        .find(|(kind, _)| *kind == Kind::Pod)
        .map(|(_, reason)| format!("Pods cannot be listed: {reason}"))
}

/// What the builder last published.
#[derive(Clone)]
enum Published {
    Build(Arc<Shared>),
    Failure(String),
}

/// One published build, and the snapshot of each namespace a subscription asked for, made the
/// first time one does: one event per generation and namespace, which every subscription of
/// that namespace sends.
struct Shared {
    built: Built,
    snapshots: Mutex<HashMap<String, Arc<ReachEvent>>>,
}

impl Shared {
    fn new(built: Built) -> Self {
        Self {
            built,
            snapshots: Mutex::new(HashMap::new()),
        }
    }

    fn snapshot_of(&self, namespace: &str) -> Arc<ReachEvent> {
        if let Some(event) = lock(&self.snapshots).get(namespace) {
            return event.clone();
        }
        // Made outside the lock, so that a subscription of another namespace does not wait for
        // this one. When two make it at once, both send the one kept first.
        let made = Arc::new(snapshot(&self.built, namespace));
        lock(&self.snapshots)
            .entry(namespace.to_owned())
            .or_insert(made)
            .clone()
    }
}

struct ReachabilityState {
    subscribers: usize,
    /// It failed, and takes no new subscriber.
    terminal: bool,
    /// Tells a linger timer whether its last subscriber is still the last one.
    linger_epoch: u64,
}

/// The reachability of one cluster.
struct Reachability {
    /// A child of the cluster's token. Lingering out cancels it too.
    token: CancellationToken,
    published: watch::Sender<Option<Published>>,
    state: Mutex<ReachabilityState>,
}

impl Reachability {
    fn new(token: CancellationToken) -> Self {
        let (published, _) = watch::channel(None);
        Self {
            token,
            published,
            state: Mutex::new(ReachabilityState {
                subscribers: 0,
                terminal: false,
                linger_epoch: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ReachabilityState> {
        lock(&self.state)
    }

    fn is_closed(&self) -> bool {
        self.token.is_cancelled() || self.lock().terminal
    }

    /// False when the reachability stopped, and the caller needs a new one.
    fn attach(&self) -> bool {
        let mut state = self.lock();
        if state.terminal || self.token.is_cancelled() {
            return false;
        }
        state.subscribers += 1;
        true
    }

    /// Starts the linger timer when this was the last subscriber. A failed reachability stops
    /// at once.
    fn detach(self: &Arc<Self>, linger: Duration) {
        let epoch = {
            let mut state = self.lock();
            state.subscribers = state.subscribers.saturating_sub(1);
            if state.subscribers > 0 || self.token.is_cancelled() {
                return;
            }
            if state.terminal {
                self.token.cancel();
                return;
            }
            state.linger_epoch += 1;
            state.linger_epoch
        };
        let reachability = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = reachability.token.cancelled() => return,
                () = tokio::time::sleep(linger) => {}
            }
            // Under the lock, so that `attach` either wins or sees the cancellation.
            let state = reachability.lock();
            if state.subscribers == 0 && state.linger_epoch == epoch {
                reachability.token.cancel();
            }
        });
    }

    /// Publishes a build that differs from the last one, as the next generation.
    fn publish(&self, mut built: Built) {
        self.published.send_if_modified(|current| {
            let mut generation = 1;
            if let Some(Published::Build(last)) = current {
                if last.built == built {
                    return false;
                }
                generation = last.built.generation + 1;
            }
            built.generation = generation;
            *current = Some(Published::Build(Arc::new(Shared::new(built))));
            true
        });
    }

    /// Ends the reachability: each subscriber gets the failure and stops.
    fn fail(&self, message: String) {
        self.lock().terminal = true;
        self.published
            .send_replace(Some(Published::Failure(message)));
    }
}

/// The reachabilities of every cluster.
pub(crate) struct ReachabilityHub {
    reachabilities: DashMap<ClusterId, Arc<Reachability>>,
    /// What stops each subscription's task, and the window that asked for it.
    subscriptions: Subscriptions,
    next_subscription: AtomicU64,
    interval: Mutex<Duration>,
}

impl Default for ReachabilityHub {
    fn default() -> Self {
        Self {
            reachabilities: DashMap::new(),
            subscriptions: Subscriptions::default(),
            next_subscription: AtomicU64::new(1),
            interval: Mutex::new(DEFAULT_INTERVAL),
        }
    }
}

impl ReachabilityHub {
    fn interval(&self) -> Duration {
        *lock(&self.interval)
    }

    /// The cluster's running reachability with one more subscriber, or a new one.
    fn join(
        self: &Arc<Self>,
        core: &AppCore,
        id: &ClusterId,
        cluster: &CancellationToken,
    ) -> CoreResult<Arc<Reachability>> {
        loop {
            // A disconnect that just happened would leave every new reachability closed.
            if cluster.is_cancelled() {
                return Err(IpcError::new(
                    ErrorCode::Unreachable,
                    format!("cluster {id} is not connected"),
                ));
            }
            match self.reachabilities.entry(id.clone()) {
                Entry::Occupied(entry) if !entry.get().is_closed() => {
                    let reachability = entry.get().clone();
                    drop(entry);
                    if reachability.attach() {
                        return Ok(reachability);
                    }
                }
                entry => {
                    let reachability = Arc::new(Reachability::new(cluster.child_token()));
                    // Before its builder starts, so that a builder failing at once still
                    // counts this subscriber, and this loop does not start another.
                    if !reachability.attach() {
                        continue;
                    }
                    entry.insert(reachability.clone());
                    tokio::spawn(run_reachability(
                        self.clone(),
                        core.clone(),
                        id.clone(),
                        reachability.clone(),
                    ));
                    return Ok(reachability);
                }
            }
        }
    }

    fn subscribe(
        self: &Arc<Self>,
        core: &AppCore,
        id: &ClusterId,
        namespace: String,
        tx: mpsc::Sender<Arc<ReachEvent>>,
        cluster: &CancellationToken,
        owner: &str,
    ) -> CoreResult<String> {
        let reachability = self.join(core, id, cluster)?;
        let number = self.next_subscription.fetch_add(1, Ordering::Relaxed);
        let subscription = format!("reach-{number}");
        let stop = reachability.token.child_token();
        self.subscriptions
            .insert(subscription.clone(), stop.clone(), Some(owner));
        let linger = core.watches().linger();
        tokio::spawn(serve(
            self.clone(),
            reachability,
            subscription.clone(),
            namespace,
            tx,
            stop,
            linger,
        ));
        Ok(subscription)
    }

    fn unsubscribe(&self, subscription: &str) {
        self.subscriptions.stop(subscription);
    }

    /// Ends the subscriptions the window `owner` asked for.
    pub(crate) fn stop_owned(&self, owner: &str) {
        self.subscriptions.stop_owned(owner);
    }

    fn running(&self) -> usize {
        self.reachabilities
            .iter()
            .filter(|entry| !entry.value().is_closed())
            .count()
    }
}

/// Builds the reachability until it lingers out, its cluster disconnects or it fails.
async fn run_reachability(
    hub: Arc<ReachabilityHub>,
    core: AppCore,
    id: ClusterId,
    reachability: Arc<Reachability>,
) {
    let mut watches = Vec::new();
    let ended = build_loop(&hub, &core, &id, &reachability, &mut watches).await;
    // A disconnect fails discovery and the watch hub too. It ends the reachability without a
    // failure.
    if let Err(message) = ended {
        if !reachability.token.is_cancelled() {
            reachability.fail(message);
        }
    }
    for watch in &watches {
        core.resources_unsubscribe(watch);
    }
    hub.reachabilities
        .remove_if(&id, |_, current| Arc::ptr_eq(current, &reachability));
}

/// Returns the failure's message, or nothing once the reachability's token is cancelled. The
/// hub subscriptions it made go into `watches`, so the caller ends them however this returns.
async fn build_loop(
    hub: &ReachabilityHub,
    core: &AppCore,
    id: &ClusterId,
    reachability: &Reachability,
    watches: &mut Vec<String>,
) -> Result<(), String> {
    let discovery = core.cluster_discovery(id).map_err(|e| e.message)?;
    let served = served_kinds(&discovery);
    // Spec §8: a kind the cluster does not serve is never read and never reported missing.
    let kinds: Vec<Kind> = REACH_KINDS
        .into_iter()
        .filter(|kind| served.contains(kind))
        .collect();
    let mut store = Store::new(&kinds);
    let mut streams = Vec::with_capacity(kinds.len());
    for kind in kinds {
        let (tx, rx) = mpsc::channel(EVENT_BACKLOG);
        let watch = core
            .subscribe_rows(
                id,
                kind.resource(),
                RowShape::Graph,
                Scope::default(),
                tx,
                None,
            )
            .map_err(|e| e.message)?;
        watches.push(watch);
        let events = stream::unfold(rx, move |mut rx| async move {
            let event = rx.recv().await?;
            Some(((kind, event), rx))
        });
        streams.push(events.boxed());
    }
    let mut events = stream::select_all(streams);
    let mut open = true;
    let mut dirty = true;
    let mut next_build = Instant::now();
    let interval = hub.interval();
    loop {
        let due = dirty && store.ready();
        tokio::select! {
            biased;
            () = reachability.token.cancelled() => return Ok(()),
            () = tokio::time::sleep_until(next_build), if due => {
                reachability.publish(build(&store));
                dirty = false;
                next_build = Instant::now() + interval;
            }
            event = events.next(), if open => match event {
                Some((kind, event)) => {
                    store.apply(kind, event);
                    if let Some(message) = pods_failure(&store) {
                        return Err(message);
                    }
                    dirty = true;
                }
                // Every watch ended: each kind failed for good, or the cluster disconnected.
                None => open = false,
            },
        }
    }
}

/// Sends one subscription its namespace's snapshot of each new build when it differs from the
/// one it sent last, until it leaves, the reachability stops or fails, or the receiver closes.
async fn serve(
    hub: Arc<ReachabilityHub>,
    reachability: Arc<Reachability>,
    subscription: String,
    namespace: String,
    tx: mpsc::Sender<Arc<ReachEvent>>,
    stop: CancellationToken,
    linger: Duration,
) {
    let mut published = reachability.published.subscribe();
    let mut last_generation: Option<u64> = None;
    let mut last_sent: Option<Arc<ReachEvent>> = None;
    loop {
        let current = published.borrow_and_update().clone();
        let event: Option<Arc<ReachEvent>> = match current {
            None => None,
            Some(Published::Failure(message)) => {
                let failure = Arc::new(ReachEvent::Failure { message });
                tokio::select! {
                    () = stop.cancelled() => {}
                    _ = tx.send(failure) => {}
                }
                break;
            }
            Some(Published::Build(shared)) => {
                let generation = shared.built.generation;
                if last_generation == Some(generation) {
                    None
                } else {
                    last_generation = Some(generation);
                    let event = shared.snapshot_of(&namespace);
                    let unchanged = last_sent
                        .as_ref()
                        .is_some_and(|last| Arc::ptr_eq(last, &event) || **last == *event);
                    if unchanged {
                        None
                    } else {
                        last_sent = Some(event.clone());
                        Some(event)
                    }
                }
            }
        };
        if let Some(event) = event {
            tokio::select! {
                () = stop.cancelled() => break,
                sent = tx.send(event) => {
                    if sent.is_err() {
                        break;
                    }
                }
            }
        }
        tokio::select! {
            // A failure published as the reachability stops still goes out first.
            biased;
            changed = published.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            () = stop.cancelled() => break,
            () = tx.closed() => break,
        }
    }
    hub.subscriptions.forget(&subscription);
    reachability.detach(linger);
}

impl AppCore {
    /// Sends the reachability of `namespace` on the cluster to `tx` until unsubscribed, the
    /// cluster disconnects, the receiver closes or the reachability fails (spec §7.3, R6).
    /// Returns the subscription id, `reach-<n>`. `owner` is the label of the window that asks.
    pub fn network_reachability_subscribe(
        &self,
        id: &ClusterId,
        namespace: String,
        tx: mpsc::Sender<Arc<ReachEvent>>,
        owner: &str,
    ) -> CoreResult<String> {
        let state = self.cluster_state(id);
        if !matches!(state, ConnectionState::Connected { .. }) {
            return Err(IpcError::new(
                ErrorCode::InvalidInput,
                format!("cluster {id} is {}", state_name(&state)),
            ));
        }
        let cluster = self.cluster_cancel_token(id)?;
        self.reachabilities()
            .subscribe(self, id, namespace, tx, &cluster, owner)
    }

    /// An id that is unknown or already ended is ignored.
    pub fn network_reachability_unsubscribe(&self, subscription: &str) {
        self.reachabilities().unsubscribe(subscription);
    }

    /// Applies to reachabilities that start later.
    pub fn set_reachability_interval_for_test(&self, interval: Duration) {
        // A zero interval would rebuild on every event.
        *lock(&self.reachabilities().interval) = interval.max(Duration::from_millis(1));
    }

    /// How many reachabilities run, so tests can check that subscriptions share one and that
    /// it stops.
    pub fn running_reachabilities_for_test(&self) -> usize {
        self.reachabilities().running()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::resources::{Row, WatchEvent, WatchStatus};

    const LINGER: Duration = Duration::from_secs(30);
    const QUIET: Duration = Duration::from_millis(200);

    fn pod(namespace: &str, name: &str) -> Value {
        json!({
            "metadata": { "name": name, "namespace": namespace, "labels": { "app": name } },
            "spec": { "containers": [{ "name": "app" }] },
            "status": { "phase": "Running" },
        })
    }

    /// The build of a store that listed every kind it reads, with `pods` as its Pods.
    fn built(pods: &[Value]) -> Built {
        let mut store = Store::new(&REACH_KINDS);
        for kind in REACH_KINDS {
            let items = if kind == Kind::Pod {
                pods.iter().map(|pod| Row::new(pod).unwrap()).collect()
            } else {
                Vec::new()
            };
            store.apply(kind, WatchEvent::Snapshot { items });
        }
        build(&store)
    }

    fn generation(reachability: &Reachability) -> Option<u64> {
        match &*reachability.published.borrow() {
            Some(Published::Build(shared)) => Some(shared.built.generation),
            _ => None,
        }
    }

    fn namespace_of(event: &ReachEvent) -> &str {
        match event {
            ReachEvent::Snapshot { namespace, .. } => namespace,
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    /// One subscription of `reachability` to `namespace`, served as the hub serves it.
    fn served(
        reachability: &Arc<Reachability>,
        namespace: &str,
    ) -> (
        Arc<ReachabilityHub>,
        mpsc::Receiver<Arc<ReachEvent>>,
        tokio::task::JoinHandle<()>,
    ) {
        let hub = Arc::new(ReachabilityHub::default());
        let (tx, rx) = mpsc::channel(4);
        assert!(reachability.attach());
        let stop = reachability.token.child_token();
        hub.subscriptions
            .insert("reach-1".to_owned(), stop.clone(), None);
        let task = tokio::spawn(serve(
            hub.clone(),
            reachability.clone(),
            "reach-1".to_owned(),
            namespace.to_owned(),
            tx,
            stop,
            LINGER,
        ));
        (hub, rx, task)
    }

    async fn quiet(rx: &mut mpsc::Receiver<Arc<ReachEvent>>) {
        if let Ok(event) = tokio::time::timeout(QUIET, rx.recv()).await {
            panic!("expected nothing, got {event:?}");
        }
    }

    #[test]
    fn an_equal_build_is_not_published_again() {
        let reachability = Reachability::new(CancellationToken::new());
        reachability.publish(built(&[pod("shop", "web")]));
        reachability.publish(built(&[pod("shop", "web")]));
        assert_eq!(generation(&reachability), Some(1));
        reachability.publish(built(&[pod("shop", "web"), pod("shop", "api")]));
        assert_eq!(generation(&reachability), Some(2));
    }

    #[test]
    fn pods_that_cannot_be_listed_fail_with_the_reason() {
        let forbidden = |message: Option<&str>| WatchEvent::Status {
            status: WatchStatus::Forbidden,
            message: message.map(str::to_owned),
        };
        let mut store = Store::new(&REACH_KINDS);
        assert_eq!(pods_failure(&store), None, "still listing");
        store.apply(
            Kind::CiliumNetworkPolicy,
            forbidden(Some("ciliumnetworkpolicies is forbidden")),
        );
        assert_eq!(
            pods_failure(&store),
            None,
            "another kind only names itself missing"
        );
        store.apply(
            Kind::Pod,
            forbidden(Some(
                "pods is forbidden: User \"viewer\" cannot list resource \"pods\"",
            )),
        );
        assert_eq!(
            pods_failure(&store).as_deref(),
            Some("Pods cannot be listed: pods is forbidden: User \"viewer\" cannot list resource \"pods\"")
        );

        let mut store = Store::new(&REACH_KINDS);
        store.apply(Kind::Pod, forbidden(None));
        assert_eq!(
            pods_failure(&store).as_deref(),
            Some("Pods cannot be listed: listing is forbidden")
        );

        let mut store = Store::new(&REACH_KINDS);
        store.apply(
            Kind::Pod,
            WatchEvent::Status {
                status: WatchStatus::NotServed,
                message: Some("the cluster no longer serves pods".to_owned()),
            },
        );
        assert_eq!(
            pods_failure(&store).as_deref(),
            Some("Pods cannot be listed: the cluster no longer serves pods")
        );
    }

    #[tokio::test]
    async fn subscriptions_of_one_namespace_share_one_event_per_build() {
        let reachability = Arc::new(Reachability::new(CancellationToken::new()));
        let (_first_hub, mut first, _first_task) = served(&reachability, "shop");
        let (_second_hub, mut second, _second_task) = served(&reachability, "shop");
        let (_other_hub, mut other, _other_task) = served(&reachability, "other");
        reachability.publish(built(&[pod("shop", "web"), pod("other", "tool")]));
        let a = first.recv().await.unwrap();
        let b = second.recv().await.unwrap();
        let c = other.recv().await.unwrap();
        assert!(
            Arc::ptr_eq(&a, &b),
            "one snapshot per generation and namespace"
        );
        assert_eq!(namespace_of(&a), "shop");
        assert_eq!(namespace_of(&c), "other");
    }

    #[tokio::test]
    async fn a_build_that_leaves_the_namespace_as_it_was_is_not_sent() {
        let reachability = Arc::new(Reachability::new(CancellationToken::new()));
        let (_hub, mut rx, _task) = served(&reachability, "shop");
        reachability.publish(built(&[pod("shop", "web")]));
        let first = rx.recv().await.unwrap();

        reachability.publish(built(&[pod("shop", "web"), pod("other", "tool")]));
        assert_eq!(generation(&reachability), Some(2), "the cluster changed");
        quiet(&mut rx).await;

        reachability.publish(built(&[
            pod("shop", "web"),
            pod("shop", "api"),
            pod("other", "tool"),
        ]));
        let later = rx.recv().await.unwrap();
        assert_ne!(first, later);
        assert_eq!(namespace_of(&later), "shop");
    }

    #[tokio::test]
    async fn a_failure_reaches_the_subscription_and_ends_it() {
        let reachability = Arc::new(Reachability::new(CancellationToken::new()));
        let (hub, mut rx, task) = served(&reachability, "shop");
        reachability.publish(built(&[pod("shop", "web")]));
        assert!(matches!(
            rx.recv().await.as_deref(),
            Some(ReachEvent::Snapshot { .. })
        ));

        let message = "Pods cannot be listed: listing is forbidden".to_owned();
        reachability.fail(message.clone());
        assert_eq!(
            rx.recv().await,
            Some(Arc::new(ReachEvent::Failure { message }))
        );
        assert_eq!(rx.recv().await, None);
        task.await.unwrap();
        assert_eq!(hub.subscriptions.len(), 0);
        assert!(reachability.is_closed());
        assert!(
            reachability.token.is_cancelled(),
            "a failed reachability does not linger"
        );
        assert!(!reachability.attach(), "a retry needs a new one");
    }

    #[tokio::test]
    async fn a_disconnect_ends_the_subscription_without_an_event() {
        let cluster = CancellationToken::new();
        let reachability = Arc::new(Reachability::new(cluster.child_token()));
        let (_hub, mut rx, task) = served(&reachability, "shop");
        reachability.publish(built(&[pod("shop", "web")]));
        assert!(rx.recv().await.is_some());
        cluster.cancel();
        assert_eq!(rx.recv().await, None, "no failure, no event");
        task.await.unwrap();
        assert!(reachability.is_closed());
    }
}
