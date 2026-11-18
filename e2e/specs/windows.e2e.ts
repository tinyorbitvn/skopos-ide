import {
  ctrlClick,
  expectPaneTitle,
  expectShape,
  openTabMenu,
  tabIn,
  tabTestId,
} from "../helpers/tabs";
import { clickWhenShown, gone, openCluster, shown } from "../helpers/ui";
import {
  expectWindowCount,
  invoke,
  invokeAndForget,
  switchToLabel,
  windowLabels,
} from "../helpers/windows";

const KIND = "kind-skopos-e2e";

interface Layout {
  label: string;
  panes: { tabs: { id: string; history: string[]; index: number }[] }[];
}

/** The part of a location after its cluster, such as `/r/core/pods`. */
function screenPath(path: string): string {
  return path.replace(/^\/cluster\/[^/]+/, "") || "/";
}

/** Every window the core lists, as "label: screen, screen | screen" (main first). */
async function windowList(): Promise<string[]> {
  const layouts = await invoke<Layout[]>("windows_list");
  return layouts.map(
    (layout) =>
      `${layout.label}: ${layout.panes
        .map((pane) => pane.tabs.map((t) => screenPath(t.history[t.index] ?? "")).join(", "))
        .join(" | ")}`,
  );
}

async function tabOf(label: string, id: string): Promise<Layout["panes"][number]["tabs"][number]> {
  const layouts = await invoke<Layout[]>("windows_list");
  const tab = layouts
    .find((layout) => layout.label === label)
    ?.panes.flatMap((pane) => pane.tabs)
    .find((t) => t.id === id);
  if (!tab) throw new Error(`window ${label} has no tab ${id}`);
  return tab;
}

/** Opens a tab's "Move to window ▸" submenu and waits for `item` in it. */
async function windowMenu(pane: number, screen: string, item: string): Promise<WebdriverIO.Element> {
  await openTabMenu(await tabIn(pane, screen));
  await clickWhenShown("tab-menu-window");
  // The other windows are read from the core when the menu opens.
  return shown(`tab-menu-window-${item}`);
}

async function closeMenus(): Promise<void> {
  // The submenu and the menu are each a `menu`; Esc closes one at a time.
  for (let i = 0; i < 3 && (await browser.$$('[role="menu"]').length) > 0; i++) {
    await browser.keys("Escape");
    await browser.pause(200);
  }
  await gone("tab-menu-pin");
}

// Spec P47: a tab in a window of its own, through the tab menu, checked in the core's
// window list, then back to the main window.
describe("windows", () => {
  let podsTab = "";

  before(async () => {
    await openCluster(KIND);
    await clickWhenShown("nav-item-core-pods");
    await ctrlClick(await shown("nav-item-core-nodes"));
    await expectShape("Pods,*Nodes");
    podsTab = (await tabTestId(0, "Pods")).replace(/^tab-/, "");
  });

  it("opens a tab in a new window from Move to window", async () => {
    await (await windowMenu(0, "Pods", "new")).click();

    await expectWindowCount(2);
    await expectShape("*Nodes");
    expect(await windowLabels()).toEqual(["main", "window-2"]);
    expect(await windowList()).toEqual(["main: /r/core/nodes", "window-2: /r/core/pods"]);
    // The tab keeps its id and its history.
    expect((await tabOf("window-2", podsTab)).history.map(screenPath)).toEqual([
      "/catalog",
      "/",
      "/r/core/pods",
    ]);
  });

  it("lists the other window by name and its tab's title in Move to window", async () => {
    const item = await windowMenu(0, "Nodes", "window-2");

    const text = await item.getText();
    expect(text).toContain("Window 2");
    expect(text).toContain(`Pods · ${KIND}`);
    await closeMenus();
  });

  it("shows the moved tab with its cluster in the second window", async () => {
    await switchToLabel("window-2");

    await expectShape("*Pods", 30000);
    await expectPaneTitle(0, "Pod");
    await shown("cluster-sidebar");
  });

  it("moves the tab back to the main window, which closes the emptied window", async () => {
    // The app closes the window as its last tab leaves, so nothing here waits on it.
    await (await windowMenu(0, "Pods", "main")).click();

    await expectWindowCount(1);
    await switchToLabel("main");
    expect(await windowLabels()).toEqual(["main"]);
    await expectShape("Nodes,*Pods");
    expect((await tabOf("main", podsTab)).history).toHaveLength(3);
  });

  it("opens the focused tab in a new window from the palette, and closing that window closes the tab", async () => {
    await browser.keys(["Control", "Shift", "p"]);
    await (await shown("palette-input")).setValue("new window");
    await clickWhenShown("palette-command-new-window");

    await expectWindowCount(2);
    await expectShape("*Nodes");
    expect(await windowList()).toEqual(["main: /r/core/nodes", "window-2: /r/core/pods"]);

    await switchToLabel("window-2");
    await shown("cluster-sidebar", 30000);
    await browser.closeWindow();

    await expectWindowCount(1);
    await switchToLabel("main");
    expect(await windowList()).toEqual(["main: /r/core/nodes"]);
    await expectShape("*Nodes");
  });

  // The driver's pointer cannot leave the page, so a tab let go outside the window
  // (P31) is sent as the page sends it: the drop command with the release's screen
  // point. Under Xvfb the main window sits at the screen's top left, 1360 × 860.
  it("drops a tab outside every window into a new window, and onto the main window back", async () => {
    await ctrlClick(await shown("nav-item-core-pods"));
    await expectShape("Nodes,*Pods");
    const pods = (await tabTestId(0, "Pods")).replace(/^tab-/, "");
    // The page saves its layout 300 ms after a change; the drop needs the tab saved.
    await browser.waitUntil(
      async () => (await windowList()).join() === "main: /r/core/nodes, /r/core/pods",
      { timeout: 15000, timeoutMsg: "the new tab was never saved" },
    );

    expect(
      await invoke("window_tab_drop", { tabId: pods, screenX: 1500, screenY: 950 }),
    ).toEqual({ target: "window-2", created: true, sourceEmpty: false });

    await expectWindowCount(2);
    await expectShape("*Nodes");
    expect(await windowList()).toEqual(["main: /r/core/nodes", "window-2: /r/core/pods"]);

    await switchToLabel("window-2");
    await shown("cluster-sidebar", 30000);
    // Its only tab leaves, so the app closes the window before the command can answer.
    await invokeAndForget("window_tab_drop", { tabId: pods, screenX: 100, screenY: 100 });

    await expectWindowCount(1);
    await switchToLabel("main");
    expect(await windowList()).toEqual(["main: /r/core/nodes, /r/core/pods"]);
    await expectShape("Nodes,*Pods");
  });
});
