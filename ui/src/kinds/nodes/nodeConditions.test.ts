import { expect, test } from "vitest";
import type { KubeObject } from "../objects";
import { nodeStatus } from "./node";
import { nodeConditions } from "./nodeConditions";

const node = (conditions: unknown, unschedulable?: boolean): KubeObject => ({
  metadata: { name: "worker-1" },
  ...(unschedulable === undefined ? {} : { spec: { unschedulable } }),
  status: { conditions },
});

const cond = (type: string, status: string) => ({
  type,
  status,
  reason: `${type}Reason`,
  message: `${type} message`,
  lastTransitionTime: "2026-11-16T08:00:00Z",
});

test("readiness comes from the Ready condition", () => {
  expect(nodeConditions(node([cond("Ready", "True")])).ready).toEqual({
    label: "Ready",
    tone: "ok",
  });
  expect(nodeConditions(node([cond("Ready", "False")])).ready).toEqual({
    label: "NotReady",
    tone: "danger",
  });
  expect(nodeConditions(node([cond("Ready", "Unknown")])).ready).toEqual({
    label: "Unknown",
    tone: "neutral",
  });
  expect(nodeConditions(node([cond("MemoryPressure", "False")])).ready).toEqual(
    { label: "Unknown", tone: "neutral" },
  );
});

test("every condition that is True is active, toned by its type", () => {
  const { active } = nodeConditions(
    node([
      cond("Ready", "True"),
      cond("EtcdIsVoter", "True"),
      cond("MemoryPressure", "True"),
      cond("DiskPressure", "False"),
      cond("PIDPressure", "True"),
      cond("NetworkUnavailable", "True"),
      cond("KernelDeadlock", "Unknown"),
    ]),
  );
  expect(active.map((a) => [a.type, a.tone])).toEqual([
    ["NetworkUnavailable", "danger"],
    ["MemoryPressure", "warn"],
    ["PIDPressure", "warn"],
    ["EtcdIsVoter", "neutral"],
  ]);
  expect(active[0]?.condition?.message).toBe("NetworkUnavailable message");
});

test("a cordoned Node adds SchedulingDisabled last among the warnings", () => {
  const { active } = nodeConditions(
    node(
      [
        cond("Ready", "True"),
        cond("FrequentKubeletRestart", "True"),
        cond("DiskPressure", "True"),
      ],
      true,
    ),
  );
  expect(active.map((a) => [a.type, a.tone, a.condition === null])).toEqual([
    ["DiskPressure", "warn", false],
    ["SchedulingDisabled", "warn", true],
    ["FrequentKubeletRestart", "neutral", false],
  ]);
  expect(nodeConditions(node([cond("Ready", "True")], false)).active).toEqual(
    [],
  );
});

test("odd condition lists read as no conditions", () => {
  for (const conditions of [
    undefined,
    null,
    "Ready",
    [null, 5, { status: "True" }],
  ]) {
    const read = nodeConditions(node(conditions));
    expect(read.ready).toEqual({ label: "Unknown", tone: "neutral" });
    expect(read.active).toEqual([]);
    expect(read.conditions).toEqual([]);
  }
  expect(nodeConditions({ metadata: { name: "bare" } }).conditions).toEqual([]);
});

test("nodeStatus keeps its label for its other callers", () => {
  expect(nodeStatus(node([cond("Ready", "True")], true)).label).toBe(
    "Ready,SchedulingDisabled",
  );
});
