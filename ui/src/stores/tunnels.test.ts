import { beforeEach, expect, test } from "vitest";
import type { TunnelPrompt } from "../ipc/generated/TunnelPrompt";
import { emitEvent, mockBackend } from "../test/ipc";
import { tunnel } from "../test/tunnels";
import {
  promptToShow,
  resetTunnelsForTest,
  tunnelOf,
  useTunnels,
} from "./tunnels";

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

function prompt(partial: Partial<TunnelPrompt> = {}): TunnelPrompt {
  return {
    id: "p1",
    tunnel: "t1",
    kind: "password",
    text: "me@bastion's password: ",
    canRemember: true,
    opensAtOnce: false,
    ...partial,
  };
}

test("promptToShow takes the chosen prompt, else one that opens at once, never an answered one", () => {
  const quiet = tunnel({ prompt: prompt() });
  const loud = tunnel({
    id: "t2",
    name: "edge",
    prompt: prompt({ id: "p2", tunnel: "t2", opensAtOnce: true }),
  });
  const tunnels = [quiet, loud];
  expect(promptToShow({ tunnels, asking: null, answered: [] })?.prompt.id).toBe(
    "p2",
  );
  expect(promptToShow({ tunnels, asking: "p1", answered: [] })?.prompt.id).toBe(
    "p1",
  );
  expect(promptToShow({ tunnels, asking: null, answered: ["p2"] })).toBeNull();
  expect(
    promptToShow({ tunnels: null, asking: "p1", answered: [] }),
  ).toBeNull();
});

test("finishPrompt hides the prompt and ends the choice", () => {
  useTunnels.getState().ask("p1");
  expect(useTunnels.getState().asking).toBe("p1");
  useTunnels.getState().finishPrompt("p1");
  expect(useTunnels.getState()).toMatchObject({
    asking: null,
    answered: ["p1"],
  });
});
