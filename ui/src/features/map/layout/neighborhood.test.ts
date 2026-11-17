import { describe, expect, it } from "vitest";
import {
  DEMO,
  demoGraph,
  gedge,
  gnode,
  ownsCycle,
  RBAC,
  rbacGraph,
} from "../../../test/graph";
import { buildModel } from "../model";
import { boxText, cellW, headW, labelHalf } from "./geometry";
import { neighborhood } from "./neighborhood";

function demoModel(extra = false) {
  const { nodes, edges } = demoGraph();
  if (!extra) return buildModel(nodes, edges);
  const other = gnode("Pod/shop/other");
  return buildModel(
    [...nodes, other],
    [...edges, gedge(other.id, "mounts", DEMO.configMap)],
  );
}

const sorted = (ids: string[]) => [...ids].sort();

describe("neighborhood", () => {
  const near = [
    DEMO.podA,
    DEMO.configMap,
    DEMO.secret,
    DEMO.account,
    DEMO.claim,
    DEMO.replicaSet,
    DEMO.service,
    DEMO.deployment,
  ];
  const traffic = [
    DEMO.podB,
    DEMO.ingress,
    DEMO.route,
    DEMO.ingressLb,
    DEMO.gateway,
    DEMO.gatewayLb,
    DEMO.gatewayClass,
  ];

  it("keeps a Pod's links and its owner chain at 1 hop", () => {
    expect(sorted(neighborhood(demoModel(), DEMO.podA, 1))).toEqual(
      sorted(near),
    );
  });

  it("climbs the traffic to the load balancers at 2 hops", () => {
    expect(sorted(neighborhood(demoModel(), DEMO.podA, 2))).toEqual(
      sorted([...near, ...traffic]),
    );
  });

  it("reaches everything connected with all, but leaves end paths", () => {
    const ids = neighborhood(demoModel(true), DEMO.podA, "all");
    expect(sorted(ids)).toEqual(sorted([...near, ...traffic]));
    expect(ids).not.toContain("Pod/shop/other");
  });

  it("counts hops from everything the focus owns", () => {
    const one = neighborhood(demoModel(), DEMO.deployment, 1);
    expect(sorted(one)).toEqual(
      sorted([
        DEMO.deployment,
        DEMO.replicaSet,
        DEMO.podA,
        DEMO.podB,
        DEMO.configMap,
        DEMO.secret,
        DEMO.account,
        DEMO.claim,
        DEMO.service,
      ]),
    );
    expect(neighborhood(demoModel(), DEMO.deployment, 2)).toHaveLength(15);
  });

  it("climbs routes from a Service focus, and a Gateway brings its class", () => {
    expect(sorted(neighborhood(demoModel(), DEMO.service, 1))).toEqual(
      sorted([
        DEMO.service,
        DEMO.podA,
        DEMO.podB,
        DEMO.ingress,
        DEMO.route,
        DEMO.ingressLb,
        DEMO.gateway,
        DEMO.gatewayLb,
        DEMO.gatewayClass,
      ]),
    );
  });

  it("walks forward from an entry point to the Pods and their owners", () => {
    expect(sorted(neighborhood(demoModel(), DEMO.ingressLb, 1))).toEqual(
      sorted([
        DEMO.ingressLb,
        DEMO.ingress,
        DEMO.service,
        DEMO.podA,
        DEMO.podB,
        DEMO.replicaSet,
        DEMO.deployment,
      ]),
    );
  });

  it("keeps a CronJob's whole tree", () => {
    expect(sorted(neighborhood(demoModel(), DEMO.cronJob, 1))).toEqual(
      sorted([DEMO.cronJob, DEMO.job, DEMO.jobPod, DEMO.token]),
    );
  });
});

describe("neighborhood with access", () => {
  const rbacModel = () => {
    const { nodes, edges } = rbacGraph();
    return buildModel(nodes, edges);
  };
  const chain = [
    RBAC.binding,
    RBAC.role,
    RBAC.viewBinding,
    RBAC.clusterBinding,
    RBAC.clusterRole,
  ];

  it("brings the bindings of its Pods' ServiceAccount and their roles at depth 1", () => {
    expect(sorted(neighborhood(rbacModel(), DEMO.deployment, 1))).toEqual(
      sorted([...neighborhood(demoModel(), DEMO.deployment, 1), ...chain]),
    );
  });

  it("walks from no binding to its other ServiceAccount, and from no role on", () => {
    for (const depth of [1, 2, "all"] as const) {
      const ids = neighborhood(rbacModel(), DEMO.deployment, depth);
      expect(ids, String(depth)).toEqual(expect.arrayContaining(chain));
      expect(ids, String(depth)).not.toContain(RBAC.nightly);
      expect(ids, String(depth)).not.toContain(RBAC.nightlyBinding);
    }
  });

  it("leads from a binding reached another way to its role only", () => {
    const owner = gnode("Deployment/team/operator");
    const binding = gnode("RoleBinding/team/operator");
    const account = gnode("ServiceAccount/team/other");
    const role = gnode("Role/team/operator");
    const model = buildModel(
      [owner, binding, account, role],
      [
        gedge(owner.id, "owns", binding.id),
        gedge(binding.id, "binds", account.id),
        gedge(binding.id, "grants", role.id),
      ],
    );
    expect(sorted(neighborhood(model, owner.id, "all"))).toEqual(
      sorted([owner.id, binding.id, role.id]),
    );
  });
});

describe("neighborhood with owners that own each other", () => {
  for (const size of [1, 2, 3]) {
    it(`finishes on a cycle of ${size} and keeps every node`, () => {
      const { nodes, edges } = ownsCycle(size);
      const model = buildModel(nodes, edges);
      for (const depth of [1, 2, "all"] as const) {
        expect(sorted(neighborhood(model, nodes[0].id, depth))).toEqual(
          sorted(nodes.map((n) => n.id)),
        );
      }
      expect(neighborhood(model, "Pod/loop/pod", 1)).toContain(nodes[0].id);
    });
  }
});

describe("geometry", () => {
  it("measures labels and cells as the board does", () => {
    expect(labelHalf("db")).toBe(36);
    expect(labelHalf("a".repeat(20))).toBe(76);
    expect(labelHalf("a".repeat(80))).toBe(110);
    expect(cellW("db", false)).toBe(72);
    expect(cellW("db", true)).toBe(80);
  });

  it("titles boxes", () => {
    const model = demoModel();
    expect(boxText(model, { kind: "Namespace", id: "", name: "shop" })).toEqual(
      { title: "shop", sub: "Namespace" },
    );
    expect(boxText(model, { kind: "External", id: "", name: "" })).toEqual({
      title: "Outside the cluster",
      sub: "Load balancers",
    });
    expect(boxText(model, { kind: "Access", id: "", name: "" })).toEqual({
      title: "Cluster-wide access",
      sub: "ClusterRoleBindings and ClusterRoles",
    });
    const deployment = boxText(model, {
      kind: "Deployment",
      id: DEMO.deployment,
      name: "web",
    });
    expect(deployment).toEqual({
      title: "web",
      sub: "Deployment · 1 of 2 available",
    });
    expect(headW(deployment)).toBe(
      Math.ceil(46 + "Deployment · 1 of 2 available".length * 7.2 + 16),
    );
  });
});
