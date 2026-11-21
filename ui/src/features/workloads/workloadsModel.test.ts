import { expect, test } from "vitest";
import {
  BatchJob,
  CronJob,
  Database,
  Deploy,
  Layers,
  Pod,
  Replica,
} from "../../design/icons";
import type { KubeObject } from "../../kinds/objects";
import { type ListView, WORKLOAD_KINDS } from "./counts";
import {
  EVENT_LIMIT,
  eventSubject,
  kindName,
  kindRowOf,
  kindTiles,
  PROBLEM_LIMIT,
  problemWorkloads,
  recentEventRows,
  workloadHealth,
} from "./workloadsModel";

const [
  PODS,
  DEPLOYMENTS,
  DAEMONSETS,
  STATEFULSETS,
  REPLICASETS,
  JOBS,
  CRONJOBS,
] = WORKLOAD_KINDS;

const NOW = Date.parse("2026-11-21T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ready = (items: KubeObject[]): ListView => ({ state: "ready", items });

type PodState = "running" | "creating" | "pending" | "crashing" | "terminating";

function pod(name: string, namespace: string, state: PodState): KubeObject {
  const running = { name: "app", ready: true, state: { running: {} } };
  const waiting = (reason: string) => [
    { name: "app", ready: false, state: { waiting: { reason } } },
  ];
  const statuses = {
    running: { phase: "Running", containerStatuses: [running] },
    creating: {
      phase: "Pending",
      containerStatuses: waiting("ContainerCreating"),
    },
    pending: { phase: "Pending" },
    crashing: {
      phase: "Running",
      containerStatuses: waiting("CrashLoopBackOff"),
    },
    terminating: { phase: "Running", containerStatuses: [running] },
  };
  return {
    metadata: {
      name,
      namespace,
      ...(state === "terminating"
        ? { deletionTimestamp: "2026-11-21T11:00:00Z" }
        : {}),
    },
    spec: { containers: [{ name: "app" }] },
    status: statuses[state],
  };
}

function deployment(
  name: string,
  namespace: string,
  state: "available" | "scaledDown" | "stalled",
): KubeObject {
  const statuses = {
    available: {
      readyReplicas: 1,
      updatedReplicas: 1,
      conditions: [{ type: "Available", status: "True" }],
    },
    scaledDown: {},
    stalled: {
      conditions: [
        {
          type: "Progressing",
          status: "False",
          reason: "ProgressDeadlineExceeded",
        },
      ],
    },
  };
  return {
    metadata: { name, namespace },
    spec: { replicas: state === "scaledDown" ? 0 : 1 },
    status: statuses[state],
  };
}

function event(
  name: string,
  minutes: number,
  over: Record<string, unknown> = {},
): KubeObject {
  return {
    metadata: { name, namespace: "shop", uid: name },
    type: "Normal",
    reason: "Started",
    involvedObject: {
      apiVersion: "v1",
      kind: "Pod",
      name: `pod-${name}`,
      namespace: "shop",
    },
    message: `message ${name}`,
    lastTimestamp: ago(minutes),
    ...over,
  };
}

test("a kind's tile counts its objects, with failing and pending in its sub-line and tone", () => {
  const tile = (items: KubeObject[]) =>
    kindTiles([kindRowOf(PODS, ready(items))], "c1")[0];
  const run = pod("a", "shop", "running");
  const pend = pod("b", "shop", "pending");
  const make = pod("c", "shop", "creating");
  const crash = pod("d", "shop", "crashing");
  const gone = pod("e", "shop", "terminating");

  expect(tile([run, crash, pend, make])).toMatchObject({
    number: "4",
    sub: "1 failing · 2 pending",
    tone: "danger",
  });
  expect(tile([crash])).toMatchObject({ sub: "1 failing", tone: "danger" });
  // ContainerCreating has the info tone, which is pending too.
  expect(tile([pend, make])).toMatchObject({
    sub: "2 pending",
    tone: "warn",
  });
  // A Terminating Pod is neither pending nor failing.
  expect(tile([run, gone])).toMatchObject({
    number: "2",
    sub: "All healthy",
    tone: "ok",
  });
  expect(tile([])).toMatchObject({ number: "0", sub: "None", tone: "neutral" });
  expect(
    tile(
      Array.from({ length: 1200 }, (_, i) => pod(`p-${i}`, "shop", "running")),
    ),
  ).toMatchObject({ number: "1,200" });
  expect(tile([run])).toMatchObject({
    id: "pods",
    label: "Pods",
    icon: Pod,
    to: "/cluster/c1/r/core/pods",
  });
});

test("the seven kinds keep the sidebar's order, each with its list's icon and link", () => {
  const kinds = [
    PODS,
    DEPLOYMENTS,
    DAEMONSETS,
    STATEFULSETS,
    REPLICASETS,
    JOBS,
    CRONJOBS,
  ];
  const tiles = kindTiles(
    kinds.map((kind) => kindRowOf(kind, ready([]))),
    "c1",
  );
  expect(tiles.map((t) => [t.id, t.label, t.icon])).toEqual([
    ["pods", "Pods", Pod],
    ["deployments", "Deployments", Deploy],
    ["daemonsets", "DaemonSets", Layers],
    ["statefulsets", "StatefulSets", Database],
    ["replicasets", "ReplicaSets", Replica],
    ["jobs", "Jobs", BatchJob],
    ["cronjobs", "CronJobs", CronJob],
  ]);
  expect(tiles.map((t) => t.to)).toEqual([
    "/cluster/c1/r/core/pods",
    "/cluster/c1/r/apps/deployments",
    "/cluster/c1/r/apps/daemonsets",
    "/cluster/c1/r/apps/statefulsets",
    "/cluster/c1/r/apps/replicasets",
    "/cluster/c1/r/batch/jobs",
    "/cluster/c1/r/batch/cronjobs",
  ]);
  expect(kinds.map(kindName)).toEqual([
    "Pod",
    "Deployment",
    "DaemonSet",
    "StatefulSet",
    "ReplicaSet",
    "Job",
    "CronJob",
  ]);
});

test("a kind whose list is not there reads a dash and says why by its cause", () => {
  const waiting = (view: ListView) =>
    kindTiles([kindRowOf(JOBS, view)], "c1")[0];
  const list = "/cluster/c1/r/batch/jobs";
  expect(waiting({ state: "loading" })).toMatchObject({
    number: "—",
    sub: "Loading",
    tone: "neutral",
    to: list,
  });
  expect(
    waiting({
      state: "unavailable",
      reason: "jobs is forbidden",
      cause: "forbidden",
    }),
  ).toMatchObject({
    number: "—",
    sub: "You may not list Jobs",
    tone: "neutral",
    to: null,
  });
  expect(
    waiting({
      state: "unavailable",
      reason: "This cluster does not serve Jobs.",
      cause: "notServed",
    }),
  ).toMatchObject({ sub: "This cluster does not serve Jobs", to: null });
  expect(
    waiting({
      state: "unavailable",
      reason: "discovery failed",
      cause: "error",
    }),
  ).toMatchObject({ sub: "Could not list Jobs", tone: "neutral", to: list });
});

test("health counts every listed kind, and healthy is what is neither pending nor failing", () => {
  const health = workloadHealth([
    kindRowOf(
      PODS,
      ready([
        pod("a", "shop", "running"),
        pod("b", "shop", "pending"),
        pod("c", "shop", "crashing"),
        pod("d", "shop", "terminating"),
      ]),
    ),
    kindRowOf(
      DEPLOYMENTS,
      ready([
        deployment("web", "shop", "available"),
        deployment("idle", "shop", "scaledDown"),
      ]),
    ),
    kindRowOf(JOBS, {
      state: "unavailable",
      reason: "jobs is forbidden",
      cause: "forbidden",
    }),
  ]);
  // The Terminating Pod and the Deployment scaled to zero count as healthy: 4 of 6.
  expect(health?.donut).toEqual({
    key: "healthy",
    name: "Healthy",
    label: "Healthy workloads",
    pct: 67,
    used: "4",
    total: "6",
    unit: "",
    note: "1 pending · 1 failing",
    level: "critical",
  });
  expect(health?.rows).toEqual([
    {
      key: "pods",
      name: "Pods",
      sub: "",
      cells: [
        { text: "2" },
        { text: "1", tone: "warn" },
        { text: "1", tone: "bad" },
      ],
    },
    {
      key: "deployments",
      name: "Deployments",
      sub: "",
      cells: [{ text: "2" }, { text: "0" }, { text: "0" }],
    },
  ]);
});

test("the health donut takes the worst state's level", () => {
  expect(
    workloadHealth([kindRowOf(PODS, ready([pod("b", "shop", "pending")]))])
      ?.donut.level,
  ).toBe("warning");
  expect(
    workloadHealth([kindRowOf(PODS, ready([pod("a", "shop", "running")]))])
      ?.donut,
  ).toMatchObject({ level: "nominal", pct: 100, used: "1", total: "1" });
  // No object at all: the share is unknown.
  expect(workloadHealth([kindRowOf(PODS, ready([]))])?.donut).toMatchObject({
    level: "nominal",
    pct: null,
    note: "0 pending · 0 failing",
  });
});

test("health is null while no kind is counted", () => {
  expect(
    workloadHealth([
      kindRowOf(PODS, {
        state: "unavailable",
        reason: "pods is forbidden",
        cause: "forbidden",
      }),
      kindRowOf(JOBS, { state: "loading" }),
    ]),
  ).toBeNull();
});

test("problems put failing first, then sort by namespace and name across kinds", () => {
  const result = problemWorkloads([
    {
      kind: PODS,
      view: ready([
        pod("web-2", "shop", "pending"),
        pod("api-0", "shop", "crashing"),
        pod("web-1", "default", "pending"),
        pod("ok", "shop", "running"),
        pod("node-10", "shop", "crashing"),
        pod("node-2", "shop", "crashing"),
      ]),
    },
    { kind: DEPLOYMENTS, view: ready([deployment("web", "shop", "stalled")]) },
    { kind: JOBS, view: { state: "loading" } },
  ]);
  expect(result.total).toBe(6);
  expect(
    result.items.map((i) => [
      i.kind.plural,
      i.object.metadata.namespace,
      i.object.metadata.name,
      i.status.label,
      i.failing,
    ]),
  ).toEqual([
    ["pods", "shop", "api-0", "CrashLoopBackOff", true],
    ["pods", "shop", "node-2", "CrashLoopBackOff", true],
    ["pods", "shop", "node-10", "CrashLoopBackOff", true],
    ["deployments", "shop", "web", "Stalled", true],
    ["pods", "default", "web-1", "Pending", false],
    ["pods", "shop", "web-2", "Pending", false],
  ]);
});

test("problems stop at the limit and keep the total", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    pod(`p-${i}`, "shop", "crashing"),
  );
  expect(PROBLEM_LIMIT).toBe(50);
  const result = problemWorkloads([{ kind: PODS, view: ready(many) }]);
  expect(result.items).toHaveLength(50);
  expect(result.total).toBe(60);
  expect(
    problemWorkloads([{ kind: PODS, view: ready(many) }], 3).items,
  ).toHaveLength(3);
});

test("recent events are null until the Events list is there", () => {
  expect(recentEventRows({ state: "loading" }, NOW)).toBeNull();
  expect(
    recentEventRows(
      {
        state: "unavailable",
        reason: "events is forbidden",
        cause: "forbidden",
      },
      NOW,
    ),
  ).toBeNull();
});

test("recent events are the eight newest, with the object, its kind and reason, the type, message and age", () => {
  const events = Array.from({ length: 10 }, (_, i) => event(`e${i}`, 20 - i));
  events[9] = event("e9", 2, {
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container api",
    involvedObject: {
      apiVersion: "v1",
      kind: "Pod",
      name: "api-0",
      namespace: "shop",
    },
  });
  // An event type other than Warning reads Normal.
  events[8] = event("e8", 3, { type: "Odd" });
  const rows = recentEventRows(ready(events), NOW);
  expect(EVENT_LIMIT).toBe(8);
  expect(rows?.map((r) => r.event.metadata.name)).toEqual([
    "e9",
    "e8",
    "e7",
    "e6",
    "e5",
    "e4",
    "e3",
    "e2",
  ]);
  expect(rows?.[0]).toMatchObject({
    name: "api-0",
    sub: "Pod · BackOff",
    type: "Warning",
    message: "Back-off restarting failed container api",
    age: "2m",
    target: { apiVersion: "v1", kind: "Pod", key: "shop/api-0" },
  });
  expect(rows?.[1]).toMatchObject({ type: "Normal", age: "3m" });
  expect(recentEventRows(ready(events), NOW, 3)).toHaveLength(3);
});

test("an event without an involved object reads its own name, and an events.k8s.io one its note", () => {
  const bare = event("bare", 1, {
    involvedObject: undefined,
    reason: "Scaled",
  });
  const newer = event("newer", 1, {
    involvedObject: undefined,
    message: undefined,
    note: "Scaled up to 3",
    regarding: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "web",
      namespace: "shop",
    },
  });
  const [first, second] = recentEventRows(ready([bare, newer]), NOW) ?? [];
  expect(first).toMatchObject({ name: "bare", sub: "Scaled", target: null });
  expect(second).toMatchObject({
    name: "web",
    sub: "Deployment · Started",
    message: "Scaled up to 3",
    target: { apiVersion: "apps/v1", kind: "Deployment", key: "shop/web" },
  });
});

test("an event's object is a target only with its apiVersion, kind and name, and one without a namespace keys as /name", () => {
  expect(
    eventSubject(
      event("n", 1, {
        involvedObject: { apiVersion: "v1", kind: "Node", name: "n1" },
      }),
    ),
  ).toEqual({ apiVersion: "v1", kind: "Node", key: "/n1" });
  expect(
    eventSubject(event("p", 1, { involvedObject: { kind: "Pod", name: "a" } })),
  ).toBeNull();
  expect(
    eventSubject(
      event("q", 1, { involvedObject: { apiVersion: "v1", kind: "Pod" } }),
    ),
  ).toBeNull();
});
