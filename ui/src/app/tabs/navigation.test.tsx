import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { tabPath } from "./layout";
import {
  catchSecondClick,
  clickMode,
  DOUBLE_CLICK_MS,
  linkPath,
  navItemHandlers,
  openPath,
  peekPendingState,
  screenLinkHandlers,
} from "./navigation";

function layoutOf(panes: TabState[][], focused = 0): WindowLayout {
  return {
    label: "main",
    bounds: null,
    panes: panes.map((tabs, i) => ({
      id: `p${i + 1}`,
      width: 1 / panes.length,
      selected: tabs[0]?.id ?? "",
      tabs,
    })),
    focusedPane: focused,
  };
}

function tab(id: string, path: string, pinned = false): TabState {
  return { id, pinned, history: [path], index: 0 };
}

// Per pane: `p1:*/catalog,/x^`, each tab's shown path, `*` selected, `^` pinned.
function shape(): string {
  const { layout } = useWindowLayout.getState();
  return layout.panes
    .map(
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

beforeEach(() => resetWindowLayoutForTest(layoutOf([[tab("t1", "/catalog")]])));

function NavItem({ path, mac = false }: { path: string; mac?: boolean }) {
  return (
    <a href={`#${path}`} {...navItemHandlers(path, mac)}>
      item
    </a>
  );
}

test("the click modes: left in the focused tab, Ctrl or Cmd in a new tab, middle beside", () => {
  const plain = { button: 0, ctrlKey: false, metaKey: false };
  expect(clickMode(plain, false)).toBe("current");
  expect(clickMode({ ...plain, ctrlKey: true }, false)).toBe("newTab");
  expect(clickMode({ ...plain, metaKey: true }, false)).toBe("current");
  expect(clickMode({ ...plain, metaKey: true }, true)).toBe("newTab");
  expect(clickMode({ ...plain, ctrlKey: true }, true)).toBe("current");
  expect(clickMode({ ...plain, button: 1 }, false)).toBe("beside");
  expect(clickMode({ ...plain, button: 2 }, false)).toBeNull();
});

test("a plain click on a navigation item navigates the focused tab (P11)", () => {
  render(<NavItem path="/preferences" />);
  const click = fireEvent.click(screen.getByText("item"));
  expect(click).toBe(false);
  expect(shape()).toBe("p1:*/preferences");
  expect(useWindowLayout.getState().layout.panes[0].tabs[0].history).toEqual([
    "/catalog",
    "/preferences",
  ]);
});

test("Ctrl+click opens a new tab at the end of the focused pane (P12)", () => {
  render(<NavItem path="/preferences" />);
  fireEvent.click(screen.getByText("item"), { ctrlKey: true });
  expect(shape()).toBe("p1:/catalog,*/preferences");
});

test("Cmd+click does on macOS what Ctrl+click does elsewhere", () => {
  render(<NavItem path="/preferences" mac />);
  fireEvent.click(screen.getByText("item"), { metaKey: true });
  expect(shape()).toBe("p1:/catalog,*/preferences");
});

test("middle-click opens beside, and a middle press does not autoscroll (P12)", () => {
  render(<NavItem path="/preferences" />);
  expect(fireEvent.mouseDown(screen.getByText("item"), { button: 1 })).toBe(
    false,
  );
  fireEvent(
    screen.getByText("item"),
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  expect(shape().replace(/\| [^:]+:/, "| new:")).toBe(
    "p1:*/catalog | new:*/preferences",
  );
  expect(useWindowLayout.getState().layout.focusedPane).toBe(1);
});

test("a double-click navigates the focused tab and pins it (P13)", () => {
  render(<NavItem path="/preferences" />);
  const item = screen.getByText("item");
  fireEvent.click(item, { detail: 1 });
  fireEvent.click(item, { detail: 2 });
  fireEvent.doubleClick(item);
  expect(shape()).toBe("p1:*/preferences^");
});

test("a double-click with a pinned tab focused pins the new tab after it", () => {
  resetWindowLayoutForTest(layoutOf([[tab("t1", "/catalog", true)]]));
  render(<NavItem path="/preferences" />);
  const item = screen.getByText("item");
  fireEvent.click(item);
  fireEvent.click(item);
  fireEvent.doubleClick(item);
  expect(shape()).toBe("p1:/catalog^,*/preferences^");
});

test("openPath leaves location state for the tab that gets the location", () => {
  const id = openPath("/x", "newTab", { state: { drawerTab: "events" } });
  expect(id).not.toBeNull();
  expect(peekPendingState(id as string, "/x")).toEqual({ drawerTab: "events" });
  expect(peekPendingState(id as string, "/y")).toBeUndefined();
});

test("linkPath reads a router link's path, plain or after a hash", () => {
  render(
    <div>
      <a href="/cluster/a?x=1">
        <span>plain</span>
      </a>
      <a href="#/catalog">hash</a>
      <a href="https://example.invalid/">outside</a>
      <span>none</span>
    </div>,
  );
  expect(linkPath(screen.getByText("plain"))).toBe("/cluster/a?x=1");
  expect(linkPath(screen.getByText("hash"))).toBe("/catalog");
  expect(linkPath(screen.getByText("outside"))).toBeNull();
  expect(linkPath(screen.getByText("none"))).toBeNull();
});

/** A pane body with a link that, like a router link, handles a plain click itself. */
function Screen({ tabId }: { tabId: string }) {
  return (
    <div {...screenLinkHandlers(tabId, false)}>
      <a href="/cluster/a" onClick={(e) => e.preventDefault()}>
        Cluster a
      </a>
    </div>
  );
}

test("in a screen, Ctrl+click on a link opens a new tab in the link's pane", () => {
  resetWindowLayoutForTest(
    layoutOf([[tab("t1", "/catalog")], [tab("t2", "/preferences")]], 1),
  );
  render(<Screen tabId="t1" />);
  const ctrl = fireEvent.click(screen.getByText("Cluster a"), {
    ctrlKey: true,
  });
  expect(ctrl).toBe(false);
  expect(shape()).toBe("p1:/catalog,*/cluster/a | p2:*/preferences");
  expect(useWindowLayout.getState().layout.focusedPane).toBe(0);
});

test("in a screen, middle-click on a link opens it beside its pane", () => {
  resetWindowLayoutForTest(
    layoutOf([[tab("t1", "/catalog")], [tab("t2", "/preferences")]], 1),
  );
  render(<Screen tabId="t1" />);
  fireEvent(
    screen.getByText("Cluster a"),
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  expect(shape()).toBe("p1:*/catalog | p2:/preferences,*/cluster/a");
});

test("in a screen, a plain click is left to the tab's router", () => {
  render(<Screen tabId="t1" />);
  fireEvent.click(screen.getByText("Cluster a"));
  expect(shape()).toBe("p1:*/catalog");
});

test("in a screen, Shift+click stays in the tab instead of leaving the app", () => {
  render(<Screen tabId="t1" />);
  const shifted = fireEvent.click(screen.getByText("Cluster a"), {
    shiftKey: true,
  });
  expect(shifted).toBe(false);
  expect(shape()).toBe("p1:*/cluster/a");
});

describe("the second click of a double-click on a palette row (P13)", () => {
  afterEach(() => vi.useRealTimers());

  /** Fires the second click's events at `x`, `y` on the body; how many got through. */
  function secondClick(x: number, y: number): number {
    let through = 0;
    const count = () => {
      through += 1;
    };
    const types = ["pointerdown", "mousedown", "mouseup", "click", "dblclick"];
    for (const type of types) document.body.addEventListener(type, count);
    for (const type of types) {
      document.body.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          detail: 2,
        }),
      );
    }
    for (const type of types) document.body.removeEventListener(type, count);
    return through;
  }

  test("is caught where the first one was, reaches nothing below, and pins the tab", () => {
    catchSecondClick("t1", 100, 40);
    expect(secondClick(102, 41)).toBe(0);
    expect(shape()).toBe("p1:*/catalog^");
    // Caught once only.
    expect(secondClick(102, 41)).toBe(5);
  });

  test("a press elsewhere ends the wait and goes through", () => {
    catchSecondClick("t1", 100, 40);
    expect(secondClick(300, 40)).toBe(5);
    expect(secondClick(100, 40)).toBe(5);
    expect(shape()).toBe("p1:*/catalog");
  });

  test("a new click at the same place goes through", () => {
    catchSecondClick("t1", 100, 40);
    let clicked = 0;
    const count = () => {
      clicked += 1;
    };
    document.body.addEventListener("click", count);
    fireEvent.click(document.body, { clientX: 100, clientY: 40, detail: 1 });
    document.body.removeEventListener("click", count);
    expect(clicked).toBe(1);
    expect(secondClick(100, 40)).toBe(5);
    expect(shape()).toBe("p1:*/catalog");
  });

  test("after the double-click time nothing is caught", () => {
    vi.useFakeTimers();
    catchSecondClick("t1", 100, 40);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(secondClick(100, 40)).toBe(5);
    expect(shape()).toBe("p1:*/catalog");
  });
});
