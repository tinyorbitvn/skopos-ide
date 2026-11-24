import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { PolicyRef } from "../../ipc/generated/PolicyRef";
import {
  IDS,
  paymentsSnapshot,
  rcell,
  rgroup,
  rhttp,
  rport,
  rref,
  rsnapshot,
} from "../../test/reachability";
import { type PolicyOpener, ReachPanel } from "./ReachPanel";
import { panelOf } from "./reachModel";

const PAYMENTS = paymentsSnapshot();
const NONE: PolicyOpener = () => undefined;

const text = (id: string) => screen.getByTestId(id).textContent;
/** The line under the workload's name. */
const header = () =>
  screen.getByTestId("reach-panel").querySelector("header p")?.textContent;
const headings = (level: 3 | 4) =>
  screen.getAllByRole("heading", { level }).map((h) => h.textContent);
/** The texts of an entry's parts, in order. */
function parts(id: string): string[] {
  const entry = screen.getByTestId(id);
  return [
    ...entry.querySelectorAll(
      ":scope > div:first-child > span, :scope > span, :scope > code",
    ),
  ].map((e) => e.textContent ?? "");
}

test("an isolated workload's panel lists what may reach it and where it may go", () => {
  render(<ReachPanel panel={panelOf(PAYMENTS, IDS.api)} opener={NONE} />);
  const panel = screen.getByTestId("reach-panel");
  expect(panel.getAttribute("aria-label")).toBe("Selected workload");
  expect(headings(3)).toEqual(["api"]);
  expect(header()).toBe("Deployment · 2 Pods · app=api, tier=backend");
  expect(screen.queryByTestId("reach-warning")).toBeNull();
  expect(headings(4)).toEqual(["Allowed in", "Allowed out"]);
  expect(parts(`reach-entry-in-${IDS.web}`)).toEqual([
    "web",
    "8080",
    "Deployment · 3 Pods",
    "GET /api/.*",
  ]);
  expect(parts(`reach-entry-in-${IDS.prometheus}`)).toEqual([
    "monitoring/prometheus",
    "9090",
    "Deployment · 1 Pod",
  ]);
  expect(
    [
      ...within(
        screen.getByRole("region", { name: "Allowed out" }),
      ).getAllByRole("listitem"),
    ].map((li) => li.getAttribute("data-testid")),
  ).toEqual([
    `reach-entry-out-${IDS.db}`,
    `reach-entry-out-${IDS.coredns}`,
    `reach-entry-out-${IDS.stripe}`,
  ]);
  expect(parts(`reach-entry-out-${IDS.coredns}`)).toEqual([
    "kube-system/coredns",
    "53 UDP, TCP",
    "Deployment · 2 Pods",
  ]);
  expect(text("reach-foot")).toBe(
    "Every other connection in and out is blocked.",
  );
});

test("each policy chip shows its source tag and name", () => {
  render(<ReachPanel panel={panelOf(PAYMENTS, IDS.api)} opener={NONE} />);
  expect(
    [
      "reach-policy-kubernetes-payments-allow-web-to-api",
      "reach-policy-cilium-payments-allow-api-from-web",
      "reach-policy-ciliumClusterwide--allow-prometheus-scrape",
    ].map((id) => text(id)),
  ).toEqual([
    "K8s allow-web-to-api",
    "Cilium allow-api-from-web",
    "Cilium cluster allow-prometheus-scrape",
  ]);
  // A policy behind several entries has a chip in each.
  expect(
    screen
      .getAllByTestId("reach-policy-cilium-payments-api-egress-stripe")
      .map((chip) => chip.closest("li")?.getAttribute("data-testid")),
  ).toEqual([
    `reach-entry-out-${IDS.coredns}`,
    `reach-entry-out-${IDS.stripe}`,
  ]);
});

test("a chip whose kind is served opens the policy; one that is not is no button", () => {
  const open = vi.fn();
  const seen: PolicyRef[] = [];
  const opener: PolicyOpener = (ref) => {
    seen.push(ref);
    return ref.source === "kubernetes" ? () => open(ref) : undefined;
  };
  render(<ReachPanel panel={panelOf(PAYMENTS, IDS.api)} opener={opener} />);
  const k8s = screen.getByTestId(
    "reach-policy-kubernetes-payments-allow-web-to-api",
  );
  const cilium = screen.getByTestId(
    "reach-policy-cilium-payments-allow-api-from-web",
  );
  expect([k8s.tagName, cilium.tagName]).toEqual(["BUTTON", "SPAN"]);
  expect(screen.getByRole("button", { name: "K8s allow-web-to-api" })).toBe(
    k8s,
  );
  fireEvent.click(k8s);
  expect(open).toHaveBeenCalledWith(rref("kubernetes", "allow-web-to-api"));
  expect(seen).toContainEqual(rref("cilium", "allow-api-from-web"));
});

test("a Denied entry reads Denied with its deny policies", () => {
  render(<ReachPanel panel={panelOf(PAYMENTS, IDS.db)} opener={NONE} />);
  expect(parts(`reach-entry-out-${IDS.world}`)).toEqual([
    "Outside the cluster",
    "Denied",
    "Addresses the rules above do not name",
  ]);
  expect(
    screen
      .getByTestId(`reach-entry-out-${IDS.world}`)
      .querySelector("[data-tone]")
      ?.getAttribute("data-tone"),
  ).toBe("denied");
  expect(parts(`reach-entry-out-${IDS.stripe}`)).toEqual([
    "api.stripe.com",
    "Denied",
    "DNS name",
  ]);
  expect(
    screen
      .getAllByTestId("reach-policy-cilium-payments-db-no-internet")
      .map((chip) => [
        chip.closest("li")?.getAttribute("data-testid"),
        chip.textContent,
      ]),
  ).toEqual([
    [`reach-entry-out-${IDS.stripe}`, "Cilium db-no-internet"],
    [`reach-entry-out-${IDS.world}`, "Cilium db-no-internet"],
  ]);
});

test("an open workload warns and reads Any source and Anywhere with all ports", () => {
  render(<ReachPanel panel={panelOf(PAYMENTS, IDS.worker)} opener={NONE} />);
  expect(text("reach-warning")).toBe(
    "No policy selects the Pods of worker, so every connection in and out is allowed.",
  );
  expect(parts("reach-entry-in-any")).toEqual(["Any source", "All ports"]);
  expect(parts("reach-entry-out-any")).toEqual(["Anywhere", "All ports"]);
  expect(screen.queryByTestId("reach-foot")).toBeNull();
  expect(
    screen
      .getByTestId("reach-panel")
      .querySelectorAll("[data-testid^='reach-policy-']"),
  ).toHaveLength(0);
});

test("HTTP rules are one per line, with ingress or egress when both sides limit L7, and Some Pods shows", () => {
  const web = rgroup("Deployment", "shop", "web", {
    policies: [rref("cilium", "w", "shop")],
  });
  const api = rgroup("Deployment", "shop", "api", {
    pods: 1,
    labels: [],
    policies: [rref("cilium", "a", "shop")],
    egressIsolated: false,
  });
  const snapshot = rsnapshot("shop", [web, api], {
    cells: [
      rcell(
        web.id,
        api.id,
        "allowed",
        [
          rport(8080, "TCP", {
            http: [
              rhttp({ side: "ingress", method: "GET", path: "/api/.*" }),
              rhttp({ side: "egress", host: "api.example.com" }),
              rhttp({ side: "egress", headers: ["X-Team: a"] }),
            ],
          }),
        ],
        [rref("cilium", "a", "shop")],
        true,
      ),
    ],
  });
  render(<ReachPanel panel={panelOf(snapshot, api.id)} opener={NONE} />);
  expect(header()).toBe("Deployment · 1 Pod");
  expect(parts(`reach-entry-in-${web.id}`)).toEqual([
    "web",
    "8080",
    "Deployment · 1 Pod",
    "Some Pods",
    "ingress GET /api/.*",
    "egress host api.example.com",
    "egress header X-Team: a",
  ]);
  expect(text("reach-warning")).toBe(
    "No policy selects the Pods of api, so every connection out is allowed.",
  );
  expect(text("reach-foot")).toBe("Every other connection in is blocked.");
});
