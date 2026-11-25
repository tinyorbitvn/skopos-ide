import { expect, test } from "vitest";
import { clusterEntry } from "../../test/ipc";
import {
  clusterIdsByName,
  failureFromRow,
  nextScope,
  objectLabel,
  rolloutProgress,
  scopeChip,
  scopeLabel,
  waitingCount,
  withItem,
} from "./chatModel";

const IDS = ["a", "b", "c"];

test("the first chat is per-cluster on a cluster page, else global over all", () => {
  expect(nextScope(null, "b", IDS)).toEqual({ clusters: ["b"], global: false });
  expect(nextScope(null, null, IDS)).toEqual({ clusters: IDS, global: true });
  expect(nextScope(null, "gone", IDS)).toEqual({ clusters: IDS, global: true });
});

test("a per-cluster chat takes the page's cluster, else keeps its own", () => {
  const own = { clusters: ["a"], global: false };
  expect(nextScope(own, "c", IDS)).toEqual({ clusters: ["c"], global: false });
  expect(nextScope(own, null, IDS)).toEqual(own);
  // Its cluster left the catalog and the page has none: every cluster.
  expect(nextScope({ clusters: ["x"], global: false }, null, IDS)).toEqual({
    clusters: IDS,
    global: true,
  });
});

test("a global chat keeps its clusters that are still in the catalog", () => {
  expect(nextScope({ clusters: ["a", "x"], global: true }, "b", IDS)).toEqual({
    clusters: ["a"],
    global: true,
  });
  expect(nextScope({ clusters: ["x"], global: true }, null, IDS)).toEqual({
    clusters: IDS,
    global: true,
  });
});

test("no cluster left gives no scope", () => {
  expect(nextScope({ clusters: ["a"], global: true }, null, [])).toBeNull();
  expect(nextScope(null, null, [])).toBeNull();
});

test("chat names map back to ids as the core numbers repeated names", () => {
  const clusters = [
    clusterEntry({ id: "a", name: "prod" }),
    clusterEntry({ id: "b", name: "prod" }),
    clusterEntry({ id: "c", name: "dev" }),
  ];
  const names = clusterIdsByName(
    { clusters: ["a", "b", "c"], global: true },
    clusters,
  );
  expect(names.get("prod")).toBe("a");
  expect(names.get("prod (2)")).toBe("b");
  expect(names.get("dev")).toBe("c");
});

test("scope labels and chips", () => {
  const clusters = [
    clusterEntry({ id: "a", name: "prod-eu-west" }),
    clusterEntry({ id: "b", name: "kind-e2e" }),
  ];
  expect(scopeLabel({ clusters: ["a"], global: false }, clusters)).toBe(
    "prod-eu-west",
  );
  expect(scopeLabel({ clusters: ["a", "b"], global: true }, clusters)).toBe(
    "All clusters",
  );
  expect(scopeLabel({ clusters: ["b"], global: true }, clusters)).toBe(
    "1 cluster",
  );
  const limited = {
    changes: "ask" as const,
    namespaces: ["payments", "ingest"],
    secretValues: false,
    exec: false,
    defaultAgent: null,
    notes: "",
  };
  expect(scopeChip({ clusters: ["a"], global: false }, clusters, limited)).toBe(
    "prod-eu-west · 2 namespaces",
  );
  expect(scopeChip({ clusters: ["a"], global: false }, clusters, null)).toBe(
    "prod-eu-west",
  );
  expect(
    scopeChip({ clusters: ["a", "b"], global: true }, clusters, null),
  ).toBe("2 clusters");
});

test("an item with a known id replaces it, a new one is appended", () => {
  const one = { id: "1", body: { type: "agent" as const, text: "Hel" } };
  const two = { id: "2", body: { type: "agent" as const, text: "x" } };
  const items = withItem(withItem([], one), two);
  expect(
    withItem(items, { id: "1", body: { type: "agent", text: "Hello" } }).map(
      (i) => i.body,
    ),
  ).toEqual([
    { type: "agent", text: "Hello" },
    { type: "agent", text: "x" },
  ]);
});

test("waiting changes are counted", () => {
  const card = (id: string, state: "waiting" | "denied") => ({
    id,
    body: {
      type: "change" as const,
      card: {
        id,
        cluster: "prod",
        title: "Change Deployment a/b",
        summary: "",
        diff: [],
        command: null,
        secrets: [],
        state: { state },
        result: null,
        rollout: null,
        output: null,
      },
    },
  });
  expect(
    waitingCount([
      card("1", "waiting"),
      card("2", "denied"),
      card("3", "waiting"),
    ]),
  ).toBe(2);
});

test("object labels name the kind, then namespace/name", () => {
  expect(
    objectLabel({
      cluster: "a",
      kind: "Pod",
      namespace: "payments",
      name: "api-1",
    }),
  ).toBe("Pod payments/api-1");
  expect(
    objectLabel({ cluster: "a", kind: "Node", namespace: null, name: "n1" }),
  ).toBe("Node n1");
});

test("an agent row's state becomes the matching start failure", () => {
  const row = {
    id: "codex",
    name: "Codex",
    detail: null,
    hint: "Run codex login in a terminal, then check again.",
    isDefault: false,
    custom: false,
  };
  expect(
    failureFromRow({ ...row, state: { state: "signInNeeded" } }, "m"),
  ).toEqual({
    kind: "signIn",
    agentId: "codex",
    agent: "Codex",
    hint: "Run codex login in a terminal, then check again.",
  });
  expect(
    failureFromRow({ ...row, state: { state: "notInstalled" } }, "m"),
  ).toEqual({
    kind: "notInstalled",
    agentId: "codex",
    agent: "Codex",
  });
  expect(
    failureFromRow(
      { ...row, state: { state: "doesNotStart", reason: "exit 2" } },
      "m",
    ),
  ).toEqual({
    kind: "doesNotStart",
    agentId: "codex",
    agent: "Codex",
    reason: "exit 2",
  });
  expect(
    failureFromRow({ ...row, state: { state: "ready" } }, "broke"),
  ).toEqual({
    kind: "other",
    message: "broke",
  });
  expect(failureFromRow(undefined, "broke")).toEqual({
    kind: "other",
    message: "broke",
  });
});

test("a rollout settles when every Pod is ready on the new generation", () => {
  const deployment = (status: Record<string, number>, generation = 2) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "ns", generation },
    spec: { replicas: 3 },
    status,
  });
  expect(
    rolloutProgress(
      "Deployment",
      deployment({
        observedGeneration: 1,
        replicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
      }),
    ),
  ).toEqual({ desired: 3, ready: 3, settled: false });
  // updatedReplicas is omitted while it is 0: the first sync of a rolling update.
  expect(
    rolloutProgress(
      "Deployment",
      deployment({
        observedGeneration: 2,
        replicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
      }),
    ).settled,
  ).toBe(false);
  expect(
    rolloutProgress(
      "Deployment",
      deployment({
        observedGeneration: 2,
        replicas: 4,
        updatedReplicas: 2,
        readyReplicas: 3,
        availableReplicas: 3,
      }),
    ).settled,
  ).toBe(false);
  expect(
    rolloutProgress(
      "Deployment",
      deployment({
        observedGeneration: 2,
        replicas: 3,
        updatedReplicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
      }),
    ),
  ).toEqual({ desired: 3, ready: 3, settled: true });
  // A trimmed row keeps only the counts.
  expect(
    rolloutProgress("Deployment", {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web" },
      spec: { replicas: 1 },
      status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 },
    }),
  ).toEqual({ desired: 1, ready: 1, settled: true });
  const daemonSet = {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: "agent", generation: 5 },
    status: {
      observedGeneration: 5,
      desiredNumberScheduled: 2,
      updatedNumberScheduled: 2,
      numberReady: 1,
      numberAvailable: 1,
    },
  };
  expect(rolloutProgress("DaemonSet", daemonSet)).toEqual({
    desired: 2,
    ready: 1,
    settled: false,
  });
});
