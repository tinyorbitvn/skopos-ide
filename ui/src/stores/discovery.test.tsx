import { act, render, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { WatchEvent } from "../ipc/generated/WatchEvent";
import { flush, mockBackend } from "../test/ipc";
import {
  REDISCOVER_DELAYS_MS,
  resetDiscoveryForTest,
  useClusterResources,
  useDiscovery,
} from "./discovery";
import { resetResourcesForTest } from "./resources";

afterEach(() => {
  vi.useRealTimers();
  resetDiscoveryForTest();
  resetResourcesForTest();
});

const CRD: ApiResourceInfo = {
  resource: {
    group: "apiextensions.k8s.io",
    version: "v1",
    plural: "customresourcedefinitions",
    kind: "CustomResourceDefinition",
    namespaced: false,
  },
  verbs: ["list", "watch"],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
};

const WIDGETS: ApiResourceInfo = {
  ...CRD,
  resource: {
    group: "e2e.test",
    version: "v1",
    plural: "widgets",
    kind: "Widget",
    namespaced: true,
  },
};

const WIDGET_CRD = {
  metadata: { name: "widgets.e2e.test", resourceVersion: "1" },
  spec: { group: "e2e.test", names: { plural: "widgets" } },
  status: { conditions: [{ type: "Established", status: "True" }] },
};

type Shown = ReturnType<typeof useDiscovery>;

/** Reads the discovery of `c1` with `hook` and puts what it shows in `shown`. */
function Reader(props: {
  index: number;
  shown: Shown[];
  hook: (clusterId: string) => Shown;
}) {
  props.shown[props.index] = props.hook("c1");
  return null;
}

/** Mounts `count` components that each read the discovery of `c1` with `hook`. */
function renderReaders(count: number, hook = useClusterResources) {
  const shown: Shown[] = [];
  const view = render(
    Array.from({ length: count }, (_, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the readers never move.
      <Reader key={i} index={i} shown={shown} hook={hook} />
    )),
  );
  return { shown, view };
}

/** A backend whose discovery gives `answers` in turn, then the last, with a CRD watch. */
function crdBackend(answers: ApiResourceInfo[][]) {
  let send: (e: WatchEvent) => void = () => {};
  let call = 0;
  const backend = mockBackend({
    resources_discover: () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer;
    },
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub-1";
    },
    resources_unsubscribe: () => null,
  });
  const snapshot = (items: unknown[]) =>
    act(async () => {
      send({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  /** The same, while fake timers run. */
  const snapshotFaked = (items: unknown[]) =>
    act(async () => {
      send({ type: "snapshot", items } as WatchEvent);
      await vi.advanceTimersByTimeAsync(1);
    });
  return { backend, snapshot, snapshotFaked };
}

const discoveries = (backend: ReturnType<typeof mockBackend>) =>
  backend.callsTo("resources_discover").length;

test("three readers share one discovery", async () => {
  const backend = mockBackend({ resources_discover: () => [WIDGETS] });
  const { shown } = renderReaders(3, useDiscovery);
  for (const reader of shown) expect(reader.loading).toBe(true);
  await act(flush);

  expect(backend.callsTo("resources_discover")).toEqual([
    { clusterId: "c1", refresh: false },
  ]);
  for (const reader of shown) {
    expect(reader.loading).toBe(false);
    expect(reader.error).toBeNull();
    expect(reader.resources).toEqual([WIDGETS]);
  }
});

test("a reader that mounts later reads what is there without asking again", async () => {
  const backend = mockBackend({ resources_discover: () => [WIDGETS] });
  renderHook(() => useDiscovery("c1"));
  await act(flush);
  const { result } = renderHook(() => useDiscovery("c1"));
  expect(result.current.loading).toBe(false);
  expect(result.current.resources).toEqual([WIDGETS]);
  await act(flush);
  expect(discoveries(backend)).toBe(1);
});

test("Strict Mode's second mount does not ask again", async () => {
  const backend = mockBackend({ resources_discover: () => [] });
  render(
    <StrictMode>
      <Reader index={0} shown={[]} hook={useDiscovery} />
    </StrictMode>,
  );
  await act(flush);
  expect(discoveries(backend)).toBe(1);
});

test("each cluster has its own discovery", async () => {
  const backend = mockBackend({
    resources_discover: (a: { clusterId: string }) =>
      a.clusterId === "c1" ? [WIDGETS] : [],
  });
  const one = renderHook(() => useDiscovery("c1"));
  const two = renderHook(() => useDiscovery("c2"));
  await act(flush);
  expect(one.result.current.resources).toEqual([WIDGETS]);
  expect(two.result.current.resources).toEqual([]);
  expect(discoveries(backend)).toBe(2);
});

test("a reader that moves to another cluster shows none of the old one", async () => {
  mockBackend({
    resources_discover: (a: { clusterId: string }) =>
      a.clusterId === "c1" ? [WIDGETS] : [],
  });
  const { result, rerender } = renderHook(
    (props: { clusterId: string }) => useDiscovery(props.clusterId),
    { initialProps: { clusterId: "c1" } },
  );
  await act(flush);
  expect(result.current.resources).toEqual([WIDGETS]);
  rerender({ clusterId: "c2" });
  expect(result.current.resources).toEqual([]);
  expect(result.current.loading).toBe(true);
  await act(flush);
  expect(result.current.loading).toBe(false);
});

test("discovers and refreshes", async () => {
  const backend = mockBackend({ resources_discover: () => [] });
  const { result } = renderHook(() => useDiscovery("a"));
  expect(result.current.loading).toBe(true);
  await act(flush);
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBeNull();
  await act(() => result.current.refresh());
  expect(backend.callsTo("resources_discover")).toEqual([
    { clusterId: "a", refresh: false },
    { clusterId: "a", refresh: true },
  ]);
});

test("reports a failure to every reader", async () => {
  mockBackend({
    resources_discover: () => {
      throw { code: "InvalidInput", message: "cluster a is disconnected" };
    },
  });
  const { shown } = renderReaders(2, useDiscovery);
  await act(flush);
  for (const reader of shown) {
    expect(reader.error).toBe("cluster a is disconnected");
    expect(reader.loading).toBe(false);
  }
});

test("keeps the last resources when a refresh fails", async () => {
  let fail = false;
  mockBackend({
    resources_discover: () => {
      if (fail) throw { code: "InvalidInput", message: "api blip" };
      return [WIDGETS];
    },
  });
  const { result } = renderHook(() => useDiscovery("a"));
  await act(flush);
  expect(result.current.resources).toHaveLength(1);
  fail = true;
  await act(() => result.current.refresh());
  expect(result.current.error).toBe("api blip");
  expect(result.current.resources).toHaveLength(1);
  expect(result.current.loading).toBe(false);
});

test("a reader that mounts after a failure asks again", async () => {
  let fail = true;
  const backend = mockBackend({
    resources_discover: () => {
      if (fail) throw { code: "InvalidInput", message: "api blip" };
      return [WIDGETS];
    },
  });
  renderHook(() => useDiscovery("c1"));
  await act(flush);
  fail = false;
  const { result } = renderHook(() => useDiscovery("c1"));
  await act(flush);
  expect(result.current.error).toBeNull();
  expect(result.current.resources).toEqual([WIDGETS]);
  expect(backend.callsTo("resources_discover")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: false },
  ]);
});

test("refreshes asked during a request wait for it, then run once", async () => {
  let running = 0;
  let most = 0;
  const pending: (() => void)[] = [];
  const backend = mockBackend({
    resources_discover: () => {
      running += 1;
      most = Math.max(most, running);
      return new Promise<ApiResourceInfo[]>((resolve) => {
        pending.push(() => {
          running -= 1;
          resolve([WIDGETS]);
        });
      });
    },
  });
  const { shown } = renderReaders(3, useDiscovery);
  await act(flush);
  let done = 0;
  act(() => {
    for (const reader of shown) void reader.refresh().then(() => done++);
  });
  await act(flush);
  expect(discoveries(backend)).toBe(1);

  await act(async () => {
    pending.shift()?.();
    await flush();
  });
  expect(backend.callsTo("resources_discover")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: true },
  ]);
  // The first answer does not end the refresh: the second request is still out.
  expect(shown[0].loading).toBe(true);
  expect(done).toBe(0);

  await act(async () => {
    pending.shift()?.();
    await flush();
  });
  expect(done).toBe(3);
  expect(most).toBe(1);
  expect(shown[0].loading).toBe(false);
});

test("a change in the set of CRDs re-discovers once for all readers", async () => {
  const { backend, snapshot } = crdBackend([[CRD]]);
  renderReaders(3);
  await act(flush);
  expect(backend.callsTo("resources_subscribe")).toHaveLength(1);
  await snapshot([]);
  expect(discoveries(backend)).toBe(1);

  await snapshot([{ metadata: { name: "a.io", resourceVersion: "1" } }]);
  await act(flush);
  expect(backend.callsTo("resources_discover")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: true },
  ]);
});

test("the readers of a cluster share one schedule of looks at a lagging discovery", async () => {
  const { backend, snapshot, snapshotFaked } = crdBackend([[CRD]]);
  renderReaders(3);
  await act(flush);
  await snapshot([]);
  vi.useFakeTimers();
  await snapshotFaked([WIDGET_CRD]);

  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  // The first look, the refresh for the new CRD, then one look per delay.
  expect(discoveries(backend)).toBe(2 + REDISCOVER_DELAYS_MS.length);
  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(discoveries(backend)).toBe(2 + REDISCOVER_DELAYS_MS.length);
});

test("the looks stop once discovery serves the new CRD", async () => {
  const { backend, snapshot, snapshotFaked } = crdBackend([
    [CRD],
    [CRD],
    [CRD, WIDGETS],
  ]);
  const { shown } = renderReaders(3);
  await act(flush);
  await snapshot([]);
  vi.useFakeTimers();
  await snapshotFaked([WIDGET_CRD]);

  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(discoveries(backend)).toBe(3);
  for (const reader of shown) expect(reader.resources).toEqual([CRD, WIDGETS]);
});

test("unmounting every reader stops the looks", async () => {
  const { backend, snapshot, snapshotFaked } = crdBackend([[CRD]]);
  const { view } = renderReaders(3);
  await act(flush);
  await snapshot([]);
  vi.useFakeTimers();
  await snapshotFaked([WIDGET_CRD]);
  await act(() => vi.advanceTimersByTimeAsync(REDISCOVER_DELAYS_MS[0]));
  const calls = discoveries(backend);
  expect(calls).toBe(3);

  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(discoveries(backend)).toBe(calls);
  expect(backend.callsTo("resources_unsubscribe")).toHaveLength(1);
});

test("the looks go on while one reader is left", async () => {
  const { backend, snapshot, snapshotFaked } = crdBackend([[CRD]]);
  const shown: Shown[] = [];
  const reader = (key: string, index: number) => (
    <Reader key={key} index={index} shown={shown} hook={useClusterResources} />
  );
  const { rerender } = render(
    <>
      {reader("a", 0)}
      {reader("b", 1)}
    </>,
  );
  await act(flush);
  await snapshot([]);
  vi.useFakeTimers();
  await snapshotFaked([WIDGET_CRD]);
  rerender(reader("b", 1));

  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(discoveries(backend)).toBe(2 + REDISCOVER_DELAYS_MS.length);
});

test("a reader that only reads still sees the refreshed resources", async () => {
  const { backend, snapshot } = crdBackend([[CRD], [CRD, WIDGETS]]);
  const watcher = renderHook(() => useClusterResources("c1"));
  const reader = renderHook(() => useDiscovery("c1"));
  await act(flush);
  await snapshot([]);
  await snapshot([WIDGET_CRD]);
  await act(flush);
  expect(discoveries(backend)).toBe(2);
  expect(reader.result.current.resources).toEqual([CRD, WIDGETS]);
  expect(watcher.result.current.resources).toEqual([CRD, WIDGETS]);
});
