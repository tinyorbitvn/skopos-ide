import { beforeEach, expect, test } from "vitest";
import type { AgentStatus } from "../ipc/generated/AgentStatus";
import { mockBackend } from "../test/ipc";
import { resetAgentsForTest, useAgents } from "./agents";

function row(partial: Partial<AgentStatus>): AgentStatus {
  return {
    id: "claude",
    name: "Claude",
    state: { state: "unknown" },
    detail: "/usr/bin/claude-agent-acp",
    hint: null,
    isDefault: false,
    custom: false,
    hosts: [],
    ...partial,
  };
}

beforeEach(() => resetAgentsForTest());

test("probeUnknown probes each unknown agent once, also when asked twice", async () => {
  let rows = [
    row({ id: "claude" }),
    row({ id: "codex", name: "Codex", state: { state: "notInstalled" } }),
  ];
  const ipc = mockBackend({
    agents_status: () => rows,
    agent_probe: ({ id }: { id: string }) => {
      rows = rows.map((r) =>
        r.id === id ? { ...r, state: { state: "ready" }, isDefault: true } : r,
      );
      return rows.find((r) => r.id === id);
    },
  });
  await useAgents.getState().load();
  await Promise.all([
    useAgents.getState().probeUnknown(),
    useAgents.getState().probeUnknown(),
  ]);
  expect(ipc.callsTo("agent_probe")).toEqual([{ id: "claude" }]);
  expect(useAgents.getState().statuses?.[0]).toMatchObject({
    state: { state: "ready" },
    isDefault: true,
  });
  expect(useAgents.getState().probing).toEqual({});
});

test("add appends the agent, then probes it", async () => {
  const added = row({ id: "custom-0a1b2c3d", name: "Mine", custom: true });
  let rows = [row({ id: "claude", state: { state: "ready" } })];
  const ipc = mockBackend({
    agents_status: () => rows,
    agent_custom_add: () => {
      rows = [...rows, added];
      return added;
    },
    agent_probe: () => ({ ...added, state: { state: "ready" } }),
  });
  await useAgents.getState().load();
  await useAgents.getState().add("Mine", "my-agent --acp");
  expect(ipc.callsTo("agent_custom_add")).toEqual([
    { name: "Mine", command: "my-agent --acp" },
  ]);
  expect(ipc.callsTo("agent_probe")).toEqual([{ id: "custom-0a1b2c3d" }]);
  expect(useAgents.getState().statuses?.map((r) => r.id)).toEqual([
    "claude",
    "custom-0a1b2c3d",
  ]);
});

test("add rejects with the core's message and adds nothing", async () => {
  mockBackend({
    agents_status: () => [],
    agent_custom_add: () => {
      throw { code: "InvalidInput", message: "No such command: nope" };
    },
  });
  await useAgents.getState().load();
  await expect(useAgents.getState().add("X", "nope")).rejects.toThrow(
    "No such command: nope",
  );
  expect(useAgents.getState().statuses).toEqual([]);
});

test("a failed load keeps the message", async () => {
  mockBackend({
    agents_status: () => {
      throw { code: "Internal", message: "broken" };
    },
  });
  await useAgents.getState().load();
  expect(useAgents.getState().error).toBe("broken");
});
