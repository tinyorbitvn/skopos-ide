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
