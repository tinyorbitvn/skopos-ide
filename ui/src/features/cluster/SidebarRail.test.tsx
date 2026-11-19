import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { tabPath } from "../../app/tabs/layout";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  resetWindowLayoutForTest,
  useWindowLayout,
} from "../../stores/windowLayout";
import { CSS_FILES, cssRules } from "../../test/css";
import { flush, mockBackend } from "../../test/ipc";
import { SECTION_ICONS } from "../palette/icons";
import { SidebarRail } from "./SidebarRail";

function info(group: string, plural: string, kind = plural): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

const WIDE = [
  info("", "pods", "Pod"),
  info("apps", "deployments", "Deployment"),
  info("apiextensions.k8s.io", "customresourcedefinitions"),
  info("acme.io", "gadgets", "Gadget"),
  info("", "nodes", "Node"),
  info("", "namespaces", "Namespace"),
  info("", "events", "Event"),
  info("argoproj.io", "applications", "Application"),
  info("argoproj.io", "appprojects", "AppProject"),
];

const TREE = [
  ...WIDE,
  info("pkg.crossplane.io", "providers", "Provider"),
  info("acl.kafka.m.crossplane.io", "topics", "Topic"),
  info("crossplane.io", "compositions", "Composition"),
];

async function show(
  props: Partial<Parameters<typeof SidebarRail>[0]> = {},
  path = "/cluster/c1",
) {
  mockBackend({ ui_state_get: () => null, ui_state_set: () => null });
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarRail
        clusterId="c1"
        resources={WIDE}
        loading={false}
        error={null}
        onRetry={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
  await act(flush);
}

/** The location of every tab of the window, pane by pane. */
function paths(): string[] {
  return useWindowLayout
    .getState()
    .layout.panes.flatMap((p) => p.tabs.map(tabPath));
}

const icon = (id: string) => screen.getByTestId(`rail-${id}`);
const flyout = (id: string) => screen.queryByTestId(`rail-flyout-${id}`);

beforeEach(() => {
  resetWindowLayoutForTest();
});

test("the rail shows one icon per section between group dividers, with the section icons and logos (spec Q §3)", async () => {
  await show();
  const rail = screen.getByTestId("cluster-rail");
  expect(
    [...rail.querySelectorAll("[data-rail-icon], hr")].map((el) =>
      el.getAttribute("data-testid"),
    ),
  ).toEqual([
    "rail-overview",
    "rail-map",
    "rail-divider-apps",
    "rail-helm",
    "rail-argo",
    "rail-divider-cluster",
    "rail-nodes",
    "rail-namespaces",
    "rail-events",
    "rail-divider-resources",
    "rail-workloads",
    "rail-network",
    "rail-custom",
  ]);
  expect(
    icon("helm").querySelector("[data-logo]")?.getAttribute("data-logo"),
  ).toBe("helm");
  expect(
    icon("workloads").querySelector("[data-icon]")?.getAttribute("data-icon"),
  ).toBe(SECTION_ICONS.workloads?.iconName);
  expect([
    icon("nodes").tagName,
    icon("nodes").getAttribute("href"),
    icon("nodes").getAttribute("aria-label"),
  ]).toEqual(["A", "/cluster/c1/r/core/nodes", "Nodes"]);
  expect([
    icon("workloads").tagName,
    icon("workloads").getAttribute("aria-label"),
    icon("workloads").getAttribute("aria-haspopup"),
    icon("workloads").getAttribute("aria-expanded"),
  ]).toEqual(["BUTTON", "Workloads", "menu", "false"]);
  const rules = cssRules(
    CSS_FILES["/src/features/cluster/SidebarRail.module.css"],
  );
  const decl = (selector: string, prop: string) =>
    rules
      .find((r) => r.selector === selector)
      ?.decls.find(([p]) => p === prop)?.[1];
  expect([
    decl(".railIcon", "width"),
    decl(".railIcon", "height"),
    decl(".divider", "width"),
    decl(".divider", "height"),
    decl(".divider", "background"),
    decl('.railIcon[aria-current="page"]', "background"),
    decl(".flyout", "width"),
    decl(".flyout", "left"),
    decl(".flyout", "max-height"),
    decl(".flyout", "overflow-y"),
    decl(".flyoutTitle", "font"),
    decl(".flyoutItem", "height"),
    decl(".flyoutItem", "border-radius"),
  ]).toEqual([
    "40px",
    "36px",
    "28px",
    "1px",
    "var(--tree-line)",
    "var(--side-selected)",
    "236px",
    "calc(100% + 6px)",
    "calc(100% - 16px)",
    "auto",
    "var(--type-overline)",
    "30px",
    "var(--radius-full)",
  ]);
});

test("the section holding the current page is the current icon", async () => {
  await show({}, "/cluster/c1/r/apps/deployments");
  expect(icon("workloads").getAttribute("aria-current")).toBe("page");
  expect(icon("network").getAttribute("aria-current")).toBeNull();
  expect(icon("overview").getAttribute("aria-current")).toBeNull();
  cleanup();
  await show({}, "/cluster/c1/r/core/nodes");
  expect(icon("nodes").getAttribute("aria-current")).toBe("page");
  expect(icon("workloads").getAttribute("aria-current")).toBeNull();
});

test("a single-screen icon navigates with the sidebar's link handlers", async () => {
  await show();
  fireEvent.click(icon("nodes"));
  expect(paths()).toEqual(["/cluster/c1/r/core/nodes"]);
  fireEvent.click(icon("namespaces"), { ctrlKey: true });
  expect(paths()).toEqual([
    "/cluster/c1/r/core/nodes",
    "/cluster/c1/r/core/namespaces",
  ]);
});

test("a multi-item icon opens its flyout of kinds on the first one; a second click closes it", async () => {
  await show();
  fireEvent.click(icon("workloads"));
  const box = flyout("workloads");
  if (box === null) throw new Error("no flyout");
  expect(icon("workloads").getAttribute("aria-expanded")).toBe("true");
  expect(box.querySelector(".flyoutTitle")?.textContent).toBe("Workloads");
  expect(
    within(box).getByTestId("rail-flyout-close").getAttribute("aria-label"),
  ).toBe("Close");
  const items = within(
    within(box).getByRole("menu", { name: "Workloads" }),
  ).getAllByRole("menuitem");
  expect(
    items.map((i) => [i.textContent, i.getAttribute("data-testid")]),
  ).toEqual([
    ["Overview", "rail-item-overview-workloads"],
    ["Pods", "rail-item-core-pods"],
    ["Deployments", "rail-item-apps-deployments"],
  ]);
  expect(items.every((i) => i.classList.contains("flyoutItem"))).toBe(true);
  expect(document.activeElement).toBe(items[0]);
  expect(box.style.top).toBe("8px");
  fireEvent.pointerDown(icon("workloads"));
  fireEvent.click(icon("workloads"));
  expect(flyout("workloads")).toBeNull();
  expect(icon("workloads").getAttribute("aria-expanded")).toBe("false");
});

test("Argo's flyout shows its Argo CD caption over its kinds, and Custom Resources its API groups", async () => {
  await show({ resources: TREE });
  fireEvent.click(icon("argo"));
  const argo = within(flyout("argo") as HTMLElement).getByRole("menu");
  expect(
    [...argo.children].map((c) => [c.getAttribute("role"), c.textContent]),
  ).toEqual([
    ["presentation", "Argo CD"],
    ["menuitem", "Applications"],
    ["menuitem", "AppProjects"],
  ]);
  fireEvent.pointerDown(document.body);
  fireEvent.click(icon("custom"));
  const custom = within(flyout("custom") as HTMLElement).getByRole("menu");
  expect([...custom.children].map((c) => c.textContent)).toEqual([
    "Definitions",
    "acme.io",
    "Gadget",
    "crossplane.io",
    "Composition",
    "acl.kafka.m.crossplane.io",
    "Topic",
    "pkg.crossplane.io",
    "Provider",
  ]);
});

test("a press on another icon closes the open flyout, and only one is ever open", async () => {
  await show();
  fireEvent.click(icon("workloads"));
  expect(flyout("workloads")).not.toBeNull();
  fireEvent.pointerDown(icon("network"));
  expect(flyout("workloads")).toBeNull();
  fireEvent.click(icon("network"));
  expect(flyout("network")).not.toBeNull();
  // A click without a press first (Enter on a focused icon) swaps the flyouts too.
  fireEvent.click(icon("helm"));
  expect(flyout("network")).toBeNull();
  expect(flyout("helm")).not.toBeNull();
  expect(screen.queryAllByTestId(/^rail-flyout-(?!close)/)).toHaveLength(1);
});

test("a pointer down outside closes the flyout; one inside it does not", async () => {
  await show();
  fireEvent.click(icon("workloads"));
  fireEvent.pointerDown(flyout("workloads") as HTMLElement);
  expect(flyout("workloads")).not.toBeNull();
  fireEvent.pointerDown(document.body);
  expect(flyout("workloads")).toBeNull();
});

test("keys: Up and Down move on the rail, Right opens a flyout, Up, Down, Home and End move in it, Escape returns", async () => {
  await show();
  icon("nodes").focus();
  fireEvent.keyDown(icon("nodes"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(icon("namespaces"));
  fireEvent.keyDown(icon("namespaces"), { key: "ArrowUp" });
  expect(document.activeElement).toBe(icon("nodes"));
  fireEvent.keyDown(icon("nodes"), { key: "ArrowUp" });
  expect(document.activeElement).toBe(icon("argo"));
  fireEvent.keyDown(icon("overview"), { key: "ArrowUp" });
  icon("workloads").focus();
  fireEvent.keyDown(icon("workloads"), { key: "ArrowRight" });
  const items = within(flyout("workloads") as HTMLElement).getAllByRole(
    "menuitem",
  );
  expect(document.activeElement).toBe(items[0]);
  const press = (key: string) =>
    fireEvent.keyDown(document.activeElement as HTMLElement, { key });
  press("ArrowDown");
  expect(document.activeElement).toBe(items[1]);
  press("End");
  expect(document.activeElement).toBe(items[2]);
  press("ArrowDown");
  expect(document.activeElement).toBe(items[2]);
  press("Home");
  expect(document.activeElement).toBe(items[0]);
  press("ArrowUp");
  expect(document.activeElement).toBe(items[0]);
  press("Escape");
  expect(flyout("workloads")).toBeNull();
  expect(document.activeElement).toBe(icon("workloads"));
  fireEvent.click(icon("workloads"));
  fireEvent.click(screen.getByTestId("rail-flyout-close"));
  expect(flyout("workloads")).toBeNull();
  expect(document.activeElement).toBe(icon("workloads"));
});

test("choosing an item navigates with the sidebar's link handlers and closes the flyout", async () => {
  await show();
  fireEvent.click(icon("workloads"));
  fireEvent.click(screen.getByTestId("rail-item-core-pods"));
  expect(paths()).toEqual(["/cluster/c1/r/core/pods"]);
  expect(flyout("workloads")).toBeNull();
  fireEvent.click(icon("workloads"));
  fireEvent.click(screen.getByTestId("rail-item-apps-deployments"), {
    ctrlKey: true,
  });
  expect(paths()).toEqual([
    "/cluster/c1/r/core/pods",
    "/cluster/c1/r/apps/deployments",
  ]);
  expect(flyout("workloads")).toBeNull();
  fireEvent.click(icon("workloads"));
  fireEvent(
    screen.getByTestId("rail-item-core-pods"),
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  expect(useWindowLayout.getState().layout.panes).toHaveLength(2);
  expect(flyout("workloads")).toBeNull();
});

test("a rail icon names its section in a tooltip on the right", async () => {
  await show();
  fireEvent.focus(icon("workloads"));
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe("Workloads");
  expect(
    document
      .querySelector("[data-radix-popper-content-wrapper] > *")
      ?.getAttribute("data-side"),
  ).toBe("right");
});

test("while resources load the rail shows a spinner, and after a failed load a retry icon", async () => {
  await show({ resources: [], loading: true });
  expect(
    within(screen.getByTestId("cluster-rail")).getByRole("status"),
  ).toBeTruthy();
  expect(screen.queryByTestId("rail-workloads")).toBeNull();
  expect(icon("overview")).toBeTruthy();
  cleanup();
  const onRetry = vi.fn();
  await show({ error: "boom", onRetry });
  expect(screen.getByTestId("rail-retry").getAttribute("aria-label")).toBe(
    "Could not load resources. Retry",
  );
  fireEvent.click(screen.getByTestId("rail-retry"));
  expect(onRetry).toHaveBeenCalled();
});
