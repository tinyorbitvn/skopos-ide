import { mockWindows } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { clusterEntry } from "../../test/ipc";
import { focusedTab, tabPath } from "./layout";
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

function layout(): WindowLayout {
  return useWindowLayout.getState().layout;
}

beforeEach(() => {
  resetCatalogForTest();
  useCatalog.setState({
    clusters: [clusterEntry({ id: "c1", name: "prod" })],
  });
  resetWindowLayoutForTest(twoPanes());
});

test("each pane shows its tabs, and only their selected tabs are mounted (P8, P9)", () => {
  render(<Panes />);
  expect(screen.getByTestId("pane-0")).toBeTruthy();
  expect(screen.getByTestId("pane-1")).toBeTruthy();
  expect(screen.getByTestId("pane-resize-0")).toBeTruthy();
  expect(screen.getByTestId("tab-t1").getAttribute("aria-label")).toBe(
    "Catalog",
  );
  // A cluster tab's chip names the cluster; the full title is its name.
  const map = screen.getByTestId("tab-t3");
  expect(map.getAttribute("aria-label")).toBe("Resource map · prod");
  expect(map.textContent).toBe("Resource mapprod");
  expect(screen.getByTestId("view-t1").textContent).toBe("/catalog");
  expect(screen.getByTestId("view-t3").textContent).toBe("/cluster/c1/map");
  expect(screen.queryByTestId("view-t2")).toBeNull();
  expect(screen.queryByTestId("view-t4")).toBeNull();
});

test("a tab click selects it, and Close closes it; a pinned tab has no Close (P14)", () => {
  render(<Panes />);
  expect(screen.queryByTestId("tab-close-t1")).toBeNull();
  fireEvent.click(screen.getByTestId("tab-t2"));
  expect(screen.getByTestId("view-t2")).toBeTruthy();
  expect(screen.queryByTestId("view-t1")).toBeNull();
  fireEvent.click(screen.getByTestId("tab-close-t2"));
  expect(screen.queryByTestId("tab-t2")).toBeNull();
  expect(screen.getByTestId("view-t1")).toBeTruthy();
});

test("a press in a pane focuses it; only then has it the outline (P19)", () => {
  render(<Panes />);
  expect(screen.getByTestId("pane-0").dataset.focused).toBe("true");
  expect(screen.getByTestId("pane-1").dataset.focused).toBe("false");
  fireEvent.pointerDown(screen.getByTestId("view-t3"));
  expect(layout().focusedPane).toBe(1);
  expect(screen.getByTestId("pane-1").dataset.focused).toBe("true");
  expect(screen.getByTestId("pane-0").dataset.focused).toBe("false");
});

test("with one pane, no outline is drawn", () => {
  resetWindowLayoutForTest({
    ...twoPanes(),
    panes: [twoPanes().panes[0]],
  });
  render(<Panes />);
  expect(screen.getByTestId("pane-0").dataset.focused).toBe("false");
  expect(screen.getByTestId("pane-0").dataset.current).toBe("true");
  expect(screen.queryByTestId("pane-resize-0")).toBeNull();
});

test("Split right opens the selected location in a new pane on the right, up to 3 panes (P20)", () => {
  render(<Panes />);
  fireEvent.click(screen.getByTestId("pane-split-1"));
  const panes = layout().panes;
  expect(panes).toHaveLength(3);
  expect(panes[2].tabs.map(tabPath)).toEqual(["/cluster/c1/map"]);
  expect(layout().focusedPane).toBe(2);
  const split = screen.getByTestId("pane-split-0") as HTMLButtonElement;
  expect(split.disabled).toBe(true);
  expect(split.getAttribute("aria-label")).toBe("Split right: 3 panes at most");
});

test("closing a pane's last tab closes the pane (P21)", () => {
  render(<Panes />);
  fireEvent.click(screen.getByTestId("tab-close-t3"));
  fireEvent.click(screen.getByTestId("tab-close-t4"));
  expect(screen.queryByTestId("pane-1")).toBeNull();
  expect(layout().panes.map((p) => p.width)).toEqual([1]);
});

test("the main window without tabs shows the empty state, which opens the Catalog (P21)", () => {
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: "", tabs: [] }],
    focusedPane: 0,
  });
  render(<Panes />);
  expect(screen.getByTestId("pane-empty").textContent).toContain(
    "No tabs open",
  );
  expect(
    (screen.getByTestId("pane-split-0") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByTestId("pane-empty-catalog"));
  const shown = focusedTab(layout());
  expect(shown === null ? null : tabPath(shown)).toBe("/catalog");
  expect(screen.getByTestId(`view-${shown?.id}`)).toBeTruthy();
});

test("another window without tabs shows no empty state", () => {
  mockWindows("window-2");
  resetWindowLayoutForTest({
    label: "window-2",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: "", tabs: [] }],
    focusedPane: 0,
  });
  render(<Panes />);
  expect(screen.queryByTestId("pane-empty")).toBeNull();
});

test("the splitter moves by 2% per arrow key, and a double-click makes the panes equal (P18)", () => {
  render(<Panes />);
  const splitter = screen.getByTestId("pane-resize-0");
  expect(splitter.getAttribute("aria-valuenow")).toBe("50");
  fireEvent.keyDown(splitter, { key: "ArrowRight" });
  fireEvent.keyDown(splitter, { key: "ArrowRight" });
  expect(layout().panes.map((p) => p.width)).toEqual([0.54, 0.46]);
  expect(splitter.getAttribute("aria-valuenow")).toBe("54");
  fireEvent.keyDown(splitter, { key: "ArrowLeft" });
  expect(layout().panes[0].width).toBe(0.52);
  act(() => {
    fireEvent.doubleClick(splitter);
  });
  expect(layout().panes.map((p) => p.width)).toEqual([0.5, 0.5]);
});

test("a pane's width share is its flex grow", () => {
  render(<Panes />);
  fireEvent.keyDown(screen.getByTestId("pane-resize-0"), {
    key: "ArrowRight",
  });
  expect(screen.getByTestId("pane-0").style.flexGrow).toBe("0.52");
  expect(screen.getByTestId("pane-1").style.flexGrow).toBe("0.48");
});

describe("a strip longer than its pane", () => {
  const original = Element.prototype.scrollIntoView;
  const scrolled = vi.fn();

  beforeEach(() => {
    scrolled.mockClear();
    Element.prototype.scrollIntoView = scrolled;
    const tabs = Array.from({ length: 20 }, (_, i) =>
      tab(`t${i + 1}`, `/cluster/c1/r/apps/deployments?n=${i + 1}`),
    );
    resetWindowLayoutForTest({
      label: "main",
      bounds: null,
      panes: [{ id: "p1", width: 1, selected: "t1", tabs }],
      focusedPane: 0,
    });
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  /** The strip elements `scrollIntoView` was called on, in order. */
  function scrolledTo(): Element[] {
    return scrolled.mock.contexts as Element[];
  }

  /** A tab's element in its strip: its button and its Close. */
  function tabElement(id: string): Element | null {
    return screen.getByTestId(`tab-${id}`).parentElement;
  }

  test("selecting the last tab scrolls it into sight without moving focus (P19)", () => {
    render(<Panes />);
    const focusedBefore = document.activeElement;
    scrolled.mockClear();

    act(() =>
      useWindowLayout.getState().dispatch({ type: "select", tabId: "t20" }),
    );

    expect(scrolledTo()).toEqual([tabElement("t20")]);
    expect(scrolled).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(document.activeElement).toBe(focusedBefore);
  });

  test("a new tab opened at the end of the strip is scrolled into sight (P12)", () => {
    render(<Panes />);
    scrolled.mockClear();

    act(() =>
      useWindowLayout.getState().dispatch({
        type: "open",
        path: "/preferences",
        mode: "newTab",
        newTabId: "t21",
        newPaneId: "p2",
      }),
    );

    expect(scrolledTo()).toEqual([tabElement("t21")]);
  });

  test("a vertical wheel over an overflowing strip scrolls it sideways", () => {
    render(<Panes />);
    const strip = screen.getByRole("tablist", { name: "Tabs of pane 1" });
    Object.defineProperty(strip, "scrollWidth", { value: 2400 });
    Object.defineProperty(strip, "clientWidth", { value: 600 });

    fireEvent.wheel(strip, { deltaY: 120 });
    fireEvent.wheel(strip, { deltaY: 3, deltaMode: 1 });

    expect(strip.scrollLeft).toBe(120 + 3 * 16);
  });
});
