import { useEffect, useState } from "react";
import { clusterStatus } from "../../app/clusterStatus";
import { EmptyState, Segmented, StatusDot, toast } from "../../design";
import { TriangleAlert } from "../../design/icons";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { AgentChanges } from "../../ipc/generated/AgentChanges";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import { useCatalog } from "../../stores/catalog";
import { CHANGES_OPTIONS } from "../agents/agentText";
import styles from "./PreferencesScreen.module.css";
import { prefsSectionId } from "./paths";

function ChangesRow({ cluster }: { cluster: ClusterEntry }) {
  const [value, setValue] = useState<AgentChanges | null>(null);
  const status = clusterStatus(cluster.state);

  useEffect(() => {
    let live = true;
    api.clusterAgentSettings(cluster.id).then(
      (settings) => {
        if (live) setValue(settings.changes);
      },
      () => {
        if (live) setValue("ask");
      },
    );
    return () => {
      live = false;
    };
  }, [cluster.id]);

  async function pick(changes: AgentChanges): Promise<void> {
    const before = value;
    setValue(changes);
    try {
      await api.clusterAgentChangesSet(cluster.id, changes);
    } catch (error) {
      setValue(before);
      toast.error(
        `Could not save the setting for ${cluster.name}`,
        failureMessage(error),
      );
    }
  }

  return (
    <li
      className={styles.changesRow}
      data-testid={`pref-changes-${cluster.id}`}
    >
      <div className={styles.changesLine}>
        <StatusDot tone={status.tone} label={status.label} />
        <span className={styles.agentName}>{cluster.name}</span>
        {value !== null ? (
          <Segmented
            label={`Changes in ${cluster.name}`}
            size="sm"
            value={value}
            options={CHANGES_OPTIONS}
            onChange={(changes) => void pick(changes)}
            testId={`pref-changes-${cluster.id}-mode`}
          />
        ) : null}
      </div>
      {value === "dontAsk" && cluster.name.startsWith("prod") ? (
        <p className={styles.warning}>
          <TriangleAlert size={14} aria-hidden="true" />
          {`Changes to ${cluster.name} will run without asking you.`}
        </p>
      ) : null}
    </li>
  );
}

/** Preferences → Agent changes (spec §3.5): one setting per catalog cluster, saved at once. */
export function AgentChangesSection() {
  const clusters = useCatalog((s) => s.clusters);
  return (
    <section
      id={prefsSectionId("agent-changes")}
      tabIndex={-1}
      className={`${styles.section} ${styles.anchor}`}
      data-testid="pref-agent-changes"
    >
      <h3 className={styles.heading}>Agent changes</h3>
      <p className={styles.muted}>
        What an agent may change in each cluster. Reads are always allowed.
      </p>
      {clusters.length === 0 ? (
        <EmptyState
          title="No clusters yet"
          body="Add a cluster to choose what agents may change in it."
        />
      ) : (
        <ul className={styles.rows}>
          {clusters.map((cluster) => (
            <ChangesRow key={cluster.id} cluster={cluster} />
          ))}
        </ul>
      )}
    </section>
  );
}
