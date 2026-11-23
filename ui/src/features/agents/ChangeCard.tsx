import { useState } from "react";
import { Button } from "../../design";
import { Shield, TriangleAlert } from "../../design/icons";
import type { ChangeAnswer } from "../../ipc/generated/ChangeAnswer";
import type { ChangeCard as Card } from "../../ipc/generated/ChangeCard";
import type { DiffLine } from "../../ipc/generated/DiffLine";
import styles from "./ChangeCard.module.css";
import { RolloutLine } from "./RolloutLine";

const SIGN: Record<DiffLine["kind"], string> = {
  context: " ",
  added: "+",
  removed: "-",
  more: "",
};

function Diff(props: { lines: DiffLine[] }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend the diff does not want.
    <div role="group" aria-label="Diff" className={styles.diff}>
      {props.lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id and never reorder.
        <div key={i} className={styles[line.kind]}>
          {line.kind === "more" ? line.text : `${SIGN[line.kind]} ${line.text}`}
        </div>
      ))}
    </div>
  );
}

function Outcome(props: {
  card: Card;
  live: boolean;
  undone: boolean;
  answer(answer: ChangeAnswer): void;
  answering: boolean;
  onUndo(): void;
}) {
  const { card } = props;
  const state = card.state;
  switch (state.state) {
    case "waiting":
      if (!props.live) return null;
      return (
        <>
          <p className={styles.note}>The agent waits for your answer.</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              size="sm"
              disabled={props.answering}
              onClick={() => props.answer("approve")}
              data-testid="agent-approve"
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={props.answering}
              onClick={() => props.answer("approveForChat")}
              data-testid="agent-approve-chat"
            >
              Approve for this chat
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={props.answering}
              onClick={() => props.answer("deny")}
              data-testid="agent-deny"
            >
              Deny
            </Button>
          </div>
        </>
      );
    case "approved":
      return (
        <>
          <p role="status" className={styles.ok}>
            {`Approved. Applied at ${state.at}.`}
          </p>
          {state.standing && !props.undone ? (
            <p className={styles.standing}>
              Later changes in this chat run without asking.
              {props.live ? (
                <button
                  type="button"
                  className={styles.link}
                  onClick={props.onUndo}
                  data-testid="agent-undo"
                >
                  Undo
                </button>
              ) : null}
            </p>
          ) : null}
        </>
      );
    case "appliedWithoutAsking":
      return (
        <p role="status" className={styles.ok}>
          {state.standing
            ? "Applied without asking. You approved changes for this chat."
            : `Applied without asking. Your setting for ${card.cluster} allows it.`}
        </p>
      );
    case "denied":
      return (
        <p role="status" className={styles.muted}>
          Denied. The agent was told no.
        </p>
      );
    case "stopped":
      return (
        <p role="status" className={styles.muted}>
          Stopped. Nothing was changed.
        </p>
      );
    case "failed":
      return (
        <p role="status" className={styles.danger}>
          {`Failed: ${state.message}`}
        </p>
      );
  }
}

/**
 * A change the agent asked for: an approval card while it waits, then its outcome; a done
 * card when it ran without asking (spec §3.2). `follow` shows the rollout line.
 */
export function ChangeCard(props: {
  card: Card;
  /** The chat runs, so the card takes answers. */
  live: boolean;
  /** The card changed in this run of the chat, so its rollout is worth following. */
  follow: boolean;
  undone: boolean;
  onAnswer(answer: ChangeAnswer): Promise<void> | void;
  onUndo(): void;
}) {
  const { card } = props;
  const [answering, setAnswering] = useState(false);
  const applied =
    card.state.state === "approved" ||
    card.state.state === "appliedWithoutAsking";

  async function answer(value: ChangeAnswer): Promise<void> {
    setAnswering(true);
    try {
      await props.onAnswer(value);
    } finally {
      setAnswering(false);
    }
  }

  return (
    <section
      aria-label={card.title}
      className={styles.card}
      data-testid="agent-change-card"
      data-card={card.id}
      data-state={card.state.state}
    >
      <div className={styles.head}>
        <Shield size={14} aria-hidden="true" />
        <span className={styles.title} title={card.title}>
          {card.title}
        </span>
        <span className={styles.chip}>{card.cluster}</span>
      </div>
      {card.summary ? <p className={styles.summary}>{card.summary}</p> : null}
      {card.command ? (
        <pre className={styles.code}>{card.command.join(" ")}</pre>
      ) : null}
      {card.diff.length > 0 ? <Diff lines={card.diff} /> : null}
      {card.secrets.length > 0 ? (
        <p className={styles.warning}>
          <TriangleAlert size={14} aria-hidden="true" />
          {`This change lets a workload read these Secrets: ${card.secrets.join(", ")}.`}
        </p>
      ) : null}
      <Outcome
        card={card}
        live={props.live}
        undone={props.undone}
        answer={(value) => void answer(value)}
        answering={answering}
        onUndo={props.onUndo}
      />
      {card.output ? <pre className={styles.code}>{card.output}</pre> : null}
      {card.result ? <p className={styles.muted}>{card.result}</p> : null}
      {props.follow && applied && card.rollout ? (
        <RolloutLine target={card.rollout} />
      ) : null}
    </section>
  );
}
