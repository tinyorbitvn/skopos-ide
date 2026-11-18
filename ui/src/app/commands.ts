import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Columns2,
  type IconComponent,
  Info,
  Keyboard,
  LayoutGrid,
  Monitor,
  Moon,
  Network,
  Package,
  Pin,
  Plus,
  Power,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  Sun,
  X,
} from "../design/icons";
import { openTerminal } from "../features/dock/openTerminal";
import { chartsPath } from "../features/helm/helmText";
import { mapPath } from "../features/map/paths";
import { settingsPath } from "../features/settings/paths";
import type { Theme } from "../ipc/generated/Theme";
import { disconnectCluster } from "../stores/clusters";
import { usePrefs } from "../stores/prefs";
import { useShell } from "../stores/shell";
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
  | "shortcuts"
  | "about"
  | "theme-dark"
  | "theme-light"
  | "theme-system"
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
    id: "shortcuts",
    label: () => "Show keyboard shortcuts",
    icon: Keyboard,
    shortcut: "shortcuts",
    available: always,
    run: () => useShell.getState().open("shortcuts"),
  },
  {
    id: "about",
    label: () => "About SkoposIDE",
    icon: Info,
    available: always,
    run: () => useShell.getState().open("about"),
  },
  theme("theme-dark", "Theme: Dark", Moon, "dark"),
  theme("theme-light", "Theme: Light", Sun, "light"),
  theme("theme-system", "Theme: System", Monitor, "system"),
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
 * The macOS menu's app items (spec C §9.2): `palette` opens the palette. Like the
 * shell keys, they do nothing while another modal dialog is open, so a menu item
 * cannot cover a Scale or Drain dialog or navigate away from what was typed in it.
 */
export function runMenuCommand(id: string, ctx: CommandContext): void {
  if (otherModalOpen()) return;
  if (id === "palette") useShell.getState().open("palette");
  else if (id === "about" || id === "preferences" || id === "shortcuts") {
    runCommand(id, ctx);
  }
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
