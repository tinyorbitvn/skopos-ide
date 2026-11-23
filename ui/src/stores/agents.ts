import { create } from "zustand";
import { toast } from "../design";
import { agentsSupported } from "../features/agents/supported";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { AgentPrefs } from "../ipc/generated/AgentPrefs";
import type { AgentStatus } from "../ipc/generated/AgentStatus";
import type { SandboxStatus } from "../ipc/generated/SandboxStatus";

/**
 * The agent CLIs and the sandbox (agents spec §3.5, §4.2), shared by Preferences, the
 * panel's agent popover and the cluster Settings page. The core keeps probe results for
 * the app run, so a row stays `unknown` only until its first probe.
 */
interface AgentsState {
  statuses: AgentStatus[] | null;
  error: string | null;
  /** The agents whose probe runs now. */
  probing: Record<string, true>;
  sandbox: SandboxStatus | null;
  sandboxError: string | null;
  sandboxChecking: boolean;
  prefs: AgentPrefs | null;
  prefsError: string | null;
  /** Reads the rows; null when the read failed (the message is in `error`). */
  load(): Promise<AgentStatus[] | null>;
  /** Probes one agent; a second call while it runs waits for the same probe. */
  probe(id: string): Promise<void>;
  /** Probes every agent whose state is still unknown. */
  probeUnknown(): Promise<void>;
  /** Rejects with the core's message (`No such command: …`, `An agent named … exists.`). */
  add(name: string, command: string): Promise<void>;
  remove(id: string): Promise<void>;
  makeDefault(id: string): Promise<void>;
  loadSandbox(refresh: boolean): Promise<SandboxStatus | null>;
  loadPrefs(): Promise<void>;
  addDomain(domain: string): Promise<void>;
  removeDomain(domain: string): Promise<void>;
  addFolder(folder: string): Promise<void>;
  removeFolder(folder: string): Promise<void>;
}

const INITIAL = {
  statuses: null,
  error: null,
  probing: {},
  sandbox: null,
  sandboxError: null,
  sandboxChecking: false,
  prefs: null,
  prefsError: null,
};

/** The probes that run now, so concurrent callers share one. */
const running = new Map<string, Promise<void>>();

function withoutKey(
  map: Record<string, true>,
  key: string,
): Record<string, true> {
  const next = { ...map };
  delete next[key];
  return next;
}

export const useAgents = create<AgentsState>((set, get) => ({
  ...INITIAL,

  async load() {
    if (!agentsSupported()) return null;
    try {
      const statuses = await api.agentsStatus();
      set({ statuses, error: null });
      return statuses;
    } catch (error) {
      set({ error: failureMessage(error) });
      return null;
    }
  },

  probe(id) {
    const known = running.get(id);
    if (known) return known;
    const run = (async () => {
      set((s) => ({ probing: { ...s.probing, [id]: true } }));
      try {
        const row = await api.agentProbe(id);
        set((s) => ({
          statuses: s.statuses?.map((r) => (r.id === id ? row : r)) ?? null,
        }));
        // A probe that makes an agent Ready can move the default to it.
        await get().load();
      } catch (error) {
        toast.error("Could not check the agent", failureMessage(error));
      } finally {
        running.delete(id);
        set((s) => ({ probing: withoutKey(s.probing, id) }));
      }
    })();
    running.set(id, run);
    return run;
  },

  async probeUnknown() {
    const rows = get().statuses ?? (await get().load()) ?? [];
    await Promise.all(
      rows
        .filter((r) => r.state.state === "unknown")
        .map((r) => get().probe(r.id)),
    );
  },

  async add(name, command) {
    const row = await api.agentCustomAdd(name, command);
    set((s) => ({ statuses: [...(s.statuses ?? []), row] }));
    await get().probe(row.id);
  },

  async remove(id) {
    await api.agentCustomRemove(id);
    await get().load();
  },

  async makeDefault(id) {
    await api.agentDefaultSet(id);
    await get().load();
  },

  async loadSandbox(refresh) {
    if (!agentsSupported()) return null;
    set({ sandboxChecking: true });
    try {
      const sandbox = await api.agentSandboxStatus(refresh);
      set({ sandbox, sandboxError: null });
      return sandbox;
    } catch (error) {
      set({ sandboxError: failureMessage(error) });
      return null;
    } finally {
      set({ sandboxChecking: false });
    }
  },

  async loadPrefs() {
    if (!agentsSupported()) return;
    try {
      set({ prefs: await api.agentPrefs(), prefsError: null });
    } catch (error) {
      set({ prefsError: failureMessage(error) });
    }
  },

  async addDomain(domain) {
    set({ prefs: await api.agentDomainAdd(domain) });
  },
  async removeDomain(domain) {
    set({ prefs: await api.agentDomainRemove(domain) });
  },
  async addFolder(folder) {
    set({ prefs: await api.agentFolderAdd(folder) });
  },
  async removeFolder(folder) {
    set({ prefs: await api.agentFolderRemove(folder) });
  },
}));

export function resetAgentsForTest(): void {
  running.clear();
  useAgents.setState(INITIAL);
}
