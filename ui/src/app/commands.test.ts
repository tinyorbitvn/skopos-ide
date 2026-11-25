import { waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import {
  Blocks,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  Namespace,
  Network,
  Server,
} from "../design/icons";
import { openTerminal } from "../features/dock/openTerminal";
import {
  resetUpdatesForTest,
  useUpdates,
} from "../features/updates/updateStore";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { ClusterInfo } from "../ipc/generated/ClusterInfo";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { resetAgentChatForTest, useAgentChat } from "../stores/agentChat";
import { resetPrefsForTest } from "../stores/prefs";
import { resetShellForTest, useShell } from "../stores/shell";
import {
  resetSidebarToggleForTest,
  useSidebarToggle,
} from "../stores/sidebarCollapse";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../stores/windowLayout";
import { mockBackend } from "../test/ipc";
import { updateState } from "../test/updates";
import {
  COMMANDS,
  type CommandContext,
  type CommandId,
  commandById,
  runCommand,
  runMenuCommand,
} from "./commands";

vi.mock("../features/dock/openTerminal", () => ({ openTerminal: vi.fn() }));

const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: ["default"],
  namespacesRestricted: false,
  isAdmin: true,
};
const CONNECTED: ConnectionState = { status: "connected", info: INFO };

function context(over: Partial<Omit<CommandContext, "navigate">> = {}) {
  const navigate = vi.fn<(to: string | number) => void>();
  return { navigate, pathname: "/catalog", cluster: null, ...over };
}

function on(state: ConnectionState) {
  return { id: "c1", name: "prod", state };
}

function served(plural: string, canList = true): ApiResourceInfo {
  return {
    resource: {
      group: "",
      version: "v1",
      plural,
      kind: plural,
      namespaced: true,
    },
    verbs: ["list", "watch"],
    shortNames: [],
    canList,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

/** Enough for every section with an Overview: Nodes, Namespaces, Workloads (Pods), Network, Storage (claims). */
const EVERY_OVERVIEW = [
  served("nodes"),
  served("namespaces"),
  served("pods"),
  served("persistentvolumeclaims"),
];

const OVERVIEWS: readonly CommandId[] = [
  "workloads-overview",
  "nodes-overview",
  "namespaces-overview",
  "network-overview",
  "storage-overview",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetShellForTest();
  resetUpdatesForTest();
  resetPrefsForTest();
  resetWindowLayoutForTest();
  resetSidebarToggleForTest();
  resetAgentChatForTest();
});

test("the registry lists the spec's commands in order", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  expect(COMMANDS.map((c) => [c.id, c.label(ctx), c.shortcut ?? null])).toEqual(
    [
      ["catalog", "Go to the catalog", null],
      ["preferences", "Open Preferences", "preferences"],
      ["add-cluster", "Add a cluster", null],
      ["install-chart", "Install a Helm chart", null],
      ["terminal", "Open a terminal in prod", "terminal"],
      ["disconnect", "Disconnect prod", null],
      ["cluster-settings", "Cluster settings for prod", null],
      ["resource-map", "Resource map of prod", null],
      ["node-topology", "Node topology of prod", null],
      ["workloads-overview", "Workloads overview of prod", null],
      ["nodes-overview", "Nodes overview of prod", null],
      ["namespaces-overview", "Namespaces overview of prod", null],
      ["network-overview", "Network overview of prod", null],
      ["storage-overview", "Storage overview of prod", null],
      ["shortcuts", "Show keyboard shortcuts", "shortcuts"],
      ["agent-open", "Open the agent", "agent"],
      ["agent-new-chat", "New agent chat", null],
      ["agent-ask", "Ask the agent about this object", null],
      ["about", "About SkoposIDE", null],
      ["check-updates", "Check for Updates", null],
      ["theme-dark", "Theme: Dark", null],
      ["theme-light", "Theme: Light", null],
      ["theme-system", "Theme: System", null],
      ["toggle-sidebar", "Collapse the sidebar", "toggleSidebar"],
      ["back", "Go back", "back"],
      ["forward", "Go forward", "forward"],
      ["split-right", "Split right", "splitRight"],
      ["close-tab", "Close tab", "closeTab"],
      ["pin-tab", "Pin tab", null],
      ["new-window", "Open in new window", null],
    ],
  );
});

test("terminal, disconnect, install-chart, resource-map and node-topology need the current cluster connected; cluster-settings any cluster", () => {
  const available = (ctx: CommandContext) =>
    COMMANDS.filter((c) => c.available(ctx)).map((c) => c.id);
  // toggle-sidebar needs a mounted sidebar, not a cluster, and the overview commands the
  // cluster's resources too; their own tests cover them. agent-ask needs the drawer.
  const all = COMMANDS.map((c) => c.id).filter(
    (id) =>
      id !== "toggle-sidebar" && id !== "agent-ask" && !OVERVIEWS.includes(id),
  );
  const onCluster = all.filter(
    (id) =>
      id !== "terminal" &&
      id !== "disconnect" &&
      id !== "install-chart" &&
      id !== "node-topology" &&
      id !== "resource-map",
  );
  const always = onCluster.filter((id) => id !== "cluster-settings");
  expect(available(context())).toEqual(always);
  expect(
    available(context({ cluster: on({ status: "disconnected" }) })),
  ).toEqual(onCluster);
  expect(available(context({ cluster: on({ status: "connecting" }) }))).toEqual(
    onCluster,
  );
  expect(available(context({ cluster: on(CONNECTED) }))).toEqual(all);
});

test("resource-map opens the cluster's map", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  runCommand("resource-map", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/cluster/c1/map"]]);
});

test("node-topology opens the cluster's node topology", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  runCommand("node-topology", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/cluster/c1/node-topology"]]);
});

test("an overview command shows while the cluster is connected and the sidebar shows its page", () => {
  const shown = (over: Partial<Omit<CommandContext, "navigate">>) =>
    COMMANDS.filter((c) => c.available(context(over)))
      .map((c) => c.id)
      .filter((id) => OVERVIEWS.includes(id));
  expect(shown({ cluster: on(CONNECTED), resources: EVERY_OVERVIEW })).toEqual([
    ...OVERVIEWS,
  ]);
  // Port Forwarding keeps Network in the sidebar; Nodes and Namespaces need their kind.
  expect(shown({ cluster: on(CONNECTED), resources: [] })).toEqual([
    "network-overview",
  ]);
  expect(
    shown({
      cluster: on(CONNECTED),
      resources: [served("nodes", false), served("namespaces", false)],
    }),
  ).toEqual(["network-overview"]);
  // Without the cluster's resources no page is known to show; off a connection none does.
  expect(shown({ cluster: on(CONNECTED) })).toEqual([]);
  expect(
    shown({ cluster: on({ status: "connecting" }), resources: EVERY_OVERVIEW }),
  ).toEqual([]);
  expect(shown({ resources: EVERY_OVERVIEW })).toEqual([]);
});

test("each overview command is named after its page and the cluster, with its tab's icon, and opens the page once", () => {
  const ctx = context({ cluster: on(CONNECTED), resources: EVERY_OVERVIEW });
  expect(
    OVERVIEWS.map((id) => [commandById(id).label(ctx), commandById(id).icon]),
  ).toEqual([
    ["Workloads overview of prod", Blocks],
    ["Nodes overview of prod", Server],
    ["Namespaces overview of prod", Namespace],
    ["Network overview of prod", Network],
    ["Storage overview of prod", HardDrive],
  ]);
  for (const id of OVERVIEWS) runCommand(id, ctx);
  expect(ctx.navigate.mock.calls).toEqual([
    ["/cluster/c1/workloads"],
    ["/cluster/c1/nodes"],
    ["/cluster/c1/namespaces"],
    ["/cluster/c1/network"],
    ["/cluster/c1/storage"],
  ]);
  const there = context({
    pathname: "/cluster/c1/nodes",
    cluster: on(CONNECTED),
    resources: EVERY_OVERVIEW,
  });
  runCommand("nodes-overview", there);
  expect(there.navigate).not.toHaveBeenCalled();
});

test("install-chart opens the cluster's Charts", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  runCommand("install-chart", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/cluster/c1/helm/charts"]]);
});

test("cluster-settings opens the cluster's Settings page, connected or not, once", () => {
  const off = context({
    pathname: "/cluster/a%2Fb",
    cluster: { id: "a/b", name: "staging", state: { status: "disconnected" } },
  });
  runCommand("cluster-settings", off);
  expect(off.navigate.mock.calls).toEqual([["/cluster/a%2Fb/settings"]]);

  const there = context({
    pathname: "/cluster/c1/settings",
    cluster: on(CONNECTED),
  });
  runCommand("cluster-settings", there);
  expect(there.navigate).not.toHaveBeenCalled();

  const nowhere = context();
  runCommand("cluster-settings", nowhere);
  expect(nowhere.navigate).not.toHaveBeenCalled();
});

test("catalog, back and forward navigate", () => {
  const ctx = context({ pathname: "/preferences" });
  runCommand("catalog", ctx);
  runCommand("back", ctx);
  runCommand("forward", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/catalog"], [-1], [1]]);
});

test("preferences closes a shell dialog and does not navigate where it is", () => {
  useShell.getState().open("palette");
  const ctx = context();
  runCommand("preferences", ctx);
  expect(useShell.getState().dialog).toBeNull();
  expect(ctx.navigate).toHaveBeenCalledWith("/preferences");

  const there = context({ pathname: "/preferences" });
  runCommand("preferences", there);
  expect(there.navigate).not.toHaveBeenCalled();
});

test("add a cluster goes to the catalog and opens the dialog", () => {
  const ctx = context({ pathname: "/cluster/c1" });
  runCommand("add-cluster", ctx);
  expect(ctx.navigate).toHaveBeenCalledWith("/catalog");
  expect(useShell.getState().addClusterOpen).toBe(true);
});

test("shortcuts and about open their dialogs", () => {
  runCommand("shortcuts", context());
  expect(useShell.getState().dialog).toBe("shortcuts");
  runCommand("about", context());
  expect(useShell.getState().dialog).toBe("about");
});

test("terminal opens the cluster's terminal, and only when it may", () => {
  runCommand("terminal", context({ cluster: on({ status: "disconnected" }) }));
  expect(openTerminal).not.toHaveBeenCalled();
  runCommand("terminal", context({ cluster: on(CONNECTED) }));
  expect(openTerminal).toHaveBeenCalledWith("c1");
});

test("disconnect calls the backend and toasts a failure", async () => {
  const ipc = mockBackend({
    cluster_disconnect: () => {
      throw { code: "Internal", message: "boom", details: null };
    },
  });
  const failed = vi.spyOn(toast, "error");
  runCommand("disconnect", context({ cluster: on(CONNECTED) }));
  await vi.waitFor(() =>
    expect(failed).toHaveBeenCalledWith("Could not disconnect", "boom"),
  );
  expect(ipc.callsTo("cluster_disconnect")).toEqual([{ id: "c1" }]);
});

test("a theme command saves the theme, loading the preferences first if needed", async () => {
  const ipc = mockBackend({
    prefs_get: () => ({ theme: "system", syncSources: [] }),
    prefs_set: () => null,
  });
  runCommand("theme-dark", context());
  await vi.waitFor(() =>
    expect(ipc.callsTo("prefs_set")).toEqual([
      { prefs: { theme: "dark", syncSources: [] } },
    ]),
  );
  expect(ipc.callsTo("prefs_get")).toHaveLength(1);
});

test("menu ids run their commands and others are ignored", () => {
  const ctx = context();
  runMenuCommand("palette", ctx);
  expect(useShell.getState().dialog).toBe("palette");
  runMenuCommand("shortcuts", ctx);
  expect(useShell.getState().dialog).toBe("shortcuts");
  runMenuCommand("about", ctx);
  expect(useShell.getState().dialog).toBe("about");
  runMenuCommand("preferences", ctx);
  expect(useShell.getState().dialog).toBeNull();
  runMenuCommand("quit", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/preferences"]]);
});

test("menu ids do nothing while another modal dialog is open", () => {
  const ctx = context();
  const scale = document.createElement("div");
  scale.setAttribute("role", "dialog");
  document.body.append(scale);
  try {
    for (const id of ["palette", "shortcuts", "about", "preferences"]) {
      runMenuCommand(id, ctx);
    }
    expect(useShell.getState().dialog).toBeNull();
    expect(ctx.navigate).not.toHaveBeenCalled();
  } finally {
    scale.remove();
  }
});

test("an open shell dialog does not stop menu ids", () => {
  const ctx = context();
  const palette = document.createElement("div");
  palette.setAttribute("role", "dialog");
  palette.setAttribute("data-shell-dialog", "");
  document.body.append(palette);
  try {
    runMenuCommand("about", ctx);
    expect(useShell.getState().dialog).toBe("about");
  } finally {
    palette.remove();
  }
});

function windowLayout() {
  return useWindowLayout.getState().layout;
}

test("the tab commands act on the focused tab, and show only when they apply (P17)", () => {
  const ctx = context();
  const pin = COMMANDS.find((c) => c.id === "pin-tab");
  const shown = () =>
    COMMANDS.filter((c) => c.available(ctx))
      .map((c) => c.id)
      .filter((id) => ["split-right", "close-tab", "pin-tab"].includes(id));
  expect(shown()).toEqual(["split-right", "close-tab", "pin-tab"]);

  runCommand("pin-tab", ctx);
  expect(windowLayout().panes[0].tabs[0].pinned).toBe(true);
  expect(pin?.label(ctx)).toBe("Unpin tab");
  // A pinned tab is not closed (P14).
  expect(shown()).toEqual(["split-right", "pin-tab"]);
  runCommand("pin-tab", ctx);
  expect(pin?.label(ctx)).toBe("Pin tab");

  runCommand("split-right", ctx);
  runCommand("split-right", ctx);
  expect(windowLayout().panes).toHaveLength(3);
  expect(shown()).toEqual(["close-tab", "pin-tab"]);
  runCommand("split-right", ctx);
  expect(windowLayout().panes).toHaveLength(3);

  runCommand("close-tab", ctx);
  expect(windowLayout().panes).toHaveLength(2);
});

test("in a window without tabs the tab commands do not show", () => {
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: "", tabs: [] }],
    focusedPane: 0,
  });
  const ids = COMMANDS.filter((c) => c.available(context())).map((c) => c.id);
  expect(ids).not.toContain("split-right");
  expect(ids).not.toContain("close-tab");
  expect(ids).not.toContain("pin-tab");
  expect(ids).not.toContain("new-window");
});

test("Open in new window sends the focused tab to a new window through the core (P17)", async () => {
  const backend = mockBackend({
    windows_list: () => [windowLayout()],
    window_tab_move: () => ({
      target: "window-2",
      created: true,
      sourceEmpty: false,
    }),
  });
  const ctx = context();
  const before = windowLayout();
  const tabId = before.panes[0].tabs[0].id;
  expect(commandById("new-window").available(ctx)).toBe(true);

  runCommand("new-window", ctx);

  // The window's bounds are not known yet: a step from its screen position.
  const scale = window.devicePixelRatio;
  const step = Math.round(32 * scale);
  await waitFor(() =>
    expect(backend.callsTo("window_tab_move")).toEqual([
      {
        tabId,
        target: {
          kind: "newWindow",
          x: Math.round(window.screenX * scale) + step,
          y: Math.round(window.screenY * scale) + step,
        },
      },
    ]),
  );
  // The core's layout event takes the tab out of this window.
  expect(windowLayout()).toBe(before);
});

test("the commands that open a location name it, so the click modes can open it (P11 to P13)", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  expect(
    COMMANDS.filter((c) => c.path !== undefined).map((c) => [
      c.id,
      c.path?.(ctx),
    ]),
  ).toEqual([
    ["catalog", "/catalog"],
    ["preferences", "/preferences"],
    ["install-chart", "/cluster/c1/helm/charts"],
    ["cluster-settings", "/cluster/c1/settings"],
    ["resource-map", "/cluster/c1/map"],
    ["node-topology", "/cluster/c1/node-topology"],
    ["workloads-overview", "/cluster/c1/workloads"],
    ["nodes-overview", "/cluster/c1/nodes"],
    ["namespaces-overview", "/cluster/c1/namespaces"],
    ["network-overview", "/cluster/c1/network"],
    ["storage-overview", "/cluster/c1/storage"],
  ]);
  expect(commandById("resource-map").path?.(context())).toBeNull();
  expect(commandById("storage-overview").path?.(context())).toBeNull();
  expect(
    commandById("storage-overview").path?.(
      context({ cluster: { id: "a/b", name: "x", state: CONNECTED } }),
    ),
  ).toBe("/cluster/a%2Fb/storage");
});

test("toggle-sidebar collapses or expands the mounted sidebar, named and drawn for its state", () => {
  const ctx = context();
  const command = commandById("toggle-sidebar");
  expect(command.available(ctx)).toBe(false);
  const toggle = vi.fn();
  useSidebarToggle.setState({ toggle, collapsed: false });
  expect([
    command.available(ctx),
    command.label(ctx),
    command.iconFor?.(),
  ]).toEqual([true, "Collapse the sidebar", ChevronLeft]);
  runCommand("toggle-sidebar", ctx);
  expect(toggle).toHaveBeenCalledTimes(1);
  useSidebarToggle.setState({ toggle, collapsed: true });
  expect([command.label(ctx), command.iconFor?.()]).toEqual([
    "Expand the sidebar",
    ChevronRight,
  ]);
});

test("Check for Updates opens the update dialog and checks", async () => {
  const ipc = mockBackend({
    update_check: () => updateState({ phase: { type: "upToDate" } }),
  });
  runCommand("check-updates", context());
  expect(useShell.getState().dialog).toBe("updates");
  await waitFor(() => expect(ipc.callsTo("update_check")).toHaveLength(1));
  await waitFor(() =>
    expect(useUpdates.getState().state?.phase).toEqual({ type: "upToDate" }),
  );
});

test("a Microsoft Store copy has no Check for Updates command", () => {
  useUpdates.setState({
    state: updateState({ phase: { type: "storeManaged" } }),
  });
  expect(commandById("check-updates").available(context())).toBe(false);
  useUpdates.setState({ state: updateState() });
  expect(commandById("check-updates").available(context())).toBe(true);
});

test("the macOS menu's check_updates runs the same command", async () => {
  const ipc = mockBackend({
    update_check: () => updateState({ phase: { type: "upToDate" } }),
  });
  runMenuCommand("check_updates", context());
  expect(useShell.getState().dialog).toBe("updates");
  await waitFor(() => expect(ipc.callsTo("update_check")).toHaveLength(1));
});

test("Ask the agent is offered only while the drawer shows an object", () => {
  const ask = commandById("agent-ask");
  const ctx = {
    navigate: () => {},
    pathname: "/cluster/a/pods",
    cluster: null,
  };
  expect(ask.available(ctx)).toBe(false);
  useAgentChat.getState().setDrawerObject({
    cluster: "a",
    kind: "Pod",
    namespace: "ns",
    name: "p",
  });
  expect(ask.available(ctx)).toBe(true);
  expect(ask.label(ctx)).toBe("Ask the agent about this Pod");
});
