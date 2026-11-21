import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { WatchEvent } from "../ipc/generated/WatchEvent";
import type { KubeObject } from "../kinds/objects";
import { flush, mockBackend } from "../test/ipc";
import { CONNECTED, connectClusters, setClusterState } from "../test/terminal";
import { resetCatalogForTest } from "./catalog";
import {
  findResource,
  LINGER_MS,
  type ResourceListState,
  resetResourcesForTest,
  rowsAreTrimmed,
  useHeldList,
  useNodePods,
  useObjectWatch,
  useResourceList,
} from "./resources";

const pods: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};

function pod(name: string, namespace = "default", rv = "1"): KubeObject {
  return { metadata: { name, namespace, resourceVersion: rv } };
}

interface Sub {
  clusterId: string;
  resource: ResourceRef;
  send(event: WatchEvent): Promise<void>;
}

function setup() {
  const subs: Sub[] = [];
  const backend = mockBackend({
    resources_subscribe: (args: {
      clusterId: string;
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.push({
        clusterId: args.clusterId,
        resource: args.resource,
        send: async (event) => {
          await act(async () => {
            args.onEvent.onmessage(event);
            await flush();
          });
        },
      });
      return `sub-${subs.length}`;
    },
    resources_unsubscribe: () => null,
  });
  return { subs, backend };
}

const snapshot = (...items: KubeObject[]): WatchEvent => ({
  type: "snapshot",
  items,
});
const status = (
  s: "syncing" | "live" | "reconnecting" | "notServed" | "forbidden",
  message: string | null = null,
): WatchEvent => ({ type: "status", status: s, message });

beforeEach(() => resetResourcesForTest());
afterEach(() => {
  resetResourcesForTest();
  resetCatalogForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Fakes the clock, so a test can pass the linger at once. The fake clock still
 * follows real time, so `flush` keeps working.
 */
function fakeClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
}

/** Makes the window hidden until `show` is called. */
function hideWindow(): { show(): Promise<void> } {
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  return {
    async show() {
      visibility.mockReturnValue("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await flush();
      });
    },
  };
}

async function mount(clusterId = "a", resource: ResourceRef | null = pods) {
  const hook = renderHook(
    (props: { c: string; r: ResourceRef | null }) =>
      useResourceList(props.c, props.r),
    { initialProps: { c: clusterId, r: resource } },
  );
  await act(flush);
  return hook;
}

test("snapshot replaces items, batch applies upserts and deletes", async () => {
  const { subs } = setup();
  const { result } = await mount();
  expect(result.current.loading).toBe(true);
  expect(result.current.items).toEqual([]);

  await subs[0].send(snapshot(pod("a"), pod("b")));
  expect(result.current.loading).toBe(false);
  expect(result.current.items.map((o) => o.metadata.name)).toEqual(["a", "b"]);

  await subs[0].send({
    type: "batch",
    upserts: [pod("b", "default", "2"), pod("c")],
    deletes: [{ namespace: "default", name: "a" }],
  });
  const names = result.current.items.map((o) => o.metadata.name).sort();
  expect(names).toEqual(["b", "c"]);
  expect(
    result.current.items.find((o) => o.metadata.name === "b")?.metadata
      .resourceVersion,
  ).toBe("2");
});

test("objects_with_same_name_in_two_namespaces_stay_separate", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("web", "x"), pod("web", "y")));
  expect(result.current.items).toHaveLength(2);

  await subs[0].send({
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "x", name: "web" }],
  });
  expect(result.current.items.map((o) => o.metadata.namespace)).toEqual(["y"]);
});

test("cluster-scoped delete matches a null namespace", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot({ metadata: { name: "node-1" } }));
  await subs[0].send({
    type: "batch",
    upserts: [],
    deletes: [{ namespace: null, name: "node-1" }],
  });
  expect(result.current.items).toEqual([]);
});

const keysOf = (items: KubeObject[]) =>
  items.map((o) => `${o.metadata.namespace ?? ""}/${o.metadata.name}`);

test("a batch lists a new object where a snapshot would: by namespace, then name", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(
    snapshot(
      pod("web-aaaaa", "app"),
      pod("coredns", "kube-system"),
      pod("other", "zz"),
    ),
  );
  await subs[0].send({
    type: "batch",
    upserts: [pod("web-bbbbb", "app")],
    deletes: [{ namespace: "app", name: "web-aaaaa" }],
  });
  expect(keysOf(result.current.items)).toEqual([
    "app/web-bbbbb",
    "kube-system/coredns",
    "zz/other",
  ]);
});

test("an object deleted and re-created in two batches keeps its place", async () => {
  const { subs } = setup();
  const { result } = await mount();
  const db = (uid: string): KubeObject => ({
    metadata: { name: "db-0", namespace: "app", resourceVersion: "1", uid },
  });
  await subs[0].send(snapshot(db("old"), pod("web", "app"), pod("x", "zz")));
  await subs[0].send({
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "app", name: "db-0" }],
  });
  await subs[0].send({ type: "batch", upserts: [db("new")], deletes: [] });
  expect(keysOf(result.current.items)).toEqual(["app/db-0", "app/web", "zz/x"]);
  expect(result.current.items[0].metadata.uid).toBe("new");
});

test("several new objects in one batch are listed in order", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot());
  await subs[0].send({
    type: "batch",
    upserts: [pod("x", "b"), pod("y", "a")],
    deletes: [],
  });
  expect(keysOf(result.current.items)).toEqual(["a/y", "b/x"]);
});

test("an update of an existing object keeps its place", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("a"), pod("b"), pod("c")));
  await subs[0].send({
    type: "batch",
    upserts: [pod("a", "default", "2")],
    deletes: [],
  });
  expect(keysOf(result.current.items)).toEqual([
    "default/a",
    "default/b",
    "default/c",
  ]);
  expect(result.current.items[0].metadata.resourceVersion).toBe("2");
});

test("cluster-scoped objects are ordered by name", async () => {
  const { subs } = setup();
  const { result } = await mount();
  const node = (name: string): KubeObject => ({ metadata: { name } });
  await subs[0].send(snapshot(node("node-a"), node("node-c")));
  await subs[0].send({
    type: "batch",
    upserts: [node("node-b"), node("Node-z")],
    deletes: [],
  });
  // Plain code units, as the core compares bytes: upper case sorts before lower.
  expect(keysOf(result.current.items)).toEqual([
    "/Node-z",
    "/node-a",
    "/node-b",
    "/node-c",
  ]);
});

test("clusters_do_not_share_rows", async () => {
  const { subs } = setup();
  const first = await mount("a");
  await subs[0].send(snapshot(pod("only-in-a")));
  const second = await mount("b");
  expect(subs).toHaveLength(2);
  await subs[1].send(snapshot(pod("only-in-b")));

  expect(first.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-a",
  ]);
  expect(second.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-b",
  ]);

  // A route change on one component from cluster a to b shows b's rows at once.
  first.rerender({ c: "b", r: pods });
  expect(first.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-b",
  ]);
  // Back on a, a's kept list shows its own rows at once, and none of b's.
  first.rerender({ c: "a", r: pods });
  expect(first.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-a",
  ]);
  await act(flush);
  expect(first.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-a",
  ]);
  expect(subs).toHaveLength(2);
});

/** Keeps the state of every render, including those before the effects run. */
function recordRenders(initial: string) {
  const renders: ResourceListState[] = [];
  const hook = renderHook(
    ({ c }: { c: string }) => {
      const state = useResourceList(c, pods);
      renders.push(state);
      return state;
    },
    { initialProps: { c: initial } },
  );
  return { renders, hook };
}

test("changing to a list nobody has open never renders the old rows", async () => {
  const { subs } = setup();
  const { renders, hook } = recordRenders("a");
  await act(flush);
  await subs[0].send(snapshot(pod("only-in-a")));
  renders.length = 0;

  hook.rerender({ c: "never-opened" });

  expect(renders.length).toBeGreaterThan(0);
  for (const state of renders) {
    expect(state.items).toEqual([]);
    expect(state.loading).toBe(true);
  }
});

test("the first render of a list is loading, not an empty list", async () => {
  setup();
  const { renders } = recordRenders("a");
  await act(flush);
  expect(renders[0].items).toEqual([]);
  expect(renders[0].loading).toBe(true);
});

test("two components share one subscription and unsubscribe a linger after the last unmount", async () => {
  fakeClock();
  const { subs, backend } = setup();
  const one = await mount();
  const two = await mount();
  expect(subs).toHaveLength(1);
  expect(backend.callsTo("resources_subscribe")).toHaveLength(1);

  await subs[0].send(snapshot(pod("a")));
  expect(two.result.current.items).toHaveLength(1);

  one.unmount();
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([]);

  two.unmount();
  await act(flush);
  vi.advanceTimersByTime(LINGER_MS - 1_000);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([]);
  vi.advanceTimersByTime(1_000);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);
});

test("a list opened again within the linger reuses its subscription and never shows loading", async () => {
  fakeClock();
  const { subs, backend } = setup();
  const first = await mount();
  await subs[0].send(snapshot(pod("a")));
  await subs[0].send(status("live"));
  first.unmount();
  await act(flush);
  vi.advanceTimersByTime(LINGER_MS - 1_000);

  const { renders } = recordRenders("a");
  await act(flush);
  expect(backend.callsTo("resources_subscribe")).toHaveLength(1);
  expect(renders.length).toBeGreaterThan(0);
  for (const state of renders) {
    expect(state.loading).toBe(false);
    expect(state.status).toBe("live");
    expect(state.items.map((o) => o.metadata.name)).toEqual(["a"]);
  }

  // The kept subscription goes on delivering, and the new reference ends the linger.
  await subs[0].send({ type: "batch", upserts: [pod("b")], deletes: [] });
  expect(renders.at(-1)?.items.map((o) => o.metadata.name)).toEqual(["a", "b"]);
  vi.advanceTimersByTime(LINGER_MS);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([]);
});

test("a list opened after the linger subscribes again and loads", async () => {
  fakeClock();
  const { subs, backend } = setup();
  const first = await mount();
  await subs[0].send(snapshot(pod("a")));
  first.unmount();
  await act(flush);
  vi.advanceTimersByTime(LINGER_MS);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);

  const second = await mount();
  expect(subs).toHaveLength(2);
  expect(second.result.current.loading).toBe(true);
  expect(second.result.current.items).toEqual([]);
});

test("a list that ended with a final status is dropped on its last unmount", async () => {
  fakeClock();
  const { subs, backend } = setup();
  const first = await mount();
  await subs[0].send(status("forbidden", "cannot list pods"));
  first.unmount();
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);

  const second = await mount();
  expect(subs).toHaveLength(2);
  expect(second.result.current.loading).toBe(true);
  expect(second.result.current.status).toBe("syncing");
});

test("a final status that arrives during the linger drops the list", async () => {
  fakeClock();
  const { subs, backend } = setup();
  const first = await mount();
  await subs[0].send(snapshot(pod("a")));
  first.unmount();
  await act(flush);
  await subs[0].send(status("notServed", "the server has no pods"));
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);

  const second = await mount();
  expect(subs).toHaveLength(2);
  expect(second.result.current.loading).toBe(true);
});

test("a refused subscribe is tried again on the next mount", async () => {
  fakeClock();
  let refuse = true;
  const backend = mockBackend({
    resources_subscribe: () => {
      if (refuse) throw { code: "Forbidden", message: "pods is forbidden" };
      return "sub-ok";
    },
    resources_unsubscribe: () => null,
  });
  const first = await mount();
  expect(first.result.current.status).toBe("forbidden");
  first.unmount();
  await act(flush);

  refuse = false;
  const second = await mount();
  expect(backend.callsTo("resources_subscribe")).toHaveLength(2);
  expect(second.result.current.status).toBe("syncing");
  expect(second.result.current.loading).toBe(true);
});

test("a cluster disconnect drops its lingering lists and keeps other clusters'", async () => {
  fakeClock();
  connectClusters({ id: "a", name: "a" }, { id: "b", name: "b" });
  const { subs, backend } = setup();
  const onA = await mount("a");
  const onB = await mount("b");
  await subs[0].send(snapshot(pod("only-in-a")));
  await subs[1].send(snapshot(pod("only-in-b")));
  onA.unmount();
  onB.unmount();
  await act(flush);

  setClusterState("a", { status: "disconnected" });
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);

  // A quick reconnect does not bring back the list the disconnect ended.
  setClusterState("a", CONNECTED);
  const again = await mount("a");
  expect(subs).toHaveLength(3);
  expect(subs[2].clusterId).toBe("a");
  expect(again.result.current.loading).toBe(true);

  const otherAgain = await mount("b");
  expect(subs).toHaveLength(3);
  expect(otherAgain.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-b",
  ]);
});

test("a list in use when its cluster disconnects is dropped on its last unmount", async () => {
  fakeClock();
  connectClusters({ id: "a", name: "a" });
  const { subs, backend } = setup();
  const first = await mount("a");
  await subs[0].send(snapshot(pod("a")));
  setClusterState("a", { status: "disconnected" });
  // The rows stay while the list is shown, as before.
  expect(first.result.current.items).toHaveLength(1);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([]);

  first.unmount();
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);
  setClusterState("a", CONNECTED);
  await mount("a");
  expect(subs).toHaveLength(2);
});

test("a null resource subscribes to nothing", async () => {
  const { backend } = setup();
  const { result } = await mount("a", null);
  expect(result.current.items).toEqual([]);
  expect(result.current.loading).toBe(false);
  expect(backend.callsTo("resources_subscribe")).toEqual([]);
});

test("reconnecting keeps the last items and exposes the status", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("a")));
  await subs[0].send(status("live"));
  expect(result.current.status).toBe("live");

  await subs[0].send(status("reconnecting", "connection reset"));
  expect(result.current.status).toBe("reconnecting");
  expect(result.current.message).toBe("connection reset");
  expect(result.current.items).toHaveLength(1);
  expect(result.current.loading).toBe(false);
});

test("a new snapshot after a reconnect replaces stale items", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("old-1"), pod("old-2")));
  await subs[0].send(status("reconnecting"));
  await subs[0].send(snapshot(pod("new")));
  await subs[0].send(status("live"));
  expect(result.current.items.map((o) => o.metadata.name)).toEqual(["new"]);
  expect(result.current.message).toBeNull();
});

test("NotServed and Forbidden expose the message and stop showing loading", async () => {
  const { subs } = setup();
  const served = await mount("a");
  await subs[0].send(status("notServed", "the server has no pods"));
  expect(served.result.current.status).toBe("notServed");
  expect(served.result.current.message).toBe("the server has no pods");
  expect(served.result.current.loading).toBe(false);

  const denied = await mount("b");
  await subs[1].send(status("forbidden", "cannot list pods"));
  expect(denied.result.current.status).toBe("forbidden");
  expect(denied.result.current.message).toBe("cannot list pods");
  expect(denied.result.current.loading).toBe(false);
});

test("batches arriving together render in one update", async () => {
  const { subs } = setup();
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useResourceList("a", pods);
  });
  await act(flush);
  const before = renders;

  await subs[0].send({
    type: "batch",
    upserts: Array.from({ length: 200 }, (_, i) => pod(`p${i}`)),
    deletes: Array.from({ length: 50 }, (_, i) => ({
      namespace: "default",
      name: `gone${i}`,
    })),
  });
  expect(hook.result.current.items).toHaveLength(200);
  expect(renders - before).toBeLessThanOrEqual(1);
});

test("a subscribe that fails shows the message and stops loading", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "InvalidInput", message: "cluster a is disconnected" };
    },
  });
  const { result } = await mount();
  expect(result.current.loading).toBe(false);
  expect(result.current.status).toBe("notServed");
  expect(result.current.message).toBe("cluster a is disconnected");
});

test("a subscribe refused as forbidden reports forbidden", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "Forbidden", message: "pods is forbidden" };
    },
  });
  const { result } = await mount();
  expect(result.current.loading).toBe(false);
  expect(result.current.status).toBe("forbidden");
  expect(result.current.message).toBe("pods is forbidden");
});

test("unmounting before the subscription id arrives still unsubscribes after the linger", async () => {
  fakeClock();
  let release: (id: string) => void = () => {};
  const backend = mockBackend({
    resources_subscribe: () => new Promise<string>((r) => (release = r)),
    resources_unsubscribe: () => null,
  });
  const hook = await mount();
  hook.unmount();
  release("late");
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([]);
  vi.advanceTimersByTime(LINGER_MS);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "late" },
  ]);
});

test("a list dropped before the subscription id arrives unsubscribes on arrival", async () => {
  fakeClock();
  let release: (id: string) => void = () => {};
  const backend = mockBackend({
    resources_subscribe: () => new Promise<string>((r) => (release = r)),
    resources_unsubscribe: () => null,
  });
  const hook = await mount();
  hook.unmount();
  vi.advanceTimersByTime(LINGER_MS);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([]);
  release("late");
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "late" },
  ]);
});

test("while the window is hidden, batches are applied and shown in one update when it shows", async () => {
  const { subs } = setup();
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useResourceList("a", pods);
  });
  await act(flush);
  await subs[0].send(snapshot(pod("a"), pod("m")));
  const hidden = hideWindow();
  const before = renders;

  await subs[0].send({ type: "batch", upserts: [pod("z")], deletes: [] });
  await subs[0].send({
    type: "batch",
    upserts: [pod("b"), pod("m", "default", "2")],
    deletes: [{ namespace: "default", name: "a" }],
  });
  expect(renders).toBe(before);
  expect(keysOf(hook.result.current.items)).toEqual(["default/a", "default/m"]);

  await hidden.show();
  expect(renders - before).toBe(1);
  expect(keysOf(hook.result.current.items)).toEqual([
    "default/b",
    "default/m",
    "default/z",
  ]);
  expect(hook.result.current.items[1].metadata.resourceVersion).toBe("2");

  // Nothing new arrived, so showing the window again renders nothing.
  await hidden.show();
  expect(renders - before).toBe(1);
});

test("while the window is hidden, the first snapshot and statuses show at once", async () => {
  const { subs } = setup();
  hideWindow();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("a")));
  expect(result.current.loading).toBe(false);
  expect(keysOf(result.current.items)).toEqual(["default/a"]);

  // A status shows with every row applied before it.
  await subs[0].send({ type: "batch", upserts: [pod("b")], deletes: [] });
  expect(keysOf(result.current.items)).toEqual(["default/a"]);
  await subs[0].send(status("reconnecting", "connection reset"));
  expect(result.current.status).toBe("reconnecting");
  expect(result.current.message).toBe("connection reset");
  expect(keysOf(result.current.items)).toEqual(["default/a", "default/b"]);
});

test("a list kept while the window is hidden shows its latest rows when the window shows", async () => {
  fakeClock();
  const { subs, backend } = setup();
  const first = await mount();
  await subs[0].send(snapshot(pod("a")));
  first.unmount();
  await act(flush);
  const hidden = hideWindow();
  await subs[0].send({ type: "batch", upserts: [pod("b")], deletes: [] });

  await hidden.show();
  const second = await mount();
  expect(backend.callsTo("resources_subscribe")).toHaveLength(1);
  expect(keysOf(second.result.current.items)).toEqual([
    "default/a",
    "default/b",
  ]);
});

test("findResource matches group and plural", () => {
  const info = (group: string, plural: string) => ({
    resource: { ...pods, group, plural },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  });
  const all = [info("", "pods"), info("apps", "deployments")];
  expect(findResource(all, "apps", "deployments")).toBe(all[1]);
  expect(findResource(all, "apps", "pods")).toBeUndefined();
});

test("the trimmed kinds are core Pods, Nodes and ConfigMaps, apps ReplicaSets and CRDs", () => {
  const ref = (group: string, plural: string): ResourceRef => ({
    ...pods,
    group,
    plural,
  });
  for (const [group, plural] of [
    ["", "pods"],
    ["", "nodes"],
    ["", "configmaps"],
    ["apps", "replicasets"],
    ["apiextensions.k8s.io", "customresourcedefinitions"],
    ["", "events"],
    ["argoproj.io", "applications"],
  ]) {
    expect(rowsAreTrimmed(ref(group, plural))).toBe(true);
  }
  for (const [group, plural] of [
    ["events.k8s.io", "events"],
    ["argoproj.io", "applicationsets"],
    ["", "secrets"],
    ["", "services"],
    ["apps", "deployments"],
    ["apps", "pods"],
    ["metrics.k8s.io", "nodes"],
    ["", "replicasets"],
    ["example.com", "configmaps"],
  ]) {
    expect(rowsAreTrimmed(ref(group, plural))).toBe(false);
  }
});

const nodes: ResourceRef = {
  group: "",
  version: "v1",
  plural: "nodes",
  kind: "Node",
  namespaced: false,
};

interface ObjectSub {
  args: Record<string, unknown>;
  send(event: WatchEvent): Promise<void>;
}

/** A backend with list watches in `subs` and single-object watches in `objectSubs`. */
function setupObjects(refuseObject?: { code: string; message: string }) {
  const subs: Sub[] = [];
  const objectSubs: ObjectSub[] = [];
  const deliver =
    (onEvent: { onmessage: (e: WatchEvent) => void }) =>
    async (event: WatchEvent) => {
      await act(async () => {
        onEvent.onmessage(event);
        await flush();
      });
    };
  const backend = mockBackend({
    resources_subscribe: (args: {
      clusterId: string;
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.push({
        clusterId: args.clusterId,
        resource: args.resource,
        send: deliver(args.onEvent),
      });
      return `sub-${subs.length}`;
    },
    resources_subscribe_object: (
      args: Record<string, unknown> & {
        onEvent: { onmessage: (e: WatchEvent) => void };
      },
    ) => {
      if (refuseObject) throw refuseObject;
      const { onEvent, ...rest } = args;
      objectSubs.push({ args: rest, send: deliver(onEvent) });
      return `object-${objectSubs.length}`;
    },
    resources_unsubscribe: () => null,
  });
  return { subs, objectSubs, backend };
}

async function mountObject(
  resource: ResourceRef | null,
  namespace: string | null,
  name: string | null,
  clusterId = "a",
) {
  const hook = renderHook(
    (props: { r: ResourceRef | null; ns: string | null; n: string | null }) =>
      useObjectWatch(clusterId, props.r, props.ns, props.n),
    { initialProps: { r: resource, ns: namespace, n: name } },
  );
  await act(flush);
  return hook;
}

test("an object watch subscribes to the one object and holds it while it exists", async () => {
  const { objectSubs, subs } = setupObjects();
  const { result } = await mountObject(pods, "default", "web");
  expect(subs).toHaveLength(0);
  expect(objectSubs.map((s) => s.args)).toEqual([
    { clusterId: "a", resource: pods, namespace: "default", name: "web" },
  ]);
  expect(result.current.loading).toBe(true);
  await objectSubs[0].send(status("syncing"));
  await objectSubs[0].send(snapshot(pod("web")));
  await objectSubs[0].send(status("live"));
  expect(result.current).toMatchObject({ loading: false, status: "live" });
  expect(result.current.items).toEqual([pod("web")]);
  await objectSubs[0].send({
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "default", name: "web" }],
  });
  expect(result.current.items).toEqual([]);
});

test("an object watch of a cluster-scoped kind sends no namespace", async () => {
  const { objectSubs } = setupObjects();
  await mountObject(nodes, "default", "node-1");
  expect(objectSubs[0].args).toMatchObject({ namespace: null, name: "node-1" });
});

test("object watches are shared per object, and linger after the last unmount", async () => {
  fakeClock();
  const { objectSubs, backend } = setupObjects();
  const first = await mountObject(pods, "default", "web");
  const second = await mountObject(pods, "default", "web");
  const other = await mountObject(pods, "default", "api");
  expect(objectSubs).toHaveLength(2);
  await objectSubs[0].send(snapshot(pod("web")));
  expect(second.result.current.items).toEqual([pod("web")]);
  first.unmount();
  second.unmount();
  other.unmount();
  await act(flush);
  // Opened again within the linger, it shows at once with no new subscription.
  const again = await mountObject(pods, "default", "web");
  expect(objectSubs).toHaveLength(2);
  expect(again.result.current.items).toEqual([pod("web")]);
  again.unmount();
  await act(async () => {
    vi.advanceTimersByTime(LINGER_MS);
    await flush();
  });
  expect(
    backend.callsTo("resources_unsubscribe").map((a) => a.subscriptionId),
  ).toEqual(["object-2", "object-1"]);
});

test("a refused object watch is notServed with the backend's message", async () => {
  setupObjects({ code: "InvalidInput", message: "namespace does not match" });
  const { result } = await mountObject(pods, "default", "web");
  await act(flush);
  expect(result.current).toMatchObject({
    status: "notServed",
    message: "namespace does not match",
    loading: false,
  });
});

test("a forbidden object watch is final, and the next mount subscribes again", async () => {
  const { objectSubs } = setupObjects();
  const first = await mountObject(pods, "default", "web");
  await objectSubs[0].send(status("forbidden", "watch is forbidden"));
  expect(first.result.current).toMatchObject({
    status: "forbidden",
    message: "watch is forbidden",
    loading: false,
  });
  first.unmount();
  await mountObject(pods, "default", "web");
  expect(objectSubs).toHaveLength(2);
});

test("a cluster disconnect ends its object watches", async () => {
  fakeClock();
  connectClusters({ id: "a", name: "a" });
  const { objectSubs, backend } = setupObjects();
  const first = await mountObject(pods, "default", "web");
  await objectSubs[0].send(snapshot(pod("web")));
  first.unmount();
  await act(flush);
  setClusterState("a", { status: "disconnected" });
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "object-1" },
  ]);
});

test("a held list is read without holding it, and is null once dropped", async () => {
  fakeClock();
  const { subs, backend } = setupObjects();
  const peek = renderHook(() => useHeldList("a", pods));
  await act(flush);
  expect(peek.result.current).toBeNull();
  const list = await mount("a", pods);
  expect(peek.result.current?.loading).toBe(true);
  await subs[0].send(snapshot(pod("web")));
  expect(peek.result.current?.items).toEqual([pod("web")]);
  // The peek holds nothing: the list lingers, then goes.
  list.unmount();
  await act(flush);
  expect(peek.result.current?.items).toEqual([pod("web")]);
  await act(async () => {
    vi.advanceTimersByTime(LINGER_MS);
    await flush();
  });
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);
  expect(peek.result.current).toBeNull();
  // An object watch is no list.
  await mountObject(pods, "default", "web");
  expect(peek.result.current).toBeNull();
});

const SOME_NODES: ResourceRef = {
  group: "",
  version: "v1",
  plural: "nodes",
  kind: "Node",
  namespaced: false,
};

async function mountIn(namespaces: string[], resource: ResourceRef = pods) {
  const hook = renderHook(() => useResourceList("a", resource, namespaces));
  await act(flush);
  return hook;
}

test("a list of some namespaces asks for those, each once and in one order", async () => {
  const { backend } = setup();
  await mountIn(["b", "a", "b"]);
  await mount();

  const asked = backend.callsTo("resources_subscribe").map((c) => c.namespaces);
  expect(asked).toEqual([["a", "b"], []]);
});

test("lists of the same namespaces share a subscription, and others have their own", async () => {
  const { subs } = setup();
  await mountIn(["a", "b"]);
  const same = await mountIn(["b", "a"]);
  const other = await mountIn(["a"]);
  const whole = await mount();
  expect(subs).toHaveLength(3);

  await subs[0].send(snapshot(pod("x", "a")));
  expect(same.result.current.items).toHaveLength(1);
  expect(other.result.current.items).toHaveLength(0);
  expect(whole.result.current.items).toHaveLength(0);
});

test("a cluster-scoped list is never asked for by namespace", async () => {
  const { backend } = setup();
  await mountIn(["a"], SOME_NODES);

  expect(backend.callsTo("resources_subscribe")[0].namespaces).toEqual([]);
});

const part = (...items: KubeObject[]): WatchEvent => ({
  type: "snapshotPart",
  items,
});
const namesOf = (state: ResourceListState) =>
  state.items.map((o) => o.metadata.name);

test("a snapshot sent in parts is shown whole, once its last part arrives", async () => {
  const { subs } = setup();
  const { result } = await mount();

  await subs[0].send(part(pod("a"), pod("b")));
  await subs[0].send(part(pod("c")));
  expect(result.current.loading).toBe(true);
  expect(result.current.items).toEqual([]);

  await subs[0].send(snapshot(pod("d")));
  expect(result.current.loading).toBe(false);
  expect(namesOf(result.current)).toEqual(["a", "b", "c", "d"]);
});

test("a new snapshot sent in parts leaves the rows shown until it is whole", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("old-1"), pod("old-2")));
  const shown = result.current.items;

  await subs[0].send(part(pod("new-1")));
  expect(result.current.items).toBe(shown);

  await subs[0].send(snapshot(pod("new-2")));
  expect(namesOf(result.current)).toEqual(["new-1", "new-2"]);
});

/** A backend that serves lists and the Pods of a node, each with its own sender. */
function setupNodes() {
  const onNode: { node: string; send(event: WatchEvent): Promise<void> }[] = [];
  const lists: Sub["send"][] = [];
  const sender =
    (onEvent: { onmessage: (e: WatchEvent) => void }) =>
    async (event: WatchEvent) => {
      await act(async () => {
        onEvent.onmessage(event);
        await flush();
      });
    };
  const backend = mockBackend({
    resources_subscribe: (args: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      lists.push(sender(args.onEvent));
      return `list-${lists.length}`;
    },
    resources_subscribe_node_pods: (args: {
      node: string;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      onNode.push({ node: args.node, send: sender(args.onEvent) });
      return `node-${onNode.length}`;
    },
    resources_unsubscribe: () => null,
  });
  return { backend, onNode, lists };
}

test("the Pods of a node are one subscription for each node, shared by those who show it", async () => {
  const { backend, onNode } = setupNodes();
  const first = renderHook(() => useNodePods("c1", "node-a"));
  const second = renderHook(() => useNodePods("c1", "node-a"));
  const other = renderHook(() => useNodePods("c1", "node-b"));
  await act(flush);

  expect(onNode.map((sub) => sub.node)).toEqual(["node-a", "node-b"]);
  expect(first.result.current.loading).toBe(true);
  await onNode[0]?.send(snapshot(pod("one")));
  expect(first.result.current.items).toEqual([pod("one")]);
  expect(second.result.current.items).toEqual([pod("one")]);
  expect(other.result.current.loading).toBe(true);
  expect(backend.callsTo("resources_subscribe")).toHaveLength(0);
});

test("the Pods of a node are never taken for the list of every Pod", async () => {
  const { onNode, lists } = setupNodes();
  renderHook(() => useNodePods("c1", "node-a"));
  await act(flush);
  await onNode[0]?.send(snapshot(pod("one")));

  const whole = renderHook(() => useResourceList("c1", pods));
  await act(flush);
  expect(whole.result.current.loading).toBe(true);
  expect(lists).toHaveLength(1);
  await lists[0]?.(snapshot(pod("one"), pod("two")));
  expect(whole.result.current.items).toHaveLength(2);
});

test("with no node named, no Pods are asked for", async () => {
  const { backend } = setupNodes();
  const { result } = renderHook(() => useNodePods("c1", null));
  await act(flush);

  expect(result.current.loading).toBe(false);
  expect(backend.callsTo("resources_subscribe_node_pods")).toHaveLength(0);
});
