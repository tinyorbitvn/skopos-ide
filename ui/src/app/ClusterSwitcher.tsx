import { useEffect, useMemo, useRef, useState } from "react";
import { StatusDot, Tooltip } from "../design";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  Search,
} from "../design/icons";
import {
  type FolderTree,
  type TreeRow,
  treeRows,
} from "../features/catalog/folderTree";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { useCatalog } from "../stores/catalog";
import { connectCluster } from "../stores/clusters";
import { useFolders } from "../stores/folders";
import { useWindowLayout } from "../stores/windowLayout";
import styles from "./ClusterSwitcher.module.css";
import { clusterRelease, clusterStatus } from "./clusterStatus";
import { clusterColor, clusterInitials } from "./clusterVisual";
import { focusedPane, focusedTab } from "./tabs/layout";
import { tabCluster } from "./tabs/routes";
import { useFocusedPath } from "./tabs/ShellRouter";

const NAME = "Cluster shown in the sidebar";
/** Each level of the list sits this much further in. */
const INDENT_PX = 14;

/**
 * The line above the switcher's name: `<distribution> · <version>` while connected
 * (CSS draws it in capitals), else the state word. An empty distribution reads
 * "Kubernetes"; an empty version is left out (spec Q §2). Build metadata after a "+"
 * (`v1.37.0+rke2r1`) is left out too: the overline has room for the release only.
 */
export function switcherOverline(state: ConnectionState): string {
  if (state.status !== "connected") return clusterStatus(state).label;
  const { distribution, version } = clusterRelease(state.info);
  return version === "" ? distribution : `${distribution} · ${version}`;
}

/** The trigger's accessible name (spec Q §2). */
function triggerLabel(cluster: ClusterEntry | undefined): string {
  if (cluster === undefined) return NAME;
  const state = clusterStatus(cluster.state).label.toLowerCase();
  return `Cluster ${cluster.name}, ${state}. Change the cluster shown in the sidebar`;
}

/** The trigger's title; none while collapsed, where a tooltip names the cluster. */
function triggerTitle(
  cluster: ClusterEntry | undefined,
  collapsed: boolean,
): string | undefined {
  if (collapsed) return undefined;
  if (cluster === undefined) return NAME;
  const state = clusterStatus(cluster.state).label;
  return `${cluster.name} · ${state}. Click to show another cluster in the sidebar`;
}

export interface SidebarCluster {
  /** The cluster the sidebar shows, or null. */
  clusterId: string | null;
  /** The focused tab's cluster, or null on a tab without one. */
  focused: string | null;
  /** Shows a cluster in the sidebar until focus moves to another tab (P25). */
  pick(id: string): void;
  /** Shows the focused tab's cluster again. */
  follow(): void;
}

/**
 * The cluster the sidebar shows (spec P23, P25): one picked in the switcher until focus
 * moves to another tab (or that tab moves to another pane or another cluster); else
 * the focused tab's; on a tab without a cluster, the one it showed before. A cluster
 * gone from the catalog is dropped.
 */
export function useSidebarCluster(): SidebarCluster {
  const path = useFocusedPath();
  const focused = path === null ? null : tabCluster(path);
  const tabId = useWindowLayout((s) => focusedTab(s.layout)?.id ?? null);
  const paneId = useWindowLayout((s) => focusedPane(s.layout)?.id ?? null);
  const focus = `${tabId ?? ""}\n${paneId ?? ""}\n${focused ?? ""}`;
  const [picked, setPicked] = useState<{ id: string; focus: string } | null>(
    null,
  );
  const [shown, setShown] = useState<string | null>(focused);
  let pick = picked;
  if (pick !== null && pick.focus !== focus) {
    pick = null;
    setPicked(null);
  }
  const id = pick?.id ?? focused ?? shown;
  if (id !== shown) setShown(id);
  const known = useCatalog(
    (s) => id === null || s.loading || s.clusters.some((c) => c.id === id),
  );
  return {
    clusterId: known ? id : null,
    focused,
    pick(cluster) {
      setPicked(cluster === focused ? null : { id: cluster, focus });
      setShown(cluster);
      const state = useCatalog
        .getState()
        .clusters.find((c) => c.id === cluster)?.state;
      // A cluster picked here connects, as opening it does (P25).
      if (state?.status === "disconnected") void connectCluster(cluster);
    },
    follow() {
      setPicked(null);
    },
  };
}

function Tile(props: { cluster: ClusterEntry | undefined }) {
  const { cluster } = props;
  if (cluster?.icon) {
    return <img src={cluster.icon} alt="" className={styles.tile} />;
  }
  return (
    <span
      aria-hidden="true"
      className={styles.tile}
      style={
        cluster ? { backgroundColor: clusterColor(cluster.id) } : undefined
      }
    >
      {cluster ? clusterInitials(cluster.name) : "?"}
    </span>
  );
}

function Row(props: {
  row: TreeRow<ClusterEntry>;
  selected: string | null;
  onToggle(id: string): void;
  onPick(id: string): void;
}) {
  const { row } = props;
  const indent = {
    paddingLeft: `calc(var(--space-3) + ${row.depth * INDENT_PX}px)`,
  };
  if (row.kind === "folder") {
    const Chevron = row.open ? ChevronDown : ChevronRight;
    const count = `${row.count} cluster${row.count === 1 ? "" : "s"}`;
    return (
      <button
        type="button"
        role="treeitem"
        className={`${styles.row} ${styles.folder}`}
        style={indent}
        aria-level={row.depth + 1}
        aria-expanded={row.open}
        aria-label={`${row.folder.name}, ${count}`}
        data-testid={`switcher-folder-${row.folder.id}`}
        onClick={() => props.onToggle(row.folder.id)}
      >
        <Chevron size={12} aria-hidden="true" className={styles.chevron} />
        <Folder size={14} aria-hidden="true" className={styles.icon} />
        <span className={styles.label}>{row.folder.name}</span>
        <span className={styles.count} aria-hidden="true">
          {row.count}
        </span>
      </button>
    );
  }
  const { cluster } = row;
  const status = clusterStatus(cluster.state);
  return (
    <button
      type="button"
      role="treeitem"
      className={styles.row}
      style={indent}
      aria-level={row.depth + 1}
      aria-selected={cluster.id === props.selected}
      aria-label={`${cluster.name}, ${status.label}`}
      data-testid={`switcher-cluster-${cluster.contextName}`}
      onClick={() => props.onPick(cluster.id)}
    >
      <span className={styles.chevron} />
      <StatusDot tone={status.tone} label={status.label} />
      <span className={styles.label}>{cluster.name}</span>
      {cluster.state.status === "connected" ? null : (
        <span className={styles.state}>{status.label}</span>
      )}
    </button>
  );
}

/**
 * The cluster switcher on top of the sidebar (spec P24, P25, Q §2): the shown cluster's
 * tile, overline and name; a list of the clusters under their folders with a search;
 * and, while the sidebar shows another cluster than the focused tab's, a way back to
 * it. Collapsed (spec Q §3), it is the tile alone, with the name in a tooltip.
 */
export function ClusterSwitcher(props: {
  clusterId: string | null;
  focused: string | null;
  onPick(id: string): void;
  onFollow(): void;
  collapsed?: boolean;
}) {
  const { clusterId, focused, onPick, onFollow } = props;
  const collapsed = props.collapsed === true;
  const clusters = useCatalog((s) => s.clusters);
  const folders = useFolders((s) => s.folders);
  const placements = useFolders((s) => s.placements);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const cluster = clusters.find((c) => c.id === clusterId);
  const status = cluster ? clusterStatus(cluster.state) : null;
  const other =
    focused !== null && focused !== clusterId
      ? (clusters.find((c) => c.id === focused)?.name ?? "Cluster")
      : null;

  const rows = useMemo(() => {
    const tree: FolderTree = { folders, placements };
    return treeRows(tree, clusters, {
      query,
      open: (id) => !closed.has(id),
    });
  }, [folders, placements, clusters, query, closed]);

  function close(refocus: boolean): void {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  }

  function pick(id: string): void {
    close(true);
    onPick(id);
  }

  function toggle(id: string): void {
    setClosed((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        wrap.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
      setQuery("");
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Collapsing the sidebar closes the menu (spec Q §3).
  useEffect(() => {
    if (!collapsed) return;
    setOpen(false);
    setQuery("");
  }, [collapsed]);

  const name = cluster?.name ?? "No cluster";
  const button = (
    <button
      ref={trigger}
      type="button"
      className={styles.trigger}
      title={triggerTitle(cluster, collapsed)}
      aria-label={triggerLabel(cluster)}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="switcher-trigger"
      onClick={() => (open ? close(false) : setOpen(true))}
    >
      <span className={styles.tileBox}>
        <Tile cluster={cluster} />
        {status ? (
          <span className={styles.tileDot}>
            <StatusDot tone={status.tone} label={status.label} />
          </span>
        ) : null}
      </span>
      <span className={styles.text}>
        <span className={styles.over}>
          {cluster ? switcherOverline(cluster.state) : "Pick a cluster"}
        </span>
        <span className={styles.name}>{name}</span>
      </span>
      <ChevronsUpDown size={14} aria-hidden="true" className={styles.updown} />
    </button>
  );

  return (
    <div
      ref={wrap}
      className={styles.switcher}
      data-collapsed={collapsed ? "true" : undefined}
    >
      {collapsed ? (
        <Tooltip content={name} side="right">
          {button}
        </Tooltip>
      ) : (
        button
      )}
      {other !== null && !collapsed ? (
        <p className={styles.follow} data-testid="switcher-follow">
          {`The focused tab is on ${other}. `}
          <button
            type="button"
            className={styles.link}
            data-testid="switcher-follow-show"
            onClick={onFollow}
          >
            {`Show ${other}`}
          </button>
        </p>
      ) : null}
      {open ? (
        <div
          role="dialog"
          aria-label={NAME}
          className={styles.panel}
          data-testid="switcher-menu"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close(true);
          }}
        >
          <div className={styles.searchRow}>
            <Search size={14} aria-hidden="true" className={styles.icon} />
            <input
              ref={search}
              type="text"
              className={styles.search}
              placeholder="Search clusters and folders"
              aria-label="Search clusters and folders"
              data-testid="switcher-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const first = rows.find((r) => r.kind === "cluster");
                if (first?.kind === "cluster") pick(first.cluster.id);
              }}
            />
          </div>
          <div
            className={styles.list}
            role="tree"
            aria-label="Clusters by folder"
          >
            {rows.map((row) => (
              <Row
                key={row.kind === "folder" ? row.folder.id : row.cluster.id}
                row={row}
                selected={clusterId}
                onToggle={toggle}
                onPick={pick}
              />
            ))}
            {rows.length === 0 ? (
              <p className={styles.none}>No cluster or folder matches.</p>
            ) : null}
          </div>
          <p className={styles.foot}>
            Changes only the sidebar. Tabs keep their cluster.
          </p>
        </div>
      ) : null}
    </div>
  );
}
