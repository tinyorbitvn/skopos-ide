import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, test } from "vitest";
import { DEPLOYMENTS } from "../../kinds/refs";
import { detailsTab, resetDockForTest, useDock } from "../../stores/dock";
import { drawerPath, useOpenAsDrawer } from "./openAsDrawer";

const WEB = detailsTab("c1", DEPLOYMENTS, "shop", "web", "events");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/cluster/c1/overview"]}>
      {children}
    </MemoryRouter>
  );
}

afterEach(() => {
  resetDockForTest();
});

test("drawerPath names the entry's list and its object as ResourceScreen keys it", () => {
  expect(
    drawerPath("c1", {
      target: {
        group: "apps",
        plural: "deployments",
        namespace: "shop",
        name: "web",
      },
      tab: "events",
    }),
  ).toBe("/cluster/c1/r/apps/deployments?object=shop%2Fweb");
  expect(
    drawerPath("kind dev", {
      target: { group: "", plural: "nodes", namespace: null, name: "n1" },
      tab: "overview",
    }),
  ).toBe("/cluster/kind%20dev/r/core/nodes?object=%2Fn1");
});

test("Open as drawer goes to the entry's list with its drawer tab and closes the details tab", () => {
  useDock.getState().open(WEB);
  const { result } = renderHook(
    () => ({ openAsDrawer: useOpenAsDrawer(), location: useLocation() }),
    { wrapper },
  );
  act(() =>
    result.current.openAsDrawer(WEB, {
      target: { group: "", plural: "pods", namespace: "shop", name: "web-1" },
      tab: "map",
    }),
  );
  expect(result.current.location.pathname).toBe("/cluster/c1/r/core/pods");
  expect(result.current.location.search).toBe("?object=shop%2Fweb-1");
  expect(result.current.location.state).toEqual({ drawerTab: "map" });
  expect(useDock.getState().tabs).toEqual([]);
});
