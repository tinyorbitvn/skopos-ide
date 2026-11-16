import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONFIG_MAP } from "../../test/apiDocs";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { resetApiDocsCacheForTest } from "./apiDocsCache";
import { resetApiDocsToggleForTest } from "./apiDocsToggle";
import { ApiDocsButton, EditorLayout } from "./EditorLayout";

const TARGET = { apiVersion: "v1", kind: "ConfigMap" };

/** A backend whose `ui_state` holds `saved`. */
function backend(saved: Record<string, unknown> = {}) {
  return mockBackend({
    ui_state_get: (args: { key: string }) => saved[args.key] ?? null,
    ui_state_set: () => null,
    api_schema: () => CONFIG_MAP,
  });
}

/** A YAML tab: its toolbar button, and its editor with the API docs beside it. */
function Tab(props: { id: string }) {
  return (
    <div data-testid={props.id}>
      <ApiDocsButton />
      <EditorLayout clusterId="c1" target={TARGET}>
        <div data-testid={`${props.id}-editor`} />
      </EditorLayout>
    </div>
  );
}

async function showTabs(...ids: string[]) {
  render(
    <>
      {ids.map((id) => (
        <Tab key={id} id={id} />
      ))}
    </>,
  );
  await act(flush);
  await act(flush);
}

function inTab(id: string) {
  return within(screen.getByTestId(id));
}

beforeEach(() => mockElementSize());

afterEach(() => {
  // Unmount before the resets, so no mounted panel asks for API docs again and fills
  // the cache the next test starts from.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetApiDocsToggleForTest();
  resetApiDocsCacheForTest();
});

test("the API docs are on at first, and the toggle hides them in every tab and saves that (spec L17, L18)", async () => {
  const calls = backend();
  await showTabs("a", "b");
  for (const id of ["a", "b"]) {
    expect(inTab(id).getByTestId("api-docs")).toBeTruthy();
    expect(
      inTab(id).getByTestId("api-docs-toggle").getAttribute("aria-pressed"),
    ).toBe("true");
  }

  fireEvent.click(inTab("a").getByTestId("api-docs-toggle"));

  for (const id of ["a", "b"]) {
    expect(inTab(id).queryByTestId("api-docs")).toBeNull();
    expect(
      inTab(id).getByTestId("api-docs-toggle").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(inTab(id).getByTestId(`${id}-editor`)).toBeTruthy();
  }
  expect(calls.callsTo("ui_state_set")).toEqual([
    { key: "editor.apiDocs", value: false },
  ]);

  fireEvent.click(inTab("b").getByTestId("api-docs-toggle"));
  expect(inTab("a").getByTestId("api-docs")).toBeTruthy();
  // Read once per run, however many tabs there are.
  expect(
    calls
      .callsTo("ui_state_get")
      .filter((args) => args.key === "editor.apiDocs"),
  ).toHaveLength(1);
});

test("a saved off keeps the API docs away, and nothing shows before it is read (spec L17)", async () => {
  let answer: (saved: unknown) => void = () => {};
  const calls = mockBackend({
    ui_state_get: (args: { key: string }) =>
      args.key === "editor.apiDocs"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : null,
    ui_state_set: () => null,
    api_schema: () => CONFIG_MAP,
  });
  await showTabs("a");
  expect(screen.queryByTestId("api-docs")).toBeNull();

  await act(async () => {
    answer(false);
    await flush();
  });

  expect(screen.queryByTestId("api-docs")).toBeNull();
  expect(
    screen.getByTestId("api-docs-toggle").getAttribute("aria-pressed"),
  ).toBe("false");
  expect(calls.callsTo("api_schema")).toEqual([]);
});

test.each([
  ["a text", "off"],
  ["a number", 0],
  ["a list", [false]],
])(
  "a saved value that is %s is not a choice, so the API docs stay on",
  async (_, saved) => {
    backend({ "editor.apiDocs": saved });
    await showTabs("a");

    expect(screen.getByTestId("api-docs")).toBeTruthy();
  },
);

test("a saved value that cannot be read leaves the API docs on", async () => {
  mockBackend({
    ui_state_get: () => {
      throw { code: "Internal", message: "no store", details: null };
    },
    api_schema: () => CONFIG_MAP,
  });
  await showTabs("a");

  expect(screen.getByTestId("api-docs")).toBeTruthy();
});

test.each([
  ["nothing saved", undefined, 340],
  ["too narrow", 100, 280],
  ["too wide", 900, 560],
  ["in bounds", 400, 400],
])("the width with %s is %i (spec L18)", async (_, saved, width) => {
  backend(saved === undefined ? {} : { "layout.apiDocsWidth": saved });
  await showTabs("a");

  const handle = screen.getByRole("separator", { name: "Resize API docs" });
  expect(handle.getAttribute("aria-valuenow")).toBe(String(width));
  expect([
    handle.getAttribute("aria-valuemin"),
    handle.getAttribute("aria-valuemax"),
  ]).toEqual(["280", "560"]);
  expect(screen.getByTestId("api-docs").parentElement?.style.width).toBe(
    `${width}px`,
  );
});

test("the handle widens the panel and saves the width (spec L18)", async () => {
  const calls = backend();
  await showTabs("a");
  vi.useFakeTimers();

  // The handle is on the panel's left edge, so Left widens it.
  fireEvent.keyDown(screen.getByTestId("api-docs-resize"), {
    key: "ArrowLeft",
  });
  expect(
    screen.getByTestId("api-docs-resize").getAttribute("aria-valuenow"),
  ).toBe("356");
  act(() => {
    vi.advanceTimersByTime(350);
  });

  expect(calls.callsTo("ui_state_set")).toEqual([
    { key: "layout.apiDocsWidth", value: 356 },
  ]);
});
