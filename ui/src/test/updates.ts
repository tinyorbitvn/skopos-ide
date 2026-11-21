import type { Release } from "../ipc/generated/Release";
import type { UpdateState } from "../ipc/generated/UpdateState";

/** Published 2026-11-25 12:00 UTC. */
export const RELEASE: Release = {
  version: "0.10.0",
  notes: "- Faster lists\n- Fewer clicks",
  date: 1795608000,
};

export function updateState(partial: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: { type: "idle" },
    current: "0.9.0",
    blocker: null,
    installer: "appimage",
    skipped: null,
    lastCheckedAt: null,
    toastWindow: null,
    ...partial,
  };
}
