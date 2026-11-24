import { pickOption } from "../helpers/helm";
import {
  byTestId,
  clickNav,
  clickWhenShown,
  gone,
  openCluster,
  shown,
} from "../helpers/ui";

// e2e/helpers/fixtures.ts applies e2e/fixtures/reachability.yaml, the sample namespace of
// network policies contract C13, before the app starts.
const KIND = "kind-skopos-e2e";
const NS = "skopos-e2e-reach";
const API = `Deployment/${NS}/api`;
const DB = `StatefulSet/${NS}/db`;
const WEB = `Deployment/${NS}/web`;
const WORKER = `Deployment/${NS}/worker`;
const COREDNS = "Deployment/kube-system/coredns";
const STRIPE = "fqdn:api.stripe.com";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

/** The text of the element with this test id, or null while there is none. */
function textOf(id: string): Promise<string | null> {
  return browser.execute(
    (target: string) =>
      document.querySelector(`[data-testid="${target}"]`)?.textContent ?? null,
    id,
  );
}

/** The cell texts the sample namespace must show, by (from, to). */
const CELLS: [string, string, string][] = [
  [WEB, API, "8080 GET /api/.*"],
  [API, DB, "5432"],
  [API, COREDNS, "53 UDP, TCP"],
  [WEB, COREDNS, "53 UDP, TCP"],
  [API, STRIPE, "443"],
  [DB, STRIPE, "Denied"],
  [DB, "world", "Denied"],
  [WORKER, WORKER, "All"],
  [WORKER, WEB, "—"],
  [`Deployment/${NS}-ingress/ingress-nginx-controller`, WEB, "8080"],
  [`Deployment/${NS}-monitoring/prometheus`, DB, "9090"],
];

describe("reachability", () => {
  before(async () => {
    await openCluster(KIND);
    await clickNav("nav-network/reachability");
    await shown("reachability");
    // The count chips come with the first snapshot and move the select to the left, so a
    // click aimed before they arrive lands beside it.
    await shown("reach-count-kubernetes");
    await pickOption("reach-namespace", NS);
  });

  it("draws the sample namespace's matrix and counts its policies", async () => {
    await until(
      async () =>
        (await textOf(`reach-cell-${WEB}--${API}`)) === "8080 GET /api/.*",
      "the matrix never showed web to api",
    );
    const texts: string[] = [];
    for (const [from, to] of CELLS) {
      texts.push((await textOf(`reach-cell-${from}--${to}`)) ?? "missing");
    }
    expect(texts).toEqual(CELLS.map(([, , text]) => text));
    expect(await textOf("reach-count-kubernetes")).toBe("K8s 6 policies");
    expect(await textOf("reach-count-cilium")).toBe("Cilium 4 policies");
    expect(await textOf("reach-not-evaluated")).toBe("1 rule not evaluated");
    expect(await textOf("reach-banner")).toBeNull();
  });

  it("shows a selected workload in the panel", async () => {
    await clickWhenShown(`reach-row-${API}`);
    await until(
      async () =>
        (await byTestId(`reach-row-${API}`).getAttribute("aria-pressed")) ===
        "true",
      "the api row never showed as selected",
    );
    const panel = await shown("reach-panel");
    expect(await panel.$("h3").getText()).toBe("api");
    // The core leaves out pod-template-hash and the other labels controllers add (R13).
    expect(await panel.$("header p").getText()).toBe(
      "Deployment · 2 Pods · app=api, tier=backend",
    );
    expect(await textOf(`reach-entry-in-${WEB}`)).toContain("GET /api/.*");
    expect(await textOf(`reach-entry-out-${DB}`)).toContain("5432");
    expect(await textOf(`reach-entry-out-${STRIPE}`)).toContain("443");
    expect(await textOf("reach-foot")).toBe(
      "Every other connection in and out is blocked.",
    );
  });

  it("opens a policy chip in the drawer", async () => {
    await clickWhenShown(`reach-policy-cilium-${NS}-allow-api-from-web`);
    await shown("detail-drawer");
    await until(
      async () =>
        (await byTestId("detail-title").getText()) === "allow-api-from-web",
      "the drawer never showed the policy",
    );
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });
});
