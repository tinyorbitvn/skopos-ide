import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { isServed, servedKinds } from "./servedKinds";

function info(group: string, version: string, kind: string): ApiResourceInfo {
  return {
    resource: {
      group,
      version,
      plural: `${kind.toLowerCase()}s`,
      kind,
      namespaced: true,
    },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

test("served kinds carry their apiVersion, once each", () => {
  expect(
    servedKinds([
      info("", "v1", "Pod"),
      info("apps", "v1", "Deployment"),
      info("", "v1", "Pod"),
    ]),
  ).toEqual([
    { apiVersion: "v1", kind: "Pod" },
    { apiVersion: "apps/v1", kind: "Deployment" },
  ]);
});

test("everything counts as served while the list is unknown", () => {
  expect(isServed([], "gateway.networking.k8s.io/v1", "Gateway")).toBe(true);
  const served = servedKinds([info("", "v1", "Pod")]);
  expect(isServed(served, "v1", "Pod")).toBe(true);
  expect(isServed(served, "gateway.networking.k8s.io/v1", "Gateway")).toBe(
    false,
  );
});
