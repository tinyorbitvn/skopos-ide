import { type MapModel, nodeOf } from "../model";
import { labelHalf } from "./geometry";
import type { Positions } from "./grouped";

/** The number of steps every Force layout runs. */
export const FORCE_STEPS = 420;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
}

/** A small force simulation: repulsion between all nodes, springs on edges, plus a pull. */
export function simulate(
  p: Particle[],
  springs: [number, number][],
  steps: number,
  spring: number,
  pull: (q: Particle) => [number, number],
  heat = 1,
): void {
  for (let step = 0; step < steps; step++) {
    const cool = heat * (1 - step / steps);
    for (let i = 0; i < p.length; i++) {
      let [fx, fy] = pull(p[i]);
      for (let j = 0; j < p.length; j++) {
        if (i === j) continue;
        const dx = p[i].x - p[j].x;
        const dy = p[i].y - p[j].y;
        const d2 = Math.max(dx * dx + dy * dy, 36);
        const f = 9800 / d2 / Math.sqrt(d2);
        fx += dx * f;
        fy += dy * f;
      }
      p[i].fx = fx;
      p[i].fy = fy;
    }
    for (const [a, b] of springs) {
      const dx = p[b].x - p[a].x;
      const dy = p[b].y - p[a].y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = ((d - spring) * 0.04) / d;
      p[a].fx += dx * f;
      p[a].fy += dy * f;
      p[b].fx -= dx * f;
      p[b].fy -= dy * f;
    }
    for (const q of p) {
      q.vx = (q.vx + q.fx) * 0.8;
      q.vy = (q.vy + q.fy) * 0.8;
      const sp = Math.sqrt(q.vx * q.vx + q.vy * q.vy);
      const max = 2 + 14 * cool;
      if (sp > max) {
        q.vx *= max / sp;
        q.vy *= max / sp;
      }
      q.x += q.vx;
      q.y += q.vy;
    }
  }
}

/** The edges between `ids`, as index pairs. */
export function springsFor(
  model: MapModel,
  ids: readonly string[],
): [number, number][] {
  const index = new Map(ids.map((id, i) => [id, i]));
  const out: [number, number][] = [];
  for (const e of model.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined) out.push([a, b]);
  }
  return out;
}

/** FNV-1a: a node's start position depends only on its id. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function start(id: string, count: number): Particle {
  const h = hashId(id);
  const angle = ((h % 3600) / 3600) * 2 * Math.PI;
  const r = 34 * Math.sqrt(1 + ((h >>> 12) % Math.max(1, count)));
  return {
    x: Math.cos(angle) * r,
    y: Math.sin(angle) * r,
    vx: 0,
    vy: 0,
    fx: 0,
    fy: 0,
  };
}

/** The share of the full run a warm start keeps at least, and how fast new nodes add to it. */
const WARM_BASE = 0.15;
const WARM_GAIN = 2;
/** How hot a warm start begins: old nodes are nudged, not thrown around. */
const WARM_HEAT = 0.15;

/** The steps for a namespace of `count` nodes of which `warm` have a previous position. */
export function stepsFor(count: number, warm: number): number {
  if (warm === 0 || count === 0) return FORCE_STEPS;
  const fresh = (count - warm) / count;
  return Math.min(
    FORCE_STEPS,
    Math.ceil(FORCE_STEPS * (WARM_BASE + WARM_GAIN * fresh)),
  );
}

/**
 * Start particles for `own`: nodes with a position in `prev` keep it (re-centred on their
 * mean, as a block's output is shifted by its packing), new nodes start beside a placed
 * neighbour, and the rest by the id seed.
 */
function warmStart(
  model: MapModel,
  own: readonly string[],
  prev: Positions,
): { p: Particle[]; warm: number } {
  const at = new Map<string, [number, number]>();
  let mx = 0;
  let my = 0;
  for (const id of own) {
    const q = prev[id];
    if (!q) continue;
    at.set(id, [q.x, q.y]);
    mx += q.x;
    my += q.y;
  }
  const warm = at.size;
  if (warm === 0) return { p: own.map((id) => start(id, own.length)), warm };
  for (const q of at.values()) {
    q[0] -= mx / warm;
    q[1] -= my / warm;
  }
  const near = new Map<string, string[]>();
  for (const e of model.edges) {
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ]) {
      const list = near.get(a);
      if (list) list.push(b);
      else near.set(a, [b]);
    }
  }
  const missing = own.filter((id) => !at.has(id));
  for (let pass = 0; pass < 3 && missing.length; pass++) {
    for (let i = 0; i < missing.length; i++) {
      const id = missing[i];
      const anchor = near.get(id)?.find((n) => at.has(n));
      if (anchor === undefined) continue;
      const [ax, ay] = at.get(anchor) as [number, number];
      const angle = ((hashId(id) % 3600) / 3600) * 2 * Math.PI;
      at.set(id, [ax + Math.cos(angle) * 40, ay + Math.sin(angle) * 40]);
      missing.splice(i--, 1);
    }
  }
  const p = own.map((id) => {
    const q = at.get(id);
    if (!q) return start(id, own.length);
    return { x: q[0], y: q[1], vx: 0, vy: 0, fx: 0, fy: 0 };
  });
  return { p, warm };
}

/**
 * The cluster map's Force layout: one simulation per namespace, the cluster-scoped nodes
 * first, packed in rows into a roughly square block. With `prev` (an earlier result for
 * the same view) the nodes already there start where they were, and a namespace runs
 * fewer steps the fewer new nodes it has; `onSteps` sees each run's step count.
 */
export function layoutCluster(
  model: MapModel,
  ids: readonly string[],
  prev?: Positions,
  onSteps?: (steps: number) => void,
): Positions {
  const out: Positions = {};
  const namespaces = [...new Set(ids.map((id) => nodeOf(model, id).namespace))]
    .filter((ns) => ns !== "")
    .sort();
  const blocks = ["", ...namespaces].flatMap((ns) => {
    const own = ids.filter((id) => nodeOf(model, id).namespace === ns);
    if (!own.length) return [];
    const { p, warm } = prev
      ? warmStart(model, own, prev)
      : { p: own.map((id) => start(id, own.length)), warm: 0 };
    const steps = stepsFor(own.length, warm);
    onSteps?.(steps);
    simulate(
      p,
      springsFor(model, own),
      steps,
      128,
      (q) => [-0.008 * q.x, -0.008 * q.y],
      warm === 0 ? 1 : WARM_HEAT,
    );
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    p.forEach((q, i) => {
      const half = labelHalf(nodeOf(model, own[i]).name);
      x0 = Math.min(x0, q.x - half);
      x1 = Math.max(x1, q.x + half);
      y0 = Math.min(y0, q.y - 40);
      y1 = Math.max(y1, q.y + 52);
    });
    return [{ ids: own, p, x0, y0, w: x1 - x0, h: y1 - y0 }];
  });
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  const rowLimit =
    Math.sqrt(blocks.reduce((sum, b) => sum + (b.w + 110) * (b.h + 110), 0)) *
    1.2;
  for (const b of blocks) {
    if (cx > 0 && cx + b.w > rowLimit) {
      cx = 0;
      cy += rowH + 110;
      rowH = 0;
    }
    b.ids.forEach((id, i) => {
      out[id] = { x: b.p[i].x - b.x0 + cx, y: b.p[i].y - b.y0 + cy };
    });
    cx += b.w + 110;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}
