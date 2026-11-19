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
