import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../objects";
import { kindSpec } from "../registry";
import {
  conditionStatus,
  gatewayAddress,
  listenerSetParent,
  policyTargets,
  routeHostnames,
  routeParents,
} from "./gateway";
import "./index";

const GROUP = "gateway.networking.k8s.io";

function obj(over: Partial<KubeObject> = {}): KubeObject {
  return { metadata: { name: "edge", namespace: "web" }, ...over };
}

function info(plural: string, kind: string, namespaced: boolean) {
  return {
    resource: { group: GROUP, version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  } satisfies ApiResourceInfo;
}

const columns = (plural: string, kind: string, namespaced: boolean) =>
  kindSpec(GROUP, plural)?.columns?.(info(plural, kind, namespaced)) ?? [];

function cell(
  plural: string,
  kind: string,
  namespaced: boolean,
  id: string,
  o: KubeObject,
) {
  const column = columns(plural, kind, namespaced).find((c) => c.id === id);
  // Scoped to its own render, so a test can read several cells.
  const view = render(<div data-testid="cell">{column?.render(o)}</div>);
  return within(view.container).getByTestId("cell");
}

describe("conditionStatus", () => {
  it("reads True, False and Unknown, and nothing for a missing condition", () => {
    const withStatus = (status: string) =>
      obj({ status: { conditions: [{ type: "Programmed", status }] } });
    expect(conditionStatus(withStatus("True"), "Programmed")).toEqual({
      label: "True",
      tone: "ok",
    });
    expect(conditionStatus(withStatus("False"), "Programmed")).toEqual({
      label: "False",
      tone: "danger",
    });
    expect(conditionStatus(withStatus("Unknown"), "Programmed")).toEqual({
      label: "Unknown",
      tone: "neutral",
    });
    expect(conditionStatus(withStatus("True"), "Accepted")).toBeNull();
    expect(conditionStatus(obj(), "Accepted")).toBeNull();
  });
});

describe("gatewayAddress", () => {
  it("shows the first address, then +N for the rest, or a dash", () => {
    expect(gatewayAddress(obj())).toBe("—");
    expect(
      gatewayAddress(obj({ status: { addresses: [{ value: "10.0.0.5" }] } })),
    ).toBe("10.0.0.5");
    expect(
      gatewayAddress(
        obj({
          status: {
            addresses: [
              { value: "10.0.0.5" },
              { value: "10.0.0.6" },
              { value: "10.0.0.7" },
            ],
          },
        }),
      ),
    ).toBe("10.0.0.5 +2");
  });
});

describe("routeHostnames and routeParents", () => {
  it("join the hostnames, or a dash", () => {
    expect(routeHostnames(obj())).toBe("—");
    expect(routeHostnames(obj({ spec: { hostnames: ["shop", "api"] } }))).toBe(
      "shop, api",
    );
  });

  it("name each parent with the route's namespace when it gives none", () => {
    expect(routeParents(obj())).toBe("—");
    expect(
      routeParents(
        obj({
          spec: {
            parentRefs: [
              { name: "edge" },
              { name: "shared", namespace: "infra" },
            ],
          },
        }),
      ),
    ).toBe("web/edge, infra/shared");
  });
});

describe("listenerSetParent and policyTargets", () => {
  it("name the ListenerSet's parent, with its own namespace when the reference gives none, or a dash", () => {
    expect(listenerSetParent(obj())).toBe("—");
    expect(listenerSetParent(obj({ spec: { parentRef: {} } }))).toBe("—");
    expect(
      listenerSetParent(obj({ spec: { parentRef: { name: "edge" } } })),
    ).toBe("web/edge");
    expect(
      listenerSetParent(
        obj({
          spec: {
            parentRef: {
              group: "gateway.networking.k8s.io",
              kind: "Gateway",
              name: "shared",
              namespace: "infra",
            },
          },
        }),
      ),
    ).toBe("infra/shared");
  });

  it("list each target as kind/name, with :sectionName when set, or a dash", () => {
    expect(policyTargets(obj())).toBe("—");
    expect(policyTargets(obj({ spec: { targetRefs: [] } }))).toBe("—");
    expect(policyTargets(obj({ spec: { targetRefs: [{ name: "x" }] } }))).toBe(
      "—",
    );
    expect(
      policyTargets(
        obj({
          spec: {
            targetRefs: [
              { group: "", kind: "Service", name: "web" },
              { group: "", kind: "Service", name: "api", sectionName: "https" },
            ],
          },
        }),
      ),
    ).toBe("Service/web, Service/api:https");
  });
});

describe("the Gateway API columns", () => {
  it("follow the spec's table after Name and Namespace", () => {
    const headers = (plural: string, kind: string, namespaced: boolean) =>
      columns(plural, kind, namespaced).map((c) => c.header);
    expect(headers("gatewayclasses", "GatewayClass", false)).toEqual([
      "Name",
      "Controller",
      "Accepted",
      "Age",
    ]);
    expect(headers("gateways", "Gateway", true)).toEqual([
      "Name",
      "Namespace",
      "Class",
      "Address",
      "Programmed",
      "Age",
    ]);
    expect(headers("httproutes", "HTTPRoute", true)).toEqual([
      "Name",
      "Namespace",
      "Hostnames",
      "Parents",
      "Age",
    ]);
    for (const [plural, kind] of [
      ["grpcroutes", "GRPCRoute"],
      ["tlsroutes", "TLSRoute"],
    ]) {
      expect(headers(plural, kind, true)).toEqual([
        "Name",
        "Namespace",
        "Hostnames",
        "Parents",
        "Age",
      ]);
    }
    for (const [plural, kind] of [
      ["tcproutes", "TCPRoute"],
      ["udproutes", "UDPRoute"],
    ]) {
      expect(headers(plural, kind, true)).toEqual([
        "Name",
        "Namespace",
        "Parents",
        "Age",
      ]);
    }
    expect(headers("listenersets", "ListenerSet", true)).toEqual([
      "Name",
      "Namespace",
      "Parent",
      "Accepted",
      "Programmed",
      "Age",
    ]);
    expect(headers("backendtlspolicies", "BackendTLSPolicy", true)).toEqual([
      "Name",
      "Namespace",
      "Targets",
      "Hostname",
      "Age",
    ]);
    // ReferenceGrant keeps the default columns.
    expect(kindSpec(GROUP, "referencegrants")).toBeUndefined();
  });

  it("show a ListenerSet's parent and conditions, and dashes without them", () => {
    const set = obj({
      spec: { parentRef: { name: "edge" } },
      status: {
        conditions: [
          { type: "Accepted", status: "True" },
          { type: "Programmed", status: "False" },
        ],
      },
    });
    expect(
      cell("listenersets", "ListenerSet", true, "parent", set).textContent,
    ).toBe("web/edge");
    expect(
      cell("listenersets", "ListenerSet", true, "accepted", set).textContent,
    ).toBe("True");
    expect(
      cell("listenersets", "ListenerSet", true, "programmed", obj())
        .textContent,
    ).toBe("—");
  });

  it("show a BackendTLSPolicy's targets and hostname, and dashes without them", () => {
    const policy = obj({
      spec: {
        targetRefs: [{ group: "", kind: "Service", name: "web" }],
        validation: { hostname: "web.example.com" },
      },
    });
    expect(
      cell("backendtlspolicies", "BackendTLSPolicy", true, "targets", policy)
        .textContent,
    ).toBe("Service/web");
    expect(
      cell("backendtlspolicies", "BackendTLSPolicy", true, "hostname", policy)
        .textContent,
    ).toBe("web.example.com");
    expect(
      cell("backendtlspolicies", "BackendTLSPolicy", true, "hostname", obj())
        .textContent,
    ).toBe("—");
    expect(
      cell(
        "backendtlspolicies",
        "BackendTLSPolicy",
        true,
        "hostname",
        obj({ spec: { validation: { hostname: "" } } }),
      ).textContent,
    ).toBe("—");
  });

  it("show a TCPRoute's parents, and a dash without them", () => {
    expect(
      cell(
        "tcproutes",
        "TCPRoute",
        true,
        "parents",
        obj({ spec: { parentRefs: [{ name: "edge" }] } }),
      ).textContent,
    ).toBe("web/edge");
    expect(
      cell("udproutes", "UDPRoute", true, "parents", obj()).textContent,
    ).toBe("—");
  });

  it("show a condition in a Badge, and a dash without it", () => {
    const programmed = cell(
      "gateways",
      "Gateway",
      true,
      "programmed",
      obj({
        status: { conditions: [{ type: "Programmed", status: "False" }] },
      }),
    );
    expect(programmed.textContent).toBe("False");
    expect(programmed.querySelector(".danger")).toBeTruthy();
  });

  it("show a dash for a class with no Accepted condition", () => {
    expect(
      cell("gatewayclasses", "GatewayClass", false, "accepted", obj())
        .textContent,
    ).toBe("—");
  });

  it("show the class name", () => {
    expect(
      cell(
        "gateways",
        "Gateway",
        true,
        "class",
        obj({ spec: { gatewayClassName: "shared" } }),
      ).textContent,
    ).toBe("shared");
  });
});
