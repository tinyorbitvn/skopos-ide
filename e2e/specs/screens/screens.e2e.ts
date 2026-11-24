import fs from "node:fs";
import path from "node:path";
import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../../helpers/kube";
import {
  clickWhenShown,
  closeDockTabs,
  editorContaining,
  gone,
  openCluster,
  openResource,
  resourceRowMenu,
  rowId,
  searchResources,
  shown,
} from "../../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-screens";
// The worktree's git-ignored tmp/, three levels up from e2e/specs/screens.
const OUT = path.resolve(__dirname, "../../../tmp/screens");

/** The Store wants desktop screenshots of at least 1366×768 (Store spec §5). */
const SHOT = { width: 1920, height: 1080 };
const STORE_MIN = { width: 1366, height: 768 };

interface TauriGlobal {
  window: { getCurrentWindow(): { setSize(size: unknown): Promise<void> } };
  dpi: { LogicalSize: new (width: number, height: number) => unknown };
}

async function sizeWindow(): Promise<void> {
  await browser.execute(async (size) => {
    const tauri = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;
    await tauri.window
      .getCurrentWindow()
      .setSize(new tauri.dpi.LogicalSize(size.width, size.height));
  }, SHOT);
  await browser.pause(500);
}

function pngSize(file: string): { width: number; height: number } {
  const png = fs.readFileSync(file);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function setTheme(theme: "light" | "dark"): Promise<void> {
  await browser.execute((t) => {
    document.documentElement.dataset.theme = t;
    // Transitions do not advance under the WebKit driver; without this the
    // light shots keep the dark colours of transitioned controls.
    if (!document.getElementById("shot-no-transition")) {
      const style = document.createElement("style");
      style.id = "shot-no-transition";
      style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
      document.head.appendChild(style);
    }
  }, theme);
  // One frame for Monaco's theme observer and the repaint.
  await browser.pause(300);
}

async function shoot(name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    const file = path.join(OUT, `${name}-${theme}.png`);
    await browser.saveScreenshot(file);
    const size = pngSize(file);
    expect(size.width).toBeGreaterThanOrEqual(STORE_MIN.width);
    expect(size.height).toBeGreaterThanOrEqual(STORE_MIN.height);
  }
}

describe("screens", () => {
  before(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await createTestNamespace(NS);
    await kubectl([
      "-n",
      NS,
      "create",
      "configmap",
      "screens",
      "--from-literal=key=value",
    ]);
    await sizeWindow();
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("catalog", async () => {
    await clickWhenShown("nav-catalog");
    await shown(`catalog-row-${KIND}`, 30000);
    // The driver's click focuses the rail button with no pointer event, which reads as
    // keyboard focus and opens its tooltip; the shot must not show it.
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.waitUntil(async () => (await $$('[role="tooltip"]').length) === 0, {
      timeout: 5000,
      timeoutMsg: "the rail tooltip stayed open",
    });
    await shoot("catalog");
  });

  it("cluster overview", async () => {
    await openCluster(KIND);
    await shoot("cluster-overview");
  });

  it("pods table with a pod drawer", async () => {
    await openResource("nav-item-core-pods", "Pod");
    // kind's etcd static pod is always there, with a container named etcd.
    await searchResources("component=etcd");
    await $('[data-testid^="resource-row-"]').click();
    await shown("detail-container-etcd");
    await shoot("pods-drawer");
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });

  it("dock with a YAML tab", async () => {
    await openResource("nav-item-core-configmaps", "ConfigMap");
    await searchResources("screens");
    await shown(rowId(NS, "screens"));
    await resourceRowMenu("screens", "edit");
    await editorContaining("key: value");
    await shoot("dock-yaml");
    await closeDockTabs();
  });

  it("delete dialog", async () => {
    await resourceRowMenu("screens", "delete");
    await shown("delete-confirm");
    await shoot("delete-dialog");
    await browser.keys("Escape");
    await gone("delete-confirm");
  });

  it("preferences", async () => {
    await clickWhenShown("nav-preferences");
    await browser.pause(400);
    await shoot("preferences");
  });
});
