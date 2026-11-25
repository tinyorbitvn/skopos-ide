import { create } from "zustand";
import { api } from "../ipc/api";
import type { ProposalCard } from "../ipc/generated/ProposalCard";

/** A proposal waiting in a tab, and the chat to answer (spec A13). Not persisted. */
export interface PendingProposal {
  chatId: string;
  card: ProposalCard;
}

interface ProposalsState {
  byTab: Record<string, PendingProposal>;
  receive(chatId: string, card: ProposalCard): void;
  /** Takes the tab's proposal and answers the core; its text, or null when none waits. */
  accept(tabId: string): string | null;
  reject(tabId: string): void;
  /** Puts a card from the chat into another tab, waiting (spec A5). */
  reopen(tabId: string, chatId: string, card: ProposalCard): void;
  drop(tabId: string): void;
}

const ignore = () => {};

function without(
  byTab: Record<string, PendingProposal>,
  tabId: string,
): Record<string, PendingProposal> {
  return Object.fromEntries(
    Object.entries(byTab).filter(([id]) => id !== tabId),
  );
}

export const useProposals = create<ProposalsState>((set, get) => {
  function take(tabId: string, accepted: boolean): PendingProposal | null {
    const pending = get().byTab[tabId];
    if (!pending) return null;
    set((s) => ({ byTab: without(s.byTab, tabId) }));
    void api
      .chatProposalAnswer(pending.chatId, pending.card.id, accepted)
      .catch(ignore);
    return pending;
  }
  return {
    byTab: {},
    receive(chatId, card) {
      set((s) => {
        if (card.state === "waiting")
          return { byTab: { ...s.byTab, [card.tabId]: { chatId, card } } };
        return s.byTab[card.tabId]?.card.id === card.id
          ? { byTab: without(s.byTab, card.tabId) }
          : s;
      });
    },
    accept(tabId) {
      return take(tabId, true)?.card.yaml ?? null;
    },
    reject(tabId) {
      take(tabId, false);
    },
    reopen(tabId, chatId, card) {
      set((s) => ({
        byTab: {
          ...s.byTab,
          [tabId]: { chatId, card: { ...card, tabId, state: "waiting" } },
        },
      }));
    },
    drop(tabId) {
      set((s) => (s.byTab[tabId] ? { byTab: without(s.byTab, tabId) } : s));
    },
  };
});

export function resetProposalsForTest(): void {
  useProposals.setState({ byTab: {} });
}
