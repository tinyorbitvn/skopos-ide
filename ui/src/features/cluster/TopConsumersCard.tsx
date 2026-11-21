import { useMemo, useState } from "react";
import { EmptyState, Segmented } from "../../design";
import { PODS } from "../../kinds/refs";
import { useMetrics } from "../../stores/metrics";
import { useListUsage } from "../metrics/useListUsage";
import { OverviewCard, type TopRow, TopTable } from "../overview";
import styles from "./OverviewCards.module.css";
import {
  type CapacityTotals,
  type TopBy,
  type TopEntry,
  topConsumers,
} from "./overviewModel";

/** Pod usage is ranked across the cluster, whatever the lists are filtered to (spec §3.5). */
const NO_NAMESPACES: string[] = [];

const BY: { value: TopBy; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
];

/** The CPU or Memory choice by cluster, for the app's run (R7). */
const choices = new Map<string, TopBy>();

export function resetTopConsumersForTest(): void {
  choices.clear();
}

/** The Top consumers card (spec §3.5): the namespaces and Pods that use the most. */
export function TopConsumersCard(props: {
  clusterId: string;
  totals: CapacityTotals;
  nodesForbidden: boolean;
  onOpen(plural: "pods" | "namespaces", key: string): void;
}) {
  const { clusterId, onOpen } = props;
  const [by, setByState] = useState<TopBy>(
    () => choices.get(clusterId) ?? "cpu",
  );
  const setBy = (next: TopBy) => {
    choices.set(clusterId, next);
    setByState(next);
  };
  const usage = useListUsage(clusterId, PODS, NO_NAMESPACES);
  const top = useMemo(() => topConsumers(usage, by), [usage, by]);

  const provider = useMetrics((s) => s.providers[clusterId]);
  const kind = provider?.value?.kind;
  const metricsOff = kind === "none";
  const reading =
    provider === undefined || (kind === undefined && provider.loading);

  const empty = metricsOff
    ? {
        title: "Top consumers need metrics-server",
        body: "No metrics source is set for this cluster (metrics-server or Prometheus), so usage by namespace and Pod is unknown.",
      }
    : reading
      ? {
          title: "Reading usage",
          body: "Checking where this cluster reports usage.",
        }
      : usage?.notServed
        ? {
            title: "Top consumers need metrics-server",
            body: "This cluster does not serve the metrics API (metrics.k8s.io), so usage by namespace and Pod is unknown.",
          }
        : props.nodesForbidden
          ? {
              title: "Top consumers are not shown",
              body: "Your account may not list nodes, so shares of the cluster cannot be summed.",
            }
          : null;

  const total = by === "cpu" ? props.totals.cores : props.totals.bytes;
  const head = by === "cpu" ? "CPU" : "Memory";
  const what = by === "cpu" ? "CPU" : "memory";
  const rows = (entries: TopEntry[], plural: "pods" | "namespaces"): TopRow[] =>
    entries.map(({ openKey, ...entry }) => ({
      ...entry,
      onOpen: () => onOpen(plural, openKey),
    }));

  return (
    <OverviewCard
      title="Top consumers"
      testId="overview-top"
      tools={
        empty ? null : (
          <Segmented
            label="Top consumers by"
            size="sm"
            value={by}
            options={BY}
            onChange={setBy}
            testId="overview-top-by"
          />
        )
      }
    >
      {empty ? (
        <div data-testid="overview-top-empty">
          <EmptyState title={empty.title} body={empty.body} />
        </div>
      ) : (
        <div className={styles.topsFrame}>
          <div className={styles.tops}>
            <TopTable
              id="overview-top-namespaces"
              title="Top namespaces"
              nameHead="Namespace"
              valueHead={head}
              total={total}
              what={what}
              rows={rows(top.namespaces, "namespaces")}
            />
            <TopTable
              id="overview-top-pods"
              title="Top pods"
              nameHead="Pod"
              valueHead={head}
              total={total}
              what={what}
              rows={rows(top.pods, "pods")}
            />
          </div>
        </div>
      )}
    </OverviewCard>
  );
}
