import { useMemo } from "react";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { PODS } from "../../kinds/refs";
import { type LabelSelector, matchesSelector } from "../../kinds/selectors";
import { isPodTab, type LogsDockTab } from "../../stores/dock";
import { useWatchedObject } from "../../stores/objectWatch";
import { rowsAreTrimmed, useResourceList } from "../../stores/resources";
import { useWholeObject } from "../details/useWholeObject";

export interface ContainerChoice {
  name: string;
  /** Waiting with reason CrashLoopBackOff. */
  crashLooping: boolean;
}

export interface LogSources {
  /** The workload's Pods, by name. Empty for a Pod tab. */
  pods: string[];
  /** The containers that can be read, init containers first. */
  containers: ContainerChoice[];
  /** Whether Previous can be turned on (spec §5.6). */
  previousAllowed: boolean;
  /** Set while the one target Pod is Pending, with the `PodScheduled` message when it is False. */
  pending: { message: string | null } | null;
}

interface ContainerStatus {
  name: string;
  restartCount?: number;
  state?: { waiting?: { reason?: string } };
}

interface PodCondition {
  type: string;
  status: string;
  message?: string;
}

interface ContainerSpecs {
  initContainers?: { name: string }[];
  containers?: { name: string }[];
}

function statusesOf(pod: KubeObject): ContainerStatus[] {
  return [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
}

function namesOf(spec: ContainerSpecs | undefined): string[] {
  return [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map(
    (c) => c.name,
  );
}

/**
 * The live data behind the toolbar's choices. A Pod tab reads its Pod, and a workload
 * tab its workload, with `useWatchedObject`: from a list the store already has, or else
 * from a watch of that one object. A workload tab also lists every Pod to find the
 * workload's own by its selector. Watched Pod rows keep container names, statuses and
 * the phase, but no condition messages, so a Pending target read from a Pods list is
 * fetched whole for its `PodScheduled` message; the single-object watch's row is whole.
 */
export function useLogSources(tab: LogsDockTab): LogSources {
  const podTab = isPodTab(tab);
  const own = useWatchedObject(
    tab.clusterId,
    tab.resource,
    tab.namespace,
    tab.name,
  );
  const pods = useResourceList(tab.clusterId, podTab ? null : PODS, [
    tab.namespace,
  ]);
  const workload = podTab ? undefined : own.object;
  const selector: LabelSelector | undefined = workload?.spec?.selector;

  const members = useMemo(
    () =>
      podTab
        ? []
        : pods.items.filter(
            (p) =>
              p.metadata.namespace === tab.namespace &&
              matchesSelector(p.metadata.labels, selector),
          ),
    [podTab, pods.items, tab.namespace, selector],
  );

  const targetName = podTab
    ? tab.name
    : tab.options.pod === "all"
      ? null
      : tab.options.pod;
  const target = podTab
    ? own.object
    : targetName === null
      ? undefined
      : pods.items.find(
          (p) =>
            p.metadata.namespace === tab.namespace &&
            p.metadata.name === targetName,
        );
  // A workload tab's target is a row of the Pods list.
  const targetTrimmed = podTab ? own.trimmed : rowsAreTrimmed(PODS);
  const spec: ContainerSpecs | undefined =
    targetName === null ? workload?.spec?.template?.spec : target?.spec;
  const statuses = target ? statusesOf(target) : members.flatMap(statusesOf);
  const chosen = tab.options.container;

  const pendingRow = target?.status?.phase === "Pending" ? target : undefined;
  const whole = useWholeObject(
    tab.clusterId,
    PODS,
    pendingRow && targetTrimmed ? objectKey(pendingRow) : null,
    pendingRow,
  );
  const pendingPod = targetTrimmed ? whole.object : pendingRow;
  const conditions: PodCondition[] = pendingPod?.status?.conditions ?? [];
  const scheduled = conditions.find((c) => c.type === "PodScheduled");

  return {
    pods: members.map((p) => p.metadata.name).sort(),
    containers: namesOf(spec).map((name) => ({
      name,
      crashLooping: statuses.some(
        (s) =>
          s.name === name && s.state?.waiting?.reason === "CrashLoopBackOff",
      ),
    })),
    previousAllowed:
      target !== undefined &&
      statusesOf(target).some(
        (s) =>
          (chosen === null || s.name === chosen) && (s.restartCount ?? 0) > 0,
      ),
    pending: pendingRow
      ? {
          message:
            scheduled?.status === "False" ? (scheduled.message ?? null) : null,
        }
      : null,
  };
}
