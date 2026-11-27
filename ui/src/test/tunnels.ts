import type { TunnelView } from "../ipc/generated/TunnelView";

/** A proxy tunnel no cluster uses, idle, without a password. */
export function tunnel(partial: Partial<TunnelView> = {}): TunnelView {
  return {
    id: "t1",
    name: "corp",
    kind: { type: "proxy", url: "http://proxy.corp:3128", username: null },
    clusterCount: 0,
    hasPassword: false,
    passwordNote: null,
    state: { status: "idle" },
    prompt: null,
    log: [],
    ...partial,
  };
}
