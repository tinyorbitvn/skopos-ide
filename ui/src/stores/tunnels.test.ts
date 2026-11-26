import { beforeEach, expect, test } from "vitest";
import { emitEvent, mockBackend } from "../test/ipc";
import { tunnel } from "../test/tunnels";
import { resetTunnelsForTest, tunnelOf, useTunnels } from "./tunnels";

beforeEach(() => resetTunnelsForTest());

test("load subscribes and reads the list once", async () => {
  const backend = mockBackend({ tunnel_list: () => [tunnel()] });
  await useTunnels.getState().load();
  await useTunnels.getState().load();
  expect(backend.callsTo("tunnel_list")).toHaveLength(1);
  expect(useTunnels.getState()).toMatchObject({
    tunnels: [tunnel()],
    error: null,
  });
});

test("a change event reads the list again", async () => {
  let name = "corp";
  mockBackend({ tunnel_list: () => [tunnel({ name })] });
  await useTunnels.getState().load();
  name = "edge";
  await emitEvent("tunnels://changed", null);
  expect(useTunnels.getState().tunnels?.[0].name).toBe("edge");
});

test("a failed read keeps its message until retry succeeds", async () => {
  let fail = true;
  mockBackend({
    tunnel_list: () => {
      if (fail) throw new Error("store unreadable");
      return [];
    },
  });
  await useTunnels.getState().load();
  expect(useTunnels.getState().error).toContain("store unreadable");
  fail = false;
  await useTunnels.getState().retry();
  expect(useTunnels.getState()).toMatchObject({ tunnels: [], error: null });
});

test("tunnelOf finds the tunnel a cluster picked", () => {
  expect(tunnelOf([tunnel()], "t1")?.name).toBe("corp");
  expect(tunnelOf([tunnel()], "gone")).toBeNull();
  expect(tunnelOf(null, "t1")).toBeNull();
  expect(tunnelOf([tunnel()], null)).toBeNull();
});
