import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { VolumeUsage } from "../../ipc/generated/VolumeUsage";
import type { VolumeUsageSnapshot } from "../../ipc/generated/VolumeUsageSnapshot";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetResourcesForTest } from "../../stores/resources";
import { servedResource } from "../../test/graph";
import { flush, mockBackend } from "../../test/ipc";
import { connectClusters } from "../../test/terminal";
import type { ClusterOutletContext } from "../cluster/ClusterLayout";
import { StorageOverview } from "./StorageOverview";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const RESOURCES: ApiResourceInfo[] = [
  servedResource("PersistentVolumeClaim", "", "persistentvolumeclaims"),
  servedResource("PersistentVolume", "", "persistentvolumes", false),
  servedResource("StorageClass", "storage.k8s.io", "storageclasses", false),
  servedResource("Pod", "", "pods"),
];
/** The lists the page watches. */
const LISTS = [
  "persistentvolumeclaims",
  "persistentvolumes",
  "pods",
  "storageclasses",
];
const TILES = ["bound", "pending", "lost", "available", "released", "classes"];

type Lists = Partial<Record<string, KubeObject[]>>;

function usage(items: VolumeUsage[]): VolumeUsageSnapshot {
  return { timestamp: "2026-11-21T10:00:00Z", items };
}

function fake(
  over: Parameters<typeof mockBackend>[0] = {},
  uiState: Record<string, unknown> = {},
) {
  const subs = new Map<string, (e: WatchEvent) => void>();
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) => uiState[a.key] ?? null,
    ui_state_set: () => null,
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    resources_subscribe_object: () => "object-sub",
    resource_get: () => new Promise(() => {}),
    resource_events: () => new Promise(() => {}),
    volumes_usage: () => usage([]),
    ...over,
  });
  /** Each watched list's first snapshot, empty unless given, then the kubelets' answer. */
  async function lists(byPlural: Lists) {
    for (const plural of LISTS) {
      await act(async () => {
        subs.get(plural)?.({
          type: "snapshot",
          items: byPlural[plural] ?? [],
        } as WatchEvent);
        await flush();
      });
    }
    await act(flush);
  }
  /** What each subscription named: the plural and the namespaces, by plural. */
  const asked = () =>
    backend
      .callsTo("resources_subscribe")
      .map((a): [string, unknown] => [
        (a.resource as ResourceRef).plural,
        a.namespaces,
      ])
      .sort(([a], [b]) => a.localeCompare(b));
  return { backend, lists, asked };
}

type Fake = ReturnType<typeof fake>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

async function show(
  f: Fake = fake(),
  resources: ApiResourceInfo[] = RESOURCES,
): Promise<Fake> {
  const context: ClusterOutletContext = {
    clusterId: "c1",
    resources,
    resourcesLoading: false,
    resourcesError: null,
  };
  render(
    <MemoryRouter initialEntries={["/cluster/c1/storage"]}>
      <Routes>
        <Route path="/cluster/:id" element={<Outlet context={context} />}>
          <Route
            path="storage"
            element={
              <>
                <StorageOverview />
                <Where />
              </>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
  await act(flush);
  return f;
}

const text = (id: string) => screen.getByTestId(id).textContent;
const tile = (id: string) => [
  id,
  text(`overview-tile-${id}-number`),
  text(`overview-tile-${id}-sub`),
];
const rowIds = (table: string) =>
  screen
    .queryAllByTestId(new RegExp(`^${table}-row-`))
    .map((r) => r.getAttribute("data-testid"));
const heads = (table: string) =>
  within(screen.getByTestId(table))
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
const emptyTitle = (id: string) =>
  within(screen.getByTestId(id)).getByRole("heading").textContent;

function claim(
  namespace: string,
  name: string,
  phase: string,
  over: {
    storage?: string;
    storageClass?: string;
    deleting?: boolean;
    finalizers?: string[];
  } = {},
): KubeObject {
  return {
    metadata: {
      name,
      namespace,
      uid: `pvc/${namespace}/${name}`,
      resourceVersion: "1",
      ...(over.deleting
        ? {
            deletionTimestamp: "2026-11-21T09:00:00Z",
            finalizers: over.finalizers ?? [],
          }
        : {}),
    },
    spec: {
      storageClassName: over.storageClass ?? "standard",
      volumeName: `pv-${name}`,
    },
    status: {
      phase,
      ...(over.storage ? { capacity: { storage: over.storage } } : {}),
    },
  } as KubeObject;
}

function volume(
  name: string,
  phase: string,
  storage: string,
  storageClass = "standard",
): KubeObject {
  return {
    metadata: { name, uid: `pv/${name}`, resourceVersion: "1" },
    spec: { storageClassName: storageClass, capacity: { storage } },
    status: { phase },
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
      resourceVersion: "1",
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
    ...(over.expansion ? { allowVolumeExpansion: true } : {}),
  } as KubeObject;
}

function pod(
  namespace: string,
  name: string,
  node: string,
  claims: string[],
): KubeObject {
  return {
    metadata: {
      name,
      namespace,
      uid: `pod/${namespace}/${name}`,
      resourceVersion: "1",
    },
    spec: {
      nodeName: node,
      volumes: claims.map((c) => ({
        name: c,
        persistentVolumeClaim: { claimName: c },
      })),
    },
  } as KubeObject;
}

function item(
  namespace: string,
  claimName: string,
  node: string,
  usedBytes: number,
  capacityBytes: number,
): VolumeUsage {
  return { namespace, claim: claimName, node, usedBytes, capacityBytes };
}

const without = (plural: string) =>
  RESOURCES.filter((r) => r.resource.plural !== plural);
const forbidden = (plural: string) =>
  RESOURCES.map((r) =>
    r.resource.plural === plural ? { ...r, canList: false } : r,
  );

beforeEach(() => {
  resetResourcesForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("the page lays out Largest claims and Summary, then Claims not Bound and Capacity by StorageClass", async () => {
  await show();
  expect(screen.getByTestId("storage-overview")).toBeTruthy();
  expect(text("storage-overview-title")).toBe("Storage overview");
  expect(screen.queryByTestId("storage-overview-namespaces")).toBeNull();
  const grid = screen.getByTestId("storage-overview-card-claims").parentElement
    ?.parentElement;
  expect(
    [...(grid?.children ?? [])].map((c) => [
      c.getAttribute("data-span"),
      c.firstElementChild?.getAttribute("data-testid"),
    ]),
  ).toEqual([
    ["5", "storage-overview-card-claims"],
    ["7", "storage-overview-card-summary"],
    ["5", "storage-overview-card-unbound"],
    ["7", "storage-overview-card-classes"],
  ]);
  expect(
    ["claims", "summary", "unbound", "classes"].map(
      (card) =>
        within(screen.getByTestId(`storage-overview-card-${card}`)).getByRole(
          "heading",
          { level: 2 },
        ).textContent,
    ),
  ).toEqual([
    "Largest claims",
    "Summary",
    "Claims not Bound",
    "Capacity by StorageClass",
  ]);
});

test("while the lists load, every tile and table says Loading and no kubelet is asked", async () => {
  const f = await show();
  for (const id of TILES) {
    expect(text(`overview-tile-${id}-sub`)).toBe("Loading");
  }
  for (const id of ["storage-claims", "storage-unbound", "storage-classes"]) {
    expect(text(`${id}-loading`)).toContain("Loading");
  }
  expect(f.backend.callsTo("volumes_usage")).toEqual([]);
});

test("the tiles count the lists under the chosen namespaces and open them", async () => {
  const f = await show(fake({}, { "namespaces:c1": ["shop"] }));
  expect(f.asked()).toEqual([
    ["persistentvolumeclaims", ["shop"]],
    ["persistentvolumes", []],
    ["pods", ["shop"]],
    ["storageclasses", []],
  ]);
  await f.lists({
    persistentvolumeclaims: [
      claim("shop", "orders-db", "Bound", { storage: "20Gi" }),
      claim("shop", "logs", "Bound", { storage: "1Gi" }),
      claim("shop", "uploads", "Pending"),
      claim("shop", "gone", "Lost"),
    ],
    persistentvolumes: [
      volume("pv-orders-db", "Bound", "20Gi"),
      volume("pv-logs", "Bound", "1Gi"),
      volume("pv-spare", "Available", "5Gi"),
      volume("pv-old", "Released", "5Gi"),
    ],
    storageclasses: [
      storageClass("standard", { isDefault: true }),
      storageClass("fast"),
    ],
  });
  expect(text("storage-overview-namespaces")).toBe("Namespaces: shop");
  expect(TILES.map(tile)).toEqual([
    ["bound", "2", "Of 4 claims"],
    ["pending", "1", "uploads"],
    ["lost", "1", "gone"],
    ["available", "1", "Ready for a claim"],
    ["released", "1", "Its claim is gone"],
    ["classes", "2", "Default: standard"],
  ]);
  expect(
    TILES.map((id) =>
      screen.getByTestId(`overview-tile-${id}`).getAttribute("data-tone"),
    ),
  ).toEqual(["ok", "warn", "danger", "neutral", "warn", "neutral"]);
  expect(
    TILES.map((id) =>
      screen.getByTestId(`overview-tile-${id}`).getAttribute("href"),
    ),
  ).toEqual([
    "/cluster/c1/r/core/persistentvolumeclaims",
    "/cluster/c1/r/core/persistentvolumeclaims",
    "/cluster/c1/r/core/persistentvolumeclaims",
    "/cluster/c1/r/core/persistentvolumes",
    "/cluster/c1/r/core/persistentvolumes",
    "/cluster/c1/r/storage.k8s.io/storageclasses",
  ]);
});

test("Largest claims asks the kubelets of the nodes whose Pods mount claims, and ranks the claims by used bytes", async () => {
  const f = await show(
    fake({
      volumes_usage: () =>
        usage([
          item("ingest", "kafka", "n10", 50 * GIB, 100 * GIB),
          item("shop", "logs", "n1", 870 * MIB, GIB),
          item("shop", "orders-db", "n2", 15 * GIB, 20 * GIB),
        ]),
    }),
  );
  await f.lists({
    persistentvolumeclaims: [
      claim("shop", "orders-db", "Bound", { storage: "20Gi" }),
      claim("shop", "logs", "Bound", { storage: "1Gi", storageClass: "fast" }),
      claim("ingest", "kafka", "Bound", { storage: "100Gi" }),
      claim("shop", "idle", "Bound", { storage: "5Gi" }),
    ],
    pods: [
      pod("shop", "db-0", "n2", ["orders-db"]),
      pod("ingest", "kafka-0", "n10", ["kafka"]),
      pod("shop", "web-0", "n1", ["logs"]),
      pod("shop", "api-0", "n3", []),
    ],
  });
  expect(f.backend.callsTo("volumes_usage")).toEqual([
    { id: "c1", nodes: ["n1", "n2", "n10"] },
  ]);
  expect(screen.getByRole("table", { name: "By used bytes" })).toBe(
    screen.getByTestId("storage-claims"),
  );
  expect(heads("storage-claims")).toEqual(["Claim", "Used", "Usage"]);
  expect(rowIds("storage-claims")).toEqual([
    "storage-claims-row-ingest/kafka",
    "storage-claims-row-shop/orders-db",
    "storage-claims-row-shop/logs",
  ]);
  const orders = screen.getByTestId("storage-claims-row-shop/orders-db");
  expect(orders.textContent).toContain("shop · standard");
  expect(orders.textContent).toContain("15 GiB");
  expect(
    within(orders).getByRole("img", { name: "orders-db 75%, 15 of 20 GiB" }),
  ).toBeTruthy();
  const logs = screen.getByTestId("storage-claims-row-shop/logs");
  expect(logs.textContent).toContain("shop · fast");
  expect(logs.textContent).toContain("870 MiB");
  expect(
    within(logs).getByRole("img", { name: "logs 85%, 0.8 of 1 GiB" }),
  ).toBeTruthy();
  expect(text("storage-claims-footer")).toBe(
    "Used bytes: kubelet volume stats of mounted claims",
  );
});

test("a claim reported once fills one row", async () => {
  const f = await show(
    fake({
      volumes_usage: () =>
        usage([item("shop", "shared", "n2", 4 * GIB, 10 * GIB)]),
    }),
  );
  await f.lists({
    persistentvolumeclaims: [
      claim("shop", "shared", "Bound", { storage: "10Gi" }),
    ],
    pods: [
      pod("shop", "web-0", "n1", ["shared"]),
      pod("shop", "web-1", "n2", ["shared"]),
    ],
  });
  expect(f.backend.callsTo("volumes_usage")).toEqual([
    { id: "c1", nodes: ["n1", "n2"] },
  ]);
  expect(rowIds("storage-claims")).toEqual(["storage-claims-row-shop/shared"]);
  const row = screen.getByTestId("storage-claims-row-shop/shared");
  expect(row.textContent).toContain("4 GiB");
  expect(
    within(row).getByRole("img", { name: "shared 40%, 4 of 10 GiB" }),
  ).toBeTruthy();
});

test("with nodes/proxy forbidden, Largest claims says volume usage is not shown", async () => {
  const f = await show(
    fake({
      volumes_usage: () => {
        throw {
          code: "Forbidden",
          message:
            "You have no access to nodes/proxy, so the claims' volume stats cannot be read.",
          details: "HTTP 403",
        };
      },
    }),
  );
  await f.lists({
    persistentvolumeclaims: [claim("shop", "orders-db", "Bound")],
    pods: [pod("shop", "db-0", "n1", ["orders-db"])],
  });
  expect(emptyTitle("storage-claims-empty")).toBe("Volume usage is not shown");
  expect(text("storage-claims-empty")).toContain(
    "Volume stats come from each node's kubelet through nodes/proxy, which is forbidden for your account.",
  );
  expect(screen.queryByTestId("storage-claims")).toBeNull();
  expect(screen.queryByTestId("storage-claims-footer")).toBeNull();
});

test("a volume stats error leaves Largest claims with the error", async () => {
  const f = await show(
    fake({
      volumes_usage: () => {
        throw {
          code: "Unreachable",
          message: "the API server did not answer.",
        };
      },
    }),
  );
  await f.lists({
    persistentvolumeclaims: [claim("shop", "orders-db", "Bound")],
    pods: [pod("shop", "db-0", "n1", ["orders-db"])],
  });
  expect(text("storage-claims-empty")).toContain(
    "Volume usage could not be read: the API server did not answer.",
  );
  expect(screen.queryByTestId("storage-claims")).toBeNull();
});

test("without a Pod that mounts a claim no kubelet is asked, and every claim is Bound", async () => {
  const f = await show();
  await f.lists({
    persistentvolumeclaims: [claim("shop", "orders-db", "Bound")],
    pods: [pod("shop", "api-0", "n3", [])],
  });
  expect(f.backend.callsTo("volumes_usage")).toEqual([]);
  expect(emptyTitle("storage-claims-empty")).toBe("No mounted claims");
  expect(text("storage-claims-empty")).toContain(
    "The kubelet reports the used bytes of a claim while a Pod mounts it.",
  );
  expect(text("storage-unbound-empty")).toContain("Every claim is Bound");
  expect(screen.queryByTestId("storage-unbound")).toBeNull();
});

test("Claims not Bound gives each claim its status and reason, by namespace and name", async () => {
  const f = await show();
  await f.lists({
    persistentvolumeclaims: [
      claim("shop", "data", "Bound"),
      claim("shop", "uploads", "Pending"),
      claim("shop", "later", "Pending", { storageClass: "late" }),
      claim("ingest", "old", "Bound", {
        deleting: true,
        finalizers: ["kubernetes.io/pvc-protection"],
      }),
      claim("shop", "gone", "Lost"),
    ],
    storageclasses: [
      storageClass("standard"),
      storageClass("late", {
        provisioner: "ebs.csi.aws.com",
        binding: "WaitForFirstConsumer",
      }),
    ],
  });
  expect(heads("storage-unbound")).toEqual(["Claim", "Status", "Reason"]);
  expect(rowIds("storage-unbound")).toEqual([
    "storage-unbound-row-ingest/old",
    "storage-unbound-row-shop/gone",
    "storage-unbound-row-shop/later",
    "storage-unbound-row-shop/uploads",
  ]);
  for (const [key, status, reason] of [
    [
      "ingest/old",
      "Terminating",
      "Being deleted; waiting for the finalizer kubernetes.io/pvc-protection",
    ],
    ["shop/gone", "Lost", "Its PersistentVolume pv-gone no longer exists"],
    [
      "shop/later",
      "Pending",
      "Waiting for a Pod to use it (WaitForFirstConsumer)",
    ],
    [
      "shop/uploads",
      "Pending",
      "Waiting for rancher.io/local-path to provision a volume",
    ],
  ]) {
    const row = text(`storage-unbound-row-${key}`);
    expect(row).toContain(status);
    expect(row).toContain(reason);
  }
  expect(text("overview-tile-pending-sub")).toBe("later, uploads");
});

test("Capacity by StorageClass shows each class's provisioner, expansion and requested of provisioned", async () => {
  const f = await show();
  await f.lists({
    persistentvolumeclaims: [claim("shop", "a", "Bound", { storage: "20Gi" })],
    persistentvolumes: [
      volume("pv-a", "Bound", "20Gi"),
      volume("pv-b", "Available", "20Gi"),
      volume("pv-c", "Bound", "5Gi", "fast"),
    ],
    storageclasses: [
      storageClass("standard", { isDefault: true, expansion: true }),
      storageClass("fast", { provisioner: "ebs.csi.aws.com" }),
    ],
  });
  expect(heads("storage-classes")).toEqual([
    "StorageClass",
    "Provisioner",
    "Expansion",
    "Requested of provisioned",
  ]);
  expect(rowIds("storage-classes")).toEqual([
    "storage-classes-row-fast",
    "storage-classes-row-standard",
  ]);
  const standard = screen.getByTestId("storage-classes-row-standard");
  for (const part of [
    "Default",
    "rancher.io/local-path",
    "Allowed",
    "20 / 40 GiB",
  ]) {
    expect(standard.textContent).toContain(part);
  }
  expect(
    within(standard).getByRole("img", {
      name: "standard requested 50%, 20 of 40 GiB",
    }),
  ).toBeTruthy();
  const fast = screen.getByTestId("storage-classes-row-fast");
  for (const part of ["ebs.csi.aws.com", "Not allowed", "0 / 5 GiB"]) {
    expect(fast.textContent).toContain(part);
  }
  expect(
    within(fast).getByRole("img", { name: "fast requested 0%, 0 of 5 GiB" }),
  ).toBeTruthy();
});

test("without the right to list PersistentVolumes their tiles are disabled and Capacity by StorageClass is not shown", async () => {
  const f = await show(fake(), forbidden("persistentvolumes"));
  expect(f.asked().map(([plural]) => plural)).toEqual([
    "persistentvolumeclaims",
    "pods",
    "storageclasses",
  ]);
  await f.lists({ storageclasses: [storageClass("standard")] });
  for (const id of ["available", "released"]) {
    const button = screen.getByTestId(
      `overview-tile-${id}`,
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(tile(id)).toEqual([id, "—", "You may not list PersistentVolumes"]);
  }
  expect(emptyTitle("storage-classes-empty")).toBe(
    "Capacity by StorageClass is not shown",
  );
  expect(text("storage-classes-empty")).toContain(
    "You may not list PersistentVolumes.",
  );
  expect(screen.queryByTestId("storage-classes")).toBeNull();
});

test("a cluster that does not serve StorageClasses disables their tile and Capacity by StorageClass says so", async () => {
  const f = await show(fake(), without("storageclasses"));
  await f.lists({});
  const classes = screen.getByTestId(
    "overview-tile-classes",
  ) as HTMLButtonElement;
  expect(classes.disabled).toBe(true);
  expect(tile("classes")).toEqual([
    "classes",
    "—",
    "This cluster does not serve StorageClasses",
  ]);
  expect(emptyTitle("storage-classes-empty")).toBe(
    "Capacity by StorageClass is not shown",
  );
  expect(text("storage-classes-empty")).toContain(
    "This cluster does not serve StorageClasses.",
  );
});

test("claims the account may not list leave Largest claims and Claims not Bound without rows, and no kubelet is asked", async () => {
  const f = await show(fake(), forbidden("persistentvolumeclaims"));
  await f.lists({
    persistentvolumes: [volume("pv-a", "Bound", "20Gi")],
    storageclasses: [storageClass("standard")],
    pods: [pod("shop", "db-0", "n1", ["orders-db"])],
  });
  for (const id of ["bound", "pending", "lost"]) {
    const button = screen.getByTestId(
      `overview-tile-${id}`,
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(tile(id)).toEqual([
      id,
      "—",
      "You may not list PersistentVolumeClaims",
    ]);
  }
  expect(f.backend.callsTo("volumes_usage")).toEqual([]);
  expect(emptyTitle("storage-claims-empty")).toBe("Volume usage is not shown");
  expect(text("storage-claims-empty")).toContain(
    "You may not list PersistentVolumeClaims.",
  );
  expect(emptyTitle("storage-unbound-empty")).toBe(
    "You may not list PersistentVolumeClaims",
  );
  const standard = screen.getByTestId("storage-classes-row-standard");
  expect(
    within(standard).getByRole("img", {
      name: "standard requested: no data",
    }),
  ).toBeTruthy();
  expect(standard.textContent).toContain("No data");
});

test("a row opens its claim's or class's drawer over the page, and Escape closes it", async () => {
  const f = await show(
    fake({
      volumes_usage: () =>
        usage([item("shop", "orders-db", "n1", 15 * GIB, 20 * GIB)]),
    }),
  );
  await f.lists({
    persistentvolumeclaims: [
      claim("shop", "orders-db", "Bound", { storage: "20Gi" }),
      claim("shop", "uploads", "Pending"),
    ],
    persistentvolumes: [volume("pv-orders-db", "Bound", "20Gi")],
    storageclasses: [storageClass("standard", { isDefault: true })],
    pods: [pod("shop", "db-0", "n1", ["orders-db"])],
  });

  fireEvent.click(screen.getByTestId("storage-claims-open-shop/orders-db"));
  expect(text("where")).toBe(
    "/cluster/c1/storage?open=persistentvolumeclaims&object=shop%2Forders-db",
  );
  await act(flush);
  expect(text("detail-title")).toBe("orders-db");
  expect(text("detail-kind")).toBe("PersistentVolumeClaim");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe("/cluster/c1/storage");

  fireEvent.click(screen.getByTestId("storage-unbound-open-shop/uploads"));
  expect(text("where")).toBe(
    "/cluster/c1/storage?open=persistentvolumeclaims&object=shop%2Fuploads",
  );
  await act(flush);
  expect(text("detail-title")).toBe("uploads");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);

  fireEvent.click(screen.getByTestId("storage-classes-open-standard"));
  expect(text("where")).toBe(
    "/cluster/c1/storage?open=storageclasses.storage.k8s.io&object=%2Fstandard",
  );
  await act(flush);
  expect(text("detail-title")).toBe("standard");
  expect(text("detail-kind")).toBe("StorageClass");
});
