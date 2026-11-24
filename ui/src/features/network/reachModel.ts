import type { PolicyRef } from "../../ipc/generated/PolicyRef";
import type { ReachCell } from "../../ipc/generated/ReachCell";
import type { ReachGroup } from "../../ipc/generated/ReachGroup";
import type { ReachHttp } from "../../ipc/generated/ReachHttp";
import type { ReachMissing } from "../../ipc/generated/ReachMissing";
import type { ReachPeer } from "../../ipc/generated/ReachPeer";
import type { ReachPolicySource } from "../../ipc/generated/ReachPolicySource";
import type { ReachPort } from "../../ipc/generated/ReachPort";
import type { ReachProtocol } from "../../ipc/generated/ReachProtocol";
import type { ReachVerdict } from "../../ipc/generated/ReachVerdict";
import type { ReachSnapshot } from "../../stores/reachability";
import { listLabel } from "../map/model";
import { countOf } from "../sections/text";

/** At most this many workloads are drawn as rows and as columns (spec §3.2). */
export const MATRIX_CAP = 100;

/** The namespace the page shows when nothing else names one (R8). */
export const DEFAULT_NAMESPACE = "default";

/**
 * The namespace the page starts on (R8): `?ns=`, then the first namespace of the sidebar's
 * filter, then the last one picked on this cluster, then `default`.
 */
export function startNamespace(
  param: string | null,
  filter: readonly string[],
  stored: string | null,
): string {
  if (param !== null && param !== "") return param;
  const first = filter[0];
  if (first !== undefined) return first;
  if (stored !== null && stored !== "") return stored;
  return DEFAULT_NAMESPACE;
}

const TAGS: Record<ReachPolicySource, string> = {
  kubernetes: "K8s",
  cilium: "Cilium",
  ciliumClusterwide: "Cilium cluster",
};

/** The source tag of a policy chip (spec §3.2). */
export function policyTag(source: ReachPolicySource): string {
  return TAGS[source];
}

/** A policy as a tooltip names it: `K8s allow-dns`, `Cilium cluster allow-prometheus-scrape`. */
export function policyLine(ref: PolicyRef): string {
  return `${policyTag(ref.source)} ${ref.name}`;
}

/** A panel chip's test id (contract C12). */
export function policyTestId(ref: PolicyRef): string {
  return `reach-policy-${ref.source}-${ref.namespace}-${ref.name}`;
}

/** Where the drawer opens a policy (spec §7.5): its kind and its object key. */
export interface PolicyTarget {
  group: string;
  plural: string;
  /** `<namespace>/<name>`, or `/<name>` for a cluster-wide policy. */
  key: string;
}

const KINDS: Record<ReachPolicySource, { group: string; plural: string }> = {
  kubernetes: { group: "networking.k8s.io", plural: "networkpolicies" },
  cilium: { group: "cilium.io", plural: "ciliumnetworkpolicies" },
  ciliumClusterwide: {
    group: "cilium.io",
    plural: "ciliumclusterwidenetworkpolicies",
  },
};

export function policyTarget(ref: PolicyRef): PolicyTarget {
  return { ...KINDS[ref.source], key: `${ref.namespace}/${ref.name}` };
}

/**
 * The text of an HTTP rule (spec §6.2): `METHOD path` when both are set, else whichever is,
 * then `host …` and one `header …` each. A rule with nothing set allows any request: `HTTP`.
 */
export function httpText(rule: ReachHttp): string {
  const parts = [[rule.method, rule.path].filter((p) => p !== null).join(" ")];
  if (rule.host !== null) parts.push(`host ${rule.host}`);
  for (const header of rule.headers) parts.push(`header ${header}`);
  const text = parts.filter((p) => p !== "").join(" ");
  return text === "" ? "HTTP" : text;
}

/** The protocols written after a port, in this order; TCP comes last and only with another. */
const WRITTEN: ReachProtocol[] = ["UDP", "SCTP", "ANY"];

/** One port number, range, name or "all ports", with every protocol and HTTP rule on it. */
interface PortGroup {
  base: string;
  /** No port number and no name: every port. */
  all: boolean;
  protocols: Set<ReachProtocol>;
  http: ReachHttp[];
}

function portBase(port: ReachPort): string {
  if (port.port !== null) {
    return port.endPort !== null && port.endPort !== port.port
      ? `${port.port}-${port.endPort}`
      : String(port.port);
  }
  return port.name ?? "";
}

function groupText(group: PortGroup): string {
  const { protocols } = group;
  let text: string;
  if (group.all && (protocols.has("ANY") || !hasOther(protocols))) {
    text = "All";
  } else {
    const others = WRITTEN.filter((p) => protocols.has(p));
    if (others.length > 0 && protocols.has("TCP")) others.push("TCP");
    const base = group.all ? "All" : group.base;
    text = others.length === 0 ? base : `${base} ${others.join(", ")}`;
  }
  if (group.http.length === 1) {
    const [rule] = group.http;
    if (rule !== undefined) text += ` ${httpText(rule)}`;
  } else if (group.http.length > 1) {
    text += ` HTTP ×${group.http.length}`;
  }
  return text;
}

function hasOther(protocols: Set<ReachProtocol>): boolean {
  return WRITTEN.some((p) => protocols.has(p));
}

/**
 * The ports of a cell (spec §6.2, contract C12): each number, range or name once, in the
 * core's order, with its protocols other than TCP (`53 UDP, TCP`), joined by ", ". No port
 * is `All` (`All UDP` for UDP alone). HTTP rules add ` <rule>`, or ` HTTP ×n` for more.
 */
export function portText(ports: readonly ReachPort[]): string {
  if (ports.length === 0) return "All";
  const groups = new Map<string, PortGroup>();
  for (const port of ports) {
    const base = portBase(port);
    let group = groups.get(base);
    if (group === undefined) {
      group = { base, all: base === "", protocols: new Set(), http: [] };
      groups.set(base, group);
    }
    group.protocols.add(port.protocol);
    group.http.push(...port.http);
  }
  return [...groups.values()].map(groupText).join(", ");
}

const VERDICT_WORDS: Record<ReachVerdict, string> = {
  allowed: "Allowed",
  open: "Open",
  denied: "Denied",
  blocked: "Blocked",
};

/** What a matrix cell shows (spec §3.2). */
export interface DerivedCell {
  /** Null for an outside row × outside column, which is not part of the namespace. */
  verdict: ReachVerdict | null;
  /** Ports, "All", "Denied", "—", or "·" outside the namespace. */
  text: string;
  somePods: boolean;
  ports: ReachPort[];
  policies: PolicyRef[];
  /** The tooltip's lines: the verdict, the ports, the policies, the catch-all note. */
  tip: string[];
}

interface Index {
  cells: Map<string, ReachCell>;
  groups: Map<string, ReachGroup>;
  peers: Map<string, ReachPeer>;
}

const indexes = new WeakMap<ReachSnapshot, Index>();

function indexOf(snapshot: ReachSnapshot): Index {
  let index = indexes.get(snapshot);
  if (index === undefined) {
    index = {
      cells: new Map(snapshot.cells.map((c) => [`${c.from}\n${c.to}`, c])),
      groups: new Map(snapshot.groups.map((g) => [g.id, g])),
      peers: new Map(snapshot.peers.map((p) => [p.id, p])),
    };
    indexes.set(snapshot, index);
  }
  return index;
}

function isCatchAll(peer: ReachPeer | undefined): boolean {
  return peer?.kind === "otherPods" || peer?.kind === "world";
}

const OUTSIDE_CELL: DerivedCell = {
  verdict: null,
  text: "·",
  somePods: false,
  ports: [],
  policies: [],
  tip: [],
};

/**
 * The cell from `from` to `to` (R4): the one the core sent, else Open when the source's
 * egress and the destination's ingress are both open, else Blocked. Two outside peers make
 * no cell.
 */
export function cellOf(
  snapshot: ReachSnapshot,
  from: string,
  to: string,
): DerivedCell {
  const index = indexOf(snapshot);
  const fromGroup = index.groups.get(from);
  const toGroup = index.groups.get(to);
  const fromPeer = index.peers.get(from);
  const toPeer = index.peers.get(to);
  if (fromGroup === undefined && toGroup === undefined) return OUTSIDE_CELL;
  const sent = index.cells.get(`${from}\n${to}`);
  let verdict: ReachVerdict;
  if (sent !== undefined) {
    verdict = sent.verdict;
  } else {
    const egress = (fromGroup ?? fromPeer)?.egressIsolated ?? false;
    const ingress = (toGroup ?? toPeer)?.ingressIsolated ?? false;
    verdict = egress || ingress ? "blocked" : "open";
  }
  const ports = sent?.ports ?? [];
  const policies = sent?.policies ?? [];
  const text =
    verdict === "allowed"
      ? portText(ports)
      : verdict === "open"
        ? "All"
        : verdict === "denied"
          ? "Denied"
          : "—";
  const tip = [VERDICT_WORDS[verdict]];
  if (verdict === "allowed" || (verdict === "open" && ports.length > 0)) {
    tip.push(portText(ports));
  }
  tip.push(...policies.map(policyLine));
  if (isCatchAll(fromPeer) || isCatchAll(toPeer)) {
    tip.push("Policies of the other side apply too.");
  }
  return {
    verdict,
    text,
    somePods: sent?.somePods ?? false,
    ports,
    policies,
    tip,
  };
}

/** A row or column head of the matrix. */
export interface AxisEntry {
  id: string;
  label: string;
  /** The second line: the workload's policy count, or the peer's detail. */
  sub: string;
  /** An outside peer, drawn after the separator and never selectable. */
  outside: boolean;
}

function matches(texts: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || texts.some((t) => t.toLowerCase().includes(q));
}

/** The workloads the filter keeps: by name or label, case-insensitive (spec §3.2). */
function matchedGroups(snapshot: ReachSnapshot, query: string): ReachGroup[] {
  return snapshot.groups.filter((g) => matches([g.name, ...g.labels], query));
}

function groupEntry(group: ReachGroup): AxisEntry {
  return {
    id: group.id,
    label: group.name,
    sub:
      group.policies.length === 0
        ? "No policy"
        : countOf(group.policies.length, "policy", "policies"),
    outside: false,
  };
}

function axis(
  snapshot: ReachSnapshot,
  query: string,
  side: "source" | "destination",
): AxisEntry[] {
  const groups = matchedGroups(snapshot, query).slice(0, MATRIX_CAP);
  const peers = snapshot.peers
    .filter((p) => p[side] && matches([p.label], query))
    .slice(0, MATRIX_CAP);
  return [
    ...groups.map(groupEntry),
    ...peers.map((p) => ({
      id: p.id,
      label: p.label,
      sub: p.detail,
      outside: true,
    })),
  ];
}

/**
 * The rows (sources): the namespace's workloads in the core's order, then the outside
 * sources. The filter applies to both; at most `MATRIX_CAP` of each are kept.
 */
export function matrixRows(
  snapshot: ReachSnapshot,
  query: string,
): AxisEntry[] {
  return axis(snapshot, query, "source");
}

/** The columns (destinations), as `matrixRows` with the outside destinations. */
export function matrixColumns(
  snapshot: ReachSnapshot,
  query: string,
): AxisEntry[] {
  return axis(snapshot, query, "destination");
}

/**
 * The line under a capped matrix (spec §3.2), or null. Without a filter the workloads the
 * core left out (`truncated`) count too.
 */
export function capText(snapshot: ReachSnapshot, query: string): string | null {
  const matched = matchedGroups(snapshot, query).length;
  const total = matched + (query.trim() === "" ? snapshot.truncated : 0);
  if (total <= MATRIX_CAP) return null;
  return `Showing ${MATRIX_CAP} of ${countOf(total, "workload")}. Filter to see the rest.`;
}

/** A count chip of the bar: "K8s 6 policies" (spec §3.2). */
export interface CountChip {
  source: "kubernetes" | "cilium";
  tag: string;
  text: string;
}

/** The K8s chip, and the Cilium chip when the cluster serves a Cilium kind. */
export function countChips(snapshot: ReachSnapshot): CountChip[] {
  const chip = (source: "kubernetes" | "cilium", n: number): CountChip => ({
    source,
    tag: policyTag(source),
    text: countOf(n, "policy", "policies"),
  });
  const chips = [chip("kubernetes", snapshot.counts.kubernetes)];
  if (snapshot.cilium) chips.push(chip("cilium", snapshot.counts.cilium));
  return chips;
}

/** The warning chip and its tooltip lines, or null when every rule was evaluated. */
export function notEvaluatedChip(
  snapshot: ReachSnapshot,
): { text: string; lines: string[] } | null {
  const n = snapshot.notEvaluated.length;
  if (n === 0) return null;
  return {
    text: countOf(n, "rule not evaluated", "rules not evaluated"),
    lines: snapshot.notEvaluated.map((e) => `${e.policy.name}: ${e.field}`),
  };
}

/** The banner line of a kind that cannot be listed (R5), by its sidebar label. */
export function missingLine(missing: ReachMissing): string {
  const reason = missing.reason.replace(/\.+$/, "");
  return `${listLabel(missing.plural)} cannot be listed: ${reason}. Connections may be wrong.`;
}

/** A policy chip of the panel. */
export interface PanelChip {
  ref: PolicyRef;
  tag: string;
  name: string;
  testId: string;
}

/** One peer of the panel's "Allowed in" or "Allowed out" (spec §3.2, §5.3). */
export interface PanelEntry {
  /** The peer's id, or `any` for "Any source" / "Anywhere". */
  id: string;
  peer: string;
  detail: string | null;
  /** The ports without their HTTP rules, "All ports" or "Denied". */
  ports: string;
  tone: "allowed" | "open" | "denied";
  somePods: boolean;
  /** One line per HTTP rule, with "ingress " or "egress " when both sides limit L7. */
  http: string[];
  chips: PanelChip[];
}

/** The panel of one workload (spec §3.2). */
export interface Panel {
  id: string;
  name: string;
  /** "Deployment · 2 Pods · app=api, tier=backend". */
  header: string;
  warning: string | null;
  ins: PanelEntry[];
  outs: PanelEntry[];
  foot: string | null;
}

function chipOf(ref: PolicyRef): PanelChip {
  return {
    ref,
    tag: policyTag(ref.source),
    name: ref.name,
    testId: policyTestId(ref),
  };
}

function podsText(kind: string, pods: number): string {
  return `${kind} · ${countOf(pods, "Pod")}`;
}

function entryOf(
  snapshot: ReachSnapshot,
  peerId: string,
  cell: DerivedCell,
): PanelEntry {
  const index = indexOf(snapshot);
  const group = index.groups.get(peerId);
  const peer = index.peers.get(peerId);
  const tone =
    cell.verdict === "denied"
      ? "denied"
      : cell.verdict === "open"
        ? "open"
        : "allowed";
  const http = new Set<string>();
  for (const port of cell.ports) {
    for (const rule of port.http) {
      http.add(
        rule.side === null ? httpText(rule) : `${rule.side} ${httpText(rule)}`,
      );
    }
  }
  return {
    id: peerId,
    peer: group?.name ?? peer?.label ?? peerId,
    detail:
      group !== undefined
        ? podsText(group.kind, group.pods)
        : (peer?.detail ?? null),
    ports:
      tone === "denied"
        ? "Denied"
        : tone === "open" || cell.ports.length === 0
          ? "All ports"
          : portText(cell.ports.map((p) => ({ ...p, http: [] }))),
    tone,
    somePods: cell.somePods,
    http: [...http],
    chips: cell.policies.map(chipOf),
  };
}

function anyEntry(label: string): PanelEntry {
  return {
    id: "any",
    peer: label,
    detail: null,
    ports: "All ports",
    tone: "open",
    somePods: false,
    http: [],
    chips: [],
  };
}

/**
 * One direction of the panel. An open direction is "Any source" / "Anywhere" with its
 * Denied entries (spec §5.3); an isolated one lists every peer that is not Blocked, in the
 * matrix's order.
 */
function direction(
  snapshot: ReachSnapshot,
  group: ReachGroup,
  inward: boolean,
): PanelEntry[] {
  const peers = [
    ...snapshot.groups.map((g) => g.id),
    ...snapshot.peers
      .filter((p) => (inward ? p.source : p.destination))
      .map((p) => p.id),
  ];
  const isolated = inward ? group.ingressIsolated : group.egressIsolated;
  const entries = isolated
    ? []
    : [anyEntry(inward ? "Any source" : "Anywhere")];
  for (const id of peers) {
    const cell = inward
      ? cellOf(snapshot, id, group.id)
      : cellOf(snapshot, group.id, id);
    if (cell.verdict === null || cell.verdict === "blocked") continue;
    if (!isolated && cell.verdict !== "denied") continue;
    entries.push(entryOf(snapshot, id, cell));
  }
  return entries;
}

/** The panel of workload `groupId`; an id the snapshot does not hold gives an empty one. */
export function panelOf(snapshot: ReachSnapshot, groupId: string): Panel {
  const group = indexOf(snapshot).groups.get(groupId);
  if (group === undefined) {
    return {
      id: groupId,
      name: "",
      header: "",
      warning: null,
      ins: [],
      outs: [],
      foot: null,
    };
  }
  const header = [podsText(group.kind, group.pods)];
  if (group.labels.length > 0) header.push(group.labels.join(", "));
  const open = [
    group.ingressIsolated ? null : "in",
    group.egressIsolated ? null : "out",
  ].filter((d) => d !== null);
  const shut = [
    group.ingressIsolated ? "in" : null,
    group.egressIsolated ? "out" : null,
  ].filter((d) => d !== null);
  return {
    id: group.id,
    name: group.name,
    header: header.join(" · "),
    warning:
      open.length === 0
        ? null
        : `No policy selects the Pods of ${group.name}, so every connection ${open.join(" and ")} is allowed.`,
    ins: direction(snapshot, group, true),
    outs: direction(snapshot, group, false),
    foot:
      shut.length === 0
        ? null
        : `Every other connection ${shut.join(" and ")} is blocked.`,
  };
}
