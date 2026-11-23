import { useEffect } from "react";
import { Badge, ErrorNotice, Spinner } from "../../design";
import { Check } from "../../design/icons";
import { useAgents } from "../../stores/agents";
import { agentStateView } from "./agentText";
import { PanelPopover } from "./PanelPopover";
import styles from "./PanelPopover.module.css";

/** The agent popover (spec §3.2): every agent with its state, then `Agent settings`. */
export function AgentPopover(props: {
  current: string | null;
  onPick(id: string): void;
  onSettings(): void;
  onClose(): void;
}) {
  const statuses = useAgents((s) => s.statuses);
  const error = useAgents((s) => s.error);
  const probing = useAgents((s) => s.probing);
  useEffect(() => {
    void useAgents
      .getState()
      .load()
      .then(() => useAgents.getState().probeUnknown());
  }, []);

  let list = null;
  if (statuses === null && error) {
    list = (
      <ErrorNotice
        title="Could not read the agents"
        message={error}
        onRetry={() => void useAgents.getState().load()}
      />
    );
  } else if (statuses === null) {
    list = <Spinner />;
  } else {
    list = (
      <ul className={styles.agents}>
        {statuses.map((status) => {
          const view = agentStateView(status.state);
          const on = status.id === props.current;
          return (
            <li key={status.id}>
              <button
                type="button"
                className={styles.agentRow}
                aria-pressed={on}
                onClick={() => {
                  props.onPick(status.id);
                  props.onClose();
                }}
                data-testid={`agent-pick-${status.id}`}
              >
                <span className={styles.mark}>
                  {on ? <Check size={14} aria-hidden="true" /> : null}
                </span>
                <span className={styles.agentName}>{status.name}</span>
                <Badge tone={view.tone}>
                  {probing[status.id] ? "Checking" : view.label}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <PanelPopover
      label="Agents"
      testId="agent-pick-popover"
      onClose={props.onClose}
    >
      {list}
      <button
        type="button"
        className={styles.link}
        onClick={() => {
          props.onSettings();
          props.onClose();
        }}
        data-testid="agent-pick-settings"
      >
        Agent settings
      </button>
    </PanelPopover>
  );
}
