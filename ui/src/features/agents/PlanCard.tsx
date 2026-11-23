import { Spinner } from "../../design";
import { Check, CircleDashed } from "../../design/icons";
import type { PlanEntry } from "../../ipc/generated/PlanEntry";
import styles from "./ChatStream.module.css";

function Mark(props: { status: PlanEntry["status"] }) {
  if (props.status === "completed") {
    return (
      <span role="img" aria-label="Done" className={styles.done}>
        <Check size={14} aria-hidden="true" />
      </span>
    );
  }
  if (props.status === "inProgress")
    return <Spinner label="Running" hideLabel />;
  return (
    <span role="img" aria-label="Waiting" className={styles.waiting}>
      <CircleDashed size={14} aria-hidden="true" />
    </span>
  );
}

/** The agent's plan (spec §3.2). A step still running when the turn ended shows as waiting. */
export function PlanCard(props: { entries: PlanEntry[]; busy: boolean }) {
  return (
    <section className={styles.plan} aria-label="Plan">
      <h4 className={styles.planTitle}>Plan</h4>
      <ul className={styles.planList}>
        {props.entries.map((entry, i) => {
          const status =
            entry.status === "inProgress" && !props.busy
              ? "pending"
              : entry.status;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: plan entries have no id; the agent sends the whole list each time.
            <li key={i} className={styles.planEntry}>
              <Mark status={status} />
              <span>{entry.content}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
