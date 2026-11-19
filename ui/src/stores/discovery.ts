import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../kinds/objects";
import { findResource, useResourceList } from "./resources";

export interface DiscoveryState {
  resources: ApiResourceInfo[];
  loading: boolean;
  error: string | null;
}

export interface Discovery extends DiscoveryState {
  /** Asks the backend again, past its cache. Resolves once the answer is shown. */
  refresh(): Promise<void>;
}

const LOADING: DiscoveryState = { resources: [], loading: true, error: null };

/** How long to wait before each new look at a discovery that lags the definitions. */
export const REDISCOVER_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/**
 * The discovery of one cluster, shared by every component that reads it. It is kept
 * while one of them is mounted and dropped when the last one goes.
 */
interface Entry {
  clusterId: string;
  state: DiscoveryState;
  listeners: Set<() => void>;
  refs: number;
  closed: boolean;
  /** The one request in flight for this cluster, if any. */
  inFlight: Promise<void> | null;
  /** A refresh asked for while a request was in flight: it runs once that ends. */
  queued: { done: Promise<void>; resolve(): void } | null;
  /** The custom resource definitions last seen, or null while they are unknown. */
  definitions: KubeObject[] | null;
  /** Their sorted names, kept while the list reloads, to tell a change. */
  names: string | null;
  /** Every `group/plural` a definition served while this entry lived. */
  defined: Set<string>;
  /** The resources discovery lags on, and the looks taken at them so far. */
  behind: string;
  looks: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

function publish(entry: Entry, state: DiscoveryState): void {
  entry.state = state;
  for (const listener of [...entry.listeners]) listener();
}

/** Asks the backend, unless a request is in flight: at most one runs per cluster. */
function load(entry: Entry, refresh: boolean): Promise<void> {
  if (entry.closed) return Promise.resolve();
  if (entry.inFlight === null) return start(entry, refresh);
  // A plain load takes the answer on its way. A refresh needs a request sent after
  // it was asked for, so one more runs when this one ends, for all who asked.
  if (!refresh) return entry.inFlight;
  if (entry.queued === null) {
    let resolve = () => {};
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    entry.queued = { done, resolve };
  }
  return entry.queued.done;
}

function start(entry: Entry, refresh: boolean): Promise<void> {
  publish(entry, { ...entry.state, loading: true, error: null });
  const request = api.resourcesDiscover(entry.clusterId, refresh).then(
    (resources): DiscoveryState => ({ resources, loading: false, error: null }),
    // A failed refresh keeps what the last answer showed.
    (error): DiscoveryState => ({
      resources: entry.state.resources,
      loading: false,
      error: failureMessage(error),
    }),
  );
  const inFlight = request.then((answer) => {
    entry.inFlight = null;
    if (entry.closed) return;
    const queued = entry.queued;
    if (queued !== null) {
      // Shown with the next answer, so the readers see one load, not two.
      entry.queued = null;
      entry.state = answer;
      void start(entry, true).then(queued.resolve);
      return;
    }
    publish(entry, answer);
    lookAgain(entry);
  });
  entry.inFlight = inFlight;
  return inFlight;
}

/** The `group/plural` a custom resource definition serves. */
function definedResource(crd: KubeObject): string {
  return `${crd.spec?.group}/${crd.spec?.names?.plural}`;
}

function isEstablished(crd: KubeObject): boolean {
  const conditions: { type?: string; status?: string }[] =
    crd.status?.conditions ?? [];
  return conditions.some(
    (c) => c.type === "Established" && c.status === "True",
  );
}

/**
 * The resources whose discovery lags their definitions: established but not served,
 * or served after their definition was deleted.
 */
function lagging(entry: Entry): string {
  const { definitions } = entry;
  if (definitions === null) return "";
  const served = new Set(
    entry.state.resources.map(
      (r) => `${r.resource.group}/${r.resource.plural}`,
    ),
  );
  const defined = new Set(definitions.map(definedResource));
  const missing = definitions
    .filter(isEstablished)
    .map(definedResource)
    .filter((resource) => !served.has(resource));
  const stale = [...entry.defined].filter(
    (resource) => !defined.has(resource) && served.has(resource),
  );
  return [...missing, ...stale].sort().join("\n");
}

function stopLooking(entry: Entry): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
}

/**
 * The API server serves a new definition, and stops serving a deleted one, some time
 * after the watch says so. So while discovery lags, it is asked again after each of
 * the delays in turn, each answer arming the next look, until it agrees.
 */
function lookAgain(entry: Entry): void {
  const behind = lagging(entry);
  if (entry.behind !== behind) {
    entry.behind = behind;
    entry.looks = 0;
  }
  stopLooking(entry);
  const delay = REDISCOVER_DELAYS_MS[entry.looks];
  if (behind === "" || delay === undefined) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.looks += 1;
    void load(entry, true);
  }, delay);
}

/**
 * Takes the custom resource definitions a reader watches. Every reader sees the same
 * shared list, so the first to pass a new one acts on it and the rest find it known.
 */
function noteDefinitions(entry: Entry, definitions: KubeObject[] | null): void {
  if (entry.closed || entry.definitions === definitions) return;
  entry.definitions = definitions;
  if (definitions !== null) {
    for (const crd of definitions) entry.defined.add(definedResource(crd));
    const names = definitions
      .map((o) => o.metadata.name)
      .sort()
      .join("\n");
    const previous = entry.names;
    entry.names = names;
    if (previous !== null && previous !== names) void load(entry, true);
  }
  lookAgain(entry);
}

function acquire(clusterId: string): Entry {
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = {
      clusterId,
      state: LOADING,
      listeners: new Set(),
      refs: 0,
      closed: false,
      inFlight: null,
      queued: null,
      definitions: null,
      names: null,
      defined: new Set(),
      behind: "",
      looks: 0,
      timer: null,
    };
    entries.set(clusterId, entry);
    void start(entry, false);
  } else if (entry.state.error !== null) {
    // A reader that arrives after a failure asks again, as it did on its own.
    void load(entry, false);
  }
  entry.refs += 1;
  return entry;
}

function close(entry: Entry): void {
  entry.closed = true;
  stopLooking(entry);
  entry.queued?.resolve();
  entry.queued = null;
  entry.listeners.clear();
  if (entries.get(entry.clusterId) === entry) entries.delete(entry.clusterId);
}

function release(entry: Entry): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  // A reader that replaces this one in the same commit, as a keyed remount or Strict
  // Mode's second mount does, keeps the entry rather than asking again.
  queueMicrotask(() => {
    if (entry.refs === 0 && !entry.closed) close(entry);
  });
}

/**
 * The resources a cluster serves. Every component reading a cluster shares one
 * discovery, with at most one request in flight. It is not looked at again when the
 * custom resource definitions change unless a `useClusterResources` reader is mounted.
 */
export function useDiscovery(clusterId: string): Discovery {
  const [entry, setEntry] = useState<Entry | null>(null);

  useEffect(() => {
    const acquired = acquire(clusterId);
    setEntry(acquired);
    return () => release(acquired);
  }, [clusterId]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!entry) return () => {};
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [entry],
  );
  const snapshot = useCallback(() => entry?.state ?? LOADING, [entry]);
  const shown = useSyncExternalStore(subscribe, snapshot);
  const refresh = useCallback(() => {
    const current = entries.get(clusterId);
    return current ? load(current, true) : Promise.resolve();
  }, [clusterId]);
  // Until the effect has run for this cluster, `entry` is the previous cluster's,
  // whose resources are never returned here.
  const current = entries.get(clusterId);
  const state = current === entry ? shown : (current?.state ?? LOADING);
  return { ...state, refresh };
}

/**
 * The served resources of a cluster, looked at again when its custom resource
 * definitions change, so new custom resources appear in the sidebar. Every reader
 * watches the same shared definition list, and the cluster's discovery acts on each
 * change once, with one schedule of further looks, however many readers there are.
 */
export function useClusterResources(clusterId: string): Discovery {
  const discovery = useDiscovery(clusterId);
  const crd = findResource(
    discovery.resources,
    "apiextensions.k8s.io",
    "customresourcedefinitions",
  );
  const ref = useMemo(
    () => (crd?.canList && crd.canWatch ? crd.resource : null),
    [crd],
  );
  const list = useResourceList(clusterId, ref);
  const definitions = ref === null || list.loading ? null : list.items;
  useEffect(() => {
    const entry = entries.get(clusterId);
    if (entry) noteDefinitions(entry, definitions);
  }, [clusterId, definitions]);
  return discovery;
}

export function resetDiscoveryForTest(): void {
  for (const entry of entries.values()) close(entry);
  entries.clear();
}
