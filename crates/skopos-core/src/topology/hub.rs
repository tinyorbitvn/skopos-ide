//! One node topology per cluster, shared by every subscription of that cluster (topology
//! spec §4.1).
//!
//! A builder task reads Nodes and Pods through the watch hub in their topology shape, keeps them
//! in a store, and rebuilds at most once per interval after a change. A build equal to the last
//! one is not published, so subscribers hear only of real changes, and all of them send the one
//! shared event of a build.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::build::{Source, Store};
use super::types::TopologyEvent;
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{state_name, ResourceRef, RowShape, Scope};
use crate::subscriptions::Subscriptions;

/// As the graph's: later snapshots at most once every 2 s.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);
/// Hub events wait here while a build runs.
const EVENT_BACKLOG: usize = 64;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn core_resource(plural: &str, kind: &str, namespaced: bool) -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced,
    }
}

/// What the builder last published.
#[derive(Debug, Clone)]
enum Published {
    Snapshot {
        generation: u64,
        event: Arc<TopologyEvent>,
    },
    Failure(String),
}

struct TopologyState {
    subscribers: usize,
    /// It failed, and takes no new subscriber.
    terminal: bool,
    /// Tells a linger timer whether its last subscriber is still the last one.
    linger_epoch: u64,
}

struct Topology {
    /// A child of the cluster's token. Lingering out cancels it too.
    token: CancellationToken,
    published: watch::Sender<Option<Published>>,
    state: Mutex<TopologyState>,
}

impl Topology {
    fn new(token: CancellationToken) -> Self {
        let (published, _) = watch::channel(None);
        Self {
            token,
            published,
            state: Mutex::new(TopologyState {
                subscribers: 0,
                terminal: false,
                linger_epoch: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, TopologyState> {
        lock(&self.state)
    }

    fn is_closed(&self) -> bool {
        self.token.is_cancelled() || self.lock().terminal
    }

    /// False when the topology stopped, and the caller needs a new one.
    fn attach(&self) -> bool {
        let mut state = self.lock();
        if state.terminal || self.token.is_cancelled() {
            return false;
        }
        state.subscribers += 1;
        true
    }

    /// Starts the linger timer when this was the last subscriber. A failed topology stops at
    /// once.
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
        let topology = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = topology.token.cancelled() => return,
                () = tokio::time::sleep(linger) => {}
            }
            // Under the lock, so that `attach` either wins or sees the cancellation.
            let state = topology.lock();
            if state.subscribers == 0 && state.linger_epoch == epoch {
                topology.token.cancel();
            }
        });
    }

    /// Publishes a build that differs from the last one, as the next generation.
    fn publish(&self, event: TopologyEvent) {
        self.published.send_if_modified(|current| {
            let mut generation = 1;
            if let Some(Published::Snapshot {
                generation: last,
                event: shown,
            }) = current
            {
                if **shown == event {
                    return false;
                }
                generation = *last + 1;
            }
            *current = Some(Published::Snapshot {
                generation,
                event: Arc::new(event),
            });
            true
        });
    }

    /// Ends the topology: each subscriber gets the failure and stops.
    fn fail(&self, message: String) {
        self.lock().terminal = true;
        self.published
            .send_replace(Some(Published::Failure(message)));
    }
}

/// The topologies of every cluster.
pub(crate) struct TopologyHub {
    topologies: DashMap<ClusterId, Arc<Topology>>,
    /// What stops each subscription's task, and the window that asked for it.
    subscriptions: Subscriptions,
    next_subscription: AtomicU64,
    interval: Mutex<Duration>,
}

impl Default for TopologyHub {
    fn default() -> Self {
        Self {
            topologies: DashMap::new(),
            subscriptions: Subscriptions::default(),
            next_subscription: AtomicU64::new(1),
            interval: Mutex::new(DEFAULT_INTERVAL),
        }
    }
}

impl TopologyHub {
    fn interval(&self) -> Duration {
        *lock(&self.interval)
    }

    /// The cluster's running topology with one more subscriber, or a new one.
    fn join(
        self: &Arc<Self>,
        core: &AppCore,
        id: &ClusterId,
        cluster: &CancellationToken,
    ) -> CoreResult<Arc<Topology>> {
        loop {
            // A disconnect that just happened would leave every new topology closed.
            if cluster.is_cancelled() {
                return Err(IpcError::new(
                    ErrorCode::Unreachable,
                    format!("cluster {id} is not connected"),
                ));
            }
            match self.topologies.entry(id.clone()) {
                Entry::Occupied(entry) if !entry.get().is_closed() => {
                    let topology = entry.get().clone();
                    drop(entry);
                    if topology.attach() {
                        return Ok(topology);
                    }
                }
                entry => {
                    let topology = Arc::new(Topology::new(cluster.child_token()));
                    // Before its builder starts, so that a builder failing at once still
                    // counts this subscriber, and this loop does not start another.
                    if !topology.attach() {
                        continue;
                    }
                    entry.insert(topology.clone());
                    tokio::spawn(run_topology(
                        self.clone(),
                        core.clone(),
                        id.clone(),
                        topology.clone(),
                    ));
                    return Ok(topology);
                }
            }
        }
    }

    fn subscribe(
        self: &Arc<Self>,
        core: &AppCore,
        id: &ClusterId,
        tx: mpsc::Sender<Arc<TopologyEvent>>,
        cluster: &CancellationToken,
        owner: &str,
    ) -> CoreResult<String> {
        let topology = self.join(core, id, cluster)?;
        let number = self.next_subscription.fetch_add(1, Ordering::Relaxed);
        let subscription = format!("topology-{number}");
        let stop = topology.token.child_token();
        self.subscriptions
            .insert(subscription.clone(), stop.clone(), Some(owner));
        let linger = core.watches().linger();
        tokio::spawn(serve(
            self.clone(),
            topology,
            subscription.clone(),
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
        self.topologies
            .iter()
            .filter(|entry| !entry.value().is_closed())
            .count()
    }
}

/// Builds the topology until it lingers out, its cluster disconnects or it fails.
async fn run_topology(
    hub: Arc<TopologyHub>,
    core: AppCore,
    id: ClusterId,
    topology: Arc<Topology>,
) {
    let mut watches = Vec::new();
    let ended = build_loop(&hub, &core, &id, &topology, &mut watches).await;
    // A disconnect ends the hub's watches too. It ends the topology without a failure.
    if let Err(message) = ended {
        if !topology.token.is_cancelled() {
            topology.fail(message);
        }
    }
    for watch in &watches {
        core.resources_unsubscribe(watch);
    }
    hub.topologies
        .remove_if(&id, |_, current| Arc::ptr_eq(current, &topology));
}

/// Returns the failure's message, or nothing once the topology's token is cancelled. The hub
/// subscriptions it made go into `watches`, so the caller ends them however this returns.
async fn build_loop(
    hub: &TopologyHub,
    core: &AppCore,
    id: &ClusterId,
    topology: &Topology,
    watches: &mut Vec<String>,
) -> Result<(), String> {
    let (nodes_tx, mut nodes) = mpsc::channel(EVENT_BACKLOG);
    let watch = core
        .subscribe_rows(
            id,
            core_resource("nodes", "Node", false),
            RowShape::Topology,
            Scope::default(),
            nodes_tx,
            None,
        )
        .map_err(|e| e.message)?;
    watches.push(watch);
    let (pods_tx, mut pods) = mpsc::channel(EVENT_BACKLOG);
    let watch = core
        .subscribe_rows(
            id,
            core_resource("pods", "Pod", true),
            RowShape::Topology,
            Scope::default(),
            pods_tx,
            None,
        )
        .map_err(|e| e.message)?;
    watches.push(watch);

    let mut store = Store::default();
    let (mut nodes_open, mut pods_open) = (true, true);
    let mut dirty = true;
    let mut next_build = Instant::now();
    let interval = hub.interval();
    loop {
        let due = dirty && store.ready();
        tokio::select! {
            biased;
            () = topology.token.cancelled() => return Ok(()),
            () = tokio::time::sleep_until(next_build), if due => {
                topology.publish(TopologyEvent::Snapshot { snapshot: store.build() });
                dirty = false;
                next_build = Instant::now() + interval;
            }
            event = nodes.recv(), if nodes_open => match event {
                Some(event) => {
                    if let Some(message) = store.apply(Source::Nodes, event) {
                        return Err(message);
                    }
                    dirty = true;
                }
                // The hub ended the watch, as on a disconnect.
                None => nodes_open = false,
            },
            event = pods.recv(), if pods_open => match event {
                Some(event) => {
                    store.apply(Source::Pods, event);
                    dirty = true;
                }
                None => pods_open = false,
            },
        }
    }
}

/// Sends one subscription each new build, until it leaves, the topology stops or fails, or the
/// receiver closes. Every subscription sends the build's one shared event.
async fn serve(
    hub: Arc<TopologyHub>,
    topology: Arc<Topology>,
    subscription: String,
    tx: mpsc::Sender<Arc<TopologyEvent>>,
    stop: CancellationToken,
    linger: Duration,
) {
    let mut published = topology.published.subscribe();
    let mut last_generation: Option<u64> = None;
    loop {
        let current = published.borrow_and_update().clone();
        let event = match current {
            None => None,
            Some(Published::Failure(message)) => {
                let failure = Arc::new(TopologyEvent::Failure { message });
                tokio::select! {
                    () = stop.cancelled() => {}
                    _ = tx.send(failure) => {}
                }
                break;
            }
            Some(Published::Snapshot { generation, event }) => {
                if last_generation == Some(generation) {
                    None
                } else {
                    last_generation = Some(generation);
                    Some(event)
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
            // A failure published as the topology stops still goes out first.
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
    topology.detach(linger);
}

impl AppCore {
    /// Sends the cluster's node topology to `tx` until unsubscribed, the cluster disconnects,
    /// the receiver closes or the topology fails (topology spec §4.1). Returns the
    /// subscription id. `owner` is the label of the window that asks.
    pub fn node_topology_subscribe(
        &self,
        id: &ClusterId,
        tx: mpsc::Sender<Arc<TopologyEvent>>,
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
        self.topologies().subscribe(self, id, tx, &cluster, owner)
    }

    /// An id that is unknown or already ended is ignored.
    pub fn node_topology_unsubscribe(&self, subscription: &str) {
        self.topologies().unsubscribe(subscription);
    }

    /// Applies to topologies that start later.
    pub fn set_topology_interval_for_test(&self, interval: Duration) {
        // A zero interval would rebuild on every event.
        *lock(&self.topologies().interval) = interval.max(Duration::from_millis(1));
    }

    /// How many topologies run, so tests can check that subscriptions share one and that it
    /// stops.
    pub fn running_topologies_for_test(&self) -> usize {
        self.topologies().running()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::topology::types::TopologySnapshot;

    fn snapshot(node_count: u32) -> TopologyEvent {
        TopologyEvent::Snapshot {
            snapshot: TopologySnapshot {
                regions: Vec::new(),
                node_count,
                pod_count: 0,
                pods_hidden: false,
            },
        }
    }

    fn generation(topology: &Topology) -> Option<u64> {
        match &*topology.published.borrow() {
            Some(Published::Snapshot { generation, .. }) => Some(*generation),
            _ => None,
        }
    }

    #[test]
    fn an_equal_build_is_not_published_again() {
        let topology = Topology::new(CancellationToken::new());
        topology.publish(snapshot(1));
        topology.publish(snapshot(1));
        assert_eq!(generation(&topology), Some(1));
        topology.publish(snapshot(2));
        assert_eq!(generation(&topology), Some(2));
    }
}
