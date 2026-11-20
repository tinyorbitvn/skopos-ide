import type { Tone } from "../../design/Badge";
import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

export interface NodeCondition {
  type: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** A condition that is happening, or SchedulingDisabled (`condition: null`). */
export interface ActiveCondition {
  type: string;
  tone: Tone;
  condition: NodeCondition | null;
}

export interface NodeConditions {
  /** Ready, NotReady or Unknown, from the Ready condition. */
  ready: StatusInfo;
  /** What is happening, worst first. */
  active: ActiveCondition[];
  /** Every condition, in the API's order. */
  conditions: NodeCondition[];
}

export const SCHEDULING_DISABLED = "SchedulingDisabled";

const PRESSURES: ReadonlySet<string> = new Set([
  "MemoryPressure",
  "DiskPressure",
  "PIDPressure",
]);

const TONE_ORDER: Record<Tone, number> = {
  danger: 0,
  warn: 1,
  info: 2,
  neutral: 3,
  ok: 4,
};

export function conditionTone(type: string): Tone {
  if (type === "NetworkUnavailable") return "danger";
  if (PRESSURES.has(type)) return "warn";
  return "neutral";
}

function readyOf(condition: NodeCondition | undefined): StatusInfo {
  if (condition?.status === "True") return { label: "Ready", tone: "ok" };
  if (condition?.status === "False")
    return { label: "NotReady", tone: "danger" };
  return { label: "Unknown", tone: "neutral" };
}

/** A Node's readiness and the conditions that are happening on it. */
export function nodeConditions(node: KubeObject): NodeConditions {
  const listed: unknown[] = Array.isArray(node.status?.conditions)
    ? node.status.conditions
    : [];
  const conditions = listed.filter(
    (c): c is NodeCondition =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as NodeCondition).type === "string",
  );
  const active: ActiveCondition[] = conditions
    .filter((c) => c.type !== "Ready" && c.status === "True")
    .map((c) => ({ type: c.type, tone: conditionTone(c.type), condition: c }));
  if (node.spec?.unschedulable === true) {
    active.push({ type: SCHEDULING_DISABLED, tone: "warn", condition: null });
  }
  // Array.prototype.sort is stable: within a tone the API's order stays,
  // and SchedulingDisabled, pushed last, sorts after the other warnings.
  active.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  return {
    ready: readyOf(conditions.find((c) => c.type === "Ready")),
    active,
    conditions,
  };
}
