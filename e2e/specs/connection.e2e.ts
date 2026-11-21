import fs from "node:fs";
import path from "node:path";
import { kubeconfig } from "../helpers/fixtures";
import { kubectl } from "../helpers/kube";
import {
  byTestId,
  catalogRow,
  clickWhenShown,
  expectHotbar,
  expectResourceTitle,
  gone,
  hotbarItem,
  rowMenu,
  shown,
} from "../helpers/ui";

const home = process.env.SKOPOS_E2E_HOME as string;
const KIND = "kind-skopos-e2e";

/** Opens a cluster from the catalog by its name link. */
async function openFromCatalog(context: string): Promise<void> {
  await clickWhenShown("nav-catalog");
  await (await catalogRow(context)).$(`a=${context}`).then((link) => link.click());
}

async function statusText(): Promise<string> {
  return (await shown("connection-status")).getText();
}

async function expectStatus(text: string, timeout = 15000): Promise<void> {
  await browser.waitUntil(async () => (await statusText()) === text, {
    timeout,
    timeoutMsg: `connection status never became ${text}`,
  });
}

async function hotbarDot(name: string): Promise<string | null> {
  const dot = await (await hotbarItem(name)).$('[role="img"]');
  return dot.getAttribute("aria-label");
}

/** The trimmed text of an element, or "" while it does not exist. */
async function textOf(id: string): Promise<string> {
  const element = byTestId(id);
  if (!(await element.isExisting())) return "";
  return (await element.getText()).trim();
}

/** How many objects kubectl lists for these arguments. */
async function countOf(args: string[]): Promise<number> {
  const out = await kubectl([...args, "-o", "name"]);
  return out.split("\n").filter((line) => line.trim() !== "").length;
}

describe("cluster connection", () => {
  it("connects to the real kind cluster", async () => {
    await shown(`catalog-row-${KIND}`, 30000);
    await openFromCatalog(KIND);
    await expectStatus("Connected", 60000);
    await browser.waitUntil(
      async () => (await byTestId("cluster-info-distribution").getText()) === "kind",
      { timeout: 15000, timeoutMsg: "distribution never showed kind" },
    );
    expect(await byTestId("cluster-info-version").getText()).not.toBe("");
  });

  it("shows the kind control plane on the Overview, every part healthy", async () => {
    await shown("control-plane", 30000);
    const parts = ["api-server", "etcd", "scheduler", "controller-manager", "dns", "proxy"];
    await browser.waitUntil(
      async () => {
        for (const part of parts) {
          const state = byTestId(`control-plane-${part}-state`);
          if (!(await state.isExisting()) || (await state.getText()) !== "Healthy") return false;
        }
        return true;
      },
      { timeout: 45000, interval: 500, timeoutMsg: "a control plane part never showed Healthy" },
    );
    expect(await byTestId("control-plane-api-server-detail").getText()).toMatch(
      /^v\d+\.\d+\.\d+.* · https:\/\/.+ · all \d+ readyz checks pass$/,
    );
    expect(await byTestId("control-plane-etcd-detail").getText()).toContain("readyz check ok");
    expect(await byTestId("control-plane-scheduler-detail").getText()).toMatch(/leader \S+, renewed/);
  });

  it("shows the kind cluster's capacity and health, and the Pods tile opens the Pods list", async () => {
    await shown("overview-grid", 30000);
    // Without metrics-server the donuts show the Pods' requests, in the same units.
    await browser.waitUntil(
      async () =>
        /^\d+(\.\d)? \/ \d+(\.\d)? cores$/.test(await textOf("overview-capacity-cpu-values")) &&
        /^\d+(\.\d)? \/ \d+(\.\d)? (GiB|MiB)$/.test(
          await textOf("overview-capacity-memory-values"),
        ) &&
        /^\d+ \/ \d+ pods$/.test(await textOf("overview-capacity-pods-values")),
      { timeout: 45000, interval: 1000, timeoutMsg: "the Capacity donuts never showed numbers" },
    );

    const nodes = await countOf(["get", "nodes"]);
    await browser.waitUntil(
      async () =>
        (await textOf("overview-tile-nodes-number")) === `${nodes} / ${nodes}` &&
        (await textOf("overview-tile-nodes-sub")) === "All ready",
      { timeout: 30000, interval: 1000, timeoutMsg: "the Nodes tile never showed every node ready" },
    );
    // Other specs start and stop Pods, so compare with a fresh count on every try.
    await browser.waitUntil(
      async () =>
        (await textOf("overview-tile-pods-number")) ===
        String(await countOf(["get", "pods", "--all-namespaces"])),
      {
        timeout: 30000,
        interval: 1000,
        timeoutMsg: "the Pods tile never matched the number of Pods kubectl lists",
      },
    );
    expect(await textOf("overview-tile-pods-sub")).toMatch(
      /^\d+ Running · \d+ Pending · \d+ Failed$/,
    );
    expect(await textOf("overview-tile-workloads-number")).toMatch(/^\d+$/);
    expect(await textOf("overview-tile-events-number")).toMatch(/^\d+$/);
    await shown("overview-top");

    await clickWhenShown("overview-tile-pods");
    await expectResourceTitle("Pod");
  });

  it("shows a failure for an unreachable cluster with reason and log", async () => {
    await openFromCatalog("dead");
    const heading = await browser.$("h3=Cannot reach the cluster");
    await heading.waitForDisplayed({ timeout: 30000 });
    await expectStatus("Failed");
    await browser.waitUntil(
      async () => (await byTestId("connection-log").getText()).trim() !== "",
      { timeout: 15000, timeoutMsg: "the connection log stayed empty" },
    );
    await shown("cluster-reconnect");
  });

  it("keeps several clusters connected and switches without reconnecting", async () => {
    await openFromCatalog("fake");
    await expectStatus("Connected", 30000);

    await clickWhenShown("nav-catalog");
    await rowMenu(KIND, "pin");
    await rowMenu("fake", "pin");
    await expectHotbar([KIND, "fake"]);

    for (const name of [KIND, "fake", KIND, "fake"]) {
      await (await hotbarItem(name)).click();
      // Read at once: a switch must show the live state, not pass through Connecting.
      await shown("connection-status");
      expect(await statusText()).toBe("Connected");
    }
    expect(await hotbarDot(KIND)).toBe("Connected");
    expect(await hotbarDot("fake")).toBe("Connected");
  });

  it("disconnect and reconnect work", async () => {
    await (await hotbarItem("fake")).click();
    await clickWhenShown("cluster-disconnect");
    await expectStatus("Disconnected");
    await clickWhenShown("cluster-reconnect");
    await expectStatus("Connected", 30000);
  });

  it("clicking a pinned disconnected cluster connects it", async () => {
    await (await hotbarItem("fake")).click();
    await clickWhenShown("cluster-disconnect");
    await expectStatus("Disconnected");

    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake");
    await (await hotbarItem("fake")).click();
    await expectStatus("Connected", 30000);
  });

  it("removing a context on disk disconnects and removes it", async () => {
    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake");

    fs.writeFileSync(path.join(home, ".kube", "fake"), kubeconfig(["other"]));

    await gone("catalog-row-fake", 5000);
    await shown("catalog-row-other");
  });
});
