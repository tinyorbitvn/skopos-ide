import {
  catalogRow,
  clickWhenShown,
  expectConnected,
  expectTerminalLine,
  expectTerminalStatus,
  openResource,
  rowId,
  shown,
  typeInTerminal,
} from "../../helpers/ui";
import {
  expectWindowCount,
  invoke,
  invokeAndForget,
  type LayoutSummary,
  switchToLabel,
  tabIds,
  windowLabels,
} from "../../helpers/windows";

// Runs without Docker: the only cluster is a fakekube context.
describe("smoke", () => {
  it("launches, lists the fake context and connects", async () => {
    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake", 30000);
    await (await catalogRow("fake")).$("a=fake").then((link) => link.click());
    await expectConnected();
  });

  it("opens Pods and shows the fake pod", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await shown(rowId("default", "fake-pod"));
  });

  it("opens the local terminal and echoes", async () => {
    await clickWhenShown("dock-terminal");
    await expectTerminalStatus("Local shell");
    await typeInTerminal("echo skopos-smoke-ok");
    await expectTerminalLine("skopos-smoke-ok");
  });

  // Spec P48: a second window opens with the whole UI and closes again, on every platform.
  it("opens a second window and closes it", async () => {
    const main = await invoke<LayoutSummary>("window_layout_get");
    const [tab] = tabIds(main);

    const opened = await invoke("window_tab_move", {
      tabId: tab,
      target: { kind: "newWindow", x: 120, y: 80 },
    });

    expect(opened).toEqual({
      target: "window-2",
      created: true,
      sourceEmpty: true,
    });
    await switchToLabel("window-2");
    await shown("nav-catalog", 30000);
    expect(await windowLabels()).toEqual(["main", "window-2"]);
    const second = await invoke<LayoutSummary>("window_layout_get");
    expect(second.label).toBe("window-2");
    expect(tabIds(second)).toEqual([tab]);

    // Its only tab goes back to main, so the app closes it before it can answer.
    await invokeAndForget("window_tab_move", {
      tabId: tab,
      target: { kind: "window", label: "main" },
    });

    await expectWindowCount(1);
    await switchToLabel("main");
    expect(await windowLabels()).toEqual(["main"]);
    expect(tabIds(await invoke<LayoutSummary>("window_layout_get"))).toEqual([
      tab,
    ]);
  });
});
