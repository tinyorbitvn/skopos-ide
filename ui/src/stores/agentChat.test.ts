import { act } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { AgentStatus } from "../ipc/generated/AgentStatus";
import type { ChatEvent } from "../ipc/generated/ChatEvent";
import type { EditorTab } from "../ipc/generated/EditorTab";
import { clusterEntry, flush, mockBackend } from "../test/ipc";
import { proposal } from "../test/proposals";
import {
  resetAgentChatForTest,
  type TabAskResult,
  useAgentChat,
} from "./agentChat";
import { resetAgentsForTest } from "./agents";
import { resetCatalogForTest, useCatalog } from "./catalog";
import { resetProposalsForTest, useProposals } from "./proposals";
import { registerTabSource, resetTabSourcesForTest } from "./tabSources";

type Channel = { onmessage(event: ChatEvent): void };

const SETTINGS = {
  changes: "ask",
  namespaces: null,
  secretValues: false,
  exec: false,
  defaultAgent: null,
  notes: "",
};

function row(partial: Partial<AgentStatus>): AgentStatus {
  return {
    id: "claude",
    name: "Claude",
    state: { state: "ready" },
    detail: null,
    hint: null,
    isDefault: true,
    custom: false,
    hosts: [],
    ...partial,
  };
}

function agentItem(id: string, text: string): ChatEvent {
  return { type: "item", item: { id, body: { type: "agent", text } } };
}

function catalog(names: Record<string, string>): void {
  useCatalog.setState({
    clusters: Object.entries(names).map(([id, name]) =>
      clusterEntry({ id, name }),
    ),
  });
}

/** A backend whose chat_start hands its channel to the test. */
function backend(more: Parameters<typeof mockBackend>[0] = {}) {
  const channels: Channel[] = [];
  let next = 0;
  const ipc = mockBackend({
    agents_status: () => [row({})],
    cluster_agent_settings: () => SETTINGS,
    chat_start: (args: { onEvent: Channel }) => {
      channels.push(args.onEvent);
      next += 1;
      return { chatId: `c${next}`, agent: "claude", canLoad: true };
    },
    chat_close: () => null,
    chat_prompt: () => null,
    ...more,
  });
  return { ipc, channels };
}

beforeEach(() => {
  resetAgentChatForTest();
  resetAgentsForTest();
  resetCatalogForTest();
  resetProposalsForTest();
  resetTabSourcesForTest();
});

test("opening on a cluster page starts a chat on that cluster and shows its items", async () => {
  catalog({ a: "prod", b: "dev" });
  const { ipc, channels } = backend();
  await act(async () => {
    useAgentChat.getState().openPanel("b");
    await flush();
  });
  expect(ipc.callsTo("chat_start")[0]).toMatchObject({
    scope: { clusters: ["b"], global: false },
    agent: null,
    continueChat: null,
  });
  expect(useAgentChat.getState().start).toEqual({
    phase: "running",
    chatId: "c1",
  });
  expect(useAgentChat.getState().agentName).toBe("Claude");
  act(() => {
    channels[0]?.onmessage(agentItem("1", "Hel"));
    channels[0]?.onmessage(agentItem("1", "Hello"));
    channels[0]?.onmessage({ type: "working", working: true });
  });
  expect(useAgentChat.getState().items).toEqual([
    { id: "1", body: { type: "agent", text: "Hello" } },
  ]);
  expect(useAgentChat.getState().busy).toBe(true);
});

test("a start that resolves after a newer one is closed and its events are dropped", async () => {
  catalog({ a: "prod" });
  const resolvers: ((info: unknown) => void)[] = [];
  const channels: Channel[] = [];
  const ipc = mockBackend({
    agents_status: () => [row({})],
    cluster_agent_settings: () => SETTINGS,
    chat_start: (args: { onEvent: Channel }) => {
      channels.push(args.onEvent);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    chat_close: () => null,
  });
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
    void useAgentChat.getState().newChat(null);
    await flush();
  });
  expect(resolvers).toHaveLength(2);
  await act(async () => {
    resolvers[1]?.({ chatId: "new", agent: "claude", canLoad: true });
    await flush();
    resolvers[0]?.({ chatId: "old", agent: "claude", canLoad: true });
    await flush();
  });
  expect(useAgentChat.getState().start).toEqual({
    phase: "running",
    chatId: "new",
  });
  expect(ipc.callsTo("chat_close")).toContainEqual({ chatId: "old" });
  act(() => channels[0]?.onmessage(agentItem("x", "from the old chat")));
  expect(useAgentChat.getState().items).toEqual([]);
});

test("no cluster left shows No clusters yet without starting", async () => {
  catalog({});
  const { ipc } = backend();
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
  });
  expect(useAgentChat.getState().start).toEqual({
    phase: "failed",
    failure: { kind: "noClusters" },
  });
  expect(ipc.callsTo("chat_start")).toEqual([]);
});

test("unknown agents are probed before a start that names none", async () => {
  catalog({ a: "prod" });
  let rows = [row({ state: { state: "unknown" }, isDefault: false })];
  const { ipc } = backend({
    agents_status: () => rows,
    agent_probe: () => {
      rows = [row({})];
      return rows[0];
    },
  });
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
    await flush();
  });
  const order = ipc.calls
    .map((c) => c.cmd)
    .filter((c) => c.startsWith("agent_probe") || c === "chat_start");
  expect(order).toEqual(["agent_probe", "chat_start"]);
});

test("a sandbox refusal shows the sandbox state with the reason", async () => {
  catalog({ a: "prod" });
  backend({
    chat_start: () => {
      throw { code: "Unavailable", message: "The agent sandbox isn't ready." };
    },
    agent_sandbox_status: () => ({ status: "notInstalled" }),
  });
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
    await flush();
  });
  expect(useAgentChat.getState().start).toEqual({
    phase: "failed",
    failure: {
      kind: "sandbox",
      reason:
        "bubblewrap is not installed. Install the bwrap command, then check again.",
    },
  });
});

test("No agent is ready with an agent that needs sign-in shows Sign in", async () => {
  catalog({ a: "prod" });
  backend({
    agents_status: () => [
      row({
        isDefault: false,
        state: { state: "signInNeeded" },
        hint: "Run claude.",
      }),
    ],
    chat_start: () => {
      throw { code: "Unavailable", message: "No agent is ready to chat." };
    },
  });
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
    await flush();
  });
  expect(useAgentChat.getState().start).toEqual({
    phase: "failed",
    failure: {
      kind: "signIn",
      agentId: "claude",
      agent: "Claude",
      hint: "Run claude.",
    },
  });
});

test("a picked agent that is not installed shows Not installed", async () => {
  catalog({ a: "prod" });
  let rows = [row({}), row({ id: "codex", name: "Codex", isDefault: false })];
  backend({
    agents_status: () => rows,
    chat_start: (args: { agent: string | null }) => {
      if (args.agent === "codex") {
        rows = [
          row({}),
          row({
            id: "codex",
            name: "Codex",
            isDefault: false,
            state: { state: "notInstalled" },
          }),
        ];
        throw { code: "Unavailable", message: "Codex is not installed." };
      }
      return { chatId: "c1", agent: "claude", canLoad: true };
    },
  });
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
    await useAgentChat.getState().pickAgent("codex");
    await flush();
  });
  expect(useAgentChat.getState().start).toEqual({
    phase: "failed",
    failure: { kind: "notInstalled", agentId: "codex", agent: "Codex" },
  });
});

test("send clears the box and the object; a failed send puts them back", async () => {
  catalog({ a: "prod" });
  let fail = false;
  const { ipc } = backend({
    chat_prompt: () => {
      if (fail)
        throw { code: "Conflict", message: "The agent is still answering." };
      return null;
    },
  });
  const object = { cluster: "a", kind: "Pod", namespace: "ns", name: "p" };
  await act(async () => {
    await useAgentChat.getState().askAbout(object);
    await flush();
  });
  expect(useAgentChat.getState().object).toEqual(object);
  useAgentChat.getState().setDraft("  Why?  ");
  await act(() => useAgentChat.getState().send());
  expect(ipc.callsTo("chat_prompt")).toEqual([
    { chatId: "c1", text: "Why?", object, tab: null },
  ]);
  expect(useAgentChat.getState()).toMatchObject({
    draft: "",
    object: null,
    busy: false,
  });
  fail = true;
  useAgentChat.getState().setDraft("Again");
  await act(() => useAgentChat.getState().send());
  expect(useAgentChat.getState().draft).toBe("Again");
});

test("a blank box or a busy agent sends nothing", async () => {
  catalog({ a: "prod" });
  const { ipc, channels } = backend();
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
  });
  useAgentChat.getState().setDraft("   ");
  await act(() => useAgentChat.getState().send());
  act(() => channels[0]?.onmessage({ type: "working", working: true }));
  useAgentChat.getState().setDraft("Hi");
  await act(() => useAgentChat.getState().send());
  expect(ipc.callsTo("chat_prompt")).toEqual([]);
});

test("Undo ends the standing approval of the card's cluster by id", async () => {
  catalog({ a: "prod", b: "prod" });
  const { ipc } = backend({ chat_undo_standing: () => null });
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
  });
  const card = {
    id: "k1",
    cluster: "prod (2)",
    title: "Change Deployment ns/web",
    summary: "",
    diff: [],
    command: null,
    secrets: [],
    state: { state: "approved" as const, at: "14:02", standing: true },
    result: null,
    rollout: null,
    output: null,
  };
  act(() =>
    useAgentChat.setState({
      items: [{ id: "k1", body: { type: "change", card } }],
    }),
  );
  await act(() => useAgentChat.getState().undo(card));
  expect(ipc.callsTo("chat_undo_standing")).toEqual([
    { chatId: "c1", clusterId: "b" },
  ]);
  expect(useAgentChat.getState().undone).toEqual(["k1"]);
});

test("a stored chat that can load continues; one that cannot shows the reopen bar", async () => {
  catalog({ a: "prod" });
  const stored = (canLoad: boolean) => ({
    id: "s1",
    scope: { clusters: ["a"], global: false },
    agent: "claude",
    agentName: "Claude",
    sessionId: "x",
    canLoad,
    title: "Why?",
    created: "2026-11-20T10:00:00Z",
    updated: "2026-11-20T10:01:00Z",
    items: [{ id: "u", body: { type: "user", text: "Why?", object: null } }],
  });
  let canLoad = true;
  const { ipc } = backend({ chat_get: () => stored(canLoad) });
  await act(async () => {
    useAgentChat.getState().openPanel(null);
    await flush();
    await useAgentChat.getState().openStored("s1");
    await flush();
  });
  expect(ipc.callsTo("chat_start").at(-1)).toMatchObject({
    agent: "claude",
    continueChat: "s1",
  });
  expect(useAgentChat.getState().items).toHaveLength(1);
  canLoad = false;
  await act(async () => {
    await useAgentChat.getState().openStored("s1");
    await flush();
  });
  expect(useAgentChat.getState()).toMatchObject({
    start: { phase: "ended" },
    cannotReopen: "Claude",
  });
});

function createTab(yaml: string): EditorTab {
  return {
    tabId: "create-1",
    title: "Create",
    cluster: "a",
    mode: "create",
    yaml,
    target: null,
    defaultNamespace: "default",
  };
}

test("asking from a tab starts a chat on its cluster and sends the tab with the text", async () => {
  catalog({ a: "prod" });
  const { ipc } = backend();
  registerTabSource("create-1", async () => createTab("kind: Pod\n"));
  let result: TabAskResult | undefined;
  await act(async () => {
    result = await useAgentChat
      .getState()
      .askFromTab("create-1", "add a container");
    await flush();
  });
  expect(result).toBe("sent");
  expect(useAgentChat.getState().open).toBe(true);
  expect(ipc.callsTo("chat_start")[0]).toMatchObject({
    scope: { clusters: ["a"], global: false },
  });
  expect(ipc.callsTo("chat_prompt")[0]).toMatchObject({
    chatId: "c1",
    text: "add a container",
    object: null,
    tab: createTab("kind: Pod\n"),
  });
  expect(useAgentChat.getState().tab).toEqual({
    tabId: "create-1",
    title: "Create",
  });
});

test("while the tab is attached, the panel's messages carry its current text", async () => {
  catalog({ a: "prod" });
  const { ipc } = backend();
  let yaml = "kind: Pod\n";
  registerTabSource("create-1", async () => createTab(yaml));
  await act(async () => {
    await useAgentChat.getState().askFromTab("create-1", "first");
  });
  yaml = "kind: Pod\nmetadata: {}\n";
  await act(async () => {
    await useAgentChat.getState().send("second");
  });
  expect(ipc.callsTo("chat_prompt")[1]).toMatchObject({
    text: "second",
    tab: createTab(yaml),
  });
});

test("a refused prompt gives the message and attaches nothing", async () => {
  catalog({ a: "prod" });
  backend({
    chat_prompt: () => {
      throw {
        code: "InvalidInput",
        message: "The agent may not read namespace payments on prod.",
      };
    },
  });
  registerTabSource("create-1", async () => createTab(""));
  let result: TabAskResult | undefined;
  await act(async () => {
    result = await useAgentChat.getState().askFromTab("create-1", "go");
  });
  expect(result).toEqual({
    failed: "The agent may not read namespace payments on prod.",
  });
  expect(useAgentChat.getState().tab).toBeNull();
});

test("a proposal item reaches the proposals store", async () => {
  catalog({ a: "prod" });
  const { channels } = backend();
  await act(async () => {
    useAgentChat.getState().openPanel("a");
    await flush();
  });
  act(() => {
    channels[0]?.onmessage({
      type: "item",
      item: { id: "i1", body: { type: "proposal", card: proposal() } },
    });
  });
  expect(useProposals.getState().byTab["create-1"]?.chatId).toBe("c1");
});
