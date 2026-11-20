import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flush } from "../test/ipc";
import {
  tnode,
  topologyBackend,
  tregion,
  tsnapshot,
  tzone,
} from "../test/topology";
import { LINGER_MS } from "./resources";
import {
  resetTopologyForTest,
  retryTopology,
  useTopology,
  useTopologyStore,
  watchTopology,
} from "./topology";

beforeEach(() => resetTopologyForTest());
afterEach(() => {
  resetTopologyForTest();
  vi.useRealTimers();
});

/** Fakes the clock, which still follows real time, so `flush` keeps working. */
function fakeClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
}

const entry = (clusterId: string) =>
  useTopologyStore.getState().entries[clusterId];
const ONE = tsnapshot([tregion(null, [tzone(null, [tnode("worker-1")])])]);

test("watchers of a cluster share one subscription, which lingers after the last leaves", async () => {
  fakeClock();
  const t = topologyBackend();
  const first = watchTopology("c1");
  const second = watchTopology("c1");
  await act(flush);
  expect(t.backend.callsTo("node_topology_subscribe")).toMatchObject([
    { clusterId: "c1" },
  ]);
  expect(entry("c1")).toEqual({ snapshot: null, error: null, loading: true });
  await t.send({ type: "snapshot", snapshot: ONE });
  expect(entry("c1")).toEqual({ snapshot: ONE, error: null, loading: false });

  first();
  first();
  second();
  await act(flush);
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([]);
  expect(entry("c1")?.snapshot).toEqual(ONE);
  vi.advanceTimersByTime(LINGER_MS - 1_000);
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([]);
  vi.advanceTimersByTime(1_000);
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([
    { subscriptionId: "t1" },
  ]);
  expect(entry("c1")).toBeUndefined();
});

test("a watcher back within the linger keeps the subscription and its snapshot", async () => {
  fakeClock();
  const t = topologyBackend();
  const first = watchTopology("c1");
  await act(flush);
  await t.send({ type: "snapshot", snapshot: ONE });
  first();
  vi.advanceTimersByTime(LINGER_MS - 1_000);
  const again = watchTopology("c1");
  expect(entry("c1")).toEqual({ snapshot: ONE, error: null, loading: false });
  vi.advanceTimersByTime(LINGER_MS);
  expect(t.backend.callsTo("node_topology_subscribe")).toHaveLength(1);
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([]);
  again();
  vi.advanceTimersByTime(LINGER_MS);
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([
    { subscriptionId: "t1" },
  ]);
});

test("a failure keeps the snapshot, Retry subscribes again, and a failed watch is dropped at once", async () => {
  const t = topologyBackend();
  const stop = watchTopology("c1");
  await act(flush);
  await t.send({ type: "snapshot", snapshot: ONE });
  await t.send({
    type: "failure",
    message: "Listing nodes is not allowed: nodes is forbidden",
  });
  expect(entry("c1")).toEqual({
    snapshot: ONE,
    error: "Listing nodes is not allowed: nodes is forbidden",
    loading: false,
  });

  act(() => retryTopology("c1"));
  await act(flush);
  expect(t.backend.callsTo("node_topology_subscribe")).toHaveLength(2);
  expect(entry("c1")).toEqual({ snapshot: ONE, error: null, loading: true });
  // The backend ended the failed subscription itself.
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([]);

  await t.send({ type: "failure", message: "boom" });
  stop();
  await act(flush);
  expect(entry("c1")).toBeUndefined();
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([]);
});

test("a refused subscribe shows its message", async () => {
  const t = topologyBackend({
    node_topology_subscribe: () => {
      throw { code: "InvalidInput", message: "cluster c1 is disconnected" };
    },
  });
  const stop = watchTopology("c1");
  await act(flush);
  expect(entry("c1")).toEqual({
    snapshot: null,
    error: "cluster c1 is disconnected",
    loading: false,
  });
  stop();
  await act(flush);
  expect(entry("c1")).toBeUndefined();
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([]);
});

test("useTopology watches while mounted, retries, and a null cluster watches nothing", async () => {
  fakeClock();
  const t = topologyBackend();
  const idle = renderHook(() => useTopology(null));
  expect(idle.result.current).toMatchObject({
    snapshot: null,
    error: null,
    loading: false,
  });
  const hook = renderHook(() => useTopology("c1"));
  await act(flush);
  expect(hook.result.current).toMatchObject({ snapshot: null, loading: true });
  await t.send({ type: "snapshot", snapshot: ONE });
  expect(hook.result.current.snapshot).toEqual(ONE);

  act(() => hook.result.current.retry());
  await act(flush);
  expect(t.backend.callsTo("node_topology_subscribe")).toHaveLength(2);
  hook.unmount();
  vi.advanceTimersByTime(LINGER_MS);
  expect(t.backend.callsTo("node_topology_unsubscribe")).toEqual([
    { subscriptionId: "t1" },
    { subscriptionId: "t2" },
  ]);
  expect(t.backend.callsTo("node_topology_subscribe")).toHaveLength(2);
});
