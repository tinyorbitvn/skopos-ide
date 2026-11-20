import {
  byTestId,
  clickNav,
  clickWhenShown,
  gone,
  openCluster,
  pointerClick,
  shown,
} from "../helpers/ui";

// e2e/helpers/fixtures.ts creates these objects before the app starts (topology spec §8).
const KIND = "kind-skopos-e2e";
const WORKER = "skopos-e2e-worker";
const CONTROL_PLANE = "skopos-e2e-control-plane";
const NS = "skopos-e2e-topology";
const ZONE = "skopos-e2e-zone";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

/** The pod keys of a node's squares, in order. */
function squares(node: string): Promise<string[]> {
  return browser.execute(
    (id: string) =>
      Array.from(
        document.querySelectorAll(`[data-testid="${id}"] [role="gridcell"]`),
      ).map((el) => el.getAttribute("data-pod") ?? ""),
    `topology-pods-${node}`,
  );
}

describe("node topology", () => {
  before(async () => {
    await openCluster(KIND);
    await clickNav("nav-node-topology");
    await shown("topology-page");
  });

  it("puts the worker in its zone column with the fixture's two pods", async () => {
    await shown(`topology-zone-${ZONE}`, 60000);
    await shown(`topology-card-${WORKER}`);
    await shown(`topology-card-${CONTROL_PLANE}`);
    await until(
      async () =>
        (await squares(WORKER)).filter((key) => key.startsWith(`${NS}/topology-`))
          .length === 2,
      "the worker never showed the fixture's two pods",
    );
  });

  it("opens a pod's drawer from its square", async () => {
    const [key] = (await squares(WORKER)).filter((k) => k.startsWith(`${NS}/`));
    if (key === undefined) throw new Error("no fixture pod on the worker");
    await pointerClick(await browser.$(`[data-pod="${key}"]`));
    await shown("detail-drawer");
    await until(
      async () =>
        (await byTestId("detail-title").getText()) === key.slice(NS.length + 1),
      "the drawer never showed the pod",
    );
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });

  it("fades the other namespaces' squares when one is highlighted", async () => {
    await pointerClick(await byTestId("topology-highlight"));
    await clickWhenShown(`topology-ns-${NS}`);
    await until(
      () =>
        browser.execute((ns: string) => {
          const cells = Array.from(
            document.querySelectorAll('[role="gridcell"]'),
          );
          return (
            cells.length > 0 &&
            cells.every(
              (el) =>
                el.hasAttribute("data-faded") ===
                !(el.getAttribute("data-pod") ?? "").startsWith(`${ns}/`),
            )
          );
        }, NS),
      "the highlight never faded the other namespaces",
    );
  });
});
