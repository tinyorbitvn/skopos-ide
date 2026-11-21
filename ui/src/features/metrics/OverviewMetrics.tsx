import { useMemo } from "react";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import { OverviewCard } from "../overview";
import { NO_FACTS, type TargetFacts } from "./charts";
import { MetricsPanel, type UsageSource } from "./MetricsPanel";

const CLUSTER: MetricsTarget = { kind: "cluster" };
const NODE_USAGE: UsageSource = { of: "nodes", namespace: null, keys: null };

/** The cluster's allocatable, as the Capacity card sums it from the topology (R19). */
export interface Allocatable {
  cores: number | null;
  bytes: number | null;
}

/**
 * The Overview's Metrics card (spec §3.6): the panel with the cluster's charts and, under
 * Prometheus or a Prometheus-compatible URL, the control plane's.
 */
export function OverviewMetrics(props: {
  clusterId: string;
  clusterName: string;
  info: ClusterInfo;
  allocatable: Allocatable;
}) {
  const { info, allocatable } = props;
  const facts = useMemo<TargetFacts>(
    () => ({
      ...NO_FACTS,
      nodeCount: info.nodeCount,
      allocatableCores: allocatable.cores,
      allocatableBytes: allocatable.bytes,
    }),
    [info.nodeCount, allocatable.cores, allocatable.bytes],
  );
  const controlPlane = useMemo(
    () => ({ distribution: info.distribution }),
    [info.distribution],
  );
  return (
    <OverviewCard title="Metrics" testId="overview-metrics">
      <MetricsPanel
        clusterId={props.clusterId}
        clusterName={props.clusterName}
        target={CLUSTER}
        facts={facts}
        usage={NODE_USAGE}
        layout="grid"
        controlPlane={controlPlane}
      />
    </OverviewCard>
  );
}
