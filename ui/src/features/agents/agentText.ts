import type { Tone } from "../../design/Badge";
import type { AgentChanges } from "../../ipc/generated/AgentChanges";
import type { AgentState } from "../../ipc/generated/AgentState";

/** An agent's state as its Preferences row and the agent popover name it (spec §3.5). */
export function agentStateView(state: AgentState): {
  label: string;
  tone: Tone;
} {
  switch (state.state) {
    case "ready":
      return { label: "Ready", tone: "ok" };
    case "signInNeeded":
      return { label: "Sign in needed", tone: "warn" };
    case "notInstalled":
      return { label: "Not installed", tone: "danger" };
    case "doesNotStart":
      return { label: "Doesn't start", tone: "danger" };
    case "unknown":
      return { label: "Checking", tone: "neutral" };
  }
}

export const CHANGES_LABELS: Record<AgentChanges, string> = {
  ask: "Ask every time",
  readOnly: "Read only",
  dontAsk: "Don't ask",
};

/** The segmented controls' options, in the spec's order. */
export const CHANGES_OPTIONS: { value: AgentChanges; label: string }[] = [
  { value: "ask", label: CHANGES_LABELS.ask },
  { value: "readOnly", label: CHANGES_LABELS.readOnly },
  { value: "dontAsk", label: CHANGES_LABELS.dontAsk },
];

/** `1 cluster`, `3 clusters`. */
export function countText(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** When a chat was last updated, as the history shows it (spec §3.4). */
export function whenText(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (then.toDateString() === now.toDateString()) {
    return `${Math.floor(minutes / 60)} h ago`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return "Yesterday";
  const day = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === now.getFullYear()
    ? day
    : `${day}, ${then.getFullYear()}`;
}
