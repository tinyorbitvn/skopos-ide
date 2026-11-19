import { Outlet, useOutletContext } from "react-router";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { useClusterResources } from "../../stores/discovery";
import styles from "./ClusterLayout.module.css";

/** What the layout hands to the routes below it. */
export interface ClusterOutletContext {
  clusterId: string;
  resources: ApiResourceInfo[];
  resourcesLoading: boolean;
  resourcesError: string | null;
}

export function useClusterContext(): ClusterOutletContext {
  return useOutletContext<ClusterOutletContext>();
}

/**
 * The routed content of a connected cluster's tab. The sidebar and the dock belong to
 * the window's shell (spec P1, P23, P37).
 */
export function ClusterLayout(props: { clusterId: string }) {
  const { clusterId } = props;
  const { resources, loading, error } = useClusterResources(clusterId);
  const context: ClusterOutletContext = {
    clusterId,
    resources,
    resourcesLoading: loading,
    resourcesError: error,
  };
  return (
    <div className={styles.content}>
      <Outlet context={context} />
    </div>
  );
}
