import { create } from "zustand";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import { events } from "../ipc/events";
import type { TunnelView } from "../ipc/generated/TunnelView";

export interface TunnelsState {
  /** `null` until the first list arrives. */
  tunnels: TunnelView[] | null;
  /** Why the last read failed, until a read succeeds. */
  error: string | null;
  /** Subscribes to changes, then reads the list. Runs once. */
  load(): Promise<void>;
  /** Reads the list again, as after a failed read. */
  retry(): Promise<void>;
}

const FIRST = { tunnels: null, error: null } satisfies Partial<TunnelsState>;

let started: Promise<void> | null = null;
// A read's answer is kept only when no newer read began while it was on its way.
let seq = 0;

export const useTunnels = create<TunnelsState>((set) => {
  async function read(): Promise<void> {
    const mine = ++seq;
    try {
      const tunnels = await api.tunnelList();
      if (mine === seq) set({ tunnels, error: null });
    } catch (error) {
      if (mine === seq) set({ error: failureMessage(error) });
    }
  }

  return {
    ...FIRST,
    load() {
      if (!started) {
        started = (async () => {
          await events.onTunnelsChanged(() => {
            void read();
          });
          await read();
        })();
      }
      return started;
    },
    retry: read,
  };
});

/** The tunnel a cluster picked, when it still exists. */
export function tunnelOf(
  tunnels: TunnelView[] | null,
  id: string | null,
): TunnelView | null {
  if (tunnels === null || id === null) return null;
  return tunnels.find((t) => t.id === id) ?? null;
}

export function resetTunnelsForTest(): void {
  started = null;
  seq = 0;
  useTunnels.setState(FIRST);
}
