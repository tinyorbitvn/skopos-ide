import { useMemo } from "react";
import { Badge, Button, IconButton } from "../design";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  Power,
  Search,
  Settings,
} from "../design/icons";
import { AgentButton } from "../features/agents/AgentButton";
import { useCatalog } from "../stores/catalog";
import { useConnect } from "../stores/clusters";
import { useShell } from "../stores/shell";
import { useWindowLayout } from "../stores/windowLayout";
import styles from "./AppHeader.module.css";
import { clusterStatus } from "./clusterStatus";
import { runCommand, useCommandContext } from "./commands";
import { IS_MAC, shortKeys } from "./shortcuts";
import { focusedTab } from "./tabs/layout";
import { tabInfo } from "./tabs/routes";
import { useFocusedPath } from "./tabs/ShellRouter";

/** The focused tab's title (spec P3, P9), or the empty window's. */
function useFocusedTitle(): string {
  const path = useFocusedPath();
  const clusters = useCatalog((s) => s.clusters);
  return useMemo(
    () => (path === null ? "No tabs open" : tabInfo(path, clusters).title),
    [path, clusters],
  );
}

/**
 * Disconnect on a connected cluster route (spec C §5, item 7). A terminal opens from the
 * dock's Create menu, the palette or Ctrl+` (spec Q §4).
 */
function ConnectedActions({ id }: { id: string }) {
  const { disconnect, busy } = useConnect(id);
  return (
    <Button
      data-testid="cluster-disconnect"
      disabled={busy}
      onClick={() => void disconnect()}
    >
      <Power size={14} aria-hidden="true" />
      Disconnect
    </Button>
  );
}

/** The bar at the top of the content column on every route (spec C §5). */
export function AppHeader() {
  const ctx = useCommandContext();
  const { cluster, pathname } = ctx;
  const title = useFocusedTitle();
  // Back and forward move through the focused tab's own history (spec P3).
  const canBack = useWindowLayout(
    (s) => (focusedTab(s.layout)?.index ?? 0) > 0,
  );
  const canForward = useWindowLayout((s) => {
    const tab = focusedTab(s.layout);
    return tab !== null && tab.index < tab.history.length - 1;
  });
  const status = cluster === null ? null : clusterStatus(cluster.state);
  const info =
    cluster?.state.status === "connected" ? cluster.state.info : null;
  const paletteKeys = shortKeys("palette", IS_MAC);

  return (
    <header className={styles.header} data-testid="app-header">
      <div className={styles.history}>
        <IconButton
          label={`Back (${shortKeys("back", IS_MAC)})`}
          icon={<ArrowLeft size={16} aria-hidden="true" />}
          disabled={!canBack}
          onClick={() => ctx.navigate(-1)}
          data-testid="header-back"
        />
        <IconButton
          label={`Forward (${shortKeys("forward", IS_MAC)})`}
          icon={<ArrowRight size={16} aria-hidden="true" />}
          disabled={!canForward}
          onClick={() => ctx.navigate(1)}
          data-testid="header-forward"
        />
      </div>
      <h1 className={styles.title} data-testid="header-title">
        {title}
      </h1>
      {status !== null ? (
        <span data-testid="connection-status">
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
      ) : null}
      {info !== null ? (
        <span className={styles.distribution} data-testid="header-distribution">
          {`${info.distribution || "Kubernetes"} · ${info.version}`}
        </span>
      ) : null}
      <div className={styles.spacer} />
      <button
        type="button"
        className={styles.palette}
        data-testid="palette-open"
        aria-label={`Command palette (${paletteKeys})`}
        aria-keyshortcuts="Control+Shift+P Meta+Shift+P"
        onClick={() => useShell.getState().open("palette")}
      >
        <Search size={14} aria-hidden="true" />
        <span className={styles.paletteText}>Search or run a command</span>
        <kbd className={styles.chip}>{paletteKeys}</kbd>
      </button>
      <AgentButton />
      {pathname === "/catalog" ? (
        <Button
          variant="primary"
          data-testid="catalog-add"
          onClick={() => useShell.getState().openAddCluster()}
        >
          <Plus size={14} aria-hidden="true" />
          Add cluster
        </Button>
      ) : null}
      {cluster !== null ? (
        <IconButton
          label="Cluster settings"
          icon={<Settings size={16} aria-hidden="true" />}
          onClick={() => runCommand("cluster-settings", ctx)}
          data-testid="header-cluster-settings"
        />
      ) : null}
      {cluster !== null && info !== null ? (
        <ConnectedActions key={cluster.id} id={cluster.id} />
      ) : null}
    </header>
  );
}
