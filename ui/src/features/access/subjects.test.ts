import { expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import {
  bindingsText,
  bindingText,
  collectSubjects,
  filterSubjects,
  parseSubjectKey,
  removalLine,
  type SubjectBinding,
  toBindingRef,
  usersGroupsPath,
} from "./subjects";

const RBAC = "rbac.authorization.k8s.io";
const user = (name: string) => ({ kind: "User", apiGroup: RBAC, name });
const group = (name: string) => ({ kind: "Group", apiGroup: RBAC, name });
const account = (namespace: string, name: string) => ({
  kind: "ServiceAccount",
  name,
  namespace,
});

function binding(
  namespace: string | undefined,
  name: string,
  role: [string, string],
  subjects: object[],
): KubeObject {
  return {
    metadata: { name, namespace, resourceVersion: `${name}-rv` },
    roleRef: { apiGroup: RBAC, kind: role[0], name: role[1] },
    subjects,
  };
}

const CLUSTER = [
  binding(undefined, "alice-view", ["ClusterRole", "view"], [user("alice")]),
  binding(
    undefined,
    "admins",
    ["ClusterRole", "cluster-admin"],
    [group("system:masters")],
  ),
];
const NAMESPACED = [
  binding(
    "payments",
    "payments-devs-edit",
    ["ClusterRole", "edit"],
    [group("payments-devs"), user("alice"), account("payments", "ci")],
  ),
  binding(
    "shop",
    "alice-reader",
    ["Role", "shop-reader"],
    [user("alice"), user("alice")],
  ),
  binding("shop", "no-subjects", ["Role", "shop-reader"], []),
];

test("users and groups are gathered by kind and name, with their bindings, roles and scope", () => {
  const all = collectSubjects(CLUSTER, NAMESPACED);
  expect(all.map((s) => s.key)).toEqual([
    "User:alice",
    "Group:payments-devs",
    "Group:system:masters",
  ]);
  const alice = all[0];
  expect(alice.bindings.map((b) => b.name)).toEqual([
    "alice-view",
    "payments-devs-edit",
    "alice-reader",
  ]);
  expect(alice.roles).toEqual([
    "ClusterRole/edit",
    "ClusterRole/view",
    "Role/shop-reader",
  ]);
  expect(alice.scope).toEqual(["Cluster", "payments", "shop"]);
  expect(alice.bindings[0]).toEqual({
    kind: "ClusterRoleBinding",
    namespace: null,
    name: "alice-view",
    resourceVersion: "alice-view-rv",
    roleKind: "ClusterRole",
    roleName: "view",
    others: 0,
  });
  // The group and the ServiceAccount stay when alice goes.
  expect(alice.bindings[1].others).toBe(2);
  // Named twice in one binding, alice counts once there, and both entries go together.
  expect(alice.bindings[2].others).toBe(0);
  expect(all[1].scope).toEqual(["payments"]);
});

test("filters hide system names unless asked, pick a kind and search names", () => {
  const all = collectSubjects(CLUSTER, NAMESPACED);
  const keys = (
    query: string,
    kind: "all" | "users" | "groups",
    showSystem: boolean,
  ) => filterSubjects(all, { query, kind, showSystem }).map((s) => s.key);
  expect(keys("", "all", false)).toEqual(["User:alice", "Group:payments-devs"]);
  expect(keys("", "all", true)).toHaveLength(3);
  expect(keys("", "users", true)).toEqual(["User:alice"]);
  expect(keys("", "groups", false)).toEqual(["Group:payments-devs"]);
  expect(keys(" PAY ", "all", false)).toEqual(["Group:payments-devs"]);
});

test("a subject key splits at its first colon", () => {
  expect(parseSubjectKey("User:alice")).toEqual({
    kind: "User",
    name: "alice",
  });
  expect(parseSubjectKey("Group:system:masters")).toEqual({
    kind: "Group",
    name: "system:masters",
  });
  expect(parseSubjectKey("ServiceAccount:ci")).toBeNull();
  expect(parseSubjectKey("User:")).toBeNull();
  expect(parseSubjectKey(null)).toBeNull();
});

test("the screen's path carries the open subject", () => {
  expect(usersGroupsPath("c 1")).toBe("/cluster/c%201/users-groups");
  expect(usersGroupsPath("c1", "Group", "system:masters")).toBe(
    "/cluster/c1/users-groups?subject=Group%3Asystem%3Amasters",
  );
});

test("a binding reads as its kind and name, and says what removal does to it", () => {
  const b: SubjectBinding = {
    kind: "RoleBinding",
    namespace: "payments",
    name: "payments-devs-edit",
    resourceVersion: "7",
    roleKind: "ClusterRole",
    roleName: "edit",
    others: 1,
  };
  expect(bindingText(b)).toBe("RoleBinding payments/payments-devs-edit");
  expect(
    bindingText({
      kind: "ClusterRoleBinding",
      namespace: null,
      name: "alice-view",
    }),
  ).toBe("ClusterRoleBinding alice-view");
  expect(removalLine(b)).toBe("Remove · 1 other subject stays");
  expect(removalLine({ ...b, others: 2 })).toBe(
    "Remove · 2 other subjects stay",
  );
  expect(removalLine({ ...b, others: 0 })).toBe("Delete · no other subjects");
  expect(bindingsText(1)).toBe("1 binding");
  expect(bindingsText(2)).toBe("2 bindings");
  expect(toBindingRef(b)).toEqual({
    kind: "RoleBinding",
    namespace: "payments",
    name: "payments-devs-edit",
    resourceVersion: "7",
  });
});
