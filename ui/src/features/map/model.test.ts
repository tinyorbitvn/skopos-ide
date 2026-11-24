import { describe, expect, it } from "vitest";
import {
  ARGO,
  DEMO,
  demoGraph,
  gedge,
  gnode,
  POLICY,
  policyArgoGraph,
  RBAC,
  rbacGraph,
} from "../../test/graph";
import { levelOf } from "./layout/constants";
import {
  autoHidden,
  buildModel,
  chipNamespaces,
  countsFirst,
  countText,
  FORCE_MAX_NODES,
  graphFilter,
  levelSort,
  linksOf,
  listLabel,
  MAX_NODES,
  missingText,
  namespaceView,
  statusLine,
  subscribedNamespaces,
  summaryText,
  summaryTitle,
  tooMany,
} from "./model";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

describe("buildModel", () => {
  it("indexes the nodes and the edges of each node", () => {
    const model = demoModel();
    expect(model.nodes).toHaveLength(22);
    expect(model.byId.get(DEMO.podA)?.name).toBe("web-7d9-a");
    expect(model.outgoing.get(DEMO.replicaSet)?.map((e) => e.to)).toEqual([
      DEMO.podA,
      DEMO.podB,
    ]);
    expect(model.incoming.get(DEMO.configMap)?.map((e) => e.from)).toEqual([
      DEMO.podA,
      DEMO.podB,
    ]);
  });

  it("drops edges whose ends are not nodes", () => {
    const a = gnode("Pod/shop/a");
    const model = buildModel(
      [a],
      [gedge(a.id, "mounts", "ConfigMap/shop/gone")],
    );
    expect(model.edges).toEqual([]);
    expect(linksOf(model, a.id)).toEqual([]);
  });

  it("lists a node's links, outgoing first", () => {
    expect(linksOf(demoModel(), DEMO.service)).toEqual([
      { other: DEMO.podA, rel: "selects", out: true },
      { other: DEMO.podB, rel: "selects", out: true },
      { other: DEMO.ingress, rel: "routes", out: false },
      { other: DEMO.route, rel: "routes", out: false },
    ]);
  });
});

describe("namespaceView", () => {
  it("draws every node when nothing is hidden", () => {
    expect(namespaceView(demoModel(), new Set())).toHaveLength(22);
  });

  it("adds what routes and class edges join to the shown namespaces", () => {
    expect(namespaceView(demoModel(), new Set(["shop", "jobs"]))).toEqual([
      DEMO.service,
      DEMO.ingress,
      DEMO.route,
      DEMO.gateway,
      DEMO.gatewayClass,
      DEMO.ingressLb,
      DEMO.gatewayLb,
    ]);
  });

  it("never brings in another namespace's Pods", () => {
    const ids = namespaceView(demoModel(), new Set(["shop", "edge"]));
    expect(ids).toEqual([DEMO.cronJob, DEMO.job, DEMO.jobPod, DEMO.token]);
  });

  it("brings in a shared GatewayClass or load balancer but never walks on from it", () => {
    const { nodes, edges } = demoGraph();
    const model = buildModel(
      [...nodes, gnode("Gateway/other/internal"), gnode("Ingress/other/admin")],
      [
        ...edges,
        gedge("Gateway/other/internal", "class", DEMO.gatewayClass),
        gedge(DEMO.ingressLb, "routes", "Ingress/other/admin"),
      ],
    );
    const ids = namespaceView(model, new Set(["edge", "jobs", "other"]));
    expect(ids).toContain(DEMO.gatewayClass);
    expect(ids).toContain(DEMO.ingressLb);
    expect(ids).not.toContain("Gateway/other/internal");
    expect(ids).not.toContain("Ingress/other/admin");
  });

  it("brings the bindings of shown ServiceAccounts and the roles of shown bindings, one way", () => {
    const { nodes, edges } = rbacGraph();
    const model = buildModel(nodes, edges);
    // The ClusterRoleBinding of the nightly ServiceAccount comes in without the shop's
    // ServiceAccount it also binds, and its ClusterRole brings no other binding.
    expect(namespaceView(model, new Set(["shop", "edge"]))).toEqual([
      DEMO.cronJob,
      DEMO.job,
      DEMO.jobPod,
      DEMO.token,
      RBAC.nightly,
      RBAC.clusterBinding,
      RBAC.clusterRole,
      RBAC.nightlyBinding,
    ]);
    const shop = namespaceView(model, new Set(["edge", "jobs"]));
    expect(shop).toEqual(
      expect.arrayContaining([
        RBAC.binding,
        RBAC.role,
        RBAC.viewBinding,
        RBAC.clusterBinding,
        RBAC.clusterRole,
      ]),
    );
    expect(shop).not.toContain(RBAC.nightly);
    expect(shop).not.toContain(RBAC.nightlyBinding);
  });

  it("brings a shown binding's role even when its ServiceAccounts are elsewhere", () => {
    const { nodes, edges } = rbacGraph();
    const editor = gnode("RoleBinding/jobs/web-editor");
    const edit = gnode("ClusterRole//edit");
    const model = buildModel(
      [...nodes, editor, edit],
      [
        ...edges,
        gedge(editor.id, "binds", DEMO.account),
        gedge(editor.id, "grants", edit.id),
      ],
    );
    const ids = namespaceView(model, new Set(["shop", "edge"]));
    expect(ids).toContain(editor.id);
    expect(ids).toContain(edit.id);
    expect(ids).not.toContain(DEMO.account);
  });

  it("draws nothing when every namespace is hidden", () => {
    expect(
      namespaceView(demoModel(), new Set(["shop", "edge", "jobs"])),
    ).toEqual([]);
  });
});

describe("levels", () => {
  it("orders kinds the way in first, config, then bindings and roles last", () => {
    expect(levelOf("LoadBalancer")).toBe(0);
    expect(levelOf("HTTPRoute")).toBe(1);
    expect(levelOf("GatewayClass")).toBe(2);
    expect(levelOf("ReplicaSet")).toBe(3);
    expect(levelOf("Job")).toBe(4);
    expect(levelOf("Pod")).toBe(5);
    expect(levelOf("PersistentVolumeClaim")).toBe(9);
    expect(levelOf("RoleBinding")).toBe(10);
    expect(levelOf("ClusterRoleBinding")).toBe(10);
    expect(levelOf("Role")).toBe(11);
    expect(levelOf("ClusterRole")).toBe(11);
    expect(levelOf("Widget")).toBe(5);
  });

  it("sorts ids by level, then by name", () => {
    const model = demoModel();
    expect(
      levelSort(model, [DEMO.podB, DEMO.secret, DEMO.ingressLb, DEMO.podA]),
    ).toEqual([DEMO.ingressLb, DEMO.podA, DEMO.podB, DEMO.secret]);
  });
});

describe("namespaces", () => {
  const counts = [
    { namespace: "shop", nodes: 900 },
    { namespace: "argo", nodes: 400 },
    { namespace: "default", nodes: 0 },
    { namespace: "jobs", nodes: 300 },
  ];

  it("gives a chip to each namespace, by name", () => {
    expect(chipNamespaces(counts)).toEqual(["argo", "default", "jobs", "shop"]);
  });

  it("subscribes with null when nothing is hidden", () => {
    expect(subscribedNamespaces(["a", "b"], new Set())).toBeNull();
    expect(subscribedNamespaces(["a", "b", "c"], new Set(["b"]))).toEqual([
      "a",
      "c",
    ]);
  });

  it("hides nothing up to 1,500 nodes", () => {
    expect(MAX_NODES).toBe(1500);
    expect(autoHidden([{ namespace: "shop", nodes: 1500 }], null)).toBeNull();
  });

  it("keeps the default namespace when it has nodes", () => {
    expect(autoHidden(counts, "jobs")).toEqual(["argo", "default", "shop"]);
  });

  it("keeps the first namespace by name when the default one is empty", () => {
    expect(autoHidden(counts, "default")).toEqual(["default", "jobs", "shop"]);
    expect(autoHidden(counts, null)).toEqual(["default", "jobs", "shop"]);
  });

  describe("what the map asks for", () => {
    const small = [
      { namespace: "", nodes: 4 },
      { namespace: "jobs", nodes: 300 },
      { namespace: "shop", nodes: 1196 },
    ];

    it("is the counts alone until it knows them, unless nothing is hidden", () => {
      expect(graphFilter(null, null)).toEqual([]);
      expect(graphFilter(["shop"], null)).toEqual([]);
      expect(graphFilter([], null)).toBeNull();
      expect(countsFirst(null, null)).toBe(true);
      expect(countsFirst(["shop"], null)).toBe(true);
      expect(countsFirst([], null)).toBe(false);
    });

    it("is the whole graph with no saved choice, when the counts hold at most 1,500 nodes", () => {
      expect(graphFilter(null, small)).toBeNull();
      expect(countsFirst(null, small)).toBe(false);
    });

    it("stays the counts alone above 1,500 nodes, until a namespace is kept", () => {
      expect(graphFilter(null, counts)).toEqual([]);
      expect(countsFirst(null, counts)).toBe(true);
      const kept = autoHidden(counts, "jobs");
      expect(graphFilter(kept, counts)).toEqual(["jobs"]);
      expect(countsFirst(kept, counts)).toBe(false);
    });

    it("is the shown namespaces of a saved choice, whatever the counts", () => {
      expect(graphFilter(["shop"], counts)).toEqual([
        "argo",
        "default",
        "jobs",
      ]);
      expect(graphFilter([], counts)).toBeNull();
      expect(graphFilter(["argo", "default", "jobs", "shop"], counts)).toEqual(
        [],
      );
      expect(countsFirst(["argo", "default", "jobs", "shop"], counts)).toBe(
        false,
      );
    });
  });

  it("knows when too many nodes are shown", () => {
    expect(FORCE_MAX_NODES).toBe(400);
    expect(tooMany(new Array(1500).fill("x"))).toBe(false);
    expect(tooMany(new Array(1501).fill("x"))).toBe(true);
  });
});

describe("texts", () => {
  it("counts resources and namespaces of what is drawn", () => {
    const model = demoModel();
    expect(
      summaryText(model, namespaceView(model, new Set()), {
        total: 22,
        filtering: false,
      }),
    ).toBe("22 resources · 3 namespaces · 16 kinds");
    expect(
      summaryText(model, [DEMO.gateway], { total: 22, filtering: true }),
    ).toBe("1 of 22 resources · 1 namespace · 1 kind");
    expect(summaryText(model, [DEMO.podA, DEMO.podB], null)).toBe(
      "2 resources",
    );
    expect(summaryTitle(true)).toBe(
      "Drawn now, of every resource in the cluster",
    );
    expect(summaryTitle(false)).toBe("Every resource in the cluster");
    expect(countText(1742, "resource", "resources")).toBe("1,742 resources");
  });

  it("names lists the way the sidebar does", () => {
    expect(listLabel("secrets")).toBe("Secrets");
    expect(listLabel("serviceaccounts")).toBe("ServiceAccounts");
    expect(listLabel("persistentvolumeclaims")).toBe("PersistentVolumeClaims");
    expect(listLabel("gatewayclasses")).toBe("GatewayClasses");
    expect(listLabel("httproutes")).toBe("HTTPRoutes");
    expect(listLabel("listenersets")).toBe("ListenerSets");
    expect(listLabel("backendtlspolicies")).toBe("BackendTLSPolicies");
    expect(listLabel("widgets")).toBe("widgets");
    expect(listLabel("widgets", "Widget")).toBe("Widgets");
    // The other Gateway API kinds take Network's names (spec M4, M6).
    expect(listLabel("xmeshes", "XMesh")).toBe("XMeshes");
    expect(listLabel("xbackendtrafficpolicies", "XBackendTrafficPolicy")).toBe(
      "XBackendTrafficPolicies",
    );
    expect(listLabel("gizmos", "Gateway")).toBe("Gateways");
  });

  it("says which kinds the user cannot list", () => {
    expect(missingText(["secrets", "serviceaccounts"])).toBe(
      "Not shown: you cannot list Secrets, ServiceAccounts.",
    );
  });

  it("falls back to the status word without a status text", () => {
    const model = demoModel();
    expect(statusLine(gnode("Pod/shop/x", { status: "critical" }))).toBe(
      "Failing",
    );
    expect(statusLine(gnode("Pod/shop/x"))).toBe("Healthy");
    const node = model.byId.get(DEMO.podB);
    expect(node && statusLine(node)).toBe("CrashLoopBackOff");
  });
});

describe("the namespace view of policies and Argo CD", () => {
  function policyArgoModel() {
    const { nodes, edges } = policyArgoGraph();
    return buildModel(nodes, edges);
  }

  it("brings a cluster-wide policy that selects a member, and an Application that manages one with its project and ApplicationSet", () => {
    // The shop shown: its policies are members; the cluster-wide one selects the db Pod;
    // Application shop manages the Deployment. Application nightly manages only the hidden
    // CronJob and stays out, and the host policy selects nothing.
    expect(
      namespaceView(policyArgoModel(), new Set(["edge", "jobs", "argocd"])),
    ).toEqual([
      ...namespaceView(demoModel(), new Set(["edge", "jobs"])),
      POLICY.netpol,
      POLICY.cilium,
      POLICY.scrape,
      ARGO.appSet,
      ARGO.app,
      ARGO.project,
    ]);
  });

  it("walks on from nothing it brings", () => {
    // The jobs shown: the cluster-wide policy and Application nightly come in, with its
    // project and ApplicationSet, but neither the db Pod the policy also selects nor the
    // Application shop the ApplicationSet also owns.
    expect(
      namespaceView(policyArgoModel(), new Set(["shop", "edge", "argocd"])),
    ).toEqual([
      DEMO.cronJob,
      DEMO.job,
      DEMO.jobPod,
      DEMO.token,
      POLICY.scrape,
      ARGO.appSet,
      ARGO.nightly,
      ARGO.project,
    ]);
  });

  it("never brings what a shown Application manages", () => {
    expect(
      namespaceView(policyArgoModel(), new Set(["shop", "edge", "jobs"])),
    ).toEqual([ARGO.appSet, ARGO.app, ARGO.nightly, ARGO.project]);
  });

  it("levels the Argo CD kinds before the way in and the policies with the Services", () => {
    expect(levelOf("ApplicationSet")).toBe(-2);
    expect(levelOf("Application")).toBe(-1);
    expect(levelOf("AppProject")).toBe(-1);
    for (const kind of [
      "NetworkPolicy",
      "CiliumNetworkPolicy",
      "CiliumClusterwideNetworkPolicy",
    ]) {
      expect(levelOf(kind), kind).toBe(levelOf("Service"));
    }
  });
});
