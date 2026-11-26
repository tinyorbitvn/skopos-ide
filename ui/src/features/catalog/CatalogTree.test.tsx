import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { CatalogFolders } from "../../ipc/generated/CatalogFolders";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetFoldersForTest, useFolders } from "../../stores/folders";
import { resetShellForTest } from "../../stores/shell";
import { resetTunnelsForTest, useTunnels } from "../../stores/tunnels";
import { clusterEntry, mockBackend } from "../../test/ipc";
import { tunnel } from "../../test/tunnels";
import { CatalogScreen } from "./CatalogScreen";

// prod > eu; Local. prod-eu-1 in eu, prod-main in prod, kind-a in Local; Beta and
// demo at the top level.
const TREE: CatalogFolders = {
  folders: [
    { id: "folder-1", name: "prod", parent: null },
    { id: "folder-2", name: "eu", parent: "folder-1" },
    { id: "folder-3", name: "Local", parent: null },
  ],
  placements: {
    "id-prod-eu-1": "folder-2",
    "id-prod-main": "folder-1",
    "id-kind-a": "folder-3",
  },
};

const CLUSTERS = ["prod-eu-1", "demo", "kind-a", "Beta", "prod-main"].map(
  (contextName) => clusterEntry({ contextName }),
);

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

async function show(
  over: Record<string, (args: never) => unknown> = {},
  tree: CatalogFolders = TREE,
) {
  let current = tree;
  const ipc = mockBackend({
    catalog_list: () => CLUSTERS,
    catalog_warnings: () => [],
    hotbar_get: () => [],
    catalog_folders: () => current,
    ui_state_get: () => null,
    ui_state_set: () => null,
    ...over,
  });
  await useCatalog.getState().init();
  await useFolders.getState().init();
  render(
    <MemoryRouter initialEntries={["/catalog"]}>
      <CatalogScreen />
      <Where />
    </MemoryRouter>,
  );
  return {
    ipc,
    setTree(next: CatalogFolders) {
      current = next;
    },
  };
}

/** The test ids of the tree's rows, top to bottom. */
function order(): string[] {
  return screen
    .getAllByRole("row")
    .map((row) => row.getAttribute("data-testid") ?? "")
    .filter((id) => id !== "");
}

function openMenu(testId: string) {
  fireEvent.keyDown(screen.getByTestId(testId), { key: "Enter" });
}

async function openMoveTo(): Promise<HTMLElement> {
  const trigger = await screen.findByTestId("menu-item-move");
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  return screen.findByTestId("menu-item-move-top");
}

const elementFromPoint = document.elementFromPoint;

/** What `document.elementFromPoint` finds from now on. */
function under(el: Element | null): void {
  document.elementFromPoint = vi.fn(() => el);
}

function press(testId: string): void {
  fireEvent.pointerDown(screen.getByTestId(testId), {
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
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

function release(x: number, y: number): void {
  fireEvent.pointerUp(window, { clientX: x, clientY: y, pointerId: 1 });
}

beforeEach(() => {
  resetCatalogForTest();
  resetFoldersForTest();
  resetShellForTest();
  resetTunnelsForTest();
  under(null);
});

afterEach(async () => {
  fireEvent.pointerCancel(window, { pointerId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.elementFromPoint = elementFromPoint;
  vi.restoreAllMocks();
});

test("folders come first, then clusters, each by name ignoring case, with their counts (P29)", async () => {
  await show();

  expect(order()).toEqual([
    "catalog-folder-folder-3",
    "catalog-row-kind-a",
    "catalog-folder-folder-1",
    "catalog-folder-folder-2",
    "catalog-row-prod-eu-1",
    "catalog-row-prod-main",
    "catalog-row-Beta",
    "catalog-row-demo",
  ]);
  expect(screen.getByRole("treegrid").getAttribute("aria-label")).toBe(
    "Clusters by folder",
  );
  // A folder counts the clusters of its subfolders too.
  expect(screen.getByTestId("catalog-folder-count-folder-1").textContent).toBe(
    "2",
  );
  expect(screen.getByTestId("catalog-folder-count-folder-2").textContent).toBe(
    "1",
  );
  expect(
    screen.getByTestId("catalog-row-prod-eu-1").getAttribute("aria-level"),
  ).toBe("3");
  // Today's columns stay.
  const header = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(header).toEqual([
    "Name",
    "Source",
    "Distribution",
    "Status",
    "Actions",
  ]);
});

test("a folder collapses and expands, and which are open is remembered (P29)", async () => {
  const { ipc } = await show({
    ui_state_get: ({ key }: { key: string }) =>
      key === "catalog:folders:closed" ? ["folder-3"] : null,
  });

  await waitFor(() =>
    expect(screen.queryByTestId("catalog-row-kind-a")).toBeNull(),
  );
  const prod = screen.getByTestId("catalog-folder-toggle-folder-1");
  expect(prod.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(prod);

  expect(prod.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByTestId("catalog-folder-folder-2")).toBeNull();
  expect(screen.queryByTestId("catalog-row-prod-main")).toBeNull();
  await waitFor(() =>
    expect(ipc.callsTo("ui_state_set")).toContainEqual({
      key: "catalog:folders:closed",
      value: ["folder-3", "folder-1"],
    }),
  );

  fireEvent.click(screen.getByTestId("catalog-folder-toggle-folder-3"));
  expect(screen.getByTestId("catalog-row-kind-a")).toBeTruthy();
});

test("New folder adds a top-level folder to name; Enter saves and errors show under the name (P29)", async () => {
  let tree = TREE;
  const { ipc, setTree } = await show({
    catalog_folder_create: ({
      parent,
      name,
    }: {
      parent: string | null;
      name: string;
    }) => {
      const folder = { id: "folder-4", name, parent };
      tree = { ...tree, folders: [...tree.folders, folder] };
      setTree(tree);
      return folder;
    },
    catalog_folder_rename: ({ name }: { name: string }) => {
      if (name.trim().toLowerCase() === "prod") {
        throw { code: "InvalidInput", message: "PROD already exists here." };
      }
      return null;
    },
  });

  fireEvent.click(screen.getByTestId("catalog-new-folder"));

  const input = (await screen.findByTestId(
    "catalog-folder-rename",
  )) as HTMLInputElement;
  expect(ipc.callsTo("catalog_folder_create")).toEqual([
    { parent: null, name: "New folder" },
  ]);
  expect(input.value).toBe("New folder");
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(
    within(screen.getByTestId("catalog-folder-folder-4")).getByTestId(
      "catalog-folder-rename",
    ),
  ).toBe(input);

  fireEvent.change(input, { target: { value: "PROD" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const error = await screen.findByTestId("catalog-folder-rename-error");
  expect(error.textContent).toBe("PROD already exists here.");
  expect(input.getAttribute("aria-invalid")).toBe("true");

  fireEvent.change(input, { target: { value: "dev" } });
  expect(screen.queryByTestId("catalog-folder-rename-error")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(screen.queryByTestId("catalog-folder-rename")).toBeNull(),
  );
  expect(ipc.callsTo("catalog_folder_rename")).toEqual([
    { id: "folder-4", name: "PROD" },
    { id: "folder-4", name: "dev" },
  ]);
});

test("the folder menu: New subfolder, Rename, Move to and Delete; Esc or a click outside cancels a rename (P29)", async () => {
  const { ipc } = await show({
    catalog_folder_create: ({
      parent,
      name,
    }: {
      parent: string | null;
      name: string;
    }) => ({ id: "folder-9", name, parent }),
    catalog_folder_rename: () => null,
  });

  openMenu("catalog-folder-menu-folder-1");
  await screen.findByTestId("menu-item-rename");
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["New subfolder", "Rename", "Move to", "Delete"]);
  fireEvent.click(screen.getByTestId("menu-item-rename"));

  let input = (await screen.findByTestId(
    "catalog-folder-rename",
  )) as HTMLInputElement;
  expect(input.value).toBe("prod");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByTestId("catalog-folder-rename")).toBeNull();

  openMenu("catalog-folder-menu-folder-1");
  fireEvent.click(await screen.findByTestId("menu-item-rename"));
  input = (await screen.findByTestId(
    "catalog-folder-rename",
  )) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "other" } });
  fireEvent.pointerDown(document.body);
  expect(screen.queryByTestId("catalog-folder-rename")).toBeNull();
  // The same name saves nothing.
  openMenu("catalog-folder-menu-folder-1");
  fireEvent.click(await screen.findByTestId("menu-item-rename"));
  fireEvent.keyDown(await screen.findByTestId("catalog-folder-rename"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(screen.queryByTestId("catalog-folder-rename")).toBeNull(),
  );
  expect(ipc.callsTo("catalog_folder_rename")).toEqual([]);

  openMenu("catalog-folder-menu-folder-1");
  fireEvent.click(await screen.findByTestId("menu-item-new-subfolder"));
  await waitFor(() =>
    expect(ipc.callsTo("catalog_folder_create")).toEqual([
      { parent: "folder-1", name: "New folder" },
    ]),
  );
});

test("Move to lists every other place and says why one is refused (P28, P29)", async () => {
  const { ipc } = await show({ catalog_folder_move: () => null });

  openMenu("catalog-folder-menu-folder-1");
  const top = await openMoveTo();
  expect(top.textContent).toBe("Top levelAlready here");
  expect(top.hasAttribute("data-disabled")).toBe(true);
  expect(screen.getByTestId("menu-item-move-folder-3").textContent).toBe(
    "Local",
  );
  // Not itself, not its own subfolder.
  expect(screen.queryByTestId("menu-item-move-folder-1")).toBeNull();
  expect(screen.queryByTestId("menu-item-move-folder-2")).toBeNull();
  fireEvent.keyDown(screen.getAllByRole("menu")[0], { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  openMenu("catalog-folder-menu-folder-2");
  fireEvent.click(await openMoveTo());
  await waitFor(() =>
    expect(ipc.callsTo("catalog_folder_move")).toEqual([
      { id: "folder-2", parent: null },
    ]),
  );
});

test("the cluster menu keeps today's items and adds Move to (P29)", async () => {
  const { ipc } = await show({ catalog_cluster_place: () => null });

  openMenu("catalog-menu-demo");
  await openMoveTo();
  expect(
    screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
      .slice(0, 3),
  ).toEqual(["Pin to hotbar", "Settings", "Move to"]);
  expect(
    screen.getByTestId("menu-item-move-top").hasAttribute("data-disabled"),
  ).toBe(true);
  const eu = screen.getByTestId("menu-item-move-folder-2");
  expect(eu.textContent).toBe("prod / eu");
  fireEvent.click(eu);

  await waitFor(() =>
    expect(ipc.callsTo("catalog_cluster_place")).toEqual([
      { cluster: "id-demo", folder: "folder-2" },
    ]),
  );
});

test("a folder closed while a Move to is on its way stays closed, and the target opens (P29)", async () => {
  let placed: (value: null) => void = () => {};
  const { ipc } = await show({
    ui_state_get: ({ key }: { key: string }) =>
      key === "catalog:folders:closed" ? ["folder-3"] : null,
    catalog_cluster_place: () =>
      new Promise<null>((resolve) => {
        placed = resolve;
      }),
  });
  await waitFor(() =>
    expect(screen.queryByTestId("catalog-row-kind-a")).toBeNull(),
  );

  openMenu("catalog-menu-demo");
  await openMoveTo();
  fireEvent.click(screen.getByTestId("menu-item-move-folder-3"));
  await waitFor(() =>
    expect(ipc.callsTo("catalog_cluster_place")).toHaveLength(1),
  );
  const prod = screen.getByTestId("catalog-folder-toggle-folder-1");
  fireEvent.click(prod);
  expect(prod.getAttribute("aria-expanded")).toBe("false");

  await act(async () => placed(null));

  await waitFor(() =>
    expect(
      screen
        .getByTestId("catalog-folder-toggle-folder-3")
        .getAttribute("aria-expanded"),
    ).toBe("true"),
  );
  expect(
    screen
      .getByTestId("catalog-folder-toggle-folder-1")
      .getAttribute("aria-expanded"),
  ).toBe("false");
  await waitFor(() =>
    expect(ipc.callsTo("ui_state_set").at(-1)).toEqual({
      key: "catalog:folders:closed",
      value: ["folder-1"],
    }),
  );
});

test("Delete: an empty folder goes at once, another asks first with what moves where (P28, P29)", async () => {
  const tree: CatalogFolders = {
    ...TREE,
    folders: [...TREE.folders, { id: "folder-4", name: "empty", parent: null }],
  };
  const { ipc } = await show({ catalog_folder_delete: () => null }, tree);

  openMenu("catalog-folder-menu-folder-4");
  fireEvent.click(await screen.findByTestId("menu-item-delete"));
  await waitFor(() =>
    expect(ipc.callsTo("catalog_folder_delete")).toEqual([{ id: "folder-4" }]),
  );
  expect(screen.queryByRole("dialog")).toBeNull();

  openMenu("catalog-folder-menu-folder-1");
  fireEvent.click(await screen.findByTestId("menu-item-delete"));
  let dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("Delete folder")).toBeTruthy();
  expect(
    dialog.getByText(
      "Delete prod? Its 1 cluster and 1 folder move to Top level.",
    ),
  ).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(ipc.callsTo("catalog_folder_delete")).toHaveLength(1);

  openMenu("catalog-folder-menu-folder-1");
  fireEvent.click(await screen.findByTestId("menu-item-delete"));
  dialog = within(await screen.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(ipc.callsTo("catalog_folder_delete")).toEqual([
      { id: "folder-4" },
      { id: "folder-1" },
    ]),
  );
});

test("a delete whose subfolder's name the parent has is refused in the dialog (P28)", async () => {
  const tree: CatalogFolders = {
    ...TREE,
    folders: [...TREE.folders, { id: "folder-4", name: "EU", parent: null }],
  };
  const { ipc } = await show({ catalog_folder_delete: () => null }, tree);

  openMenu("catalog-folder-menu-folder-1");
  fireEvent.click(await screen.findByTestId("menu-item-delete"));

  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("Cannot delete this folder")).toBeTruthy();
  expect(
    dialog.getByText(
      "Top level already has a folder named eu. Rename one of them first.",
    ),
  ).toBeTruthy();
  const remove = dialog.getByRole("button", { name: "Delete" });
  expect((remove as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(remove);
  expect(ipc.callsTo("catalog_folder_delete")).toEqual([]);
});

test("the search filters clusters by name and folder path and opens their folders (P29)", async () => {
  await show({
    ui_state_get: ({ key }: { key: string }) =>
      key === "catalog:folders:closed" ? ["folder-1", "folder-3"] : null,
  });
  await waitFor(() =>
    expect(screen.queryByTestId("catalog-folder-folder-2")).toBeNull(),
  );
  const search = screen.getByTestId("catalog-search");

  fireEvent.change(search, { target: { value: "prod / eu" } });
  expect(order()).toEqual([
    "catalog-folder-folder-1",
    "catalog-folder-folder-2",
    "catalog-row-prod-eu-1",
  ]);

  fireEvent.change(search, { target: { value: "kind" } });
  expect(order()).toEqual(["catalog-folder-folder-3", "catalog-row-kind-a"]);

  fireEvent.change(search, { target: { value: "" } });
  expect(order()).toEqual([
    "catalog-folder-folder-3",
    "catalog-folder-folder-1",
    "catalog-row-Beta",
    "catalog-row-demo",
  ]);
});

test("a cluster dragged onto a folder row goes into it; the click after the drop opens nothing (P29)", async () => {
  const { ipc } = await show({ catalog_cluster_place: () => null });

  press("catalog-row-demo");
  move(30, 30);
  const label = await screen.findByTestId("catalog-drag-label");
  expect(label.textContent).toContain("demo");
  expect(screen.getByTestId("catalog-drop-top")).toBeTruthy();

  under(screen.getByTestId("catalog-folder-folder-2"));
  move(40, 40);
  expect(
    screen.getByTestId("catalog-folder-folder-2").getAttribute("data-drop"),
  ).toBe("ok");
  expect(screen.getByTestId("catalog-drag-label").textContent).toContain(
    "Let go to move it into prod / eu",
  );

  release(40, 40);
  fireEvent.click(screen.getByTestId("catalog-row-demo"));

  await waitFor(() =>
    expect(ipc.callsTo("catalog_cluster_place")).toEqual([
      { cluster: "id-demo", folder: "folder-2" },
    ]),
  );
  expect(screen.queryByTestId("catalog-drag-label")).toBeNull();
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("a press whose release was missed before the drag started starts none (P29)", async () => {
  const { ipc } = await show({ catalog_cluster_place: () => null });

  press("catalog-row-demo");
  move(12, 10, 0);
  under(screen.getByTestId("catalog-folder-folder-3"));
  move(30, 30, 0);
  move(40, 40);

  expect(screen.queryByTestId("catalog-drag-label")).toBeNull();
  release(40, 40);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(ipc.callsTo("catalog_cluster_place")).toEqual([]);
});

test("a drag that starts moves no row: the Top level strip is not a body row (P29)", async () => {
  await show();
  /** Each body row's test id, top to bottom, "" for a row without one. */
  const bodyRows = () =>
    Array.from(
      screen.getByTestId("catalog-table").querySelectorAll("tbody > tr"),
      (row) => row.getAttribute("data-testid") ?? "",
    );
  const firstItem = () =>
    bodyRows().findIndex((id) => /^catalog-(folder|row)-/.test(id));
  const before = bodyRows();
  expect(firstItem()).toBe(0);

  press("catalog-row-demo");
  move(30, 30);
  await screen.findByTestId("catalog-drag-label");

  expect(screen.getByTestId("catalog-drop-top")).toBeTruthy();
  expect(bodyRows()).toEqual(before);
  expect(firstItem()).toBe(0);
});

test("a refused target shows as not allowed and takes nothing; the Top level strip takes a folder out (P28, P29)", async () => {
  const { ipc } = await show({ catalog_folder_move: () => null });

  press("catalog-folder-folder-1");
  move(30, 30);
  under(screen.getByTestId("catalog-folder-folder-2"));
  move(40, 40);
  expect(
    screen.getByTestId("catalog-folder-folder-2").getAttribute("data-drop"),
  ).toBe("refused");
  expect(screen.getByTestId("catalog-drag-label").textContent).toContain(
    "A folder cannot go inside itself.",
  );
  release(40, 40);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(ipc.callsTo("catalog_folder_move")).toEqual([]);

  press("catalog-folder-folder-2");
  move(30, 30);
  under(screen.getByTestId("catalog-drop-top"));
  move(40, 40);
  release(40, 40);
  await waitFor(() =>
    expect(ipc.callsTo("catalog_folder_move")).toEqual([
      { id: "folder-2", parent: null },
    ]),
  );
});

test("Esc cancels a drag, and a refused drop by the core shows in a toast (P44)", async () => {
  const error = vi.spyOn(toast, "error");
  const { ipc } = await show({
    catalog_cluster_place: () => {
      throw { code: "Internal", message: "Could not save the folders." };
    },
  });

  press("catalog-row-demo");
  move(30, 30);
  under(screen.getByTestId("catalog-folder-folder-3"));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("catalog-drag-label")).toBeNull();
  release(40, 40);
  expect(ipc.callsTo("catalog_cluster_place")).toEqual([]);

  press("catalog-row-demo");
  move(30, 30);
  move(40, 40);
  release(40, 40);
  await waitFor(() =>
    expect(error).toHaveBeenCalledWith(
      "Could not move demo",
      "Could not save the folders.",
    ),
  );
});

test("a connected cluster whose tunnel failed shows the badge in its status", async () => {
  useTunnels.setState({
    tunnels: [tunnel({ state: { status: "failed", message: "refused" } })],
  });
  const connected = clusterEntry({
    contextName: "kind-a",
    tunnel: "t1",
    state: {
      status: "connected",
      info: {
        version: "v1.31.0",
        distribution: "kind",
        nodeCount: 1,
        namespaces: [],
        namespacesRestricted: false,
        isAdmin: true,
      },
    },
  });
  await show({ catalog_list: () => [connected] });
  const badge = await screen.findByTestId("catalog-tunnel-id-kind-a");
  expect(badge.textContent).toBe("Tunnel failed");
  expect(badge.getAttribute("title")).toBe('Tunnel "corp": refused');
});
