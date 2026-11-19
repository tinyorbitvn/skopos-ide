import { describe, expect, it } from "vitest";
import { demoGraph, ownsCycle } from "../../../test/graph";
import { buildModel } from "../model";
import { FORCE_STEPS, hashId, layoutCluster } from "./force";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

describe("layoutCluster", () => {
  it("places every node", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const pos = layoutCluster(model, ids);
    for (const id of ids) {
      expect(
        Number.isFinite(pos[id]?.x) && Number.isFinite(pos[id]?.y),
        id,
      ).toBe(true);
    }
  });

  it("gives the same positions twice for the same graph", () => {
    const ids = demoModel().nodes.map((n) => n.id);
    expect(layoutCluster(demoModel(), ids)).toEqual(
      layoutCluster(demoModel(), ids),
    );
  });

  it("keeps each namespace in a block of its own", () => {
    const model = demoModel();
    const pos = layoutCluster(
      model,
      model.nodes.map((n) => n.id),
    );
    const span = (ns: string) => {
      const xs = model.nodes
        .filter((n) => n.namespace === ns)
        .map((n) => pos[n.id]);
      return {
        x0: Math.min(...xs.map((p) => p.x)),
        x1: Math.max(...xs.map((p) => p.x)),
        y0: Math.min(...xs.map((p) => p.y)),
        y1: Math.max(...xs.map((p) => p.y)),
      };
    };
    const names = ["", "edge", "jobs", "shop"];
    for (const a of names) {
      for (const b of names) {
        if (a >= b) continue;
        const p = span(a);
        const q = span(b);
        const hit =
          p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;
        expect(hit, `${a} and ${b}`).toBe(false);
      }
    }
  });

  it("seeds from the id alone", () => {
    expect(hashId("Pod/shop/a")).toBe(hashId("Pod/shop/a"));
    expect(hashId("Pod/shop/a")).not.toBe(hashId("Pod/shop/b"));
  });

  it("draws owners that own each other", () => {
    const { nodes, edges } = ownsCycle(3);
    const pos = layoutCluster(
      buildModel(nodes, edges),
      nodes.map((n) => n.id),
    );
    expect(Object.keys(pos)).toHaveLength(4);
  });
});

describe("layoutCluster warm start", () => {
  function ring(count: number, extra = 0) {
    const nodes = Array.from({ length: count + extra }, (_, i) => ({
      id: `Pod/shop/p${String(i).padStart(3, "0")}`,
      kind: "Pod",
      name: `p${i}`,
      namespace: "shop",
    }));
    const edges = nodes.slice(1).map((n, i) => ({
      from: nodes[Math.floor(i / 2)].id,
      to: n.id,
      rel: "owns",
    }));
    // biome-ignore lint/suspicious/noExplicitAny: a minimal graph for the layout
    return buildModel(nodes as any, edges as any);
  }
  const idsOf = (m: ReturnType<typeof ring>) => m.nodes.map((n) => n.id);

  it("keeps old nodes near their old positions when one node is added", () => {
    const before = ring(60);
    const cold = layoutCluster(before, idsOf(before));
    const after = ring(60, 1);
    const warm = layoutCluster(after, idsOf(after), cold);
    // The block may shift as a whole when its extent changes; the nodes must not move
    // relative to one another.
    const old = idsOf(before);
    const dx =
      old.reduce((s, id) => s + warm[id].x - cold[id].x, 0) / old.length;
    const dy =
      old.reduce((s, id) => s + warm[id].y - cold[id].y, 0) / old.length;
    let worst = 0;
    for (const id of old) {
      worst = Math.max(
        worst,
        Math.hypot(warm[id].x - cold[id].x - dx, warm[id].y - cold[id].y - dy),
      );
    }
    expect(worst).toBeLessThan(100);
    expect(warm[idsOf(after)[60]]).toBeDefined();
  });

  it("runs fewer steps than a cold start", () => {
    const before = ring(60);
    const cold = layoutCluster(before, idsOf(before));
    const after = ring(60, 1);
    const coldSteps: number[] = [];
    const warmSteps: number[] = [];
    layoutCluster(after, idsOf(after), undefined, (n) => coldSteps.push(n));
    layoutCluster(after, idsOf(after), cold, (n) => warmSteps.push(n));
    expect(coldSteps).toEqual([FORCE_STEPS]);
    expect(warmSteps[0]).toBeLessThan(FORCE_STEPS / 2);
  });

  it("runs the full steps when no node was placed before", () => {
    const m = ring(10);
    const steps: number[] = [];
    layoutCluster(m, idsOf(m), { other: { x: 0, y: 0 } }, (n) => steps.push(n));
    expect(steps).toEqual([FORCE_STEPS]);
  });

  it("leaves a cold start unchanged by an empty previous layout", () => {
    const m = ring(30);
    expect(layoutCluster(m, idsOf(m), {})).toEqual(layoutCluster(m, idsOf(m)));
  });

  it("is deterministic for the same inputs", () => {
    const before = ring(40);
    const cold = layoutCluster(before, idsOf(before));
    const after = ring(40, 3);
    expect(layoutCluster(after, idsOf(after), cold)).toEqual(
      layoutCluster(after, idsOf(after), cold),
    );
  });
});
