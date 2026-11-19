import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { registerKind } from "../../kinds/registry";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { buildFilterIndex } from "./filter";
import { ResourceScreen } from "./ResourceScreen";

// The real index, watched, to see when a list counts its keys and values.
vi.mock("./filter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./filter")>();
  return { ...actual, buildFilterIndex: vi.fn(actual.buildFilterIndex) };
});

function info(resource: Partial<ResourceRef>): ApiResourceInfo {
  return {
    resource: {
      group: "",
      version: "v1",
      plural: "pods",
      kind: "Pod",
      namespaced: true,
      ...resource,
    },
    verbs: ["list", "watch", "delete"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

function labelled(
  name: string,
  labels: Record<string, string> = {},
  namespace?: string,
  resourceVersion = "1",
): KubeObject {
  return { metadata: { name, namespace, resourceVersion, labels } };
}

/** Shows the list with its first objects; the result sends each later batch of changes. */
async function show(resource: ApiResourceInfo, items: KubeObject[]) {
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
  const send = async (event: WatchEvent) => {
    await act(async () => {
      subs.get(resource.resource.plural)?.(event);
      await flush();
    });
  };
  render(
    <MemoryRouter>
      <ResourceScreen clusterId="c1" info={resource} resources={[resource]} />
    </MemoryRouter>,
  );
  await act(flush);
  await send({ type: "snapshot", items } as WatchEvent);
  await send({ type: "status", status: "live", message: null });
  return (upserts: KubeObject[]) =>
    send({ type: "batch", upserts, deletes: [] } as WatchEvent);
}

const optionTexts = () =>
  within(screen.getByTestId("filter-suggestions"))
    .getAllByRole("option")
    .map((o) => o.firstElementChild?.textContent);

beforeEach(() => {
  resetResourcesForTest();
  mockElementSize();
  vi.mocked(buildFilterIndex).mockClear();
});
afterEach(() => {
  resetResourcesForTest();
  vi.restoreAllMocks();
});

test("the filter index is counted only while the suggestions show, and again for each batch then", async () => {
  const batch = await show(info({}), [labelled("web", { app: "web" }, "ns")]);
  await batch([labelled("db", { tier: "data" }, "ns")]);
  expect(buildFilterIndex).not.toHaveBeenCalled();

  const box = screen.getByTestId("resource-search");
  act(() => box.focus());
  expect(buildFilterIndex).toHaveBeenCalledTimes(1);
  expect(optionTexts()).toEqual(
    expect.arrayContaining(["label:app", "label:tier"]),
  );

  await batch([labelled("cache", { role: "cache" }, "ns")]);
  expect(buildFilterIndex).toHaveBeenCalledTimes(2);
  expect(optionTexts()).toContain("label:role");

  act(() => box.blur());
  expect(screen.queryByTestId("filter-suggestions")).toBeNull();
  await batch([labelled("queue", { role: "queue" }, "ns")]);
  expect(buildFilterIndex).toHaveBeenCalledTimes(2);
});

test("a batch renders again only the rows whose objects changed", async () => {
  const cell = vi.fn((o: KubeObject) => o.metadata.name);
  registerKind("batch.test", "sprockets", {
    columns: () => [
      { id: "sprocket", header: "Sprocket", width: 80, render: cell },
    ],
  });
  const batch = await show(
    info({ group: "batch.test", plural: "sprockets", kind: "Sprocket" }),
    [labelled("a", {}, "ns"), labelled("b", {}, "ns")],
  );
  expect(screen.getByTestId("resource-row-ns-a")).toBeTruthy();

  cell.mockClear();
  await batch([labelled("b", { changed: "yes" }, "ns", "2")]);
  expect(cell.mock.calls.map(([o]) => o.metadata.name)).toEqual(["b"]);
});

test("selecting a row of a cluster-scoped list does not sort it again", async () => {
  const sortValue = vi.fn((o: KubeObject) => o.metadata.name);
  registerKind("batch.test", "widgets", {
    columns: () => [
      {
        id: "widget",
        header: "Widget",
        width: 80,
        sortValue,
        render: (o) => o.metadata.name,
      },
    ],
  });
  await show(
    info({
      group: "batch.test",
      plural: "widgets",
      kind: "Widget",
      namespaced: false,
    }),
    [labelled("b"), labelled("a")],
  );
  fireEvent.click(screen.getByRole("button", { name: "Widget" }));
  expect(sortValue).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("checkbox", { name: "Select a" }));
  expect(screen.getByTestId("bulk-delete").textContent).toBe("Delete (1)");
  expect(sortValue).toHaveBeenCalledTimes(2);
});
