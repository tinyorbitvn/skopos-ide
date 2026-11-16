import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../objects";

/** The kinds whose Status comes from their Pods (spec N1). */
export type WorkloadKind =
  | "deployments"
  | "statefulsets"
  | "replicasets"
  | "daemonsets"
  | "jobs"
  | "cronjobs";

const APPS_KINDS: ReadonlySet<string> = new Set([
  "deployments",
  "statefulsets",
  "replicasets",
  "daemonsets",
]);
const BATCH_KINDS: ReadonlySet<string> = new Set(["jobs", "cronjobs"]);

/** The workload kind of a list, by group and plural; null for every other list. */
export function workloadKind(
  info: ApiResourceInfo | undefined,
): WorkloadKind | null {
  if (!info) return null;
  const { group, plural } = info.resource;
  if (group === "apps" && APPS_KINDS.has(plural)) return plural as WorkloadKind;
  if (group === "batch" && BATCH_KINDS.has(plural))
    return plural as WorkloadKind;
  return null;
}

export interface OwnedPods {
  /** The workload's Pods; undefined when this index cannot answer for it. */
  podsOf(workload: KubeObject): KubeObject[] | undefined;
}

/** The uid of an object's controller: its first owner reference marked `controller`. */
export function controllerUid(o: KubeObject): string | undefined {
  return o.metadata.ownerReferences?.find((r) => r.controller === true)?.uid;
}

function byController(objects: KubeObject[]): Map<string, KubeObject[]> {
  const groups = new Map<string, KubeObject[]>();
  for (const o of objects) {
    const uid = controllerUid(o);
    if (!uid) continue;
    const group = groups.get(uid);
    if (group) group.push(o);
    else groups.set(uid, [o]);
  }
  return groups;
}

/**
 * Indexes Pods by the workload that controls them (spec N2). A Deployment reaches its
 * Pods through its ReplicaSets and a CronJob through its Jobs, so those need `links`.
 */
export function indexOwnedPods(
  kind: WorkloadKind,
  pods: KubeObject[],
  links: { replicaSets?: KubeObject[]; jobs?: KubeObject[] },
): OwnedPods {
  const podsByOwner = byController(pods);
  const middle =
    kind === "deployments"
      ? links.replicaSets
      : kind === "cronjobs"
        ? links.jobs
        : null;
  const middleByOwner = middle ? byController(middle) : null;
  const podsOfUid = (uid: string | undefined) =>
    uid ? (podsByOwner.get(uid) ?? []) : [];
  return {
    podsOf(workload) {
      const uid = workload.metadata.uid;
      // A list that needs links it was not given, or a row without a uid, cannot answer.
      if (!uid || middle === undefined) return undefined;
      if (middleByOwner === null) return podsOfUid(uid);
      return (middleByOwner.get(uid) ?? []).flatMap((m) =>
        podsOfUid(m.metadata.uid),
      );
    },
  };
}
