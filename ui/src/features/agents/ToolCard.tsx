import { type ReactNode, useState } from "react";
import { Spinner } from "../../design";
import { ChevronDown, ChevronRight, ScrollText } from "../../design/icons";
import type { AgentToolStatus } from "../../ipc/generated/AgentToolStatus";
import type { CardDetails } from "../../ipc/generated/CardDetails";
import type { ToolCard as ToolCardData } from "../../ipc/generated/ToolCard";
import styles from "./ChatStream.module.css";

function Details(props: { details: CardDetails }) {
  const { details } = props;
  if (details.type === "table") {
    return (
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {details.head.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: headings may repeat and never reorder.
                <th key={i} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {details.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and never reorder.
              <tr key={r}>
                {row.map((cell, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells have no id and never reorder.
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (details.type === "text")
    return <pre className={styles.excerpt}>{details.text}</pre>;
  return null;
}

/** A head that opens its details when it has some, else a plain row. */
function Expandable(props: {
  head: ReactNode;
  details: ReactNode | null;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const chevron = open ? (
    <ChevronDown size={14} aria-hidden="true" />
  ) : (
    <ChevronRight size={14} aria-hidden="true" />
  );
  return (
    <div className={styles.tool} data-testid={props.testId}>
      {props.details ? (
        <button
          type="button"
          className={styles.toolHead}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {props.head}
          <span className={styles.chev}>{chevron}</span>
        </button>
      ) : (
        <div className={styles.toolHead}>{props.head}</div>
      )}
      {open && props.details ? props.details : null}
    </div>
  );
}

/** A read the agent ran through SkoposIDE's tools (spec §3.2, §4.4). */
export function ToolCard(props: { card: ToolCardData }) {
  const { card } = props;
  return (
    <Expandable
      testId="agent-tool-card"
      details={
        card.details.type === "none" ? null : <Details details={card.details} />
      }
      head={
        <>
          <span className={styles.toolIcon}>
            {card.running ? (
              <Spinner label="Running" hideLabel />
            ) : (
              <ScrollText size={14} aria-hidden="true" />
            )}
          </span>
          <span className={styles.toolTitle} title={card.title}>
            {card.title}
          </span>
          {card.cluster ? (
            <span className={styles.chip}>{card.cluster}</span>
          ) : null}
          {card.result ? (
            <span
              className={
                card.tone === "danger" ? styles.resultDanger : styles.result
              }
            >
              {card.result}
            </span>
          ) : null}
        </>
      }
    />
  );
}

const STATUS: Record<AgentToolStatus, string> = {
  pending: "Waiting",
  inProgress: "Running",
  completed: "Done",
  failed: "Failed",
};

/** One of the agent's own tools: its shell, an edit in its folder (spec §3.2). */
export function AgentToolCard(props: {
  title: string;
  status: AgentToolStatus;
  details: string;
}) {
  return (
    <Expandable
      testId="agent-own-tool"
      details={
        props.details ? (
          <pre className={styles.excerpt}>{props.details}</pre>
        ) : null
      }
      head={
        <>
          <span className={styles.toolIcon}>
            {props.status === "inProgress" ? (
              <Spinner label="Running" hideLabel />
            ) : (
              <ScrollText size={14} aria-hidden="true" />
            )}
          </span>
          <span className={styles.toolTitle} title={props.title}>
            {props.title}
          </span>
          <span
            className={
              props.status === "failed" ? styles.resultDanger : styles.result
            }
          >
            {STATUS[props.status]}
          </span>
        </>
      }
    />
  );
}
