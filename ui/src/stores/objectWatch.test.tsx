import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { WatchEvent } from "../ipc/generated/WatchEvent";
import type { WatchStatus } from "../ipc/generated/WatchStatus";
import type { KubeObject } from "../kinds/objects";
import { flush, mockBackend } from "../test/ipc";
import { useWatchedObject, type WatchedObject } from "./objectWatch";
import { LINGER_MS, resetResourcesForTest, useResourceList } from "./resources";

const PODS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};

type OnEvent = { onmessage: (e: WatchEvent) => void };

function pod(name: string, extra: Partial<KubeObject> = {}): KubeObject {
  return { metadata: { name, namespace: "n", resourceVersion: "1" }, ...extra };
}

function backend() {
  const lists: OnEvent[] = [];
  const objects: OnEvent[] = [];
  const b = mockBackend({
    resources_subscribe: (a: { onEvent: OnEvent }) => {
      lists.push(a.onEvent);
      return `list-${lists.length}`;
    },
    resources_subscribe_object: (a: { onEvent: OnEvent }) => {
      objects.push(a.onEvent);
      return `object-${objects.length}`;
    },
    resources_unsubscribe: () => null,
  });
  const send = (to: OnEvent | undefined, event: WatchEvent) =>
    act(async () => {
      to?.onmessage(event);
      await flush();
    });
  return {
    b,
    list: (items: KubeObject[], at = lists.length - 1) =>
      send(lists[at], { type: "snapshot", items } as WatchEvent),
    object: (items: KubeObject[], at = objects.length - 1) =>
      send(objects[at], { type: "snapshot", items } as WatchEvent),
    status: (status: WatchStatus, at = lists.length - 1) =>
      send(lists[at], { type: "status", status, message: null }),
  };
}

function watched() {
  return renderHook(() => useWatchedObject("c1", PODS, "n", "web"));
}

function holdList() {
  return renderHook(() => useResourceList("c1", PODS));
}

beforeEach(() => resetResourcesForTest());
afterEach(() => {
  resetResourcesForTest();
  vi.useRealTimers();
});

function fakeClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
}

async function passLinger(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(LINGER_MS);
    await flush();
  });
}

test("with no list, a single-object watch gives the whole object", async () => {
  const f = backend();
  const { result } = watched();
  await act(flush);
  expect(result.current).toMatchObject({ loading: true, source: "object" });
  const whole = pod("web", { spec: { volumes: [] } });
  await f.object([whole]);
  expect(result.current).toMatchObject({
    object: whole,
    trimmed: false,
    source: "object",
    loading: false,
  });
  expect(f.b.callsTo("resources_subscribe")).toHaveLength(0);
});

test("a list already held is read, trimmed, and no object watch starts", async () => {
  const f = backend();
  holdList();
  await act(flush);
  await f.list([pod("api"), pod("web")]);
  const { result } = watched();
  await act(flush);
  expect(result.current).toMatchObject({
    object: pod("web"),
    trimmed: true,
    source: "list",
  });
  expect(f.b.callsTo("resources_subscribe_object")).toHaveLength(0);
});

let seen: WatchedObject | null = null;

function Child() {
  seen = useWatchedObject("c1", PODS, "n", "web");
  return null;
}

/** A child's effects run before its parent's, as a drawer's do before its screen's. */
function Parent() {
  useResourceList("c1", PODS);
  return <Child />;
}

test("a list a parent opens in the same commit is read, and no object watch starts", async () => {
  const f = backend();
  render(<Parent />);
  await act(flush);
  await f.list([pod("web")]);
  expect(seen).toMatchObject({ object: pod("web"), source: "list" });
  expect(f.b.callsTo("resources_subscribe_object")).toHaveLength(0);
});

test("a list that is dropped hands over to an object watch, keeping the row until it loads", async () => {
  fakeClock();
  const f = backend();
  const list = holdList();
  await act(flush);
  await f.list([pod("web")]);
  const { result } = watched();
  await act(flush);
  list.unmount();
  await act(flush);
  // The list lingers, and is still read.
  expect(result.current.source).toBe("list");
  expect(f.b.callsTo("resources_subscribe_object")).toHaveLength(0);
  await passLinger();
  expect(f.b.callsTo("resources_subscribe_object")).toHaveLength(1);
  expect(result.current).toMatchObject({ object: pod("web"), loading: false });
  const whole = pod("web", { spec: { volumes: [] } });
  await f.object([whole]);
  expect(result.current).toMatchObject({
    object: whole,
    trimmed: false,
    source: "object",
  });
});

test("a list opened later takes over, and the object watch is released", async () => {
  fakeClock();
  const f = backend();
  const { result } = watched();
  await act(flush);
  const whole = pod("web", { spec: { volumes: [] } });
  await f.object([whole]);
  holdList();
  await act(flush);
  // The object stays while the list loads.
  expect(result.current).toMatchObject({ object: whole, loading: false });
  const row = pod("web", { metadata: { name: "web", namespace: "n" } });
  await f.list([row]);
  expect(result.current).toMatchObject({
    object: row,
    trimmed: true,
    source: "list",
  });
  await passLinger();
  expect(f.b.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "object-1" },
  ]);
});

test("a list refused as a whole is passed over for an object watch", async () => {
  const f = backend();
  holdList();
  await act(flush);
  const { result } = watched();
  await act(flush);
  expect(f.b.callsTo("resources_subscribe_object")).toHaveLength(0);
  await f.status("forbidden", 0);
  await act(flush);
  expect(f.b.callsTo("resources_subscribe_object")).toHaveLength(1);
  const whole = pod("web", { spec: { volumes: [] } });
  await f.object([whole]);
  expect(result.current).toMatchObject({
    object: whole,
    trimmed: false,
    source: "object",
    status: "syncing",
  });
});

test("another object never shows the last one's answer, and the last watch is released", async () => {
  fakeClock();
  const f = backend();
  const { result, rerender } = renderHook(
    ({ name }: { name: string }) => useWatchedObject("c1", PODS, "n", name),
    { initialProps: { name: "web" } },
  );
  await act(flush);
  await f.object([pod("web")]);
  expect(result.current.object).toEqual(pod("web"));
  rerender({ name: "api" });
  expect(result.current.object).toBeUndefined();
  await act(flush);
  expect(result.current).toMatchObject({ object: undefined, loading: true });
  expect(f.b.callsTo("resources_subscribe_object")).toHaveLength(2);
  await f.object([pod("api")]);
  expect(result.current).toMatchObject({ object: pod("api"), loading: false });
  await passLinger();
  expect(f.b.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "object-1" },
  ]);
});

test("nothing is watched without a resource or a name", async () => {
  const f = backend();
  const { result } = renderHook(() => useWatchedObject("c1", null, "n", "web"));
  renderHook(() => useWatchedObject("c1", PODS, "n", null));
  await act(flush);
  expect(result.current).toMatchObject({ object: undefined, source: null });
  expect(f.b.calls.filter((c) => c.cmd.startsWith("resources_"))).toEqual([]);
});

test("the row comes from a held list of the object's namespace", async () => {
  const { b, list } = backend();
  renderHook(() => useResourceList("c1", PODS, ["n"]));
  await act(flush);
  const { result } = watched();
  await act(flush);
  await list([pod("web")]);

  expect(result.current.source).toBe("list");
  expect(result.current.object?.metadata.name).toBe("web");
  expect(b.callsTo("resources_subscribe_object")).toEqual([]);
});

test("a held list of other namespaces does not stand in for the object's watch", async () => {
  const { b } = backend();
  renderHook(() => useResourceList("c1", PODS, ["other"]));
  await act(flush);
  const { result } = watched();
  await act(flush);

  expect(result.current.source).toBe("object");
  expect(b.callsTo("resources_subscribe_object")).toHaveLength(1);
});
