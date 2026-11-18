import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import type { TabState } from "../../ipc/generated/TabState";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { focusedTab } from "./layout";
import { peekPendingState } from "./navigation";
import { ShellRouter } from "./ShellRouter";
import { type TabRouter, tabRouters } from "./TabView";

function tab(
  id: string,
  history: string[],
  index = history.length - 1,
): TabState {
  return { id, pinned: false, history, index };
}

beforeEach(() => {
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [
      {
        id: "p1",
        width: 0.5,
        selected: "t1",
        tabs: [tab("t1", ["/catalog", "/preferences"], 0)],
      },
      {
        id: "p2",
        width: 0.5,
        selected: "t2",
        tabs: [tab("t2", ["/cluster/c1/map?kind=Pod"])],
      },
    ],
    focusedPane: 1,
  });
});

let navigate: ReturnType<typeof useNavigate> = () => {};

function Probe() {
  const location = useLocation();
  const cluster = useMatch("/cluster/:id/*")?.params.id ?? "none";
  navigate = useNavigate();
  return (
    <>
      <p data-testid="where">{`${location.pathname}${location.search}|${cluster}`}</p>
      <Link to="/preferences" data-testid="link">
        Preferences
      </Link>
    </>
  );
}

function focused(): TabState | null {
  return focusedTab(useWindowLayout.getState().layout);
}

test("its location is the focused tab's, and follows the focus", () => {
  render(
    <ShellRouter>
      <Probe />
    </ShellRouter>,
  );
  expect(screen.getByTestId("where").textContent).toBe(
    "/cluster/c1/map?kind=Pod|c1",
  );
  act(() =>
    useWindowLayout.getState().dispatch({ type: "focusPane", paneId: "p1" }),
  );
  expect(screen.getByTestId("where").textContent).toBe("/catalog|none");
});

test("an empty window gives the root location", () => {
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [{ id: "p1", width: 1, selected: "", tabs: [] }],
    focusedPane: 0,
  });
  render(
    <ShellRouter>
      <Probe />
    </ShellRouter>,
  );
  expect(screen.getByTestId("where").textContent).toBe("/|none");
});

test("links are hash links, and a click navigates the focused tab (P11)", () => {
  render(
    <ShellRouter>
      <Probe />
    </ShellRouter>,
  );
  const link = screen.getByTestId("link");
  expect(link.getAttribute("href")).toBe("#/preferences");
  fireEvent.click(link);
  expect(focused()?.id).toBe("t2");
  expect(focused()?.history).toEqual([
    "/cluster/c1/map?kind=Pod",
    "/preferences",
  ]);
});

test("navigate with state leaves the state for the tab's router", () => {
  render(
    <ShellRouter>
      <Probe />
    </ShellRouter>,
  );
  act(
    () =>
      void navigate("/cluster/c1/r/apps/deployments", { state: { drawer: 1 } }),
  );
  expect(peekPendingState("t2", "/cluster/c1/r/apps/deployments")).toEqual({
    drawer: 1,
  });
});

test("back and forward move the focused tab through its own history (P3)", () => {
  act(() =>
    useWindowLayout.getState().dispatch({ type: "focusPane", paneId: "p1" }),
  );
  render(
    <ShellRouter>
      <Probe />
    </ShellRouter>,
  );
  act(() => void navigate(1));
  expect(focused()?.index).toBe(1);
  expect(screen.getByTestId("where").textContent).toBe("/preferences|none");
  act(() => void navigate(-1));
  expect(focused()?.index).toBe(0);
  // At the start of its history nothing moves.
  act(() => void navigate(-1));
  expect(focused()?.index).toBe(0);
});

test("new state for the location the tab shows goes to its router, in place", () => {
  const navigateTab = vi.fn(async () => {});
  tabRouters.set("t2", { navigate: navigateTab } as unknown as TabRouter);
  try {
    render(
      <ShellRouter>
        <Probe />
      </ShellRouter>,
    );
    const before = useWindowLayout.getState().layout;
    act(
      () => void navigate("/cluster/c1/map?kind=Pod", { state: { tab: "x" } }),
    );
    expect(navigateTab).toHaveBeenCalledWith("/cluster/c1/map?kind=Pod", {
      state: { tab: "x" },
      replace: true,
    });
    expect(useWindowLayout.getState().layout).toBe(before);
  } finally {
    tabRouters.delete("t2");
  }
});
