import { mockWindows } from "@tauri-apps/api/mocks";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { clusterEntry, mockBackend } from "../../test/ipc";
import { focusedTab, tabPath } from "./layout";
import { Panes } from "./Panes";
import { tabElementId } from "./tabKeys";

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

  test("closing the selected tab scrolls the tab that takes its place into sight (P19)", () => {
    render(<Panes />);
    const focusedBefore = document.activeElement;
    scrolled.mockClear();

    act(() =>
      useWindowLayout.getState().dispatch({ type: "close", tabId: "t1" }),
    );

    expect(layout().panes[0].selected).toBe("t2");
    expect(scrolledTo()).toEqual([tabElement("t2")]);
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

// Per pane: `p1:*/catalog^,/x`, each tab's shown path, `*` selected, `^` pinned.
function shape(): string {
  return layout()
    .panes.map(
      (p) =>
        `${p.id}:${p.tabs
          .map(
            (t) =>
              `${p.selected === t.id ? "*" : ""}${tabPath(t)}${t.pinned ? "^" : ""}`,
          )
          .join(",")}`,
    )
    .join(" | ");
}

test("a double-click on a tab pins it, and on a pinned tab unpins it (P13, P14)", () => {
  render(<Panes />);
  fireEvent.doubleClick(screen.getByTestId("tab-t2"));
  expect(shape()).toBe(
    "p1:/catalog^,*/preferences^ | p2:*/cluster/c1/map,/cluster/c1",
  );
  expect(screen.queryByTestId("tab-close-t2")).toBeNull();
  fireEvent.doubleClick(screen.getByTestId("tab-t1"));
  expect(shape()).toBe(
    "p1:/preferences^,*/catalog | p2:*/cluster/c1/map,/cluster/c1",
  );
});

test("a middle-click closes a tab, but not a pinned one (P14)", () => {
  render(<Panes />);
  const press = fireEvent.mouseDown(screen.getByTestId("tab-t4"), {
    button: 1,
  });
  expect(press).toBe(false);
  fireEvent(
    screen.getByTestId("tab-t4"),
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  expect(shape()).toBe("p1:*/catalog^,/preferences | p2:*/cluster/c1/map");
  fireEvent(
    screen.getByTestId("tab-t1"),
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  expect(shape()).toBe("p1:*/catalog^,/preferences | p2:*/cluster/c1/map");
});

test("the tab menu shows why an item does not apply, and runs the others (P15)", async () => {
  render(<Panes />);
  fireEvent.contextMenu(screen.getByTestId("tab-t2"));
  const menu = await screen.findByRole("menu", {
    name: "Actions for Preferences",
  });
  expect(
    [...menu.querySelectorAll('[role="menuitem"]')].map((i) => [
      i.getAttribute("data-testid"),
      i.textContent,
      i.hasAttribute("data-disabled"),
      i.getAttribute("title"),
    ]),
  ).toEqual([
    ["tab-menu-pin", "Pin tabDouble-click", false, null],
    [
      "tab-menu-left",
      "Move to the left paneNo pane on the left",
      true,
      "No pane on the left",
    ],
    ["tab-menu-right", "Move to the right pane", false, null],
    ["tab-menu-new-pane", "Move to a new pane on the right", false, null],
    ["tab-menu-window", "Move to window", false, null],
    ["tab-menu-close", "CloseCtrl+W", false, null],
    // The other tab of its pane is pinned.
    [
      "tab-menu-close-others",
      "Close other tabsNo other tabs to close",
      true,
      "No other tabs to close",
    ],
  ]);
  fireEvent.click(screen.getByTestId("tab-menu-right"));
  expect(shape()).toBe(
    "p1:*/catalog^ | p2:/cluster/c1/map,/cluster/c1,*/preferences",
  );
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("Move to window lists the other windows and moves the tab through the core (P15, P31)", async () => {
  const other: WindowLayout = {
    label: "window-2",
    bounds: null,
    panes: [
      {
        id: "q1",
        width: 1,
        selected: "t9",
        tabs: [tab("t9", "/cluster/c1/map")],
      },
    ],
    focusedPane: 0,
  };
  const backend = mockBackend({
    windows_list: () => [twoPanes(), other],
    window_tab_move: () => ({
      target: "window-2",
      created: false,
      sourceEmpty: false,
    }),
  });
  const before = layout();
  render(<Panes />);
  fireEvent.contextMenu(screen.getByTestId("tab-t2"));
  const trigger = await screen.findByTestId("tab-menu-window");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  const target = await screen.findByTestId("tab-menu-window-window-2");
  expect(target.textContent).toBe("Window 2Resource map · prod");
  // This window is not offered.
  expect(screen.queryByTestId("tab-menu-window-main")).toBeNull();
  expect(screen.getByTestId("tab-menu-window-new").textContent).toBe(
    "New window",
  );
  fireEvent.click(target);
  await waitFor(() =>
    expect(backend.callsTo("window_tab_move")).toEqual([
      { tabId: "t2", target: { kind: "window", label: "window-2" } },
    ]),
  );
  // The core's layout event takes the tab out; the menu changes nothing itself.
  expect(layout()).toBe(before);
});

test("New window in the tab menu opens the tab in a new window beside this one (P15)", async () => {
  const backend = mockBackend({
    windows_list: () => [twoPanes()],
    window_tab_move: () => ({
      target: "window-2",
      created: true,
      sourceEmpty: false,
    }),
  });
  render(<Panes />);
  fireEvent.contextMenu(screen.getByTestId("tab-t3"));
  fireEvent.keyDown(await screen.findByTestId("tab-menu-window"), {
    key: "ArrowRight",
  });
  fireEvent.click(await screen.findByTestId("tab-menu-window-new"));
  // Bounds not known yet: a step from the window's screen position.
  const step = Math.round(32 * window.devicePixelRatio);
  await waitFor(() =>
    expect(backend.callsTo("window_tab_move")).toEqual([
      {
        tabId: "t3",
        target: {
          kind: "newWindow",
          x: Math.round(window.screenX * window.devicePixelRatio) + step,
          y: Math.round(window.screenY * window.devicePixelRatio) + step,
        },
      },
    ]),
  );
});

test("a pinned tab's menu cannot close it, and Close other tabs keeps it (P14)", async () => {
  render(<Panes />);
  fireEvent.contextMenu(screen.getByTestId("tab-t1"));
  const close = await screen.findByTestId("tab-menu-close");
  expect(close.hasAttribute("data-disabled")).toBe(true);
  expect(close.getAttribute("title")).toBe("Pinned tabs cannot be closed");
  fireEvent.click(screen.getByTestId("tab-menu-close-others"));
  expect(shape()).toBe("p1:*/catalog^ | p2:*/cluster/c1/map,/cluster/c1");
});

test("Shift+F10 and the context-menu key open the menu of the focused tab (P15)", async () => {
  render(<Panes />);
  const button = screen.getByTestId("tab-t3");
  button.focus();
  fireEvent.keyDown(button, { key: "F10", shiftKey: true });
  expect(
    await screen.findByRole("menu", {
      name: "Actions for Resource map · prod",
    }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.keyDown(screen.getByTestId("tab-t4"), { key: "ContextMenu" });
  expect(
    await screen.findByRole("menu", { name: "Actions for Overview · prod" }),
  ).toBeTruthy();
});

test("Left, Right, Home and End move the focus along the strip, wrapping; Enter selects", () => {
  resetWindowLayoutForTest({
    ...twoPanes(),
    panes: [
      {
        ...twoPanes().panes[0],
        tabs: [...twoPanes().panes[0].tabs, tab("t5", "/cluster/c1/nodes")],
      },
      twoPanes().panes[1],
    ],
  });
  render(<Panes />);
  const focused = () => document.activeElement?.id;
  screen.getByTestId("tab-t1").focus();
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
  expect(focused()).toBe(tabElementId("t2"));
  fireEvent.keyDown(document.activeElement as Element, { key: "End" });
  expect(focused()).toBe(tabElementId("t5"));
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
  expect(focused()).toBe(tabElementId("t1"));
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
  expect(focused()).toBe(tabElementId("t5"));
  fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
  expect(focused()).toBe(tabElementId("t1"));
  // Moving the focus does not select: the screen of the tab stays mounted.
  expect(layout().panes[0].selected).toBe("t1");
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
  fireEvent.click(document.activeElement as Element);
  expect(layout().panes[0].selected).toBe("t2");
  // Alt+Left is Back, not a move along the strip.
  const back = fireEvent.keyDown(document.activeElement as Element, {
    key: "ArrowLeft",
    altKey: true,
  });
  expect(back).toBe(true);
  expect(focused()).toBe(tabElementId("t2"));
});
