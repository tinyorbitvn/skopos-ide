import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NodeDiskSnapshot } from "../../ipc/generated/NodeDiskSnapshot";
import { mockBackend } from "../../test/ipc";
import { NODES_DISK_POLL_MS, useNodesDisk } from "./useNodesDisk";

const SNAPSHOT: NodeDiskSnapshot = {
  timestamp: "2026-11-19T10:00:00Z",
  items: [{ name: "node-1", usedBytes: 30, capacityBytes: 100 }],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("reads the listed nodes now and every 30 s, and asks again only when the names change", async () => {
  const backend = mockBackend({ nodes_disk_usage: () => SNAPSHOT });
  const { result, rerender } = renderHook(
    ({ names }: { names: string[] }) => useNodesDisk("c1", names),
    { initialProps: { names: ["node-1"] } },
  );
  await act(async () => {});
  expect(backend.callsTo("nodes_disk_usage")).toEqual([
    { id: "c1", names: ["node-1"] },
  ]);
  expect(result.current?.items?.get("node-1")?.usedBytes).toBe(30);
  expect(result.current?.forbidden).toBe(false);

  rerender({ names: ["node-1"] });
  await act(async () => {});
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(1);

  await act(async () => {
    vi.advanceTimersByTime(NODES_DISK_POLL_MS);
  });
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(2);

  rerender({ names: ["node-1", "node-2"] });
  await act(async () => {});
  expect(backend.callsTo("nodes_disk_usage").at(-1)).toEqual({
    id: "c1",
    names: ["node-1", "node-2"],
  });
});

test("marks the view forbidden when no kubelet lets us read its summary", async () => {
  mockBackend({
    nodes_disk_usage: () => {
      throw { code: "Forbidden", message: "nodes/proxy is forbidden" };
    },
  });
  const { result } = renderHook(() => useNodesDisk("c1", ["node-1"]));
  await act(async () => {});
  expect(result.current).toEqual({ items: null, forbidden: true });
});

test("reads nothing for a list that is not Nodes", async () => {
  const backend = mockBackend({});
  const { result } = renderHook(() => useNodesDisk("c1", null));
  await act(async () => {});
  expect(result.current).toBeUndefined();
  expect(backend.calls).toEqual([]);
});

test("does not ask the kubelets again while a read is under way", async () => {
  const answers: ((snapshot: NodeDiskSnapshot) => void)[] = [];
  const backend = mockBackend({
    nodes_disk_usage: () =>
      new Promise<NodeDiskSnapshot>((resolve) => {
        answers.push(resolve);
      }),
  });
  const { result } = renderHook(() => useNodesDisk("c1", ["node-1"]));
  await act(async () => {});
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(1);

  await act(async () => {
    vi.advanceTimersByTime(2 * NODES_DISK_POLL_MS);
  });
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(1);

  await act(async () => {
    answers[0]?.(SNAPSHOT);
  });
  expect(result.current?.items?.get("node-1")?.usedBytes).toBe(30);
  await act(async () => {
    vi.advanceTimersByTime(NODES_DISK_POLL_MS);
  });
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(2);
});

test("asks nothing while the window is hidden, and once when it shows again", async () => {
  const backend = mockBackend({ nodes_disk_usage: () => SNAPSHOT });
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  renderHook(() => useNodesDisk("c1", ["node-1"]));
  await act(async () => {});
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(1);

  visibility.mockReturnValue("hidden");
  await act(async () => {
    vi.advanceTimersByTime(3 * NODES_DISK_POLL_MS);
  });
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(1);

  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(2);

  // Showing the window again without a poll missed asks nothing more.
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(2);
});

test("a list opened in a hidden window is read when the window shows", async () => {
  const backend = mockBackend({ nodes_disk_usage: () => SNAPSHOT });
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const { result } = renderHook(() => useNodesDisk("c1", ["node-1"]));
  await act(async () => {});
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(0);

  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(backend.callsTo("nodes_disk_usage")).toHaveLength(1);
  expect(result.current?.items?.get("node-1")?.usedBytes).toBe(30);
});
