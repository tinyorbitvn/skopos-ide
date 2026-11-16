import type { Tone } from "../../design/Badge";
import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";
import { podStatus } from "./pod";

/** Pods of a workload that share one status label (spec N5). */
export interface PodState {
  label: string;
  tone: Tone;
  pods: KubeObject[];
}

const TONE_RANK: Record<Tone, number> = {
  danger: 4,
  warn: 3,
  info: 2,
  neutral: 1,
  ok: 0,
};

/** States left over from Pods that no longer run; a live problem of the same tone goes first. */
const LEFTOVER: ReadonlySet<string> = new Set(["Evicted"]);

/** The workload's Pods grouped by their status, worst first. */
export function podStates(pods: KubeObject[]): PodState[] {
  const byLabel = new Map<string, PodState>();
  for (const pod of pods) {
    const { label, tone } = podStatus(pod);
    const state = byLabel.get(label);
    if (state) state.pods.push(pod);
    else byLabel.set(label, { label, tone, pods: [pod] });
  }
  const score = (s: PodState) =>
    TONE_RANK[s.tone] * 2 + (LEFTOVER.has(s.label) ? 0 : 1);
  return [...byLabel.values()].sort(
    (a, b) =>
      score(b) - score(a) ||
      b.pods.length - a.pods.length ||
      a.label.localeCompare(b.label),
  );
}

/** A workload's own states that win over its Pods' (spec N6, step 1). */
export const LIFECYCLE: ReadonlySet<string> = new Set([
  "Terminating",
  "ScaledDown",
  "Paused",
  "Complete",
  "Failed",
  "Suspended",
]);

export interface WorkloadStatus {
  /** What the cell's badge shows. */
  badge: StatusInfo;
  /** How many Pods are in the badge's state, when the badge is a Pod state. */
  count?: number;
  /** How many other problem states there are, shown as `+N`. */
  more: number;
  /** Every state of the workload's Pods, worst first. */
  states: PodState[];
  /** The card's last line, when the workload's own state needs saying. */
  note?: string;
}

/**
 * A workload's Status from its own status (`own`, what the kind showed before) and its
 * Pods (spec N6). `kindName` is the singular kind, such as "Deployment".
 */
export function workloadStatus(
  own: StatusInfo,
  workload: KubeObject,
  pods: KubeObject[],
  kindName: string,
): WorkloadStatus {
  const states = podStates(pods);
  const deleting = Boolean(workload.metadata.deletionTimestamp);
  const problems = states.filter(
    (s) => s.tone !== "ok" && !(deleting && s.label === "Terminating"),
  );
  if (LIFECYCLE.has(own.label)) {
    return {
      badge: own,
      more: own.label === "Complete" ? 0 : problems.length,
      states,
      note: `The ${kindName} is ${own.label}.`,
    };
  }
  const [worst, ...others] = problems;
  if (worst) {
    const reported = own.tone === "danger";
    return {
      badge: { label: worst.label, tone: worst.tone },
      count: worst.pods.length,
      more: others.length + (reported ? 1 : 0),
      states,
      ...(reported
        ? { note: `The ${kindName} also reports ${own.label}.` }
        : {}),
    };
  }
  return { badge: own, more: 0, states };
}
