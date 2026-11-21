import { Namespace, Scan, SlidersHorizontal, Trash2 } from "../../design/icons";
import { resourcePath } from "../../kinds/nav";
import type { KubeObject } from "../../kinds/objects";
import { percentOf } from "../../kinds/usageColumns";
import { parseQuantity } from "../metrics/format";
import type { OverviewCellValue, TileTone } from "../overview";
import type { ListView } from "../workloads/counts";
import type { DonutValue } from "./nodesModel";
import {
  byNamespaceName,
  countOf,
  formatCount,
  naturalCompare,
  objectKey,
  oneDecimal,
  someNames,
} from "./text";
import { type SectionTile, waitingTile } from "./tiles";

const GIB = 1024 ** 3;
const DASH = "—";

/** A tile's fixed parts, as `waitingTile` takes them. */
export type TileBase = Parameters<typeof waitingTile>[1];

/** A list a card cannot read, with why. */
export type UnavailableView = Extract<ListView, { state: "unavailable" }>;

/**
 * A ready list's tile. `plural` only words the waiting sub-lines (`waitingTile`), so the
 * tile leaves it out. The Network overview uses it too.
 */
export function readyTile(
  base: TileBase,
  n: number,
  sub: string,
  tone: TileTone,
): SectionTile {
  return {
    id: base.id,
    icon: base.icon,
    label: base.label,
    number: formatCount(n),
    sub,
    tone,
    to: base.to,
  };
}

/**
 * A card's empty state for a list it cannot read, worded as the tiles word it (spec §3.1):
 * the title says why, and an error adds its reason. The Network overview uses it too.
 */
export function unavailableState(
  view: UnavailableView,
  plural: string,
): { title: string; text: string } {
  if (view.cause === "forbidden") {
    return { title: `You may not list ${plural}`, text: "" };
  }
  if (view.cause === "notServed") {
    return { title: `This cluster does not serve ${plural}`, text: "" };
  }
  return { title: `Could not list ${plural}`, text: view.reason };
}

// ---- Summary (spec §3.4)

/** A Namespace's `status.phase`, or "" without one. */
export function namespacePhase(o: KubeObject): string {
  const phase = o.status?.phase;
  return typeof phase === "string" ? phase : "";
}

/** How many namespaces hold at least one of these objects. */
function holders(objects: readonly KubeObject[]): number {
  return new Set(objects.map((o) => o.metadata.namespace ?? "")).size;
}

/** With a ResourceQuota or With a LimitRange: the namespaces holding one, under the selection. */
function holdersTile(view: ListView, base: TileBase, one: string): SectionTile {
  if (view.state !== "ready") return waitingTile(view, base);
  return readyTile(
    base,
    holders(view.items),
    countOf(view.items.length, one),
    "neutral",
  );
}

/**
 * The Summary's four tiles (spec §3.4), in their order. Namespaces are cluster-scoped, so
 * their list is not filtered by the selection; quotas and limits are.
 */
export function namespaceTiles(input: {
  clusterId: string;
  namespaces: ListView;
  quotas: ListView;
  limits: ListView;
}): SectionTile[] {
  const { clusterId, namespaces } = input;
  const namespacesList = resourcePath(clusterId, "", "namespaces");
  const every: TileBase = {
    id: "namespaces",
    icon: Namespace,
    label: "Namespaces",
    plural: "Namespaces",
    to: namespacesList,
  };
  const terminating: TileBase = {
    id: "terminating",
    icon: Trash2,
    label: "Terminating",
    plural: "Namespaces",
    to: namespacesList,
  };
  const quota = holdersTile(
    input.quotas,
    {
      id: "quota",
      icon: SlidersHorizontal,
      label: "With a ResourceQuota",
      plural: "ResourceQuotas",
      to: resourcePath(clusterId, "", "resourcequotas"),
    },
    "ResourceQuota",
  );
  const limits = holdersTile(
    input.limits,
    {
      id: "limits",
      icon: Scan,
      label: "With a LimitRange",
      plural: "LimitRanges",
      to: resourcePath(clusterId, "", "limitranges"),
    },
    "LimitRange",
  );
  if (namespaces.state !== "ready") {
    return [
      waitingTile(namespaces, every),
      waitingTile(namespaces, terminating),
      quota,
      limits,
    ];
  }
  const total = namespaces.items.length;
  const going = namespaces.items
    .filter((o) => namespacePhase(o) === "Terminating")
    .map((o) => o.metadata.name)
    .sort(naturalCompare);
  const n = going.length;
  return [
    readyTile(
      every,
      total,
      `${formatCount(total - n)} Active${n > 0 ? ` · ${formatCount(n)} Terminating` : ""}`,
      "ok",
    ),
    readyTile(
      terminating,
      n,
      n > 0 ? someNames(going) : "None",
      n > 0 ? "warn" : "ok",
    ),
    quota,
    limits,
  ];
}

// ---- Quota usage (spec §3.4, §5)

interface QuotaResource {
  /** The column's head and the quota's key. */
  name: string;
  /** The key the API treats as `name`: `cpu` for `requests.cpu`. */
  short: string | null;
  unit: string;
  amount(n: number): string;
}

const QUOTA_RESOURCES: readonly QuotaResource[] = [
  { name: "requests.cpu", short: "cpu", unit: "cores", amount: oneDecimal },
  {
    name: "requests.memory",
    short: "memory",
    unit: "GiB",
    amount: (bytes) => oneDecimal(bytes / GIB),
  },
  { name: "pods", short: null, unit: "pods", amount: formatCount },
];

/** The heads of Quota usage's donut columns, in their order. */
export const QUOTA_HEADS: readonly string[] = QUOTA_RESOURCES.map(
  (r) => r.name,
);

function quantities(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * One donut of used against hard, from `status.used` and `status.hard` (`spec.hard` until
 * the quota controller has copied it). Null when the quota does not set the resource.
 */
function quotaCell(
  quota: KubeObject,
  resource: QuotaResource,
): DonutValue | null {
  const hard = {
    ...quantities(quota.spec?.hard),
    ...quantities(quota.status?.hard),
  };
  const used = quantities(quota.status?.used);
  const key = [resource.name, resource.short].find(
    (k): k is string => k !== null && hard[k] !== undefined,
  );
  if (key === undefined) return null;
  const name = `${objectKey(quota)} ${resource.name}`;
  const total = parseQuantity(hard[key]);
  const amount = parseQuantity(used[key]);
  const pct =
    total === null || amount === null
      ? null
      : percentOf({ used: amount, total });
  if (pct === null || total === null || amount === null) {
    return {
      pct: null,
      used: null,
      total: null,
      unit: resource.unit,
      label: `${name}: no data`,
    };
  }
  const usedText = resource.amount(amount);
  const totalText = resource.amount(total);
  return {
    pct,
    used: usedText,
    total: totalText,
    unit: resource.unit,
    label: `${name} ${pct}%, ${usedText} of ${totalText} ${resource.unit}`,
  };
}

/**
 * Quota usage's rows (spec §3.4): each ResourceQuota by namespace and name, with a cell for
 * `requests.cpu`, `requests.memory` and `pods`. `cpu` and `memory` count as their
 * `requests.` names, as the API treats them.
 */
export function quotaRows(
  quotas: readonly KubeObject[],
): { object: KubeObject; cells: (DonutValue | null)[] }[] {
  return [...quotas].sort(byNamespaceName).map((object) => ({
    object,
    cells: QUOTA_RESOURCES.map((r) => quotaCell(object, r)),
  }));
}

/** Quota usage without rows: why it cannot read the quotas, or that there are none. */
export function quotaEmpty(
  quotas: ListView,
  chosen: readonly string[],
): { title: string; text: string } {
  if (quotas.state === "unavailable") {
    return unavailableState(quotas, "ResourceQuotas");
  }
  return {
    title: "No ResourceQuotas",
    text:
      chosen.length > 0
        ? `No ResourceQuota in ${chosen.join(", ")}.`
        : "No namespace of this cluster has a quota.",
  };
}

/** A table cell of a donut and its caption, or a dim dash where there is none. */
export function donutCell(value: DonutValue | null): OverviewCellValue {
  if (value === null) return { text: DASH, tone: "dim" };
  const known =
    value.pct !== null && value.used !== null && value.total !== null;
  return {
    donut: {
      ...value,
      caption: known
        ? `${value.used} / ${value.total} ${value.unit}`
        : "No data",
    },
  };
}

// ---- Pods and workloads per namespace (spec §3.4)

/** A list the page reads, as `useSectionView` takes it. */
export interface CountedKind {
  /** The list's name in reasons and its column's head, as "Pods". */
  label: string;
  group: string;
  plural: string;
}

/** The columns after Namespace, in their order. Pods come first, and rows sort by them. */
export const PER_NAMESPACE_KINDS: readonly CountedKind[] = [
  { label: "Pods", group: "", plural: "pods" },
  { label: "Deployments", group: "apps", plural: "deployments" },
  { label: "StatefulSets", group: "apps", plural: "statefulsets" },
  { label: "DaemonSets", group: "apps", plural: "daemonsets" },
  { label: "Jobs", group: "batch", plural: "jobs" },
  { label: "CronJobs", group: "batch", plural: "cronjobs" },
];

function tally(objects: readonly KubeObject[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of objects) {
    const ns = o.metadata.namespace ?? "";
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  return counts;
}

/**
 * One row per namespace, the chosen ones under a selection; a chosen namespace that no
 * longer exists adds none. Each kind's count is null where its list is not ready. The first
 * kind is Pods: most Pods first, then by name.
 */
export function perNamespaceRows(
  namespaces: readonly KubeObject[],
  chosen: readonly string[],
  kinds: { plural: string; view: ListView }[],
): { object: KubeObject; counts: (number | null)[] }[] {
  const wanted = new Set(chosen);
  const tallies = kinds.map(({ view }) =>
    view.state === "ready" ? tally(view.items) : null,
  );
  return namespaces
    .filter((o) => wanted.size === 0 || wanted.has(o.metadata.name))
    .map((object) => ({
      object,
      counts: tallies.map((t) =>
        t === null ? null : (t.get(object.metadata.name) ?? 0),
      ),
    }))
    .sort(
      (a, b) =>
        (b.counts[0] ?? 0) - (a.counts[0] ?? 0) ||
        naturalCompare(a.object.metadata.name, b.object.metadata.name),
    );
}

// ---- Top namespaces (spec §3.4, as spec 1's Top consumers)

/** Why Top namespaces has no table, or null when it has one. */
export function topNamespacesEmpty(input: {
  /** No metrics source is set for the cluster. */
  metricsOff: boolean;
  /** The metrics source is still being looked up. */
  reading: boolean;
  /** The cluster does not serve metrics.k8s.io. */
  notServed: boolean;
  /** The account may not list nodes, so the cluster's allocatable is unknown. */
  nodesForbidden: boolean;
}): { title: string; text: string } | null {
  if (input.metricsOff) {
    return {
      title: "Top namespaces need metrics-server",
      text: "No metrics source is set for this cluster (metrics-server or Prometheus), so usage by namespace is unknown.",
    };
  }
  if (input.reading) {
    return {
      title: "Reading usage",
      text: "Checking where this cluster reports usage.",
    };
  }
  if (input.notServed) {
    return {
      title: "Top namespaces need metrics-server",
      text: "This cluster does not serve the metrics API (metrics.k8s.io), so usage by namespace is unknown.",
    };
  }
  if (input.nodesForbidden) {
    return {
      title: "Top namespaces are not shown",
      text: "Your account may not list nodes, so shares of the cluster cannot be summed.",
    };
  }
  return null;
}
