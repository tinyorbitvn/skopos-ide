import { useCallback } from "react";
import { useNavigate } from "react-router";
import { resourcePath } from "../../kinds/nav";
import { type DetailsDockTab, useDock } from "../../stores/dock";
import type { DrawerEntry, DrawerRouteState } from "../details/drawerHistory";

/**
 * The list of the entry's kind with its drawer open on the entry. The `object` key is
 * `<namespace>/<name>`, or `/<name>` when cluster-scoped, as ResourceScreen reads it.
 */
export function drawerPath(clusterId: string, entry: DrawerEntry): string {
  const { group, plural, namespace, name } = entry.target;
  const key = `${namespace ?? ""}/${name}`;
  return `${resourcePath(clusterId, group, plural)}?object=${encodeURIComponent(key)}`;
}

/**
 * Open as drawer (spec K14, K15): shows the entry in the drawer over its own list, on
 * the entry's tab, and closes the details tab. On the same list it changes only the
 * `object` parameter.
 */
export function useOpenAsDrawer(): (
  tab: DetailsDockTab,
  entry: DrawerEntry,
) => void {
  const navigate = useNavigate();
  return useCallback(
    (tab: DetailsDockTab, entry: DrawerEntry) => {
      const state: DrawerRouteState = { drawerTab: entry.tab };
      navigate(drawerPath(tab.clusterId, entry), { state });
      useDock.getState().close(tab.id);
    },
    [navigate],
  );
}
