import { expect, test } from "vitest";
import type { VolumeUsage } from "../../ipc/generated/VolumeUsage";
import type { KubeObject } from "../../kinds/objects";
import type { ListView } from "../workloads/counts";
import {
  classRows,
  largestClaims,
  mountNodes,
  notListed,
  storageTiles,
  unboundClaims,
} from "./storageModel";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

interface ClaimOver {
  phase?: string;
  /** null: the claim names no StorageClass. */
  storageClass?: string | null;
  storage?: string;
  volumeName?: string;
  deleting?: boolean;
  finalizers?: string[];
}

function claim(
  namespace: string,
  name: string,
  over: ClaimOver = {},
): KubeObject {
  return {
    metadata: {
      name,
      namespace,
      uid: `pvc/${namespace}/${name}`,
      ...(over.deleting ? { deletionTimestamp: "2026-11-21T09:00:00Z" } : {}),
      ...(over.finalizers ? { finalizers: over.finalizers } : {}),
    },
    spec: {
      ...(over.storageClass === null
        ? {}
        : { storageClassName: over.storageClass ?? "standard" }),
      ...(over.volumeName ? { volumeName: over.volumeName } : {}),
    },
    status: {
      phase: over.phase ?? "Bound",
      ...(over.storage ? { capacity: { storage: over.storage } } : {}),
    },
  } as KubeObject;
}

function volume(
  name: string,
  over: {
    phase?: string;
    storageClass?: string;
    storage?: string;
    deleting?: boolean;
  } = {},
): KubeObject {
  return {
    metadata: {
      name,
      uid: `pv/${name}`,
      ...(over.deleting ? { deletionTimestamp: "2026-11-21T09:00:00Z" } : {}),
    },
    spec: {
      storageClassName: over.storageClass ?? "standard",
      capacity: { storage: over.storage ?? "10Gi" },
    },
    status: { phase: over.phase ?? "Bound" },
  } as KubeObject;
}

function storageClass(
  name: string,
  over: {
    provisioner?: string;
    isDefault?: boolean;
    expansion?: boolean;
    binding?: string;
  } = {},
): KubeObject {
  return {
    metadata: {
      name,
      uid: `sc/${name}`,
      ...(over.isDefault
        ? {
            annotations: {
              "storageclass.kubernetes.io/is-default-class": "true",
            },
          }
        : {}),
    },
    provisioner: over.provisioner ?? "rancher.io/local-path",
    volumeBindingMode: over.binding ?? "Immediate",
    ...(over.expansion === undefined
      ? {}
      : { allowVolumeExpansion: over.expansion }),
  } as KubeObject;
}

function pod(name: string, node: string | null, claims: string[]): KubeObject {
  return {
    metadata: { name, namespace: "shop", uid: `pod/${name}` },
    spec: {
      ...(node === null ? {} : { nodeName: node }),
      volumes: [
        { name: "config", configMap: { name: "web-config" } },
        ...claims.map((c) => ({
          name: c,
          persistentVolumeClaim: { claimName: c },
        })),
      ],
    },
  } as KubeObject;
}

const ready = (items: KubeObject[]): ListView => ({ state: "ready", items });
const NONE = ready([]);

function used(
  namespace: string,
  claimName: string,
  node: string,
  usedBytes: number,
  capacityBytes: number,
): VolumeUsage {
  return { namespace, claim: claimName, node, usedBytes, capacityBytes };
}

const CLAIMS_LIST = "/cluster/c1/r/core/persistentvolumeclaims";
const VOLUMES_LIST = "/cluster/c1/r/core/persistentvolumes";
const CLASSES_LIST = "/cluster/c1/r/storage.k8s.io/storageclasses";

test("the claim tiles count Bound, Pending and Lost, and a claim being deleted counts in none", () => {
  const tiles = storageTiles({
    clusterId: "c1",
    claims: ready([
      claim("shop", "data-1"),
      claim("shop", "data-2"),
      claim("ingest", "cache-10", { phase: "Pending" }),
      claim("ingest", "cache-2", { phase: "Pending" }),
      claim("shop", "logs", { phase: "Pending" }),
      claim("ingest", "logs", { phase: "Pending" }),
      claim("shop", "gone", { phase: "Lost" }),
      claim("shop", "old", { deleting: true }),
    ]),
    volumes: NONE,
    classes: NONE,
  });
  expect(tiles.map((t) => t.id)).toEqual([
    "bound",
    "pending",
    "lost",
    "available",
    "released",
    "classes",
  ]);
  const [bound, pending, lost] = tiles;
  expect(bound).toMatchObject({
    id: "bound",
    number: "2",
    label: "PVCs Bound",
    sub: "Of 8 claims",
    tone: "ok",
    to: CLAIMS_LIST,
  });
  expect(pending).toMatchObject({
    id: "pending",
    number: "4",
    label: "PVCs Pending",
    sub: "cache-2, cache-10 and 2 more",
    tone: "warn",
    to: CLAIMS_LIST,
  });
  expect(lost).toMatchObject({
    id: "lost",
    number: "1",
    label: "PVCs Lost",
    sub: "gone",
    tone: "danger",
    to: CLAIMS_LIST,
  });
});

test("with no Pending or Lost claim their tiles read None in the ok tone", () => {
  const [bound, pending, lost] = storageTiles({
    clusterId: "c1",
    claims: ready([claim("shop", "data-1")]),
    volumes: NONE,
    classes: NONE,
  });
  expect(bound).toMatchObject({ number: "1", sub: "Of 1 claim", tone: "ok" });
  expect([pending, lost].map((t) => [t.number, t.sub, t.tone])).toEqual([
    ["0", "None", "ok"],
    ["0", "None", "ok"],
  ]);
});

test("the volume tiles count Available and Released, and the classes tile names the default", () => {
  const tiles = storageTiles({
    clusterId: "c1",
    claims: NONE,
    volumes: ready([
      volume("pv-1", { phase: "Available" }),
      volume("pv-2", { phase: "Released" }),
      volume("pv-3", { phase: "Released" }),
      volume("pv-4"),
      volume("pv-5", { phase: "Available", deleting: true }),
    ]),
    classes: ready([
      storageClass("fast"),
      storageClass("standard", { isDefault: true }),
    ]),
  });
  const [, , , available, released, classes] = tiles;
  expect(available).toMatchObject({
    id: "available",
    number: "1",
    label: "PVs Available",
    sub: "Ready for a claim",
    tone: "neutral",
    to: VOLUMES_LIST,
  });
  expect(released).toMatchObject({
    id: "released",
    number: "2",
    label: "PVs Released",
    sub: "Their claims are gone",
    tone: "warn",
    to: VOLUMES_LIST,
  });
  expect(classes).toMatchObject({
    id: "classes",
    number: "2",
    label: "StorageClasses",
    sub: "Default: standard",
    tone: "neutral",
    to: CLASSES_LIST,
  });
});

test("one Released volume, none Available and no default class read so", () => {
  const [, , , available, released, classes] = storageTiles({
    clusterId: "c1",
    claims: NONE,
    volumes: ready([volume("pv-2", { phase: "Released" })]),
    classes: ready([storageClass("fast")]),
  });
  expect([available.number, available.sub, available.tone]).toEqual([
    "0",
    "None",
    "neutral",
  ]);
  expect([released.number, released.sub, released.tone]).toEqual([
    "1",
    "Its claim is gone",
    "warn",
  ]);
  expect(classes.sub).toBe("No default class");
  const [, , , , none] = storageTiles({
    clusterId: "c1",
    claims: NONE,
    volumes: NONE,
    classes: NONE,
  });
  expect([none.number, none.sub, none.tone]).toEqual(["0", "None", "neutral"]);
});

test("a tile whose list is not there says why, by the kind it reads", () => {
  const tiles = storageTiles({
    clusterId: "c1",
    claims: { state: "loading" },
    volumes: {
      state: "unavailable",
      reason: "You may not list PersistentVolumes.",
      cause: "forbidden",
    },
    classes: {
      state: "unavailable",
      reason: "This cluster does not serve StorageClasses.",
      cause: "notServed",
    },
  });
  expect(tiles.map((t) => [t.id, t.number, t.sub, t.tone, t.to])).toEqual([
    ["bound", "—", "Loading", "neutral", CLAIMS_LIST],
    ["pending", "—", "Loading", "neutral", CLAIMS_LIST],
    ["lost", "—", "Loading", "neutral", CLAIMS_LIST],
    ["available", "—", "You may not list PersistentVolumes", "neutral", null],
    ["released", "—", "You may not list PersistentVolumes", "neutral", null],
    [
      "classes",
      "—",
      "This cluster does not serve StorageClasses",
      "neutral",
      null,
    ],
  ]);
  const [bound] = storageTiles({
    clusterId: "c1",
    claims: { state: "unavailable", reason: "boom", cause: "error" },
    volumes: NONE,
    classes: NONE,
  });
  expect([bound.number, bound.sub, bound.tone, bound.to]).toEqual([
    "—",
    "Could not list PersistentVolumeClaims",
    "neutral",
    CLAIMS_LIST,
  ]);
});

test("the mounted claims' nodes are the nodes of Pods that mount one, sorted and once each", () => {
  expect(
    mountNodes([
      pod("web-0", "node-10", ["data-1"]),
      pod("web-1", "node-2", ["data-1"]),
      pod("web-2", "node-2", ["logs"]),
      pod("api-0", "node-3", []),
      pod("waiting-0", null, ["data-2"]),
    ]),
  ).toEqual(["node-2", "node-10"]);
  expect(mountNodes([pod("api-0", "node-3", [])])).toEqual([]);
});

test("Largest claims ranks the mounted claims under the selection by used bytes, then by name, five at most", () => {
  const claims = [
    claim("shop", "orders-db"),
    claim("shop", "logs"),
    claim("shop", "cache-10"),
    claim("shop", "cache-3"),
    claim("shop", "cache-2"),
    claim("shop", "cache-1"),
    claim("shop", "idle"),
  ];
  const usage = [
    used("ingest", "kafka", "n2", 50 * GIB, 100 * GIB),
    used("shop", "cache-10", "n1", 100 * MIB, GIB),
    used("shop", "cache-3", "n1", 100 * MIB, GIB),
    used("shop", "cache-2", "n1", 100 * MIB, GIB),
    used("shop", "cache-1", "n1", 100 * MIB, GIB),
    used("shop", "logs", "n2", 870 * MIB, GIB),
    used("shop", "orders-db", "n1", 15 * GIB, 20 * GIB),
  ];
  expect(largestClaims(claims, usage).map((r) => r.key)).toEqual([
    "shop/orders-db",
    "shop/logs",
    "shop/cache-1",
    "shop/cache-2",
    "shop/cache-3",
  ]);
  expect(largestClaims(claims, usage, 2).map((r) => r.key)).toEqual([
    "shop/orders-db",
    "shop/logs",
  ]);
  expect(largestClaims(claims, [])).toEqual([]);
});

test("a claim row names its namespace and class, its used bytes and its own usage", () => {
  const [orders, logs] = largestClaims(
    [
      claim("shop", "orders-db", { storage: "20Gi" }),
      claim("shop", "logs", { storageClass: "fast" }),
    ],
    [
      used("shop", "logs", "n2", 870 * MIB, GIB),
      used("shop", "orders-db", "n1", 15 * GIB, 20 * GIB),
    ],
  );
  expect(orders).toMatchObject({
    key: "shop/orders-db",
    name: "orders-db",
    sub: "shop · standard",
    amount: 15 * GIB,
    amountText: "15 GiB",
    own: { pct: 75, label: "orders-db 75%, 15 of 20 GiB" },
  });
  expect(orders.own.level).toBeUndefined();
  expect(logs).toMatchObject({
    sub: "shop · fast",
    amountText: "870 MiB",
    own: { pct: 85, label: "logs 85%, 0.8 of 1 GiB" },
  });
  const [raw] = largestClaims(
    [claim("shop", "raw", { storageClass: null })],
    [used("shop", "raw", "n1", 870 * MIB, 0)],
  );
  expect(raw).toMatchObject({
    sub: "shop",
    amountText: "870 MiB",
    own: { pct: null, label: "raw: no data" },
  });
});

test("a claim the kubelets report twice still fills one row, with the larger used bytes", () => {
  const rows = largestClaims(
    [claim("shop", "shared")],
    [
      used("shop", "shared", "n1", 2 * GIB, 10 * GIB),
      used("shop", "shared", "n2", 3 * GIB, 10 * GIB),
    ],
  );
  expect(rows.map((r) => [r.key, r.amountText])).toEqual([
    ["shop/shared", "3 GiB"],
  ]);
});

test("Claims not Bound gives the first reason that applies, by namespace and name", () => {
  const classes = [
    storageClass("standard"),
    storageClass("late", {
      provisioner: "ebs.csi.aws.com",
      binding: "WaitForFirstConsumer",
    }),
  ];
  const rows = unboundClaims(
    [
      claim("shop", "bound"),
      claim("shop", "deleting", {
        deleting: true,
        finalizers: ["kubernetes.io/pvc-protection"],
      }),
      claim("ingest", "deleting", { deleting: true }),
      claim("shop", "waits", { phase: "Pending", storageClass: "late" }),
      claim("shop", "provisions", { phase: "Pending" }),
      claim("shop", "static", { phase: "Pending", storageClass: null }),
      claim("shop", "orphan", { phase: "Pending", storageClass: "gone" }),
      claim("shop", "lost", { phase: "Lost", volumeName: "pv-9" }),
      claim("shop", "new", { phase: "" }),
    ],
    classes,
  );
  expect(
    rows.map((r) => [
      `${r.claim.metadata.namespace}/${r.claim.metadata.name}`,
      r.status,
      r.reason,
    ]),
  ).toEqual([
    // Without a finalizer the first rule does not apply, so the status text stands.
    ["ingest/deleting", "Terminating", "Terminating"],
    [
      "shop/deleting",
      "Terminating",
      "Being deleted; waiting for the finalizer kubernetes.io/pvc-protection",
    ],
    ["shop/lost", "Lost", "Its PersistentVolume pv-9 no longer exists"],
    ["shop/new", "Unknown", "Unknown"],
    ["shop/orphan", "Pending", "Waiting for a matching PersistentVolume"],
    [
      "shop/provisions",
      "Pending",
      "Waiting for rancher.io/local-path to provision a volume",
    ],
    ["shop/static", "Pending", "Waiting for a matching PersistentVolume"],
    [
      "shop/waits",
      "Pending",
      "Waiting for a Pod to use it (WaitForFirstConsumer)",
    ],
  ]);
  expect(unboundClaims([claim("shop", "bound")], classes)).toEqual([]);
});

test("Capacity by StorageClass sums Bound claims under the selection against the class's volumes", () => {
  const rows = classRows(
    [
      storageClass("standard", { isDefault: true, expansion: true }),
      storageClass("fast", { provisioner: "ebs.csi.aws.com" }),
      storageClass("empty"),
    ],
    [
      volume("pv-1", { storage: "20Gi" }),
      volume("pv-2", { storage: "20Gi", phase: "Released" }),
      volume("pv-3", { storage: "5Gi", storageClass: "fast" }),
    ],
    [
      claim("shop", "data-1", { storage: "20Gi" }),
      claim("shop", "data-2", { storage: "20Gi", phase: "Pending" }),
      claim("shop", "data-3", { storage: "20Gi", deleting: true }),
      claim("shop", "f", { storage: "5Gi", storageClass: "fast" }),
    ],
  );
  expect(
    rows.map((r) => [
      r.storageClass.metadata.name,
      r.isDefault,
      r.provisioner,
      r.expansion,
    ]),
  ).toEqual([
    ["empty", false, "rancher.io/local-path", "Not allowed"],
    ["fast", false, "ebs.csi.aws.com", "Not allowed"],
    ["standard", true, "rancher.io/local-path", "Allowed"],
  ]);
  expect(rows.map((r) => r.donut)).toEqual([
    {
      pct: null,
      used: null,
      total: null,
      unit: "GiB",
      label: "empty requested: no data",
    },
    {
      pct: 100,
      used: "5",
      total: "5",
      unit: "GiB",
      label: "fast requested 100%, 5 of 5 GiB",
    },
    {
      pct: 50,
      used: "20",
      total: "40",
      unit: "GiB",
      label: "standard requested 50%, 20 of 40 GiB",
    },
  ]);
  // Claims the account may not list leave every donut without data.
  const [unknown] = classRows(
    [storageClass("standard")],
    [volume("pv-1")],
    null,
  );
  expect(unknown.donut).toEqual({
    pct: null,
    used: null,
    total: null,
    unit: "GiB",
    label: "standard requested: no data",
  });
});

test("notListed says why a list is not there in the tiles' words", () => {
  expect(notListed("forbidden", "Pods")).toBe("You may not list Pods");
  expect(notListed("notServed", "StorageClasses")).toBe(
    "This cluster does not serve StorageClasses",
  );
  expect(notListed("error", "PersistentVolumes")).toBe(
    "Could not list PersistentVolumes",
  );
});
