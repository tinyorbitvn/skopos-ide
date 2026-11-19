import { useCatalog } from "../../stores/catalog";
import { nextTerminalNumber, terminalTab, useDock } from "../../stores/dock";

function clusterName(clusterId: string): string | null {
  return (
    useCatalog.getState().clusters.find((c) => c.id === clusterId)?.name ?? null
  );
}

/**
 * Brings the cluster's terminal forward and shows the dock: the active tab when it is
 * one, else the first. Opens the cluster's first terminal when it has none.
 */
export function openTerminal(clusterId: string): void {
  const dock = useDock.getState();
  const terminals = dock.tabs.filter(
    (t) => t.kind === "terminal" && t.clusterId === clusterId,
  );
  const shown =
    terminals.find((t) => t.id === dock.activeId) ?? terminals[0] ?? null;
  dock.open(shown ?? terminalTab(clusterId, clusterName(clusterId)));
}

/** Opens a new local terminal of the cluster, beside the ones it has, and shows the dock. */
export function newTerminal(clusterId: string): void {
  const dock = useDock.getState();
  const number = nextTerminalNumber(dock.tabs, clusterId);
  dock.open(terminalTab(clusterId, clusterName(clusterId), number));
}
