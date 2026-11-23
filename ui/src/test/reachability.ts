import { act } from "@testing-library/react";
import type { PolicyRef } from "../ipc/generated/PolicyRef";
import type { ReachCell } from "../ipc/generated/ReachCell";
import type { ReachEvent } from "../ipc/generated/ReachEvent";
import type { ReachGroup } from "../ipc/generated/ReachGroup";
import type { ReachHttp } from "../ipc/generated/ReachHttp";
import type { ReachPeer } from "../ipc/generated/ReachPeer";
import type { ReachPolicySource } from "../ipc/generated/ReachPolicySource";
import type { ReachPort } from "../ipc/generated/ReachPort";
import type { ReachProtocol } from "../ipc/generated/ReachProtocol";
import type { ReachVerdict } from "../ipc/generated/ReachVerdict";
import type { ReachSnapshot } from "../stores/reachability";
import { type Backend, flush, mockBackend } from "./ipc";

export interface ReachabilityBackend {
  backend: Backend;
  /** The subscription ids still open, oldest first. */
  open(): string[];
  /**
   * Sends an event and lets it render. With an id it goes to that subscription, even one
   * already ended, as an event still in flight would. Without one, a snapshot goes to every
   * open subscription of its namespace and a failure to every open one. A failure ends the
   * subscriptions it is sent on, as the backend does.
   */
  send(event: ReachEvent, subscriptionId?: string): Promise<void>;
  /** From now on a subscribe gets its channel at once and its id only on `answer()`. */
  hold(): void;
  /** Answers the oldest held subscribe and lets it settle. */
  answer(): Promise<void>;
}

/**
 * A backend whose reachability subscriptions answer `r1`, `r2`… and keep their channels and
 * namespaces, so a test can send snapshots and failures. `extra` adds other handlers.
 */
export function reachabilityBackend(
  extra: Parameters<typeof mockBackend>[0] = {},
): ReachabilityBackend {
  const channels = new Map<string, (event: ReachEvent) => void>();
  const namespaces = new Map<string, string>();
  const open = new Set<string>();
  const held: (() => void)[] = [];
  let holding = false;
  let seq = 0;
  const backend = mockBackend({
    network_reachability_subscribe: (a: {
      namespace: string;
      onEvent: { onmessage: (event: ReachEvent) => void };
    }) => {
      seq += 1;
      const id = `r${seq}`;
      channels.set(id, a.onEvent.onmessage);
      namespaces.set(id, a.namespace);
      open.add(id);
      if (!holding) return id;
      return new Promise<string>((resolve) => held.push(() => resolve(id)));
    },
    network_reachability_unsubscribe: (a: { subscriptionId: string }) => {
      open.delete(a.subscriptionId);
      return null;
    },
    ...extra,
  });
  return {
    backend,
    open: () => [...open],
    send: async (event, subscriptionId) => {
      await act(async () => {
        const ids =
          subscriptionId === undefined
            ? [...open].filter(
                (id) =>
                  event.type === "failure" ||
                  namespaces.get(id) === event.namespace,
              )
            : [subscriptionId];
        for (const id of ids) {
          channels.get(id)?.(event);
          if (event.type === "failure") open.delete(id);
        }
        await flush();
      });
    },
    hold: () => {
      holding = true;
    },
    answer: async () => {
      await act(async () => {
        held.shift()?.();
        await flush();
      });
    },
  };
}

/** A policy of the sample namespace; a cluster-wide one has no namespace. */
export function rref(
  source: ReachPolicySource,
  name: string,
  namespace = source === "ciliumClusterwide" ? "" : "payments",
): PolicyRef {
  return { source, namespace, name };
}

export function rport(
  port: number | null,
  protocol: ReachProtocol = "TCP",
  over: Partial<ReachPort> = {},
): ReachPort {
  return { protocol, port, endPort: null, name: null, http: [], ...over };
}

export function rhttp(over: Partial<ReachHttp> = {}): ReachHttp {
  return {
    side: null,
    method: null,
    path: null,
    host: null,
    headers: [],
    ...over,
  };
}

export function rcell(
  from: string,
  to: string,
  verdict: ReachVerdict,
  ports: ReachPort[],
  policies: PolicyRef[],
  somePods = false,
): ReachCell {
  return { from, to, verdict, ports, policies, somePods };
}

/** A workload of `namespace`, isolated both ways when it has policies. */
export function rgroup(
  kind: string,
  namespace: string,
  name: string,
  over: Partial<ReachGroup> = {},
): ReachGroup {
  const policies = over.policies ?? [];
  return {
    id: `${kind}/${namespace}/${name}`,
    kind,
    name,
    pods: 1,
    labels: [`app=${name}`],
    policies,
    ingressIsolated: policies.length > 0,
    egressIsolated: policies.length > 0,
    ...over,
  };
}

/** The two catch-all peers, last in every snapshot (contract C9). */
export const OTHER_PODS: ReachPeer = {
  id: "otherPods",
  kind: "otherPods",
  namespace: null,
  label: "Other Pods in the cluster",
  detail: "Pods the rules above do not name",
  source: true,
  destination: true,
  ingressIsolated: false,
  egressIsolated: false,
};
export const WORLD: ReachPeer = {
  id: "world",
  kind: "world",
  namespace: null,
  label: "Outside the cluster",
  detail: "Addresses the rules above do not name",
  source: true,
  destination: true,
  ingressIsolated: false,
  egressIsolated: false,
};

/** A snapshot of `namespace` with these groups, the catch-alls and nothing else. */
export function rsnapshot(
  namespace: string,
  groups: ReachGroup[] = [],
  over: Partial<ReachSnapshot> = {},
): ReachSnapshot {
  return {
    type: "snapshot",
    namespace,
    groups,
    peers: groups.length === 0 ? [] : [OTHER_PODS, WORLD],
    cells: [],
    counts: { kubernetes: 0, cilium: 0 },
    notEvaluated: [],
    missing: [],
    cilium: false,
    truncated: 0,
    ...over,
  };
}

/** The ids of the sample namespace's workloads and peers (contract C13). */
export const IDS = {
  api: "Deployment/payments/api",
  db: "StatefulSet/payments/db",
  web: "Deployment/payments/web",
  worker: "Deployment/payments/worker",
  ingress: "Deployment/ingress-nginx/ingress-nginx-controller",
  prometheus: "Deployment/monitoring/prometheus",
  coredns: "Deployment/kube-system/coredns",
  stripe: "fqdn:api.stripe.com",
  otherPods: "otherPods",
  world: "world",
} as const;

/**
 * The canvas board's namespace `payments` (contract C13) as the core sends it: its four
 * workloads, its outside peers, the twelve cells the core sends and nothing the UI derives (R4).
 */
export function paymentsSnapshot(): ReachSnapshot {
  const k8s = (name: string) => rref("kubernetes", name);
  const cilium = (name: string) => rref("cilium", name);
  const scrape = rref("ciliumClusterwide", "allow-prometheus-scrape");
  const dns = [rport(53, "TCP"), rport(53, "UDP")];
  const outside = (
    id: string,
    namespace: string,
    detail: string,
    source: boolean,
  ): ReachPeer => ({
    id,
    kind: "workload",
    namespace,
    label: id.slice(id.indexOf("/") + 1),
    detail,
    source,
    destination: !source,
    ingressIsolated: false,
    egressIsolated: false,
  });
  return {
    type: "snapshot",
    namespace: "payments",
    groups: [
      rgroup("Deployment", "payments", "api", {
        pods: 2,
        labels: ["app=api", "tier=backend"],
        policies: [
          k8s("allow-api-to-db"),
          k8s("allow-dns"),
          k8s("default-deny"),
          cilium("allow-api-from-web"),
          cilium("api-egress-stripe"),
          scrape,
        ],
      }),
      rgroup("StatefulSet", "payments", "db", {
        pods: 1,
        labels: ["app=db", "tier=data"],
        policies: [
          k8s("allow-db-from-api"),
          k8s("allow-dns"),
          k8s("default-deny"),
          cilium("db-no-internet"),
          scrape,
        ],
      }),
      rgroup("Deployment", "payments", "web", {
        pods: 3,
        labels: ["app=web", "tier=frontend"],
        policies: [
          k8s("allow-dns"),
          k8s("allow-web-from-ingress"),
          k8s("allow-web-to-api"),
          k8s("default-deny"),
          scrape,
        ],
      }),
      rgroup("Deployment", "payments", "worker", {
        pods: 2,
        labels: ["app=worker"],
      }),
    ],
    peers: [
      outside(IDS.ingress, "ingress-nginx", "Deployment · 1 Pod", true),
      outside(IDS.coredns, "kube-system", "Deployment · 2 Pods", false),
      outside(IDS.prometheus, "monitoring", "Deployment · 1 Pod", true),
      {
        id: IDS.stripe,
        kind: "fqdn",
        namespace: null,
        label: "api.stripe.com",
        detail: "DNS name",
        source: false,
        destination: true,
        ingressIsolated: false,
        egressIsolated: false,
      },
      OTHER_PODS,
      WORLD,
    ],
    cells: [
      rcell(
        IDS.web,
        IDS.api,
        "allowed",
        [
          rport(8080, "TCP", {
            http: [rhttp({ method: "GET", path: "/api/.*" })],
          }),
        ],
        [k8s("allow-web-to-api"), cilium("allow-api-from-web")],
      ),
      rcell(
        IDS.api,
        IDS.db,
        "allowed",
        [rport(5432)],
        [k8s("allow-api-to-db"), k8s("allow-db-from-api")],
      ),
      rcell(IDS.web, IDS.coredns, "allowed", dns, [k8s("allow-dns")]),
      rcell(IDS.db, IDS.coredns, "allowed", dns, [k8s("allow-dns")]),
      rcell(IDS.api, IDS.coredns, "allowed", dns, [
        k8s("allow-dns"),
        cilium("api-egress-stripe"),
      ]),
      rcell(
        IDS.api,
        IDS.stripe,
        "allowed",
        [rport(443)],
        [cilium("api-egress-stripe")],
      ),
      // The entity `world` covers every DNS name, so the deny reaches api.stripe.com too.
      rcell(IDS.db, IDS.stripe, "denied", [], [cilium("db-no-internet")]),
      rcell(IDS.db, IDS.world, "denied", [], [cilium("db-no-internet")]),
      rcell(
        IDS.ingress,
        IDS.web,
        "allowed",
        [rport(8080)],
        [k8s("allow-web-from-ingress")],
      ),
      rcell(IDS.prometheus, IDS.web, "allowed", [rport(9090)], [scrape]),
      rcell(IDS.prometheus, IDS.api, "allowed", [rport(9090)], [scrape]),
      rcell(IDS.prometheus, IDS.db, "allowed", [rport(9090)], [scrape]),
    ],
    counts: { kubernetes: 6, cilium: 4 },
    notEvaluated: [{ policy: cilium("api-egress-stripe"), field: "rules.dns" }],
    missing: [],
    cilium: true,
    truncated: 0,
  };
}
