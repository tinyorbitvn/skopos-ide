import type { UsageTone } from "../../design/UsageDonut";
import { eventLastSeen, eventStatus } from "../../kinds/cluster/cluster";
import type { StatusInfo } from "../../kinds/columns";
import { resourcePath } from "../../kinds/nav";
import { formatAge, type KubeObject } from "../../kinds/objects";
import { percentOf } from "../../kinds/usageColumns";
import type { CapacityItem } from "../overview";
import type { OverviewCellValue, OverviewRow } from "../overview/OverviewTable";
import { FALLBACK_ICON, KIND_ICONS } from "../palette/icons";
import { byNamespaceName, formatCount } from "../sections/text";
import { type SectionTile, waitingTile } from "../sections/tiles";
import {
  type KindRow,
  type ListView,
  latestEvents,
  type WorkloadKind,
  workloadCounts,
} from "./counts";

/** At most this many rows in Workloads with problems; the lists show the rest (spec §3.2, §10). */
export const PROBLEM_LIMIT = 50;
/** How many of the newest events Recent events shows (spec §3.2). */
export const EVENT_LIMIT = 8;

/** The workload kinds in the singular, as the Kind column names them. */
const KIND_NAMES: Partial<Record<string, string>> = {
  pods: "Pod",
  deployments: "Deployment",
  daemonsets: "DaemonSet",
  statefulsets: "StatefulSet",
  replicasets: "ReplicaSet",
  jobs: "Job",
  cronjobs: "CronJob",
};

/** A workload kind's name in the singular: "Pod", "Deployment". */
export function kindName(kind: WorkloadKind): string {
  return KIND_NAMES[kind.plural] ?? kind.label;
}

/**
 * A kind's row from its list's view: counted once the list is there, else the view's state,
 * with the cause that tells the tile why (R1).
 */
export function kindRowOf(kind: WorkloadKind, view: ListView): KindRow {
  if (view.state !== "ready") return { kind, ...view };
  return { kind, state: "counted", counts: workloadCounts(kind, view.items) };
}

/** `<f> failing · <p> pending`, either alone, `All healthy`, or `None` without objects (spec §3.2). */
function kindSub(total: number, pending: number, failing: number): string {
  const parts: string[] = [];
  if (failing > 0) parts.push(`${formatCount(failing)} failing`);
  if (pending > 0) parts.push(`${formatCount(pending)} pending`);
  if (parts.length > 0) return parts.join(" · ");
  return total > 0 ? "All healthy" : "None";
}

/**
 * Workloads by kind (spec §3.2): a tile per kind, in the rows' order, that opens the kind's
 * list. A kind whose list is not there reads a dash and says why, by the list's cause (R1).
 */
export function kindTiles(rows: KindRow[], clusterId: string): SectionTile[] {
  return rows.map((row): SectionTile => {
    const { kind } = row;
    const base = {
      id: kind.plural,
      icon: KIND_ICONS[kind.plural] ?? FALLBACK_ICON,
      label: kind.label,
      plural: kind.label,
      to: resourcePath(clusterId, kind.group, kind.plural),
    };
    if (row.state !== "counted") return waitingTile(row, base);
    const { total, pending, failing } = row.counts;
    return {
      id: base.id,
      icon: base.icon,
      label: base.label,
      number: formatCount(total),
      sub: kindSub(total, pending, failing),
      tone:
        failing > 0
          ? "danger"
          : pending > 0
            ? "warn"
            : total > 0
              ? "ok"
              : "neutral",
      to: base.to,
    };
  });
}

/** A count cell, in its state's tone while above zero (spec §3.2). */
function countCell(n: number, tone?: "warn" | "bad"): OverviewCellValue {
  return tone !== undefined && n > 0
    ? { text: formatCount(n), tone }
    : { text: formatCount(n) };
}

/**
 * Health (spec §3.2): a donut of the healthy objects of every counted kind, in the worst
 * state's level, and a row per counted kind. Healthy is all minus pending minus failing, so a
 * Deployment scaled to zero is healthy. Null while no kind is counted.
 */
export function workloadHealth(
  rows: KindRow[],
): { donut: CapacityItem; rows: OverviewRow[] } | null {
  const counted = rows.flatMap((row) => (row.state === "counted" ? [row] : []));
  if (counted.length === 0) return null;
  const all = counted.reduce((sum, row) => sum + row.counts.total, 0);
  const pending = counted.reduce((sum, row) => sum + row.counts.pending, 0);
  const failing = counted.reduce((sum, row) => sum + row.counts.failing, 0);
  const healthy = all - pending - failing;
  const level: UsageTone =
    failing > 0 ? "critical" : pending > 0 ? "warning" : "nominal";
  return {
    donut: {
      key: "healthy",
      name: "Healthy",
      label: "Healthy workloads",
      pct: percentOf({ used: healthy, total: all }),
      used: formatCount(healthy),
      total: formatCount(all),
      unit: "",
      note: `${formatCount(pending)} pending · ${formatCount(failing)} failing`,
      level,
    },
    rows: counted.map(
      ({ kind, counts }): OverviewRow => ({
        key: kind.plural,
        name: kind.label,
        sub: "",
        cells: [
          countCell(counts.total - counts.pending - counts.failing),
          countCell(counts.pending, "warn"),
          countCell(counts.failing, "bad"),
        ],
      }),
    ),
  };
}

/** A workload that is failing or pending, with the Status its list shows. */
export interface ProblemWorkload {
  object: KubeObject;
  kind: WorkloadKind;
  status: StatusInfo;
  failing: boolean;
}

/**
 * Workloads with problems (spec §3.2): every failing or pending object of the listed kinds,
 * failing first, then by namespace and name; at most `limit`, with how many there are.
 */
export function problemWorkloads(
  views: { kind: WorkloadKind; view: ListView }[],
  limit = PROBLEM_LIMIT,
): { items: ProblemWorkload[]; total: number } {
  const found: ProblemWorkload[] = [];
  for (const { kind, view } of views) {
    if (view.state !== "ready") continue;
    for (const object of view.items) {
      const status = kind.status(object);
      const failing = status.tone === "danger";
      if (failing || status.tone === "warn" || status.tone === "info") {
        found.push({ object, kind, status, failing });
      }
    }
  }
  found.sort(
    (a, b) =>
      Number(b.failing) - Number(a.failing) ||
      byNamespaceName(a.object, b.object),
  );
  return { items: found.slice(0, limit), total: found.length };
}

/** The object an event is about, as the drawer opens it (R3, R5). */
export interface EventSubject {
  apiVersion: string;
  kind: string;
  /** `<namespace>/<name>`, or `/<name>` for an object without a namespace. */
  key: string;
}

/** A row of Recent events (spec §3.2). */
export interface EventRow {
  event: KubeObject;
  /** The involved object's name, else the event's own. */
  name: string;
  /** `<kind> · <reason>`, or whichever of them is set. */
  sub: string;
  /** `Warning`, else `Normal`. */
  type: string;
  message: string;
  /** As the lists show an age: `2m`. */
  age: string;
  target: EventSubject | null;
}

const asText = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * The object an event names: `involvedObject`, or `regarding` in events.k8s.io. Null unless
 * it names its apiVersion, kind and name, since only those can be resolved (R5).
 */
export function eventSubject(event: KubeObject): EventSubject | null {
  const o = event.involvedObject ?? event.regarding;
  const apiVersion = asText(o?.apiVersion);
  const kind = asText(o?.kind);
  const name = asText(o?.name);
  if (apiVersion === "" || kind === "" || name === "") return null;
  return { apiVersion, kind, key: `${asText(o?.namespace)}/${name}` };
}

/**
 * Recent events (spec §3.2): the `limit` newest events of the list, newest first, as rows.
 * Null until the Events list is there.
 */
export function recentEventRows(
  events: ListView,
  nowMs: number,
  limit = EVENT_LIMIT,
): EventRow[] | null {
  if (events.state !== "ready") return null;
  return latestEvents(events.items, limit).map((event): EventRow => {
    const o = event.involvedObject ?? event.regarding;
    const name = asText(o?.name);
    return {
      event,
      name: name === "" ? event.metadata.name : name,
      sub: [asText(o?.kind), asText(event.reason)]
        .filter((part) => part !== "")
        .join(" · "),
      type: eventStatus(event).label === "Warning" ? "Warning" : "Normal",
      message: asText(event.message) || asText(event.note),
      age: formatAge(eventLastSeen(event), nowMs),
      target: eventSubject(event),
    };
  });
}
