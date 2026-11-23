import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flush } from "../test/ipc";
import {
  paymentsSnapshot,
  reachabilityBackend,
  rgroup,
  rsnapshot,
} from "../test/reachability";
import { CONNECTED, connectClusters, setClusterState } from "../test/terminal";
import { resetCatalogForTest } from "./catalog";
import {
  reachKey,
  resetReachabilityForTest,
  retryReachability,
  useReachability,
  useReachabilityStore,
  watchReachability,
} from "./reachability";
import { LINGER_MS } from "./resources";

beforeEach(() => resetReachabilityForTest());
afterEach(() => {
  resetReachabilityForTest();
  vi.useRealTimers();
});

/** Fakes the clock, which still follows real time, so `flush` keeps working. */
function fakeClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
}

const entry = (clusterId: string, namespace: string) =>
  useReachabilityStore.getState().entries[reachKey(clusterId, namespace)];
const PAYMENTS = paymentsSnapshot();
const SHOP = rsnapshot("shop", [rgroup("Deployment", "shop", "cart")]);

test("watchers of a namespace share one subscription, which lingers after the last leaves", async () => {
  fakeClock();
  const r = reachabilityBackend();
  const first = watchReachability("c1", "payments");
  const second = watchReachability("c1", "payments");
  await act(flush);
  expect(r.backend.callsTo("network_reachability_subscribe")).toMatchObject([
    { clusterId: "c1", namespace: "payments" },
  ]);
  expect(entry("c1", "payments")).toEqual({
    snapshot: null,
    error: null,
    loading: true,
  });
  await r.send(PAYMENTS);
  expect(entry("c1", "payments")).toEqual({
    snapshot: PAYMENTS,
    error: null,
    loading: false,
  });

  first();
  first();
  second();
  await act(flush);
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([]);
  expect(entry("c1", "payments")?.snapshot).toEqual(PAYMENTS);
  const again = watchReachability("c1", "payments");
  vi.advanceTimersByTime(LINGER_MS);
  expect(r.backend.callsTo("network_reachability_subscribe")).toHaveLength(1);
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([]);
  again();
  vi.advanceTimersByTime(LINGER_MS - 1_000);
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([]);
  vi.advanceTimersByTime(1_000);
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([
    { subscriptionId: "r1" },
  ]);
  expect(entry("c1", "payments")).toBeUndefined();
});

test("each namespace and each cluster has its own subscription and entry", async () => {
  const r = reachabilityBackend();
  const leaves = [
    watchReachability("c1", "payments"),
    watchReachability("c1", "shop"),
    watchReachability("c2", "payments"),
  ];
  await act(flush);
  expect(r.backend.callsTo("network_reachability_subscribe")).toMatchObject([
    { clusterId: "c1", namespace: "payments" },
    { clusterId: "c1", namespace: "shop" },
    { clusterId: "c2", namespace: "payments" },
  ]);
  await r.send(SHOP, "r2");
  // A snapshot of another namespace on a subscription is not its own.
  await r.send(SHOP, "r1");
  expect(entry("c1", "shop")?.snapshot).toEqual(SHOP);
  expect(entry("c1", "payments")?.snapshot).toBeNull();
  expect(entry("c2", "payments")?.snapshot).toBeNull();
  await r.send(PAYMENTS, "r3");
  expect(entry("c2", "payments")?.snapshot).toEqual(PAYMENTS);
  expect(entry("c1", "payments")?.snapshot).toBeNull();
  for (const leave of leaves) leave();
});

test("a late event of a namespace left behind is dropped", async () => {
  fakeClock();
  const r = reachabilityBackend();
  r.hold();
  const hook = renderHook(({ namespace }) => useReachability("c1", namespace), {
    initialProps: { namespace: "payments" },
  });
  await act(flush);
  hook.rerender({ namespace: "shop" });
  await act(flush);
  expect(r.backend.callsTo("network_reachability_subscribe")).toMatchObject([
    { clusterId: "c1", namespace: "payments" },
    { clusterId: "c1", namespace: "shop" },
  ]);
  // The old namespace answers late, then sends its snapshot: the page shows neither.
  await r.answer();
  await r.send(PAYMENTS, "r1");
  expect(hook.result.current).toEqual({
    snapshot: null,
    error: null,
    loading: true,
  });

  act(() => {
    vi.advanceTimersByTime(LINGER_MS);
  });
  await act(flush);
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([
    { subscriptionId: "r1" },
  ]);
  expect(entry("c1", "payments")).toBeUndefined();
  // An event still in flight on the ended subscription changes nothing.
  await r.send(PAYMENTS, "r1");
  expect(entry("c1", "payments")).toBeUndefined();
  expect(hook.result.current.snapshot).toBeNull();

  await r.answer();
  await r.send(SHOP, "r2");
  expect(hook.result.current).toEqual({
    snapshot: SHOP,
    error: null,
    loading: false,
  });
  hook.unmount();
});

test("a subscription id that answers after its namespace was dropped is ended at once", async () => {
  fakeClock();
  const r = reachabilityBackend();
  r.hold();
  watchReachability("c1", "payments")();
  await act(flush);
  vi.advanceTimersByTime(LINGER_MS);
  expect(entry("c1", "payments")).toBeUndefined();
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([]);
  await r.answer();
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([
    { subscriptionId: "r1" },
  ]);
  expect(entry("c1", "payments")).toBeUndefined();
});

test("a failure keeps the snapshot, Retry subscribes again, and a failed watch is dropped at once", async () => {
  const r = reachabilityBackend();
  const stop = watchReachability("c1", "payments");
  await act(flush);
  await r.send(PAYMENTS);
  await r.send({
    type: "failure",
    message: "Pods cannot be listed: pods is forbidden",
  });
  expect(entry("c1", "payments")).toEqual({
    snapshot: PAYMENTS,
    error: "Pods cannot be listed: pods is forbidden",
    loading: false,
  });

  act(() => retryReachability("c1", "payments"));
  await act(flush);
  expect(r.backend.callsTo("network_reachability_subscribe")).toHaveLength(2);
  expect(entry("c1", "payments")).toEqual({
    snapshot: PAYMENTS,
    error: null,
    loading: true,
  });
  // The backend ended the failed subscription itself.
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([]);

  await r.send({ type: "failure", message: "boom" });
  stop();
  await act(flush);
  expect(entry("c1", "payments")).toBeUndefined();
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([]);
});

test("a refused subscribe shows its message", async () => {
  const r = reachabilityBackend({
    network_reachability_subscribe: () => {
      throw { code: "InvalidInput", message: "cluster c1 is disconnected" };
    },
  });
  const stop = watchReachability("c1", "payments");
  await act(flush);
  expect(entry("c1", "payments")).toEqual({
    snapshot: null,
    error: "cluster c1 is disconnected",
    loading: false,
  });
  stop();
  await act(flush);
  expect(entry("c1", "payments")).toBeUndefined();
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([]);
});

test("a disconnect drops the cluster's lingering watches and marks its watched ones failed", async () => {
  fakeClock();
  connectClusters({ id: "c1", name: "c1" }, { id: "c2", name: "c2" });
  const r = reachabilityBackend();
  watchReachability("c1", "shop")();
  const leave = watchReachability("c1", "payments");
  const other = watchReachability("c2", "payments");
  await act(flush);
  await r.send(PAYMENTS, "r2");

  setClusterState("c1", { status: "disconnected" });
  expect(entry("c1", "shop")).toBeUndefined();
  expect(entry("c1", "payments")).toEqual({
    snapshot: PAYMENTS,
    error: "Cluster disconnected",
    loading: false,
  });
  expect(entry("c2", "payments")?.error).toBeNull();
  expect(r.backend.callsTo("network_reachability_unsubscribe")).toEqual([
    { subscriptionId: "r1" },
    { subscriptionId: "r2" },
  ]);

  setClusterState("c1", CONNECTED);
  retryReachability("c1", "payments");
  await act(flush);
  expect(r.backend.callsTo("network_reachability_subscribe")).toHaveLength(4);
  expect(entry("c1", "payments")?.error).toBeNull();
  leave();
  other();
  resetCatalogForTest();
});
