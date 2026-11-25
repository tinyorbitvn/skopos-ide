import { describe, expect, it } from "vitest";
import {
  ARGO,
  DEMO,
  demoGraph,
  drawnHiding,
  gedge,
  gnode,
  ownsCycle,
  POLICY,
  policyArgoGraph,
  RBAC,
  rbacGraph,
} from "../../../test/graph";
import { buildModel, type MapModel } from "../model";
import { boxText, leafSize } from "./geometry";
import {
  ACCESS_BOX,
  appNamespaceKey,
  boxRects,
  EXTERNAL,
  footprint,
  groupedEdges,
  groupTree,
  layoutGrouped,
  type Positions,
  poly,
  type Rect,
  ROOT,
} from "./grouped";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

function rbacModel() {
  const { nodes, edges } = rbacGraph();
  return buildModel(nodes, edges);
}

const inside = (inner: Rect, outer: Rect) =>
  inner.x0 >= outer.x0 - 0.01 &&
  inner.y0 >= outer.y0 - 0.01 &&
  inner.x1 <= outer.x1 + 0.01 &&
  inner.y1 <= outer.y1 + 0.01;

const overlap = (a: Rect, b: Rect) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function checkLayout(model: MapModel, ids: string[], pos: Positions) {
  const tree = groupTree(model, ids);
  const { boxes } = boxRects(model, tree, pos, "");
  for (const id of ids) {
    expect(pos[id], id).toBeDefined();
    expect(Number.isFinite(pos[id].x) && Number.isFinite(pos[id].y)).toBe(true);
  }
  for (const [key, group] of Object.entries(tree.groups)) {
    if (key === ROOT) continue;
    for (const kid of group.kids) {
      const r = tree.groups[kid] ? boxes[kid] : footprint(model, pos, kid, "");
      expect(inside(r, boxes[key]), `${kid} in ${key}`).toBe(true);
    }
  }
  // Owners are boxes; the other nodes are icons that must not overlap.
  const icons = ids.filter((id) => !tree.groups[id]);
  const cells = icons.map((id) => footprint(model, pos, id, ""));
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      expect(overlap(cells[i], cells[j]), `${icons[i]} and ${icons[j]}`).toBe(
        false,
      );
    }
  }
}

describe("groupTree", () => {
  it("puts each node in its nearest drawn owner, else its namespace", () => {
    const model = demoModel();
    const tree = groupTree(
      model,
      model.nodes.map((n) => n.id),
    );
    expect(tree.parentOf[DEMO.podA]).toBe(DEMO.replicaSet);
    expect(tree.parentOf[DEMO.replicaSet]).toBe(DEMO.deployment);
    expect(tree.parentOf[DEMO.deployment]).toBe("ns:shop");
    expect(tree.parentOf[DEMO.service]).toBe("ns:shop");
    expect(tree.parentOf[DEMO.ingressLb]).toBe(EXTERNAL);
    expect(tree.parentOf[DEMO.gatewayClass]).toBe(ROOT);
    expect(tree.groups[ROOT].kids[0]).toBe(EXTERNAL);
    expect(tree.leaves[DEMO.deployment]).toEqual([DEMO.podA, DEMO.podB]);
  });

  it("skips an owner that is not drawn", () => {
    const model = demoModel();
    const tree = groupTree(model, [DEMO.deployment, DEMO.podA]);
    expect(tree.parentOf[DEMO.podA]).toBe(DEMO.deployment);
  });
});

describe("layoutGrouped", () => {
  it("places every node in its box without overlaps, left to right", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    checkLayout(model, ids, layoutGrouped(model, ids, "h"));
  });

  it("places every node in its box without overlaps, top to bottom", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const pos = layoutGrouped(model, ids, "v", DEMO.podA);
    for (const id of ids) expect(pos[id]).toBeDefined();
    checkLayout(model, ids, layoutGrouped(model, ids, "v"));
  });

  it("puts what is outside the cluster first along the flow", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const pos = layoutGrouped(model, ids, "h");
    expect(pos[DEMO.ingressLb].x).toBeLessThan(pos[DEMO.ingress].x);
    expect(pos[DEMO.ingress].x).toBeLessThan(pos[DEMO.service].x);
    expect(pos[DEMO.service].x).toBeLessThan(pos[DEMO.podA].x);
    expect(pos[DEMO.podA].x).toBeLessThan(pos[DEMO.configMap].x);
  });

  it("is the same twice", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    expect(layoutGrouped(model, ids)).toEqual(layoutGrouped(model, ids));
  });
});

describe("groupedEdges", () => {
  it("draws one arrow to a box whose Pods all share a link, and no owns", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const edges = groupedEdges(model, tree, layoutGrouped(model, ids), "h", "");
    const brief = edges.map((e) => `${e.from} ${e.rel} ${e.to}`);
    expect(brief).toContain(`${DEMO.service} selects ${DEMO.replicaSet}`);
    expect(brief).toContain(`${DEMO.replicaSet} mounts ${DEMO.configMap}`);
    expect(brief).toContain(`${DEMO.podA} claims ${DEMO.claim}`);
    expect(brief).toContain(`${DEMO.gateway} class ${DEMO.gatewayClass}`);
    expect(edges.some((e) => e.rel === "owns")).toBe(false);
    const selects = edges.find((e) => e.rel === "selects");
    expect(selects?.ids).toEqual([DEMO.service, DEMO.podA, DEMO.podB]);
    for (const e of edges) {
      expect(e.d).toMatch(/^M-?\d/);
      expect(e.head).toMatch(/Z$/);
    }
  });
});

describe("access columns", () => {
  it("puts a RoleBinding level with its ServiceAccount in column 4 and its Role level with it in column 5", () => {
    const model = rbacModel();
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf[RBAC.binding]).toBe("ns:shop");
    expect(tree.parentOf[RBAC.role]).toBe("ns:shop");
    const pos = layoutGrouped(model, ids, "h");
    expect(pos[DEMO.configMap].x).toBeLessThan(pos[RBAC.binding].x);
    expect(pos[RBAC.binding].x).toBeLessThan(pos[RBAC.role].x);
    expect(pos[RBAC.binding].y).toBeCloseTo(pos[DEMO.account].y);
    expect(pos[RBAC.role].y).toBeCloseTo(pos[RBAC.binding].y);
    // A second binding of the same ServiceAccount takes the next free spot.
    expect(pos[RBAC.viewBinding].x).toBeCloseTo(pos[RBAC.binding].x);
    expect(pos[RBAC.viewBinding].y).toBeGreaterThan(pos[RBAC.binding].y);
  });

  it("places the access columns in their boxes without overlaps, both ways", () => {
    const model = rbacModel();
    const ids = model.nodes.map((n) => n.id);
    checkLayout(model, ids, layoutGrouped(model, ids, "h"));
    const pos = layoutGrouped(model, ids, "v");
    checkLayout(model, ids, pos);
    expect(pos[RBAC.binding].x).toBeCloseTo(pos[DEMO.account].x);
    expect(pos[RBAC.binding].y).toBeGreaterThan(pos[DEMO.account].y);
  });

  it("holds ClusterRoleBindings and ClusterRoles in the Cluster-wide access box, after the namespaces", () => {
    const model = rbacModel();
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.groups[ACCESS_BOX]).toMatchObject({
      kind: "Access",
      name: "Cluster-wide access",
      namespace: "",
    });
    expect(tree.groups[ACCESS_BOX].kids).toEqual([
      RBAC.clusterBinding,
      RBAC.clusterRole,
    ]);
    expect(tree.groups[ROOT].kids).toEqual([
      EXTERNAL,
      DEMO.gatewayClass,
      "ns:edge",
      "ns:jobs",
      "ns:shop",
      ACCESS_BOX,
    ]);
    const pos = layoutGrouped(model, ids, "h");
    expect(pos[RBAC.clusterBinding].x).toBeLessThan(pos[RBAC.clusterRole].x);
    expect(pos[RBAC.clusterRole].y).toBeCloseTo(pos[RBAC.clusterBinding].y);
  });

  it("puts the ClusterRole of a RoleBinding in the Cluster-wide access box", () => {
    const model = rbacModel();
    const ids = [DEMO.account, RBAC.viewBinding, RBAC.clusterRole];
    const tree = groupTree(model, ids);
    expect(tree.parentOf[RBAC.viewBinding]).toBe("ns:shop");
    expect(tree.parentOf[RBAC.clusterRole]).toBe(ACCESS_BOX);
    expect(tree.groups[ACCESS_BOX].kids).toEqual([RBAC.clusterRole]);
  });

  it("draws no Cluster-wide access box when it would be empty", () => {
    const model = rbacModel();
    const namespaced = model.nodes
      .filter((n) => n.namespace !== "")
      .map((n) => n.id);
    expect(groupTree(model, namespaced).groups[ACCESS_BOX]).toBeUndefined();
    const demo = demoModel();
    expect(
      groupTree(
        demo,
        demo.nodes.map((n) => n.id),
      ).groups[ACCESS_BOX],
    ).toBeUndefined();
  });

  it("draws binds and grants as access edges between the columns", () => {
    const model = rbacModel();
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const edges = groupedEdges(model, tree, layoutGrouped(model, ids), "h", "");
    const access = edges.filter((e) => e.cls === "access");
    expect(access.map((e) => `${e.from} ${e.rel} ${e.to}`).sort()).toEqual(
      model.edges
        .filter((e) => e.rel === "binds" || e.rel === "grants")
        .map((e) => `${e.from} ${e.rel} ${e.to}`)
        .sort(),
    );
    for (const e of access) expect(e.ids).toEqual([e.from, e.to]);
  });
});

describe("owners that own each other", () => {
  for (const size of [1, 2, 3]) {
    it(`draws a cycle of ${size} with every node placed`, () => {
      const { nodes, edges } = ownsCycle(size);
      const model = buildModel(nodes, edges);
      const ids = nodes.map((n) => n.id);
      const tree = groupTree(model, ids);
      for (const id of ids) {
        const seen = new Set<string>();
        for (let k = id; k !== ROOT; k = tree.parentOf[k]) {
          expect(seen.has(k), `${id} reaches the root`).toBe(false);
          seen.add(k);
        }
      }
      const pos = layoutGrouped(model, ids);
      checkLayout(model, ids, pos);
      expect(groupedEdges(model, tree, pos, "h", "")).toEqual([]);
    });
  }
});

describe("poly", () => {
  it("gives the point halfway along the line", () => {
    expect(
      poly([
        [0, 0],
        [10, 0],
      ]).mid,
    ).toEqual({ x: 5, y: 0 });
    expect(
      poly([
        [0, 0],
        [0, 10],
        [30, 10],
      ]).mid,
    ).toEqual({ x: 10, y: 10 });
  });
});

describe("bridged edges", () => {
  const f = (n: number) => n.toFixed(1);

  it("draws a bridged owns edge as a branch from the owner box's corner to each child", () => {
    const model = drawnHiding(["ReplicaSet"]);
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const pos = layoutGrouped(model, ids);
    const owner = boxRects(model, tree, pos, "").boxes[DEMO.deployment];
    const branches = groupedEdges(model, tree, pos, "h", "").filter(
      (e) => e.cls === "own",
    );
    expect(branches.map((e) => [e.from, e.to, e.via])).toEqual([
      [DEMO.deployment, DEMO.podA, ["ReplicaSet"]],
      [DEMO.deployment, DEMO.podB, ["ReplicaSet"]],
    ]);
    const sx = owner.x0 + 14;
    const sy = owner.y0 + 40;
    for (const e of branches) {
      const p = pos[e.to];
      // Straight down, then right to the leaf's left edge at its centre.
      expect(e.d.startsWith(`M${f(sx)} ${f(sy)} L${f(sx)} `)).toBe(true);
      expect(
        e.head.startsWith(` M${f(p.x - leafSize(false) / 2)} ${f(p.y)} `),
      ).toBe(true);
      expect(e.mid).toEqual({ x: sx, y: sy + 9 });
    }
  });

  it("does not draw a branch to a child box that starts less than 16 px right of the start", () => {
    const nodes = [
      gnode("Deployment/n/d"),
      gnode("ReplicaSet/n/r"),
      gnode("Job/n/j"),
      gnode("Pod/n/p"),
    ];
    const edges = [
      gedge("Deployment/n/d", "owns", "ReplicaSet/n/r"),
      gedge("ReplicaSet/n/r", "owns", "Job/n/j"),
      gedge("Job/n/j", "owns", "Pod/n/p"),
    ];
    const model = drawnHiding(["ReplicaSet"], { nodes, edges });
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf["Job/n/j"]).toBe("Deployment/n/d");
    expect(
      groupedEdges(model, tree, layoutGrouped(model, ids), "h", "").filter(
        (e) => e.cls === "own",
      ),
    ).toEqual([]);
  });

  it("a merged arrow carries via only when every edge it stands for is a bridge", () => {
    const model = drawnHiding(["Service"]);
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const edges = groupedEdges(model, tree, layoutGrouped(model, ids), "h", "");
    const fromIngress = edges.find(
      (e) => e.from === DEMO.ingress && e.rel === "selects",
    );
    expect(fromIngress?.to).toBe(DEMO.replicaSet);
    expect(fromIngress?.via).toEqual(["Service"]);
    const mounts = edges.find(
      (e) => e.rel === "mounts" && e.to === DEMO.configMap,
    );
    expect(mounts?.via).toBeUndefined();
  });
});

describe("policies and Argo CD", () => {
  function policyArgoModel() {
    const { nodes, edges } = policyArgoGraph();
    return buildModel(nodes, edges);
  }

  it("holds Applications in their ApplicationSet's box at the root, policies with the Services and AppProjects with config", () => {
    const model = policyArgoModel();
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf[ARGO.app]).toBe(ARGO.appSet);
    expect(tree.parentOf[ARGO.nightly]).toBe(ARGO.appSet);
    expect(tree.parentOf[ARGO.appSet]).toBe(ROOT);
    expect(tree.parentOf[ARGO.project]).toBe("ns:argocd");
    expect(tree.parentOf[POLICY.netpol]).toBe("ns:shop");
    expect(tree.parentOf[POLICY.scrape]).toBe(ROOT);
    const pos = layoutGrouped(model, ids, "h");
    expect(pos[POLICY.cilium].x).toBeCloseTo(pos[POLICY.netpol].x);
    checkLayout(model, ids, pos);
    checkLayout(model, ids, layoutGrouped(model, ids, "v"));
  });

  it("draws a policy's selects as traffic and project as a use, and no manages into the Application's own box", () => {
    const model = policyArgoModel();
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const edges = groupedEdges(model, tree, layoutGrouped(model, ids), "h", "");
    const brief = edges.map((e) => `${e.cls} ${e.from} ${e.rel} ${e.to}`);
    expect(brief).toContain(`net ${POLICY.netpol} selects ${DEMO.replicaSet}`);
    expect(brief).toContain(`use ${ARGO.app} project ${ARGO.project}`);
    expect(brief).toContain(`use ${ARGO.nightly} project ${ARGO.project}`);
    expect(brief.filter((b) => b.includes(" manages "))).toEqual([]);
  });
});

describe("Argo CD Applications as the outer boxes", () => {
  const app = (name: string) => `Application/argocd/${name}`;

  /** The demo graph with `apps` added and the `manages` edges given. */
  function argoModel(apps: string[], manages: [string, string][]): MapModel {
    const { nodes, edges } = demoGraph();
    return buildModel(
      [
        ...nodes,
        ...apps.map((a) => gnode(a, { statusText: "Healthy · Synced" })),
      ],
      [...edges, ...manages.map(([a, to]) => gedge(a, "manages", to))],
    );
  }

  it("holds what an Application manages, and what that owns, in its box at the root", () => {
    const model = argoModel(
      [ARGO.app],
      [
        [ARGO.app, DEMO.deployment],
        [ARGO.app, DEMO.service],
        [ARGO.app, DEMO.configMap],
      ],
    );
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf[ARGO.app]).toBe(ROOT);
    expect(tree.parentOf[DEMO.deployment]).toBe(ARGO.app);
    expect(tree.parentOf[DEMO.service]).toBe(ARGO.app);
    expect(tree.parentOf[DEMO.configMap]).toBe(ARGO.app);
    expect(tree.parentOf[DEMO.replicaSet]).toBe(DEMO.deployment);
    expect(tree.parentOf[DEMO.podA]).toBe(DEMO.replicaSet);
    // What it does not manage stays in its namespace.
    expect(tree.parentOf[DEMO.secret]).toBe("ns:shop");
    expect(tree.parentOf[DEMO.statefulSet]).toBe("ns:shop");
    expect(tree.groups[ARGO.app].place).toBe("shop");
    expect(boxText(model, tree.groups[ARGO.app])).toEqual({
      title: "shop",
      sub: "Application · shop · Healthy · Synced",
    });
    const pos = layoutGrouped(model, ids, "h");
    // Inside, the columns of a namespace: the Service before the workloads, then config.
    expect(pos[DEMO.service].x).toBeLessThan(pos[DEMO.podA].x);
    expect(pos[DEMO.podA].x).toBeLessThan(pos[DEMO.configMap].x);
    checkLayout(model, ids, pos);
    checkLayout(model, ids, layoutGrouped(model, ids, "v"));
  });

  it("puts a Pod whose owners are hidden in the Application that manages one of them", () => {
    const model = argoModel([ARGO.app], [[ARGO.app, DEMO.deployment]]);
    const tree = groupTree(model, [ARGO.app, DEMO.podA, DEMO.podB]);
    expect(tree.parentOf[DEMO.podA]).toBe(ARGO.app);
    expect(tree.parentOf[DEMO.podB]).toBe(ARGO.app);
  });

  it("gives an Application across namespaces a box for each, with cluster-scoped objects beside them", () => {
    const model = argoModel(
      [ARGO.app],
      [
        [ARGO.app, DEMO.deployment],
        [ARGO.app, DEMO.cronJob],
        [ARGO.app, DEMO.gatewayClass],
      ],
    );
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const shop = appNamespaceKey(ARGO.app, "shop");
    const jobs = appNamespaceKey(ARGO.app, "jobs");
    expect(tree.parentOf[DEMO.deployment]).toBe(shop);
    expect(tree.parentOf[DEMO.cronJob]).toBe(jobs);
    expect(tree.parentOf[shop]).toBe(ARGO.app);
    expect(tree.parentOf[jobs]).toBe(ARGO.app);
    expect(tree.parentOf[DEMO.gatewayClass]).toBe(ARGO.app);
    expect(tree.groups[shop]).toMatchObject({
      kind: "Namespace",
      name: "shop",
    });
    expect(tree.groups[ARGO.app].place).toBeUndefined();
    expect(boxText(model, tree.groups[ARGO.app]).sub).toBe(
      "Application · Healthy · Synced",
    );
    checkLayout(model, ids, layoutGrouped(model, ids, "h"));
    checkLayout(model, ids, layoutGrouped(model, ids, "v"));
  });

  it("nests the Applications a parent manages, and breaks a cycle of Applications", () => {
    const root = app("root");
    const model = argoModel(
      [root, ARGO.app, ARGO.nightly],
      [
        [root, root],
        [root, ARGO.app],
        [root, ARGO.nightly],
        [ARGO.app, DEMO.deployment],
        [ARGO.nightly, DEMO.cronJob],
      ],
    );
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf[root]).toBe(ROOT);
    expect(tree.parentOf[ARGO.app]).toBe(root);
    expect(tree.parentOf[ARGO.nightly]).toBe(root);
    expect(tree.parentOf[DEMO.deployment]).toBe(ARGO.app);
    // Child Applications are not split by their own namespace.
    expect(tree.groups[root].place).toBeUndefined();
    checkLayout(model, ids, layoutGrouped(model, ids, "h"));

    const a = app("a");
    const b = app("b");
    const loop = argoModel(
      [a, b],
      [
        [a, b],
        [b, a],
      ],
    );
    const loopIds = loop.nodes.map((n) => n.id);
    const loopTree = groupTree(loop, loopIds);
    const top = [a, b].find((x) => loopTree.parentOf[x] === ROOT);
    expect(top).toBeDefined();
    expect(loopTree.parentOf[top === a ? b : a]).toBe(top);
    checkLayout(loop, loopIds, layoutGrouped(loop, loopIds, "h"));
  });

  it("puts an object two Applications manage in the first by id and draws the other's manages", () => {
    const first = app("a");
    const second = app("b");
    const model = argoModel(
      [second, first],
      [
        [second, DEMO.service],
        [first, DEMO.service],
      ],
    );
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf[DEMO.service]).toBe(first);
    const brief = groupedEdges(
      model,
      tree,
      layoutGrouped(model, ids),
      "h",
      "",
    ).map((e) => `${e.from} ${e.rel} ${e.to}`);
    expect(brief).toContain(`${second} manages ${DEMO.service}`);
    expect(brief).not.toContain(`${first} manages ${DEMO.service}`);
  });

  it("draws an Application with nothing here as an empty box at the root", () => {
    const model = argoModel([ARGO.app], []);
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf[ARGO.app]).toBe(ROOT);
    expect(tree.groups[ARGO.app].kids).toEqual([]);
    checkLayout(model, ids, layoutGrouped(model, ids, "h"));
  });

  it("points a link to every Pod of an Application's box at the Pods, not the box", () => {
    const model = argoModel(
      [ARGO.app],
      [
        [ARGO.app, DEMO.podA],
        [ARGO.app, DEMO.podB],
      ],
    );
    const ids = [ARGO.app, DEMO.podA, DEMO.podB, DEMO.service];
    const tree = groupTree(model, ids);
    expect(tree.parentOf[DEMO.podA]).toBe(ARGO.app);
    const brief = groupedEdges(
      model,
      tree,
      layoutGrouped(model, ids),
      "h",
      "",
    ).map((e) => `${e.from} ${e.rel} ${e.to}`);
    expect(brief).toContain(`${DEMO.service} selects ${DEMO.podA}`);
    expect(brief).toContain(`${DEMO.service} selects ${DEMO.podB}`);
  });
});
