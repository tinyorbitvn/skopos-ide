import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import {
  resetUpdatesForTest,
  useUpdates,
} from "../features/updates/updateStore";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import { resetCatalogForTest, useCatalog } from "../stores/catalog";
import { resetShellForTest, useShell } from "../stores/shell";
import { resetTunnelsForTest, useTunnels } from "../stores/tunnels";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../stores/windowLayout";
import { clusterEntry, flush, mockBackend } from "../test/ipc";
import { tunnel } from "../test/tunnels";
import { updateState } from "../test/updates";
import { Hotbar } from "./Hotbar";
import { tabPath } from "./tabs/layout";
import { ShellRouter } from "./tabs/ShellRouter";

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

const alpha = clusterEntry({ id: "a", contextName: "prod-eu-west" });
const beta = clusterEntry({
  id: "b",
  contextName: "kind-e2e",
  state: { status: "connecting" },
});

async function show(
  clusters: ClusterEntry[],
  hotbar: string[],
  more: Parameters<typeof mockBackend>[0] = {},
) {
  const ipc = mockBackend({
    catalog_list: () => clusters,
    catalog_warnings: () => [],
    hotbar_get: () => hotbar,
    hotbar_set: () => null,
    update_check: () => updateState({ phase: { type: "upToDate" } }),
    ...more,
  });
  await useCatalog.getState().init();
  render(
    <ShellRouter>
      <Hotbar />
      <Where />
    </ShellRouter>,
  );
  return ipc;
}

function shownOrder(): (string | null)[] {
  return within(screen.getByTestId("hotbar"))
    .getAllByRole("button")
    .map((el) => el.getAttribute("data-testid"))
    .filter((id) => id?.startsWith("hotbar-item-")) as string[];
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
  resetUpdatesForTest();
  resetTunnelsForTest();
  // One Catalog tab, focused.
  resetWindowLayoutForTest();
});

function shownPaths(): string[] {
  return useWindowLayout.getState().layout.panes[0].tabs.map(tabPath);
}
afterEach(() => {
  vi.restoreAllMocks();
});

test("renders pinned clusters with initials and status dot", async () => {
  await show([alpha, beta], ["b", "a"]);

  expect(shownOrder()).toEqual(["hotbar-item-b", "hotbar-item-a"]);
  const first = within(screen.getByTestId("hotbar-item-a"));
  expect(first.getByText("PE")).toBeTruthy();
  expect(first.getByRole("img", { name: "Disconnected" })).toBeTruthy();
  expect(
    within(screen.getByTestId("hotbar-item-b")).getByRole("img", {
      name: "Connecting",
    }),
  ).toBeTruthy();
});

test("shows the user's icon when the cluster has one", async () => {
  const withIcon = clusterEntry({
    id: "i",
    icon: "data:image/png;base64,AAAA",
  });
  await show([withIcon], ["i"]);

  const item = within(screen.getByTestId("hotbar-item-i"));
  expect(item.getByRole("presentation").getAttribute("src")).toBe(
    "data:image/png;base64,AAAA",
  );
});

test("rail links keep their class and mark the current page", async () => {
  await show([], []);

  const catalog = screen.getByTestId("nav-catalog");
  expect(catalog.classList.contains("link")).toBe(true);
  expect(catalog.getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByTestId("nav-preferences").getAttribute("aria-current"),
  ).toBeNull();
});

test("click navigates the focused tab to the cluster, and its tile is then active (P2)", async () => {
  await show([alpha, beta], ["a", "b"]);
  expect(
    screen.getByTestId("hotbar-item-a").getAttribute("aria-current"),
  ).toBeNull();

  fireEvent.click(screen.getByTestId("hotbar-item-a"));

  expect(screen.getByTestId("where").textContent).toBe("/cluster/a");
  expect(shownPaths()).toEqual(["/cluster/a"]);
  expect(screen.getByTestId("hotbar-item-a").getAttribute("aria-current")).toBe(
    "page",
  );
  expect(
    screen.getByTestId("hotbar-item-b").getAttribute("aria-current"),
  ).toBeNull();
  expect(
    screen.getByTestId("nav-catalog").getAttribute("aria-current"),
  ).toBeNull();
});

test("Ctrl+click on a tile or a rail link opens a new tab; middle-click opens beside (P2, P12)", async () => {
  await show([alpha], ["a"]);

  fireEvent.click(screen.getByTestId("hotbar-item-a"), { ctrlKey: true });
  expect(shownPaths()).toEqual(["/catalog", "/cluster/a"]);
  fireEvent.click(screen.getByTestId("nav-preferences"), { ctrlKey: true });
  expect(shownPaths()).toEqual(["/catalog", "/cluster/a", "/preferences"]);
  fireEvent(
    screen.getByTestId("hotbar-item-a"),
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  const panes = useWindowLayout.getState().layout.panes;
  expect(panes).toHaveLength(2);
  expect(panes[1].tabs.map(tabPath)).toEqual(["/cluster/a"]);
});

test("the rail has no Workspace link, and a Shift-click on a tile opens the cluster", async () => {
  await show([alpha], ["a"]);

  expect(screen.queryByTestId("nav-workspace")).toBeNull();
  fireEvent.click(screen.getByTestId("hotbar-item-a"), { shiftKey: true });

  expect(screen.getByTestId("where").textContent).toBe("/cluster/a");
});

test("unknown ids are not rendered", async () => {
  await show([alpha], ["ghost", "a"]);

  expect(shownOrder()).toEqual(["hotbar-item-a"]);
});

test("explains itself when nothing is pinned", async () => {
  await show([alpha], []);

  expect(
    screen.getByRole("img", { name: /Pin clusters from the catalog/ }),
  ).toBeTruthy();
});

test("keyboard reorder calls reorderHotbar", async () => {
  // jsdom has no layout, so give each item the place it would have on screen.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const items = shownOrder();
      const index = items.indexOf(this.getAttribute("data-testid"));
      const holder = items.findIndex(
        (id) => id && this.querySelector(`[data-testid="${id}"]`),
      );
      const at = index >= 0 ? index : Math.max(holder, 0);
      return new DOMRect(0, at * 48, 40, 40);
    },
  );
  const ipc = await show([alpha, beta], ["a", "b"]);
  const item = screen.getByTestId("hotbar-item-a");
  item.focus();

  fireEvent.keyDown(item, { code: "Space", key: " " });
  await act(flush);
  fireEvent.keyDown(document, { code: "ArrowDown", key: "ArrowDown" });
  await act(flush);
  fireEvent.keyDown(document, { code: "Space", key: " " });
  await act(flush);

  await waitFor(() =>
    expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: ["b", "a"] }]),
  );
  expect(useCatalog.getState().hotbar).toEqual(["b", "a"]);
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("unpin from the context menu", async () => {
  const ipc = await show([alpha, beta], ["a", "b"]);

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-a"));
  fireEvent.click(await screen.findByTestId("menu-item-unpin"));

  await waitFor(() =>
    expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: ["b"] }]),
  );
  await waitFor(() => expect(shownOrder()).toEqual(["hotbar-item-b"]));
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("the context menu opens the cluster's settings in the focused tab", async () => {
  await show([alpha, beta], ["a", "b"]);

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-a"));
  fireEvent.click(await screen.findByTestId("menu-item-settings"));

  expect(screen.getByTestId("where").textContent).toBe("/cluster/a/settings");
  expect(shownPaths()).toEqual(["/cluster/a/settings"]);
});

test("Agent settings opens the cluster's Settings at the Agent card", async () => {
  await show([alpha], ["a"]);

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-a"));
  fireEvent.click(await screen.findByTestId("menu-item-agent-settings"));

  expect(screen.getByTestId("where").textContent).toBe("/cluster/a/settings");
  expect(shownPaths()).toEqual(["/cluster/a/settings?card=agent"]);
});

test("the context menu disconnects a connected or connecting cluster", async () => {
  const ipc = await show([alpha, beta], ["a", "b"], {
    cluster_disconnect: () => null,
  });

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-b"));
  expect(screen.queryByTestId("menu-item-connect")).toBeNull();
  fireEvent.click(await screen.findByTestId("menu-item-disconnect"));

  await waitFor(() =>
    expect(ipc.callsTo("cluster_disconnect")).toEqual([{ id: "b" }]),
  );
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("the context menu connects a disconnected cluster", async () => {
  const ipc = await show([alpha, beta], ["a", "b"], {
    cluster_connect: () => ({ status: "connecting" }),
  });

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-a"));
  expect(screen.queryByTestId("menu-item-disconnect")).toBeNull();
  fireEvent.click(await screen.findByTestId("menu-item-connect"));

  await waitFor(() =>
    expect(ipc.callsTo("cluster_connect")).toEqual([{ id: "a" }]),
  );
});

test("Connect is disabled, with the reason, for a kubeconfig with a problem", async () => {
  const broken = clusterEntry({
    id: "x",
    contextName: "broken",
    problem: "The kubeconfig names no server for this context",
  });
  const ipc = await show([broken], ["x"], {
    cluster_connect: () => ({ status: "connecting" }),
  });

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-x"));
  const connect = await screen.findByTestId("menu-item-connect");
  expect(connect.getAttribute("data-disabled")).not.toBeNull();
  expect(connect.getAttribute("title")).toBe(
    "The kubeconfig names no server for this context",
  );
  fireEvent.click(connect);
  await act(flush);
  expect(ipc.callsTo("cluster_connect")).toEqual([]);
});

test("a failed disconnect shows the backend's message", async () => {
  const error = vi.spyOn(toast, "error");
  await show([alpha, beta], ["a", "b"], {
    cluster_disconnect: () => {
      throw new Error("the cluster is busy");
    },
  });

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-b"));
  fireEvent.click(await screen.findByTestId("menu-item-disconnect"));

  await waitFor(() =>
    expect(error).toHaveBeenCalledWith(
      "Could not disconnect",
      expect.stringContaining("the cluster is busy"),
    ),
  );
});

test("a long non-ASCII name stays on one line in the tooltip, in full", async () => {
  const name = "クラスター".repeat(60);
  await show([clusterEntry({ id: "l", contextName: "long", name })], ["l"]);
  const item = screen.getByTestId("hotbar-item-l");

  expect(item.getAttribute("aria-label")).toBe(name);
  fireEvent.focus(item);

  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe(name);
  const label = document.querySelector(`span[title="${name}"]`);
  expect(label).not.toBeNull();
  const style = getComputedStyle(label as Element);
  expect(style.textOverflow).toBe("ellipsis");
  expect(style.whiteSpace).toBe("nowrap");
});

test("the Help menu sits directly above Preferences and lists four items", async () => {
  await show([alpha], []);

  const help = screen.getByTestId("hotbar-help");
  expect(help.getAttribute("aria-label")).toBe("Help");
  expect(help.nextElementSibling?.getAttribute("data-testid")).toBe(
    "nav-preferences",
  );
  fireEvent.keyDown(help, { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  expect(
    items.map((item) => [item.getAttribute("data-testid"), item.textContent]),
  ).toEqual([
    ["help-palette", "Command palette"],
    ["help-shortcuts", "Keyboard shortcuts"],
    ["help-about", "About SkoposIDE"],
    ["help-check-updates", "Check for Updates…"],
  ]);
});

test("the Help menu's items open the three shell dialogs", async () => {
  await show([alpha], []);

  const opened: (string | null)[] = [];
  for (const item of ["help-palette", "help-shortcuts", "help-about"]) {
    fireEvent.keyDown(screen.getByTestId("hotbar-help"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId(item));
    opened.push(useShell.getState().dialog);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
  expect(opened).toEqual(["palette", "shortcuts", "about"]);
});

test("the Help menu's Check for Updates opens the update dialog and checks", async () => {
  const ipc = await show([alpha], []);
  fireEvent.keyDown(screen.getByTestId("hotbar-help"), { key: "Enter" });
  fireEvent.click(await screen.findByTestId("help-check-updates"));
  expect(useShell.getState().dialog).toBe("updates");
  await waitFor(() => expect(ipc.callsTo("update_check")).toHaveLength(1));
});

test("a Microsoft Store copy's Help menu has no Check for Updates", async () => {
  await show([alpha], []);
  act(() =>
    useUpdates.setState({
      state: updateState({ phase: { type: "storeManaged" } }),
    }),
  );
  fireEvent.keyDown(screen.getByTestId("hotbar-help"), { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.getAttribute("data-testid"))).toEqual([
    "help-palette",
    "help-shortcuts",
    "help-about",
  ]);
});

test("a pinned cluster whose tunnel failed shows a danger dot named Tunnel failed", async () => {
  useTunnels.setState({
    tunnels: [tunnel({ state: { status: "failed", message: "refused" } })],
  });
  const connected = clusterEntry({
    id: "c",
    contextName: "gamma",
    tunnel: "t1",
    state: {
      status: "connected",
      info: {
        version: "v1.31.0",
        distribution: "kind",
        nodeCount: 1,
        namespaces: [],
        namespacesRestricted: false,
        isAdmin: true,
      },
    },
  });
  await show([connected], ["c"]);
  expect(
    within(screen.getByTestId("hotbar-item-c")).getByRole("img", {
      name: "Tunnel failed",
    }),
  ).toBeTruthy();
});
