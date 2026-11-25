import { Button } from "../../design";
import type { ChoiceKind } from "../../ipc/generated/ChoiceKind";
import type { PermissionCard as Card } from "../../ipc/generated/PermissionCard";
import { Diff } from "./ChangeCard";
import styles from "./PermissionCard.module.css";

const ANSWERED: Record<ChoiceKind, string> = {
  allowOnce: "Allowed once",
  allowAlways: "Always allowed",
  rejectOnce: "Rejected once",
  rejectAlways: "Always rejected",
};

export interface PermissionCardProps {
  card: Card;
  /** The chat runs, so a waiting card takes an answer. */
  live: boolean;
  onChoose(optionId: string): Promise<void> | void;
}

function outcomeText(card: Card): string {
  const state = card.state;
  if (state.state === "chosen") return ANSWERED[state.kind];
  if (state.state === "cancelled") return "Cancelled";
  // A waiting card of a chat that is gone (history): stored chats map it to Cancelled.
  return "Cancelled";
}

export function PermissionCard({ card, live, onChoose }: PermissionCardProps) {
  const primary = card.options.find(
    (o) => o.kind === "allowOnce" || o.kind === "allowAlways",
  )?.id;
  return (
    <section
      className={styles.card}
      data-testid="agent-permission"
      aria-label={card.title}
    >
      <h4 className={styles.title}>{card.title}</h4>
      {card.command ? <pre className={styles.code}>{card.command}</pre> : null}
      {card.url ? <p className={styles.url}>{card.url}</p> : null}
      {card.diffs.map((diff) => (
        <div key={diff.path} className={styles.file}>
          <p className={styles.path}>{diff.path}</p>
          <Diff lines={diff.lines} />
        </div>
      ))}
      {card.raw ? <pre className={styles.code}>{card.raw}</pre> : null}
      {card.state.state === "waiting" && live ? (
        <div className={styles.actions}>
          {card.options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option.id === primary ? "primary" : "secondary"}
              data-testid={`agent-permission-${option.id}`}
              onClick={() => void onChoose(option.id)}
            >
              {option.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className={styles.outcome}>{outcomeText(card)}</p>
      )}
    </section>
  );
}
