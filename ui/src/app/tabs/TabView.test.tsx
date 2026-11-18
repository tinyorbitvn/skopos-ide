import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Link, type RouteObject, useLocation, useNavigate } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { findTab } from "./layout";
import { openPath } from "./navigation";
import { goInTab, TabView, tabRouters, useTabContext } from "./TabView";

function Page({ name }: { name: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = useTabContext();
  return (
    <div>
      <output data-testid="where">{`${name} ${location.pathname}${location.search}`}</output>
      <output data-testid="state">
        {JSON.stringify(location.state ?? null)}
      </output>
      <output data-testid="tab">{tab?.tabId}</output>
      <Link to="/b">to b</Link>
      <Link to="/a?q=1">a with a query</Link>
      <button type="button" onClick={() => navigate(-1)}>
        back
      </button>
    </div>
  );
}

const ROUTES: RouteObject[] = [
  { path: "a", element: <Page name="a" /> },
  { path: "b", element: <Page name="b" /> },
  { path: "c", element: <Page name="c" /> },
];

function layoutOf(tabs: TabState[]): WindowLayout {
  return {
    label: "main",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: tabs[0].id, tabs }],
    focusedPane: 0,
  };
}

function tabIn(id: string): TabState {
  const found = findTab(useWindowLayout.getState().layout, id);
  if (!found) throw new Error(`no tab ${id}`);
  return found.tab;
}

/** The focused pane's selected tab, as a pane renders it. */
function Selected() {
  const tab = useWindowLayout((s) => {
    const pane = s.layout.panes[s.layout.focusedPane];
    return pane.tabs.find((t) => t.id === pane.selected);
  });
  return tab ? <TabView key={tab.id} tab={tab} routes={ROUTES} /> : null;
}

function where(): string {
  return screen.getByTestId("where").textContent ?? "";
}

beforeEach(() => {
  resetWindowLayoutForTest(
    layoutOf([{ id: "t1", pinned: false, history: ["/a", "/b"], index: 0 }]),
  );
});

test("renders the tab's shown location and gives screens the tab", () => {
  render(<Selected />);
  expect(where()).toBe("a /a");
  expect(screen.getByTestId("tab").textContent).toBe("t1");
});

test("a link inside the screen pushes onto the tab's history in the layout", async () => {
  resetWindowLayoutForTest(
    layoutOf([{ id: "t1", pinned: false, history: ["/a"], index: 0 }]),
  );
  render(<Selected />);
  fireEvent.click(screen.getByText("to b"));
  await waitFor(() => expect(where()).toBe("b /b"));
  expect(tabIn("t1")).toMatchObject({ history: ["/a", "/b"], index: 1 });
});

test("going back inside the screen moves the tab's position", async () => {
  resetWindowLayoutForTest(
    layoutOf([{ id: "t1", pinned: false, history: ["/a", "/b"], index: 1 }]),
  );
  render(<Selected />);
  fireEvent.click(screen.getByText("back"));
  await waitFor(() => expect(where()).toBe("a /a"));
  expect(tabIn("t1")).toMatchObject({ history: ["/a", "/b"], index: 0 });
});

test("a navigation item moves the tab's router", async () => {
  render(<Selected />);
  act(() => {
    openPath("/c", "current");
  });
  await waitFor(() => expect(where()).toBe("c /c"));
  expect(tabIn("t1")).toMatchObject({ history: ["/a", "/c"], index: 1 });
});

test("location state given to openPath reaches the screen", async () => {
  render(<Selected />);
  act(() => {
    openPath("/b", "current", { state: { drawerTab: "yaml" } });
  });
  await waitFor(() => expect(where()).toBe("b /b"));
  expect(screen.getByTestId("state").textContent).toBe('{"drawerTab":"yaml"}');
});

test("back and forward go through the mounted tab's router", async () => {
  render(<Selected />);
  expect(tabRouters.has("t1")).toBe(true);
  act(() => goInTab("t1", 1));
  await waitFor(() => expect(where()).toBe("b /b"));
  expect(tabIn("t1").index).toBe(1);
  act(() => goInTab("t1", -1));
  await waitFor(() => expect(where()).toBe("a /a"));
  expect(tabIn("t1").index).toBe(0);
});

test("a tab that is not mounted goes back through the layout", () => {
  resetWindowLayoutForTest(
    layoutOf([{ id: "t1", pinned: false, history: ["/a", "/b"], index: 1 }]),
  );
  goInTab("t1", -1);
  expect(tabIn("t1").index).toBe(0);
});

test("the registry drops a tab's router when it unmounts", () => {
  const view = render(<Selected />);
  expect(tabRouters.has("t1")).toBe(true);
  view.unmount();
  expect(tabRouters.has("t1")).toBe(false);
});

test("a layout from elsewhere replaces the tab's router", async () => {
  render(<Selected />);
  act(() => {
    useWindowLayout.setState({
      layout: layoutOf([
        { id: "t1", pinned: false, history: ["/c", "/b"], index: 0 },
      ]),
    });
  });
  await waitFor(() => expect(where()).toBe("c /c"));
  act(() => goInTab("t1", 1));
  await waitFor(() => expect(where()).toBe("b /b"));
});

test("a pinned tab keeps its pathname: a link elsewhere opens a new tab after the pinned ones", async () => {
  resetWindowLayoutForTest(
    layoutOf([
      { id: "t1", pinned: true, history: ["/a"], index: 0 },
      { id: "t2", pinned: false, history: ["/c"], index: 0 },
    ]),
  );
  render(<Selected />);
  fireEvent.click(screen.getByText("to b"));
  await waitFor(() => expect(where()).toBe("b /b"));
  const pane = useWindowLayout.getState().layout.panes[0];
  expect(pane.tabs.map((t) => t.id)[0]).toBe("t1");
  expect(pane.tabs).toHaveLength(3);
  expect(pane.tabs[1]).toMatchObject({ pinned: false, history: ["/b"] });
  expect(pane.selected).toBe(pane.tabs[1].id);
  expect(tabIn("t1").history).toEqual(["/a"]);
});

test("in a pinned tab, a change of the query stays in the tab", async () => {
  resetWindowLayoutForTest(
    layoutOf([{ id: "t1", pinned: true, history: ["/a"], index: 0 }]),
  );
  render(<Selected />);
  fireEvent.click(screen.getByText("a with a query"));
  await waitFor(() => expect(where()).toBe("a /a?q=1"));
  expect(tabIn("t1")).toMatchObject({ history: ["/a", "/a?q=1"], index: 1 });
  expect(useWindowLayout.getState().layout.panes[0].tabs).toHaveLength(1);
});
