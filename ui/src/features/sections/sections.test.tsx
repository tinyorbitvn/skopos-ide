import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { Box, HardDrive } from "../../design/icons";
import type { KubeObject } from "../../kinds/objects";
import {
  DEPLOYMENTS,
  NAMESPACES,
  PODS,
  STORAGE_CLASSES,
} from "../../kinds/refs";
import type { ListView } from "../workloads/counts";
import {
  byNamespaceName,
  countOf,
  formatCount,
  naturalCompare,
  objectKey,
  oneDecimal,
  openKeyOf,
  someNames,
} from "./text";
import { type SectionTile, TileGrid, waitingTile } from "./tiles";

const PVS = "/cluster/c1/r/core/persistentvolumes";
const BASE = {
  id: "available",
  icon: HardDrive,
  label: "PVs Available",
  plural: "PersistentVolumes",
  to: PVS,
};

test.each<
  [string, Exclude<ListView, { state: "ready" }>, string, string | null]
>([
  ["loading", { state: "loading" }, "Loading", PVS],
  [
    "forbidden",
    {
      state: "unavailable",
      reason: "persistentvolumes is forbidden",
      cause: "forbidden",
    },
    "You may not list PersistentVolumes",
    null,
  ],
  [
    "not served",
    {
      state: "unavailable",
      reason: "the server could not find the requested resource",
      cause: "notServed",
    },
    "This cluster does not serve PersistentVolumes",
    null,
  ],
  [
    "failed",
    { state: "unavailable", reason: "connection refused", cause: "error" },
    "Could not list PersistentVolumes",
    PVS,
  ],
])(
  "a %s list gives a dash in the neutral tone, its sub-line from the cause (R1)",
  (_, view, sub, to) => {
    expect(waitingTile(view, BASE)).toEqual({
      id: "available",
      icon: HardDrive,
      label: "PVs Available",
      number: "—",
      sub,
      tone: "neutral",
      to,
    });
  },
);

test("a tile grid draws each tile in one row that counts them, as a link or a disabled button", () => {
  const tiles: SectionTile[] = [
    {
      id: "bound",
      icon: Box,
      number: "12",
      label: "PVCs Bound",
      sub: "Of 14 claims",
      tone: "ok",
      to: "/cluster/c1/r/core/persistentvolumeclaims",
    },
    waitingTile(
      { state: "unavailable", reason: "no", cause: "forbidden" },
      BASE,
    ),
  ];
  render(
    <MemoryRouter>
      <TileGrid tiles={tiles} />
    </MemoryRouter>,
  );
  const bound = screen.getByTestId("overview-tile-bound");
  expect([
    bound.tagName,
    bound.getAttribute("href"),
    bound.getAttribute("data-tone"),
  ]).toEqual(["A", "/cluster/c1/r/core/persistentvolumeclaims", "ok"]);
  expect(screen.getByTestId("overview-tile-bound-sub").textContent).toBe(
    "Of 14 claims",
  );
  expect(bound.parentElement?.getAttribute("data-n")).toBe("2");
  const available = screen.getByTestId(
    "overview-tile-available",
  ) as HTMLButtonElement;
  expect([available.tagName, available.disabled]).toEqual(["BUTTON", true]);
  expect(screen.getByTestId("overview-tile-available-number").textContent).toBe(
    "—",
  );
  expect(screen.getByTestId("overview-tile-available-sub").textContent).toBe(
    "You may not list PersistentVolumes",
  );
});

test("names sort naturally and ignore case", () => {
  expect(
    ["node-10", "Node-3", "node-2", "node-1"].sort(naturalCompare),
  ).toEqual(["node-1", "node-2", "Node-3", "node-10"]);
  expect(naturalCompare("Payments", "payments")).toBe(0);
  expect(naturalCompare("b", "A")).toBeGreaterThan(0);
});

const object = (name: string, namespace?: string): KubeObject => ({
  metadata: namespace === undefined ? { name } : { name, namespace },
});

test("objects sort by namespace, then by name, with cluster-scoped ones first", () => {
  const sorted = [
    object("web-10", "shop"),
    object("api", "shop"),
    object("web-2", "shop"),
    object("db", "billing"),
    object("standard"),
  ].sort(byNamespaceName);
  expect(sorted.map((o) => objectKey(o))).toEqual([
    "/standard",
    "billing/db",
    "shop/api",
    "shop/web-2",
    "shop/web-10",
  ]);
});

test("a list of names shows up to two, then how many more", () => {
  expect(someNames([])).toBe("");
  expect(someNames(["worker-04"])).toBe("worker-04");
  expect(someNames(["worker-04", "worker-07"])).toBe("worker-04, worker-07");
  expect(someNames(["worker-04", "worker-07", "worker-09"])).toBe(
    "worker-04, worker-07 and 1 more",
  );
  expect(
    someNames([
      "worker-04",
      "worker-07",
      "worker-09",
      "worker-11",
      "worker-12",
    ]),
  ).toBe("worker-04, worker-07 and 3 more");
});

test("counts take thousands commas, and their noun its plural", () => {
  expect([0, 999, 1000, 1234567].map(formatCount)).toEqual([
    "0",
    "999",
    "1,000",
    "1,234,567",
  ]);
  expect(countOf(1, "node")).toBe("1 node");
  expect(countOf(12, "node")).toBe("12 nodes");
  expect(countOf(0, "claim")).toBe("0 claims");
  expect(countOf(1204, "pod")).toBe("1,204 pods");
  expect(countOf(2, "EndpointSlice")).toBe("2 EndpointSlices");
  expect(countOf(3, "policy", "policies")).toBe("3 policies");
  expect(countOf(1, "policy", "policies")).toBe("1 policy");
});

test("cores and GiB keep one decimal, without a trailing .0", () => {
  expect([13.26, 2, 0.04, 60.5].map(oneDecimal)).toEqual([
    "13.3",
    "2",
    "0",
    "60.5",
  ]);
});

test("the drawer's URL keys: plural for the core group, else plural.group; namespace/name, or /name for a cluster-scoped object (R3)", () => {
  expect(openKeyOf(PODS)).toBe("pods");
  expect(openKeyOf(NAMESPACES)).toBe("namespaces");
  expect(openKeyOf(DEPLOYMENTS)).toBe("deployments.apps");
  expect(openKeyOf(STORAGE_CLASSES)).toBe("storageclasses.storage.k8s.io");
  expect(
    openKeyOf({
      group: "gateway.networking.k8s.io",
      version: "v1",
      plural: "httproutes",
      kind: "HTTPRoute",
      namespaced: true,
    }),
  ).toBe("httproutes.gateway.networking.k8s.io");
  // A core and a grouped namespaced object; a core and a grouped cluster-scoped one.
  expect(objectKey(object("web-1", "shop"))).toBe("shop/web-1");
  expect(objectKey(object("web", "shop"))).toBe("shop/web");
  expect(objectKey(object("worker-03"))).toBe("/worker-03");
  expect(objectKey(object("standard"))).toBe("/standard");
});
