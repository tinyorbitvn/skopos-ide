import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../objects";
import { kindSpec } from "../registry";
import "./index";
import {
  DeviceClassDetail,
  ResourceClaimDetail,
  ResourceClaimTemplateDetail,
  ResourceSliceDetail,
} from "./DeviceDetails";
import {
  allocatedDevices,
  claimState,
  deviceRequests,
  requestClasses,
  sliceDevices,
  sliceNode,
} from "./devices";

const GROUP = "resource.k8s.io";
const ref = (
  group: string,
  plural: string,
  kind: string,
  namespaced: boolean,
): ResourceRef => ({ group, version: "v1", plural, kind, namespaced });
const info = (r: ResourceRef) =>
  ({ resource: r, canList: true }) as unknown as ApiResourceInfo;
const RESOURCES = [
  info(ref("", "pods", "Pod", true)),
  info(ref("", "nodes", "Node", false)),
  info(ref(GROUP, "deviceclasses", "DeviceClass", false)),
];

function show(Detail: typeof ResourceClaimDetail, object: KubeObject) {
  render(
    <MemoryRouter>
      <Detail
        clusterId="c"
        object={object}
        resource={ref(GROUP, "x", "X", true)}
        resources={RESOURCES}
      />
    </MemoryRouter>,
  );
}

const CLAIM: KubeObject = {
  apiVersion: "resource.k8s.io/v1",
  kind: "ResourceClaim",
  metadata: { name: "gpu", namespace: "ml" },
  spec: {
    devices: {
      requests: [
        {
          name: "gpu",
          exactly: {
            deviceClassName: "gpu.example.com",
            count: 2,
            selectors: [{ cel: { expression: "device.driver == 'x'" } }],
          },
        },
      ],
    },
  },
  status: {
    allocation: {
      devices: {
        results: [
          {
            request: "gpu",
            driver: "gpu.example.com",
            pool: "node-1",
            device: "gpu-0",
          },
        ],
      },
    },
    reservedFor: [{ resource: "pods", name: "trainer", uid: "u1" }],
  },
};

test("a claim is Pending, then Allocated, then Reserved while a Pod holds it", () => {
  const meta = { name: "c" };
  expect(claimState({ metadata: meta }).label).toBe("Pending");
  expect(claimState({ metadata: meta, status: { allocation: {} } }).label).toBe(
    "Allocated",
  );
  expect(claimState(CLAIM)).toEqual({ label: "Reserved", tone: "ok" });
  expect(
    claimState({
      metadata: { ...meta, deletionTimestamp: "2026-11-19T00:00:00Z" },
    }).label,
  ).toBe("Terminating");
});

test("requests read both v1's exactly and first-available forms and v1beta1's flat form", () => {
  expect(deviceRequests(CLAIM.spec)).toEqual([
    {
      name: "gpu",
      classes: ["gpu.example.com"],
      mode: "2",
      selectors: ["device.driver == 'x'"],
    },
  ]);
  const spec = {
    devices: {
      requests: [
        {
          name: "any",
          firstAvailable: [
            { name: "big", deviceClassName: "big.example.com" },
            { name: "small", deviceClassName: "small.example.com" },
          ],
        },
        {
          name: "old",
          deviceClassName: "old.example.com",
          allocationMode: "All",
        },
      ],
    },
  };
  expect(deviceRequests(spec).map((r) => [r.classes, r.mode])).toEqual([
    [["big.example.com", "small.example.com"], "First available"],
    [["old.example.com"], "All"],
  ]);
  expect(requestClasses(spec)).toBe(
    "big.example.com, small.example.com, old.example.com",
  );
  expect(deviceRequests(undefined)).toEqual([]);
});

test("a claim's drawer shows its state, holder, requests and allocated devices", () => {
  show(ResourceClaimDetail, CLAIM);
  expect(screen.getByText("Reserved")).toBeTruthy();
  expect(
    within(screen.getByTestId("claim-reserved-for")).getByRole("link", {
      name: "Pod trainer",
    }),
  ).toBeTruthy();
  const requests = screen.getByTestId("device-requests");
  expect(
    within(requests).getByRole("link", { name: "DeviceClass gpu.example.com" }),
  ).toBeTruthy();
  expect(within(requests).getByText("device.driver == 'x'")).toBeTruthy();
  expect(allocatedDevices(CLAIM)).toHaveLength(1);
  expect(screen.getByTestId("claim-devices").textContent).toContain("gpu-0");
});

test("a template's drawer shows the requests of the claims it makes", () => {
  show(ResourceClaimTemplateDetail, {
    apiVersion: "resource.k8s.io/v1",
    metadata: { name: "t", namespace: "ml" },
    spec: { spec: CLAIM.spec },
  });
  expect(screen.getByTestId("device-requests").textContent).toContain(
    "gpu.example.com",
  );
});

test("a class lists its selectors", () => {
  show(DeviceClassDetail, {
    metadata: { name: "gpu.example.com" },
    spec: { selectors: [{ cel: { expression: "device.driver == 'x'" } }] },
  });
  expect(screen.getByText("device.driver == 'x'")).toBeTruthy();
});

const SLICE: KubeObject = {
  metadata: { name: "node-1-gpu" },
  spec: {
    driver: "gpu.example.com",
    nodeName: "node-1",
    pool: { name: "node-1", generation: 3, resourceSliceCount: 1 },
    devices: [
      {
        name: "gpu-0",
        attributes: { model: { string: "A1" }, index: { int: 0 } },
        capacity: { memory: { value: "16Gi" } },
      },
    ],
  },
};

test("a slice shows its node, pool and each device's attributes and capacity", () => {
  expect(sliceNode(SLICE)).toBe("node-1");
  expect(sliceNode({ metadata: { name: "s" }, spec: { allNodes: true } })).toBe(
    "All nodes",
  );
  expect(sliceDevices(SLICE)).toEqual([
    {
      name: "gpu-0",
      attributes: ["model=A1", "index=0"],
      capacity: ["memory=16Gi"],
    },
  ]);
  // v1beta1 nests a device's fields under `basic`.
  expect(
    sliceDevices({
      metadata: { name: "s" },
      spec: {
        devices: [{ name: "d", basic: { attributes: { a: { bool: true } } } }],
      },
    })[0].attributes,
  ).toEqual(["a=true"]);
  show(ResourceSliceDetail, SLICE);
  expect(screen.getByRole("link", { name: "Node node-1" })).toBeTruthy();
  expect(screen.getByTestId("slice-devices").textContent).toContain("model=A1");
});

test("each kind of Device Resources has its own columns and drawer", () => {
  for (const plural of [
    "resourceclaims",
    "resourceclaimtemplates",
    "deviceclasses",
    "resourceslices",
  ]) {
    expect(kindSpec(GROUP, plural)?.detail).toBeTruthy();
  }
  const columns = kindSpec(GROUP, "resourceslices")?.columns?.({
    resource: ref(GROUP, "resourceslices", "ResourceSlice", false),
  } as ApiResourceInfo);
  expect(columns?.map((c) => c.id)).toEqual([
    "name",
    "node",
    "driver",
    "pool",
    "devices",
    "age",
  ]);
});
