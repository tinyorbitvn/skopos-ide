import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { flush, mockBackend } from "../../test/ipc";
import {
  metricsResult,
  metricsServer,
  points,
  prometheus,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import { type Allocatable, OverviewMetrics } from "./OverviewMetrics";

const GIB = 2 ** 30;

const INFO: ClusterInfo = {
  version: "v1.33.1",
  distribution: "kind",
  nodeCount: 2,
  namespaces: ["default", "shop"],
  namespacesRestricted: false,
  isAdmin: true,
};

const CLUSTER_RESULT = metricsResult({
  cpuUsage: points([1.2, 1.5]),
  memoryUsage: points([2 * GIB, 3 * GIB]),
});
const CP_RESULT = metricsResult({
  apiRequests: points([40, 41]),
  etcdDbSize: points([0.2 * GIB, 0.25 * GIB]),
});

async function settle() {
  await act(flush);
  await act(flush);
  await act(flush);
}

async function show(
  handlers: Parameters<typeof mockBackend>[0],
  info: ClusterInfo = INFO,
  allocatable: Allocatable = { cores: 8, bytes: 32 * GIB },
) {
  const backend = mockBackend(handlers);
  render(
    <MemoryRouter initialEntries={["/cluster/c1"]}>
      <OverviewMetrics
        clusterId="c1"
        clusterName="kind-dev"
        info={info}
        allocatable={allocatable}
      />
    </MemoryRouter>,
  );
  await settle();
  return backend;
}

beforeEach(() => {
  resetMetricsForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("the Metrics card holds the panel with the cluster's and the control plane's charts", async () => {
  const backend = await show({
    metrics_provider: () => prometheus(),
    metrics_query: (a: { target: MetricsTarget }) =>
      a.target.kind === "controlPlane" ? CP_RESULT : CLUSTER_RESULT,
  });
  const card = screen.getByRole("region", { name: "Metrics" });
  expect(card).toBe(screen.getByTestId("overview-metrics"));
  expect(within(card).getByTestId("metrics-panel")).toBeTruthy();
  expect(screen.getByTestId("metrics-control-plane-source").textContent).toBe(
    "From the API server's own metrics, etcd as the API server sees it.",
  );
  expect(
    within(screen.getByTestId("metrics-chart-etcd-database")).getByText(
      "etcd's default quota is 2 GiB",
    ),
  ).toBeTruthy();
  expect(screen.queryByTestId("overview-gauges")).toBeNull();
  expect(
    backend
      .callsTo("metrics_query")
      .map((a) => (a.target as MetricsTarget).kind),
  ).toEqual(["cluster", "controlPlane"]);
});

test("on AKS the source caption says that AKS runs etcd", async () => {
  await show(
    {
      metrics_provider: () => prometheus(),
      metrics_query: (a: { target: MetricsTarget }) =>
        a.target.kind === "controlPlane" ? CP_RESULT : CLUSTER_RESULT,
    },
    { ...INFO, distribution: "AKS" },
  );
  expect(screen.getByTestId("metrics-control-plane-source").textContent).toBe(
    "From the API server's own metrics: AKS runs etcd, so etcd is read as the API server sees it.",
  );
  expect(
    within(screen.getByTestId("metrics-chart-etcd-database")).getByText(
      "size on disk",
    ),
  ).toBeTruthy();
});

test("under metrics-server the charts read the allocatable it is given, and no Node list starts", async () => {
  const backend = await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({
          namespace: null,
          name: "n1",
          cpuCores: 2,
          memoryBytes: 4 * GIB,
        }),
      ]),
  });
  expect(
    within(screen.getByTestId("metrics-chart-cpu")).getByText(
      "of 8 cores on 2 nodes",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("metrics-chart-memory")).getByText(
      "of 32 GiB on 2 nodes",
    ),
  ).toBeTruthy();
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "nodes", namespace: null },
  ]);
  expect(backend.callsTo("resources_subscribe")).toEqual([]);
});
