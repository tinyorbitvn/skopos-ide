import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { PODS } from "../../kinds/refs";
import { podSessionTab } from "../../stores/dock";
import { resetResourcesForTest, useResourceList } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { containerChoices, useContainerChoices } from "./podContainers";

test("the choices are the Pod's containers, a waiting one with its reason", () => {
  expect(
    containerChoices({
      metadata: { name: "web-1", namespace: "shop" },
      spec: {
        initContainers: [{ name: "setup" }],
        containers: [{ name: "app" }, { name: "sidecar" }, { name: "proxy" }],
        ephemeralContainers: [{ name: "debugger" }],
      },
      status: {
        containerStatuses: [
          { name: "app", state: { waiting: { reason: "CrashLoopBackOff" } } },
          { name: "sidecar", state: { running: {} } },
          { name: "proxy", state: { waiting: {} } },
        ],
      },
    }),
  ).toEqual([
    { value: "app", label: "app (CrashLoopBackOff)" },
    { value: "sidecar", label: "sidecar" },
    { value: "proxy", label: "proxy" },
  ]);
});

test("there are no choices before the Pod row is there", () => {
  expect(containerChoices(undefined)).toEqual([]);
  expect(containerChoices({ metadata: { name: "web-1" } })).toEqual([]);
});

type OnEvent = { onmessage: (e: WatchEvent) => void };

function watches() {
  const sent = { list: (_e: WatchEvent) => {}, object: (_e: WatchEvent) => {} };
  const b = mockBackend({
    resources_subscribe: (a: { onEvent: OnEvent }) => {
      sent.list = a.onEvent.onmessage;
      return "list";
    },
    resources_subscribe_object: (a: { onEvent: OnEvent }) => {
      sent.object = a.onEvent.onmessage;
      return "object";
    },
    resources_unsubscribe: () => null,
  });
  const snapshot = (to: "list" | "object", items: KubeObject[]) =>
    act(async () => {
      sent[to]({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  return { b, snapshot };
}

const SHELL = podSessionTab("shell", "c1", "shop", "web-1", "app");
const WEB: KubeObject = {
  metadata: { name: "web-1", namespace: "shop" },
  spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
};

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("a Shell tab watches its one Pod, not every Pod", async () => {
  const { b, snapshot } = watches();
  const { result } = renderHook(() => useContainerChoices(SHELL));
  await act(flush);
  expect(b.callsTo("resources_subscribe")).toEqual([]);
  expect(b.callsTo("resources_subscribe_object")).toEqual([
    {
      clusterId: "c1",
      resource: PODS,
      namespace: "shop",
      name: "web-1",
      onEvent: expect.anything(),
    },
  ]);
  await snapshot("object", [WEB]);
  expect(result.current.map((c) => c.value)).toEqual(["app", "sidecar"]);
});

test("a Shell tab reads its Pod's row from a Pods list another view holds", async () => {
  const { b, snapshot } = watches();
  renderHook(() => useResourceList("c1", PODS));
  await act(flush);
  await snapshot("list", [WEB]);
  const { result } = renderHook(() => useContainerChoices(SHELL));
  await act(flush);
  expect(result.current.map((c) => c.value)).toEqual(["app", "sidecar"]);
  expect(b.callsTo("resources_subscribe")).toHaveLength(1);
  expect(b.callsTo("resources_subscribe_object")).toEqual([]);
});

test("no tab watches nothing", async () => {
  const { b } = watches();
  const { result } = renderHook(() => useContainerChoices(null));
  await act(flush);
  expect(result.current).toEqual([]);
  expect(b.calls).toEqual([]);
});
