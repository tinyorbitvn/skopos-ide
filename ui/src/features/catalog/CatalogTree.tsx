import { ChevronDown, ChevronRight, CornerLeftUp, Folder } from "lucide-react";
import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import { clusterStatus } from "../../app/clusterStatus";
import {
  Badge,
  Button,
  Menu,
  type MenuItem,
  StatusDot,
  toast,
} from "../../design";
import { Ellipsis } from "../../design/glyphs";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { CatalogFolder } from "../../ipc/generated/CatalogFolder";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import { useCatalog } from "../../stores/catalog";
import { useFolders } from "../../stores/folders";
import { settingsPath } from "../settings/paths";
import styles from "./CatalogScreen.module.css";
import { dropText, startCatalogDrag, useCatalogDrag } from "./catalogDrag";
import { moveItem } from "./folderActions";
import {
  type FolderTree,
  type MoveItem,
  moveTargets,
  type TreeRow,
} from "./folderTree";

/** Each level of the tree sits this much further in. */
const INDENT_PX = 20;

export function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

function statusDetail(cluster: ClusterEntry): string | null {
  if (cluster.problem) return cluster.problem;
  return cluster.state.status === "failed" ? cluster.state.message : null;
}

/** A folder being renamed: the name typed so far and the core's refusal, if any. */
export interface Renaming {
  id: string;
  value: string;
  error: string | null;
}

/** What the rows ask of the Catalog screen. */
export interface TreeActions {
  tree: FolderTree;
  toggle(id: string): void;
  /** Opens a folder, after something moved into it. */
  expand(id: string): void;
  newFolder(parent: string | null): void;
  rename(folder: CatalogFolder): void;
  remove(folder: CatalogFolder): void;
  removeCluster(cluster: ClusterEntry): void;
  renaming: Renaming | null;
  typeName(value: string): void;
  saveName(): void;
  cancelName(): void;
}

function ConnectButton({ cluster }: { cluster: ClusterEntry }) {
  const [busy, setBusy] = useState(false);
  const status = cluster.state.status;
  const live = status === "connected" || status === "connecting";

  async function run(): Promise<void> {
    setBusy(true);
    try {
      if (live) await api.clusterDisconnect(cluster.id);
      else await api.clusterConnect(cluster.id);
    } catch (error) {
      const action = live ? "disconnect from" : "connect to";
      toast.error(`Could not ${action} ${cluster.name}`, failureMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size="sm"
      // A connect can run for minutes, and must stay cancellable meanwhile.
      loading={busy && status !== "connecting"}
      disabled={!live && cluster.problem !== null}
      onClick={() => void run()}
    >
      {live ? "Disconnect" : "Connect"}
    </Button>
  );
}

/** "Move to ▸": the top level and the folders, each disabled with why it cannot take it. */
function moveMenu(
  actions: TreeActions,
  item: MoveItem,
  name: string,
): MenuItem {
  return {
    id: "move",
    label: "Move to",
    sub: moveTargets(actions.tree, item).map((t) => ({
      id: t.id === null ? "move-top" : `move-${t.id}`,
      label: t.label,
      disabled: t.problem !== null,
      hint: t.problem ?? undefined,
      tooltip: t.problem ?? undefined,
      onSelect: () => {
        void moveItem(item, t.id, name).then((moved) => {
          if (moved && t.id !== null) actions.expand(t.id);
        });
      },
    })),
  };
}

/** The row actions: a press there opens a menu or connects, and never drags. */
function Actions(props: { children: ReactNode }) {
  return (
    // The row opens the cluster on click, and these controls must not.
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops bubbling.
    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops bubbling.
    <div
      className={styles.actions}
      data-catalog-actions
      onClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </div>
  );
}

/** A menu's trigger; an element, not a component, so the menu can give it its props. */
function menuButton(label: string, testId: string) {
  return (
    // No Tooltip here: closing the menu returns focus to this button,
    // and a tooltip opened by that focus would cover the row above.
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      title="Actions"
      data-testid={testId}
    >
      <Ellipsis size={16} aria-hidden="true" />
    </Button>
  );
}

function ClusterActions(props: {
  cluster: ClusterEntry;
  actions: TreeActions;
}) {
  const { cluster, actions } = props;
  const navigate = useNavigate();
  const pinned = useCatalog((s) => s.hotbar.includes(cluster.id));
  const pin = useCatalog((s) => s.pin);
  const unpin = useCatalog((s) => s.unpin);

  const items: MenuItem[] = [
    pinned
      ? {
          id: "unpin",
          label: "Unpin from hotbar",
          onSelect: () => void unpin(cluster.id),
        }
      : {
          id: "pin",
          label: "Pin to hotbar",
          onSelect: () => void pin(cluster.id),
        },
    {
      id: "settings",
      label: "Settings",
      onSelect: () => void navigate(settingsPath(cluster.id)),
    },
    moveMenu(actions, { kind: "cluster", id: cluster.id }, cluster.name),
  ];
  if (cluster.source.kind === "pasted") {
    items.push({
      id: "remove",
      label: "Remove",
      onSelect: () => actions.removeCluster(cluster),
    });
  }

  return (
    <Actions>
      <ConnectButton cluster={cluster} />
      <Menu
        items={items}
        trigger={menuButton(
          `Actions for ${cluster.name}`,
          `catalog-menu-${cluster.contextName}`,
        )}
      />
    </Actions>
  );
}

/** Starts a drag from a press on a row, but not from its actions or a name being typed. */
function dragFrom(
  event: PointerEvent<HTMLElement>,
  item: MoveItem,
  name: string,
  actions: TreeActions,
): void {
  const from = event.target instanceof Element ? event.target : null;
  if (from?.closest("input, [data-catalog-actions]")) return;
  // The tree as it is when the pointer moves, not as it was at the press.
  const tree = (): FolderTree => {
    const { folders, placements } = useFolders.getState();
    return { folders, placements };
  };
  startCatalogDrag(event.nativeEvent, item, name, tree, (moved, target) => {
    void moveItem(moved, target, name).then((done) => {
      if (done && target !== null) actions.expand(target);
    });
  });
}

/** The folder's name being typed: Enter saves, Esc or a press outside cancels (P29). */
function NameField(props: { actions: TreeActions; renaming: Renaming }) {
  const { actions, renaming } = props;
  const box = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef(actions.cancelName);
  cancel.current = actions.cancelName;

  useEffect(() => {
    // After a menu that opened the rename has put the focus back on its button.
    const timer = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) {
        return;
      }
      cancel.current();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  return (
    <span ref={box} className={styles.rename}>
      <input
        ref={input}
        type="text"
        className={styles.renameInput}
        aria-label="Folder name"
        aria-invalid={renaming.error !== null}
        aria-describedby={
          renaming.error === null ? undefined : "catalog-folder-rename-error"
        }
        data-testid="catalog-folder-rename"
        value={renaming.value}
        onChange={(event) => actions.typeName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            actions.saveName();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            actions.cancelName();
          }
        }}
      />
      {renaming.error === null ? null : (
        <span
          id="catalog-folder-rename-error"
          role="alert"
          className={styles.renameError}
          data-testid="catalog-folder-rename-error"
        >
          {renaming.error}
        </span>
      )}
    </span>
  );
}

/** A drag's state on a target row: takes it, refuses it, or neither. */
function useDropState(target: string | null): "ok" | "refused" | undefined {
  return useCatalogDrag((s) => {
    const over = s.drag?.over;
    if (!over || over.target !== target) return undefined;
    return over.problem === null ? "ok" : "refused";
  });
}

function useDragging(id: string): boolean {
  return useCatalogDrag((s) => s.drag?.item.id === id);
}

function FolderRow(props: {
  row: Extract<TreeRow<ClusterEntry>, { kind: "folder" }>;
  actions: TreeActions;
}) {
  const { row, actions } = props;
  const { folder } = row;
  const drop = useDropState(folder.id);
  const dragging = useDragging(folder.id);
  const renaming = actions.renaming?.id === folder.id ? actions.renaming : null;
  const Chevron = row.open ? ChevronDown : ChevronRight;
  const items: MenuItem[] = [
    {
      id: "new-subfolder",
      label: "New subfolder",
      onSelect: () => actions.newFolder(folder.id),
    },
    { id: "rename", label: "Rename", onSelect: () => actions.rename(folder) },
    moveMenu(actions, { kind: "folder", id: folder.id }, folder.name),
    {
      id: "delete",
      label: "Delete",
      danger: true,
      separated: true,
      onSelect: () => actions.remove(folder),
    },
  ];
  const count = `${row.count} cluster${row.count === 1 ? "" : "s"} inside`;
  return (
    <tr
      className={styles.folderRow}
      aria-level={row.depth + 1}
      aria-expanded={row.open}
      data-testid={`catalog-folder-${folder.id}`}
      data-catalog-drop={folder.id}
      data-drop={drop}
      data-dragging={dragging || undefined}
      onPointerDown={(event) =>
        dragFrom(event, { kind: "folder", id: folder.id }, folder.name, actions)
      }
    >
      <td>
        <div
          className={styles.nameCell}
          style={{ paddingLeft: row.depth * INDENT_PX }}
        >
          {renaming ? (
            <>
              <Chevron
                size={14}
                aria-hidden="true"
                className={styles.chevron}
              />
              <Folder
                size={14}
                aria-hidden="true"
                className={styles.folderIcon}
              />
              <NameField actions={actions} renaming={renaming} />
            </>
          ) : (
            <button
              type="button"
              className={styles.toggle}
              aria-expanded={row.open}
              title={folder.name}
              data-testid={`catalog-folder-toggle-${folder.id}`}
              onClick={() => actions.toggle(folder.id)}
            >
              <Chevron
                size={14}
                aria-hidden="true"
                className={styles.chevron}
              />
              <Folder
                size={14}
                aria-hidden="true"
                className={styles.folderIcon}
              />
              <span className={styles.truncated}>{folder.name}</span>
            </button>
          )}
          <span
            className={styles.count}
            title={count}
            data-testid={`catalog-folder-count-${folder.id}`}
          >
            {row.count}
          </span>
        </div>
      </td>
      <td />
      <td />
      <td />
      <td>
        <Actions>
          <Menu
            items={items}
            trigger={menuButton(
              `Actions for folder ${folder.name}`,
              `catalog-folder-menu-${folder.id}`,
            )}
          />
        </Actions>
      </td>
    </tr>
  );
}

function ClusterRow(props: {
  row: Extract<TreeRow<ClusterEntry>, { kind: "cluster" }>;
  actions: TreeActions;
}) {
  const { row, actions } = props;
  const { cluster: c } = row;
  const navigate = useNavigate();
  const dragging = useDragging(c.id);
  const status = clusterStatus(c.state);
  const detail = statusDetail(c);
  const to = `/cluster/${encodeURIComponent(c.id)}`;
  return (
    <tr
      className={styles.clusterRow}
      aria-level={row.depth + 1}
      data-testid={`catalog-row-${c.contextName}`}
      data-dragging={dragging || undefined}
      onClick={() => void navigate(to)}
      onPointerDown={(event) =>
        dragFrom(event, { kind: "cluster", id: c.id }, c.name, actions)
      }
    >
      <td>
        <div
          className={styles.nameCell}
          style={{ paddingLeft: row.depth * INDENT_PX }}
        >
          <span className={styles.chevron} />
          <Link
            to={to}
            className={styles.name}
            title={c.name}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
          >
            {c.name}
          </Link>
        </div>
      </td>
      <td>
        <span className={styles.source}>
          <span className={styles.truncated} title={c.source.path}>
            {basename(c.source.path)}
          </span>
          {c.source.kind === "pasted" ? (
            <Badge tone="info">Pasted</Badge>
          ) : null}
        </span>
      </td>
      <td>
        {c.state.status === "connected" ? c.state.info.distribution : null}
      </td>
      <td>
        <span className={styles.status}>
          <StatusDot tone={status.tone} label={status.label} />
          <span>{status.label}</span>
          {detail ? (
            <span className={styles.detail} title={detail}>
              {detail}
            </span>
          ) : null}
        </span>
      </td>
      <td>
        <ClusterActions cluster={c} actions={actions} />
      </td>
    </tr>
  );
}

/**
 * While a drag is on: the strip that takes a folder or cluster out to the top level.
 * It lies over the table head and takes no room, so no row moves under the pointer
 * when the drag starts.
 */
function TopLevelStrip() {
  const drop = useDropState(null);
  return (
    <div
      className={styles.topStrip}
      data-catalog-drop="top"
      data-drop={drop}
      data-testid="catalog-drop-top"
    >
      <CornerLeftUp size={14} aria-hidden="true" />
      Top level: drop here to take it out of its folder
    </div>
  );
}

/** Beside the pointer while dragging: the name, and what letting go does. */
function DragLabel() {
  const drag = useCatalogDrag((s) => s.drag);
  if (drag === null) return null;
  const take = drag.over !== null && drag.over.problem === null;
  return createPortal(
    <div
      className={styles.dragLabel}
      style={{ left: drag.x + 14, top: drag.y + 14 }}
      aria-hidden="true"
      data-testid="catalog-drag-label"
      data-drop={drag.over === null ? undefined : take ? "ok" : "refused"}
    >
      <strong>{drag.name}</strong>
      <span>{dropText(drag.over)}</span>
    </div>,
    document.body,
  );
}

/**
 * The Catalog as a tree table (spec P29): today's columns, folders with a chevron, an
 * icon, the name and the clusters inside, then clusters, with menus, inline rename and
 * drag and drop onto folder rows or the "Top level" strip.
 */
export function CatalogTree(props: {
  rows: TreeRow<ClusterEntry>[];
  actions: TreeActions;
}) {
  const dragging = useCatalogDrag((s) => s.drag !== null);
  return (
    <>
      {dragging ? <TopLevelStrip /> : null}
      <table
        className={styles.tree}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a table whose rows open and close is the ARIA treegrid pattern.
        role="treegrid"
        aria-label="Clusters by folder"
        data-testid="catalog-table"
      >
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ width: "20%" }}>Source</th>
            <th style={{ width: "120px" }}>Distribution</th>
            <th style={{ width: "28%" }}>Status</th>
            <th style={{ width: "150px" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) =>
            row.kind === "folder" ? (
              <FolderRow
                key={row.folder.id}
                row={row}
                actions={props.actions}
              />
            ) : (
              <ClusterRow
                key={row.cluster.id}
                row={row}
                actions={props.actions}
              />
            ),
          )}
        </tbody>
      </table>
      <DragLabel />
    </>
  );
}
