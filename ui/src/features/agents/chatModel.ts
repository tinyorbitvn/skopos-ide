import type { AgentStatus } from "../../ipc/generated/AgentStatus";
import type { ChatItem } from "../../ipc/generated/ChatItem";
import type { ChatScope } from "../../ipc/generated/ChatScope";
import type { ClusterAgentSettings } from "../../ipc/generated/ClusterAgentSettings";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import type { ObjectRef } from "../../ipc/generated/ObjectRef";
import type { KubeObject } from "../../kinds/objects";
import { countText } from "./agentText";

/** Why the panel shows a state instead of a chat (spec §3.3, P5). */
export type StartFailure =
  | { kind: "noClusters" }
  | { kind: "noAgent" }
  | { kind: "sandbox"; reason: string }
  | { kind: "signIn"; agentId: string; agent: string; hint: string | null }
  | { kind: "notInstalled"; agentId: string; agent: string }
  | { kind: "doesNotStart"; agentId: string; agent: string; reason: string }
  | { kind: "other"; message: string };

/** The core's messages that `chat_start` rejects with (`agents/chat.rs`). */
export const SANDBOX_NOT_READY = "The agent sandbox isn't ready.";
export const NO_AGENT = "No agent is ready to chat.";
export const CANNOT_REOPEN_SUFFIX =
  "can't reopen old chats. Start a new chat to continue.";

/**
 * The scope of the next new chat (P6): the scope does not follow the page, but a new
 * per-cluster chat takes the page's cluster. Null when the catalog has no cluster.
 */
export function nextScope(
  current: ChatScope | null,
  page: string | null,
  ids: string[],
): ChatScope | null {
  if (ids.length === 0) return null;
  const pageId = page !== null && ids.includes(page) ? page : null;
  if (current === null) {
    return pageId !== null
      ? { clusters: [pageId], global: false }
      : { clusters: ids, global: true };
  }
  if (current.global) {
    const kept = current.clusters.filter((id) => ids.includes(id));
    return { clusters: kept.length > 0 ? kept : ids, global: true };
  }
  if (pageId !== null) return { clusters: [pageId], global: false };
  const own = current.clusters[0];
  if (own !== undefined && ids.includes(own))
    return { clusters: [own], global: false };
  return { clusters: ids, global: true };
}

/**
 * The scope's clusters by the name the chat gives them, as the core's `scope_names` does:
 * in scope order, a repeated name gets ` (2)`, ` (3)`.
 */
export function clusterIdsByName(
  scope: ChatScope,
  clusters: ClusterEntry[],
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const id of scope.clusters) {
    const name = clusters.find((c) => c.id === id)?.name;
    if (name === undefined) continue;
    let shown = name;
    let number = 2;
    while (byName.has(shown)) {
      shown = `${name} (${number})`;
      number += 1;
    }
    byName.set(shown, id);
  }
  return byName;
}

function clusterName(id: string | undefined, clusters: ClusterEntry[]): string {
  return clusters.find((c) => c.id === id)?.name ?? "Cluster";
}

/** The scope button's label (spec §3.2). */
export function scopeLabel(scope: ChatScope, clusters: ClusterEntry[]): string {
  if (!scope.global) return clusterName(scope.clusters[0], clusters);
  const all =
    clusters.length > 0 && clusters.every((c) => scope.clusters.includes(c.id));
  return all
    ? "All clusters"
    : countText(scope.clusters.length, "cluster", "clusters");
}

/** The composer's scope chip (spec §3.2). */
export function scopeChip(
  scope: ChatScope,
  clusters: ClusterEntry[],
  settings: ClusterAgentSettings | null,
): string {
  if (scope.global)
    return countText(scope.clusters.length, "cluster", "clusters");
  const name = clusterName(scope.clusters[0], clusters);
  const limit = settings?.namespaces;
  return limit
    ? `${name} · ${countText(limit.length, "namespace", "namespaces")}`
    : name;
}

/** Puts an item in place: the core sends an item again, whole, under the same id. */
export function withItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const at = items.findIndex((i) => i.id === item.id);
  if (at === -1) return [...items, item];
  const next = items.slice();
  next[at] = item;
  return next;
}

/** The change cards that wait for the person. */
export function waitingCount(items: ChatItem[]): number {
  return items.filter(
    (i) => i.body.type === "change" && i.body.card.state.state === "waiting",
  ).length;
}

/** `Pod payments/api-7d9f8c6b5-x2kqp`, `Node node-1`. */
export function objectLabel(object: ObjectRef): string {
  return object.namespace
    ? `${object.kind} ${object.namespace}/${object.name}`
    : `${object.kind} ${object.name}`;
}

/** A start failure from the state of the agent the start used (P5). */
export function failureFromRow(
  row: AgentStatus | undefined,
  message: string,
): StartFailure {
  if (row === undefined) return { kind: "other", message };
  const named = { agentId: row.id, agent: row.name };
  switch (row.state.state) {
    case "signInNeeded":
      return { kind: "signIn", ...named, hint: row.hint };
    case "notInstalled":
      return { kind: "notInstalled", ...named };
    case "doesNotStart":
      return { kind: "doesNotStart", ...named, reason: row.state.reason };
    default:
      return { kind: "other", message };
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * How far a workload's rollout got (P10). `settled` needs every count at the desired one
 * and, when the object carries them, the new generation observed and every Pod updated.
 */
export function rolloutProgress(
  kind: string,
  object: KubeObject,
): { desired: number; ready: number; settled: boolean } {
  const status = (object.status ?? {}) as Record<string, unknown>;
  const spec = (object.spec ?? {}) as Record<string, unknown>;
  const daemon = kind === "DaemonSet";
  const desired = daemon
    ? (num(status.desiredNumberScheduled) ?? 0)
    : (num(spec.replicas) ?? 1);
  const current = daemon
    ? num(status.desiredNumberScheduled)
    : num(status.replicas);
  const ready =
    (daemon ? num(status.numberReady) : num(status.readyReplicas)) ?? 0;
  const available =
    (daemon ? num(status.numberAvailable) : num(status.availableReplicas)) ?? 0;
  const updated = daemon
    ? num(status.updatedNumberScheduled)
    : num(status.updatedReplicas);
  const generation = num(
    (object.metadata as Record<string, unknown> | undefined)?.generation,
  );
  const observed = num(status.observedGeneration);
  const settled =
    (current ?? 0) === desired &&
    ready === desired &&
    available === desired &&
    // omitempty: a zero count is left out of status. Once the controller has written
    // the status (observedGeneration is there), a missing count reads as 0, as in
    // kubectl rollout status. A trimmed row without it keeps only the counts.
    (updated === undefined
      ? observed === undefined || desired === 0
      : updated === desired) &&
    (generation === undefined ||
      observed === undefined ||
      observed >= generation);
  return { desired, ready, settled };
}
