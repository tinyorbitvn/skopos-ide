import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { IpcError } from "../../ipc/generated/IpcError";
import type { MetricName } from "../../ipc/generated/MetricName";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsRange } from "../../ipc/generated/MetricsRange";
import type { MetricsResult } from "../../ipc/generated/MetricsResult";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import { resetCatalogForTest } from "../../stores/catalog";
import { askQuery, resetMetricsForTest } from "../../stores/metrics";
import { CSS_FILES, cssRules } from "../../test/css";
import { flush, mockBackend } from "../../test/ipc";
import {
  FORBIDDEN,
  metricsResult,
  metricsServer,
  noProvider,
  PROMETHEUS_DOWN,
  points,
  prometheus,
  remote,
  T0,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import { NO_FACTS } from "./charts";
import {
  MetricsPanel,
  type MetricsPanelProps,
  type UsageSource,
} from "./MetricsPanel";

const CLUSTER: MetricsTarget = { kind: "cluster" };
const POD: MetricsTarget = { kind: "pod", namespace: "shop", name: "web-1" };
const PVC: MetricsTarget = { kind: "pvc", namespace: "shop", name: "data" };
const NODE_USAGE: UsageSource = { of: "nodes", namespace: null, keys: null };
const POD_USAGE: UsageSource = {
  of: "pods",
  namespace: "shop",
  keys: ["shop/web-1"],
};
const GIB = 2 ** 30;

const USAGE_DOWN: IpcError = {
  code: "Internal",
  message: "the metrics API answered 503",
  details: null,
};

const RESULT = metricsResult({
  cpuUsage: points([1.2, 1.5]),
  cpuRequests: points([2, 2]),
  cpuLimits: points([3, 3]),
  cpuAllocatable: points([4, 4]),
  memoryUsage: points([2 * GIB, 3 * GIB]),
  memoryRequests: points([4 * GIB, 4 * GIB]),
  memoryLimits: points([6 * GIB, 6 * GIB]),
  memoryAllocatable: points([16 * GIB, 16 * GIB]),
  podUsage: points([20, 21]),
  podCapacity: points([220, 220]),
  diskUsage: points([30 * GIB, 31 * GIB]),
  diskCapacity: points([100 * GIB, 100 * GIB]),
});

function Location() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

/** Lets the provider answer, the watches start and their answers render. */
async function settle() {
  await act(flush);
  await act(flush);
  await act(flush);
}

async function show(
  handlers: Parameters<typeof mockBackend>[0],
  over: Partial<MetricsPanelProps> = {},
) {
  const backend = mockBackend(handlers);
  render(
    <MemoryRouter initialEntries={["/cluster/c1"]}>
      <MetricsPanel
        clusterId="c1"
        clusterName="kind-dev"
        target={CLUSTER}
        facts={{ ...NO_FACTS, nodeCount: 2 }}
        usage={NODE_USAGE}
        layout="grid"
        {...over}
      />
      <Location />
    </MemoryRouter>,
  );
  await settle();
  return backend;
}

const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  resetMetricsForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("a spinner shows while the provider is checked", async () => {
  let answer: (p: MetricsProvider) => void = () => {};
  await show({
    metrics_provider: () =>
      new Promise<MetricsProvider>((resolve) => {
        answer = resolve;
      }),
  });
  expect(
    screen.getByRole("status", { name: "Checking the metrics provider" }),
  ).toBeTruthy();

  await act(async () => {
    answer(noProvider("setting"));
    await flush();
  });
  expect(
    screen.queryByRole("status", { name: "Checking the metrics provider" }),
  ).toBeNull();
  expect(screen.getByTestId("metrics-note")).toBeTruthy();
});

test("provider None from the settings: only the note, whose button opens the cluster settings", async () => {
  await show({ metrics_provider: () => noProvider("setting") });
  const note = screen.getByTestId("metrics-note");
  expect(note.getAttribute("role")).toBe("note");
  expect(note.querySelector("p")?.textContent).toBe(
    "Metrics are off: the metrics provider is None in the cluster settings.",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();
  expect(screen.queryByTestId("metrics-grid")).toBeNull();

  expect(text("metrics-note-action")).toBe("Cluster settings");
  fireEvent.click(screen.getByTestId("metrics-note-action"));
  expect(text("location")).toBe("/cluster/c1/settings");
});

test("no provider found: the note names the cluster and leads to the Helm charts", async () => {
  await show({ metrics_provider: () => noProvider("nothingFound") });
  expect(
    screen.getByTestId("metrics-note").querySelector("p")?.textContent,
  ).toBe(
    "No metrics provider answers in kind-dev: there is no Prometheus Service and the metrics.k8s.io API is not served. Install metrics-server or kube-prometheus-stack from the Helm charts.",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();

  expect(text("metrics-note-action")).toBe("Helm charts");
  fireEvent.click(screen.getByTestId("metrics-note-action"));
  expect(text("location")).toBe("/cluster/c1/helm/charts");
});

test("a failed provider check shows its error block, and Retry checks again with refresh", async () => {
  let fail = true;
  const backend = await show({
    metrics_provider: () => {
      if (fail) throw PROMETHEUS_DOWN;
      return prometheus();
    },
    metrics_query: () => RESULT,
  });
  const block = screen.getByTestId("metrics-error");
  expect(block.getAttribute("role")).toBe("alert");
  expect(block.querySelector("strong")?.textContent).toBe(
    "Metrics could not be checked",
  );
  expect(block.textContent).toContain("Prometheus answered 503");

  fail = false;
  fireEvent.click(screen.getByTestId("metrics-retry"));
  await settle();

  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: true },
  ]);
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(screen.getByTestId("metrics-toolbar")).toBeTruthy();
});

test.each([
  [
    prometheus(),
    "Prometheus monitoring/prometheus-server:80, autodetected, through the API server proxy",
  ],
  [
    prometheus({ chosenBy: "setting" }),
    "Prometheus monitoring/prometheus-server:80, pinned in the cluster settings, through the API server proxy",
  ],
  [
    prometheus({
      chosenBy: "setting",
      tenant: "team-a",
      matcher: { name: "cluster", value: "prod" },
    }),
    'Prometheus monitoring/prometheus-server:80, pinned in the cluster settings, through the API server proxy, tenant team-a, label cluster="prod"',
  ],
  [
    prometheus({ chosenBy: "setting", tenant: "team-a" }),
    "Prometheus monitoring/prometheus-server:80, pinned in the cluster settings, through the API server proxy, tenant team-a",
  ],
  [
    prometheus({ matcher: { name: "cluster", value: "prod" } }),
    'Prometheus monitoring/prometheus-server:80, autodetected, through the API server proxy, label cluster="prod"',
  ],
  [
    remote(),
    "Prometheus API at mimir.example.com, set in the cluster settings",
  ],
  [
    remote({
      host: "127.0.0.1:9009",
      tenant: "team-a",
      matcher: { name: "cluster", value: "prod" },
    }),
    'Prometheus API at 127.0.0.1:9009, set in the cluster settings, tenant team-a, label cluster="prod"',
  ],
  [
    metricsServer("fallback"),
    "metrics-server, autodetected: no Prometheus Service found. Samples every 15 s while the cluster is connected",
  ],
  [
    metricsServer("setting"),
    "metrics-server, set in the cluster settings. Samples every 15 s while the cluster is connected",
  ],
])(
  "the source line says where metrics come from and how it was chosen (%#)",
  async (provider, line) => {
    await show({
      metrics_provider: () => provider,
      metrics_query: () => RESULT,
      metrics_usage: () => usageSnapshot([]),
    });
    expect(text("metrics-source")).toBe(line);
  },
);

test("Prometheus: the range and view pickers, the four cluster charts, and 6h asks for 6h", async () => {
  const backend = await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => RESULT,
  });
  expect(screen.getByTestId("metrics-range")).toBeTruthy();
  expect(screen.getByTestId("metrics-view")).toBeTruthy();
  expect(screen.queryByTestId("metrics-live")).toBeNull();
  expect(screen.queryByTestId("metrics-note")).toBeNull();
  for (const stem of ["cpu", "memory", "pods", "disk"]) {
    expect(screen.getByTestId(`metrics-chart-${stem}`)).toBeTruthy();
  }
  expect(
    within(screen.getByTestId("metrics-chart-cpu")).getByText(
      "of 4 cores on 2 nodes",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("metrics-chart-memory")).getByText(
      "of 16 GiB on 2 nodes",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("metrics-chart-pods")).getByText(
      "running, capacity 220",
    ),
  ).toBeTruthy();
  expect(text("metrics-chart-cpu-now")).toBe("1.5 cores");
  expect(screen.getByTestId("metrics-grid").classList.contains("grid")).toBe(
    true,
  );

  fireEvent.click(screen.getByRole("radio", { name: "6h" }));
  await settle();
  expect(backend.callsTo("metrics_query")).toContainEqual({
    clusterId: "c1",
    target: { kind: "cluster" },
    range: "6h",
  });
});

test("Prometheus: Loading ‹range› and no grid before the first answer", async () => {
  const pending: ((r: MetricsResult) => void)[] = [];
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      new Promise<MetricsResult>((resolve) => {
        pending.push(resolve);
      }),
  });
  expect(text("metrics-loading")).toBe("Loading 1h");
  expect(screen.queryByTestId("metrics-grid")).toBeNull();

  await act(async () => {
    pending[0]?.(RESULT);
    await flush();
  });
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    false,
  );
});

test("a new range keeps the last charts, dimmed, with Loading ‹range› until its first answer", async () => {
  const pending: ((r: MetricsResult) => void)[] = [];
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: (a: { range: MetricsRange }) =>
      a.range === "1h"
        ? RESULT
        : new Promise<MetricsResult>((resolve) => {
            pending.push(resolve);
          }),
  });
  fireEvent.click(screen.getByRole("radio", { name: "6h" }));
  await settle();

  expect(text("metrics-loading")).toBe("Loading 6h");
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    true,
  );
  expect(text("metrics-chart-cpu-now")).toBe("1.5 cores");

  await act(async () => {
    pending[0]?.(
      metricsResult({ cpuUsage: points([0.5]) }, { end: T0 + 6 * 3600 }),
    );
    await flush();
  });
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    false,
  );
  expect(text("metrics-chart-cpu-now")).toBe("500m");
});

test("a failed query keeps the last charts dimmed under the error block; Retry waits for its answer and the block goes", async () => {
  let answer: () => unknown = () => RESULT;
  const backend = await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => answer(),
  });
  answer = () => {
    throw PROMETHEUS_DOWN;
  };
  await act(() => askQuery("c1", CLUSTER, "1h"));

  const block = screen.getByTestId("metrics-error");
  expect(block.getAttribute("role")).toBe("alert");
  expect(block.querySelector("strong")?.textContent).toBe(
    "Prometheus did not answer",
  );
  expect(block.textContent).toContain("Prometheus answered 503");
  expect(text("metrics-chart-cpu-now")).toBe("1.5 cores");
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    true,
  );

  let release: (r: MetricsResult) => void = () => {};
  answer = () =>
    new Promise<MetricsResult>((resolve) => {
      release = resolve;
    });
  fireEvent.click(screen.getByTestId("metrics-retry"));
  await act(flush);
  expect(
    (screen.getByTestId("metrics-retry") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(text("metrics-loading")).toBe("Retrying");

  await act(async () => {
    release(RESULT);
    await flush();
  });
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(backend.callsTo("metrics_query")).toHaveLength(3);
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    false,
  );
});

test("a Prometheus-compatible URL: the range picker and the charts, and a failed query's block names its host", async () => {
  let answer: () => unknown = () => RESULT;
  const backend = await show({
    metrics_provider: () => remote(),
    metrics_query: () => answer(),
  });
  expect(screen.getByTestId("metrics-range")).toBeTruthy();
  expect(text("metrics-chart-cpu-now")).toBe("1.5 cores");
  expect(backend.callsTo("metrics_query")).toEqual([
    { clusterId: "c1", target: CLUSTER, range: "1h" },
  ]);

  answer = () => {
    throw {
      code: "Unreachable",
      message: "Cannot reach mimir.example.com: connection refused.",
      details: null,
    };
  };
  await act(() => askQuery("c1", CLUSTER, "1h"));
  const block = screen.getByTestId("metrics-error");
  expect(block.querySelector("strong")?.textContent).toBe(
    "mimir.example.com did not answer",
  );
  expect(block.textContent).toContain(
    "Cannot reach mimir.example.com: connection refused.",
  );
});

test("the error block's Cluster settings opens the settings", async () => {
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => {
      throw PROMETHEUS_DOWN;
    },
  });
  fireEvent.click(screen.getByTestId("metrics-settings"));
  expect(text("location")).toBe("/cluster/c1/settings");
});

test("a missing main series shows the empty text and a missing reference line is left out", async () => {
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      metricsResult(
        {
          cpuRequests: points([2, 2]),
          memoryUsage: points([2 * GIB, 3 * GIB]),
          memoryRequests: points([4 * GIB, 4 * GIB]),
          podUsage: points([20, 21]),
          podCapacity: [],
        },
        { missing: ["cpuUsage", "memoryLimits"] },
      ),
  });

  expect(text("metrics-chart-cpu-empty")).toBe("No samples in this range.");
  expect(text("metrics-chart-cpu-now")).toBe("—");

  const memory = screen.getByTestId("metrics-chart-memory");
  expect(screen.queryByTestId("metrics-chart-memory-empty")).toBeNull();
  expect(within(memory).queryByText("Requests")).not.toBeNull();
  expect(within(memory).queryByText("Limits")).toBeNull();

  const pods = screen.getByTestId("metrics-chart-pods");
  expect(screen.queryByTestId("metrics-chart-pods-empty")).toBeNull();
  expect(within(pods).queryByText("Capacity")).toBeNull();
});

test("the view picker shows tables", async () => {
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => RESULT,
  });
  fireEvent.click(screen.getByRole("radio", { name: "Table" }));
  await settle();
  expect(screen.getByTestId("metrics-table-cpu")).toBeTruthy();
});

test("the drawer's layout is one column", async () => {
  await show(
    { metrics_provider: () => prometheus(), metrics_query: () => RESULT },
    { layout: "column" },
  );
  expect(screen.getByTestId("metrics-grid").classList.contains("column")).toBe(
    true,
  );
});

test("the object's empty text replaces the shared one", async () => {
  const seen: [string, number | null][] = [];
  const objectEmpty = (source: string, start: number | null) => {
    seen.push([source, start]);
    return `object text for ${source}`;
  };
  await show(
    {
      metrics_provider: () => prometheus(),
      metrics_query: () => metricsResult({}),
    },
    { objectEmpty },
  );
  expect(text("metrics-chart-cpu-empty")).toBe("object text for prometheus");
  expect(seen).toContainEqual(["prometheus", T0]);
});

test("metrics-server: the Live badge and text, no range picker, and rolling CPU and Memory under the note", async () => {
  const backend = await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({
          namespace: null,
          name: "node-a",
          cpuCores: 0.5,
          memoryBytes: GIB,
        }),
        usageItem({
          namespace: null,
          name: "node-b",
          cpuCores: 0.25,
          memoryBytes: GIB,
        }),
      ]),
  });
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "nodes", namespace: null },
  ]);
  expect(text("metrics-live-badge")).toBe("Live");
  expect(text("metrics-live")).toBe("Last 1 min, 1 sample");
  expect(screen.queryByTestId("metrics-range")).toBeNull();
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(text("metrics-note")).toBe(
    "Pods, disk and control plane history need Prometheus: metrics-server reports only the current CPU and memory.",
  );
  expect(text("metrics-chart-cpu-now")).toBe("750m");
  expect(text("metrics-chart-memory-now")).toBe("2 GiB");
  expect(screen.queryByTestId("metrics-chart-pods")).toBeNull();
  expect(screen.queryByTestId("metrics-chart-disk")).toBeNull();
});

test("metrics-server before the first sample: waiting, the collecting text, and never Loading", async () => {
  await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () => new Promise(() => {}),
  });
  expect(text("metrics-live")).toBe("Waiting for the first sample");
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(text("metrics-chart-cpu-empty")).toBe(
    "Collecting samples: metrics-server is read every 15 s, the next sample arrives in 15 s.",
  );
});

test("metrics-server for a Pod: its note and only its own samples", async () => {
  const backend = await show(
    {
      metrics_provider: () => metricsServer(),
      metrics_usage: () =>
        usageSnapshot([
          usageItem({ name: "web-1", cpuCores: 0.25 }),
          usageItem({ name: "web-2", cpuCores: 0.5 }),
        ]),
    },
    { target: POD, usage: POD_USAGE, layout: "column" },
  );
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: "shop" },
  ]);
  expect(text("metrics-note")).toBe(
    "Network and filesystem charts need Prometheus: metrics-server reports only the current CPU and memory.",
  );
  expect(text("metrics-chart-cpu-now")).toBe("250m");
  expect(screen.queryByTestId("metrics-chart-network")).toBeNull();
});

test("metrics-server for a PVC: only its note, and no snapshot is read", async () => {
  const backend = await show(
    { metrics_provider: () => metricsServer() },
    { target: PVC, usage: null, layout: "column" },
  );
  expect(text("metrics-note")).toBe(
    "Volume usage needs Prometheus: kubelet exports it as kubelet_volume_stats_used_bytes, which metrics-server does not serve.",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();
  expect(backend.callsTo("metrics_usage")).toEqual([]);
});

test("metrics-server: a forbidden node snapshot shows the forbidden note in place of the error block and charts", async () => {
  await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () => {
      throw FORBIDDEN;
    },
  });
  expect(text("metrics-note")).toBe(
    "Metrics are not shown: the nodes API is forbidden, so usage cannot be summed.",
  );
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(screen.queryByTestId("metrics-grid")).toBeNull();
  expect(screen.getByTestId("metrics-toolbar")).toBeTruthy();
});

test("metrics-server: a failed snapshot shows its error block, and Retry asks again", async () => {
  let fail = true;
  const backend = await show(
    {
      metrics_provider: () => metricsServer(),
      metrics_usage: () => {
        if (fail) throw USAGE_DOWN;
        return usageSnapshot([usageItem({ name: "web-1" })]);
      },
    },
    { target: POD, usage: POD_USAGE },
  );
  const block = screen.getByTestId("metrics-error");
  expect(block.querySelector("strong")?.textContent).toBe(
    "metrics.k8s.io did not answer",
  );
  expect(block.textContent).toContain("the metrics API answered 503");

  fail = false;
  fireEvent.click(screen.getByTestId("metrics-retry"));
  await settle();
  expect(backend.callsTo("metrics_usage")).toHaveLength(2);
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(text("metrics-chart-cpu-now")).toBe("250m");
});

const MIMIR = prometheus({
  chosenBy: "setting",
  tenant: "team-a",
  matcher: { name: "cluster", value: "prod" },
});
const NO_SAMPLES = metricsResult(
  {},
  { missing: ["cpuUsage", "memoryUsage", "podUsage", "diskUsage"] },
);

test("no samples at all under a tenant and a label: the note with Cluster settings, over the charts' own empty text", async () => {
  await show({
    metrics_provider: () => MIMIR,
    metrics_query: () => NO_SAMPLES,
  });
  const note = screen.getByTestId("metrics-note");
  expect(note.querySelector("p")?.textContent).toBe(
    'No samples for tenant team-a with cluster="prod": check the tenant and the cluster label in the cluster settings.',
  );
  expect(text("metrics-chart-cpu-empty")).toBe("No samples in this range.");
  expect(text("metrics-note-action")).toBe("Cluster settings");
  fireEvent.click(screen.getByTestId("metrics-note-action"));
  expect(text("location")).toBe("/cluster/c1/settings");
});

const QUIET: [string, MetricsResult, MetricsPanelProps["objectEmpty"]][] = [
  [
    "a query failed",
    metricsResult({}, { missing: ["memoryUsage"], failed: ["cpuUsage"] }),
    undefined,
  ],
  [
    "a metric has samples",
    metricsResult({ cpuUsage: points([1.2]) }, { missing: ["memoryUsage"] }),
    undefined,
  ],
  [
    "the object explains its own gap",
    NO_SAMPLES,
    () => "No samples: web has no Pods.",
  ],
];

test.each(QUIET)("no tenant note when %s", async (_, result, objectEmpty) => {
  await show(
    { metrics_provider: () => MIMIR, metrics_query: () => result },
    objectEmpty ? { objectEmpty } : {},
  );
  expect(screen.queryByTestId("metrics-note")).toBeNull();
});

test("a long tenant or label wraps in the source line and the note", () => {
  const rules = cssRules(
    CSS_FILES["/src/features/metrics/MetricsPanel.module.css"] ?? "",
  );
  for (const selector of [".source", ".noteText"]) {
    const decls = Object.fromEntries(
      rules.find((r) => r.selector === selector)?.decls ?? [],
    );
    expect([selector, decls["overflow-wrap"]]).toEqual([selector, "anywhere"]);
  }
});

const CONTROL: MetricsTarget = { kind: "controlPlane" };
const CP_METRICS: MetricName[] = [
  "apiRequests",
  "apiErrors",
  "apiLatencyP99",
  "etcdLatencyP99",
  "etcdDbSize",
];
const CP_RESULT = metricsResult({
  apiRequests: points([300, 352]),
  apiErrors: points([0.2, 0.21]),
  apiLatencyP99: points([0.12, 0.145]),
  etcdLatencyP99: points([0.004, 0.0042]),
  etcdDbSize: points([0.5 * GIB, 0.6 * GIB]),
});
const CP_MISSING = metricsResult({}, { missing: CP_METRICS });

/** Answers the cluster with RESULT and the control plane with `plane`. */
function byTarget(plane: () => unknown = () => CP_RESULT) {
  return (a: { target: MetricsTarget }) =>
    a.target.kind === "controlPlane" ? plane() : RESULT;
}

/** The stems of a grid's charts, in order: each chart is a child of its grid. */
const stems = (id: string) =>
  [...screen.getByTestId(id).children].map((c) =>
    (c.getAttribute("data-testid") ?? "").slice("metrics-chart-".length),
  );

test("the Overview's panel draws two headed groups: the cluster's charts, then the control plane's", async () => {
  const backend = await show(
    { metrics_provider: () => prometheus(), metrics_query: byTarget() },
    { controlPlane: { distribution: "EKS" } },
  );
  expect(text("metrics-heading-cluster")).toBe("Cluster resources");
  expect(text("metrics-heading-control-plane")).toBe("Control plane");
  expect(text("metrics-control-plane-source")).toBe(
    "From the API server's own metrics: EKS runs etcd, so etcd is read as the API server sees it.",
  );
  expect(screen.getByTestId("metrics-grid").getAttribute("data-n")).toBe("4");
  expect(stems("metrics-grid")).toEqual(["cpu", "memory", "pods", "disk"]);
  const plane = screen.getByTestId("metrics-grid-control-plane");
  expect(plane.getAttribute("data-n")).toBe("4");
  expect(stems("metrics-grid-control-plane")).toEqual([
    "api-requests",
    "api-latency",
    "etcd-latency",
    "etcd-database",
  ]);
  expect(text("metrics-chart-api-requests-now")).toBe("352 req/s");
  expect(text("metrics-chart-api-latency-now")).toBe("145 ms");
  expect(text("metrics-chart-etcd-latency-now")).toBe("4.2 ms");
  expect(
    within(screen.getByTestId("metrics-chart-etcd-database")).getByText(
      "8 GiB on standard control planes",
    ),
  ).toBeTruthy();
  expect(backend.callsTo("metrics_query")).toEqual([
    { clusterId: "c1", target: CLUSTER, range: "1h" },
    { clusterId: "c1", target: CONTROL, range: "1h" },
  ]);
});

test("without the controlPlane prop, or in a column, the panel asks only for its own target", async () => {
  const backend = await show({
    metrics_provider: () => prometheus(),
    metrics_query: byTarget(),
  });
  expect(screen.queryByTestId("metrics-grid-control-plane")).toBeNull();
  expect(screen.queryByTestId("metrics-heading-cluster")).toBeNull();
  expect(
    backend
      .callsTo("metrics_query")
      .map((a) => (a.target as MetricsTarget).kind),
  ).toEqual(["cluster"]);
});

test("in a drawer's column the control plane is never asked for", async () => {
  const backend = await show(
    { metrics_provider: () => prometheus(), metrics_query: byTarget() },
    { layout: "column", controlPlane: { distribution: "kind" } },
  );
  expect(screen.queryByTestId("metrics-grid-control-plane")).toBeNull();
  expect(
    backend
      .callsTo("metrics_query")
      .map((a) => (a.target as MetricsTarget).kind),
  ).toEqual(["cluster"]);
});

test("all five control plane metrics missing: one note in place of the charts, naming the cluster label", async () => {
  await show(
    {
      metrics_provider: () =>
        remote({ matcher: { name: "cluster", value: "prod" } }),
      metrics_query: byTarget(() => CP_MISSING),
    },
    { controlPlane: { distribution: "kind" } },
  );
  expect(screen.queryByTestId("metrics-grid-control-plane")).toBeNull();
  expect(text("metrics-heading-control-plane")).toBe("Control plane");
  expect(text("metrics-control-plane-note")).toBe(
    'No API server metrics in this Prometheus: there are no samples of apiserver_request_total with cluster="prod". kube-prometheus-stack scrapes the API server by default; another Prometheus needs a job for the kubernetes Service\'s endpoints.',
  );
});

test("some control plane metrics missing: each such chart says it has no samples", async () => {
  await show(
    {
      metrics_provider: () => prometheus(),
      metrics_query: byTarget(() =>
        metricsResult(
          { apiRequests: points([300, 352]) },
          {
            missing: [
              "apiErrors",
              "apiLatencyP99",
              "etcdLatencyP99",
              "etcdDbSize",
            ],
          },
        ),
      ),
    },
    { controlPlane: { distribution: "kind" } },
  );
  expect(screen.queryByTestId("metrics-control-plane-note")).toBeNull();
  expect(text("metrics-chart-api-requests-now")).toBe("352 req/s");
  expect(screen.getByTestId("metrics-chart-api-latency-empty")).toBeTruthy();
});

test("the cluster's no-samples note leaves the control plane group out", async () => {
  await show(
    {
      metrics_provider: () => remote({ tenant: "platform" }),
      metrics_query: (a: { target: MetricsTarget }) =>
        a.target.kind === "controlPlane"
          ? CP_MISSING
          : metricsResult({}, { missing: ["cpuUsage", "memoryUsage"] }),
    },
    { controlPlane: { distribution: "kind" } },
  );
  expect(
    screen.getByTestId("metrics-note").querySelector("p")?.textContent,
  ).toBe(
    "No samples for tenant platform: check the tenant in the cluster settings.",
  );
  expect(screen.queryByTestId("metrics-control-plane-note")).toBeNull();
  expect(screen.queryByTestId("metrics-heading-control-plane")).toBeNull();
});

test("a failed control plane query shows its own block, and its Retry asks again", async () => {
  let plane: () => unknown = () => {
    throw PROMETHEUS_DOWN;
  };
  const backend = await show(
    {
      metrics_provider: () => prometheus(),
      metrics_query: byTarget(() => plane()),
    },
    { controlPlane: { distribution: "kind" } },
  );
  const block = screen.getByTestId("metrics-control-plane-error");
  expect(block.querySelector("strong")?.textContent).toBe(
    "The control plane metrics did not answer",
  );
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(stems("metrics-grid")).toEqual(["cpu", "memory", "pods", "disk"]);

  plane = () => CP_RESULT;
  fireEvent.click(within(block).getByTestId("metrics-retry"));
  await settle();
  expect(screen.queryByTestId("metrics-control-plane-error")).toBeNull();
  expect(text("metrics-chart-api-requests-now")).toBe("352 req/s");
  expect(
    backend
      .callsTo("metrics_query")
      .filter((a) => (a.target as MetricsTarget).kind === "controlPlane"),
  ).toHaveLength(2);
});

test("a new range keeps both groups' charts dimmed until their answers", async () => {
  const pending: { kind: string; resolve: (r: MetricsResult) => void }[] = [];
  await show(
    {
      metrics_provider: () => prometheus(),
      metrics_query: (a: { target: MetricsTarget; range: MetricsRange }) =>
        a.range === "1h"
          ? byTarget()(a)
          : new Promise<MetricsResult>((resolve) => {
              pending.push({ kind: a.target.kind, resolve });
            }),
    },
    { controlPlane: { distribution: "kind" } },
  );
  fireEvent.click(screen.getByRole("radio", { name: "6h" }));
  await settle();
  expect(text("metrics-loading")).toBe("Loading 6h");
  for (const id of ["metrics-grid", "metrics-grid-control-plane"]) {
    expect([id, screen.getByTestId(id).classList.contains("dim")]).toEqual([
      id,
      true,
    ]);
  }
  expect(text("metrics-chart-api-requests-now")).toBe("352 req/s");

  await act(async () => {
    for (const p of pending) {
      p.resolve(p.kind === "controlPlane" ? CP_RESULT : RESULT);
    }
    await flush();
  });
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
});

test("Table view lists the control plane's tables after the cluster's, under both headings", async () => {
  await show(
    { metrics_provider: () => prometheus(), metrics_query: byTarget() },
    { controlPlane: { distribution: "kind" } },
  );
  fireEvent.click(screen.getByRole("radio", { name: "Table" }));
  await settle();
  const tables = [
    ...document.querySelectorAll('[data-testid^="metrics-table-"]'),
  ].map((t) => t.getAttribute("data-testid"));
  expect(tables).toEqual(
    [
      "cpu",
      "memory",
      "pods",
      "disk",
      "api-requests",
      "api-latency",
      "etcd-latency",
      "etcd-database",
    ].map((s) => `metrics-table-${s}`),
  );
  expect(
    [
      ...screen
        .getByTestId("metrics-table-api-requests")
        .querySelectorAll("th"),
    ].map((th) => th.textContent),
  ).toEqual(["Time", "Requests", "5xx errors"]);
  expect(text("metrics-heading-cluster")).toBe("Cluster resources");
  expect(text("metrics-heading-control-plane")).toBe("Control plane");
});

test("metrics-server: no control plane group, and the note names control plane history", async () => {
  const backend = await show(
    {
      metrics_provider: () => metricsServer(),
      metrics_usage: () =>
        usageSnapshot([
          usageItem({ namespace: null, name: "n1", cpuCores: 1 }),
        ]),
    },
    { controlPlane: { distribution: "kind" } },
  );
  expect(text("metrics-note")).toBe(
    "Pods, disk and control plane history need Prometheus: metrics-server reports only the current CPU and memory.",
  );
  expect(screen.queryByTestId("metrics-heading-control-plane")).toBeNull();
  expect(screen.getByTestId("metrics-grid").getAttribute("data-n")).toBe("2");
  expect(backend.callsTo("metrics_query")).toEqual([]);
});

test("the panel is the container of its grids: 2 columns from 612 px, 4 for four charts from 1236 px", () => {
  const css = (
    CSS_FILES["/src/features/metrics/MetricsPanel.module.css"] ?? ""
  ).replace(/\s+/g, " ");
  expect(css).toMatch(/\.panel \{[^}]*container: metrics-panel \/ inline-size/);
  expect(css).toContain(
    "grid-template-columns: repeat(var(--metrics-columns, 1), minmax(0, 1fr))",
  );
  expect(css).toContain(
    '@container metrics-panel (min-width: 612px) { .grid { --metrics-columns: 2; } .grid[data-n="1"] { --metrics-columns: 1; } }',
  );
  expect(css).toContain(
    '@container metrics-panel (min-width: 1236px) { .grid[data-n="4"] { --metrics-columns: 4; } }',
  );
  expect(css).not.toMatch(/auto-fit|auto-fill/);
});

test("one hover marks the cluster's and the control plane's charts", async () => {
  await show(
    { metrics_provider: () => prometheus(), metrics_query: byTarget() },
    { controlPlane: { distribution: "kind" } },
  );
  act(() => screen.getByTestId("metrics-chart-api-latency-plot").focus());
  expect(screen.getByTestId("metrics-chart-api-latency-readout")).toBeTruthy();
  expect(screen.getByTestId("metrics-chart-cpu-hairline")).toBeTruthy();
  expect(screen.queryByTestId("metrics-chart-cpu-readout")).toBeNull();
});
