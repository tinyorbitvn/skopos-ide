import { useClusterResources } from "../../stores/discovery";
import { Sidebar } from "./Sidebar";
import { SidebarRail } from "./SidebarRail";

/**
 * The navigation of a connected cluster, with its custom resources kept current (spec
 * P23): the sidebar, or the icon rail while the sidebar is collapsed (spec Q §3).
 */
export function ClusterNav(props: { clusterId: string; collapsed?: boolean }) {
  const { clusterId } = props;
  const { resources, loading, error, refresh } = useClusterResources(clusterId);
  const Nav = props.collapsed ? SidebarRail : Sidebar;
  return (
    <Nav
      clusterId={clusterId}
      resources={resources}
      loading={loading}
      error={error}
      onRetry={() => void refresh()}
    />
  );
}
