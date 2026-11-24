import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { ReachEvent } from "../ipc/generated/ReachEvent";
import { useCatalog } from "./catalog";
import { LINGER_MS } from "./resources";

/** What the core sends for one namespace (network policies spec §7.3). */
export type ReachSnapshot = Extract<ReachEvent, { type: "snapshot" }>;

/** One namespace's reachability (network policies spec §3.2). */
export interface ReachEntry {
  /** The last snapshot. A failure keeps it, and so does a retry until the next one. */
  snapshot: ReachSnapshot | null;
  error: string | null;
  loading: boolean;
}

interface ReachabilityState {
  /** By `reachKey(clusterId, namespace)`. */
  entries: Record<string, ReachEntry>;
}

export const useReachabilityStore = create<ReachabilityState>(() => ({
  entries: {},
}));

const LOADING: ReachEntry = { snapshot: null, error: null, loading: true };

/** The key of a (cluster, namespace) pair; a newline is in neither. */
export function reachKey(clusterId: string, namespace: string): string {
  return `${clusterId}\n${namespace}`;
}

/** One backend subscription, shared by every watcher of a cluster's namespace. */
interface Watch {
  key: string;
  clusterId: string;
  namespace: string;
  count: number;
  /** Bumped by each subscribe and by the drop, so late events and ids are dropped. */
  generation: number;
  /** Set once the backend answered, and cleared when the subscription ends. */
  subscriptionId: string | null;
  /** Drops the watch once the last watcher has been gone for `LINGER_MS`. */
  linger: ReturnType<typeof setTimeout> | null;
  /** The last answer was a failure: nothing is left to keep, so leaving drops it at once. */
  failed: boolean;
}

const watches = new Map<string, Watch>();

function patch(key: string, change: Partial<ReachEntry>): void {
  useReachabilityStore.setState((s) => ({
    entries: {
      ...s.entries,
      [key]: { ...(s.entries[key] ?? LOADING), ...change },
    },
  }));
}

function endSubscription(watch: Watch): void {
  const id = watch.subscriptionId;
  watch.subscriptionId = null;
  if (id !== null) void api.networkReachabilityUnsubscribe(id).catch(() => {});
}

/** Ends the watch's subscription and forgets its entry. */
function drop(watch: Watch): void {
  if (watches.get(watch.key) === watch) watches.delete(watch.key);
  if (watch.linger !== null) clearTimeout(watch.linger);
  watch.linger = null;
  watch.generation += 1;
  endSubscription(watch);
  useReachabilityStore.setState((s) => {
    const entries = { ...s.entries };
    delete entries[watch.key];
    return { entries };
  });
}

function subscribe(watch: Watch): void {
  watch.generation += 1;
  const mine = watch.generation;
  const { key, clusterId, namespace } = watch;
  const current = () => watches.get(key) === watch && watch.generation === mine;
  // A failure ends the subscription on the backend, so there is nothing to end here.
  let ended = false;
  watch.failed = false;
  patch(key, { error: null, loading: true });
  api
    .networkReachabilitySubscribe(clusterId, namespace, (event) => {
      if (!current()) return;
      if (event.type === "snapshot") {
        // Only this namespace's snapshots belong here (spec §7.3).
        if (event.namespace !== namespace) return;
        patch(key, { snapshot: event, error: null, loading: false });
        return;
      }
      ended = true;
      watch.failed = true;
      watch.subscriptionId = null;
      patch(key, { error: event.message, loading: false });
      // Failed while lingering: nobody is left to retry it.
      if (watch.count === 0) drop(watch);
    })
    .then(
      (id) => {
        if (!current()) {
          void api.networkReachabilityUnsubscribe(id).catch(() => {});
        } else if (!ended) {
          watch.subscriptionId = id;
        }
      },
      (error) => {
        if (!current()) return;
        watch.failed = true;
        patch(key, { error: failureMessage(error), loading: false });
      },
    );
}

/**
 * Watches a namespace's reachability. The first watcher of a (cluster, namespace) pair
 * subscribes. When the last one leaves, the subscription and its snapshot stay for
 * `LINGER_MS`, so going back shows them at once; a failed subscription is dropped at once.
 * Returns the function that leaves; calling it again does nothing.
 */
export function watchReachability(
  clusterId: string,
  namespace: string,
): () => void {
  listen();
  const key = reachKey(clusterId, namespace);
  let watch = watches.get(key);
  if (!watch) {
    watch = {
      key,
      clusterId,
      namespace,
      count: 0,
      generation: 0,
      subscriptionId: null,
      linger: null,
      failed: false,
    };
    watches.set(key, watch);
    subscribe(watch);
  }
  if (watch.linger !== null) {
    clearTimeout(watch.linger);
    watch.linger = null;
  }
  watch.count += 1;
  const mine = watch;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mine.count -= 1;
    if (mine.count > 0) return;
    if (mine.failed) {
      drop(mine);
      return;
    }
    mine.linger = setTimeout(() => {
      mine.linger = null;
      if (mine.count === 0) drop(mine);
    }, LINGER_MS);
  };
}

let listening = false;

function statusesOf(): Map<string, string> {
  return new Map(
    useCatalog.getState().clusters.map((c) => [c.id, c.state.status] as const),
  );
}

/**
 * A disconnect ends the backend subscriptions without an event. A lingering watch of that
 * cluster is dropped, so a quick reconnect subscribes again; a watched one is marked
 * failed, so its page shows the error and Retry.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  let statuses = statusesOf();
  useCatalog.subscribe(() => {
    const before = statuses;
    statuses = statusesOf();
    for (const [clusterId, status] of before) {
      if (status !== "connected" || statuses.get(clusterId) === "connected") {
        continue;
      }
      for (const watch of [...watches.values()]) {
        if (watch.clusterId !== clusterId) continue;
        if (watch.count === 0) {
          drop(watch);
          continue;
        }
        watch.generation += 1;
        watch.failed = true;
        endSubscription(watch);
        patch(watch.key, { error: "Cluster disconnected", loading: false });
      }
    }
  });
}

/** Subscribes a watched namespace again, after a failure or a refused subscribe. */
export function retryReachability(clusterId: string, namespace: string): void {
  const watch = watches.get(reachKey(clusterId, namespace));
  if (!watch) return;
  endSubscription(watch);
  subscribe(watch);
}

/**
 * The reachability of a cluster's namespace for a component, watched while it is mounted.
 * A new pair leaves the old one, whose late events and ids are then dropped (spec §3.2).
 */
export function useReachability(
  clusterId: string,
  namespace: string,
): ReachEntry {
  useEffect(
    () => watchReachability(clusterId, namespace),
    [clusterId, namespace],
  );
  const entry = useReachabilityStore(
    (s) => s.entries[reachKey(clusterId, namespace)],
  );
  return entry ?? LOADING;
}

export function resetReachabilityForTest(): void {
  for (const watch of watches.values()) {
    watch.generation += 1;
    if (watch.linger !== null) clearTimeout(watch.linger);
  }
  watches.clear();
  useReachabilityStore.setState({ entries: {} });
}
