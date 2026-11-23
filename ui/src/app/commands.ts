import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Columns2,
  type IconComponent,
  Info,
  Keyboard,
  LayoutGrid,
  MessageSquarePlus,
  Monitor,
  Moon,
  Network,
  Package,
  Pin,
  Plus,
  Power,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Sun,
  X,
} from "../design/icons";
import { agentsSupported } from "../features/agents/supported";
import { openTerminal } from "../features/dock/openTerminal";
import { chartsPath } from "../features/helm/helmText";
import { mapPath } from "../features/map/paths";
import { OVERVIEW_ICONS } from "../features/palette/icons";
import { settingsPath } from "../features/settings/paths";
import { topologyPath } from "../features/topology/paths";
import { checkForUpdates } from "../features/updates/updateStore";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { Theme } from "../ipc/generated/Theme";
import { visibleSections } from "../kinds/nav";
import { useAgentChat } from "../stores/agentChat";
import { disconnectCluster } from "../stores/clusters";
import { usePrefs } from "../stores/prefs";
import { useShell } from "../stores/shell";
import { toggleSidebar, useSidebarToggle } from "../stores/sidebarCollapse";
import { useWindowLayout } from "../stores/windowLayout";
import { type CurrentCluster, useCurrentCluster } from "./currentCluster";
import { otherModalOpen } from "./shellKeys";
import type { ShortcutId } from "./shortcuts";
import { focusedTab, MAX_PANES } from "./tabs/layout";
import { closeFocusedTab, splitFocusedTab } from "./tabs/tabKeys";
import { openInNewWindow } from "./tabs/windowMoves";

/** What a command sees when it is listed and when it runs. */
export interface CommandContext {
  navigate(to: string | number): void;
  pathname: string;
  cluster: CurrentCluster | null;
  /**
   * What the current cluster serves, where the caller has read it (the palette does). An
   * overview command shows only while the sidebar shows its page, which this tells.
   */
  resources?: ApiResourceInfo[];
}

export type CommandId =
  | "catalog"
  | "preferences"
  | "add-cluster"
  | "install-chart"
  | "terminal"
  | "disconnect"
  | "cluster-settings"
  | "resource-map"
  | "node-topology"
  | "workloads-overview"
  | "nodes-overview"
  | "namespaces-overview"
  | "network-overview"
  | "storage-overview"
  | "shortcuts"
  | "agent-open"
  | "agent-new-chat"
  | "agent-ask"
  | "about"
  | "check-updates"
  | "theme-dark"
  | "theme-light"
  | "theme-system"
  | "toggle-sidebar"
  | "back"
  | "forward"
  | "split-right"
  | "close-tab"
  | "pin-tab"
  | "new-window";

export interface AppCommand {
  id: CommandId;
  /** A function, because some labels name the cluster. */
  label(ctx: CommandContext): string;
  icon: IconComponent;
  /** The icon for the state now, when it changes with it; the palette uses it over `icon`. */
  iconFor?(): IconComponent;
  shortcut?: ShortcutId;
  /**
   * The location the command opens, if it only opens one: a click on its palette row
   * then opens it by the click's mode (spec P11 to P13). Null when it cannot here.
   */
  path?(ctx: CommandContext): string | null;
  available(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void;
}

const always = () => true;

function connected(ctx: CommandContext): boolean {
  return ctx.cluster?.state.status === "connected";
}

function onCluster(ctx: CommandContext): boolean {
  return ctx.cluster !== null;
}

function clusterName(ctx: CommandContext): string {
  return ctx.cluster?.name ?? "Cluster";
}

/** A location of the current cluster, or null off a cluster. */
function clusterPath(
  ctx: CommandContext,
  path: (clusterId: string) => string,
): string | null {
  return ctx.cluster ? path(ctx.cluster.id) : null;
}

/** This window's focused tab, which the tab commands act on (spec P17). */
function shownTab() {
  return focusedTab(useWindowLayout.getState().layout);
}

/** Navigates unless the route is already there, so a key that reaches the app twice
 * (the macOS menu and the webview) does not push a second history entry. */
function go(ctx: CommandContext, path: string): void {
  if (ctx.pathname !== path) ctx.navigate(path);
}

async function setTheme(theme: Theme): Promise<void> {
  // Bootstrap loads the preferences; a failed load is retried here.
  if (usePrefs.getState().prefs === null) await usePrefs.getState().load();
  await usePrefs.getState().setTheme(theme);
}

function theme(
  id: CommandId,
  label: string,
  icon: IconComponent,
  value: Theme,
): AppCommand {
  return {
    id,
    label: () => label,
    icon,
    available: always,
    run: () => void setTheme(value),
  };
}

/**
 * A section overview's command (section overviews spec §3.7), labelled
 * `<page title> of <cluster>`: it shows while the cluster is connected and the sidebar
 * shows the page at `/cluster/:id/<page>`.
 */
function overviewCommand(
  id: CommandId,
  page: string,
  title: string,
  icon: IconComponent,
): AppCommand {
  const pagePath = (clusterId: string) =>
    `/cluster/${encodeURIComponent(clusterId)}/${page}`;
  return {
    id,
    label: (ctx) => `${title} of ${clusterName(ctx)}`,
    icon,
    path: (ctx) => clusterPath(ctx, pagePath),
    available: (ctx) =>
      connected(ctx) &&
      ctx.resources !== undefined &&
      visibleSections(ctx.resources).some((s) => s.overview === page),
    run: (ctx) => {
      if (ctx.cluster) go(ctx, pagePath(ctx.cluster.id));
    },
  };
}

/** Spec C §4.1, in the palette's order. */
export const COMMANDS: readonly AppCommand[] = [
  {
    id: "catalog",
    label: () => "Go to the catalog",
    icon: LayoutGrid,
    path: () => "/catalog",
    available: always,
    run: (ctx) => go(ctx, "/catalog"),
  },
  {
    id: "preferences",
    label: () => "Open Preferences",
    icon: Settings,
    shortcut: "preferences",
    path: () => "/preferences",
    available: always,
    run: (ctx) => {
      useShell.getState().close();
      go(ctx, "/preferences");
    },
  },
  {
    id: "add-cluster",
    label: () => "Add a cluster",
    icon: Plus,
    available: always,
    run: (ctx) => {
      go(ctx, "/catalog");
      useShell.getState().openAddCluster();
    },
  },
  {
    id: "install-chart",
    label: () => "Install a Helm chart",
    icon: Package,
    path: (ctx) => clusterPath(ctx, chartsPath),
    available: connected,
    run: (ctx) => {
      if (ctx.cluster) go(ctx, chartsPath(ctx.cluster.id));
    },
  },
  {
    id: "terminal",
    label: (ctx) => `Open a terminal in ${clusterName(ctx)}`,
    icon: SquareTerminal,
    shortcut: "terminal",
    available: connected,
    run: (ctx) => {
      if (ctx.cluster) openTerminal(ctx.cluster.id);
    },
  },
  {
    id: "disconnect",
    label: (ctx) => `Disconnect ${clusterName(ctx)}`,
    icon: Power,
    available: connected,
    run: (ctx) => {
      if (ctx.cluster) void disconnectCluster(ctx.cluster.id);
    },
  },
  {
    id: "cluster-settings",
    label: (ctx) => `Cluster settings for ${clusterName(ctx)}`,
    icon: SlidersHorizontal,
    path: (ctx) => clusterPath(ctx, settingsPath),
    available: onCluster,
    run: (ctx) => {
      if (ctx.cluster) go(ctx, settingsPath(ctx.cluster.id));
    },
  },
  {
    id: "resource-map",
    label: (ctx) => `Resource map of ${clusterName(ctx)}`,
    icon: Network,
    path: (ctx) => clusterPath(ctx, mapPath),
    available: connected,
    run: (ctx) => {
      if (ctx.cluster) go(ctx, mapPath(ctx.cluster.id));
    },
  },
  {
    id: "node-topology",
    label: (ctx) => `Node topology of ${clusterName(ctx)}`,
    icon: LayoutGrid,
    path: (ctx) => clusterPath(ctx, topologyPath),
    available: connected,
    run: (ctx) => {
      if (ctx.cluster) go(ctx, topologyPath(ctx.cluster.id));
    },
  },
  overviewCommand(
    "workloads-overview",
    "workloads",
    "Workloads overview",
    OVERVIEW_ICONS.workloads,
  ),
  overviewCommand(
    "nodes-overview",
    "nodes",
    "Nodes overview",
    OVERVIEW_ICONS.nodes,
  ),
  overviewCommand(
    "namespaces-overview",
    "namespaces",
    "Namespaces overview",
    OVERVIEW_ICONS.namespaces,
  ),
  overviewCommand(
    "network-overview",
    "network",
    "Network overview",
    OVERVIEW_ICONS.network,
  ),
  overviewCommand(
    "storage-overview",
    "storage",
    "Storage overview",
    OVERVIEW_ICONS.storage,
  ),
  {
    id: "shortcuts",
    label: () => "Show keyboard shortcuts",
    icon: Keyboard,
    shortcut: "shortcuts",
    available: always,
    run: () => useShell.getState().open("shortcuts"),
  },
  {
    id: "agent-open",
    label: () => "Open the agent",
    icon: Sparkles,
    shortcut: "agent",
    available: () => agentsSupported(),
    run: (ctx) => useAgentChat.getState().openPanel(ctx.cluster?.id ?? null),
  },
  {
    id: "agent-new-chat",
    label: () => "New agent chat",
    icon: MessageSquarePlus,
    available: () => agentsSupported(),
    run: (ctx) => {
      const page = ctx.cluster?.id ?? null;
      const chat = useAgentChat.getState();
      // Opening an unused panel already starts a new chat.
      const fresh = chat.start.phase === "idle";
      chat.openPanel(page);
      if (!fresh) void chat.newChat(page);
    },
  },
  {
    id: "agent-ask",
    label: () =>
      `Ask the agent about this ${useAgentChat.getState().drawerObject?.kind ?? "object"}`,
    icon: Sparkles,
    available: () =>
      agentsSupported() && useAgentChat.getState().drawerObject !== null,
    run: () => {
      const object = useAgentChat.getState().drawerObject;
      if (object) void useAgentChat.getState().askAbout(object);
    },
  },
  {
    id: "about",
    label: () => "About SkoposIDE",
    icon: Info,
    available: always,
    run: () => useShell.getState().open("about"),
  },
  {
    id: "check-updates",
    label: () => "Check for Updates",
    icon: RefreshCw,
    available: always,
    run: () => void checkForUpdates(),
  },
  theme("theme-dark", "Theme: Dark", Moon, "dark"),
  theme("theme-light", "Theme: Light", Sun, "light"),
  theme("theme-system", "Theme: System", Monitor, "system"),
  {
    id: "toggle-sidebar",
    label: () =>
      useSidebarToggle.getState().collapsed
        ? "Expand the sidebar"
        : "Collapse the sidebar",
    icon: ChevronLeft,
    iconFor: () =>
      useSidebarToggle.getState().collapsed ? ChevronRight : ChevronLeft,
    shortcut: "toggleSidebar",
    available: () => useSidebarToggle.getState().toggle !== null,
    run: () => {
      toggleSidebar();
    },
  },
  {
    id: "back",
    label: () => "Go back",
    icon: ArrowLeft,
    shortcut: "back",
    available: always,
    run: (ctx) => ctx.navigate(-1),
  },
  {
    id: "forward",
    label: () => "Go forward",
    icon: ArrowRight,
    shortcut: "forward",
    available: always,
    run: (ctx) => ctx.navigate(1),
  },
  {
    id: "split-right",
    label: () => "Split right",
    icon: Columns2,
    shortcut: "splitRight",
    available: () =>
      shownTab() !== null &&
      useWindowLayout.getState().layout.panes.length < MAX_PANES,
    run: splitFocusedTab,
  },
  {
    id: "close-tab",
    label: () => "Close tab",
    icon: X,
    shortcut: "closeTab",
    available: () => shownTab()?.pinned === false,
    run: () => void closeFocusedTab(),
  },
  {
    id: "pin-tab",
    label: () => (shownTab()?.pinned ? "Unpin tab" : "Pin tab"),
    icon: Pin,
    available: () => shownTab() !== null,
    run: () => {
      const tab = shownTab();
      if (tab === null) return;
      useWindowLayout
        .getState()
        .dispatch({ type: tab.pinned ? "unpin" : "pin", tabId: tab.id });
    },
  },
  {
    id: "new-window",
    label: () => "Open in new window",
    icon: AppWindow,
    available: () => shownTab() !== null,
    run: () => {
      const tab = shownTab();
      // The core moves it and sends both windows their layouts (P31, P33).
      if (tab !== null) void openInNewWindow(tab.id);
    },
  },
];

export function commandById(id: CommandId): AppCommand {
  const command = COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`no command ${id}`);
  return command;
}

/** Runs a command when it is available in this context. */
export function runCommand(id: CommandId, ctx: CommandContext): void {
  const command = commandById(id);
  if (command.available(ctx)) command.run(ctx);
}

/**
 * The macOS menu's app items (spec C §9.2): `palette` opens the palette and
 * `check_updates` runs the check-updates command. Like the
 * shell keys, they do nothing while another modal dialog is open, so a menu item
 * cannot cover a Scale or Drain dialog or navigate away from what was typed in it.
 */
export function runMenuCommand(id: string, ctx: CommandContext): void {
  if (otherModalOpen()) return;
  if (id === "palette") useShell.getState().open("palette");
  else if (id === "about" || id === "preferences" || id === "shortcuts") {
    runCommand(id, ctx);
  } else if (id === "check_updates") runCommand("check-updates", ctx);
}

export function useCommandContext(): CommandContext {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const cluster = useCurrentCluster();
  return useMemo(
    () => ({
      navigate: (to: string | number) => {
        if (typeof to === "number") void navigate(to);
        else void navigate(to);
      },
      pathname,
      cluster,
    }),
    [navigate, pathname, cluster],
  );
}
