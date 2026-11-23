import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  ErrorNotice,
  Spinner,
  StatusDot,
  toast,
} from "../../design";
import { failureMessage } from "../../ipc/client";
import type { AgentStatus } from "../../ipc/generated/AgentStatus";
import { useAgents } from "../../stores/agents";
import { agentStateView } from "../agents/agentText";
import { AddAgentDialog } from "./AddAgentDialog";
import styles from "./PreferencesScreen.module.css";
import { prefsSectionId } from "./paths";

function AgentRow({ status }: { status: AgentStatus }) {
  const probing = useAgents((s) => s.probing[status.id] === true);
  const view = agentStateView(status.state);
  const ready = status.state.state === "ready";
  const unknown = status.state.state === "unknown";
  const { probe, remove, makeDefault } = useAgents.getState();

  async function run(action: () => Promise<void>, failure: string) {
    try {
      await action();
    } catch (error) {
      toast.error(failure, failureMessage(error));
    }
  }

  return (
    <li className={styles.agentRow} data-testid={`pref-agent-${status.id}`}>
      <StatusDot tone={view.tone} label={view.label} />
      <div className={styles.agentText}>
        <div className={styles.agentLine}>
          <span className={styles.agentName}>{status.name}</span>
          <span className={styles.muted}>
            {probing || unknown ? "Checking…" : view.label}
          </span>
          {status.isDefault ? (
            <Badge tone="info">Default</Badge>
          ) : ready ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(
                  () => makeDefault(status.id),
                  `Could not make ${status.name} the default`,
                )
              }
              data-testid={`pref-agent-default-${status.id}`}
            >
              Make default
            </Button>
          ) : null}
        </div>
        {status.detail ? (
          <span className={styles.agentDetail}>{status.detail}</span>
        ) : null}
        {status.hint ? (
          <span className={styles.muted}>{status.hint}</span>
        ) : null}
      </div>
      <span className={styles.toolAction}>
        {!ready ? (
          <Button
            size="sm"
            loading={probing}
            onClick={() => void probe(status.id)}
            data-testid={`pref-agent-check-${status.id}`}
          >
            Check again
          </Button>
        ) : null}
        {status.custom ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${status.name}`}
            onClick={() =>
              void run(
                () => remove(status.id),
                `Could not remove ${status.name}`,
              )
            }
            data-testid={`pref-agent-remove-${status.id}`}
          >
            Remove
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/** Preferences → Agents (spec §3.5): the agent CLIs, their states and the person's own. */
export function AgentsSection() {
  const statuses = useAgents((s) => s.statuses);
  const error = useAgents((s) => s.error);
  const load = useAgents((s) => s.load);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    // Spec §4.2: opening the section probes each agent once per app run.
    void load().then(() => useAgents.getState().probeUnknown());
  }, [load]);

  let body = null;
  if (statuses === null && error) {
    body = (
      <ErrorNotice
        title="Could not read the agents"
        message={error}
        onRetry={() => void load()}
      />
    );
  } else if (statuses === null) {
    body = <Spinner />;
  } else {
    body = (
      <ul className={styles.rows}>
        {statuses.map((status) => (
          <AgentRow key={status.id} status={status} />
        ))}
      </ul>
    );
  }

  return (
    <section
      id={prefsSectionId("agents")}
      tabIndex={-1}
      className={`${styles.section} ${styles.anchor}`}
      data-testid="pref-agents"
    >
      <h3 className={styles.heading}>Agents</h3>
      <p className={styles.muted}>
        Agent CLIs found on this computer. SkoposIDE runs them over the Agent
        Client Protocol, inside the sandbox below.
      </p>
      {body}
      <div>
        <Button onClick={() => setAdding(true)} data-testid="pref-agent-add">
          Add an agent…
        </Button>
      </div>
      {adding ? <AddAgentDialog onClose={() => setAdding(false)} /> : null}
    </section>
  );
}
