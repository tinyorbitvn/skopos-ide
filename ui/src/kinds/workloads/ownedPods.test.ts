import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../objects";
import { controllerUid, indexOwnedPods, workloadKind } from "./ownedPods";

const info = (group: string, plural: string) =>
  ({
    resource: { group, version: "v1", plural, kind: "Kind", namespaced: true },
  }) as unknown as ApiResourceInfo;

/** An object with a uid, controlled by `owner` when one is given. */
function obj(
  name: string,
  uid: string,
  owner?: string,
  namespace = "ns",
): KubeObject {
  return {
    metadata: {
      name,
      namespace,
      uid,
      ...(owner
        ? {
            ownerReferences: [
              { kind: "Owner", name: "owner", uid: owner, controller: true },
            ],
          }
        : {}),
    },
  };
}

const names = (pods: KubeObject[] | undefined) =>
  pods?.map((p) => p.metadata.name);

test("workloadKind names the six workload lists and nothing else", () => {
  for (const plural of [
    "deployments",
    "statefulsets",
    "replicasets",
    "daemonsets",
  ]) {
    expect(workloadKind(info("apps", plural))).toBe(plural);
  }
  expect(workloadKind(info("batch", "jobs"))).toBe("jobs");
  expect(workloadKind(info("batch", "cronjobs"))).toBe("cronjobs");
  expect(workloadKind(info("", "pods"))).toBeNull();
  expect(workloadKind(info("apps", "controllerrevisions"))).toBeNull();
  expect(workloadKind(info("argoproj.io", "rollouts"))).toBeNull();
  expect(workloadKind(info("example.com", "jobs"))).toBeNull();
  expect(workloadKind(undefined)).toBeNull();
});

test("only an owner reference marked controller counts", () => {
  const pod: KubeObject = {
    metadata: {
      name: "p",
      ownerReferences: [
        { kind: "ConfigMap", name: "c", uid: "not-it" },
        { kind: "StatefulSet", name: "db", uid: "sts", controller: true },
      ],
    },
  };
  expect(controllerUid(pod)).toBe("sts");
  expect(
    controllerUid({
      metadata: {
        name: "q",
        ownerReferences: [{ kind: "StatefulSet", name: "db", uid: "sts" }],
      },
    }),
  ).toBeUndefined();
  const index = indexOwnedPods("statefulsets", [pod], {});
  expect(names(index.podsOf(obj("db", "sts")))).toEqual(["p"]);
  expect(names(index.podsOf(obj("db", "not-it")))).toEqual([]);
});

test("direct owners get the Pods they control", () => {
  const pods = [
    obj("db-0", "p0", "sts"),
    obj("db-1", "p1", "sts"),
    obj("web-x", "p2", "rs"),
  ];
  for (const kind of [
    "statefulsets",
    "replicasets",
    "daemonsets",
    "jobs",
  ] as const) {
    const index = indexOwnedPods(kind, pods, {});
    expect(names(index.podsOf(obj("db", "sts")))).toEqual(["db-0", "db-1"]);
    expect(names(index.podsOf(obj("none", "nothing")))).toEqual([]);
  }
});

test("a Deployment gets the Pods of every ReplicaSet it controls", () => {
  const replicaSets = [
    obj("web-old", "rs1", "d1"),
    obj("web-new", "rs2", "d1"),
    obj("api-1", "rs3", "d2"),
  ];
  const pods = [
    obj("web-old-a", "p1", "rs1"),
    obj("web-new-a", "p2", "rs2"),
    obj("web-new-b", "p3", "rs2"),
    obj("api-1-a", "p4", "rs3"),
    obj("orphan", "p5", "rs-gone"),
  ];
  const index = indexOwnedPods("deployments", pods, { replicaSets });
  expect(names(index.podsOf(obj("web", "d1")))).toEqual([
    "web-old-a",
    "web-new-a",
    "web-new-b",
  ]);
  expect(names(index.podsOf(obj("api", "d2")))).toEqual(["api-1-a"]);
});

test("a CronJob gets the Pods of every Job it controls", () => {
  const jobs = [obj("tick-1", "j1", "c1"), obj("tick-2", "j2", "c1")];
  const pods = [
    obj("tick-1-a", "p1", "j1"),
    obj("tick-2-a", "p2", "j2"),
    obj("solo", "p3", "j3"),
  ];
  const index = indexOwnedPods("cronjobs", pods, { jobs });
  expect(names(index.podsOf(obj("tick", "c1")))).toEqual([
    "tick-1-a",
    "tick-2-a",
  ]);
});

test("an index without the links its kind needs cannot answer", () => {
  const pods = [obj("web-a", "p1", "rs1")];
  expect(
    indexOwnedPods("deployments", pods, {}).podsOf(obj("web", "d1")),
  ).toBeUndefined();
  expect(
    indexOwnedPods("cronjobs", pods, {}).podsOf(obj("tick", "c1")),
  ).toBeUndefined();
  expect(
    indexOwnedPods("deployments", pods, { replicaSets: [] }).podsOf(
      obj("web", "d1"),
    ),
  ).toEqual([]);
});

test("a row without a uid cannot be answered for", () => {
  const index = indexOwnedPods("statefulsets", [obj("db-0", "p0", "sts")], {});
  expect(
    index.podsOf({ metadata: { name: "db", namespace: "ns" } }),
  ).toBeUndefined();
});

test("workloads with the same name in two namespaces never share Pods", () => {
  const pods = [
    obj("db-0", "p0", "sts-a", "a"),
    obj("db-0", "p1", "sts-b", "b"),
  ];
  const index = indexOwnedPods("statefulsets", pods, {});
  expect(
    index
      .podsOf(obj("db", "sts-a", undefined, "a"))
      ?.map((p) => p.metadata.namespace),
  ).toEqual(["a"]);
  expect(
    index
      .podsOf(obj("db", "sts-b", undefined, "b"))
      ?.map((p) => p.metadata.namespace),
  ).toEqual(["b"]);
});
