import {
  ctrlClick,
  doubleClick,
  dragTo,
  expectPaneTitle,
  expectShape,
  layoutCount,
  menuItemState,
  middleClick,
  openTabMenu,
  paneHalf,
  tabIn,
  tabMenu,
  tabTestId,
} from "../helpers/tabs";
import {
  byTestId,
  catalogRow,
  clickNav,
  clickWhenShown,
  expectConnected,
  gone,
  navItem,
  pointerClick,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";

async function closeButton(pane: number, screen: string): Promise<string> {
  return (await tabTestId(pane, screen)).replace(/^tab-/, "tab-close-");
}

// Spec P47: tabs and panes. Each step starts from the layout the step before left.
describe("tabs and panes", () => {
  it("starts on one Catalog tab, and a double-click on it pins it", async () => {
    await shown(`catalog-row-${KIND}`, 30000);
    await expectShape("*Catalog");

    await doubleClick(await tabIn(0, "Catalog"));

    await expectShape("*Catalog^");
    expect(await byTestId(await closeButton(0, "Catalog")).isExisting()).toBe(false);
    expect(await layoutCount()).toBe("1 pane · 1 tab");
  });

  it("opens a cluster linked from the pinned tab in a new tab after it", async () => {
    await (await catalogRow(KIND)).$(`a=${KIND}`).then((link) => link.click());

    await expectShape("Catalog^,*Overview");
    await expectConnected();
    await shown("cluster-sidebar");
  });

  it("navigates the focused tab with a plain click, and goes back through its history", async () => {
    await clickNav("nav-item-core-pods");

    await expectShape("Catalog^,*Pods");
    await expectPaneTitle(0, "Pod");

    await clickWhenShown("header-back");
    await expectShape("Catalog^,*Overview");
    await clickWhenShown("header-forward");
    await expectShape("Catalog^,*Pods");
  });

  it("opens a new tab at the end of the pane with Ctrl+click", async () => {
    await ctrlClick(await navItem("nav-item-core-namespaces"));

    await expectShape("Catalog^,Pods,*Namespaces");
    await expectPaneTitle(0, "Namespace");
  });

  it("opens a plain click on a pinned tab in a new tab right after the pinned ones", async () => {
    await (await tabIn(0, "Catalog")).click();
    await expectShape("*Catalog^,Pods,Namespaces");

    await clickNav("nav-item-core-configmaps");

    await expectShape("Catalog^,*ConfigMaps,Pods,Namespaces");
  });

  it("opens a middle-click beside, in a new pane on the right", async () => {
    await middleClick(await navItem("nav-item-core-nodes"));

    await expectShape("Catalog^,*ConfigMaps,Pods,Namespaces | >*Nodes");
    await expectPaneTitle(1, "Node");
  });

  it("copies the focused tab into a third pane with Ctrl+\\, and allows no fourth", async () => {
    await browser.keys(["Control", "\\"]);

    await expectShape("Catalog^,*ConfigMaps,Pods,Namespaces | *Nodes | >*Nodes");
    for (const pane of [0, 1, 2]) {
      expect(await byTestId(`pane-split-${pane}`).isEnabled()).toBe(false);
    }
    expect(await layoutCount()).toBe("3 panes · 6 tabs");
  });

  it("closes a pane with its last tab", async () => {
    await clickWhenShown(await closeButton(2, "Nodes"));

    await expectShape("Catalog^,*ConfigMaps,Pods,Namespaces | >*Nodes");
  });

  it("copies a pane's tab into a new pane on its right with the split button", async () => {
    // A press focuses the pane before the click, as a person's does.
    await pointerClick(await shown("pane-split-0"));

    await expectShape("Catalog^,*ConfigMaps,Pods,Namespaces | >*ConfigMaps | *Nodes");
    await expectPaneTitle(1, "ConfigMap");

    await clickWhenShown(await closeButton(1, "ConfigMaps"));
    await expectShape("Catalog^,*ConfigMaps,Pods,Namespaces | >*Nodes");
  });

  it("drags a tab onto the right half of another pane into a new pane there", async () => {
    await dragTo(await tabIn(0, "Pods"), await paneHalf(1, "right"));

    await expectShape("Catalog^,*ConfigMaps,Namespaces | *Nodes | >*Pods");
    await gone("tab-drag-label");
  });

  it("moves a tab to the left pane from its menu", async () => {
    await tabMenu(await tabIn(2, "Pods"), "left");

    await expectShape("Catalog^,*ConfigMaps,Namespaces | >Nodes,*Pods");
  });

  it("says in the menu why an item cannot apply", async () => {
    await openTabMenu(await tabIn(0, "Catalog"));

    expect(await (await shown("tab-menu-pin")).getText()).toContain("Unpin tab");
    expect(await menuItemState("tab-menu-left")).toEqual({
      disabled: true,
      reason: "No pane on the left",
    });
    expect(await menuItemState("tab-menu-close")).toEqual({
      disabled: true,
      reason: "Pinned tabs cannot be closed",
    });
    await browser.keys("Escape");
    await gone("tab-menu-pin");
  });

  it("keeps the pinned tab on Close other tabs", async () => {
    await tabMenu(await tabIn(0, "ConfigMaps"), "close-others");

    await expectShape(">Catalog^,*ConfigMaps | Nodes,*Pods");
  });

  it("closes tabs by middle-click and Ctrl+W, and unpins by double-click", async () => {
    // The press focuses the pane it lands in (P19).
    await middleClick(await tabIn(1, "Pods"));
    await expectShape("Catalog^,*ConfigMaps | >*Nodes");

    await (await tabIn(1, "Nodes")).click();
    await browser.keys(["Control", "w"]);
    await expectShape("Catalog^,*ConfigMaps");

    await doubleClick(await tabIn(0, "Catalog"));
    await expectShape("*Catalog,ConfigMaps");
  });

  it("shows the empty state when the last tab closes, and opens the Catalog from it", async () => {
    await clickWhenShown(await closeButton(0, "ConfigMaps"));
    await clickWhenShown(await closeButton(0, "Catalog"));

    const empty = await shown("pane-empty");
    expect(await empty.getText()).toContain("No tabs open");
    expect(await layoutCount()).toBe("1 pane · 0 tabs");

    await clickWhenShown("pane-empty-catalog");

    await expectShape("*Catalog");
    await shown(`catalog-row-${KIND}`);
  });
});
