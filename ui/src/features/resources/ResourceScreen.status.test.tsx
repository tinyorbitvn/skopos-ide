import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { DEPLOYMENTS } from "../../kinds/refs";
import "../../kinds/workloads";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { ResourceScreen } from "./ResourceScreen";

const INFO: ApiResourceInfo = {
  resource: DEPLOYMENTS,
  verbs: ["list", "watch"],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
};

const controlledBy = (uid: string) => [
  { apiVersion: "v1", kind: "X", name: "owner", uid, controller: true },
];

const WEB: KubeObject = {
  metadata: { name: "web", namespace: "ns", uid: "d1", resourceVersion: "1" },
  spec: { replicas: 2 },
  status: {
    replicas: 2,
    updatedReplicas: 2,
    readyReplicas: 2,
    conditions: [{ type: "Available", status: "True" }],
  },
};
const WEB_RS: KubeObject = {
  metadata: {
    name: "web-abc",
    namespace: "ns",
    uid: "rs1",
    ownerReferences: controlledBy("d1"),
  },
};
const crashing = (name: string): KubeObject => ({
  metadata: {
    name,
    namespace: "ns",
    uid: `pod-${name}`,
    ownerReferences: controlledBy("rs1"),
  },
  spec: { containers: [{ name: "c" }] },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "c",
        ready: false,
        restartCount: 3,
        state: { waiting: { reason: "CrashLoopBackOff" } },
      },
    ],
  },
});

function fakeBackend() {
  const subs = new Map<string, (event: WatchEvent) => void>();
  mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    resource_events: () => [],
  });
  return async (plural: string, items: KubeObject[]) => {
    await act(async () => {
      subs.get(plural)?.({ type: "snapshot", items });
      subs.get(plural)?.({ type: "status", status: "live", message: null });
      await flush();
    });
  };
}

beforeEach(() => {
  resetResourcesForTest();
  mockElementSize();
});
afterEach(() => resetResourcesForTest());

test("a Deployment's Status shows its Pods' worst state, and clicking it opens the drawer", async () => {
  const send = fakeBackend();
  render(
    <MemoryRouter>
      <ResourceScreen clusterId="c1" info={INFO} resources={[INFO]} />
    </MemoryRouter>,
  );
  await act(flush);
  await send("deployments", [WEB]);
  const row = screen.getByTestId("resource-row-ns-web");
  expect(within(row).getByText("Available")).toBeTruthy();
  await send("replicasets", [WEB_RS]);
  await send("pods", [crashing("web-abc-1"), crashing("web-abc-2")]);
  const cell = within(row).getByTestId("status-cell");
  expect(cell.getAttribute("aria-label")).toBe("CrashLoopBackOff, 2 of 2 Pods");
  fireEvent.click(cell);
  await act(flush);
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
});
