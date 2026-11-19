import { useClusterResources } from "../../stores/discovery";
import { Sidebar } from "./Sidebar";

/** The navigation of a connected cluster, with its custom resources kept current (spec P23). */
export function ClusterNav(props: { clusterId: string }) {
  const { clusterId } = props;
  const { resources, loading, error, refresh } = useClusterResources(clusterId);
  return (
    <Sidebar
      clusterId={clusterId}
      resources={resources}
      loading={loading}
      error={error}
      onRetry={() => void refresh()}
    />
  );
}
