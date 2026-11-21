import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { CRONJOBS, DEPLOYMENTS, PODS } from "../../kinds/refs";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { useOwnedPods } from "./useOwnedPods";

function info(resource: ResourceRef): ApiResourceInfo {
  return {
    resource,
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

const STATEFULSETS = info({
  ...DEPLOYMENTS,
  plural: "statefulsets",
  kind: "StatefulSet",
});

type Send = (event: WatchEvent) => Promise<void>;

function setup() {
  const subs = new Map<string, Send>();
  const backend = mockBackend({
    resources_subscribe: (args: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(args.resource.plural, async (event) => {
        await act(async () => {
          args.onEvent.onmessage(event);
          await flush();
        });
      });
      return `sub-${args.resource.plural}`;
    },
    resources_unsubscribe: () => null,
  });
  const send = (plural: string, event: WatchEvent) => {
    const to = subs.get(plural);
    if (!to) throw new Error(`no watch on ${plural}`);
    return to(event);
  };
  return { subs, backend, send };
}

const snapshot = (...items: KubeObject[]): WatchEvent => ({
  type: "snapshot",
  items,
});
const status = (s: "forbidden" | "notServed" | "reconnecting"): WatchEvent => ({
  type: "status",
  status: s,
  message: null,
});

const owned = (name: string, uid: string, owner: string): KubeObject => ({
  metadata: {
    name,
    namespace: "ns",
    uid,
    ownerReferences: [
      {
        apiVersion: "v1",
        kind: "X",
        name: "owner",
        uid: owner,
        controller: true,
      },
    ],
  },
});

const WEB: KubeObject = {
  metadata: { name: "web", namespace: "ns", uid: "d1" },
};

const NO_NAMESPACES: string[] = [];

async function mount(
  kind: ApiResourceInfo | undefined,
  namespaces: readonly string[] = NO_NAMESPACES,
) {
  const hook = renderHook(() => useOwnedPods("c1", kind, namespaces));
  await act(flush);
  return hook;
}

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("the Pods list and other kinds watch nothing", async () => {
  const { subs } = setup();
  for (const kind of [undefined, info(PODS)]) {
    const { result, unmount } = await mount(kind);
    expect(result.current).toBeUndefined();
    unmount();
  }
  expect([...subs.keys()]).toEqual([]);
});

test("a StatefulSet list watches Pods only and answers once they load", async () => {
  const { subs, send } = setup();
  const { result } = await mount(STATEFULSETS);
  expect([...subs.keys()]).toEqual(["pods"]);
  expect(result.current).toBeUndefined();
  await send("pods", snapshot(owned("web-0", "p1", "d1")));
  expect(result.current?.podsOf(WEB)?.map((p) => p.metadata.name)).toEqual([
    "web-0",
  ]);
});

test("a Deployment list also watches ReplicaSets and waits for both", async () => {
  const { subs, send } = setup();
  const { result } = await mount(info(DEPLOYMENTS));
  expect([...subs.keys()].sort()).toEqual(["pods", "replicasets"]);
  await send("pods", snapshot(owned("web-1", "p1", "rs1")));
  expect(result.current).toBeUndefined();
  await send("replicasets", snapshot(owned("web-abc", "rs1", "d1")));
  expect(result.current?.podsOf(WEB)?.map((p) => p.metadata.name)).toEqual([
    "web-1",
  ]);
});

test("a CronJob list also watches Jobs", async () => {
  const { subs } = setup();
  await mount(info(CRONJOBS));
  expect([...subs.keys()].sort()).toEqual(["jobs", "pods"]);
});

test("forbidden ReplicaSets leave Deployments on their own status", async () => {
  const { send } = setup();
  const { result } = await mount(info(DEPLOYMENTS));
  await send("pods", snapshot(owned("web-1", "p1", "rs1")));
  await send("replicasets", status("forbidden"));
  expect(result.current).toBeUndefined();
});

test("Pods that are not served or forbidden give no answer", async () => {
  for (const s of ["notServed", "forbidden"] as const) {
    resetResourcesForTest();
    const { send } = setup();
    const { result, unmount } = await mount(STATEFULSETS);
    await send("pods", status(s));
    expect(result.current).toBeUndefined();
    unmount();
  }
});

test("a reconnecting watch keeps answering from its last items", async () => {
  const { send } = setup();
  const { result } = await mount(STATEFULSETS);
  await send("pods", snapshot(owned("web-0", "p1", "d1")));
  await send("pods", status("reconnecting"));
  expect(result.current?.podsOf(WEB)?.map((p) => p.metadata.name)).toEqual([
    "web-0",
  ]);
});

test("every list it opens is asked with the given namespaces", async () => {
  const { backend } = setup();
  await mount(info(DEPLOYMENTS), ["b", "a"]);
  await mount(info(CRONJOBS), ["b", "a"]);
  // The Pods watch is shared by both lists.
  const asked = backend
    .callsTo("resources_subscribe")
    .map((a) => [(a.resource as ResourceRef).plural, a.namespaces]);
  expect(asked.sort()).toEqual([
    ["jobs", ["a", "b"]],
    ["pods", ["a", "b"]],
    ["replicasets", ["a", "b"]],
  ]);
});
