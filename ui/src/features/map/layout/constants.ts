import type { GraphRel } from "../../../ipc/generated/GraphRel";
import type { GraphStatus } from "../../../ipc/generated/GraphStatus";

/**
 * The map's kinds and sizes, ported from the board library's graph module
 * (spec E §7.1), with the policy and Argo CD kinds of spec §3.3. Pod traffic is not ported.
 */

/**
 * Level order: Argo CD first, as it manages what follows (spec §3.3), then the way in,
 * routes, Services and the policies that select Pods, controllers, Pods and config, then
 * the bindings of ServiceAccounts and the roles they grant (spec O §5.1). The Argo CD kinds
 * take levels below 0 so the others keep theirs.
 */
export const ORDER: Readonly<Record<string, number>> = {
  ApplicationSet: -2,
  Application: -1,
  AppProject: -1,
  LoadBalancer: 0,
  Gateway: 1,
  HTTPRoute: 1,
  Ingress: 1,
  GatewayClass: 2,
  Service: 2,
  NetworkPolicy: 2,
  CiliumNetworkPolicy: 2,
  CiliumClusterwideNetworkPolicy: 2,
  Deployment: 3,
  StatefulSet: 3,
  DaemonSet: 3,
  CronJob: 3,
  ReplicaSet: 3,
  Job: 4,
  Pod: 5,
  ConfigMap: 6,
  Secret: 7,
  ServiceAccount: 8,
  PersistentVolumeClaim: 9,
  RoleBinding: 10,
  ClusterRoleBinding: 10,
  Role: 11,
  ClusterRole: 11,
};

/** A kind's level; a kind the map does not know sits with the Pods. */
export function levelOf(kind: string): number {
  return ORDER[kind] ?? 5;
}

/**
 * Kinds that end a path in an object map's neighbourhood. An AppProject is shared by many
 * Applications and a policy may select the Pods of many workloads, so walking on from one
 * would bring unrelated objects (spec §3.3). Applications and ApplicationSets are walked on.
 */
export const LEAVES: ReadonlySet<string> = new Set([
  "ConfigMap",
  "Secret",
  "ServiceAccount",
  "PersistentVolumeClaim",
  "GatewayClass",
  "Role",
  "ClusterRole",
  "AppProject",
  "NetworkPolicy",
  "CiliumNetworkPolicy",
  "CiliumClusterwideNetworkPolicy",
]);

/** The ownership chain the Layered layout ranks first. */
export const SPINE: ReadonlySet<string> = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "Job",
  "ReplicaSet",
  "Pod",
]);

/**
 * Owners the Grouped layout draws as boxes around what they own; an ApplicationSet holds
 * its Applications (spec §3.3).
 */
export const BOX: ReadonlySet<string> = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "Job",
  "ReplicaSet",
  "ApplicationSet",
]);

/** Relations drawn in the dashed "uses" style; `project` is an Application's AppProject. */
export const USE: ReadonlySet<GraphRel> = new Set([
  "mounts",
  "env",
  "runsAs",
  "claims",
  "class",
  "project",
]);

/** Relations drawn in the dotted "access" style: binding to ServiceAccount and role. */
export const ACCESS: ReadonlySet<GraphRel> = new Set(["binds", "grants"]);

/** Relations drawn in the traffic style. */
export const TRAFFIC: ReadonlySet<GraphRel> = new Set(["routes", "selects"]);

/** Kinds that traffic from outside is climbed to, up to the load balancer. */
export const ROUTED: ReadonlySet<string> = new Set([
  "Service",
  "HTTPRoute",
  "Ingress",
  "Gateway",
]);

/** Entry points: their neighbourhood walks forward to Services and Pods. */
export const ENTRY: ReadonlySet<string> = new Set([
  "LoadBalancer",
  "Gateway",
  "HTTPRoute",
  "Ingress",
]);

/** The kinds a map can be focused on (spec E §2). */
export const FOCUSABLE: ReadonlySet<string> = new Set([
  "Pod",
  "Deployment",
  "ReplicaSet",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "Service",
  "Ingress",
  "Gateway",
  "HTTPRoute",
  "LoadBalancer",
]);

/** A node's icon, and the focus's (spec E §8.1). */
export const NODE_SIZE = 44;
export const FOCUS_SIZE = 64;
/** Room under an icon for its name. */
export const LABEL_ROOM = 28;
/** Grouped boxes: inner padding, header height, gap between items, gap between columns. */
export const PAD = 14;
export const HEAD = 48;
export const GAP = 16;
export const FLOW = 76;

/** The status words used when a node has no status text (spec E §12.1). */
export const STATUS_TEXT: Readonly<Record<GraphStatus, string>> = {
  nominal: "Healthy",
  warning: "Degraded",
  critical: "Failing",
  neutral: "No health status",
};
