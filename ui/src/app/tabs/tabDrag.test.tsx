import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import {
  resetWindowLayoutForTest,
  startWindowLayout,
  useWindowLayout,
} from "../../stores/windowLayout";
import { clusterEntry, mockBackend } from "../../test/ipc";
import { tabPath } from "./layout";
import { Panes } from "./Panes";

// A tab's screen is a stand-in here: the tab router has its own tests.
vi.mock("./TabView", () => ({
  TabView: (props: { tab: TabState }) => (
    <p data-testid={`view-${props.tab.id}`}>
      {props.tab.history[props.tab.index]}
    </p>
  ),
}));

function tab(id: string, path: string, pinned = false): TabState {
  return { id, pinned, history: [path], index: 0 };
}

function twoPanes(): WindowLayout {
  return {
    label: "main",
    bounds: null,
    panes: [
      {
        id: "p1",
        width: 0.5,
        selected: "t1",
        tabs: [tab("t1", "/catalog", true), tab("t2", "/preferences")],
      },
      {
        id: "p2",
        width: 0.5,
        selected: "t3",
        tabs: [tab("t3", "/cluster/c1/map"), tab("t4", "/cluster/c1")],
      },
    ],
    focusedPane: 0,
  };
}

// Per pane: `p1:*/catalog^,/x`, each tab's shown path, `*` selected, `^` pinned.
function shape(): string {
  return useWindowLayout
    .getState()
    .layout.panes.map(
      (p) =>
        `${p.tabs
          .map(
            (t) =>
              `${p.selected === t.id ? "*" : ""}${tabPath(t)}${t.pinned ? "^" : ""}`,
          )
          .join(",")}`,
    )
    .join(" | ");
}

/** What `document.elementFromPoint` finds from now on. */
function under(el: Element | null): void {
  document.elementFromPoint = vi.fn(() => el);
}

function down(tabId: string, x = 10, y = 10): void {
  fireEvent.pointerDown(screen.getByTestId(`tab-${tabId}`), {
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    pointerId: 1,
  });
}

function move(x: number, y: number, buttons = 1): void {
  fireEvent.pointerMove(window, {
    clientX: x,
    clientY: y,
    buttons,
    pointerId: 1,
  });
}

function up(x: number, y: number, at = { screenX: 0, screenY: 0 }): void {
  fireEvent.pointerUp(window, { clientX: x, clientY: y, pointerId: 1, ...at });
}

function strip(index: number): Element {
  const el = screen
    .getByTestId(`pane-${index}`)
    .querySelector("[data-drop-count]");
  if (el === null) throw new Error("no strip");
  return el;
}

function label(): string {
  return screen.getByTestId("tab-drag-label").textContent ?? "";
}

const elementFromPoint = document.elementFromPoint;

beforeEach(() => {
  resetCatalogForTest();
  useCatalog.setState({
    clusters: [clusterEntry({ id: "c1", name: "prod" })],
  });
  resetWindowLayoutForTest(twoPanes());
  under(null);
});

afterEach(async () => {
  // Ends a drag a test left going, and lets the click after a drop be swallowed.
  fireEvent.pointerCancel(window, { pointerId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.elementFromPoint = elementFromPoint;
  resetWindowLayoutForTest();
  vi.restoreAllMocks();
});

test("a press that moves less than 6 px is a click: it selects and drags nothing (P22)", () => {
  render(<Panes />);
  down("t2");
  move(13, 13);
  expect(screen.queryByTestId("tab-drag-label")).toBeNull();
  up(13, 13);
  fireEvent.click(screen.getByTestId("tab-t2"));
  expect(shape()).toBe(
    "/catalog^,*/preferences | */cluster/c1/map,/cluster/c1",
  );
});

test("a drag shows the dragged tab, the body zones and a label beside the pointer (P22)", () => {
  render(<Panes />);
  down("t2");
  move(16, 10);
  expect(label()).toBe("PreferencesLet go here to cancel");
  expect(
    screen
      .getByTestId("tab-t2")
      .closest("[data-dragging]")
      ?.getAttribute("data-dragging"),
  ).toBe("true");
  expect(
    screen.queryAllByTestId(/^pane-drop-/).map((z) => z.dataset.testid),
  ).toEqual([
    "pane-drop-left-0",
    "pane-drop-right-0",
    "pane-drop-left-1",
    "pane-drop-right-1",
  ]);
  expect(screen.getByTestId("pane-drop-left-1").textContent).toBe(
    "New pane on the left",
  );
});

test("over a strip it marks the place, and letting go there moves the tab (P22)", () => {
  render(<Panes />);
  down("t4");
  under(strip(0));
  move(40, 10);
  expect(label()).toBe("Overview · prodLet go to place it here");
  // The mark sits after the last tab of the first strip.
  const marks = screen
    .getByTestId("pane-0")
    .querySelectorAll('[data-testid="tab-drop-mark"]');
  expect(marks).toHaveLength(1);
  expect(
    marks[0].previousElementSibling?.querySelector('[role="tab"]')?.id,
  ).toBe("pane-tab-t2");
  up(40, 10);
  expect(shape()).toBe(
    "/catalog^,/preferences,*/cluster/c1 | */cluster/c1/map",
  );
  expect(screen.queryByTestId("tab-drag-label")).toBeNull();
  expect(screen.queryAllByTestId(/^pane-drop-/)).toEqual([]);
});

test("over a body half it opens a new pane on that side (P22)", () => {
  render(<Panes />);
  down("t2");
  move(20, 10);
  under(screen.getByTestId("pane-drop-left-1"));
  move(400, 300);
  expect(label()).toBe("PreferencesLet go: new pane on the left");
  expect(screen.getByTestId("pane-drop-left-1").dataset.over).toBe("true");
  expect(screen.getByTestId("pane-drop-right-1").dataset.over).toBe("false");
  up(400, 300);
  expect(shape()).toBe(
    "*/catalog^ | */preferences | */cluster/c1/map,/cluster/c1",
  );
  expect(useWindowLayout.getState().layout.focusedPane).toBe(1);
});

test("at 3 panes another pane's body only takes the tab (P22)", () => {
  render(<Panes />);
  fireEvent.click(screen.getByTestId("pane-split-1"));
  down("t2");
  move(20, 10);
  expect(screen.queryByTestId("pane-drop-left-1")).toBeNull();
  expect(screen.queryByTestId("pane-drop-here-0")).toBeNull();
  under(screen.getByTestId("pane-drop-here-2"));
  move(500, 300);
  expect(label()).toBe("PreferencesLet go: move to this pane");
  expect(screen.getByTestId("pane-drop-here-2").textContent).toBe(
    "Move to this pane (3 panes at most)",
  );
  up(500, 300);
  expect(shape()).toBe(
    "*/catalog^ | */cluster/c1/map,/cluster/c1 | /cluster/c1/map,*/preferences",
  );
});

test("Esc cancels the drag, and the click after the release selects nothing", async () => {
  render(<Panes />);
  down("t2");
  move(20, 10);
  under(screen.getByTestId("pane-drop-right-1"));
  move(400, 300);
  const esc = fireEvent.keyDown(window, { key: "Escape" });
  expect(esc).toBe(false);
  expect(screen.queryByTestId("tab-drag-label")).toBeNull();
  expect(screen.queryAllByTestId(/^pane-drop-/)).toEqual([]);
  up(400, 300);
  fireEvent.click(screen.getByTestId("tab-t4"));
  expect(shape()).toBe(
    "*/catalog^,/preferences | */cluster/c1/map,/cluster/c1",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.click(screen.getByTestId("tab-t4"));
  expect(shape()).toBe(
    "*/catalog^,/preferences | /cluster/c1/map,*/cluster/c1",
  );
});

test("letting go anywhere else cancels, and the click that follows selects nothing", async () => {
  render(<Panes />);
  down("t4");
  move(30, 10);
  under(document.body);
  move(30, 400);
  up(30, 400);
  fireEvent.click(screen.getByTestId("tab-t4"));
  expect(shape()).toBe(
    "*/catalog^,/preferences | */cluster/c1/map,/cluster/c1",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.click(screen.getByTestId("tab-t4"));
  expect(shape()).toBe(
    "*/catalog^,/preferences | /cluster/c1/map,*/cluster/c1",
  );
});

test("a release that never came in cancels the drag on the next move", () => {
  render(<Panes />);
  down("t2");
  move(20, 10);
  move(30, 10, 0);
  expect(screen.queryByTestId("tab-drag-label")).toBeNull();
  under(screen.getByTestId("pane-1"));
  up(30, 10);
  expect(shape()).toBe(
    "*/catalog^,/preferences | */cluster/c1/map,/cluster/c1",
  );
});

test("let go outside the window, the pending save goes first, then the core moves the tab (P31)", async () => {
  const backend = mockBackend({
    window_layout_get: () => twoPanes(),
    window_layout_set: () => null,
    window_tab_drop: () => ({
      target: "window-2",
      created: true,
      sourceEmpty: false,
    }),
  });
  await startWindowLayout(() => true);
  render(<Panes />);
  fireEvent.click(screen.getByTestId("tab-t2"));
  down("t4");
  move(30, 10);
  move(-20, 300);
  expect(label()).toBe(
    "Overview · prodLet go: into the window there, or a new window",
  );
  up(-20, 300, { screenX: 1480, screenY: 520 });
  await waitFor(() =>
    expect(backend.callsTo("window_tab_drop")).toEqual([
      { tabId: "t4", screenX: 1480, screenY: 520 },
    ]),
  );
  const order = backend.calls
    .map((c) => c.cmd)
    .filter((cmd) => cmd === "window_layout_set" || cmd === "window_tab_drop");
  expect(order).toEqual(["window_layout_set", "window_tab_drop"]);
  // The core's layout event moves the tab; nothing changes here before it.
  expect(shape()).toBe(
    "/catalog^,*/preferences | */cluster/c1/map,/cluster/c1",
  );
});

test("a drop outside that fails says why in a toast, and the tab stays (P44)", async () => {
  mockBackend({
    window_tab_drop: () => {
      throw {
        code: "Internal",
        message: "Could not open a new window: no display.",
        details: null,
      };
    },
  });
  const failed = vi.spyOn(toast, "error");
  render(<Panes />);
  down("t4");
  move(30, 10);
  up(30, 2000, { screenX: 40, screenY: 2100 });
  await waitFor(() =>
    expect(failed).toHaveBeenCalledWith(
      "Could not open a new window: no display.",
    ),
  );
  expect(shape()).toBe(
    "*/catalog^,/preferences | */cluster/c1/map,/cluster/c1",
  );
});
