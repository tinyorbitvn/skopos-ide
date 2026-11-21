//! One graph per cluster, shared by every subscription of that cluster (spec E §4.1 to §4.3).
//!
//! A builder task reads the graph's kinds through the watch hub, keeps them in a store, and
//! rebuilds the graph at most once per interval after a change. Each subscription has its own
//! task, which sends its view of a new build when that view changed.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::build::{build, view, Built, Store};
use super::kinds::served_kinds;
use super::types::GraphEvent;
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{state_name, RowShape, Scope};
use crate::subscriptions::Subscriptions;

/// Spec E §4.3: later snapshots at most once every 2 s.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);
/// Hub events wait here while a build runs.
const EVENT_BACKLOG: usize = 64;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the builder last published.
#[derive(Debug, Clone)]
enum Published {
    Graph(Arc<Shared>),
    Failure(String),
}

/// One published build, and the event that shows all of it, made the first time a
/// subscription without a namespace filter asks for it. They all send that one event.
#[derive(Debug)]
struct Shared {
    built: Built,
    whole: OnceLock<Arc<GraphEvent>>,
}

impl Shared {
    fn whole(&self) -> Arc<GraphEvent> {
        self.whole
            .get_or_init(|| Arc::new(view(&self.built, None)))
            .clone()
    }
}

struct GraphState {
    subscribers: usize,
    /// It failed, and takes no new subscriber.
    terminal: bool,
    /// Tells a linger timer whether its last subscriber is still the last one.
    linger_epoch: u64,
}

struct Graph {
    /// A child of the cluster's token. Lingering out cancels it too.
    token: CancellationToken,
    published: watch::Sender<Option<Published>>,
    state: Mutex<GraphState>,
}

impl Graph {
    fn new(token: CancellationToken) -> Self {
        let (published, _) = watch::channel(None);
        Self {
            token,
            published,
            state: Mutex::new(GraphState {
                subscribers: 0,
                terminal: false,
                linger_epoch: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, GraphState> {
        lock(&self.state)
    }

    fn is_closed(&self) -> bool {
        self.token.is_cancelled() || self.lock().terminal
    }

    /// False when the graph stopped, and the caller needs a new one.
    fn attach(&self) -> bool {
        let mut state = self.lock();
        if state.terminal || self.token.is_cancelled() {
            return false;
        }
        state.subscribers += 1;
        true
    }

    /// Starts the linger timer when this was the last subscriber. A failed graph stops at once.
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
        let graph = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = graph.token.cancelled() => return,
                () = tokio::time::sleep(linger) => {}
            }
            // Under the lock, so that `attach` either wins or sees the cancellation.
            let state = graph.lock();
            if state.subscribers == 0 && state.linger_epoch == epoch {
                graph.token.cancel();
            }
        });
    }

    /// Publishes a build that differs from the last one, as the next generation.
    fn publish(&self, mut built: Built) {
        self.published.send_if_modified(|current| {
            let mut generation = 1;
            if let Some(Published::Graph(last)) = current {
                if last.built == built {
                    return false;
                }
                generation = last.built.generation + 1;
            }
            built.generation = generation;
            *current = Some(Published::Graph(Arc::new(Shared {
                built,
                whole: OnceLock::new(),
            })));
            true
        });
    }

    /// Ends the graph: each subscriber gets the failure and stops.
    fn fail(&self, message: String) {
        self.lock().terminal = true;
        self.published
            .send_replace(Some(Published::Failure(message)));
    }
}

/// The graphs of every cluster.
pub(crate) struct GraphHub {
    graphs: DashMap<ClusterId, Arc<Graph>>,
    /// What stops each subscription's task.
    subscriptions: Subscriptions,
    next_subscription: AtomicU64,
    interval: Mutex<Duration>,
}

impl Default for GraphHub {
    fn default() -> Self {
        Self {
            graphs: DashMap::new(),
            subscriptions: Subscriptions::default(),
            next_subscription: AtomicU64::new(1),
            interval: Mutex::new(DEFAULT_INTERVAL),
        }
    }
}

impl GraphHub {
    fn interval(&self) -> Duration {
        *lock(&self.interval)
    }

    /// The cluster's running graph with one more subscriber, or a new one.
    fn join(
        self: &Arc<Self>,
        core: &AppCore,
        id: &ClusterId,
        cluster: &CancellationToken,
    ) -> CoreResult<Arc<Graph>> {
        loop {
            // A disconnect that just happened would leave every new graph closed.
            if cluster.is_cancelled() {
                return Err(IpcError::new(
                    ErrorCode::Unreachable,
                    format!("cluster {id} is not connected"),
                ));
            }
            match self.graphs.entry(id.clone()) {
                Entry::Occupied(entry) if !entry.get().is_closed() => {
                    let graph = entry.get().clone();
                    drop(entry);
                    if graph.attach() {
                        return Ok(graph);
                    }
                }
                entry => {
                    let graph = Arc::new(Graph::new(cluster.child_token()));
                    // Before its builder starts, so that a builder failing at once still
                    // counts this subscriber, and this loop does not start another.
                    if !graph.attach() {
                        continue;
                    }
                    entry.insert(graph.clone());
                    tokio::spawn(run_graph(
                        self.clone(),
                        core.clone(),
                        id.clone(),
                        graph.clone(),
                    ));
                    return Ok(graph);
                }
            }
        }
    }

    fn subscribe(
        self: &Arc<Self>,
        core: &AppCore,
        id: &ClusterId,
        namespaces: Option<Vec<String>>,
        tx: mpsc::Sender<Arc<GraphEvent>>,
        cluster: &CancellationToken,
        owner: &str,
    ) -> CoreResult<String> {
        let graph = self.join(core, id, cluster)?;
        let number = self.next_subscription.fetch_add(1, Ordering::Relaxed);
        let subscription = format!("graph-{number}");
        let stop = graph.token.child_token();
        self.subscriptions
            .insert(subscription.clone(), stop.clone(), Some(owner));
        let linger = core.watches().linger();
        tokio::spawn(serve(
            self.clone(),
            graph,
            subscription.clone(),
            namespaces,
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
        self.graphs
            .iter()
            .filter(|entry| !entry.value().is_closed())
            .count()
    }
}

/// Builds the graph until it lingers out, its cluster disconnects or it fails.
async fn run_graph(hub: Arc<GraphHub>, core: AppCore, id: ClusterId, graph: Arc<Graph>) {
    let mut watches = Vec::new();
    let ended = build_loop(&hub, &core, &id, &graph, &mut watches).await;
    // A disconnect fails discovery and the hub too. It ends the graph without a failure.
    if let Err(message) = ended {
        if !graph.token.is_cancelled() {
            graph.fail(message);
        }
    }
    for watch in &watches {
        core.resources_unsubscribe(watch);
    }
    hub.graphs
        .remove_if(&id, |_, current| Arc::ptr_eq(current, &graph));
}

/// Returns the failure's message, or nothing once the graph's token is cancelled. The hub
/// subscriptions it made go into `watches`, so the caller ends them however this returns.
async fn build_loop(
    hub: &GraphHub,
    core: &AppCore,
    id: &ClusterId,
    graph: &Graph,
    watches: &mut Vec<String>,
) -> Result<(), String> {
    let discovery = core.cluster_discovery(id).map_err(|e| e.message)?;
    let kinds = served_kinds(&discovery);
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
            () = graph.token.cancelled() => return Ok(()),
            () = tokio::time::sleep_until(next_build), if due => {
                graph.publish(build(&store));
                dirty = false;
                next_build = Instant::now() + interval;
            }
            event = events.next(), if open => match event {
                Some((kind, event)) => {
                    store.apply(kind, event);
                    dirty = true;
                }
                // Every watch ended: each kind failed for good, or the cluster disconnected.
                None => open = false,
            },
        }
    }
}

/// Sends one subscription its view of each new build, until it leaves, the graph stops or
/// fails, or the receiver closes. Without a namespace filter the view is the graph itself:
/// one shared event per generation, so a build that nobody changed is not compared at all.
async fn serve(
    hub: Arc<GraphHub>,
    graph: Arc<Graph>,
    subscription: String,
    namespaces: Option<Vec<String>>,
    tx: mpsc::Sender<Arc<GraphEvent>>,
    stop: CancellationToken,
    linger: Duration,
) {
    let mut published = graph.published.subscribe();
    // What was last sent: the generation of the whole graph, or a namespace view.
    let mut last_generation: Option<u64> = None;
    let mut last_view: Option<GraphEvent> = None;
    loop {
        let current = published.borrow_and_update().clone();
        let event: Option<Arc<GraphEvent>> = match current {
            None => None,
            Some(Published::Failure(message)) => {
                let failure = Arc::new(GraphEvent::Failure { message });
                tokio::select! {
                    () = stop.cancelled() => {}
                    _ = tx.send(failure) => {}
                }
                break;
            }
            Some(Published::Graph(shared)) => match namespaces.as_deref() {
                None => {
                    let generation = shared.built.generation;
                    if last_generation == Some(generation) {
                        None
                    } else {
                        last_generation = Some(generation);
                        Some(shared.whole())
                    }
                }
                Some(namespaces) => {
                    let event = view(&shared.built, Some(namespaces));
                    if last_view.as_ref() == Some(&event) {
                        None
                    } else {
                        last_view = Some(event.clone());
                        Some(Arc::new(event))
                    }
                }
            },
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
            // A failure published as the graph stops still goes out first.
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
    graph.detach(linger);
}

impl AppCore {
    /// Sends the cluster's graph, seen through `namespaces`, to `tx` until unsubscribed, the
    /// cluster disconnects, the receiver closes or the graph fails (spec E §4.1). `None` sees
    /// the whole graph. Returns the subscription id. `owner` is the label of the window that
    /// asks.
    pub fn resource_graph_subscribe(
        &self,
        id: &ClusterId,
        namespaces: Option<Vec<String>>,
        tx: mpsc::Sender<Arc<GraphEvent>>,
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
        self.graphs()
            .subscribe(self, id, namespaces, tx, &cluster, owner)
    }

    /// An id that is unknown or already ended is ignored.
    pub fn resource_graph_unsubscribe(&self, subscription: &str) {
        self.graphs().unsubscribe(subscription);
    }

    /// Applies to graphs that start later.
    pub fn set_graph_interval_for_test(&self, interval: Duration) {
        // A zero interval would rebuild on every event.
        *lock(&self.graphs().interval) = interval.max(Duration::from_millis(1));
    }

    /// How many graphs run, so tests can check that subscriptions share one and that it stops.
    pub fn running_graphs_for_test(&self) -> usize {
        self.graphs().running()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::graph::types::{GraphNode, GraphStatus};

    const LINGER: Duration = Duration::from_secs(30);
    const QUIET: Duration = Duration::from_millis(200);

    fn deployment(namespace: &str, name: &str) -> GraphNode {
        GraphNode {
            id: format!("Deployment/{namespace}/{name}"),
            kind: "Deployment".into(),
            group: "apps".into(),
            plural: "deployments".into(),
            namespace: namespace.into(),
            name: name.into(),
            created: None,
            status: GraphStatus::Nominal,
            status_text: None,
            facts: Vec::new(),
        }
    }

    fn built(nodes: Vec<GraphNode>) -> Built {
        Built {
            nodes,
            edges: Vec::new(),
            counts: Vec::new(),
            missing: Vec::new(),
            gateway_api: false,
            generation: 0,
        }
    }

    /// One subscription of `graph`, served as the hub serves it.
    fn served(
        graph: &Arc<Graph>,
        namespaces: Option<Vec<String>>,
    ) -> (
        Arc<GraphHub>,
        mpsc::Receiver<Arc<GraphEvent>>,
        tokio::task::JoinHandle<()>,
    ) {
        let hub = Arc::new(GraphHub::default());
        let (tx, rx) = mpsc::channel(4);
        assert!(graph.attach());
        let stop = graph.token.child_token();
        hub.subscriptions
            .insert("graph-1".to_owned(), stop.clone(), None);
        let task = tokio::spawn(serve(
            hub.clone(),
            graph.clone(),
            "graph-1".to_owned(),
            namespaces,
            tx,
            stop,
            LINGER,
        ));
        (hub, rx, task)
    }

    async fn quiet(rx: &mut mpsc::Receiver<Arc<GraphEvent>>) {
        if let Ok(event) = tokio::time::timeout(QUIET, rx.recv()).await {
            panic!("expected nothing, got {event:?}");
        }
    }

    fn node_ids(event: Option<Arc<GraphEvent>>) -> Vec<String> {
        match event.as_deref() {
            Some(GraphEvent::Snapshot { nodes, .. }) => {
                nodes.iter().map(|n| n.id.clone()).collect()
            }
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[test]
    fn an_unchanged_build_is_not_published_again() {
        let graph = Graph::new(CancellationToken::new());
        let mut seen = graph.published.subscribe();
        graph.publish(built(vec![deployment("a", "web")]));
        assert!(seen.has_changed().unwrap());
        seen.borrow_and_update();
        graph.publish(built(vec![deployment("a", "web")]));
        assert!(!seen.has_changed().unwrap());
        graph.publish(built(vec![deployment("a", "api")]));
        assert!(seen.has_changed().unwrap());
    }

    fn generation_of(seen: &watch::Receiver<Option<Published>>) -> u64 {
        match &*seen.borrow() {
            Some(Published::Graph(shared)) => shared.built.generation,
            other => panic!("expected a graph, got {other:?}"),
        }
    }

    #[test]
    fn each_published_build_is_the_next_generation_and_a_repeat_is_not_one() {
        let graph = Graph::new(CancellationToken::new());
        let seen = graph.published.subscribe();
        graph.publish(built(vec![deployment("a", "web")]));
        assert_eq!(generation_of(&seen), 1);
        graph.publish(built(vec![deployment("a", "web")]));
        assert_eq!(generation_of(&seen), 1, "the same graph is not a new one");
        graph.publish(built(vec![deployment("a", "api")]));
        assert_eq!(generation_of(&seen), 2);
    }

    #[tokio::test]
    async fn an_unfiltered_subscription_is_sent_one_event_per_generation() {
        let graph = Arc::new(Graph::new(CancellationToken::new()));
        let (_hub, mut rx, _task) = served(&graph, None);
        graph.publish(built(vec![deployment("a", "web")]));
        let first = rx.recv().await.unwrap();

        graph.publish(built(vec![deployment("a", "web")]));
        quiet(&mut rx).await;

        graph.publish(built(vec![deployment("a", "web"), deployment("b", "api")]));
        let second = rx.recv().await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(
            node_ids(Some(second)),
            ["Deployment/a/web", "Deployment/b/api"]
        );
    }

    #[tokio::test]
    async fn a_subscription_is_sent_only_what_changes_its_view() {
        let graph = Arc::new(Graph::new(CancellationToken::new()));
        let (_hub, mut rx, _task) = served(&graph, Some(vec!["a".to_owned()]));
        graph.publish(built(vec![deployment("a", "web")]));
        assert_eq!(node_ids(rx.recv().await), ["Deployment/a/web"]);

        graph.publish(built(vec![deployment("a", "web"), deployment("b", "api")]));
        quiet(&mut rx).await;

        graph.publish(built(vec![
            deployment("a", "api"),
            deployment("a", "web"),
            deployment("b", "api"),
        ]));
        assert_eq!(
            node_ids(rx.recv().await),
            ["Deployment/a/api", "Deployment/a/web"]
        );
    }

    #[tokio::test]
    async fn a_new_subscription_gets_the_current_graph_at_once() {
        let graph = Arc::new(Graph::new(CancellationToken::new()));
        graph.publish(built(vec![deployment("a", "web")]));
        let (_hub, mut rx, _task) = served(&graph, None);
        assert_eq!(node_ids(rx.recv().await), ["Deployment/a/web"]);
    }

    #[tokio::test]
    async fn a_failure_reaches_the_subscription_and_ends_it() {
        let graph = Arc::new(Graph::new(CancellationToken::new()));
        let (hub, mut rx, task) = served(&graph, None);
        graph.publish(built(Vec::new()));
        assert!(matches!(
            rx.recv().await.as_deref(),
            Some(GraphEvent::Snapshot { .. })
        ));

        graph.fail("discovery failed".to_owned());
        assert_eq!(
            rx.recv().await,
            Some(Arc::new(GraphEvent::Failure {
                message: "discovery failed".to_owned()
            }))
        );
        assert_eq!(rx.recv().await, None);
        task.await.unwrap();
        assert_eq!(hub.subscriptions.len(), 0);
        assert!(graph.is_closed());
        assert!(graph.token.is_cancelled(), "a failed graph does not linger");
        assert!(!graph.attach(), "a retry needs a new graph");
    }

    #[tokio::test]
    async fn leaving_ends_the_subscription_without_an_event() {
        let graph = Arc::new(Graph::new(CancellationToken::new()));
        let (hub, mut rx, task) = served(&graph, None);
        hub.unsubscribe("graph-1");
        assert_eq!(rx.recv().await, None);
        task.await.unwrap();
        hub.unsubscribe("graph-1");
        hub.unsubscribe("graph-unknown");
        assert!(!graph.token.is_cancelled(), "it lingers");
    }

    #[tokio::test]
    async fn the_last_departure_lingers_before_the_graph_stops() {
        let graph = Arc::new(Graph::new(CancellationToken::new()));
        assert!(graph.attach());
        graph.detach(Duration::from_millis(100));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            graph.attach(),
            "coming back within the linger keeps the graph"
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!graph.token.is_cancelled());

        graph.detach(Duration::from_millis(50));
        tokio::time::timeout(Duration::from_secs(2), graph.token.cancelled())
            .await
            .expect("the graph stops after the linger");
        assert!(!graph.attach());
    }

    #[tokio::test]
    async fn a_disconnect_stops_the_graph_and_its_subscriptions() {
        let cluster = CancellationToken::new();
        let graph = Arc::new(Graph::new(cluster.child_token()));
        let (_hub, mut rx, task) = served(&graph, None);
        graph.publish(built(Vec::new()));
        assert!(rx.recv().await.is_some());
        cluster.cancel();
        assert_eq!(rx.recv().await, None, "no failure, no event");
        task.await.unwrap();
        assert!(graph.is_closed());
    }
}
