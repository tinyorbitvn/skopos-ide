import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../ipc/api";
import { failureMessage, IpcFailure } from "../ipc/client";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { ObjectKey } from "../ipc/generated/ObjectKey";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { WatchEvent } from "../ipc/generated/WatchEvent";
import type { WatchStatus } from "../ipc/generated/WatchStatus";
import { type KubeObject, objectKey } from "../kinds/objects";
import { useCatalog } from "./catalog";
import { mergeAdded } from "./mergeRows";

/** The kinds whose watched rows are trimmed, as `<group>/<plural>`. */
const TRIMMED = new Set([
  "/pods",
  "/nodes",
  "/configmaps",
  "apps/replicasets",
  "apiextensions.k8s.io/customresourcedefinitions",
]);

/**
 * Whether the list watch sends this resource's rows with only some of their fields:
 * core Pods, Nodes and ConfigMaps, `apps` ReplicaSets and CustomResourceDefinitions.
 * "Watched Pod rows" and "Watched rows of other trimmed kinds" in the backend IPC
 * contract list what a row keeps. Read only those fields from a row, or read the
 * object with `resourceGet` or a single-object watch, whose rows are whole.
 */
export function rowsAreTrimmed(resource: ResourceRef): boolean {
  return TRIMMED.has(`${resource.group}/${resource.plural}`);
}

export interface ResourceListState {
  items: KubeObject[];
  /**
   * `notServed` and `forbidden` are final. They also stand for a subscribe call the
   * backend refused: `forbidden` when access was denied, `notServed` for any other
   * reason, such as a cluster that has just disconnected. `message` then holds the
   * reason, so show it rather than assuming the resource type is gone.
   */
  status: WatchStatus;
  message: string | null;
  loading: boolean;
}

const IDLE: ResourceListState = {
  items: [],
  status: "syncing",
  message: null,
  loading: false,
};

const LOADING: ResourceListState = { ...IDLE, loading: true };

/**
 * How long a list is kept after the last component using it goes away. Opening it
 * again within that time shows its rows at once, with no new subscription, so the
 * backend does not send the whole list again.
 */
export const LINGER_MS = 20_000;

/**
 * One backend subscription, shared by every component showing the same list, or the
 * same object for a single-object watch, whose rows hold 0 or 1 objects.
 */
interface Entry {
  key: string;
  clusterId: string;
  /** Always up to date. `state.items` lags behind it while the window is hidden. */
  rows: Map<string, KubeObject>;
  /** Set when `rows` changed after `state.items` was built from them. */
  changed: boolean;
  /** The keys batches added at the end of `rows`, out of the listed order. */
  added: Set<string>;
  state: ResourceListState;
  listeners: Set<() => void>;
  refs: number;
  /** Set once the backend answered; `closed` entries unsubscribe on arrival. */
  subscriptionId: string | null;
  closed: boolean;
  /**
   * Set once the backend sends nothing more: after a final status, a refused
   * subscribe or a disconnect of the cluster. Such an entry is dropped at its last
   * release, so the next component subscribes again.
   */
  ended: boolean;
  /** Drops the entry once it has had no reference for `LINGER_MS`. */
  linger: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

/** Told when an entry is added to `entries` or removed from it. */
const storeListeners = new Set<() => void>();

function notifyStore(): void {
  for (const listener of [...storeListeners]) listener();
}

function entryKey(clusterId: string, r: ResourceRef): string {
  return JSON.stringify([clusterId, r.group, r.plural]);
}

/** Never equal to a list's key, which has three parts. */
function objectEntryKey(
  clusterId: string,
  r: ResourceRef,
  namespace: string | null,
  name: string,
): string {
  return JSON.stringify([clusterId, r.group, r.plural, namespace, name]);
}

/** Starts a backend subscription that sends its events to `onEvent`. */
type Start = (onEvent: (event: WatchEvent) => void) => Promise<string>;

function notify(entry: Entry): void {
  for (const listener of [...entry.listeners]) listener();
}

function windowHidden(): boolean {
  return document.visibilityState === "hidden";
}

function keyOf(key: ObjectKey): string {
  return `${key.namespace ?? ""}/${key.name}`;
}

/**
 * The order of a snapshot: by namespace, cluster-scoped first, then name, comparing
 * code units as the core compares bytes. Keep it the same as `sorted_items` in
 * `crates/skopos-core/src/resources/hub.rs`, so an object a batch adds shows where a
 * snapshot would put it.
 */
function compareListed(a: KubeObject, b: KubeObject): number {
  const an = a.metadata.namespace ?? "";
  const bn = b.metadata.namespace ?? "";
  if (an !== bn) return an < bn ? -1 : 1;
  const { name: x } = a.metadata;
  const { name: y } = b.metadata;
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * Builds `state.items` from `rows` if they changed, and tells the components. New
 * rows are put in their place here, so batches that arrive while the window is hidden
 * are placed once. Only the new rows are sorted: the others are in order already.
 */
function publish(entry: Entry): void {
  if (entry.added.size > 0) {
    entry.rows = mergeAdded(entry.rows, entry.added, compareListed);
    entry.added.clear();
  }
  if (entry.changed) {
    entry.state = { ...entry.state, items: [...entry.rows.values()] };
    entry.changed = false;
  }
  notify(entry);
}

/**
 * Applies one event and publishes a single new state for it. While the window is
 * hidden, a batch only changes the rows, and they are published when the window
 * shows. A snapshot or a status is published at once: either is rare, a snapshot
 * ends the loading that other code waits for, and a status may report an error.
 */
function apply(entry: Entry, event: WatchEvent): void {
  switch (event.type) {
    case "snapshot": {
      entry.rows = new Map(
        (event.items as unknown as KubeObject[]).map((o) => [objectKey(o), o]),
      );
      entry.changed = true;
      entry.added.clear();
      entry.state = { ...entry.state, loading: false };
      break;
    }
    case "batch": {
      for (const key of event.deletes) entry.rows.delete(keyOf(key));
      // An update keeps its place. A Map adds a new key at the end, and the core sends
      // a batch in no order, so new objects are put in the snapshot's order.
      for (const o of event.upserts as unknown as KubeObject[]) {
        const key = objectKey(o);
        if (!entry.rows.has(key)) entry.added.add(key);
        entry.rows.set(key, o);
      }
      entry.changed = true;
      if (windowHidden()) return;
      break;
    }
    case "status": {
      const final =
        event.status === "notServed" || event.status === "forbidden";
      entry.state = {
        ...entry.state,
        status: event.status,
        message: event.message,
        loading: final ? false : entry.state.loading,
      };
      publish(entry);
      // The backend ends a subscription after its final status.
      if (final) end(entry);
      return;
    }
  }
  publish(entry);
}

/** Publishes the rows that batches changed while the window was hidden. */
function onVisibility(): void {
  if (windowHidden()) return;
  for (const entry of entries.values()) {
    if (entry.changed) publish(entry);
  }
}

function statusesOf(): Map<string, string> {
  return new Map(
    useCatalog.getState().clusters.map((c) => [c.id, c.state.status] as const),
  );
}

let listening = false;

/**
 * Starts with the first list and lasts for the store's whole life. A disconnect
 * ends every subscription of the cluster without an event, so its entries are
 * marked ended here, and the next list after a reconnect subscribes again.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", onVisibility);
  let statuses = statusesOf();
  useCatalog.subscribe(() => {
    const before = statuses;
    statuses = statusesOf();
    for (const [clusterId, status] of before) {
      if (status !== "connected" || statuses.get(clusterId) === "connected") {
        continue;
      }
      for (const entry of [...entries.values()]) {
        if (entry.clusterId === clusterId) end(entry);
      }
    }
  });
}

function open(key: string, clusterId: string, start: Start): Entry {
  listen();
  const entry: Entry = {
    key,
    clusterId,
    rows: new Map(),
    changed: false,
    added: new Set(),
    state: LOADING,
    listeners: new Set(),
    refs: 0,
    subscriptionId: null,
    closed: false,
    ended: false,
    linger: null,
  };
  start((event) => {
    if (!entry.closed) apply(entry, event);
  }).then(
    (id) => {
      entry.subscriptionId = id;
      if (entry.closed) void api.resourcesUnsubscribe(id).catch(() => {});
    },
    (error) => {
      if (entry.closed) return;
      entry.state = {
        ...entry.state,
        status:
          error instanceof IpcFailure && error.code === "Forbidden"
            ? "forbidden"
            : "notServed",
        message: failureMessage(error),
        loading: false,
      };
      publish(entry);
      end(entry);
    },
  );
  return entry;
}

/** Unsubscribes and forgets the entry. */
function drop(entry: Entry): void {
  if (entry.linger !== null) clearTimeout(entry.linger);
  entry.linger = null;
  entry.closed = true;
  if (entry.subscriptionId !== null) {
    void api.resourcesUnsubscribe(entry.subscriptionId).catch(() => {});
  }
  if (entries.get(entry.key) === entry) {
    entries.delete(entry.key);
    notifyStore();
  }
}

/** Marks the entry ended, and drops it now if nothing uses it. */
function end(entry: Entry): void {
  entry.ended = true;
  if (entry.refs === 0 && !entry.closed) drop(entry);
}

function acquire(key: string, clusterId: string, start: Start): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = open(key, clusterId, start);
    entries.set(key, entry);
    notifyStore();
  }
  if (entry.linger !== null) {
    clearTimeout(entry.linger);
    entry.linger = null;
  }
  entry.refs += 1;
  return entry;
}

/**
 * At the last release, keeps a live entry for `LINGER_MS`. An ended entry, or one a
 * test reset closed, is dropped at once.
 */
function release(entry: Entry): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (entry.ended || entry.closed) {
    drop(entry);
    return;
  }
  entry.linger = setTimeout(() => {
    entry.linger = null;
    drop(entry);
  }, LINGER_MS);
}

/**
 * Holds the entry of `key` while the component uses it, starting its subscription
 * with `start` if the store has none, and returns its state.
 */
function useEntry(
  key: string | null,
  clusterId: string,
  start: Start | null,
): ResourceListState {
  // The effect depends on the identity in `key`, so it reads the latest props from a ref.
  const latest = useRef({ clusterId, start });
  latest.current = { clusterId, start };
  const [entry, setEntry] = useState<Entry | null>(null);

  useEffect(() => {
    const { clusterId: cluster, start: begin } = latest.current;
    if (key === null || begin === null) {
      setEntry(null);
      return;
    }
    const acquired = acquire(key, cluster, begin);
    setEntry(acquired);
    return () => release(acquired);
  }, [key]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!entry) return () => {};
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [entry],
  );
  const snapshot = useCallback(() => entry?.state ?? IDLE, [entry]);
  const shown = useSyncExternalStore(subscribe, snapshot);
  if (key === null) return IDLE;
  // Until the effect has run for this key, `entry` is the previous list, whose rows
  // belong to another cluster or resource, so they are never returned here.
  const current = entries.get(key);
  return current === entry ? shown : (current?.state ?? LOADING);
}

/**
 * The live objects of a resource. One subscription is kept per cluster, group and
 * plural, and ended `LINGER_MS` after the last component using it goes away.
 */
export function useResourceList(
  clusterId: string,
  resource: ResourceRef | null,
): ResourceListState {
  return useEntry(
    resource ? entryKey(clusterId, resource) : null,
    clusterId,
    resource
      ? (onEvent) => api.resourcesSubscribe(clusterId, resource, onEvent)
      : null,
  );
}

/**
 * One object, live, from a single-object watch ("Single-object watch" in the backend
 * IPC contract): `items` holds the object while it exists. Its rows are whole, even
 * for a kind whose list rows are trimmed. One subscription is kept per cluster,
 * resource, namespace and name, and ended `LINGER_MS` after the last component using
 * it goes away. `namespace` is sent only for a namespaced resource, as the backend
 * refuses one that does not match the resource's scope.
 */
export function useObjectWatch(
  clusterId: string,
  resource: ResourceRef | null,
  namespace: string | null,
  name: string | null,
): ResourceListState {
  const scoped = resource?.namespaced ? namespace : null;
  const wanted = resource !== null && name !== null;
  return useEntry(
    wanted ? objectEntryKey(clusterId, resource, scoped, name) : null,
    clusterId,
    wanted
      ? (onEvent) =>
          api.resourcesSubscribeObject(
            clusterId,
            resource,
            scoped,
            name,
            onEvent,
          )
      : null,
  );
}

/**
 * The state of the list of a resource that the store already has, because a
 * component uses it or it lingers, read without holding it: null when there is none,
 * and again once it is dropped. It never starts a subscription.
 */
export function useHeldList(
  clusterId: string,
  resource: ResourceRef | null,
): ResourceListState | null {
  const key = resource ? entryKey(clusterId, resource) : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key === null) return () => {};
      // Follows the entry of `key` as the store adds and drops it.
      let followed: Entry | undefined;
      const follow = () => {
        const next = entries.get(key);
        if (next === followed) return;
        followed?.listeners.delete(listener);
        followed = next;
        followed?.listeners.add(listener);
      };
      const onStore = () => {
        follow();
        listener();
      };
      storeListeners.add(onStore);
      follow();
      return () => {
        storeListeners.delete(onStore);
        followed?.listeners.delete(listener);
      };
    },
    [key],
  );
  const snapshot = useCallback(
    () => (key === null ? null : (entries.get(key)?.state ?? null)),
    [key],
  );
  return useSyncExternalStore(subscribe, snapshot);
}

export function findResource(
  resources: ApiResourceInfo[],
  group: string,
  plural: string,
): ApiResourceInfo | undefined {
  return resources.find(
    (r) => r.resource.group === group && r.resource.plural === plural,
  );
}

export function resetResourcesForTest(): void {
  for (const entry of entries.values()) {
    if (entry.linger !== null) clearTimeout(entry.linger);
    entry.linger = null;
    entry.closed = true;
    entry.listeners.clear();
  }
  entries.clear();
}
