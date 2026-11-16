import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test } from "vitest";
import type { StatusInfo } from "./columns";
import type { KubeObject } from "./objects";
import {
  nodeStatusColumn,
  podDetail,
  workloadStatusColumn,
} from "./statusCells";
import type { OwnedPods } from "./workloads/ownedPods";

const CONTAINERS = { containers: [{ name: "c" }] };

const running = (name: string): KubeObject => ({
  metadata: { name },
  spec: CONTAINERS,
  status: {
    phase: "Running",
    containerStatuses: [{ name: "c", ready: true, state: { running: {} } }],
  },
});

const crashing = (name: string, restarts: number): KubeObject => ({
  metadata: { name },
  spec: CONTAINERS,
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "c",
        ready: false,
        restartCount: restarts,
        state: { waiting: { reason: "CrashLoopBackOff" } },
      },
    ],
  },
});

const evicted = (name: string, message: unknown): KubeObject => ({
  metadata: { name },
  status: { phase: "Failed", reason: "Evicted", message },
});

const unscheduled = (name: string): KubeObject => ({
  metadata: { name },
  status: {
    phase: "Pending",
    conditions: [
      { type: "PodScheduled", status: "False", reason: "Unschedulable" },
    ],
  },
});

const WEB: KubeObject = {
  metadata: { name: "web", namespace: "ns", uid: "w" },
};
const AVAILABLE: StatusInfo = { label: "Available", tone: "ok" };

const owning = (pods: KubeObject[]): OwnedPods => ({
  podsOf: (o) => (o.metadata.uid ? pods : undefined),
});

function cell(
  column: ReturnType<typeof workloadStatusColumn>,
  row: KubeObject,
) {
  return render(column.render(row));
}

async function openCard(): Promise<HTMLElement> {
  fireEvent.focus(screen.getByTestId("status-cell"));
  return screen.findByTestId("status-card");
}

test("without the workload's Pods the cell shows the status it always did", () => {
  const column = workloadStatusColumn("Deployment", () => AVAILABLE, undefined);
  expect(column.width).toBe(220);
  cell(column, WEB);
  expect(screen.getByText("Available")).toBeTruthy();
  expect(screen.queryByTestId("status-cell")).toBeNull();
  expect(column.sortValue?.(WEB)).toBe("4:Available");
  const noUid = workloadStatusColumn("Deployment", () => AVAILABLE, owning([]));
  expect(noUid.sortValue?.({ metadata: { name: "x" } })).toBe("4:Available");
});

test("the worst Pod state shows with its count and +N", () => {
  const pods = [
    crashing("web-a", 14),
    crashing("web-b", 1),
    evicted("web-c", "The node was low on resource: memory."),
    running("web-d"),
  ];
  const column = workloadStatusColumn(
    "Deployment",
    () => AVAILABLE,
    owning(pods),
  );
  cell(column, WEB);
  const status = screen.getByTestId("status-cell");
  expect(status.getAttribute("aria-label")).toBe(
    "CrashLoopBackOff, 2 of 4 Pods; Evicted 1; Running 1",
  );
  expect(status.getAttribute("role")).toBe("img");
  expect(status.getAttribute("tabindex")).toBe("0");
  expect(status.textContent).toBe("CrashLoopBackOff2+1");
  expect(column.sortValue?.(WEB)).toBe("0:CrashLoopBackOff");
});

test("the card lists the Pods by state with their details", async () => {
  const pods = [
    crashing("web-b", 1),
    crashing("web-a", 14),
    evicted("web-c", "The node was low on resource: memory."),
    unscheduled("web-e"),
    running("web-d"),
  ];
  cell(
    workloadStatusColumn("Deployment", () => AVAILABLE, owning(pods)),
    WEB,
  );
  const card = await openCard();
  const lines = within(card)
    .getAllByText(/web-/)
    .map((el) => el.textContent);
  expect(within(card).getByText("web — 5 Pods")).toBeTruthy();
  expect(lines).toEqual([
    "web-a (restarted 14 times), web-b (restarted 1 time)",
    "web-c (The node was low on resource: memory.)",
    "web-e (Unschedulable)",
    "web-d",
  ]);
  expect(within(card).queryByText(/also reports|is Available/)).toBeNull();
});

test("a state with many Pods names five and counts the rest", async () => {
  const pods = Array.from({ length: 7 }, (_, i) => running(`web-${i + 1}`));
  cell(
    workloadStatusColumn("DaemonSet", () => AVAILABLE, owning(pods)),
    WEB,
  );
  const card = await openCard();
  expect(within(card).getByText(/^web-1, /).textContent).toBe(
    "web-1, web-2, web-3, web-4, web-5 and 2 more",
  );
});

test("a lifecycle state with no Pods says so and notes the state", async () => {
  cell(
    workloadStatusColumn(
      "Deployment",
      () => ({ label: "ScaledDown", tone: "neutral" }),
      owning([]),
    ),
    WEB,
  );
  const status = screen.getByTestId("status-cell");
  expect(status.getAttribute("aria-label")).toBe("ScaledDown; no Pods");
  expect(status.textContent).toBe("ScaledDown");
  const card = await openCard();
  expect(within(card).getByText("web — no Pods")).toBeTruthy();
  expect(within(card).getByText("The Deployment is ScaledDown.")).toBeTruthy();
});

test("Escape closes the card", async () => {
  cell(
    workloadStatusColumn(
      "Deployment",
      () => AVAILABLE,
      owning([running("web-a")]),
    ),
    WEB,
  );
  await openCard();
  fireEvent.keyDown(screen.getByTestId("status-cell"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByTestId("status-card")).toBeNull());
});

test("a Pod message that is not text is left out", () => {
  expect(podDetail(evicted("a", 5))).toBe("");
  expect(podDetail(evicted("a", ""))).toBe("");
  expect(podDetail(crashing("a", 2))).toBe("restarted 2 times");
});

const cond = (
  type: string,
  status: string,
  extra: Record<string, string> = {},
) => ({
  type,
  status,
  reason: `${type}Reason`,
  message: `${type} message`,
  lastTransitionTime: "2026-11-16T08:00:00Z",
  ...extra,
});

const NODE = (conditions: unknown[], unschedulable = false): KubeObject => ({
  metadata: { name: "worker-1" },
  spec: { unschedulable },
  status: { conditions },
});

test("a Node shows its readiness, the worst active condition and +N", () => {
  const column = nodeStatusColumn();
  expect(column.width).toBe(280);
  const node = NODE([
    cond("Ready", "True"),
    cond("MemoryPressure", "True"),
    cond("DiskPressure", "True"),
    cond("PIDPressure", "False"),
  ]);
  render(column.render(node));
  const status = screen.getByTestId("status-cell");
  expect(status.textContent).toBe("ReadyMemoryPressure+1");
  expect(status.getAttribute("aria-label")).toBe(
    "Ready; MemoryPressure, DiskPressure",
  );
  expect(column.sortValue?.(node)).toBe("1:Ready");
  expect(column.sortValue?.(NODE([cond("Ready", "False")]))).toBe("0:NotReady");
  expect(
    column.sortValue?.(
      NODE([cond("Ready", "True"), cond("NetworkUnavailable", "True")]),
    ),
  ).toBe("0:Ready");
  expect(column.sortValue?.(NODE([]))).toBe("3:Unknown");
  expect(column.sortValue?.(NODE([cond("Ready", "True")]))).toBe("4:Ready");
});

test("the Node card lists every condition, its age and its reason", async () => {
  render(
    nodeStatusColumn().render(
      NODE(
        [
          cond("Ready", "True", {
            message: "kubelet is posting ready status",
          }),
          cond("MemoryPressure", "True"),
          {
            type: "PIDPressure",
            status: "False",
            reason: "KubeletHasSufficientPID",
          },
        ],
        true,
      ),
    ),
  );
  const card = await openCard();
  expect(within(card).getByText("worker-1 — conditions")).toBeTruthy();
  expect(
    within(card).getByText("ReadyReason: kubelet is posting ready status"),
  ).toBeTruthy();
  expect(
    within(card).getByText("MemoryPressureReason: MemoryPressure message"),
  ).toBeTruthy();
  expect(within(card).getByText("KubeletHasSufficientPID")).toBeTruthy();
  const inactive = within(card).getByText("PIDPressure False");
  expect(inactive.classList.contains("inactive")).toBe(true);
  expect(
    within(card).getByText("MemoryPressure True").closest(".inactive"),
  ).toBeNull();
  const ages = card.querySelectorAll(".count");
  expect([...ages].map((a) => a.textContent)).toEqual([
    expect.stringMatching(/^\d+[smhdy]/),
    expect.stringMatching(/^\d+[smhdy]/),
    "-",
    "-",
  ]);
  expect(within(card).getByText("spec.unschedulable is true")).toBeTruthy();
  expect(
    within(card).getByText(
      "The time is how long each condition has had its status.",
    ),
  ).toBeTruthy();
});
