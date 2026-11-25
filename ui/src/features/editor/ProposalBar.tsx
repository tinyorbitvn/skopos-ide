import { Button } from "../../design";
import type { ProposalCard } from "../../ipc/generated/ProposalCard";
import styles from "./YamlEditor.module.css";

/** A pending proposal over the tab's editor (spec A4). */
export function ProposalBar(props: {
  card: ProposalCard;
  onAccept(): void;
  onReject(): void;
}) {
  return (
    <div className={styles.proposal} data-testid="yaml-proposal-bar">
      <strong>AI proposal</strong>
      <span className={styles.proposalSummary}>{props.card.summary}</span>
      <span className={styles.hint}>
        +{props.card.added} −{props.card.removed}
      </span>
      <Button
        size="sm"
        variant="primary"
        onClick={props.onAccept}
        data-testid="yaml-proposal-accept"
      >
        Accept
      </Button>
      <Button
        size="sm"
        onClick={props.onReject}
        data-testid="yaml-proposal-reject"
      >
        Reject
      </Button>
    </div>
  );
}
