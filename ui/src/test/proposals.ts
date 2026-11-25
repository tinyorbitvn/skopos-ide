import type { ProposalCard } from "../ipc/generated/ProposalCard";

/** A waiting create-tab proposal; `over` changes any field. */
export function proposal(over: Partial<ProposalCard> = {}): ProposalCard {
  return {
    id: "p1",
    tabId: "create-1",
    tabTitle: "Create",
    cluster: "kind",
    clusterId: "c1",
    mode: "create",
    target: null,
    summary: "Add a Service",
    added: 4,
    removed: 0,
    state: "waiting",
    yaml: "kind: Service\n",
    diff: [],
    ...over,
  };
}
