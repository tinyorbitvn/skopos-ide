import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { NavLink, useMatch } from "react-router";
import {
  ContextMenu,
  IconButton,
  Menu,
  Spinner,
  StatusDot,
  Tooltip,
} from "../design";
import {
  CircleHelp,
  Command,
  Info,
  Keyboard,
  LayoutGrid,
  Pin,
  RefreshCw,
  Settings,
  TriangleAlert,
} from "../design/icons";
import { settingsPath } from "../features/settings/paths";
import { checkForUpdates } from "../features/updates/updateStore";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import { useCatalog } from "../stores/catalog";
import { connectCluster, disconnectCluster } from "../stores/clusters";
import { useShell } from "../stores/shell";
import { clusterStatus } from "./clusterStatus";
import { clusterColor, clusterInitials } from "./clusterVisual";
import styles from "./Hotbar.module.css";
import { openPath, useNavItem } from "./tabs/navigation";

function HotbarItem({ cluster }: { cluster: ClusterEntry }) {
  const unpin = useCatalog((s) => s.unpin);
  // Active while the focused tab is on this cluster (spec P2).
  const shown = useMatch({ path: "/cluster/:id", end: false })?.params.id;
  const active = shown === cluster.id;
  // The tile is a navigation item for the cluster's Overview (P11 to P13).
  const open = useNavItem(`/cluster/${encodeURIComponent(cluster.id)}`);
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: cluster.id });
  const status = clusterStatus(cluster.state);
  const live =
    cluster.state.status === "connected" ||
    cluster.state.status === "connecting";

  return (
    <li
      ref={setNodeRef}
      className={styles.slot}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <ContextMenu
        items={[
          {
            id: "settings",
            label: "Settings",
            onSelect: () => void openPath(settingsPath(cluster.id), "current"),
          },
          live
            ? {
                id: "disconnect",
                label: "Disconnect",
                onSelect: () => void disconnectCluster(cluster.id),
              }
            : {
                id: "connect",
                label: "Connect",
                // As in the catalog: a kubeconfig with a problem cannot connect.
                disabled: cluster.problem !== null,
                tooltip: cluster.problem ?? undefined,
                onSelect: () => void connectCluster(cluster.id),
              },
          {
            id: "unpin",
            label: "Unpin",
            separated: true,
            onSelect: () => void unpin(cluster.id),
          },
        ]}
      >
        <div>
          <Tooltip
            content={
              <span className={styles.tipName} title={cluster.name}>
                {cluster.name}
              </span>
            }
          >
            <button
              {...attributes}
              {...listeners}
              type="button"
              className={styles.item}
              style={{ backgroundColor: clusterColor(cluster.id) }}
              aria-label={cluster.name}
              aria-current={active ? "page" : undefined}
              data-testid={`hotbar-item-${cluster.id}`}
              {...open}
            >
              {cluster.icon ? (
                <img src={cluster.icon} alt="" className={styles.icon} />
              ) : (
                <span aria-hidden="true">{clusterInitials(cluster.name)}</span>
              )}
              <span className={styles.status}>
                <StatusDot tone={status.tone} label={status.label} />
              </span>
            </button>
          </Tooltip>
        </div>
      </ContextMenu>
    </li>
  );
}

function RailLink(props: {
  to: string;
  label: string;
  testId: string;
  icon: React.ReactNode;
}) {
  const open = useNavItem(props.to);
  return (
    <Tooltip content={props.label}>
      <NavLink
        {...open}
        to={props.to}
        aria-label={props.label}
        data-testid={props.testId}
        className={styles.link}
      >
        {props.icon}
      </NavLink>
    </Tooltip>
  );
}

function RailNotice(props: { label: string; icon: React.ReactNode }) {
  return (
    <Tooltip content={props.label}>
      <span role="img" aria-label={props.label} className={styles.notice}>
        {props.icon}
      </span>
    </Tooltip>
  );
}

/**
 * Spec C §9.1: the shell dialogs from the rail, without key chips, and Check for
 * Updates (in-app update R7).
 */
function HelpMenu() {
  const open = useShell((s) => s.open);
  return (
    <Menu
      trigger={
        <IconButton
          label="Help"
          tooltip={false}
          icon={<CircleHelp size={18} aria-hidden="true" />}
          className={styles.help}
          data-testid="hotbar-help"
        />
      }
      items={[
        {
          id: "palette",
          label: "Command palette",
          icon: <Command size={14} aria-hidden="true" />,
          testId: "help-palette",
          onSelect: () => open("palette"),
        },
        {
          id: "shortcuts",
          label: "Keyboard shortcuts",
          icon: <Keyboard size={14} aria-hidden="true" />,
          testId: "help-shortcuts",
          onSelect: () => open("shortcuts"),
        },
        {
          id: "about",
          label: "About SkoposIDE",
          icon: <Info size={14} aria-hidden="true" />,
          testId: "help-about",
          onSelect: () => open("about"),
        },
        {
          id: "check-updates",
          label: "Check for Updates…",
          icon: <RefreshCw size={14} aria-hidden="true" />,
          testId: "help-check-updates",
          onSelect: () => void checkForUpdates(),
        },
      ]}
    />
  );
}

export function Hotbar() {
  const clusters = useCatalog((s) => s.clusters);
  const hotbar = useCatalog((s) => s.hotbar);
  const loading = useCatalog((s) => s.loading);
  const error = useCatalog((s) => s.error);
  const reorderHotbar = useCatalog((s) => s.reorderHotbar);

  const pinned = hotbar.flatMap((id) => {
    const cluster = clusters.find((c) => c.id === id);
    return cluster ? [cluster] : [];
  });

  const sensors = useSensors(
    // A small threshold, so a plain click still opens the cluster.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter stays a click on the item.
      keyboardCodes: {
        start: ["Space"],
        cancel: ["Escape"],
        end: ["Space"],
      },
    }),
  );

  function onDragEnd({ active, over }: DragEndEvent): void {
    if (!over || active.id === over.id) return;
    const ids = pinned.map((c) => c.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) void reorderHotbar(arrayMove(ids, from, to));
  }

  return (
    <nav className={styles.rail} aria-label="Hotbar" data-testid="hotbar">
      <RailLink
        to="/catalog"
        label="Catalog"
        testId="nav-catalog"
        icon={<LayoutGrid size={18} aria-hidden="true" />}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={pinned.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className={styles.list}>
            {pinned.map((cluster) => (
              <HotbarItem key={cluster.id} cluster={cluster} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {loading ? <Spinner /> : null}
      {!loading && error ? (
        <RailNotice
          label="The clusters could not be loaded"
          icon={<TriangleAlert size={18} aria-hidden="true" />}
        />
      ) : null}
      {!loading && !error && pinned.length === 0 ? (
        <RailNotice
          label="Pin clusters from the catalog to keep them here"
          icon={<Pin size={18} aria-hidden="true" />}
        />
      ) : null}
      <div className={styles.spacer} />
      <HelpMenu />
      <RailLink
        to="/preferences"
        label="Preferences"
        testId="nav-preferences"
        icon={<Settings size={18} aria-hidden="true" />}
      />
    </nav>
  );
}
