import type { PolicyRef } from "../../ipc/generated/PolicyRef";
import styles from "./ReachPanel.module.css";
import type { Panel, PanelChip, PanelEntry } from "./reachModel";

/** Opens a policy in the drawer; undefined where the cluster does not serve its kind. */
export type PolicyOpener = (ref: PolicyRef) => (() => void) | undefined;

function Chip(props: { chip: PanelChip; open: (() => void) | undefined }) {
  const { chip, open } = props;
  const body = (
    <>
      <span className={styles.tag} data-source={chip.ref.source}>
        {chip.tag}
      </span>{" "}
      <span className={styles.chipName}>{chip.name}</span>
    </>
  );
  return open === undefined ? (
    <span className={styles.chip} data-testid={chip.testId}>
      {body}
    </span>
  ) : (
    <button
      type="button"
      className={styles.chip}
      data-testid={chip.testId}
      onClick={open}
    >
      {body}
    </button>
  );
}

function Entry(props: {
  entry: PanelEntry;
  side: "in" | "out";
  opener: PolicyOpener;
}) {
  const { entry } = props;
  return (
    <li
      className={styles.entry}
      data-testid={`reach-entry-${props.side}-${entry.id}`}
    >
      <div className={styles.entryHead}>
        <span className={styles.peer}>{entry.peer}</span>
        <span className={styles.ports} data-tone={entry.tone}>
          {entry.ports}
        </span>
      </div>
      {entry.detail === null ? null : (
        <span className={styles.detail}>{entry.detail}</span>
      )}
      {entry.somePods ? <span className={styles.detail}>Some Pods</span> : null}
      {entry.http.map((line) => (
        <code key={line} className={styles.http}>
          {line}
        </code>
      ))}
      {entry.chips.length === 0 ? null : (
        <div className={styles.chips}>
          {entry.chips.map((chip) => (
            <Chip key={chip.testId} chip={chip} open={props.opener(chip.ref)} />
          ))}
        </div>
      )}
    </li>
  );
}

function Direction(props: {
  title: string;
  side: "in" | "out";
  entries: PanelEntry[];
  opener: PolicyOpener;
}) {
  return (
    <section className={styles.direction} aria-label={props.title}>
      <h4 className={styles.directionTitle}>{props.title}</h4>
      <ul className={styles.entries}>
        {props.entries.map((entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            side={props.side}
            opener={props.opener}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The panel of the selected workload (spec §3.2): what may reach it and where it may go,
 * each with its ports, HTTP rules and the policies behind it, which open in the drawer.
 */
export function ReachPanel(props: { panel: Panel; opener: PolicyOpener }) {
  const { panel } = props;
  return (
    <aside
      className={styles.panel}
      data-testid="reach-panel"
      aria-label="Selected workload"
    >
      <header className={styles.head}>
        <h3 className={styles.name}>{panel.name}</h3>
        <p className={styles.header}>{panel.header}</p>
      </header>
      {panel.warning === null ? null : (
        <p className={styles.warning} data-testid="reach-warning">
          {panel.warning}
        </p>
      )}
      <Direction
        title="Allowed in"
        side="in"
        entries={panel.ins}
        opener={props.opener}
      />
      <Direction
        title="Allowed out"
        side="out"
        entries={panel.outs}
        opener={props.opener}
      />
      {panel.foot === null ? null : (
        <p className={styles.foot} data-testid="reach-foot">
          {panel.foot}
        </p>
      )}
    </aside>
  );
}
