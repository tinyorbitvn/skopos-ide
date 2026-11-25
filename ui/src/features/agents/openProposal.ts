import type { ProposalCard } from "../../ipc/generated/ProposalCard";
import { editTab, newCreateTab, useDock, writeDraft } from "../../stores/dock";
import { useProposals } from "../../stores/proposals";
import type { CreateDraft } from "../editor/CreateResourceTab";

/** A fresh tab with the proposal waiting in it (spec A5): an empty create tab, or the edited object's tab. */
export function openProposal(chatId: string, card: ProposalCard): void {
  const dock = useDock.getState();
  if (card.mode === "edit" && card.target) {
    const tab = editTab(
      card.clusterId,
      card.target.resource,
      card.target.namespace ?? undefined,
      card.target.name,
    );
    dock.open(tab);
    useProposals.getState().reopen(tab.id, chatId, card);
    return;
  }
  const tab = newCreateTab(card.clusterId, card.tabTitle);
  dock.open(tab);
  writeDraft(tab.id, {
    text: "",
    baseline: "",
    results: [],
  } satisfies CreateDraft);
  useProposals.getState().reopen(tab.id, chatId, card);
}
