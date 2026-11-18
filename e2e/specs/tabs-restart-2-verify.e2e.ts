import { expectPaneTitle, expectShape, tabIn, tabTestId } from "../helpers/tabs";
import { byTestId, clickWhenShown } from "../helpers/ui";

// Shares its temp HOME and config dir with tabs-restart-1-save.e2e.ts, and each spec
// file runs in its own app process.
describe("panes, tabs and pins across a restart: after", () => {
  it("restores the panes, their tabs and pins, the widths and the focused pane", async () => {
    await expectShape("*Pods^,Namespaces | >*Nodes", 30000);
    expect(await byTestId("pane-resize-0").getAttribute("aria-valuenow")).toBe("46");
    const pinned = await tabTestId(0, "Pods");
    expect(await byTestId(pinned.replace(/^tab-/, "tab-close-")).isExisting()).toBe(false);
  });

  it("connects the cluster and shows each pane's selected tab", async () => {
    await expectPaneTitle(0, "Pod");
    await expectPaneTitle(1, "Node");
  });

  it("keeps a restored tab's history", async () => {
    await (await tabIn(0, "Pods")).click();
    await expectShape(">*Pods^,Namespaces | *Nodes");

    await clickWhenShown("header-back");

    await expectShape(">*Overview^,Namespaces | *Nodes");
  });
});
