import { expect, test } from "vitest";
import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";
import { podStates, workloadStatus } from "./podStates";

const CONTAINERS = { containers: [{ name: "c" }] };

const running = (name: string): KubeObject => ({
  metadata: { name },
  spec: CONTAINERS,
  status: {
    phase: "Running",
    containerStatuses: [{ name: "c", ready: true, state: { running: {} } }],
  },
});

const waiting = (name: string, reason: string, restarts = 0): KubeObject => ({
  metadata: { name },
  spec: CONTAINERS,
  status: {
    phase: "Pending",
    containerStatuses: [
      {
        name: "c",
        ready: false,
        restartCount: restarts,
        state: { waiting: { reason } },
      },
    ],
  },
});

const evicted = (name: string): KubeObject => ({
  metadata: { name },
  status: {
    phase: "Failed",
    reason: "Evicted",
    message: "The node was low on resource: memory.",
  },
});

const pending = (name: string): KubeObject => ({
  metadata: { name },
  status: {
    phase: "Pending",
    conditions: [
      { type: "PodScheduled", status: "False", reason: "Unschedulable" },
    ],
  },
});

const terminating = (name: string): KubeObject => ({
  metadata: { name, deletionTimestamp: "2026-11-16T10:00:00Z" },
  status: { phase: "Running" },
});

const failed = (name: string): KubeObject => ({
  metadata: { name },
  spec: CONTAINERS,
  status: {
    phase: "Failed",
    containerStatuses: [
      { name: "c", state: { terminated: { reason: "Error", exitCode: 1 } } },
    ],
  },
});

const summary = (pods: KubeObject[]) =>
  podStates(pods).map((s) => [s.label, s.tone, s.pods.length]);

const WORKLOAD: KubeObject = { metadata: { name: "web", uid: "w" } };
const own = (label: string, tone: StatusInfo["tone"]): StatusInfo => ({
  label,
  tone,
});

test("podStates groups Pods by status, worst tone first", () => {
  expect(
    summary([
      running("a"),
      running("b"),
      waiting("c", "CrashLoopBackOff"),
      pending("d"),
      waiting("e", "ContainerCreating"),
      terminating("f"),
    ]),
  ).toEqual([
    ["CrashLoopBackOff", "danger", 1],
    ["Pending", "warn", 1],
    ["ContainerCreating", "info", 1],
    ["Terminating", "neutral", 1],
    ["Running", "ok", 2],
  ]);
});

test("a leftover Evicted state comes after a live problem of the same tone", () => {
  expect(
    summary([
      evicted("a"),
      evicted("b"),
      evicted("c"),
      waiting("d", "CrashLoopBackOff"),
      waiting("e", "CrashLoopBackOff"),
    ]),
  ).toEqual([
    ["CrashLoopBackOff", "danger", 2],
    ["Evicted", "danger", 3],
  ]);
});

test("within a tone, more Pods go first, then the label from A to Z", () => {
  expect(
    summary([
      waiting("a", "ImagePullBackOff"),
      waiting("b", "ErrImagePull"),
      waiting("c", "ErrImagePull"),
      waiting("d", "CrashLoopBackOff"),
    ]).map(([label]) => label),
  ).toEqual(["ErrImagePull", "CrashLoopBackOff", "ImagePullBackOff"]);
  expect(podStates([])).toEqual([]);
});

test("a lifecycle state wins, and the problem states count as more", () => {
  for (const [label, tone] of [
    ["ScaledDown", "neutral"],
    ["Paused", "info"],
    ["Failed", "danger"],
    ["Suspended", "warn"],
  ] as const) {
    const status = workloadStatus(
      own(label, tone),
      WORKLOAD,
      [terminating("a"), waiting("b", "CrashLoopBackOff"), running("c")],
      "Deployment",
    );
    expect(status.badge).toEqual({ label, tone });
    expect(status.count).toBeUndefined();
    expect(status.more).toBe(2);
    expect(status.note).toBe(`The Deployment is ${label}.`);
  }
});

test("a workload being deleted says Terminating once", () => {
  const deleting: KubeObject = {
    metadata: {
      name: "web",
      uid: "w",
      deletionTimestamp: "2026-11-16T10:00:00Z",
    },
  };
  const status = workloadStatus(
    own("Terminating", "neutral"),
    deleting,
    [terminating("a"), terminating("b"), waiting("c", "CrashLoopBackOff")],
    "StatefulSet",
  );
  expect(status.badge.label).toBe("Terminating");
  expect(status.more).toBe(1);
  expect(status.note).toBe("The StatefulSet is Terminating.");
});

test("a Complete Job shows no more, though its card keeps every Pod", () => {
  const status = workloadStatus(
    own("Complete", "ok"),
    WORKLOAD,
    [failed("a"), running("b")],
    "Job",
  );
  expect(status.badge).toEqual({ label: "Complete", tone: "ok" });
  expect(status.more).toBe(0);
  expect(status.states.map((s) => s.label)).toEqual(["Error", "Running"]);
  expect(status.note).toBe("The Job is Complete.");
});

test("otherwise the worst Pod state shows with its count", () => {
  const status = workloadStatus(
    own("Updating", "info"),
    WORKLOAD,
    [
      waiting("a", "CrashLoopBackOff"),
      waiting("b", "CrashLoopBackOff"),
      evicted("c"),
      evicted("d"),
      evicted("e"),
      running("f"),
    ],
    "Deployment",
  );
  expect(status.badge).toEqual({ label: "CrashLoopBackOff", tone: "danger" });
  expect(status.count).toBe(2);
  expect(status.more).toBe(1);
  expect(status.note).toBeUndefined();
});

test("a failure the workload reports itself counts as more and is noted", () => {
  const status = workloadStatus(
    own("Stalled", "danger"),
    WORKLOAD,
    [waiting("a", "ImagePullBackOff")],
    "Deployment",
  );
  expect(status.badge).toEqual({ label: "ImagePullBackOff", tone: "danger" });
  expect(status.count).toBe(1);
  expect(status.more).toBe(1);
  expect(status.note).toBe("The Deployment also reports Stalled.");
});

test("with no Pod in trouble the workload's own status shows", () => {
  for (const [label, tone] of [
    ["Available", "ok"],
    ["Updating", "info"],
    ["Stalled", "danger"],
    ["Running", "info"],
    ["Scheduled", "ok"],
  ] as const) {
    const status = workloadStatus(
      own(label, tone),
      WORKLOAD,
      [running("a")],
      "Deployment",
    );
    expect(status).toEqual({
      badge: { label, tone },
      more: 0,
      states: podStates([running("a")]),
    });
  }
  expect(
    workloadStatus(own("Ready", "ok"), WORKLOAD, [], "StatefulSet"),
  ).toEqual({
    badge: { label: "Ready", tone: "ok" },
    more: 0,
    states: [],
  });
});
