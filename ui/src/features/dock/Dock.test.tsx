import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FilePlus,
  PanelBottom,
  Pen,
  Plug,
  ScrollText,
  SquareTerminal,
  Terminal,
} from "../../design/icons";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { resetCatalogForTest } from "../../stores/catalog";
import {
  detailsTab,
  editTab,
  logsTab,
  newCreateTab,
  nodeShellTabFor,
  podSessionTab,
  resetDockForTest,
  terminalTab,
  useDock,
} from "../../stores/dock";
import { resetResourcesForTest } from "../../stores/resources";
import { type Backend, flush, mockBackend } from "../../test/ipc";
import {
  captureResizeObservers,
  connectClusters,
  installFakeViews,
} from "../../test/terminal";
import { setAgentsSupportedForTest } from "../agents/supported";
import { resetSessionsForTest } from "../terminal/sessions";
import { setTermViewFactory } from "../terminal/termView";
import { Dock } from "./Dock";

vi.mock("../editor/YamlEditor", () => ({
  YamlEditor: (props: {
    value: string;
    onChange(v: string): void;
    readOnly?: boolean;
    testId?: string;
  }) => (
    <textarea
      data-testid={props.testId}
      value={props.value}
      readOnly={props.readOnly}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

const PODS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};

const WEB = editTab("c1", PODS, "team-a", "web");
const API = editTab("c1", PODS, "team-a", "api");
const OTHER = editTab("c2", PODS, "team-a", "other");

function panel(id: string) {
  return screen.getByTestId<HTMLElement>(`dock-panel-${id}`);
}

function editorOf(id: string) {
  return within(panel(id)).getByTestId<HTMLTextAreaElement>("yaml-editor");
}

async function show(clusterId = "c1") {
  const view = render(
    <MemoryRouter>
      <Dock clusterId={clusterId} />
    </MemoryRouter>,
  );
  await act(flush);
  return view;
}

let backend: Backend;

beforeEach(() => {
  resetDockForTest();
  setAgentsSupportedForTest(true);
  vi.stubGlobal("innerHeight", 1000);
  installFakeViews();
  captureResizeObservers();
  backend = mockBackend({
    resource_get_yaml: (a: { name: string }) => `kind: Pod\nname: ${a.name}\n`,
    logs_start: () => "s1",
    logs_stop: () => null,
    session_ack: () => null,
    resources_subscribe: () => "sub",
    resources_unsubscribe: () => null,
    terminal_start: () => "t1",
    node_shell_start: () => "n1",
    session_write: () => null,
    session_resize: () => null,
    session_stop: () => null,
    cluster_settings_get: () => ({ nodeShellImage: null }),
    ui_state_get: () => null,
    ui_state_set: () => null,
    api_schema: () => {
      throw new Error("no docs");
    },
  });
});

afterEach(() => {
  resetSessionsForTest();
  resetDockForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  setTermViewFactory(null);
  vi.unstubAllGlobals();
});

test("with no tabs the dock offers Create and no content", async () => {
  await show();

  expect(screen.getByTestId("dock")).toBeTruthy();
  expect(screen.queryByTestId("dock-minimize")).toBeNull();
  expect(screen.queryByTestId("dock-resize")).toBeNull();
  expect(screen.queryByTestId("yaml-editor")).toBeNull();
});

/** Opens the dock's + picker and picks `item`. */
function pick(item: string): void {
  fireEvent.click(screen.getByTestId("dock-new"));
  fireEvent.click(screen.getByTestId(item));
}

test("Create resource opens a create tab for this cluster", async () => {
  await show();

  pick("create-resource");
  await act(flush);

  const { tabs, activeId } = useDock.getState();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ kind: "create", clusterId: "c1" });
  expect(activeId).toBe(tabs[0].id);
  expect(screen.getByTestId(`dock-tab-${tabs[0].id}`)).toBeTruthy();
  expect(screen.getByTestId("create-apply")).toBeTruthy();
});

test("an edit tab shows its object and is named after it", async () => {
  useDock.getState().open(WEB);
  await show();

  expect(screen.getByTestId(`dock-tab-${WEB.id}`).textContent).toContain(
    "Pod team-a/web",
  );
  expect(editorOf(WEB.id).value).toContain("name: web");
});

test("clicking a tab switches to it and keeps the other's edits", async () => {
  useDock.getState().open(WEB);
  useDock.getState().open(API);
  await show();

  expect(panel(API.id).hidden).toBe(false);
  expect(panel(WEB.id).hidden).toBe(true);
  fireEvent.change(editorOf(API.id), { target: { value: "edited: true\n" } });

  fireEvent.click(screen.getByTestId(`dock-tab-${WEB.id}`));
  expect(panel(WEB.id).hidden).toBe(false);
  expect(panel(API.id).hidden).toBe(true);

  fireEvent.click(screen.getByTestId(`dock-tab-${API.id}`));
  expect(editorOf(API.id).value).toBe("edited: true\n");
});

test("closing a clean tab does not ask", async () => {
  useDock.getState().open(WEB);
  await show();

  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  await act(flush);

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useDock.getState().tabs).toEqual([]);
});

test("closing a dirty tab asks first", async () => {
  useDock.getState().open(WEB);
  await show();
  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Pod team-a/web");

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await act(flush);
  expect(useDock.getState().tabs).toHaveLength(1);
  expect(editorOf(WEB.id).value).toBe("edited: true\n");

  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  const again = await screen.findByRole("dialog");
  fireEvent.click(within(again).getByRole("button", { name: "Discard" }));
  await act(flush);
  expect(useDock.getState().tabs).toEqual([]);
});

test("a dirty tab is marked in the tab strip", async () => {
  useDock.getState().open(WEB);
  await show();
  const tab = screen.getByTestId(`dock-tab-${WEB.id}`);
  expect(tab.dataset.dirty).toBe("false");

  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  expect(screen.getByTestId(`dock-tab-${WEB.id}`).dataset.dirty).toBe("true");
});

test("minimized hides content and keeps tabs", async () => {
  useDock.getState().open(WEB);
  await show();
  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  fireEvent.click(screen.getByTestId("dock-minimize"));

  expect(useDock.getState().minimized).toBe(true);
  expect(panel(WEB.id).hidden).toBe(true);
  expect(screen.getByTestId(`dock-tab-${WEB.id}`)).toBeTruthy();
  expect(screen.queryByTestId("dock-resize")).toBeNull();
  expect(screen.getByTestId("dock").style.height).toBe("");

  fireEvent.click(screen.getByTestId("dock-minimize"));

  expect(panel(WEB.id).hidden).toBe(false);
  expect(editorOf(WEB.id).value).toBe("edited: true\n");
});

test("clicking a tab while minimized shows the dock again", async () => {
  useDock.getState().open(WEB);
  useDock.getState().setMinimized(true);
  await show();

  fireEvent.click(screen.getByTestId(`dock-tab-${WEB.id}`));

  expect(useDock.getState().minimized).toBe(false);
});

test("resize handle updates height", async () => {
  useDock.getState().open(WEB);
  useDock.getState().setHeight(300);
  await show();
  const handle = screen.getByTestId("dock-resize");
  expect(screen.getByTestId("dock").style.height).toBe("300px");

  fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
  expect(useDock.getState().height).toBe(400);
  expect(screen.getByTestId("dock").style.height).toBe("400px");

  fireEvent.pointerMove(handle, { clientY: 450, pointerId: 1 });
  expect(useDock.getState().height).toBe(350);

  fireEvent.pointerUp(handle, { clientY: 450, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
  expect(useDock.getState().height).toBe(350);
});

test("the resize handle works from the keyboard", async () => {
  useDock.getState().open(WEB);
  useDock.getState().setHeight(300);
  await show();
  const handle = screen.getByRole("separator", { name: "Resize dock" });

  fireEvent.keyDown(handle, { key: "ArrowUp" });
  expect(useDock.getState().height).toBeGreaterThan(300);

  act(() => useDock.getState().setHeight(300));
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  expect(useDock.getState().height).toBeLessThan(300);
});

test("the dock shows only the current cluster's tabs", async () => {
  useDock.getState().open(WEB);
  useDock.getState().open(OTHER);
  useDock.getState().open(newCreateTab("c2"));
  await show("c1");

  expect(screen.getByTestId(`dock-tab-${WEB.id}`)).toBeTruthy();
  expect(screen.queryByTestId(`dock-tab-${OTHER.id}`)).toBeNull();
  expect(screen.queryAllByRole("tab")).toHaveLength(1);
  // The active tab is another cluster's, so this cluster's own tab is shown.
  expect(panel(WEB.id).hidden).toBe(false);
});

test("unsaved edits come back with their cluster", async () => {
  useDock.getState().open(WEB);
  const view = await show("c1");
  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  view.unmount();
  useDock.getState().open(OTHER);
  const second = await show("c2");
  expect(screen.queryByTestId(`dock-tab-${WEB.id}`)).toBeNull();

  second.unmount();
  await show("c1");
  expect(editorOf(WEB.id).value).toBe("edited: true\n");
  expect(screen.getByTestId(`dock-tab-${WEB.id}`).dataset.dirty).toBe("true");
});

test("each tab shows its kind's 14 px icon before its title", async () => {
  const create = newCreateTab("c1");
  const logs = logsTab("c1", PODS, {
    metadata: { name: "web", namespace: "team-a" },
    spec: { containers: [{ name: "main" }] },
  });
  const terminal = terminalTab("c1", "kind-dev");
  const shell = podSessionTab("shell", "c1", "team-a", "web", "main");
  const attach = podSessionTab("attach", "c1", "team-a", "web", "main");
  const nodeShell = nodeShellTabFor("c1", "worker-1");
  const details = detailsTab("c1", PODS, "team-a", "web", "events");
  for (const tab of [
    WEB,
    create,
    logs,
    terminal,
    shell,
    attach,
    nodeShell,
    details,
  ]) {
    useDock.getState().open(tab);
  }
  await show();

  for (const [tab, Icon] of [
    [WEB, Pen],
    [create, FilePlus],
    [logs, ScrollText],
    [terminal, SquareTerminal],
    [shell, Terminal],
    [attach, Plug],
    [nodeShell, Terminal],
    [details, PanelBottom],
  ] as const) {
    const button = screen.getByTestId(`dock-tab-${tab.id}`);
    const svg = button.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.closest("[data-icon]")?.getAttribute("data-icon")).toBe(
      Icon.iconName,
    );
    expect(button.firstElementChild).toBe(svg?.closest("[data-icon]"));
    expect(button.textContent).toBe(tab.title);
  }
  expect(
    screen.getByTestId(`dock-close-${logs.id}`).getAttribute("aria-label"),
  ).toBe("Close Logs · web");
  expect(
    screen.getByTestId(`dock-close-${terminal.id}`).getAttribute("aria-label"),
  ).toBe("Close Terminal · kind-dev");
});

test("a Logs tab's panel holds the Logs view, which starts its stream", async () => {
  const logs = logsTab("c1", PODS, {
    metadata: { name: "web", namespace: "team-a" },
    spec: { containers: [{ name: "main" }] },
  });
  useDock.getState().open(logs);
  await show();

  const body = within(panel(logs.id));
  expect(body.getByTestId("logs-tab")).toBeTruthy();
  expect(body.getByTestId("logs-status").textContent).toBe("Connecting");
});

test("the dock waits for the saved layout before it shows", async () => {
  useDock.setState({ restored: false });
  await show();
  expect(screen.queryByTestId("dock")).toBeNull();

  act(() =>
    useDock.getState().restore({
      height: 400,
      minimized: false,
      activeId: WEB.id,
      tabs: [WEB],
    }),
  );
  expect(screen.getByTestId("dock").style.height).toBe("400px");
  expect(
    screen.getByTestId(`dock-tab-${WEB.id}`).getAttribute("aria-selected"),
  ).toBe("true");
});

test("Ctrl+Shift+PageDown moves the focused tab right, keeps its focus, and stops at the end", async () => {
  const B = editTab("c1", PODS, "team-a", "b");
  const C = editTab("c1", PODS, "team-a", "c");
  for (const tab of [WEB, B, C]) useDock.getState().open(tab);
  await show();
  const tab = (id: string) => screen.getByTestId(`dock-tab-${id}`);
  const order = () =>
    within(screen.getByRole("tablist", { name: "Open editors" }))
      .getAllByRole("tab")
      .map((t) => t.textContent);
  const press = (key: string, chord = true) =>
    fireEvent.keyDown(document.activeElement as Element, {
      key,
      ctrlKey: chord,
      shiftKey: chord,
    });

  tab(WEB.id).focus();
  press("PageDown");
  expect(order()).toEqual([B.title, WEB.title, C.title]);
  expect(document.activeElement).toBe(tab(WEB.id));
  press("PageDown");
  expect(order()).toEqual([B.title, C.title, WEB.title]);
  expect(document.activeElement).toBe(tab(WEB.id));
  press("PageDown");
  expect(order()).toEqual([B.title, C.title, WEB.title]);
  expect(document.activeElement).toBe(tab(WEB.id));

  press("PageUp");
  expect(order()).toEqual([B.title, WEB.title, C.title]);
  press("PageDown", false);
  expect(order()).toEqual([B.title, WEB.title, C.title]);
  expect(useDock.getState().tabs.map((t) => t.id)).toEqual([
    B.id,
    WEB.id,
    C.id,
  ]);
});

test("the resize handle states its limits, and a double-click resets the height", async () => {
  useDock.getState().open(WEB);
  useDock.getState().setHeight(500);
  await show();

  const handle = screen.getByTestId("dock-resize");
  expect(handle.getAttribute("aria-valuemin")).toBe("120");
  expect(handle.getAttribute("aria-valuemax")).toBe("800");
  expect(handle.getAttribute("aria-valuenow")).toBe("500");
  expect(handle.title).toBe("Drag to resize, double-click to reset");
  fireEvent.doubleClick(handle);
  expect(handle.getAttribute("aria-valuenow")).toBe("320");
  expect(useDock.getState().height).toBe(320);
});

const backquote = { code: "Backquote", key: "`" };

function tabIds(): string[] {
  return useDock.getState().tabs.map((t) => t.id);
}

test("the + is named New tab and lists a blank draft, the template groups and a terminal", async () => {
  await show();
  const plus = screen.getByTestId("dock-new");
  expect(plus.getAttribute("aria-label")).toBe("New tab");
  fireEvent.click(plus);
  const picker = screen.getByTestId("dock-new-picker");
  expect(within(picker).getByTestId("create-resource").textContent).toContain(
    "Blank YAML",
  );
  expect(within(picker).getByText("Workloads")).toBeTruthy();
  expect(within(picker).getByTestId("dock-terminal").textContent).toContain(
    "Terminal session",
  );
});

test("Blank YAML, Draft with AI and Terminal session come first, before the templates", async () => {
  await show();
  fireEvent.click(screen.getByTestId("dock-new"));
  const ids = within(screen.getByTestId("dock-new-picker"))
    .getAllByRole("option")
    .map((option) => option.getAttribute("data-testid"));
  const terminal = ids.indexOf("dock-terminal");
  expect(ids[0]).toBe("create-resource");
  expect(ids.slice(1, terminal)).toEqual(
    ids.includes("dock-ai-draft") ? ["dock-ai-draft"] : [],
  );
  expect(ids.length).toBeGreaterThan(terminal + 1);
});

test("a template opens a create tab named after it, holding its text, not dirty", async () => {
  await show();
  fireEvent.click(screen.getByTestId("dock-new"));
  fireEvent.change(screen.getByTestId("dock-new-picker-search"), {
    target: { value: "nodeport" },
  });
  fireEvent.click(screen.getByTestId("menu-item-service-nodeport"));
  await act(flush);
  const [tab] = useDock.getState().tabs;
  expect(tab).toMatchObject({
    kind: "create",
    clusterId: "c1",
    title: "New Service · NodePort",
    dirty: false,
  });
  expect(
    (screen.getByTestId("yaml-editor") as HTMLTextAreaElement).value,
  ).toContain("type: NodePort");
});

test("templates of kinds the cluster does not serve are disabled", async () => {
  render(
    <MemoryRouter>
      <Dock
        clusterId="c1"
        resources={[
          {
            resource: {
              group: "",
              version: "v1",
              plural: "pods",
              kind: "Pod",
              namespaced: true,
            },
            verbs: [],
            shortNames: [],
            canList: true,
            canWatch: true,
            canCreate: true,
            canUpdate: true,
            canPatch: true,
            canDelete: true,
          },
        ]}
      />
    </MemoryRouter>,
  );
  await act(flush);
  fireEvent.click(screen.getByTestId("dock-new"));
  expect(
    screen.getByTestId("menu-item-gateway").getAttribute("aria-disabled"),
  ).toBe("true");
  expect(
    screen.getByTestId("menu-item-pod").getAttribute("aria-disabled"),
  ).toBeNull();
});

test("each Terminal Session is a new terminal, numbered after the first", async () => {
  connectClusters({ id: "c1", name: "kind-dev" });
  await show();

  pick("dock-terminal");
  await act(flush);
  expect(useDock.getState().tabs).toEqual([terminalTab("c1", "kind-dev")]);
  expect(screen.getByTestId("dock-tab-terminal:c1").textContent).toBe(
    "Terminal · kind-dev",
  );
  expect(within(panel("terminal:c1")).getByTestId("terminal-tab")).toBeTruthy();

  pick("dock-terminal");
  await act(flush);
  expect(tabIds()).toEqual(["terminal:c1", "terminal:c1:2"]);
  expect(useDock.getState().activeId).toBe("terminal:c1:2");
  expect(screen.getByTestId("dock-tab-terminal:c1:2").textContent).toBe(
    "Terminal 2 · kind-dev",
  );
  // Each tab runs its own session.
  expect(backend.callsTo("terminal_start")).toMatchObject([
    { clusterId: "c1" },
    { clusterId: "c1" },
  ]);

  // A number comes free when its terminal closes.
  act(() => useDock.getState().close("terminal:c1"));
  pick("dock-terminal");
  await act(flush);
  expect(tabIds()).toEqual(["terminal:c1:2", "terminal:c1"]);
});

test("Ctrl+` brings an open terminal forward, the active one first, and shows the dock", async () => {
  connectClusters({ id: "c1", name: "kind-dev" });
  useDock.getState().open(terminalTab("c1", "kind-dev"));
  useDock.getState().open(terminalTab("c1", "kind-dev", 2));
  useDock.getState().open(WEB);
  useDock.getState().setMinimized(true);
  await show();

  fireEvent.keyDown(window, { ...backquote, ctrlKey: true });
  await act(flush);
  expect(tabIds()).toEqual(["terminal:c1", "terminal:c1:2", WEB.id]);
  expect(useDock.getState().activeId).toBe("terminal:c1");
  expect(useDock.getState().minimized).toBe(false);

  act(() => useDock.getState().activate("terminal:c1:2"));
  fireEvent.keyDown(window, { ...backquote, ctrlKey: true });
  await act(flush);
  expect(useDock.getState().activeId).toBe("terminal:c1:2");
  expect(tabIds()).toHaveLength(3);
});

test("Ctrl+` opens the terminal, also from inside a terminal, and other modifiers do nothing", async () => {
  connectClusters({ id: "c1", name: "kind-dev" });
  await show();

  fireEvent.keyDown(window, { ...backquote, ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { ...backquote, ctrlKey: true, altKey: true });
  fireEvent.keyDown(window, { ...backquote, ctrlKey: true, metaKey: true });
  fireEvent.keyDown(window, backquote);
  expect(tabIds()).toEqual([]);

  fireEvent.keyDown(window, { ...backquote, ctrlKey: true });
  await act(flush);
  expect(tabIds()).toEqual(["terminal:c1"]);

  act(() => useDock.getState().setMinimized(true));
  fireEvent.keyDown(screen.getByTestId("terminal-view"), {
    ...backquote,
    ctrlKey: true,
  });
  await act(flush);
  expect(useDock.getState().minimized).toBe(false);
  expect(tabIds()).toEqual(["terminal:c1"]);
});

test("Ctrl+` does nothing while a dialog is open", async () => {
  useDock.getState().open(WEB);
  await show();
  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });
  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  await screen.findByRole("dialog");

  fireEvent.keyDown(window, { ...backquote, ctrlKey: true });
  await act(flush);
  expect(tabIds()).toEqual([WEB.id]);
});

test("restored tabs: a hidden terminal starts when its tab is shown, a node shell waits for Reconnect", async () => {
  connectClusters({ id: "c1", name: "kind-dev" });
  const terminal = terminalTab("c1", "kind-dev");
  const nodeShell = nodeShellTabFor("c1", "worker-1");
  useDock.getState().open(terminal);
  useDock.getState().open(nodeShell);
  await show();

  expect(backend.callsTo("terminal_start")).toEqual([]);
  expect(
    within(panel(nodeShell.id)).getByTestId("terminal-status").textContent,
  ).toBe("Not connected");

  fireEvent.click(screen.getByTestId(`dock-tab-${terminal.id}`));
  await act(flush);
  expect(backend.callsTo("terminal_start")).toHaveLength(1);
  expect(backend.callsTo("node_shell_start")).toEqual([]);
});

test("Draft with AI opens a blank create tab with its AI bar open", async () => {
  await show();
  fireEvent.click(screen.getByTestId("dock-new"));
  expect(screen.getByTestId("dock-ai-draft").textContent).toContain(
    "Draft with AI",
  );
  fireEvent.click(screen.getByTestId("dock-ai-draft"));
  await act(flush);
  const [tab] = useDock.getState().tabs;
  expect(tab).toMatchObject({
    kind: "create",
    clusterId: "c1",
    title: "Create",
  });
  expect(screen.getByTestId("yaml-ai-bar")).toBeTruthy();
  expect(
    (screen.getByTestId("yaml-ai-input") as HTMLTextAreaElement).placeholder,
  ).toBe("Describe the objects to create");
});

test("Draft with AI is not offered where agents are not supported", async () => {
  setAgentsSupportedForTest(false);
  await show();
  fireEvent.click(screen.getByTestId("dock-new"));
  expect(screen.queryByTestId("dock-ai-draft")).toBeNull();
});
