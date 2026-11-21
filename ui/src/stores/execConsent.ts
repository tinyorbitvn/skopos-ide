import { create } from "zustand";

interface ExecConsentState {
  /** The cluster whose kubeconfig waits for permission to run a program, if any. */
  clusterId: string | null;
  ask(clusterId: string): void;
  close(): void;
}

/** Which cluster the consent dialog is open for. One per window. */
export const useExecConsent = create<ExecConsentState>((set) => ({
  clusterId: null,
  ask(clusterId) {
    set({ clusterId });
  },
  close() {
    set({ clusterId: null });
  },
}));

export function resetExecConsentForTest(): void {
  useExecConsent.setState({ clusterId: null });
}
