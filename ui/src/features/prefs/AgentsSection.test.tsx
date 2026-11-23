import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { AgentStatus } from "../../ipc/generated/AgentStatus";
import { resetAgentsForTest } from "../../stores/agents";
import { mockBackend } from "../../test/ipc";
import { AgentsSection } from "./AgentsSection";

function row(partial: Partial<AgentStatus>): AgentStatus {
  return {
    id: "claude",
    name: "Claude",
    state: { state: "ready" },
    detail: "/usr/bin/claude · ACP adapter claude-agent-acp",
    hint: null,
    isDefault: false,
    custom: false,
    hosts: [],
    ...partial,
  };
}

beforeEach(() => resetAgentsForTest());

test("lists each agent with its state, detail, hint and actions", async () => {
  mockBackend({
    agents_status: () => [
      row({ isDefault: true }),
      row({
        id: "codex",
        name: "Codex",
        state: { state: "signInNeeded" },
        detail: "/usr/bin/codex · ACP adapter codex-acp",
        hint: "Run codex login in a terminal, then check again.",
      }),
      row({ id: "gemini", name: "Gemini CLI", state: { state: "ready" } }),
      row({
        id: "custom-0a1b2c3d",
        name: "Mine",
        custom: true,
        state: { state: "doesNotStart", reason: "exit 1" },
        hint: "exit 1",
      }),
    ],
  });
  render(<AgentsSection />);
  const claude = await screen.findByTestId("pref-agent-claude");
  expect(within(claude).getByText("Default")).toBeTruthy();
  expect(within(claude).queryByText("Check again")).toBeNull();
  const codex = screen.getByTestId("pref-agent-codex");
  expect(within(codex).getByText("Sign in needed")).toBeTruthy();
  expect(
    within(codex).getByText("Run codex login in a terminal, then check again."),
  ).toBeTruthy();
  expect(within(codex).getByText("Check again")).toBeTruthy();
  expect(
    within(screen.getByTestId("pref-agent-gemini")).getByText("Make default"),
  ).toBeTruthy();
  const mine = screen.getByTestId("pref-agent-custom-0a1b2c3d");
  expect(within(mine).getByText("Doesn't start")).toBeTruthy();
  expect(
    within(mine).getByRole("button", { name: "Remove Mine" }),
  ).toBeTruthy();
});

test("opening the section probes the unknown agents", async () => {
  const ipc = mockBackend({
    agents_status: () => [row({ state: { state: "unknown" } })],
    agent_probe: () => row({ state: { state: "ready" } }),
  });
  render(<AgentsSection />);
  await waitFor(() =>
    expect(ipc.callsTo("agent_probe")).toEqual([{ id: "claude" }]),
  );
});

test("Make default saves and reloads", async () => {
  let rows = [
    row({ isDefault: true }),
    row({ id: "gemini", name: "Gemini CLI" }),
  ];
  const ipc = mockBackend({
    agents_status: () => rows,
    agent_default_set: ({ id }: { id: string }) => {
      rows = rows.map((r) => ({ ...r, isDefault: r.id === id }));
      return null;
    },
  });
  render(<AgentsSection />);
  fireEvent.click(await screen.findByTestId("pref-agent-default-gemini"));
  await waitFor(() =>
    expect(
      within(screen.getByTestId("pref-agent-gemini")).getByText("Default"),
    ).toBeTruthy(),
  );
  expect(ipc.callsTo("agent_default_set")).toEqual([{ id: "gemini" }]);
});

test("the add dialog checks for blanks and shows the core's error", async () => {
  mockBackend({
    agents_status: () => [row({})],
    agent_custom_add: () => {
      throw { code: "InvalidInput", message: "No such command: my-agent" };
    },
  });
  render(<AgentsSection />);
  fireEvent.click(await screen.findByTestId("pref-agent-add"));
  const dialog = await screen.findByTestId("agent-add-dialog");
  fireEvent.click(within(dialog).getByTestId("agent-add-submit"));
  expect(
    await within(dialog).findByText("Enter a name and a command."),
  ).toBeTruthy();
  fireEvent.change(within(dialog).getByTestId("agent-add-name"), {
    target: { value: "My agent" },
  });
  fireEvent.change(within(dialog).getByTestId("agent-add-command"), {
    target: { value: "my-agent --acp" },
  });
  fireEvent.click(within(dialog).getByTestId("agent-add-submit"));
  expect(
    await within(dialog).findByText("No such command: my-agent"),
  ).toBeTruthy();
});

test("a failed read shows the error with Try again", async () => {
  mockBackend({
    agents_status: () => {
      throw { code: "Internal", message: "broken" };
    },
  });
  render(<AgentsSection />);
  expect(await screen.findByText("broken")).toBeTruthy();
});
