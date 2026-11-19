import type { TableColumn } from "../design/VirtualTable";
import {
  columnCpu,
  columnMemory,
  DASH,
  formatBytes,
  formatCores,
  parseQuantity,
} from "../features/metrics/format";
import type { UsageItem } from "../ipc/generated/UsageItem";
import type { KubeObject } from "./objects";
import styles from "./usageColumns.module.css";

export interface UsageView {
  /** Latest usage by row key (`namespace/name` for Pods, the name for nodes); null when there is none to show. */
  items: Map<string, UsageItem> | null;
  /** The cluster does not serve metrics.k8s.io: cells read "—" with a tooltip. */
  notServed: boolean;
}

export const NOT_SERVED_TIP = "metrics.k8s.io is not served";

function usageColumn(
  id: "cpu" | "memory",
  header: string,
  usage: UsageView | undefined,
  keyOf: (row: KubeObject) => string,
  read: (item: UsageItem) => number,
  format: (value: number) => string,
): TableColumn<KubeObject> {
  const value = (row: KubeObject): number | null => {
    if (!usage || usage.notServed) return null;
    const item = usage.items?.get(keyOf(row));
    if (!item) return null;
    const n = read(item);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    id,
    header,
    width: 88,
    sortValue: value,
    render: (row) => {
      const n = value(row);
      return (
        <span
          data-testid={`usage-${id}`}
          title={usage?.notServed ? NOT_SERVED_TIP : undefined}
        >
          {n === null ? DASH : format(n)}
        </span>
      );
    },
  };
}

/**
 * CPU and Memory in the `kubectl top` style (spec §11). A cell reads "—" with no
 * sample, with no provider, or when metrics.k8s.io is not served, and sorts last.
 */
export function usageColumns(
  usage: UsageView | undefined,
  keyOf: (row: KubeObject) => string,
): TableColumn<KubeObject>[] {
  return [
    usageColumn("cpu", "CPU", usage, keyOf, (i) => i.cpuCores, columnCpu),
    usageColumn(
      "memory",
      "Memory",
      usage,
      keyOf,
      (i) => i.memoryBytes,
      columnMemory,
    ),
  ];
}

/** How much of a node a resource uses: `used` out of `total`, which is null when unknown. */
export interface UsageShare {
  used: number;
  total: number | null;
}

/** At this share a bar turns to the warning colour, and at the next to the critical one. */
const WARN_AT = 80;
const CRITICAL_AT = 95;

function level(percent: number): "ok" | "warn" | "critical" {
  if (percent >= CRITICAL_AT) return "critical";
  if (percent >= WARN_AT) return "warn";
  return "ok";
}

function percentOf(share: UsageShare | null): number | null {
  if (share === null || share.total === null || !(share.total > 0)) {
    return null;
  }
  return Math.round((share.used / share.total) * 100);
}

/**
 * A node's use of one resource as a bar of what the node can give, with the share beside
 * it; the cell's title has both amounts. Without the node's total it reads the amount
 * alone, and without a sample "—". Rows sort by the share.
 */
export function shareColumn(
  id: "cpu" | "memory" | "disk",
  header: string,
  get: (row: KubeObject) => UsageShare | null,
  format: (value: number) => string,
  tip?: string,
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: 150,
    sortValue: (row) => {
      const share = get(row);
      return percentOf(share) ?? share?.used ?? null;
    },
    render: (row) => {
      const share = get(row);
      const percent = percentOf(share);
      if (share === null || percent === null) {
        return (
          <span data-testid={`usage-${id}`} title={tip}>
            {share === null ? DASH : format(share.used)}
          </span>
        );
      }
      return (
        <span
          className={styles.share}
          data-testid={`usage-${id}`}
          title={`${format(share.used)} of ${format(share.total ?? 0)}`}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: WebKit draws <meter> its own way; this bar uses the design tokens. */}
          <span
            role="meter"
            aria-label={`${header} used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, percent)}
            className={styles.track}
            data-level={level(percent)}
          >
            <span
              className={styles.fill}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </span>
          <span className={styles.percent}>{`${percent}%`}</span>
        </span>
      );
    },
  };
}

/** What a node can give: its allocatable CPU in cores or memory in bytes. */
export function allocatable(
  row: KubeObject,
  resource: "cpu" | "memory",
): number | null {
  return parseQuantity(row.status?.allocatable?.[resource]);
}

/**
 * The Nodes list's CPU and Memory: what metrics-server measured against what each node
 * can give (its allocatable), drawn as bars.
 */
export function nodeUsageColumns(
  usage: UsageView | undefined,
): TableColumn<KubeObject>[] {
  const share =
    (read: (item: UsageItem) => number, resource: "cpu" | "memory") =>
    (row: KubeObject): UsageShare | null => {
      if (!usage || usage.notServed) return null;
      const item = usage.items?.get(row.metadata.name);
      if (!item) return null;
      const used = read(item);
      if (!Number.isFinite(used) || used < 0) return null;
      return { used, total: allocatable(row, resource) };
    };
  const tip = usage?.notServed ? NOT_SERVED_TIP : undefined;
  return [
    shareColumn(
      "cpu",
      "CPU",
      share((i) => i.cpuCores, "cpu"),
      formatCores,
      tip,
    ),
    shareColumn(
      "memory",
      "Memory",
      share((i) => i.memoryBytes, "memory"),
      formatBytes,
      tip,
    ),
  ];
}
