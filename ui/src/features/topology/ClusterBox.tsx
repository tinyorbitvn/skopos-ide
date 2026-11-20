import type { ReactNode } from "react";
import { Cluster } from "../../design/icons";
import styles from "./Topology.module.css";

/**
 * The cluster (topology spec §3.3): a solid accent box with a filled tab at its top-left
 * holding the cluster icon, and "<cluster> · <distribution> <version>" beside it.
 */
export function ClusterBox(props: { label: string; children: ReactNode }) {
  return (
    <div className={styles.cluster} data-testid="topology-cluster">
      <div className={styles.clusterHead}>
        <span className={styles.clusterTab}>
          <Cluster size={16} />
        </span>
        <p className={styles.clusterLabel} data-testid="topology-cluster-label">
          {props.label}
        </p>
      </div>
      <div className={styles.clusterBody}>{props.children}</div>
    </div>
  );
}
