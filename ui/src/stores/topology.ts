import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { TopologySnapshot } from "../ipc/generated/TopologySnapshot";
import { LINGER_MS } from "./resources";

/** One cluster's node topology (topology spec §4.3). */
export interface TopologyEntry {
  /** The last snapshot. A failure keeps it, and so does a retry until the next one. */
  snapshot: TopologySnapshot | null;
  error: string | null;
  loading: boolean;
}

interface TopologyState {
  /** By cluster id. */
  entries: Record<string, TopologyEntry>;
}

export const useTopologyStore = create<TopologyState>(() => ({ entries: {} }));

const LOADING: TopologyEntry = { snapshot: null, error: null, loading: true };
const IDLE: TopologyEntry = { snapshot: null, error: null, loading: false };

/** One backend subscription, shared by every watcher of a cluster. */
interface Watch {
  clusterId: string;
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

function patch(clusterId: string, change: Partial<TopologyEntry>): void {
  useTopologyStore.setState((s) => ({
    entries: {
      ...s.entries,
      [clusterId]: { ...(s.entries[clusterId] ?? LOADING), ...change },
    },
  }));
}

function endSubscription(watch: Watch): void {
  const id = watch.subscriptionId;
  watch.subscriptionId = null;
  if (id !== null) void api.nodeTopologyUnsubscribe(id).catch(() => {});
}

/** Ends the watch's subscription and forgets its entry. */
function drop(watch: Watch): void {
  if (watches.get(watch.clusterId) === watch) watches.delete(watch.clusterId);
  if (watch.linger !== null) clearTimeout(watch.linger);
  watch.linger = null;
  watch.generation += 1;
  endSubscription(watch);
  useTopologyStore.setState((s) => {
    const entries = { ...s.entries };
    delete entries[watch.clusterId];
    return { entries };
  });
}

function subscribe(watch: Watch): void {
  watch.generation += 1;
  const mine = watch.generation;
  const { clusterId } = watch;
  const current = () =>
    watches.get(clusterId) === watch && watch.generation === mine;
  // A failure ends the subscription on the backend, so there is nothing to end here.
  let ended = false;
  watch.failed = false;
  patch(clusterId, { error: null, loading: true });
  api
    .nodeTopologySubscribe(clusterId, (event) => {
      if (!current()) return;
      if (event.type === "snapshot") {
        patch(clusterId, {
          snapshot: event.snapshot,
          error: null,
          loading: false,
        });
        return;
      }
      ended = true;
      watch.failed = true;
      watch.subscriptionId = null;
      patch(clusterId, { error: event.message, loading: false });
      // Failed while lingering: nobody is left to retry it.
      if (watch.count === 0) drop(watch);
    })
    .then(
      (id) => {
        if (!current()) {
          void api.nodeTopologyUnsubscribe(id).catch(() => {});
        } else if (!ended) {
          watch.subscriptionId = id;
        }
      },
      (error) => {
        if (!current()) return;
        watch.failed = true;
        patch(clusterId, { error: failureMessage(error), loading: false });
      },
    );
}

/**
 * Watches a cluster's node topology. The first watcher subscribes. When the last one
 * leaves, the subscription and its snapshot stay for `LINGER_MS`, so going back to the
 * page shows them at once; a failed subscription is dropped at once. Returns the function
 * that leaves; calling it again does nothing.
 */
export function watchTopology(clusterId: string): () => void {
  let watch = watches.get(clusterId);
  if (!watch) {
    watch = {
      clusterId,
      count: 0,
      generation: 0,
      subscriptionId: null,
      linger: null,
      failed: false,
    };
    watches.set(clusterId, watch);
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

/** Subscribes a watched cluster again, after a failure or a refused subscribe. */
export function retryTopology(clusterId: string): void {
  const watch = watches.get(clusterId);
  if (!watch) return;
  endSubscription(watch);
  subscribe(watch);
}

/**
 * The node topology of a cluster for a component, watched while it is mounted; `retry`
 * subscribes again. A null cluster watches nothing.
 */
export function useTopology(
  clusterId: string | null,
): TopologyEntry & { retry(): void } {
  useEffect(() => {
    if (clusterId === null) return;
    return watchTopology(clusterId);
  }, [clusterId]);
  const entry = useTopologyStore((s) =>
    clusterId === null ? undefined : s.entries[clusterId],
  );
  const retry = useCallback(() => {
    if (clusterId !== null) retryTopology(clusterId);
  }, [clusterId]);
  return { ...(entry ?? (clusterId === null ? IDLE : LOADING)), retry };
}

export function resetTopologyForTest(): void {
  for (const watch of watches.values()) {
    watch.generation += 1;
    if (watch.linger !== null) clearTimeout(watch.linger);
  }
  watches.clear();
  useTopologyStore.setState({ entries: {} });
}
