import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetAgentsForTest } from "../../stores/agents";
import { mockBackend } from "../../test/ipc";
import { AgentSandboxSection } from "./AgentSandboxSection";

const PREFS = {
  defaultAgent: null,
  custom: [],
  domains: ["corp.example"],
  folders: [],
};
const CLAUDE = {
  id: "claude",
  name: "Claude",
  state: { state: "ready" },
  detail: "/usr/bin/claude",
  hint: null,
  isDefault: true,
  custom: false,
  hosts: ["api.anthropic.com", "claude.ai"],
};
const CODEX = {
  ...CLAUDE,
  id: "codex",
  name: "Codex",
  state: { state: "notInstalled" },
  detail: null,
  hosts: ["api.openai.com"],
};

beforeEach(() => resetAgentsForTest());

test("shows a ready sandbox, the installed agents' hosts and the person's domains", async () => {
  mockBackend({
    agent_sandbox_status: () => ({ status: "ready", kind: "bubblewrap" }),
    agents_status: () => [CLAUDE, CODEX],
    agent_prefs: () => PREFS,
  });
  render(<AgentSandboxSection />);
  expect(await screen.findByText("Sandbox ready")).toBeTruthy();
  expect(screen.getByText("bubblewrap")).toBeTruthy();
  expect(await screen.findByText("api.anthropic.com · Claude")).toBeTruthy();
  expect(screen.getByText("claude.ai · Claude")).toBeTruthy();
  // Codex is not installed, so its hosts are not listed.
  expect(screen.queryByText("api.openai.com · Codex")).toBeNull();
  expect(screen.getByText("corp.example")).toBeTruthy();
});

test("a sandbox that cannot start shows the reason and Check again refreshes it", async () => {
  let status: unknown = { status: "cannotStart", error: "userns denied" };
  const ipc = mockBackend({
    agent_sandbox_status: () => status,
    agents_status: () => [],
    agent_prefs: () => PREFS,
  });
  render(<AgentSandboxSection />);
  expect(await screen.findByText("Sandbox not available")).toBeTruthy();
  expect(
    screen.getByText("bubblewrap could not start a sandbox: userns denied"),
  ).toBeTruthy();
  status = { status: "ready", kind: "bubblewrap" };
  fireEvent.click(screen.getByTestId("pref-sandbox-check"));
  expect(await screen.findByText("Sandbox ready")).toBeTruthy();
  expect(ipc.callsTo("agent_sandbox_status")).toEqual([
    { refresh: false },
    { refresh: true },
  ]);
});

test("adding a domain shows the core's refusal under the field", async () => {
  mockBackend({
    agent_sandbox_status: () => ({ status: "ready", kind: "bubblewrap" }),
    agents_status: () => [],
    agent_prefs: () => PREFS,
    agent_domain_add: () => {
      throw {
        code: "InvalidInput",
        message: "Enter a domain such as example.com",
      };
    },
  });
  render(<AgentSandboxSection />);
  const input = await screen.findByTestId("pref-domain-input");
  fireEvent.change(input, { target: { value: "10.0.0.1" } });
  fireEvent.click(screen.getByTestId("pref-domain-add"));
  expect(
    await screen.findByText("Enter a domain such as example.com"),
  ).toBeTruthy();
});

test("a folder is added and removed", async () => {
  let prefs = { ...PREFS, folders: [] as string[] };
  mockBackend({
    agent_sandbox_status: () => ({ status: "ready", kind: "bubblewrap" }),
    agents_status: () => [],
    agent_prefs: () => prefs,
    agent_folder_add: ({ folder }: { folder: string }) => {
      prefs = { ...prefs, folders: [folder] };
      return prefs;
    },
    agent_folder_remove: () => {
      prefs = { ...prefs, folders: [] };
      return prefs;
    },
  });
  render(<AgentSandboxSection />);
  fireEvent.change(await screen.findByTestId("pref-folder-input"), {
    target: { value: "~/src" },
  });
  fireEvent.click(screen.getByTestId("pref-folder-add"));
  const rows = await screen.findByTestId("pref-folders");
  expect(within(rows).getByText("~/src")).toBeTruthy();
  fireEvent.click(within(rows).getByRole("button", { name: "Remove ~/src" }));
  await waitFor(() => expect(within(rows).queryByText("~/src")).toBeNull());
});
