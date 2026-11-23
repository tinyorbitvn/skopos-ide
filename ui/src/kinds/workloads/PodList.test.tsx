import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { expectKeptWidth, savedWidth } from "../../test/columnWidths";
import { flush, mockBackend } from "../../test/ipc";
import { DrawerLinkContext } from "../detail/links";
import type { KubeObject } from "../objects";
import { PodList } from "./PodList";

function live(handlers: Parameters<typeof mockBackend>[0] = {}) {
  let send: (e: WatchEvent) => void = () => {};
  mockBackend({
    ...handlers,
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub";
    },
    resources_unsubscribe: () => null,
  });
  return (items: KubeObject[]) =>
    act(async () => {
      send({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
}

const show = (match: (p: KubeObject) => boolean, namespace?: string) =>
  render(
    <MemoryRouter>
      <PodList clusterId="c" match={match} namespace={namespace} />
    </MemoryRouter>,
  );

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("lists the matching pods with status and a link", async () => {
  const snapshot = live();
  show((p) => p.metadata.labels?.app === "web", "n");
  await act(flush);
  await snapshot([
    {
      metadata: { name: "a", namespace: "n", labels: { app: "web" } },
      status: { phase: "Running" },
    },
    { metadata: { name: "b", namespace: "n", labels: { app: "db" } } },
    { metadata: { name: "c", namespace: "other", labels: { app: "web" } } },
  ]);
  const table = within(screen.getByTestId("detail-pods"));
  expect(table.getByRole("link", { name: "a" }).getAttribute("href")).toBe(
    "/cluster/c/r/core/pods?object=n%2Fa",
  );
  expect(table.getByText("Running")).toBeTruthy();
  expect(table.queryByText("b")).toBeNull();
  expect(table.queryByText("c")).toBeNull();
});

test("shows a spinner while loading", async () => {
  live();
  show(() => true);
  await act(flush);
  expect(screen.getByTestId("detail-pods-loading")).toBeTruthy();
});

test("says when no pod matches", async () => {
  const snapshot = live();
  show(() => false);
  await act(flush);
  await snapshot([{ metadata: { name: "a", namespace: "n" } }]);
  expect(screen.getByText("No pods.")).toBeTruthy();
});

test("says so when pods cannot be listed", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "Forbidden", message: "pods is forbidden" };
    },
    resources_unsubscribe: () => null,
  });
  show(() => true);
  await act(flush);
  expect(screen.getByRole("alert").textContent).toContain("pods is forbidden");
  expect(screen.queryByText("No pods.")).toBeNull();
});

test("inside a drawer a pod's name opens the Pod in that drawer", async () => {
  const snapshot = live();
  const open = vi.fn();
  render(
    <MemoryRouter>
      <DrawerLinkContext.Provider value={{ open }}>
        <PodList clusterId="c" match={() => true} namespace="n" />
      </DrawerLinkContext.Provider>
    </MemoryRouter>,
  );
  await act(flush);
  await snapshot([{ metadata: { name: "a", namespace: "n" } }]);
  const table = within(screen.getByTestId("detail-pods"));
  expect(table.queryByRole("link")).toBeNull();
  fireEvent.click(table.getByRole("button", { name: "a" }));
  expect(open).toHaveBeenCalledWith({
    group: "",
    plural: "pods",
    namespace: "n",
    name: "a",
  });
});

function askedNamespaces(namespace?: string) {
  const backend = mockBackend({
    resources_subscribe: () => "sub",
    resources_unsubscribe: () => null,
  });
  show(() => true, namespace);
  return backend;
}

test("asks for the pods of the given namespace only", async () => {
  const backend = askedNamespaces("n");
  await act(flush);
  const asked = backend.callsTo("resources_subscribe");
  expect(asked.map((a) => a.namespaces)).toEqual([["n"]]);
});

test("without a namespace it asks for the pods of every namespace", async () => {
  const backend = askedNamespaces();
  await act(flush);
  const asked = backend.callsTo("resources_subscribe");
  expect(asked.map((a) => a.namespaces)).toEqual([[]]);
});

test("the Pods of a node are asked for by the node, and not as every Pod", async () => {
  let send: (e: WatchEvent) => void = () => {};
  const backend = mockBackend({
    resources_subscribe: () => "list",
    resources_subscribe_node_pods: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "node";
    },
    resources_unsubscribe: () => null,
  });
  render(
    <MemoryRouter>
      <PodList
        clusterId="c"
        node="worker-1"
        match={(p) => p.spec?.nodeName === "worker-1"}
      />
    </MemoryRouter>,
  );
  await act(flush);
  expect(screen.getByTestId("detail-pods-loading")).toBeTruthy();
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        {
          metadata: { name: "a", namespace: "n" },
          spec: { nodeName: "worker-1" },
        },
      ],
    } as WatchEvent);
    await flush();
  });

  expect(within(screen.getByTestId("detail-pods")).getByText("a")).toBeTruthy();
  expect(backend.callsTo("resources_subscribe_node_pods")).toMatchObject([
    { clusterId: "c", node: "worker-1" },
  ]);
  expect(backend.callsTo("resources_subscribe")).toHaveLength(0);
});

test("keeps the widths its columns are given, between runs", async () => {
  const state = savedWidth("#detail-pods", "name");
  const snapshot = live(state.handlers);
  show(() => true, "n");
  await act(flush);
  await snapshot([{ metadata: { name: "a", namespace: "n" } }]);
  await expectKeptWidth(state, "#detail-pods", "name");
});
