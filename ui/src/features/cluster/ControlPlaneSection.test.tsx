import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ControlPlane } from "../../ipc/generated/ControlPlane";
import { mockBackend } from "../../test/ipc";
import {
  CONTROL_PLANE_POLL_MS,
  ControlPlaneSection,
  componentDetail,
  worst,
} from "./ControlPlaneSection";

const NOW = Date.parse("2026-11-19T10:00:00Z");

const HEALTHY: ControlPlane = {
  apiServer: {
    url: "https://127.0.0.1:6443",
    version: "v1.34.0",
    platform: "linux/amd64",
    goVersion: "go1.24.6",
    buildDate: "2025-08-27T00:00:00Z",
    live: "healthy",
    ready: "healthy",
    checks: [
      { name: "ping", ok: true },
      { name: "etcd", ok: true },
      { name: "informer-sync", ok: true },
    ],
  },
  components: [
    {
      id: "etcd",
      name: "etcd",
      state: "healthy",
      pods: { ready: 1, total: 1 },
      leader: null,
      check: true,
    },
    {
      id: "scheduler",
      name: "Scheduler",
      state: "healthy",
      pods: { ready: 1, total: 1 },
      leader: {
        holder: "kind-control-plane_1a2b",
        renewed: "2026-11-19T09:59:56Z",
        leaseSeconds: 15,
      },
      check: null,
    },
    {
      id: "dns",
      name: "DNS",
      state: "degraded",
      pods: { ready: 1, total: 2 },
      leader: null,
      check: null,
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function show(handler: () => unknown) {
  const backend = mockBackend({ cluster_control_plane: handler });
  render(<ControlPlaneSection clusterId="c1" />);
  await act(async () => {});
  return backend;
}

test("lists the API server, then each component with its state and what it is based on", async () => {
  const backend = await show(() => HEALTHY);
  expect(backend.callsTo("cluster_control_plane")).toEqual([{ id: "c1" }]);
  const section = screen.getByRole("region", { name: "Control plane" });
  const rows = within(section)
    .getAllByRole("listitem")
    .filter((li) => li.dataset.testid?.startsWith("control-plane-"));
  expect(rows.map((r) => r.dataset.testid)).toEqual([
    "control-plane-api-server",
    "control-plane-etcd",
    "control-plane-scheduler",
    "control-plane-dns",
  ]);
  expect(
    screen.getByTestId("control-plane-api-server-detail").textContent,
  ).toBe("v1.34.0 · https://127.0.0.1:6443 · all 3 readyz checks pass");
  expect(screen.getByTestId("control-plane-etcd-detail").textContent).toBe(
    "1 of 1 Pod ready · readyz check ok",
  );
  expect(screen.getByTestId("control-plane-scheduler-detail").textContent).toBe(
    "1 of 1 Pod ready · leader kind-control-plane_1a2b, renewed 4s ago",
  );
  expect(screen.getByTestId("control-plane-dns-state").textContent).toBe(
    "Degraded",
  );
  expect(
    within(screen.getByTestId("control-plane-dns")).getByRole("img", {
      name: "Degraded",
    }),
  ).toBeTruthy();
  expect(screen.getByTestId("control-plane-build").textContent).toBe(
    "linux/amd64 · go1.24.6 · built 2025-08-27T00:00:00Z",
  );
  expect(
    within(screen.getByTestId("control-plane-checks")).getAllByRole("listitem"),
  ).toHaveLength(3);
});

test("a failing readyz check makes the API server unhealthy and names the check", async () => {
  await show(() => ({
    ...HEALTHY,
    apiServer: {
      ...HEALTHY.apiServer,
      ready: "unhealthy",
      checks: [
        { name: "ping", ok: true },
        { name: "etcd", ok: false },
      ],
    },
  }));
  expect(screen.getByTestId("control-plane-api-server-state").textContent).toBe(
    "Unhealthy",
  );
  expect(
    screen.getByTestId("control-plane-api-server-detail").textContent,
  ).toContain("1 of 2 readyz checks fail: etcd");
});

test("reads again every 30 s, and says why when it cannot", async () => {
  let fail = true;
  const backend = await show(() => {
    if (fail) throw { code: "unreachable", message: "the server is gone" };
    return HEALTHY;
  });
  expect(screen.getByTestId("control-plane-note").textContent).toBe(
    "Could not read the control plane: the server is gone",
  );
  fail = false;
  await act(async () => {
    vi.advanceTimersByTime(CONTROL_PLANE_POLL_MS);
  });
  expect(backend.callsTo("cluster_control_plane")).toHaveLength(2);
  expect(screen.queryByTestId("control-plane-note")).toBeNull();
  expect(screen.getByTestId("control-plane-etcd")).toBeTruthy();
});

test("a component with nothing visible says so; a lease never renewed says so", () => {
  expect(
    componentDetail(
      {
        id: "etcd",
        name: "etcd",
        state: "unknown",
        pods: null,
        leader: null,
        check: null,
      },
      NOW,
    ),
  ).toBe("Not visible: run by the provider, or not readable with your access");
  expect(
    componentDetail(
      {
        id: "scheduler",
        name: "Scheduler",
        state: "unhealthy",
        pods: null,
        leader: { holder: "", renewed: null, leaseSeconds: null },
        check: null,
      },
      NOW,
    ),
  ).toBe("No leader, never renewed");
});

test("the worse state wins, and unknown only beats healthy", () => {
  expect(worst("healthy", "unknown")).toBe("unknown");
  expect(worst("unknown", "degraded")).toBe("degraded");
  expect(worst("unhealthy", "healthy")).toBe("unhealthy");
});
