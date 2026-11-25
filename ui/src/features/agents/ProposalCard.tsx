import { Button } from "../../design";
import type { ProposalCard as Card } from "../../ipc/generated/ProposalCard";
import type { ProposalState } from "../../ipc/generated/ProposalState";
import { useDock } from "../../stores/dock";
import { Diff } from "./ChangeCard";
import styles from "./ChangeCard.module.css";
import { openProposal } from "./openProposal";

const STATE_TEXT: Record<ProposalState, string> = {
  waiting: "Waiting for you",
  accepted: "Accepted",
  rejected: "Rejected",
  replaced: "Replaced",
  tabClosed: "Tab closed",
};

/** The agent's proposal for a YAML tab (YAML authoring spec A5). */
export function ProposalCard(props: {
  card: Card;
  chatId: string | null;
  live: boolean;
}) {
  const { card } = props;
  const tabOpen = useDock((s) => s.tabs.some((tab) => tab.id === card.tabId));
  const chatId = props.chatId;
  const actionable = props.live && chatId !== null && card.yaml !== "";
  return (
    <div className={styles.card} data-testid="agent-proposal-card">
      <div className={styles.head}>
        <span className={styles.title}>Proposal for {card.tabTitle}</span>
        <span className={styles.chip}>
          +{card.added} −{card.removed}
        </span>
      </div>
      <p className={styles.summary}>{card.summary}</p>
      {card.diff.length > 0 ? <Diff lines={card.diff} /> : null}
      <p className={styles.muted}>{STATE_TEXT[card.state]}</p>
      {actionable && tabOpen ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            onClick={() => {
              const dock = useDock.getState();
              dock.activate(card.tabId);
              dock.setMinimized(false);
            }}
            data-testid="agent-proposal-show"
          >
            Show in tab
          </Button>
        </div>
      ) : null}
      {actionable && !tabOpen ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            onClick={() => openProposal(chatId, card)}
            data-testid="agent-proposal-open"
          >
            Open in new tab
          </Button>
        </div>
      ) : null}
    </div>
  );
}
