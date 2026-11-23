import { describe, expect, test } from "vitest";
import {
  IDS,
  paymentsSnapshot,
  rcell,
  rgroup,
  rhttp,
  rport,
  rref,
  rsnapshot,
} from "../../test/reachability";
import {
  capText,
  cellOf,
  countChips,
  httpText,
  MATRIX_CAP,
  matrixColumns,
  matrixRows,
  missingLine,
  notEvaluatedChip,
  panelOf,
  policyLine,
  policyTag,
  policyTarget,
  policyTestId,
  portText,
  startNamespace,
} from "./reachModel";

const PAYMENTS = paymentsSnapshot();

describe("portText", () => {
  test("TCP is not written, and a number with TCP and UDP reads UDP, TCP", () => {
    expect(portText([rport(8080)])).toBe("8080");
    expect(portText([rport(53, "TCP"), rport(53, "UDP")])).toBe("53 UDP, TCP");
    expect(portText([rport(53, "UDP"), rport(53, "TCP")])).toBe("53 UDP, TCP");
    expect(portText([rport(53, "UDP")])).toBe("53 UDP");
    expect(portText([rport(9000, "SCTP"), rport(9000, "UDP")])).toBe(
      "9000 UDP, SCTP",
    );
    expect(portText([rport(53, "ANY")])).toBe("53 ANY");
  });

  test("several numbers are joined in the core's order", () => {
    expect(portText([rport(8080), rport(9090)])).toBe("8080, 9090");
    expect(portText([rport(53, "UDP"), rport(8080)])).toBe("53 UDP, 8080");
  });

  test("a range, a name that did not resolve, and every port", () => {
    expect(portText([rport(8000, "TCP", { endPort: 8080 })])).toBe("8000-8080");
    expect(portText([rport(8080, "TCP", { endPort: 8080 })])).toBe("8080");
    expect(portText([rport(null, "TCP", { name: "http" })])).toBe("http");
    expect(portText([rport(null, "TCP")])).toBe("All");
    expect(portText([rport(null, "ANY")])).toBe("All");
    expect(portText([rport(null, "UDP")])).toBe("All UDP");
    expect(portText([rport(null, "SCTP")])).toBe("All SCTP");
    expect(portText([])).toBe("All");
  });

  test("one HTTP rule is written after its port, more as a count", () => {
    expect(
      portText([
        rport(8080, "TCP", {
          http: [rhttp({ method: "GET", path: "/api/.*" })],
        }),
      ]),
    ).toBe("8080 GET /api/.*");
    expect(
      portText([
        rport(8080, "TCP", {
          http: [
            rhttp({ method: "GET" }),
            rhttp({ path: "/health" }),
            rhttp({ host: "api.example.com" }),
          ],
        }),
      ]),
    ).toBe("8080 HTTP ×3");
  });
});

test("httpText writes the method and path, then host and headers", () => {
  expect(httpText(rhttp({ method: "GET", path: "/api/.*" }))).toBe(
    "GET /api/.*",
  );
  expect(httpText(rhttp({ method: "POST" }))).toBe("POST");
  expect(httpText(rhttp({ path: "/health" }))).toBe("/health");
  expect(
    httpText(
      rhttp({
        method: "GET",
        host: "api.example.com",
        headers: ["X-Team: a", "X-Env: prod"],
      }),
    ),
  ).toBe("GET host api.example.com header X-Team: a header X-Env: prod");
  expect(httpText(rhttp())).toBe("HTTP");
});

test("policy tags, tooltip lines, chip test ids and drawer targets", () => {
  const k8s = rref("kubernetes", "allow-dns");
  const cilium = rref("cilium", "allow-api-from-web");
  const cluster = rref("ciliumClusterwide", "allow-prometheus-scrape");
  expect([k8s, cilium, cluster].map((r) => policyTag(r.source))).toEqual([
    "K8s",
    "Cilium",
    "Cilium cluster",
  ]);
  expect([k8s, cilium, cluster].map(policyLine)).toEqual([
    "K8s allow-dns",
    "Cilium allow-api-from-web",
    "Cilium cluster allow-prometheus-scrape",
  ]);
  expect(policyTestId(k8s)).toBe("reach-policy-kubernetes-payments-allow-dns");
  expect(policyTestId(cluster)).toBe(
    "reach-policy-ciliumClusterwide--allow-prometheus-scrape",
  );
  expect([k8s, cilium, cluster].map(policyTarget)).toEqual([
    {
      group: "networking.k8s.io",
      plural: "networkpolicies",
      key: "payments/allow-dns",
    },
    {
      group: "cilium.io",
      plural: "ciliumnetworkpolicies",
      key: "payments/allow-api-from-web",
    },
    {
      group: "cilium.io",
      plural: "ciliumclusterwidenetworkpolicies",
      key: "/allow-prometheus-scrape",
    },
  ]);
});

/** Every cell text of the sample namespace, row by row (contract C13). */
const C13_TEXTS = [
  ["api", ["—", "5432", "—", "—", "53 UDP, TCP", "443", "—", "—"]],
  ["db", ["—", "—", "—", "—", "53 UDP, TCP", "Denied", "—", "Denied"]],
  ["web", ["8080 GET /api/.*", "—", "—", "—", "53 UDP, TCP", "—", "—", "—"]],
  ["worker", ["—", "—", "—", "All", "All", "All", "All", "All"]],
  [
    "ingress-nginx/ingress-nginx-controller",
    ["—", "—", "8080", "All", "·", "·", "·", "·"],
  ],
  [
    "monitoring/prometheus",
    ["9090", "9090", "9090", "All", "·", "·", "·", "·"],
  ],
  ["Other Pods in the cluster", ["—", "—", "—", "All", "·", "·", "·", "·"]],
  ["Outside the cluster", ["—", "—", "—", "All", "·", "·", "·", "·"]],
];

test("the sample namespace's rows, columns and cells read as the board", () => {
  const rows = matrixRows(PAYMENTS, "");
  const columns = matrixColumns(PAYMENTS, "");
  expect(rows.map((r) => [r.label, r.sub, r.outside])).toEqual([
    ["api", "6 policies", false],
    ["db", "5 policies", false],
    ["web", "5 policies", false],
    ["worker", "No policy", false],
    ["ingress-nginx/ingress-nginx-controller", "Deployment · 1 Pod", true],
    ["monitoring/prometheus", "Deployment · 1 Pod", true],
    ["Other Pods in the cluster", "Pods the rules above do not name", true],
    ["Outside the cluster", "Addresses the rules above do not name", true],
  ]);
  expect(columns.map((c) => [c.label, c.outside])).toEqual([
    ["api", false],
    ["db", false],
    ["web", false],
    ["worker", false],
    ["kube-system/coredns", true],
    ["api.stripe.com", true],
    ["Other Pods in the cluster", true],
    ["Outside the cluster", true],
  ]);
  expect(
    rows.map((r) => [
      r.label,
      columns.map((c) => cellOf(PAYMENTS, r.id, c.id).text),
    ]),
  ).toEqual(C13_TEXTS);
});

test("missing cells are derived from the isolation flags (R4)", () => {
  expect(cellOf(PAYMENTS, IDS.worker, IDS.worker).verdict).toBe("open");
  expect(cellOf(PAYMENTS, IDS.worker, IDS.web).verdict).toBe("blocked");
  expect(cellOf(PAYMENTS, IDS.web, IDS.worker).verdict).toBe("blocked");
  expect(cellOf(PAYMENTS, IDS.world, IDS.worker).verdict).toBe("open");
  expect(cellOf(PAYMENTS, IDS.ingress, IDS.otherPods)).toMatchObject({
    verdict: null,
    text: "·",
    tip: [],
  });
});

test("a cell's tooltip names the verdict, the ports and every policy", () => {
  expect(cellOf(PAYMENTS, IDS.web, IDS.api).tip).toEqual([
    "Allowed",
    "8080 GET /api/.*",
    "K8s allow-web-to-api",
    "Cilium allow-api-from-web",
  ]);
  expect(cellOf(PAYMENTS, IDS.prometheus, IDS.db).tip).toEqual([
    "Allowed",
    "9090",
    "Cilium cluster allow-prometheus-scrape",
  ]);
  expect(cellOf(PAYMENTS, IDS.db, IDS.world).tip).toEqual([
    "Denied",
    "Cilium db-no-internet",
    "Policies of the other side apply too.",
  ]);
  expect(cellOf(PAYMENTS, IDS.db, IDS.stripe).tip).toEqual([
    "Denied",
    "Cilium db-no-internet",
  ]);
  expect(cellOf(PAYMENTS, IDS.worker, IDS.worker).tip).toEqual(["Open"]);
  expect(cellOf(PAYMENTS, IDS.worker, IDS.web).tip).toEqual(["Blocked"]);
  expect(cellOf(PAYMENTS, IDS.otherPods, IDS.worker).tip).toEqual([
    "Open",
    "Policies of the other side apply too.",
  ]);
});

test("a cell the core sends with Some Pods keeps its verdict and says so", () => {
  const groups = [
    rgroup("Deployment", "shop", "cart", {
      policies: [rref("kubernetes", "a", "shop")],
    }),
    rgroup("Deployment", "shop", "pay"),
  ];
  const snapshot = rsnapshot("shop", groups, {
    cells: [
      rcell(groups[1]?.id ?? "", groups[0]?.id ?? "", "open", [], [], true),
    ],
  });
  expect(
    cellOf(snapshot, groups[1]?.id ?? "", groups[0]?.id ?? ""),
  ).toMatchObject({
    verdict: "open",
    text: "All",
    somePods: true,
  });
});

test("the filter keeps names and labels, case-insensitive, on both axes", () => {
  expect(matrixRows(PAYMENTS, "API").map((r) => r.label)).toEqual(["api"]);
  expect(matrixColumns(PAYMENTS, "api").map((c) => c.label)).toEqual([
    "api",
    "api.stripe.com",
  ]);
  expect(matrixRows(PAYMENTS, "tier=").map((r) => r.label)).toEqual([
    "api",
    "db",
    "web",
  ]);
  expect(matrixRows(PAYMENTS, "  Outside ").map((r) => r.label)).toEqual([
    "Outside the cluster",
  ]);
  expect(matrixRows(PAYMENTS, "nothing")).toEqual([]);
});

test("at most 100 workloads are drawn, with a line that says how many there are", () => {
  const groups = Array.from({ length: 150 }, (_, i) =>
    rgroup("Deployment", "big", `app-${String(i).padStart(3, "0")}`),
  );
  const big = rsnapshot("big", groups);
  const rows = matrixRows(big, "");
  expect(rows.filter((r) => !r.outside)).toHaveLength(MATRIX_CAP);
  expect(rows.filter((r) => r.outside).map((r) => r.label)).toEqual([
    "Other Pods in the cluster",
    "Outside the cluster",
  ]);
  expect(matrixColumns(big, "").filter((c) => !c.outside)).toHaveLength(100);
  expect(capText(big, "")).toBe(
    "Showing 100 of 150 workloads. Filter to see the rest.",
  );
  expect(capText(rsnapshot("big", groups, { truncated: 1200 }), "")).toBe(
    "Showing 100 of 1,350 workloads. Filter to see the rest.",
  );
  // With a filter, only the workloads the core sent can match.
  expect(capText(rsnapshot("big", groups, { truncated: 1200 }), "APP-")).toBe(
    "Showing 100 of 150 workloads. Filter to see the rest.",
  );
  expect(capText(big, "app-0")).toBeNull();
  expect(capText(PAYMENTS, "")).toBeNull();
});

test("the bar's chips count each source's policies and list what was not evaluated", () => {
  expect(countChips(PAYMENTS)).toEqual([
    { source: "kubernetes", tag: "K8s", text: "6 policies" },
    { source: "cilium", tag: "Cilium", text: "4 policies" },
  ]);
  expect(
    countChips(
      rsnapshot("one", [], {
        counts: { kubernetes: 1, cilium: 1 },
        cilium: true,
      }),
    ),
  ).toEqual([
    { source: "kubernetes", tag: "K8s", text: "1 policy" },
    { source: "cilium", tag: "Cilium", text: "1 policy" },
  ]);
  expect(countChips(rsnapshot("plain")).map((c) => c.tag)).toEqual(["K8s"]);

  expect(notEvaluatedChip(PAYMENTS)).toEqual({
    text: "1 rule not evaluated",
    lines: ["api-egress-stripe: rules.dns"],
  });
  const two = rsnapshot("two", [], {
    notEvaluated: [
      { policy: rref("cilium", "a"), field: "rules.dns" },
      { policy: rref("cilium", "b"), field: "toServices" },
    ],
  });
  expect(notEvaluatedChip(two)).toEqual({
    text: "2 rules not evaluated",
    lines: ["a: rules.dns", "b: toServices"],
  });
  expect(notEvaluatedChip(rsnapshot("none"))).toBeNull();
});

test("a kind that cannot be listed is named by its sidebar label (R5)", () => {
  expect(
    missingLine({ plural: "networkpolicies", reason: "listing is forbidden" }),
  ).toBe(
    "NetworkPolicies cannot be listed: listing is forbidden. Connections may be wrong.",
  );
  expect(
    missingLine({
      plural: "namespaces",
      reason: "the cluster no longer serves it.",
    }),
  ).toBe(
    "Namespaces cannot be listed: the cluster no longer serves it. Connections may be wrong.",
  );
});

describe("panelOf", () => {
  test("an isolated workload lists what may reach it and where it may go", () => {
    expect(panelOf(PAYMENTS, IDS.api)).toEqual({
      id: IDS.api,
      name: "api",
      header: "Deployment · 2 Pods · app=api, tier=backend",
      warning: null,
      ins: [
        {
          id: IDS.web,
          peer: "web",
          detail: "Deployment · 3 Pods",
          ports: "8080",
          tone: "allowed",
          somePods: false,
          http: ["GET /api/.*"],
          chips: [
            {
              ref: rref("kubernetes", "allow-web-to-api"),
              tag: "K8s",
              name: "allow-web-to-api",
              testId: "reach-policy-kubernetes-payments-allow-web-to-api",
            },
            {
              ref: rref("cilium", "allow-api-from-web"),
              tag: "Cilium",
              name: "allow-api-from-web",
              testId: "reach-policy-cilium-payments-allow-api-from-web",
            },
          ],
        },
        {
          id: IDS.prometheus,
          peer: "monitoring/prometheus",
          detail: "Deployment · 1 Pod",
          ports: "9090",
          tone: "allowed",
          somePods: false,
          http: [],
          chips: [
            {
              ref: rref("ciliumClusterwide", "allow-prometheus-scrape"),
              tag: "Cilium cluster",
              name: "allow-prometheus-scrape",
              testId: "reach-policy-ciliumClusterwide--allow-prometheus-scrape",
            },
          ],
        },
      ],
      outs: [
        expect.objectContaining({
          id: IDS.db,
          peer: "db",
          detail: "StatefulSet · 1 Pod",
          ports: "5432",
        }),
        expect.objectContaining({
          id: IDS.coredns,
          peer: "kube-system/coredns",
          detail: "Deployment · 2 Pods",
          ports: "53 UDP, TCP",
        }),
        expect.objectContaining({
          id: IDS.stripe,
          peer: "api.stripe.com",
          detail: "DNS name",
          ports: "443",
        }),
      ],
      foot: "Every other connection in and out is blocked.",
    });
  });

  test("a Denied entry reads Denied with its deny policies", () => {
    const db = panelOf(PAYMENTS, IDS.db);
    expect(db.outs.map((e) => [e.peer, e.ports, e.tone])).toEqual([
      ["kube-system/coredns", "53 UDP, TCP", "allowed"],
      ["api.stripe.com", "Denied", "denied"],
      ["Outside the cluster", "Denied", "denied"],
    ]);
    expect(db.outs[2]?.chips.map((c) => `${c.tag} ${c.name}`)).toEqual([
      "Cilium db-no-internet",
    ]);
    expect(db.ins.map((e) => e.peer)).toEqual(["api", "monitoring/prometheus"]);
  });

  test("an open workload reads Any source and Anywhere with all ports and no chips", () => {
    expect(panelOf(PAYMENTS, IDS.worker)).toEqual({
      id: IDS.worker,
      name: "worker",
      header: "Deployment · 2 Pods · app=worker",
      warning:
        "No policy selects the Pods of worker, so every connection in and out is allowed.",
      ins: [
        {
          id: "any",
          peer: "Any source",
          detail: null,
          ports: "All ports",
          tone: "open",
          somePods: false,
          http: [],
          chips: [],
        },
      ],
      outs: [
        {
          id: "any",
          peer: "Anywhere",
          detail: null,
          ports: "All ports",
          tone: "open",
          somePods: false,
          http: [],
          chips: [],
        },
      ],
      foot: null,
    });
  });

  test("one open direction warns about it and the other ends with its blocked line", () => {
    const egressOnly = rgroup("Deployment", "shop", "cart", {
      labels: [],
      pods: 1,
      policies: [rref("kubernetes", "egress", "shop")],
      ingressIsolated: false,
      egressIsolated: true,
    });
    const ingressOnly = rgroup("Deployment", "shop", "pay", {
      labels: [],
      policies: [rref("kubernetes", "ingress", "shop")],
      ingressIsolated: true,
      egressIsolated: false,
    });
    const snapshot = rsnapshot("shop", [egressOnly, ingressOnly]);
    expect(panelOf(snapshot, egressOnly.id)).toMatchObject({
      header: "Deployment · 1 Pod",
      warning:
        "No policy selects the Pods of cart, so every connection in is allowed.",
      foot: "Every other connection out is blocked.",
      outs: [],
    });
    expect(panelOf(snapshot, ingressOnly.id)).toMatchObject({
      warning:
        "No policy selects the Pods of pay, so every connection out is allowed.",
      foot: "Every other connection in is blocked.",
      ins: [],
    });
  });

  test("HTTP rules say ingress or egress when both sides limit L7", () => {
    const [web, api] = [
      rgroup("Deployment", "shop", "web", {
        policies: [rref("cilium", "w", "shop")],
      }),
      rgroup("Deployment", "shop", "api", {
        policies: [rref("cilium", "a", "shop")],
      }),
    ];
    if (web === undefined || api === undefined) throw new Error("no groups");
    const snapshot = rsnapshot("shop", [web, api], {
      cells: [
        rcell(
          web.id,
          api.id,
          "allowed",
          [
            rport(8080, "TCP", {
              http: [
                rhttp({ side: "ingress", method: "GET", path: "/api/.*" }),
                rhttp({ side: "egress", host: "api.example.com" }),
                rhttp({ side: "egress", headers: ["X-Team: a"] }),
              ],
            }),
          ],
          [rref("cilium", "a", "shop"), rref("cilium", "w", "shop")],
        ),
      ],
    });
    expect(panelOf(snapshot, api.id).ins).toEqual([
      expect.objectContaining({
        peer: "web",
        ports: "8080",
        http: [
          "ingress GET /api/.*",
          "egress host api.example.com",
          "egress header X-Team: a",
        ],
      }),
    ]);
    expect(cellOf(snapshot, web.id, api.id).text).toBe("8080 HTTP ×3");
  });

  test("an id the snapshot does not hold gives an empty panel", () => {
    expect(panelOf(PAYMENTS, "Deployment/payments/gone")).toEqual({
      id: "Deployment/payments/gone",
      name: "",
      header: "",
      warning: null,
      ins: [],
      outs: [],
      foot: null,
    });
  });
});

test("the namespace starts on ns, then the sidebar filter, then the last pick, then default (R8)", () => {
  expect(startNamespace("payments", ["shop"], "kube-system")).toBe("payments");
  expect(startNamespace(null, ["shop", "payments"], "kube-system")).toBe(
    "shop",
  );
  expect(startNamespace("", [], "kube-system")).toBe("kube-system");
  expect(startNamespace(null, [], null)).toBe("default");
  expect(startNamespace(null, [], "")).toBe("default");
});
