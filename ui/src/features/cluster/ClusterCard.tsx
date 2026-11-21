import { useNavigate } from "react-router";
import { Button } from "../../design";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import { OverviewCard } from "../overview";
import { settingsPath } from "../settings/paths";
import styles from "./ClusterScreen.module.css";
import { ControlPlaneSection } from "./ControlPlaneSection";

/** The Cluster card (spec §3.4): the facts, the namespaces warning and the control plane. */
export function ClusterCard(props: { clusterId: string; info: ClusterInfo }) {
  const { clusterId, info } = props;
  const navigate = useNavigate();
  return (
    <OverviewCard title="Cluster" testId="overview-cluster">
      <dl className={styles.facts}>
        <dt>Version</dt>
        <dd data-testid="cluster-info-version">{info.version}</dd>
        <dt>Distribution</dt>
        <dd data-testid="cluster-info-distribution">{info.distribution}</dd>
        <dt>Nodes</dt>
        <dd data-testid="cluster-info-nodes">{info.nodeCount ?? "Unknown"}</dd>
        <dt>Namespaces</dt>
        <dd data-testid="cluster-info-namespaces">
          {info.namespacesRestricted ? "Restricted" : info.namespaces.length}
        </dd>
      </dl>
      {info.namespacesRestricted ? (
        <div className={styles.warnRow}>
          <p
            className={styles.warn}
            role="status"
            data-testid="cluster-namespaces-warning"
          >
            You may not list this cluster's namespaces, so only these are used:{" "}
            {info.namespaces.join(", ")}.
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="cluster-namespaces-settings"
            onClick={() => navigate(settingsPath(clusterId))}
          >
            Cluster settings
          </Button>
        </div>
      ) : null}
      <ControlPlaneSection clusterId={clusterId} />
    </OverviewCard>
  );
}
