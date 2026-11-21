import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { VolumeUsageSnapshot } from "../../ipc/generated/VolumeUsageSnapshot";
import { mockBackend } from "../../test/ipc";
import { useVolumeUsage, VOLUMES_POLL_MS } from "./useVolumeUsage";

const SNAPSHOT: VolumeUsageSnapshot = {
  timestamp: "2026-11-21T10:00:00Z",
  items: [
    {
      namespace: "shop",
      claim: "data-1",
      node: "n1",
      usedBytes: 30,
      capacityBytes: 100,
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("asks no kubelet while no node hosts a Pod that mounts a claim", async () => {
  const backend = mockBackend({});
  const { result } = renderHook(() => useVolumeUsage("c1", []));
  await act(async () => {});
  await act(async () => {
    vi.advanceTimersByTime(VOLUMES_POLL_MS);
  });
  expect(result.current).toEqual({ items: [], forbidden: false, error: null });
  expect(backend.calls).toEqual([]);
});

test("reads the nodes now and every 30 s, and asks again only when the nodes change", async () => {
  const backend = mockBackend({ volumes_usage: () => SNAPSHOT });
  const { result, rerender } = renderHook(
    ({ nodes }: { nodes: string[] }) => useVolumeUsage("c1", nodes),
    { initialProps: { nodes: ["n1"] } },
  );
  expect(result.current.items).toBeNull();
  await act(async () => {});
  expect(backend.callsTo("volumes_usage")).toEqual([
    { id: "c1", nodes: ["n1"] },
  ]);
  expect(result.current).toEqual({
    items: SNAPSHOT.items,
    forbidden: false,
    error: null,
  });

  rerender({ nodes: ["n1"] });
  await act(async () => {});
  expect(backend.callsTo("volumes_usage")).toHaveLength(1);

  await act(async () => {
    vi.advanceTimersByTime(VOLUMES_POLL_MS);
  });
  await act(async () => {});
  expect(backend.callsTo("volumes_usage")).toHaveLength(2);

  rerender({ nodes: ["n1", "n2"] });
  await act(async () => {});
  expect(backend.callsTo("volumes_usage").at(-1)).toEqual({
    id: "c1",
    nodes: ["n1", "n2"],
  });

  // No node left: no call, and no item.
  rerender({ nodes: [] });
  await act(async () => {
    vi.advanceTimersByTime(VOLUMES_POLL_MS);
  });
  expect(backend.callsTo("volumes_usage")).toHaveLength(3);
  expect(result.current.items).toEqual([]);
});

test("marks the view forbidden by the error's code, whatever its message", async () => {
  mockBackend({
    volumes_usage: () => {
      throw {
        code: "Forbidden",
        message:
          "You have no access to nodes/proxy, so the claims' volume stats cannot be read.",
        details: "HTTP 403",
      };
    },
  });
  const { result } = renderHook(() => useVolumeUsage("c1", ["n1"]));
  await act(async () => {});
  expect(result.current).toEqual({ items: null, forbidden: true, error: null });
});

test("a failure of another code is an error, even when its message names nodes/proxy", async () => {
  mockBackend({
    volumes_usage: () => {
      throw {
        code: "Internal",
        message: "nodes/proxy answered with a summary that is not JSON",
      };
    },
  });
  const { result } = renderHook(() => useVolumeUsage("c1", ["n1"]));
  await act(async () => {});
  expect(result.current).toEqual({
    items: null,
    forbidden: false,
    error: "nodes/proxy answered with a summary that is not JSON",
  });
});

test("keeps the message of any other failure, and drops it on the next good read", async () => {
  let fail = true;
  mockBackend({
    volumes_usage: () => {
      if (fail) {
        throw { code: "Unreachable", message: "the API server did not answer" };
      }
      return SNAPSHOT;
    },
  });
  const { result } = renderHook(() => useVolumeUsage("c1", ["n1"]));
  await act(async () => {});
  expect(result.current).toEqual({
    items: null,
    forbidden: false,
    error: "the API server did not answer",
  });

  fail = false;
  await act(async () => {
    vi.advanceTimersByTime(VOLUMES_POLL_MS);
  });
  await act(async () => {});
  expect(result.current).toEqual({
    items: SNAPSHOT.items,
    forbidden: false,
    error: null,
  });
});

test("asks nothing while the window is hidden, and once when it shows again", async () => {
  const backend = mockBackend({ volumes_usage: () => SNAPSHOT });
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  renderHook(() => useVolumeUsage("c1", ["n1"]));
  await act(async () => {});
  expect(backend.callsTo("volumes_usage")).toHaveLength(1);

  visibility.mockReturnValue("hidden");
  await act(async () => {
    vi.advanceTimersByTime(3 * VOLUMES_POLL_MS);
  });
  expect(backend.callsTo("volumes_usage")).toHaveLength(1);

  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(backend.callsTo("volumes_usage")).toHaveLength(2);
});
