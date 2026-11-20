import { expect, test } from "vitest";
import {
  MAP_ICON,
  OVERVIEW_ICON,
  SECTION_ICONS,
} from "../features/palette/icons";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import {
  customResourceGroups,
  GATEWAY_GROUPS,
  groupFromSegment,
  groupSegment,
  NAV_GROUPS,
  NAV_SCREENS,
  NAV_SECTIONS,
  navItemKey,
  navLabel,
  pluralKind,
  resourcePath,
  visibleSections,
} from "./nav";

function info(
  group: string,
  plural: string,
  over: Partial<ApiResourceInfo> = {},
  kind = plural,
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
    ...over,
  };
}

const EXPECTED: [string, string[]][] = [
  ["helm", ["route:helm/charts", "route:helm/releases"]],
  [
    "argo",
    [
      "argoproj.io/applications",
      "argoproj.io/applicationsets",
      "argoproj.io/appprojects",
    ],
  ],
  ["nodes", ["/nodes", "route:node-topology"]],
  ["namespaces", ["/namespaces"]],
  ["events", ["/events"]],
  [
    "workloads",
    [
      "/pods",
      "apps/deployments",
      "apps/daemonsets",
      "apps/statefulsets",
      "apps/replicasets",
      "batch/jobs",
      "batch/cronjobs",
    ],
  ],
  [
    "config",
    [
      "/configmaps",
      "/secrets",
      "/resourcequotas",
      "/limitranges",
      "autoscaling/horizontalpodautoscalers",
      "policy/poddisruptionbudgets",
      "scheduling.k8s.io/priorityclasses",
      "node.k8s.io/runtimeclasses",
      "coordination.k8s.io/leases",
      "admissionregistration.k8s.io/mutatingwebhookconfigurations",
      "admissionregistration.k8s.io/validatingwebhookconfigurations",
    ],
  ],
  [
    "network",
    [
      "/services",
      "discovery.k8s.io/endpointslices",
      "networking.k8s.io/ingresses",
      "networking.k8s.io/ingressclasses",
      "networking.k8s.io/networkpolicies",
      "gateway.networking.k8s.io/gatewayclasses",
      "gateway.networking.k8s.io/gateways",
      "gateway.networking.k8s.io/listenersets",
      "gateway.networking.k8s.io/httproutes",
      "gateway.networking.k8s.io/grpcroutes",
      "gateway.networking.k8s.io/tlsroutes",
      "gateway.networking.k8s.io/tcproutes",
      "gateway.networking.k8s.io/udproutes",
      "gateway.networking.k8s.io/backendtlspolicies",
      "gateway.networking.k8s.io/referencegrants",
      "route:port-forwards",
    ],
  ],
  [
    "storage",
    [
      "/persistentvolumeclaims",
      "/persistentvolumes",
      "storage.k8s.io/storageclasses",
    ],
  ],
  [
    "access",
    [
      "/serviceaccounts",
      "rbac.authorization.k8s.io/clusterroles",
      "rbac.authorization.k8s.io/roles",
      "rbac.authorization.k8s.io/clusterrolebindings",
      "rbac.authorization.k8s.io/rolebindings",
    ],
  ],
  [
    "devices",
    [
      "resource.k8s.io/resourceclaims",
      "resource.k8s.io/resourceclaimtemplates",
      "resource.k8s.io/deviceclasses",
      "resource.k8s.io/resourceslices",
    ],
  ],
  ["custom", ["apiextensions.k8s.io/customresourcedefinitions"]],
];

const allServed = () =>
  NAV_SECTIONS.flatMap((s) => s.items).flatMap((i) =>
    i.type === "resource" ? [info(i.group, i.plural)] : [],
  );

test("NAV_SECTIONS covers every F4 resource", () => {
  const actual = NAV_SECTIONS.map((s) => [s.id, s.items.map(navItemKey)]);
  expect(actual).toEqual(EXPECTED);
  expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
    "Helm",
    "Argo",
    "Nodes",
    "Namespaces",
    "Events",
    "Workloads",
    "Config",
    "Network",
    "Storage",
    "Access Control",
    "Device Resources",
    "Custom Resources",
  ]);
  expect(visibleSections(allServed())).toEqual(NAV_SECTIONS);
});

test("items not served are hidden", () => {
  const served = allServed().filter((r) => r.resource.plural !== "cronjobs");
  const workloads = visibleSections(served).find((s) => s.id === "workloads");
  expect(workloads?.items.map(navItemKey)).not.toContain("batch/cronjobs");
  expect(workloads?.items.map(navItemKey)).toContain("batch/jobs");
});

test("items the user cannot list are hidden", () => {
  const served = allServed().map((r) =>
    r.resource.plural === "secrets" ? { ...r, canList: false } : r,
  );
  const config = visibleSections(served).find((s) => s.id === "config");
  expect(config?.items.map(navItemKey)).not.toContain("/secrets");
  expect(config?.items.map(navItemKey)).toContain("/configmaps");
});

test("sections with no visible items disappear; routes need no listable resource", () => {
  const shape = (resources: ApiResourceInfo[]) =>
    visibleSections(resources).map((s) => [s.id, s.items.map(navItemKey)]);
  const helm: [string, string[]] = [
    "helm",
    ["route:helm/charts", "route:helm/releases"],
  ];
  expect(
    shape([info("", "pods"), info("", "nodes", { canList: false })]),
  ).toEqual([
    helm,
    ["workloads", ["/pods"]],
    ["network", ["route:port-forwards"]],
  ]);
  expect(shape([])).toEqual([helm, ["network", ["route:port-forwards"]]]);
});

test("Helm is an Apps section of two routes, with its logo", () => {
  expect(NAV_SECTIONS.find((s) => s.id === "helm")).toEqual({
    id: "helm",
    label: "Helm",
    group: "apps",
    icon: "helm",
    items: [
      { type: "route", label: "Charts", path: "helm/charts" },
      { type: "route", label: "Releases", path: "helm/releases" },
    ],
  });
});

test("the sections sit in their groups, in the design's order (spec Q §2)", () => {
  expect(NAV_GROUPS).toEqual([
    { id: "top", label: null },
    { id: "apps", label: "Apps" },
    { id: "cluster", label: "Cluster" },
    { id: "resources", label: "Resources" },
  ]);
  expect(NAV_SECTIONS.map((s) => [s.group, s.id])).toEqual([
    ["apps", "helm"],
    ["apps", "argo"],
    ["cluster", "nodes"],
    ["cluster", "namespaces"],
    ["cluster", "events"],
    ["resources", "workloads"],
    ["resources", "config"],
    ["resources", "network"],
    ["resources", "storage"],
    ["resources", "access"],
    ["resources", "devices"],
    ["resources", "custom"],
  ]);
});

test("Overview and Resource map are the screens of the first group", () => {
  expect(NAV_SCREENS.map((s) => [s.id, s.label, s.path, s.icon])).toEqual([
    ["overview", "Overview", "", OVERVIEW_ICON],
    ["map", "Resource map", "map", MAP_ICON],
  ]);
});

test("Helm and Argo show their logos; every other section the palette's icon", () => {
  for (const s of NAV_SECTIONS) {
    if (s.id === "helm" || s.id === "argo") {
      expect([s.id, s.icon]).toEqual([s.id, s.id]);
    } else {
      expect([s.id, SECTION_ICONS[s.id] !== undefined]).toEqual([s.id, true]);
      expect([s.id, s.icon]).toEqual([s.id, SECTION_ICONS[s.id]]);
    }
  }
});

test("Namespaces and Events are direct links to their only kind; Nodes holds List and Topology", () => {
  expect(
    NAV_SECTIONS.filter((s) => s.direct).map((s) => [
      s.id,
      s.items.map(navItemKey),
    ]),
  ).toEqual([
    ["namespaces", ["/namespaces"]],
    ["events", ["/events"]],
  ]);
  const nodes = NAV_SECTIONS.find((s) => s.id === "nodes");
  expect(
    nodes?.items.map((i) => [navItemKey(i), navLabel(i), i.label]),
  ).toEqual([
    ["/nodes", "List", "Nodes"],
    ["route:node-topology", "Topology", "Topology"],
  ]);
});

test("Topology shows only where nodes can be listed, so Nodes hides whole", () => {
  const nodes = (resources: ApiResourceInfo[]) =>
    visibleSections(resources)
      .find((s) => s.id === "nodes")
      ?.items.map(navItemKey);
  expect(nodes([info("", "nodes")])).toEqual(["/nodes", "route:node-topology"]);
  expect(nodes([info("", "nodes", { canList: false })])).toBeUndefined();
  expect(nodes([info("", "pods")])).toBeUndefined();
});

test("Argo holds one sub-branch, Argo CD, with its kinds; kinds not served leave it", () => {
  const argo = NAV_SECTIONS.find((s) => s.id === "argo");
  expect(argo?.label).toBe("Argo");
  expect(
    argo?.branches?.map((b) => [b.id, b.label, b.items.map(navItemKey)]),
  ).toEqual([
    [
      "argocd",
      "Argo CD",
      [
        "argoproj.io/applications",
        "argoproj.io/applicationsets",
        "argoproj.io/appprojects",
      ],
    ],
  ]);
  expect(
    NAV_SECTIONS.filter((s) => s.branches !== undefined).map((s) => s.id),
  ).toEqual(["argo"]);
  const shown = visibleSections([info("argoproj.io", "applications")]).find(
    (s) => s.id === "argo",
  );
  expect(shown?.branches?.map((b) => b.items.map(navItemKey))).toEqual([
    ["argoproj.io/applications"],
  ]);
});

test("the Network group ends with Port Forwarding, a route of the cluster screen", () => {
  expect(NAV_SECTIONS.find((s) => s.id === "network")?.items.at(-1)).toEqual({
    type: "route",
    label: "Port Forwarding",
    path: "port-forwards",
  });
});

test("custom resources group by API group and exclude built-ins", () => {
  const groups = customResourceGroups([
    info("", "pods"),
    info("apps", "deployments"),
    info("apiextensions.k8s.io", "customresourcedefinitions"),
    info("zeta.io", "widgets", {}, "Widget"),
    info("acme.io", "gadgets", {}, "Gadget"),
    info("acme.io", "bolts", {}, "Bolt"),
    info("acme.io", "hidden", { canList: false }, "Hidden"),
  ]);
  expect(groups).toEqual([
    {
      group: "acme.io",
      items: [
        { label: "Bolt", plural: "bolts" },
        { label: "Gadget", plural: "gadgets" },
      ],
    },
    { group: "zeta.io", items: [{ label: "Widget", plural: "widgets" }] },
  ]);
});

test("the core group is spelled core in URLs", () => {
  expect(groupSegment("")).toBe("core");
  expect(groupSegment("apps")).toBe("apps");
  expect(groupFromSegment("core")).toBe("");
  expect(groupFromSegment("apps")).toBe("apps");
  expect(resourcePath("c1", "", "pods")).toBe("/cluster/c1/r/core/pods");
});

test("Workloads has an Overview entry and no other section does", () => {
  expect(
    NAV_SECTIONS.filter((s) => s.overview !== undefined).map((s) => [
      s.id,
      s.overview,
    ]),
  ).toEqual([["workloads", "workloads"]]);
  expect(
    visibleSections(allServed()).find((s) => s.id === "workloads")?.overview,
  ).toBe("workloads");
});

test("each Argo CD page shows only when its kind is served", () => {
  const argo = (resources: ApiResourceInfo[]) =>
    visibleSections(resources)
      .find((s) => s.id === "argo")
      ?.items.map(navItemKey);
  expect(argo([info("", "pods")])).toBeUndefined();
  expect(
    argo([
      info("argoproj.io", "applications"),
      info("argoproj.io", "appprojects"),
    ]),
  ).toEqual(["argoproj.io/applications", "argoproj.io/appprojects"]);
});

test("the Gateway API kinds sit in Network between NetworkPolicies and Port Forwarding", () => {
  const network = NAV_SECTIONS.find((s) => s.id === "network");
  const keys = network?.items.map(navItemKey) ?? [];
  const at = keys.indexOf("networking.k8s.io/networkpolicies");
  expect(keys.slice(at + 1)).toEqual([
    "gateway.networking.k8s.io/gatewayclasses",
    "gateway.networking.k8s.io/gateways",
    "gateway.networking.k8s.io/listenersets",
    "gateway.networking.k8s.io/httproutes",
    "gateway.networking.k8s.io/grpcroutes",
    "gateway.networking.k8s.io/tlsroutes",
    "gateway.networking.k8s.io/tcproutes",
    "gateway.networking.k8s.io/udproutes",
    "gateway.networking.k8s.io/backendtlspolicies",
    "gateway.networking.k8s.io/referencegrants",
    "route:port-forwards",
  ]);
  expect(network?.items.slice(5, 15).map((i) => i.label)).toEqual([
    "GatewayClasses",
    "Gateways",
    "ListenerSets",
    "HTTPRoutes",
    "GRPCRoutes",
    "TLSRoutes",
    "TCPRoutes",
    "UDPRoutes",
    "BackendTLSPolicies",
    "ReferenceGrants",
  ]);
});

test("GATEWAY_GROUPS holds the standard and the experimental group", () => {
  expect([...GATEWAY_GROUPS].sort()).toEqual([
    "gateway.networking.k8s.io",
    "gateway.networking.x-k8s.io",
  ]);
});

test("Network adds the other listable kinds of both Gateway API groups, sorted, before Port Forwarding", () => {
  const network = (resources: ApiResourceInfo[]) =>
    visibleSections(resources).find((s) => s.id === "network")?.items ?? [];
  const items = network([
    info("gateway.networking.k8s.io", "gateways", {}, "Gateway"),
    info("gateway.networking.k8s.io", "referencegrants", {}, "ReferenceGrant"),
    info("gateway.networking.x-k8s.io", "xmeshes", {}, "XMesh"),
    info("gateway.networking.x-k8s.io", "xbackends", {}, "XBackend"),
    info(
      "gateway.networking.x-k8s.io",
      "xtelemetrypolicies",
      {},
      "XTelemetryPolicy",
    ),
    info(
      "gateway.networking.x-k8s.io",
      "xbackendtrafficpolicies",
      {},
      "XBackendTrafficPolicy",
    ),
    info("gateway.networking.k8s.io", "futureroutes", {}, "FutureRoute"),
    info(
      "gateway.networking.x-k8s.io",
      "xhidden",
      { canList: false },
      "XHidden",
    ),
    info("example.com", "widgets", {}, "Widget"),
  ]);
  expect(items.map((i) => [navItemKey(i), i.label])).toEqual([
    ["gateway.networking.k8s.io/gateways", "Gateways"],
    ["gateway.networking.k8s.io/referencegrants", "ReferenceGrants"],
    ["gateway.networking.k8s.io/futureroutes", "FutureRoutes"],
    ["gateway.networking.x-k8s.io/xbackends", "XBackends"],
    [
      "gateway.networking.x-k8s.io/xbackendtrafficpolicies",
      "XBackendTrafficPolicies",
    ],
    ["gateway.networking.x-k8s.io/xmeshes", "XMeshes"],
    ["gateway.networking.x-k8s.io/xtelemetrypolicies", "XTelemetryPolicies"],
    ["route:port-forwards", "Port Forwarding"],
  ]);
  expect(items[2]).toEqual({
    type: "resource",
    label: "FutureRoutes",
    group: "gateway.networking.k8s.io",
    plural: "futureroutes",
  });
  // NAV_SECTIONS itself stays static.
  expect(
    NAV_SECTIONS.flatMap((s) => s.items).some(
      (i) => i.type === "resource" && i.plural === "xmeshes",
    ),
  ).toBe(false);
});

test("pluralKind adds es, ies or s", () => {
  expect(pluralKind("XMesh")).toBe("XMeshes");
  expect(pluralKind("XBackendTrafficPolicy")).toBe("XBackendTrafficPolicies");
  expect(pluralKind("Gateway")).toBe("Gateways");
  expect(pluralKind("Ingress")).toBe("Ingresses");
  expect(pluralKind("Box")).toBe("Boxes");
  expect(pluralKind("Quiz")).toBe("Quizes");
  expect(pluralKind("Patch")).toBe("Patches");
  expect(pluralKind("Key")).toBe("Keys");
  expect(pluralKind("Widget")).toBe("Widgets");
});

test("custom resources leave out the kinds a section lists, and both Gateway API groups whole", () => {
  const groups = customResourceGroups([
    info("argoproj.io", "applications", {}, "Application"),
    info("argoproj.io", "appprojects", {}, "AppProject"),
    info("argoproj.io", "rollouts", {}, "Rollout"),
    info("gateway.networking.k8s.io", "gateways", {}, "Gateway"),
    info("gateway.networking.k8s.io", "futureroutes", {}, "FutureRoute"),
    info("gateway.networking.x-k8s.io", "xmeshes", {}, "XMesh"),
  ]);
  expect(groups).toEqual([
    { group: "argoproj.io", items: [{ label: "Rollout", plural: "rollouts" }] },
  ]);
});
