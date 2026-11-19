import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import type { ClusterInfo } from "../ipc/generated/ClusterInfo";
import { resetCatalogForTest, useCatalog } from "../stores/catalog";
import { resetDiscoveryForTest } from "../stores/discovery";
import { resetWindowLayoutForTest } from "../stores/windowLayout";
import { CSS_FILES, type CssRule, cssRules } from "../test/css";
import { clusterEntry, flush, mockBackend } from "../test/ipc";
import { SidebarColumn } from "./SidebarColumn";
import { ShellRouter } from "./tabs/ShellRouter";

const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: ["default"],
  namespacesRestricted: false,
  isAdmin: true,
};
const PROD = clusterEntry({
  id: "c1",
  contextName: "prod",
  state: { status: "connected", info: INFO },
});
const STAGING = clusterEntry({ id: "c2", contextName: "staging" });
const PODS: ApiResourceInfo = {
  resource: {
    group: "",
    version: "v1",
    plural: "pods",
    kind: "Pod",
    namespaced: true,
  },
  verbs: ["list", "watch"],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
};

function decl(rules: CssRule[], selector: string, prop: string) {
  return rules
    .find((r) => r.selector === selector)
    ?.decls.find(([p]) => p === prop)?.[1];
}

/** The column in a window whose only tab shows `path`, with `saved` as the UI state. */
async function show(
  path: string,
  saved: Record<string, unknown> = {},
  clusters: ClusterEntry[] = [PROD, STAGING],
) {
  const backend = mockBackend({
    catalog_list: () => clusters,
    catalog_warnings: () => [],
    hotbar_get: () => [],
    resources_discover: () => [PODS],
    cluster_connect: () => ({ status: "connecting" }),
    ui_state_get: (a: { key: string }) => saved[a.key] ?? null,
    ui_state_set: () => null,
  });
  await useCatalog.getState().init();
  resetWindowLayoutForTest({
    label: "main",
    bounds: null,
    panes: [
      {
        id: "p1",
        width: 1,
        selected: "t1",
        tabs: [{ id: "t1", pinned: false, history: [path], index: 0 }],
      },
    ],
    focusedPane: 0,
  });
  render(
    <ShellRouter>
      <SidebarColumn />
    </ShellRouter>,
  );
  await act(flush);
  return backend;
}

beforeEach(() => {
  resetCatalogForTest();
  resetWindowLayoutForTest();
  resetDiscoveryForTest();
});

test("the column draws one glass layer and the only border; the switcher and the nav draw none (spec Q §1)", () => {
  const column = cssRules(CSS_FILES["/src/app/SidebarColumn.module.css"]);
  expect(decl(column, ".column", "background")).toBe("var(--glass-tint)");
  expect(decl(column, ".column", "border-right")).toBe(
    "1px solid var(--border-subtle)",
  );
  const switcher = cssRules(CSS_FILES["/src/app/ClusterSwitcher.module.css"]);
  const sidebar = cssRules(
    CSS_FILES["/src/features/cluster/Sidebar.module.css"],
  );
  for (const [rules, selector] of [
    [switcher, ".switcher"],
    [sidebar, ".sidebar"],
  ] as const) {
    expect([selector, decl(rules, selector, "background")]).toEqual([
      selector,
      undefined,
    ]);
    expect([selector, decl(rules, selector, "border-right")]).toEqual([
      selector,
      undefined,
    ]);
  }
  expect(decl(column, ".note", "border")).toBe(
    "1px dashed var(--border-default)",
  );
  expect(decl(column, ".note", "border-radius")).toBe("var(--radius-md)");
  expect(decl(column, ".note", "padding")).toBe("var(--space-7)");
  const hotbar = cssRules(CSS_FILES["/src/app/Hotbar.module.css"]);
  expect(decl(hotbar, ".rail", "background")).toBe("var(--glass-tint)");
  expect(decl(hotbar, ".status", "background")).toBe("var(--surface-card)");
});

test("the navigation starts at 248 px, steps by 16 and resets to 248 on a double-click", async () => {
  await show("/cluster/c1/r/core/pods");
  const handle = screen.getByTestId("nav-resize");
  expect(screen.getByTestId("sidebar-column").style.width).toBe("248px");
  expect(handle.getAttribute("aria-valuemin")).toBe("200");
  expect(handle.getAttribute("aria-valuemax")).toBe("360");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle.getAttribute("aria-valuenow")).toBe("264");
  fireEvent.doubleClick(handle);
  expect(handle.getAttribute("aria-valuenow")).toBe("248");
});

test("a width saved under the old bounds clamps to 200, and still resizes", async () => {
  await show("/cluster/c1/r/core/pods", { "layout.navWidth": 180 });
  const handle = screen.getByTestId("nav-resize");
  expect(handle.getAttribute("aria-valuenow")).toBe("200");
  expect(screen.getByTestId("sidebar-column").style.width).toBe("200px");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle.getAttribute("aria-valuenow")).toBe("216");
});

test("a cluster that is not connected shows the dashed waiting box, whose Connect connects it", async () => {
  const backend = await show("/cluster/c2");
  const waiting = screen.getByTestId("sidebar-waiting");
  expect(waiting.classList.contains("note")).toBe(true);
  expect(waiting.textContent).toContain("staging");
  expect(waiting.textContent).toContain("Disconnected.");
  fireEvent.click(screen.getByTestId("sidebar-connect"));
  await act(flush);
  expect(backend.callsTo("cluster_connect")).toEqual([{ id: "c2" }]);
});

test("a tab without a cluster shows the empty note in the same box", async () => {
  await show("/catalog");
  const empty = screen.getByTestId("sidebar-empty");
  expect(empty.classList.contains("note")).toBe(true);
  expect(empty.textContent).toBe(
    "Pick a cluster above, or open one, to see its navigation here.",
  );
});
