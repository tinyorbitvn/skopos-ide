import { useMemo } from "react";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { JOBS, PODS, REPLICASETS } from "../../kinds/refs";
import {
  indexOwnedPods,
  type OwnedPods,
  workloadKind,
} from "../../kinds/workloads/ownedPods";
import {
  type ResourceListState,
  useResourceList,
} from "../../stores/resources";

/** Whether a needed list can answer: loaded, served and allowed (spec N3). */
function answers(list: ResourceListState): boolean {
  return (
    !list.loading && list.status !== "notServed" && list.status !== "forbidden"
  );
}

/**
 * The Pods of each workload in a list of `info`'s kind, from the shared watches of Pods and,
 * for Deployments and CronJobs, of ReplicaSets or Jobs (spec N3). Undefined for any other
 * kind, and while a needed list is loading, not served or forbidden. The lists cover only
 * `namespaces`; an empty array means every namespace.
 */
export function useOwnedPods(
  clusterId: string,
  info: ApiResourceInfo | undefined,
  namespaces: readonly string[],
): OwnedPods | undefined {
  const kind = workloadKind(info);
  const pods = useResourceList(clusterId, kind ? PODS : null, namespaces);
  const replicaSets = useResourceList(
    clusterId,
    kind === "deployments" ? REPLICASETS : null,
    namespaces,
  );
  const jobs = useResourceList(
    clusterId,
    kind === "cronjobs" ? JOBS : null,
    namespaces,
  );
  const ready =
    kind !== null &&
    answers(pods) &&
    (kind !== "deployments" || answers(replicaSets)) &&
    (kind !== "cronjobs" || answers(jobs));
  const podItems = pods.items;
  const replicaSetItems = replicaSets.items;
  const jobItems = jobs.items;
  return useMemo(() => {
    if (!ready || kind === null) return undefined;
    return indexOwnedPods(kind, podItems, {
      ...(kind === "deployments" ? { replicaSets: replicaSetItems } : {}),
      ...(kind === "cronjobs" ? { jobs: jobItems } : {}),
    });
  }, [ready, kind, podItems, replicaSetItems, jobItems]);
}
