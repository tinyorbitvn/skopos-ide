//! One shared watcher per cluster and resource, fanned out to its subscribers.
//!
//! A watcher task updates the group's store and each subscriber's pending map.
//! Each subscriber has its own flush task, so a slow one only ever delays itself,
//! and what it has not read yet stays bounded by the number of objects.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use futures::stream::{FuturesUnordered, StreamExt};
use futures::FutureExt;
use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher;
use kube::{Api, Client};
use serde_json::Value;
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::discovery::state_name;
use super::sanitize::strip_for_list;
use super::trim::{is_core_pods, trim_for_graph, trim_for_watch};
use super::types::{ObjectKey, ResourceRef, Row, WatchEvent, WatchStatus};
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::subscriptions::Subscriptions;

const DEFAULT_BATCH: Duration = Duration::from_millis(150);
const DEFAULT_LINGER: Duration = Duration::from_secs(30);
const PAGE_SIZE: u32 = 500;
pub(super) const MIN_BACKOFF: Duration = Duration::from_secs(1);
pub(super) const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Pending changes may reach this many, or the number of objects if larger,
/// before a fresh snapshot replaces them. Otherwise names that come and go while
/// a subscriber is stalled would pile up as deletes.
const MIN_PENDING_LIMIT: usize = 256;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One watcher's scope: a namespace, or `None` for the whole cluster.
type Partition = Option<String>;

/// What a subscriber's rows keep: what the tables read, or what the relationship graph reads.
/// The two differ only for core Pods, so a group stores both rows of each Pod, and every other
/// resource has one row for both shapes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub(crate) enum RowShape {
    #[default]
    Table,
    Graph,
}

/// What a group keeps of one object.
#[derive(Clone)]
struct StoredRow {
    table: Row,
    /// Only core Pods have a graph row of their own.
    graph: Option<Row>,
}

impl StoredRow {
    /// The row a subscriber of `shape` receives.
    fn pick(&self, shape: RowShape) -> &Row {
        match shape {
            RowShape::Table => &self.table,
            RowShape::Graph => self.graph.as_ref().unwrap_or(&self.table),
        }
    }
}

/// A group's key: cluster, group and plural.
type GroupKey = (ClusterId, String, String);

enum Phase {
    Syncing,
    Live,
    Failing(String),
}

struct PartitionState {
    phase: Phase,
    synced_once: bool,
}

impl PartitionState {
    fn new() -> Self {
        Self {
            phase: Phase::Syncing,
            synced_once: false,
        }
    }
}

type StatusUpdate = (WatchStatus, Option<String>);

/// What one subscriber has not received yet.
#[derive(Default)]
struct Subscriber {
    /// Which of an object's rows this subscriber receives.
    shape: RowShape,
    /// Latest wins, so this holds at most one entry per object.
    changes: HashMap<ObjectKey, Option<Row>>,
    status: Option<StatusUpdate>,
    /// Built from the store when flushed, so a stalled subscriber holds no copy.
    snapshot_due: bool,
    got_snapshot: bool,
    /// Signalled whenever something is queued for this subscriber, so its flusher sleeps
    /// until then. `notify_one` keeps a permit, so a signal during a flush is not lost.
    wake: Arc<Notify>,
}

struct GroupState {
    store: HashMap<ObjectKey, StoredRow>,
    partitions: HashMap<Partition, PartitionState>,
    subscribers: HashMap<String, Subscriber>,
    status: StatusUpdate,
    /// The watcher stopped for good. Subscribers end once they have been told.
    terminal: bool,
    /// Tells a linger timer whether its last subscriber is still the last one.
    linger_epoch: u64,
}

impl GroupState {
    fn synced(&self) -> bool {
        self.partitions.values().all(|p| p.synced_once)
    }

    fn current_status(&self) -> StatusUpdate {
        let mut status = (WatchStatus::Live, None);
        for partition in self.partitions.values() {
            match &partition.phase {
                Phase::Failing(message) => {
                    return (WatchStatus::Reconnecting, Some(message.clone()));
                }
                Phase::Syncing => status = (WatchStatus::Syncing, None),
                Phase::Live => {}
            }
        }
        status
    }

    /// Tells every subscriber's flusher to look at what is queued.
    fn wake_all(&self) {
        for subscriber in self.subscribers.values() {
            subscriber.wake.notify_one();
        }
    }

    fn set_status(&mut self, status: StatusUpdate) {
        if self.status == status {
            return;
        }
        self.status = status;
        for subscriber in self.subscribers.values_mut() {
            subscriber.status = Some(self.status.clone());
            subscriber.wake.notify_one();
        }
    }

    fn publish_status(&mut self) {
        let status = self.current_status();
        self.set_status(status);
    }

    fn queue_snapshot(&mut self) {
        if !self.synced() {
            return;
        }
        for subscriber in self.subscribers.values_mut() {
            subscriber.snapshot_due = true;
            subscriber.changes.clear();
            subscriber.wake.notify_one();
        }
    }

    fn record_change(&mut self, key: &ObjectKey, value: Option<&StoredRow>) {
        // Whoever is waiting for a snapshot gets this change in it.
        if !self.synced() {
            return;
        }
        let limit = self.store.len().max(MIN_PENDING_LIMIT);
        for subscriber in self.subscribers.values_mut() {
            if subscriber.snapshot_due {
                continue;
            }
            let row = value.map(|stored| stored.pick(subscriber.shape).clone());
            subscriber.changes.insert(key.clone(), row);
            if subscriber.changes.len() > limit {
                subscriber.changes.clear();
                subscriber.snapshot_due = true;
            }
            subscriber.wake.notify_one();
        }
    }
}

struct Group {
    resource: ResourceRef,
    /// A child of the cluster's token. Lingering out cancels it too.
    token: CancellationToken,
    state: Mutex<GroupState>,
}

impl Group {
    fn new(resource: ResourceRef, token: CancellationToken) -> Self {
        Self {
            resource,
            token,
            state: Mutex::new(GroupState {
                store: HashMap::new(),
                partitions: HashMap::from([(None, PartitionState::new())]),
                subscribers: HashMap::new(),
                status: (WatchStatus::Syncing, None),
                terminal: false,
                linger_epoch: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, GroupState> {
        lock(&self.state)
    }

    fn is_closed(&self) -> bool {
        self.token.is_cancelled() || self.lock().terminal
    }

    /// False when the group stopped, and the caller needs a new one. `wake` is signalled
    /// whenever something is queued for the new subscriber, which starts with a status.
    fn attach(&self, subscription: &str, shape: RowShape, wake: Arc<Notify>) -> bool {
        let mut state = self.lock();
        if state.terminal || self.token.is_cancelled() {
            return false;
        }
        let subscriber = Subscriber {
            shape,
            status: Some(state.status.clone()),
            snapshot_due: state.synced(),
            wake,
            ..Default::default()
        };
        subscriber.wake.notify_one();
        state
            .subscribers
            .insert(subscription.to_owned(), subscriber);
        true
    }

    /// Starts the linger timer when this was the last subscriber.
    fn detach(self: &Arc<Self>, subscription: &str, linger: Duration) {
        let epoch = {
            let mut state = self.lock();
            state.subscribers.remove(subscription);
            if !state.subscribers.is_empty() || state.terminal || self.token.is_cancelled() {
                return;
            }
            state.linger_epoch += 1;
            state.linger_epoch
        };
        let group = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = group.token.cancelled() => return,
                () = tokio::time::sleep(linger) => {}
            }
            // Under the lock, so that `attach` either wins or sees the cancellation.
            let state = group.lock();
            if state.subscribers.is_empty() && state.linger_epoch == epoch {
                group.token.cancel();
            }
        });
    }

    /// The events owed to one subscriber, and whether they are its last.
    fn take_events(&self, subscription: &str) -> (Vec<WatchEvent>, bool) {
        let mut guard = self.lock();
        let state = &mut *guard;
        let Some(subscriber) = state.subscribers.get_mut(subscription) else {
            return (Vec::new(), true);
        };
        let status = subscriber
            .status
            .take()
            .map(|(status, message)| WatchEvent::Status { status, message });
        let snapshot = std::mem::take(&mut subscriber.snapshot_due).then(|| WatchEvent::Snapshot {
            items: sorted_items(&state.store, subscriber.shape),
        });
        let batch = (!subscriber.changes.is_empty()).then(|| {
            let mut upserts = Vec::new();
            let mut deletes = Vec::new();
            for (key, value) in subscriber.changes.drain() {
                match value {
                    Some(value) => upserts.push(value),
                    None => deletes.push(key),
                }
            }
            WatchEvent::Batch { upserts, deletes }
        });
        // A subscriber's first data is a snapshot, whatever the status says by then,
        // and a final status closes the subscription, so it goes last.
        let status_first = !state.terminal && (subscriber.got_snapshot || snapshot.is_none());
        subscriber.got_snapshot |= snapshot.is_some();
        let mut events = Vec::new();
        if status_first {
            events.extend(status);
            events.extend(snapshot);
            events.extend(batch);
        } else {
            events.extend(snapshot);
            events.extend(batch);
            events.extend(status);
        }
        (events, state.terminal)
    }

    /// Replaces what the partition holds with a completed listing.
    fn finish_init(&self, partition: &Partition, listed: HashMap<ObjectKey, StoredRow>) {
        let mut state = self.lock();
        match partition {
            None => state.store = listed,
            Some(namespace) => {
                state
                    .store
                    .retain(|key, _| key.namespace.as_ref() != Some(namespace));
                state.store.extend(listed);
            }
        }
        if let Some(entry) = state.partitions.get_mut(partition) {
            entry.phase = Phase::Live;
            entry.synced_once = true;
        }
        state.publish_status();
        state.queue_snapshot();
    }

    fn apply(&self, key: ObjectKey, value: StoredRow) {
        let mut state = self.lock();
        state.record_change(&key, Some(&value));
        state.store.insert(key, value);
    }

    fn delete(&self, key: &ObjectKey) {
        let mut state = self.lock();
        state.store.remove(key);
        state.record_change(key, None);
    }

    fn set_failing(&self, partition: &Partition, message: String) {
        let mut state = self.lock();
        if let Some(entry) = state.partitions.get_mut(partition) {
            entry.phase = Phase::Failing(message);
        }
        state.publish_status();
    }

    /// Switches from the cluster-wide watcher to one per namespace. Only objects
    /// of those namespaces can stay, since nothing else will keep them current.
    fn begin_fallback(&self, namespaces: &[String]) {
        let mut state = self.lock();
        state.partitions = namespaces
            .iter()
            .map(|namespace| (Some(namespace.clone()), PartitionState::new()))
            .collect();
        state.store.retain(|key, _| {
            key.namespace
                .as_ref()
                .is_some_and(|namespace| namespaces.contains(namespace))
        });
        state.publish_status();
    }

    /// A namespace the user may not read leaves the merge.
    fn drop_partition(&self, namespace: &str) {
        let mut state = self.lock();
        state.partitions.remove(&Some(namespace.to_owned()));
        state
            .store
            .retain(|key, _| key.namespace.as_deref() != Some(namespace));
        // The last one leaving ends the group in `finish`, which reports why.
        if state.partitions.is_empty() {
            return;
        }
        state.publish_status();
        state.queue_snapshot();
    }

    fn finish(&self, status: WatchStatus, message: Option<String>) {
        let mut state = self.lock();
        state.terminal = true;
        state.set_status((status, message));
        // A subscriber must learn it is over even when the status did not change.
        state.wake_all();
    }
}

#[derive(Clone, Copy)]
struct Timing {
    batch: Duration,
    linger: Duration,
}

/// The shared watchers of every cluster.
pub(crate) struct WatchHub {
    /// Keyed by cluster, group and plural.
    groups: DashMap<GroupKey, Arc<Group>>,
    /// What stops each subscription's flush task.
    subscriptions: Subscriptions,
    next_subscription: AtomicU64,
    timing: Mutex<Timing>,
    /// How many times a flusher reached `take_events`.
    #[cfg(test)]
    flusher_wakes: AtomicU64,
}

impl Default for WatchHub {
    fn default() -> Self {
        Self {
            groups: DashMap::new(),
            subscriptions: Subscriptions::default(),
            next_subscription: AtomicU64::new(1),
            timing: Mutex::new(Timing {
                batch: DEFAULT_BATCH,
                linger: DEFAULT_LINGER,
            }),
            #[cfg(test)]
            flusher_wakes: AtomicU64::new(0),
        }
    }
}

/// What a new watcher needs from the connection.
pub(super) struct Connection {
    pub(super) client: Client,
    pub(super) token: CancellationToken,
    pub(super) namespaces: Vec<String>,
}

impl WatchHub {
    fn timing(&self) -> Timing {
        *lock(&self.timing)
    }

    #[cfg(test)]
    fn flusher_wakes(&self) -> u64 {
        self.flusher_wakes.load(Ordering::Relaxed)
    }

    /// How long a watcher outlives its last subscriber. The graph lingers as long.
    pub(crate) fn linger(&self) -> Duration {
        self.timing().linger
    }

    /// The next id, `watch-N`. Hub subscribers and object watches draw from one counter.
    fn new_subscription(&self) -> String {
        let number = self.next_subscription.fetch_add(1, Ordering::Relaxed);
        format!("watch-{number}")
    }

    /// Makes `stop` what `unsubscribe` cancels for a new id, for a watch that has no group.
    /// `owner` is the window that asked, if one did.
    pub(super) fn register(&self, stop: CancellationToken, owner: Option<&str>) -> String {
        let subscription = self.new_subscription();
        self.subscriptions.insert(subscription.clone(), stop, owner);
        subscription
    }

    /// Forgets an id whose watch has ended.
    pub(super) fn deregister(&self, subscription: &str) {
        self.subscriptions.forget(subscription);
    }

    /// Ends the subscriptions the window `owner` asked for.
    pub(crate) fn stop_owned(&self, owner: &str) {
        self.subscriptions.stop_owned(owner);
    }

    fn subscribe(
        self: &Arc<Self>,
        id: &ClusterId,
        resource: ResourceRef,
        shape: RowShape,
        tx: mpsc::Sender<WatchEvent>,
        connection: &Connection,
        owner: Option<&str>,
    ) -> CoreResult<String> {
        let subscription = self.new_subscription();
        let wake = Arc::new(Notify::new());
        let group = loop {
            // A disconnect that just happened would leave every new group closed.
            if connection.token.is_cancelled() {
                return Err(IpcError::new(
                    ErrorCode::Unreachable,
                    format!("cluster {id} is not connected"),
                ));
            }
            let group = self.group_for(id, &resource, connection);
            if group.attach(&subscription, shape, wake.clone()) {
                break group;
            }
        };
        let stop = group.token.child_token();
        self.subscriptions
            .insert(subscription.clone(), stop.clone(), owner);
        tokio::spawn(flush_subscriber(
            self.clone(),
            group,
            subscription.clone(),
            wake,
            tx,
            stop,
        ));
        Ok(subscription)
    }

    /// The running group, or a new one in place of nothing or a stopped one.
    fn group_for(
        self: &Arc<Self>,
        id: &ClusterId,
        resource: &ResourceRef,
        connection: &Connection,
    ) -> Arc<Group> {
        let key = (id.clone(), resource.group.clone(), resource.plural.clone());
        match self.groups.entry(key.clone()) {
            Entry::Occupied(entry) if !entry.get().is_closed() => entry.get().clone(),
            entry => {
                let group = Arc::new(Group::new(resource.clone(), connection.token.child_token()));
                entry.insert(group.clone());
                tokio::spawn(run_group(
                    self.clone(),
                    key,
                    group.clone(),
                    connection.client.clone(),
                    connection.namespaces.clone(),
                ));
                group
            }
        }
    }

    fn unsubscribe(&self, subscription: &str) {
        self.subscriptions.stop(subscription);
    }
}

/// Sends a subscriber what has piled up, until it leaves, its group ends or the receiver
/// closes. It sleeps until the group queues something for the subscriber, and then until a
/// batch interval has passed since its last flush. So an idle subscriber never wakes, a busy
/// one is sent at most once per interval, and a change waits no longer than one interval.
async fn flush_subscriber(
    hub: Arc<WatchHub>,
    group: Arc<Group>,
    subscription: String,
    wake: Arc<Notify>,
    tx: mpsc::Sender<WatchEvent>,
    stop: CancellationToken,
) {
    let batch = hub.timing().batch;
    let mut last_flush: Option<Instant> = None;
    'flushing: loop {
        tokio::select! {
            () = stop.cancelled() => break,
            () = tx.closed() => break,
            () = wake.notified() => {}
        }
        if let Some(last) = last_flush {
            tokio::select! {
                () = stop.cancelled() => break,
                () = tx.closed() => break,
                () = tokio::time::sleep_until(last + batch) => {}
            }
        }
        // This flush takes everything queued so far, so a signal stored since the wake
        // (several queueings, or one during the sleep) would only wake it for nothing.
        // A queueing after this point stores a new one, so nothing is missed.
        let _ = wake.notified().now_or_never();
        #[cfg(test)]
        hub.flusher_wakes.fetch_add(1, Ordering::Relaxed);
        let (events, last) = group.take_events(&subscription);
        // A wake whose changes an earlier flush already took sends nothing, and must not
        // push the next flush back.
        let sent_any = !events.is_empty();
        for event in events {
            tokio::select! {
                () = stop.cancelled() => break 'flushing,
                sent = tx.send(event) => {
                    if sent.is_err() {
                        break 'flushing;
                    }
                }
            }
        }
        if sent_any {
            last_flush = Some(Instant::now());
        }
        if last {
            break;
        }
    }
    hub.subscriptions.forget(&subscription);
    group.detach(&subscription, hub.timing().linger);
}

/// Why a partition's watcher stopped.
enum PartitionEnd {
    Cancelled,
    Forbidden(String),
    Gone,
}

async fn run_group(
    hub: Arc<WatchHub>,
    key: GroupKey,
    group: Arc<Group>,
    client: Client,
    namespaces: Vec<String>,
) {
    match run_partitions(&group, &client, &namespaces).await {
        PartitionEnd::Cancelled => {}
        PartitionEnd::Forbidden(message) => group.finish(WatchStatus::Forbidden, Some(message)),
        PartitionEnd::Gone => {
            let message = format!("the cluster no longer serves {}", group.resource.plural);
            group.finish(WatchStatus::NotServed, Some(message));
        }
    }
    hub.groups
        .remove_if(&key, |_, current| Arc::ptr_eq(current, &group));
}

/// Watches the whole cluster, or each namespace when that is forbidden. Returns
/// only once nothing is left to watch.
async fn run_partitions(group: &Group, client: &Client, namespaces: &[String]) -> PartitionEnd {
    let mut denied = match run_partition(group, client, None).await {
        PartitionEnd::Forbidden(message) => message,
        end => return end,
    };
    if !group.resource.namespaced || namespaces.is_empty() {
        return PartitionEnd::Forbidden(denied);
    }
    group.begin_fallback(namespaces);
    let mut running: FuturesUnordered<_> = namespaces
        .iter()
        .map(|namespace| async move {
            let end = run_partition(group, client, Some(namespace.clone())).await;
            (namespace, end)
        })
        .collect();
    while let Some((namespace, end)) = running.next().await {
        match end {
            PartitionEnd::Forbidden(message) => {
                group.drop_partition(namespace);
                denied = message;
            }
            end => return end,
        }
    }
    PartitionEnd::Forbidden(denied)
}

pub(super) struct Failure {
    pub(super) code: Option<u16>,
    /// Sanitized, since the status reaches the webview.
    pub(super) message: String,
}

pub(super) fn describe(err: watcher::Error) -> Failure {
    let source = match err {
        watcher::Error::InitialListFailed(source)
        | watcher::Error::WatchStartFailed(source)
        | watcher::Error::WatchFailed(source) => source,
        watcher::Error::WatchError(status) => kube::Error::Api(status),
        watcher::Error::NoResourceVersion => {
            return Failure {
                code: None,
                message: "the API server sent no resource version".to_owned(),
            }
        }
    };
    let code = match &source {
        kube::Error::Api(status) => Some(status.code),
        _ => None,
    };
    Failure {
        code,
        message: IpcError::from(source).message,
    }
}

/// Asks the API server, not the discovery result kept since connecting. When it
/// cannot tell, the resource counts as served, so that the watcher keeps trying.
pub(super) async fn still_served(client: &Client, resource: &ResourceRef) -> bool {
    let list = if resource.group.is_empty() {
        client.list_core_api_resources(&resource.version).await
    } else {
        client
            .list_api_group_resources(&format!("{}/{}", resource.group, resource.version))
            .await
    };
    match list {
        Ok(list) => list.resources.iter().any(|r| r.name == resource.plural),
        Err(kube::Error::Api(status)) => status.code != 404,
        Err(_) => true,
    }
}

/// The request path decides what the server returns, so a caller's `kind` must
/// not be able to exempt Secrets from having their values blanked.
pub(super) fn stamped_kind(resource: &ResourceRef) -> &str {
    if resource.group.is_empty() && resource.plural == "secrets" {
        "Secret"
    } else {
        &resource.kind
    }
}

pub(super) fn api_version(resource: &ResourceRef) -> String {
    if resource.group.is_empty() {
        resource.version.clone()
    } else {
        format!("{}/{}", resource.group, resource.version)
    }
}

pub(super) fn object_key(object: &DynamicObject) -> Option<ObjectKey> {
    Some(ObjectKey {
        namespace: object.metadata.namespace.clone(),
        name: object.metadata.name.clone()?,
    })
}

/// The object as the JSON value a row is built from, before any trim. List items come
/// without `kind` and `apiVersion`, so these are set from the resource before stripping,
/// which depends on them.
pub(super) fn stripped_object(
    object: &DynamicObject,
    resource: &ResourceRef,
) -> Option<(ObjectKey, Value)> {
    let key = object_key(object)?;
    let mut value = serde_json::to_value(object).ok()?;
    let fields = value.as_object_mut()?;
    fields.insert("apiVersion".to_owned(), api_version(resource).into());
    fields.insert("kind".to_owned(), stamped_kind(resource).into());
    strip_for_list(&mut value);
    Some((key, value))
}

/// The rows for the subscribers. A core Pod gets its graph row too, cut from a copy of the
/// same parsed value, so the object is parsed once however many shapes read it.
fn to_row(object: &DynamicObject, resource: &ResourceRef) -> Option<(ObjectKey, StoredRow)> {
    let (key, mut value) = stripped_object(object, resource)?;
    let graph = if is_core_pods(resource) {
        let mut graph = value.clone();
        trim_for_graph(resource, &mut graph);
        Some(Row::new(&graph).ok()?)
    } else {
        None
    };
    trim_for_watch(resource, &mut value);
    let table = Row::new(&value).ok()?;
    Some((key, StoredRow { table, graph }))
}

/// Sleeps unless cancelled first, and lengthens the next pause.
pub(super) async fn pause(backoff: &mut Duration, token: &CancellationToken) -> bool {
    let delay = *backoff;
    *backoff = (delay * 2).min(MAX_BACKOFF);
    tokio::select! {
        () = token.cancelled() => false,
        () = tokio::time::sleep(delay) => true,
    }
}

/// Runs one watcher until it is cancelled or must not be retried. After a failure
/// it starts over with a new list, so that subscribers get a snapshot of what they
/// missed instead of `watcher` quietly resuming from its last resource version.
async fn run_partition(group: &Group, client: &Client, partition: Partition) -> PartitionEnd {
    let resource = &group.resource;
    let api_resource = ApiResource {
        group: resource.group.clone(),
        version: resource.version.clone(),
        api_version: api_version(resource),
        kind: resource.kind.clone(),
        plural: resource.plural.clone(),
    };
    let api: Api<DynamicObject> = match &partition {
        Some(namespace) => Api::namespaced_with(client.clone(), namespace, &api_resource),
        None => Api::all_with(client.clone(), &api_resource),
    };
    let config = watcher::Config::default().page_size(PAGE_SIZE);
    let mut backoff = MIN_BACKOFF;
    loop {
        let mut stream = Box::pin(watcher(api.clone(), config.clone()));
        let mut listing = HashMap::new();
        let mut live_since = None;
        let end_of_stream = loop {
            let item = tokio::select! {
                () = group.token.cancelled() => return PartitionEnd::Cancelled,
                item = stream.next() => item,
            };
            let err = match item {
                Some(Ok(watcher::Event::Init)) => {
                    listing = HashMap::new();
                    continue;
                }
                Some(Ok(watcher::Event::InitApply(object))) => {
                    listing.extend(to_row(&object, resource));
                    continue;
                }
                Some(Ok(watcher::Event::InitDone)) => {
                    group.finish_init(&partition, std::mem::take(&mut listing));
                    live_since = Some(Instant::now());
                    continue;
                }
                Some(Ok(watcher::Event::Apply(object))) => {
                    if let Some((key, value)) = to_row(&object, resource) {
                        group.apply(key, value);
                    }
                    continue;
                }
                Some(Ok(watcher::Event::Delete(object))) => {
                    if let Some(key) = object_key(&object) {
                        group.delete(&key);
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
                if !pause(&mut backoff, &group.token).await {
                    return PartitionEnd::Cancelled;
                }
                continue;
            }
            break Some(describe(err));
        };
        if let Some(failure) = end_of_stream {
            if failure.code == Some(403) {
                return PartitionEnd::Forbidden(failure.message);
            }
            if matches!(failure.code, Some(404 | 410)) {
                let served = tokio::select! {
                    () = group.token.cancelled() => return PartitionEnd::Cancelled,
                    served = still_served(client, resource) => served,
                };
                if !served {
                    return PartitionEnd::Gone;
                }
            }
            // Only the resource version expired, and the next stream lists anew.
            if failure.code != Some(410) {
                tracing::debug!(plural = %resource.plural, "watch failed: {}", failure.message);
                group.set_failing(&partition, failure.message);
            }
        }
        if !pause(&mut backoff, &group.token).await {
            return PartitionEnd::Cancelled;
        }
    }
}

/// Group, version and plural become URL path segments, and come from the webview.
fn is_valid_path_part(part: &str) -> bool {
    part.split('.').all(|label| {
        !label.is_empty()
            && label
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

pub(super) fn validate(resource: &ResourceRef) -> CoreResult<()> {
    let valid = (resource.group.is_empty() || is_valid_path_part(&resource.group))
        && is_valid_path_part(&resource.version)
        && is_valid_path_part(&resource.plural);
    if valid {
        Ok(())
    } else {
        Err(IpcError::new(
            ErrorCode::InvalidInput,
            "the resource reference is not valid",
        ))
    }
}

impl AppCore {
    /// Delivers `resource` to `tx` until unsubscribed, the cluster disconnects, the
    /// receiver closes or a final status has been sent. Returns the subscription id.
    /// `owner` is the label of the window that asks, which `subscriptions_stop_owned` reads.
    pub async fn resources_subscribe(
        &self,
        id: &ClusterId,
        resource: ResourceRef,
        tx: mpsc::Sender<WatchEvent>,
        owner: &str,
    ) -> CoreResult<String> {
        validate(&resource)?;
        self.subscribe_rows(id, resource, RowShape::Table, tx, Some(owner))
    }

    /// `resources_subscribe` with the rows' shape picked. A reader inside the core has no
    /// `owner`, so no window's reload ends its subscription.
    pub(crate) fn subscribe_rows(
        &self,
        id: &ClusterId,
        resource: ResourceRef,
        shape: RowShape,
        tx: mpsc::Sender<WatchEvent>,
        owner: Option<&str>,
    ) -> CoreResult<String> {
        let connection = self.connection_of(id)?;
        self.watches()
            .subscribe(id, resource, shape, tx, &connection, owner)
    }

    /// The client, token and namespaces of a connected cluster.
    pub(super) fn connection_of(&self, id: &ClusterId) -> CoreResult<Connection> {
        let info = match self.cluster_state(id) {
            ConnectionState::Connected { info } => info,
            other => {
                return Err(IpcError::new(
                    ErrorCode::InvalidInput,
                    format!("cluster {id} is {}", state_name(&other)),
                ))
            }
        };
        Ok(Connection {
            client: self.cluster_client(id)?,
            token: self.cluster_cancel_token(id)?,
            namespaces: info.namespaces,
        })
    }

    /// An id that is unknown or already ended is ignored.
    pub fn resources_unsubscribe(&self, subscription: &str) {
        self.watches().unsubscribe(subscription);
    }

    /// `batch` applies to later subscriptions, and `linger` to later departures.
    pub fn set_watch_timing_for_test(&self, batch: Duration, linger: Duration) {
        *lock(&self.watches().timing) = Timing {
            // A zero interval would panic in the timer.
            batch: batch.max(Duration::from_millis(1)),
            linger,
        };
    }
}

/// The store's rows of `shape` in a stable order: by namespace (cluster-scoped first), then
/// name. The UI puts objects a batch adds in this same order (`compareListed` in
/// `ui/src/stores/resources.ts`); keep the two the same.
fn sorted_items(store: &HashMap<ObjectKey, StoredRow>, shape: RowShape) -> Vec<Row> {
    let mut entries: Vec<(&ObjectKey, &StoredRow)> = store.iter().collect();
    entries.sort_by(|a, b| (&a.0.namespace, &a.0.name).cmp(&(&b.0.namespace, &b.0.name)));
    entries
        .into_iter()
        .map(|(_, stored)| stored.pick(shape).clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_items_are_sorted_by_namespace_then_name() {
        let mut store = HashMap::new();
        for (namespace, name) in [
            (Some("b"), "x"),
            (Some("a"), "z"),
            (None, "node"),
            (Some("a"), "y"),
        ] {
            let key = ObjectKey {
                namespace: namespace.map(str::to_owned),
                name: name.to_owned(),
            };
            let row = Row::new(&serde_json::json!({ "n": namespace, "name": name })).unwrap();
            store.insert(
                key,
                StoredRow {
                    table: row,
                    graph: None,
                },
            );
        }
        let names: Vec<_> = sorted_items(&store, RowShape::Table)
            .iter()
            .map(|row| row.to_value()["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, ["node", "y", "z", "x"]);
    }

    #[test]
    fn path_parts() {
        for good in ["pods", "v1beta1", "example.com", "a-b.c-d"] {
            assert!(is_valid_path_part(good), "{good}");
        }
        for bad in ["", "..", "a/b", "../v1", "a..b", ".a", "a.", "Pods", "a b"] {
            assert!(!is_valid_path_part(bad), "{bad}");
        }
    }

    #[test]
    fn a_failing_partition_decides_the_status() {
        let mut states = HashMap::new();
        states.insert(Some("a".to_owned()), PartitionState::new());
        states.insert(
            Some("b".to_owned()),
            PartitionState {
                phase: Phase::Failing("broken".to_owned()),
                synced_once: true,
            },
        );
        let state = GroupState {
            store: HashMap::new(),
            partitions: states,
            subscribers: HashMap::new(),
            status: (WatchStatus::Syncing, None),
            terminal: false,
            linger_epoch: 0,
        };
        assert_eq!(
            state.current_status(),
            (WatchStatus::Reconnecting, Some("broken".to_owned()))
        );
        assert!(!state.synced());
    }

    fn resource(group: &str, plural: &str) -> ResourceRef {
        ResourceRef {
            group: group.into(),
            version: "v1".into(),
            plural: plural.into(),
            kind: "Pod".into(),
            namespaced: true,
        }
    }

    #[test]
    fn a_graph_row_keeps_what_the_graph_reads_and_a_table_row_does_not() {
        let object: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "web", "namespace": "a" },
            "spec": {
                "serviceAccountName": "web",
                "containers": [{ "name": "app", "env": [{ "name": "A", "value": "hidden-value" }] }],
            },
        }))
        .unwrap();
        let pods = resource("", "pods");

        let (_, stored) = to_row(&object, &pods).unwrap();
        let table = stored.pick(RowShape::Table);
        let graph = stored.pick(RowShape::Graph);

        assert!(table.to_value()["spec"].get("serviceAccountName").is_none());
        assert_eq!(graph.to_value()["spec"]["serviceAccountName"], "web");
        assert!(!graph.json().contains("hidden-value"), "{}", graph.json());
    }

    #[test]
    fn only_core_pods_store_a_graph_row_of_their_own() {
        let object: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "x", "namespace": "a" },
            "spec": { "serviceAccountName": "x" },
        }))
        .unwrap();
        for (group, plural, own_graph_row) in [
            ("", "pods", true),
            ("", "secrets", false),
            ("", "configmaps", false),
            ("example.com", "pods", false),
        ] {
            let (_, stored) = to_row(&object, &resource(group, plural)).unwrap();
            assert_eq!(stored.graph.is_some(), own_graph_row, "{group}/{plural}");
            if !own_graph_row {
                assert_eq!(
                    stored.pick(RowShape::Graph).json(),
                    stored.pick(RowShape::Table).json(),
                    "{group}/{plural}"
                );
            }
        }
    }

    /// The rows a batch of events carries, as values.
    fn rows_of(events: &[WatchEvent]) -> Vec<Value> {
        events
            .iter()
            .flat_map(|event| match event {
                WatchEvent::Snapshot { items } => items.clone(),
                WatchEvent::Batch { upserts, .. } => upserts.clone(),
                WatchEvent::Status { .. } => Vec::new(),
            })
            .map(|row| row.to_value())
            .collect()
    }

    #[test]
    fn each_subscriber_of_a_group_gets_the_rows_of_its_shape_in_snapshots_and_changes() {
        let pods = resource("", "pods");
        let object = |version: &str| -> DynamicObject {
            serde_json::from_value(serde_json::json!({
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": {
                    "name": "web",
                    "namespace": "a",
                    "resourceVersion": version,
                    "labels": { "version": version },
                },
                "spec": { "serviceAccountName": "web", "containers": [{ "name": "app" }] },
            }))
            .unwrap()
        };
        let group = Group::new(pods.clone(), CancellationToken::new());
        assert!(group.attach("table", RowShape::Table, Arc::default()));
        assert!(group.attach("graph", RowShape::Graph, Arc::default()));

        let (key, first) = to_row(&object("1"), &pods).unwrap();
        group.finish_init(&None, HashMap::from([(key.clone(), first)]));
        let table = rows_of(&group.take_events("table").0);
        let graph = rows_of(&group.take_events("graph").0);
        assert_eq!(table.len(), 1);
        assert_eq!(graph.len(), 1);
        assert!(table[0]["spec"].get("serviceAccountName").is_none());
        assert_eq!(graph[0]["spec"]["serviceAccountName"], "web");

        let (_, second) = to_row(&object("2"), &pods).unwrap();
        group.apply(key, second);
        let table = rows_of(&group.take_events("table").0);
        let graph = rows_of(&group.take_events("graph").0);
        assert_eq!(table[0]["metadata"]["resourceVersion"], "2");
        assert!(table[0]["spec"].get("serviceAccountName").is_none());
        // A graph row keeps no resourceVersion, so a label shows it is the new row.
        assert_eq!(graph[0]["metadata"]["labels"]["version"], "2");
        assert_eq!(graph[0]["spec"]["serviceAccountName"], "web");
    }

    #[test]
    fn registered_subscriptions_share_the_counter_and_unsubscribe_cancels_them() {
        let hub = WatchHub::default();
        let first = hub.register(CancellationToken::new(), None);
        assert_eq!(first, "watch-1");
        assert_eq!(hub.new_subscription(), "watch-2");

        let stop = CancellationToken::new();
        let third = hub.register(stop.clone(), None);
        assert_eq!(third, "watch-3");
        hub.unsubscribe(&third);
        assert!(stop.is_cancelled());

        let kept = CancellationToken::new();
        let fourth = hub.register(kept.clone(), None);
        hub.deregister(&fourth);
        hub.unsubscribe(&fourth);
        assert!(!kept.is_cancelled(), "a released id is no longer known");
    }

    #[test]
    fn a_stripped_object_is_stamped_and_has_secret_values_blanked() {
        let object: DynamicObject = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "s", "namespace": "a", "managedFields": [{ "manager": "m" }] },
            "data": { "password": "czNjcjN0" },
        }))
        .unwrap();
        let secrets = ResourceRef {
            group: String::new(),
            version: "v1".into(),
            plural: "secrets".into(),
            kind: "ConfigMap".into(),
            namespaced: true,
        };

        let (key, value) = stripped_object(&object, &secrets).unwrap();

        assert_eq!(key.name, "s");
        assert_eq!(value["kind"], "Secret");
        assert_eq!(value["apiVersion"], "v1");
        assert_eq!(value["data"]["password"], "");
        assert!(value["metadata"].get("managedFields").is_none());
    }

    fn stored(name: &str, version: &str) -> (ObjectKey, StoredRow) {
        let key = ObjectKey {
            namespace: Some("a".to_owned()),
            name: name.to_owned(),
        };
        let row = Row::new(&serde_json::json!({
            "metadata": { "name": name, "namespace": "a", "resourceVersion": version },
        }))
        .unwrap();
        (
            key,
            StoredRow {
                table: row,
                graph: None,
            },
        )
    }

    struct Rig {
        hub: Arc<WatchHub>,
        group: Arc<Group>,
        rx: mpsc::Receiver<WatchEvent>,
        stop: CancellationToken,
        task: tokio::task::JoinHandle<()>,
    }

    /// One flusher over a group with no watcher behind it, so a test is the API server.
    fn flusher_rig(batch: Duration) -> Rig {
        let hub = Arc::new(WatchHub::default());
        *lock(&hub.timing) = Timing {
            batch,
            linger: Duration::from_secs(30),
        };
        let group = Arc::new(Group::new(resource("", "pods"), CancellationToken::new()));
        let wake = Arc::new(Notify::new());
        assert!(group.attach("watch-1", RowShape::Table, wake.clone()));
        let (tx, rx) = mpsc::channel(16);
        let stop = group.token.child_token();
        let task = tokio::spawn(flush_subscriber(
            hub.clone(),
            group.clone(),
            "watch-1".to_owned(),
            wake,
            tx,
            stop.clone(),
        ));
        Rig {
            hub,
            group,
            rx,
            stop,
            task,
        }
    }

    impl Rig {
        /// Takes the status a subscriber starts with, then syncs the group and takes the
        /// empty snapshot and the Live status that follow.
        async fn synced(&mut self) {
            assert!(matches!(
                self.rx.recv().await,
                Some(WatchEvent::Status {
                    status: WatchStatus::Syncing,
                    ..
                })
            ));
            self.group.finish_init(&None, HashMap::new());
            assert!(matches!(
                self.rx.recv().await,
                Some(WatchEvent::Snapshot { .. })
            ));
            assert!(matches!(
                self.rx.recv().await,
                Some(WatchEvent::Status {
                    status: WatchStatus::Live,
                    ..
                })
            ));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn flusher_does_not_wake_while_idle() {
        let mut rig = flusher_rig(Duration::from_millis(150));
        rig.synced().await;
        let wakes = rig.hub.flusher_wakes();

        tokio::time::sleep(Duration::from_secs(3600)).await;

        assert_eq!(rig.hub.flusher_wakes(), wakes, "an idle flusher polled");
        assert!(rig.rx.try_recv().is_err());
        rig.stop.cancel();
        rig.task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn flusher_sends_a_change_at_once_after_idle_and_one_batch_after_a_flush() {
        let batch = Duration::from_millis(150);
        let mut rig = flusher_rig(batch);
        rig.synced().await;
        tokio::time::sleep(Duration::from_secs(10)).await;

        let started = Instant::now();
        let (key, first) = stored("web", "1");
        rig.group.apply(key.clone(), first);
        assert!(matches!(
            rig.rx.recv().await,
            Some(WatchEvent::Batch { .. })
        ));
        assert!(
            started.elapsed() <= batch,
            "late by {:?}",
            started.elapsed()
        );

        // A change right after a flush waits out the interval, and folds into one batch.
        let started = Instant::now();
        for version in ["2", "3", "4"] {
            rig.group.apply(key.clone(), stored("web", version).1);
        }
        let Some(WatchEvent::Batch { upserts, deletes }) = rig.rx.recv().await else {
            panic!("expected a batch");
        };
        assert_eq!(started.elapsed(), batch);
        assert!(deletes.is_empty());
        assert_eq!(upserts.len(), 1);
        assert_eq!(upserts[0].to_value()["metadata"]["resourceVersion"], "4");

        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(rig.rx.try_recv().is_err(), "nothing more was queued");
        rig.stop.cancel();
        rig.task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn flusher_wakes_for_a_status_a_due_snapshot_and_the_final_status() {
        let mut rig = flusher_rig(Duration::from_millis(150));
        rig.synced().await;

        rig.group.set_failing(&None, "boom".to_owned());
        let Some(WatchEvent::Status { status, message }) = rig.rx.recv().await else {
            panic!("expected a status");
        };
        assert_eq!(status, WatchStatus::Reconnecting);
        assert_eq!(message.as_deref(), Some("boom"));

        // After its first snapshot a subscriber gets the status before the next one.
        rig.group.finish_init(&None, HashMap::new());
        assert!(matches!(
            rig.rx.recv().await,
            Some(WatchEvent::Status {
                status: WatchStatus::Live,
                ..
            })
        ));
        assert!(matches!(
            rig.rx.recv().await,
            Some(WatchEvent::Snapshot { .. })
        ));

        rig.group
            .finish(WatchStatus::NotServed, Some("gone".to_owned()));
        let Some(WatchEvent::Status { status, .. }) = rig.rx.recv().await else {
            panic!("expected the final status");
        };
        assert_eq!(status, WatchStatus::NotServed);
        assert!(rig.rx.recv().await.is_none(), "the final status ends it");
        rig.task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn flusher_ends_when_the_receiver_closes_without_any_change() {
        let mut rig = flusher_rig(Duration::from_millis(150));
        rig.synced().await;

        drop(rig.rx);

        tokio::time::timeout(Duration::from_secs(1), rig.task)
            .await
            .expect("the flusher did not end")
            .unwrap();
    }
}
