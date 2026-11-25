import { create } from "zustand";
import { toast } from "../design";
import {
  CANNOT_REOPEN_SUFFIX,
  clusterIdsByName,
  failureFromRow,
  NO_AGENT,
  nextScope,
  type StartFailure,
  withItem,
} from "../features/agents/chatModel";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { ChangeAnswer } from "../ipc/generated/ChangeAnswer";
import type { ChangeCard } from "../ipc/generated/ChangeCard";
import type { ChatEvent } from "../ipc/generated/ChatEvent";
import type { ChatItem } from "../ipc/generated/ChatItem";
import type { ChatScope } from "../ipc/generated/ChatScope";
import type { ChatSummary } from "../ipc/generated/ChatSummary";
import type { ClusterAgentSettings } from "../ipc/generated/ClusterAgentSettings";
import type { EditorTab } from "../ipc/generated/EditorTab";
import type { ObjectRef } from "../ipc/generated/ObjectRef";
import type { TabChip } from "../ipc/generated/TabChip";
import { useAgents } from "./agents";
import { useCatalog } from "./catalog";
import { useProposals } from "./proposals";
import { tabSource } from "./tabSources";

export type StartState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; chatId: string }
  | { phase: "failed"; failure: StartFailure }
  /** The agent exited, or a stored chat that cannot continue. */
  | { phase: "ended" };

export interface AgentChatState {
  open: boolean;
  view: "chat" | "history";
  scope: ChatScope | null;
  /** The agent picked in the agent popover; new chats keep it. */
  picked: string | null;
  /** The shown chat's agent (id and name). */
  agentId: string | null;
  agentName: string | null;
  start: StartState;
  items: ChatItem[];
  /** The agent runs a turn (`working` events, or a prompt in flight). */
  busy: boolean;
  /** The agent's name when a stored chat cannot continue (§3.4). */
  cannotReopen: string | null;
  object: ObjectRef | null;
  draft: string;
  /** Change cards whose standing approval was undone. */
  undone: string[];
  /** Items read from a stored chat: their change cards show no rollout line (P10). */
  past: string[];
  history: {
    loading: boolean;
    error: string | null;
    rows: ChatSummary[] | null;
  };
  /** The per-cluster scope's agent settings. */
  clusterSettings: ClusterAgentSettings | null;
  /** The object the drawer shows, for the palette's ask command. */
  drawerObject: ObjectRef | null;
  /** The YAML tab this chat holds; its messages carry it (YAML authoring spec A6). */
  tab: TabChip | null;
  toggle(page: string | null): void;
  openPanel(page: string | null): void;
  closePanel(): void;
  newChat(page: string | null): Promise<void>;
  setScope(scope: ChatScope): Promise<void>;
  pickAgent(id: string): Promise<void>;
  askAbout(object: ObjectRef): Promise<void>;
  askFromTab(tabId: string, text: string): Promise<TabAskResult>;
  retry(): Promise<void>;
  send(text?: string): Promise<void>;
  stop(): Promise<void>;
  answer(cardId: string, answer: ChangeAnswer): Promise<void>;
  undo(card: ChangeCard): Promise<void>;
  showHistory(on: boolean): void;
  loadHistory(): Promise<void>;
  openStored(id: string): Promise<void>;
  setDraft(text: string): void;
  removeObject(): void;
  setDrawerObject(object: ObjectRef | null): void;
}

const INITIAL = {
  open: false,
  view: "chat" as const,
  scope: null,
  picked: null,
  agentId: null,
  agentName: null,
  start: { phase: "idle" } as StartState,
  items: [],
  busy: false,
  cannotReopen: null,
  object: null,
  draft: "",
  undone: [],
  past: [],
  history: { loading: false, error: null, rows: null },
  clusterSettings: null,
  drawerObject: null,
  tab: null,
};

/** Bumped by every start; work of an older start sees a newer number and stops (P7). */
let generation = 0;

const ignore = () => {};

const STILL_ANSWERING = "The agent is still answering.";

export type TabAskResult = "sent" | "notStarted" | { failed: string };

export function runningChatId(state: { start: StartState }): string | null {
  return state.start.phase === "running" ? state.start.chatId : null;
}

function catalogIds(): string[] {
  return useCatalog.getState().clusters.map((c) => c.id);
}

export const useAgentChat = create<AgentChatState>((set, get) => {
  function onEvent(gen: number, event: ChatEvent): void {
    if (gen !== generation) return;
    switch (event.type) {
      case "item":
        if (event.item.body.type === "proposal") {
          const chatId = runningChatId(get());
          if (chatId)
            useProposals.getState().receive(chatId, event.item.body.card);
        }
        set((s) => ({ items: withItem(s.items, event.item) }));
        break;
      case "working":
        set({ busy: event.working });
        break;
      case "closed":
        set({ start: { phase: "ended" }, busy: false });
        break;
    }
  }

  /** The start failure for the core's message (P5). */
  async function failureOf(
    message: string,
    expected: string | null,
  ): Promise<StartFailure> {
    const agents = useAgents.getState();
    const rows = (await agents.load()) ?? [];
    if (message === NO_AGENT) {
      const row =
        rows.find((r) => r.state.state === "signInNeeded") ??
        rows.find((r) => r.state.state === "doesNotStart");
      return row ? failureFromRow(row, message) : { kind: "noAgent" };
    }
    return failureFromRow(
      rows.find((r) => r.id === expected),
      message,
    );
  }

  /**
   * Starts a chat on `scope` (P3), closing the shown one. `agent` null lets the core pick
   * the cluster's or the app's default; `continueChat` continues a stored chat whose items
   * are already shown.
   */
  async function begin(
    scope: ChatScope | null,
    options: {
      agent?: string | null;
      continueChat?: string | null;
      object?: ObjectRef | null;
    } = {},
  ): Promise<void> {
    const gen = ++generation;
    const old = runningChatId(get());
    if (old) void api.chatClose(old).catch(ignore);
    const agent = options.agent ?? null;
    const continueChat = options.continueChat ?? null;
    set({
      scope,
      view: "chat",
      start: scope
        ? { phase: "starting" }
        : { phase: "failed", failure: { kind: "noClusters" } },
      items: continueChat ? get().items : [],
      past: continueChat ? get().past : [],
      busy: false,
      cannotReopen: null,
      undone: [],
      tab: null,
      object: options.object ?? null,
      clusterSettings: null,
      agentId: null,
      agentName: null,
    });
    if (!scope) return;

    let settings: ClusterAgentSettings | null = null;
    if (!scope.global && scope.clusters[0] !== undefined) {
      settings = await api
        .clusterAgentSettings(scope.clusters[0])
        .catch(() => null);
      if (gen !== generation) return;
      set({ clusterSettings: settings });
    }

    // The core's default is the first Ready agent, and states stay unknown until probed (P4).
    const agents = useAgents.getState();
    let rows = agents.statuses ?? (await agents.load()) ?? [];
    const clusterDefault = rows.find(
      (r) => r.id === settings?.defaultAgent,
    )?.id;
    if (agent === null && !clusterDefault && !rows.some((r) => r.isDefault)) {
      await agents.probeUnknown();
      rows = useAgents.getState().statuses ?? rows;
    }
    if (gen !== generation) return;
    const expected =
      agent ?? clusterDefault ?? rows.find((r) => r.isDefault)?.id ?? null;

    try {
      const info = await api.chatStart(scope, agent, continueChat, (event) =>
        onEvent(gen, event),
      );
      if (gen !== generation) {
        void api.chatClose(info.chatId).catch(ignore);
        return;
      }
      const name =
        useAgents.getState().statuses?.find((r) => r.id === info.agent)?.name ??
        info.agent;
      set({
        start: { phase: "running", chatId: info.chatId },
        agentId: info.agent,
        agentName: name,
      });
      // A start that worked made the agent Ready.
      void useAgents.getState().load();
    } catch (error) {
      if (gen !== generation) return;
      const message = failureMessage(error);
      if (continueChat && message.endsWith(CANNOT_REOPEN_SUFFIX)) {
        set({
          start: { phase: "ended" },
          cannotReopen: message.slice(0, -CANNOT_REOPEN_SUFFIX.length).trim(),
        });
        return;
      }
      const failure = await failureOf(message, expected);
      if (gen !== generation) return;
      set({ start: { phase: "failed", failure } });
    }
  }

  function scopeNow(page: string | null): ChatScope | null {
    return nextScope(get().scope, page, catalogIds());
  }

  return {
    ...INITIAL,

    toggle(page) {
      if (get().open) get().closePanel();
      else get().openPanel(page);
    },

    openPanel(page) {
      set({ open: true });
      if (get().start.phase === "idle")
        void begin(scopeNow(page), { agent: get().picked });
    },

    closePanel() {
      set({ open: false });
    },

    newChat(page) {
      return begin(scopeNow(page), { agent: get().picked });
    },

    setScope(scope) {
      return begin(nextScope(scope, null, catalogIds()), {
        agent: get().picked,
      });
    },

    pickAgent(id) {
      set({ picked: id });
      return begin(scopeNow(null), { agent: id });
    },

    askAbout(object) {
      set({ open: true });
      return begin(
        nextScope(
          { clusters: [object.cluster], global: false },
          null,
          catalogIds(),
        ),
        { agent: get().picked, object },
      );
    },

    async askFromTab(tabId, text) {
      const source = tabSource(tabId);
      const body = text.trim();
      if (!source || body === "") return "notStarted";
      const tab = await source();
      set({ open: true });
      const now = get();
      const reaches =
        runningChatId(now) !== null &&
        (now.scope?.clusters.includes(tab.cluster) ?? false);
      if (!reaches) {
        await begin(
          nextScope(
            { clusters: [tab.cluster], global: false },
            null,
            catalogIds(),
          ),
          { agent: get().picked },
        );
      }
      const s = get();
      const chatId = runningChatId(s);
      // Problems starting a chat show in the panel (spec A2).
      if (chatId === null) return "notStarted";
      if (s.busy) return { failed: STILL_ANSWERING };
      const before = s.tab;
      set({ tab: { tabId: tab.tabId, title: tab.title }, busy: true });
      try {
        await api.chatPrompt(chatId, body, null, tab);
        return "sent";
      } catch (error) {
        if (runningChatId(get()) === chatId) set({ tab: before });
        return { failed: failureMessage(error) };
      } finally {
        if (runningChatId(get()) === chatId) set({ busy: false });
      }
    },

    async retry() {
      const { start } = get();
      const agents = useAgents.getState();
      if (start.phase === "failed") {
        const failure = start.failure;
        if ("agentId" in failure) await agents.probe(failure.agentId);
        else if (failure.kind === "noAgent") {
          await agents.load();
          await agents.probeUnknown();
        }
      }
      await begin(scopeNow(null), { agent: get().picked });
    },

    async send(text) {
      const s = get();
      const chatId = runningChatId(s);
      const body = (text ?? s.draft).trim();
      if (body === "" || chatId === null || s.busy) return;
      const object = s.object;
      let tab: EditorTab | null = null;
      if (s.tab) {
        const source = tabSource(s.tab.tabId);
        if (source) tab = await source();
        else set({ tab: null });
      }
      set({
        draft: text === undefined ? "" : s.draft,
        object: null,
        busy: true,
      });
      try {
        await api.chatPrompt(chatId, body, object, tab);
      } catch (error) {
        if (runningChatId(get()) === chatId && get().draft === "") {
          set({ draft: body, object });
        }
        toast.error("Could not send the message", failureMessage(error));
      } finally {
        if (runningChatId(get()) === chatId) set({ busy: false });
      }
    },

    async stop() {
      const chatId = runningChatId(get());
      if (chatId === null) return;
      try {
        await api.chatStop(chatId);
      } catch (error) {
        toast.error("Could not stop the agent", failureMessage(error));
      }
    },

    async answer(cardId, answer) {
      const chatId = runningChatId(get());
      if (chatId === null) return;
      try {
        await api.chatAnswer(chatId, cardId, answer);
      } catch (error) {
        toast.error("Could not answer the change", failureMessage(error));
      }
    },

    async undo(card) {
      const s = get();
      const chatId = runningChatId(s);
      const clusterId = s.scope
        ? clusterIdsByName(s.scope, useCatalog.getState().clusters).get(
            card.cluster,
          )
        : undefined;
      if (chatId === null || clusterId === undefined) return;
      try {
        await api.chatUndoStanding(chatId, clusterId);
        // Every card that holds this cluster's standing approval loses its Undo.
        const ids = get()
          .items.filter(
            (i) =>
              i.body.type === "change" &&
              i.body.card.cluster === card.cluster &&
              "standing" in i.body.card.state &&
              i.body.card.state.standing,
          )
          .map((i) => i.id);
        set((x) => ({ undone: [...new Set([...x.undone, ...ids, card.id])] }));
      } catch (error) {
        toast.error("Could not undo the approval", failureMessage(error));
      }
    },

    showHistory(on) {
      set({ view: on ? "history" : "chat" });
      if (on) void get().loadHistory();
    },

    async loadHistory() {
      const scope = get().scope;
      if (scope === null) {
        set({ history: { loading: false, error: null, rows: [] } });
        return;
      }
      set((s) => ({ history: { ...s.history, loading: true, error: null } }));
      try {
        const rows = await api.chatList(scope);
        set({ history: { loading: false, error: null, rows } });
      } catch (error) {
        set({
          history: { loading: false, error: failureMessage(error), rows: null },
        });
      }
    },

    async openStored(id) {
      let stored: Awaited<ReturnType<typeof api.chatGet>>;
      try {
        stored = await api.chatGet(id);
      } catch (error) {
        toast.error("Could not open the chat", failureMessage(error));
        return;
      }
      set({
        items: stored.items,
        past: stored.items.map((i) => i.id),
        draft: "",
      });
      if (!stored.canLoad) {
        generation += 1;
        const old = runningChatId(get());
        if (old) void api.chatClose(old).catch(ignore);
        set({
          scope: stored.scope,
          view: "chat",
          start: { phase: "ended" },
          busy: false,
          cannotReopen: stored.agentName,
          agentId: stored.agent,
          agentName: stored.agentName,
          object: null,
          undone: [],
        });
        return;
      }
      await begin(stored.scope, { agent: stored.agent, continueChat: id });
    },

    setDraft(text) {
      set({ draft: text });
    },

    removeObject() {
      set({ object: null });
    },

    setDrawerObject(object) {
      set({ drawerObject: object });
    },
  };
});

export function resetAgentChatForTest(): void {
  generation += 1;
  useAgentChat.setState({ ...INITIAL, start: { phase: "idle" } });
}
