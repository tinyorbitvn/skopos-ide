import { linksOf, type MapModel, nodeOf } from "../model";
import { ENTRY, LEAVES, ROUTED } from "./constants";

/** How far an object map reaches: 1 or 2 hops, or everything connected. */
export type Depth = 1 | 2 | "all";

/**
 * The ids an object map draws around `focusId` (spec E §7.2), in the order they were reached.
 *
 * - The owner chain above the focus, and everything it owns below.
 * - Links within `depth` hops, counted from the focus and everything it owns, where
 *   ConfigMap, Secret, ServiceAccount, PersistentVolumeClaim, GatewayClass, Role,
 *   ClusterRole, AppProject and the policy kinds end a path (`LEAVES`).
 * - Inbound traffic climbed over `routes` edges up to the load balancer, from each Service,
 *   route, Ingress or Gateway reached in fewer than `depth` hops. A Gateway brings its
 *   GatewayClass.
 * - An entry point walks forward over `routes` and `selects` to Services and Pods, which
 *   bring their owner chain.
 * - Each ServiceAccount brings, whatever the depth, the bindings that bind it and the roles
 *   they grant. No walk goes from a binding to the other ServiceAccounts it binds (spec O
 *   §5.3).
 */
export function neighborhood(
  model: MapModel,
  focusId: string,
  depth: Depth,
): string[] {
  const max = depth === "all" ? Number.POSITIVE_INFINITY : depth;
  const kindOf = (id: string) => nodeOf(model, id).kind;
  const climb = (id: string, up: boolean, into: Set<string>) => {
    for (const link of linksOf(model, id)) {
      if (link.rel !== "owns" || link.out === up || into.has(link.other)) {
        continue;
      }
      into.add(link.other);
      climb(link.other, up, into);
    }
  };

  const above = new Set<string>();
  const below = new Set([focusId]);
  climb(focusId, true, above);
  climb(focusId, false, below);

  const seen = new Map<string, number>();
  const queue: string[] = [];
  for (const id of below) {
    seen.set(id, 0);
    queue.push(id);
  }
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const d = seen.get(id) ?? 0;
    if (d >= max || (id !== focusId && LEAVES.has(kindOf(id)))) continue;
    for (const link of linksOf(model, id)) {
      // A binding reached through its owner leads to its role, not its ServiceAccounts.
      if (seen.has(link.other) || (link.rel === "binds" && link.out)) continue;
      seen.set(link.other, d + 1);
      queue.push(link.other);
    }
  }
  for (const id of above) if (!seen.has(id)) seen.set(id, 0);

  const front = new Set<string>();
  const climbIn = (id: string) => {
    for (const link of linksOf(model, id)) {
      if (link.rel !== "routes" || link.out || front.has(link.other)) continue;
      front.add(link.other);
      climbIn(link.other);
    }
  };
  for (const [id, d] of [...seen]) {
    if (d < max && ROUTED.has(kindOf(id))) climbIn(id);
  }
  if (ENTRY.has(kindOf(focusId))) {
    // Its own visited set: the climb above may already hold the routes this walks through.
    const went = new Set<string>();
    const walk = (id: string) => {
      for (const link of linksOf(model, id)) {
        if (!link.out || (link.rel !== "routes" && link.rel !== "selects")) {
          continue;
        }
        if (went.has(link.other)) continue;
        went.add(link.other);
        front.add(link.other);
        walk(link.other);
      }
    };
    walk(focusId);
  }
  for (const id of [...front, ...seen.keys()]) {
    if (kindOf(id) !== "Gateway") continue;
    for (const link of linksOf(model, id)) {
      if (link.rel === "class") front.add(link.other);
    }
  }
  for (const id of [...front]) {
    if (kindOf(id) !== "LoadBalancer") climb(id, true, front);
  }
  for (const id of front) if (!seen.has(id)) seen.set(id, max);
  // Each ServiceAccount's bindings and the roles they grant, whatever the depth.
  for (const id of [...seen.keys()]) {
    if (kindOf(id) !== "ServiceAccount") continue;
    for (const bound of linksOf(model, id)) {
      if (bound.rel !== "binds" || bound.out) continue;
      if (!seen.has(bound.other)) seen.set(bound.other, max);
      for (const granted of linksOf(model, bound.other)) {
        if (granted.rel !== "grants" || !granted.out) continue;
        if (!seen.has(granted.other)) seen.set(granted.other, max);
      }
    }
  }
  return [...seen.keys()];
}
