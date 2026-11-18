import fs from "node:fs";
import path from "node:path";
import { createTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, dockTabTitles, gone, openCluster, openResource, pointerClick, rowId,
  searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-dock-restart";
const IMAGE = "registry.k8s.io/e2e-test-images/agnhost:2.53";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

const MANIFEST = `
apiVersion: v1
kind: Pod
metadata:
  name: keeper
  namespace: ${NS}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: main
      image: ${IMAGE}
      command: ["/bin/sh", "-c", "while true; do echo keeper line; sleep 1; done"]
`;

/** The main window's dock layout (spec P37) as the app saved it in this spec's config dir, or null. */
function savedLayout(): any {
  const file = path.join(process.env.SKOPOS_CONFIG_DIR ?? "", "config", "ui-state.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).data?.["dock:layout:main"] ?? null;
  } catch {
    return null;
  }
}

async function expectTitles(titles: string[], timeoutMsg: string): Promise<void> {
  await until(async () => JSON.stringify(await dockTabTitles()) === JSON.stringify(titles), timeoutMsg);
}

// dock-restart-2-verify.e2e.ts reads this layout back in a new app process.
describe("the dock layout across a restart: before", () => {
  before(async function () {
    this.timeout(300000);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    await kubectl(["-n", NS, "wait", "--for=condition=Ready", "pod/keeper", "--timeout=180s"]);
    await openCluster(KIND);
  });

  it("saves the height, the tab order, the active tab and a Logs tab's options", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await searchResources("keeper");
    await byTestId(rowId(NS, "keeper")).click();
    await shown("detail-drawer");
    await clickWhenShown("detail-action-logs");
    await shown("logs-tab");
    await clickWhenShown("create-resource");
    await expectTitles(["Logs · keeper", "Create"], "the dock never held the two tabs");

    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid^="dock-tab-create-"]')?.focus(),
    );
    await browser.keys(["Control", "Shift", "PageUp"]);
    await expectTitles(["Create", "Logs · keeper"], "Ctrl+Shift+PageUp never moved the Create tab");

    await browser.$('[data-testid^="dock-tab-logs:"]').click();
    await clickWhenShown("logs-wrap");
    await clickWhenShown("logs-timestamps");
    await until(
      async () =>
        (await byTestId("logs-wrap").getAttribute("data-checked")) === "true" &&
        (await byTestId("logs-timestamps").getAttribute("data-checked")) === "false",
      "Wrap and Timestamps never changed",
    );

    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid="dock-resize"]')?.focus(),
    );
    await browser.keys("ArrowUp");
    await browser.keys("ArrowUp");
    await until(
      async () => (await byTestId("dock-resize").getAttribute("aria-valuenow")) === "368",
      "the dock never grew to 368 px",
    );

    // Written 300 ms after the last change.
    await until(async () => {
      const saved = savedLayout();
      const tab = saved?.tabs?.find((t: any) => t.kind === "logs");
      return (
        saved?.height === 368 &&
        JSON.stringify(saved.tabs.map((t: any) => t.kind)) === JSON.stringify(["create", "logs"]) &&
        String(saved.activeId).startsWith("logs:") &&
        tab?.options?.wrap === true &&
        tab?.options?.timestamps === false
      );
    }, "the dock layout was never saved");
  });

  it("saves a details tab with the drawer tab it shows", async () => {
    if (!(await byTestId("detail-drawer").isExisting())) await byTestId(rowId(NS, "keeper")).click();
    await shown("detail-drawer");
    await pointerClick(await shown("detail-tab-events"));
    await shown("detail-events");
    await pointerClick(await shown("detail-minimize"));
    await gone("detail-drawer");
    await expectTitles(["Create", "Logs · keeper", "Pod · keeper"], "Minimize never added the details tab");

    // dock-restart-2-verify.e2e.ts expects the Logs tab active after the restart.
    await browser.$('[data-testid^="dock-tab-logs:"]').click();
    await until(async () => {
      const saved = savedLayout();
      const details = saved?.tabs?.find((t: any) => t.kind === "details");
      return (
        JSON.stringify(saved?.tabs?.map((t: any) => t.kind)) === JSON.stringify(["create", "logs", "details"]) &&
        String(saved.activeId).startsWith("logs:") &&
        details?.tab === "events" &&
        details?.namespace === NS &&
        details?.name === "keeper"
      );
    }, "the details tab was never saved");
  });
});
