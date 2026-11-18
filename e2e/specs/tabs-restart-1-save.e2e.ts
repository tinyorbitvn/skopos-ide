import fs from "node:fs";
import path from "node:path";
import { ctrlClick, doubleClick, expectShape, middleClick, tabIn } from "../helpers/tabs";
import { byTestId, clickWhenShown, openCluster, shown } from "../helpers/ui";

const KIND = "kind-skopos-e2e";

interface SavedTab {
  pinned: boolean;
  history: string[];
  index: number;
}

interface SavedPane {
  width: number;
  tabs: SavedTab[];
}

/** The main window's layout as the core saved it in this spec's config dir, or null. */
function savedMain(): { panes: SavedPane[]; focusedPane: number } | null {
  const file = path.join(process.env.SKOPOS_CONFIG_DIR ?? "", "config", "windows.json");
  try {
    const windows = JSON.parse(fs.readFileSync(file, "utf8")).data?.windows ?? [];
    return windows.find((w: { label: string }) => w.label === "main") ?? null;
  } catch {
    return null;
  }
}

/** The location a saved tab shows. */
const shownPath = (tab: SavedTab) => tab.history[tab.index] ?? "";

// tabs-restart-2-verify.e2e.ts reads this layout back in a new app process (spec P38, P47).
describe("panes, tabs and pins across a restart: before", () => {
  it("saves two panes, a pinned tab with its history, and the pane widths", async () => {
    await openCluster(KIND);
    await clickWhenShown("nav-item-core-pods");
    await expectShape("*Pods");
    await ctrlClick(await shown("nav-item-core-namespaces"));
    await doubleClick(await tabIn(0, "Pods"));
    await expectShape("*Pods^,Namespaces");
    await middleClick(await shown("nav-item-core-nodes"));
    await expectShape("*Pods^,Namespaces | >*Nodes");

    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid="pane-resize-0"]')?.focus(),
    );
    await browser.keys("ArrowLeft");
    await browser.keys("ArrowLeft");
    await browser.waitUntil(
      async () => (await byTestId("pane-resize-0").getAttribute("aria-valuenow")) === "46",
      { timeout: 15000, timeoutMsg: "the splitter never moved to 46%" },
    );

    // Saved 300 ms after the last change.
    await browser.waitUntil(
      async () => {
        const main = savedMain();
        if (main === null || main.panes.length !== 2) return false;
        const [left, right] = main.panes;
        return (
          main.focusedPane === 1 &&
          Math.abs(left.width - 0.46) < 0.001 &&
          left.tabs.map((t) => t.pinned).join() === "true,false" &&
          // The first tab started on the Catalog, then showed the Overview.
          left.tabs[0].history.length === 3 &&
          shownPath(left.tabs[0]).endsWith("/r/core/pods") &&
          shownPath(left.tabs[1]).endsWith("/r/core/namespaces") &&
          right.tabs.length === 1 &&
          shownPath(right.tabs[0]).endsWith("/r/core/nodes")
        );
      },
      { timeout: 15000, interval: 250, timeoutMsg: "the layout was never saved" },
    );
  });
});
