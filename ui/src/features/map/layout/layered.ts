import type { GraphRel } from "../../../ipc/generated/GraphRel";
import { type MapModel, nodeOf } from "../model";
import { levelOf, SPINE, USE } from "./constants";
import type { Positions } from "./grouped";

const SELECTS: ReadonlySet<GraphRel> = new Set(["selects"]);
const ROUTES: ReadonlySet<GraphRel> = new Set(["routes"]);
const OWNS: ReadonlySet<GraphRel> = new Set(["owns"]);
const MANAGES: ReadonlySet<GraphRel> = new Set(["manages"]);
const BINDS: ReadonlySet<GraphRel> = new Set(["binds"]);
const GRANTS: ReadonlySet<GraphRel> = new Set(["grants"]);
const BINDINGS: ReadonlySet<string> = new Set([
  "RoleBinding",
  "ClusterRoleBinding",
]);
const ROLES: ReadonlySet<string> = new Set(["Role", "ClusterRole"]);
/** Kinds that select Pods: a Service, and the policies of spec §3.3. */
const SELECTORS: ReadonlySet<string> = new Set([
  "Service",
  "NetworkPolicy",
  "CiliumNetworkPolicy",
  "CiliumClusterwideNetworkPolicy",
]);

/**
 * Each node's rank: ownership first (Deployment → ReplicaSet → Pod), then a Service or a
 * policy one rank before the Pods it selects, routes before their Services, Gateways before
 * their routes, load balancers first, an Application one rank before the objects it manages
 * and its ApplicationSet one before it (spec §3.3), config and AppProjects one rank after
 * what uses them, a binding one rank after the ServiceAccounts it binds and a role one after
 * the bindings that grant it.
 */
export function ranks(
  model: MapModel,
  ids: readonly string[],
): Record<string, number> {
  const set = new Set(ids);
  const edges = model.edges.filter((e) => set.has(e.from) && set.has(e.to));
  const kind = (id: string) => nodeOf(model, id).kind;
  const spine = edges.filter(
    (e) => e.rel === "owns" && SPINE.has(kind(e.from)) && SPINE.has(kind(e.to)),
  );
  const rank: Record<string, number> = {};
  const depthOf = (id: string): number => {
    if (id in rank) return rank[id];
    rank[id] = 0;
    let d = 0;
    for (const e of spine)
      if (e.to === id) d = Math.max(d, depthOf(e.from) + 1);
    rank[id] = d;
    return d;
  };
  for (const id of ids) if (SPINE.has(kind(id))) depthOf(id);
  const linked = (id: string, rels: ReadonlySet<GraphRel>, dir: "in" | "out") =>
    edges
      .filter(
        (e) => rels.has(e.rel) && (dir === "out" ? e.from === id : e.to === id),
      )
      .map((e) => (dir === "out" ? e.to : e.from))
      .filter((o) => o in rank)
      .map((o) => rank[o]);
  const ownerNext = (id: string) => {
    const m = linked(id, OWNS, "in");
    return m.length ? Math.max(...m) + 1 : 0;
  };
  const rest = ids.filter((id) => !(id in rank));
  const pass = (
    pick: (id: string) => boolean,
    place: (id: string) => number,
  ) => {
    for (const id of rest.filter(pick)) rank[id] = place(id);
  };
  pass(
    (id) => SELECTORS.has(kind(id)),
    (id) => {
      const p = linked(id, SELECTS, "out");
      return p.length ? Math.min(...p) - 1 : ownerNext(id);
    },
  );
  const before = (id: string) => {
    const s = linked(id, ROUTES, "out");
    return s.length ? Math.min(...s) - 1 : ownerNext(id);
  };
  pass((id) => kind(id) === "Ingress" || kind(id) === "HTTPRoute", before);
  pass((id) => kind(id) === "Gateway", before);
  pass((id) => kind(id) === "LoadBalancer", before);
  // Load balancers are the way in, so they share the first column whatever they front.
  const lbs = ids.filter((id) => kind(id) === "LoadBalancer");
  if (lbs.length) {
    const first = Math.min(...lbs.map((id) => rank[id]));
    for (const id of lbs) rank[id] = first;
  }
  // Argo CD comes before what it manages, and an ApplicationSet before its Applications.
  pass(
    (id) => kind(id) === "Application",
    (id) => {
      const m = linked(id, MANAGES, "out");
      return m.length ? Math.min(...m) - 1 : ownerNext(id);
    },
  );
  pass(
    (id) => kind(id) === "ApplicationSet",
    (id) => {
      const a = linked(id, OWNS, "out");
      return a.length ? Math.min(...a) - 1 : 0;
    },
  );
  pass(
    (id) => !(id in rank) && !BINDINGS.has(kind(id)) && !ROLES.has(kind(id)),
    (id) => {
      const u = linked(id, USE, "in");
      return u.length ? Math.max(...u) + 1 : ownerNext(id);
    },
  );
  // The access chain follows its ServiceAccounts, in the level order (spec O §5.2).
  pass(
    (id) => BINDINGS.has(kind(id)),
    (id) => {
      const a = linked(id, BINDS, "out");
      return a.length ? Math.max(...a) + 1 : ownerNext(id);
    },
  );
  pass(
    (id) => ROLES.has(kind(id)),
    (id) => {
      const b = linked(id, GRANTS, "in");
      return b.length ? Math.max(...b) + 1 : ownerNext(id);
    },
  );
  const low = Math.min(...ids.map((id) => rank[id]));
  for (const id of ids) rank[id] -= low;
  return rank;
}

export interface LayeredOptions {
  /** Space between nodes of one level. */
  gap?: number;
  /** Space between levels. */
  step?: number;
  /** Levels top to bottom instead of left to right. */
  vertical?: boolean;
}

/**
 * Levels from `ranks`, ordered inside a level by the mean position of their neighbours (a
 * few sweeps), then each node nudged towards its neighbours while keeping `gap` between
 * nodes, so chains such as Deployment → ReplicaSet → Pod come out straight.
 */
export function layered(
  model: MapModel,
  ids: readonly string[],
  opts: LayeredOptions = {},
): Positions {
  const gap = opts.gap ?? 92;
  const step = opts.step ?? 240;
  const rank = ranks(model, ids);
  const set = new Set(ids);
  const nbr = new Map<string, [string, number][]>(ids.map((id) => [id, []]));
  for (const e of model.edges) {
    if (!set.has(e.from) || !set.has(e.to)) continue;
    const w = e.rel === "owns" ? 3 : 1;
    nbr.get(e.from)?.push([e.to, w]);
    nbr.get(e.to)?.push([e.from, w]);
  }
  const levels: string[][] = [];
  for (const id of ids) {
    levels[rank[id]] = levels[rank[id]] ?? [];
    levels[rank[id]].push(id);
  }
  const live = levels.map((_, r) => r).filter((r) => levels[r]);
  const pri = (id: string) => levelOf(nodeOf(model, id).kind);
  const y: Record<string, number> = {};
  const spread = (level: string[]) => {
    level.forEach((id, i) => {
      y[id] = (i - (level.length - 1) / 2) * gap;
    });
  };
  for (const r of live) {
    levels[r].sort(
      (a, b) =>
        pri(a) - pri(b) ||
        nodeOf(model, a).name.localeCompare(nodeOf(model, b).name),
    );
    spread(levels[r]);
  }
  const pull = (id: string) => {
    let s = 0;
    let w = 0;
    for (const [o, wt] of nbr.get(id) ?? []) {
      if (rank[o] !== rank[id]) {
        s += y[o] * wt;
        w += wt;
      }
    }
    return w ? s / w : y[id];
  };
  for (let i = 0; i < 6; i++) {
    for (const r of i % 2 ? [...live].reverse() : live) {
      const level = levels[r];
      const key = new Map(level.map((id) => [id, pull(id)]));
      level.sort(
        (a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0) || pri(a) - pri(b),
      );
      spread(level);
    }
  }
  for (let i = 0; i < 8; i++) {
    for (const r of i % 2 ? [...live].reverse() : live) {
      const level = levels[r];
      const want = level.map((id) => (y[id] + pull(id)) / 2);
      let prev = Number.NEGATIVE_INFINITY;
      const got = want.map((w) => {
        prev = Math.max(w, prev + gap);
        return prev;
      });
      const shift = want.reduce((s, w, j) => s + w - got[j], 0) / level.length;
      level.forEach((id, j) => {
        y[id] = got[j] + shift;
      });
    }
  }
  const out: Positions = {};
  for (const id of ids) {
    out[id] = opts.vertical
      ? { x: y[id], y: rank[id] * step }
      : { x: rank[id] * step, y: y[id] };
  }
  return out;
}

/** An object map's Layered layout; `vertical` runs the levels top to bottom. */
export function layoutFocus(
  model: MapModel,
  ids: readonly string[],
  vertical = false,
): Positions {
  return layered(
    model,
    ids,
    vertical ? { vertical: true, gap: 180, step: 124 } : { gap: 92, step: 210 },
  );
}

/**
 * The cluster map's Layered layout: one band per namespace, stacked, after a row of the
 * cluster-scoped nodes with the load balancers first.
 */
export function layoutClusterLayered(
  model: MapModel,
  ids: readonly string[],
): Positions {
  const STEP = 240;
  const out: Positions = {};
  const namespaces = [...new Set(ids.map((id) => nodeOf(model, id).namespace))]
    .filter((ns) => ns !== "")
    .sort();
  const lbFirst = (id: string) =>
    nodeOf(model, id).kind === "LoadBalancer" ? 0 : 1;
  let top = 0;
  for (const ns of ["", ...namespaces]) {
    const band = ids.filter((id) => nodeOf(model, id).namespace === ns);
    if (!band.length) continue;
    const pos: Positions = {};
    if (ns === "") {
      [...band]
        .sort((a, b) => lbFirst(a) - lbFirst(b))
        .forEach((id, i) => {
          pos[id] = { x: STEP + i * 160, y: 0 };
        });
    } else {
      Object.assign(pos, layered(model, band, { step: STEP }));
    }
    const ys = band.map((id) => pos[id].y);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    for (const id of band)
      out[id] = { x: pos[id].x + 40, y: pos[id].y - y0 + top };
    top += y1 - y0 + 220;
  }
  return out;
}
