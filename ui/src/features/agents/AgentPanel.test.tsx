import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentStatus } from "../../ipc/generated/AgentStatus";
import type { ChatEvent } from "../../ipc/generated/ChatEvent";
import { resetAgentChatForTest, useAgentChat } from "../../stores/agentChat";
import { resetAgentsForTest } from "../../stores/agents";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { clusterEntry, flush, mockBackend } from "../../test/ipc";
import { AgentPanel } from "./AgentPanel";
import { setAgentsSupportedForTest } from "./supported";

type Channel = { onmessage(event: ChatEvent): void };

const SETTINGS = {
  changes: "ask",
  namespaces: null,
  secretValues: false,
  exec: false,
  defaultAgent: null,
  notes: "",
};

const CLAUDE: AgentStatus = {
  id: "claude",
  name: "Claude",
  state: { state: "ready" },
  detail: null,
  hint: null,
  isDefault: true,
  custom: false,
  hosts: [],
};

let channel: Channel | null = null;

function backend(more: Parameters<typeof mockBackend>[0] = {}) {
  return mockBackend({
    agents_status: () => [CLAUDE],
    cluster_agent_settings: () => SETTINGS,
    chat_start: (args: { onEvent: Channel }) => {
      channel = args.onEvent;
      return { chatId: "c1", agent: "claude", canLoad: true };
    },
    chat_close: () => null,
    chat_prompt: () => null,
    chat_list: () => [],
    ...more,
  });
}

async function openOn(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AgentPanel />
    </MemoryRouter>,
  );
  const page = path.match(/^\/cluster\/([^/]+)/)?.[1] ?? null;
  await act(async () => {
    useAgentChat.getState().openPanel(page);
    await flush();
    await flush();
  });
  return screen.getByTestId("agent-panel");
}

beforeEach(() => {
  channel = null;
  resetAgentChatForTest();
  resetAgentsForTest();
  resetCatalogForTest();
  useCatalog.setState({
    clusters: [
      clusterEntry({
        id: "a",
        name: "prod-eu-west",
        state: {
          status: "connected",
          info: { distribution: "", version: "v1.31" },
        } as never,
      }),
      clusterEntry({ id: "b", name: "kind-e2e" }),
    ],
  });
});

afterEach(() => setAgentsSupportedForTest(true));

test("a new chat on a cluster page focuses the box and offers the cluster suggestions", async () => {
  backend();
  const panel = await openOn("/cluster/a/overview");
  expect(within(panel).getByTestId("agent-scope").textContent).toContain(
    "prod-eu-west",
  );
  expect(within(panel).getByTestId("agent-pick").textContent).toContain(
    "Claude",
  );
  expect(within(panel).getByTestId("agent-new-chat-title").textContent).toBe(
    "Ask the agent",
  );
  expect(
    within(panel)
      .getAllByTestId("agent-suggestion")
      .map((b) => b.textContent),
  ).toEqual([
    "Why is a Pod restarting?",
    "What changed in the last hour?",
    "Which Deployments are not ready?",
  ]);
  const box = within(panel).getByTestId("agent-message");
  expect(document.activeElement).toBe(box);
  expect(box.getAttribute("placeholder")).toBe("Ask about prod-eu-west…");
  expect(within(panel).getByTestId("agent-scope-chip").textContent).toBe(
    "prod-eu-west",
  );
});

test("off a cluster page the chat is global with the global suggestions", async () => {
  backend();
  const panel = await openOn("/catalog");
  expect(within(panel).getByTestId("agent-scope").textContent).toContain(
    "All clusters",
  );
  expect(within(panel).getAllByTestId("agent-suggestion")[0]?.textContent).toBe(
    "Which clusters run an old ingress-nginx?",
  );
  expect(
    within(panel).getByTestId("agent-message").getAttribute("placeholder"),
  ).toBe("Ask about your clusters…");
});

test("Enter sends; Shift+Enter, composition and a blank box do not", async () => {
  const ipc = backend();
  const panel = await openOn("/cluster/a/overview");
  const box = within(panel).getByTestId("agent-message");
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.change(box, { target: { value: "Why?" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
  expect(ipc.callsTo("chat_prompt")).toEqual([]);
  expect(within(panel).getByTestId("agent-send").hasAttribute("disabled")).toBe(
    false,
  );
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
  });
  expect(ipc.callsTo("chat_prompt")).toEqual([
    { chatId: "c1", text: "Why?", object: null, tab: null },
  ]);
});

test("while the agent works Send becomes Stop", async () => {
  const ipc = backend({ chat_stop: () => null });
  const panel = await openOn("/cluster/a/overview");
  act(() => channel?.onmessage({ type: "working", working: true }));
  fireEvent.click(within(panel).getByTestId("agent-stop"));
  await waitFor(() =>
    expect(ipc.callsTo("chat_stop")).toEqual([{ chatId: "c1" }]),
  );
  expect(within(panel).queryByTestId("agent-send")).toBeNull();
});

test("a Read only cluster shows the badge and its settings under Details", async () => {
  backend({
    cluster_agent_settings: () => ({
      ...SETTINGS,
      changes: "readOnly",
      namespaces: ["payments", "ingest"],
    }),
  });
  const panel = await openOn("/cluster/a/overview");
  expect(within(panel).getByTestId("agent-read-only").textContent).toBe(
    "Read only",
  );
  fireEvent.click(within(panel).getByTestId("agent-sandbox-details"));
  const list = within(panel).getByRole("list", {
    name: "This cluster's agent settings",
  });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual([
    "Changes: Read only",
    "Namespaces: payments, ingest",
    "Secret values: hidden",
    "Commands in containers: off",
  ]);
  expect(within(panel).getByText("prod-eu-west · 2 namespaces")).toBeTruthy();
});

test("a sandbox that is not ready shows the reason and the section button", async () => {
  backend({
    chat_start: () => {
      throw { code: "Unavailable", message: "The agent sandbox isn't ready." };
    },
    agent_sandbox_status: () => ({
      status: "cannotStart",
      error: "userns denied",
    }),
  });
  const panel = await openOn("/cluster/a/overview");
  const state = within(panel).getByTestId("agent-state");
  expect(state.dataset.kind).toBe("sandbox");
  expect(within(state).getByText("The agent sandbox isn't ready")).toBeTruthy();
  expect(
    within(state).getByText(
      /bubblewrap could not start a sandbox: userns denied/,
    ),
  ).toBeTruthy();
  expect(
    within(state).getByText(/Agents run only inside the sandbox./),
  ).toBeTruthy();
  expect(
    within(state).getByRole("button", { name: "Agent sandbox" }),
  ).toBeTruthy();
  expect(within(panel).queryByTestId("agent-message")).toBeNull();
});

test("Sign in needed offers Try again, which probes and starts again", async () => {
  let signedIn = false;
  const signIn = {
    ...CLAUDE,
    isDefault: false,
    state: { state: "signInNeeded" as const },
    hint: "Run claude.",
  };
  const ipc = backend({
    agents_status: () => [signedIn ? CLAUDE : signIn],
    agent_probe: () => {
      signedIn = true;
      return CLAUDE;
    },
    chat_start: (args: { onEvent: Channel }) => {
      if (!signedIn)
        throw { code: "Unavailable", message: "No agent is ready to chat." };
      channel = args.onEvent;
      return { chatId: "c2", agent: "claude", canLoad: true };
    },
  });
  const panel = await openOn("/cluster/a/overview");
  const state = within(panel).getByTestId("agent-state");
  expect(within(state).getByText("Sign in to Claude")).toBeTruthy();
  expect(
    within(state).getByText("Claude needs you to sign in. Run claude."),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(within(state).getByTestId("agent-retry"));
    await flush();
    await flush();
  });
  expect(ipc.callsTo("agent_probe")).toContainEqual({ id: "claude" });
  expect(within(panel).getByTestId("agent-new-chat-title")).toBeTruthy();
});

test("history lists the scope's chats and an empty one says so", async () => {
  let rows: unknown[] = [];
  backend({ chat_list: () => rows });
  const panel = await openOn("/catalog");
  fireEvent.click(within(panel).getByTestId("agent-history"));
  expect(await within(panel).findByText("No chats yet")).toBeTruthy();
  expect(
    within(panel).getByTestId("agent-history").getAttribute("aria-pressed"),
  ).toBe("true");
  rows = [
    {
      id: "s1",
      title: "Which clusters run an old ingress-nginx?",
      agent: "Claude",
      updated: new Date().toISOString(),
      clusters: 3,
    },
  ];
  fireEvent.click(within(panel).getByTestId("agent-history"));
  fireEvent.click(within(panel).getByTestId("agent-history"));
  const row = await within(panel).findByTestId("agent-history-s1");
  expect(row.textContent).toContain("Claude · Just now · 3 clusters");
});

test("a stored chat that cannot reopen replaces the composer", async () => {
  backend({
    chat_list: () => [
      {
        id: "s1",
        title: "Why?",
        agent: "Codex",
        updated: new Date().toISOString(),
        clusters: 1,
      },
    ],
    chat_get: () => ({
      id: "s1",
      scope: { clusters: ["a"], global: false },
      agent: "codex",
      agentName: "Codex",
      sessionId: "x",
      canLoad: false,
      title: "Why?",
      created: "2026-11-20T10:00:00Z",
      updated: "2026-11-20T10:01:00Z",
      items: [{ id: "u", body: { type: "user", text: "Why?", object: null } }],
    }),
  });
  const panel = await openOn("/cluster/a/overview");
  fireEvent.click(within(panel).getByTestId("agent-history"));
  await act(async () => {
    fireEvent.click(await within(panel).findByTestId("agent-history-s1"));
    await flush();
  });
  expect(within(panel).getByTestId("agent-reopen").textContent).toContain(
    "Codex can't reopen old chats. Start a new chat to continue.",
  );
  expect(within(panel).queryByTestId("agent-message")).toBeNull();
  expect(within(panel).getByText("Why?")).toBeTruthy();
});

test("a disconnected cluster shows the banner with Connect", async () => {
  backend();
  const panel = await openOn("/cluster/b/overview");
  expect(
    within(panel).getByTestId("agent-connect-banner").textContent,
  ).toContain(
    "kind-e2e is not connected. The agent can't read it until you connect.",
  );
  expect(within(panel).getByTestId("agent-connect")).toBeTruthy();
});

test("Escape closes a popover but not the panel", async () => {
  backend();
  const panel = await openOn("/cluster/a/overview");
  fireEvent.click(within(panel).getByTestId("agent-scope"));
  const pop = screen.getByRole("dialog", { name: "Scope" });
  fireEvent.keyDown(pop, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Scope" })).toBeNull();
  expect(screen.getByTestId("agent-panel")).toBeTruthy();
  expect(document.activeElement).toBe(within(panel).getByTestId("agent-scope"));
});

test("on Windows the panel renders nothing", async () => {
  setAgentsSupportedForTest(false);
  backend();
  render(
    <MemoryRouter>
      <AgentPanel />
    </MemoryRouter>,
  );
  act(() => useAgentChat.setState({ open: true }));
  expect(screen.queryByTestId("agent-panel")).toBeNull();
});
