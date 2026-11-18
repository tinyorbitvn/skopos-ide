import { beforeEach, expect, test } from "vitest";
import type { CatalogFolders } from "../ipc/generated/CatalogFolders";
import { emitEvent, flush, mockBackend } from "../test/ipc";
import { resetFoldersForTest, useFolders } from "./folders";

const TREE: CatalogFolders = {
  folders: [{ id: "folder-1", name: "prod", parent: null }],
  placements: { "id-alpha": "folder-1" },
};

beforeEach(() => {
  resetFoldersForTest();
});

test("init reads the folder tree once", async () => {
  const backend = mockBackend({ catalog_folders: () => TREE });
  expect(useFolders.getState().loaded).toBe(false);

  await Promise.all([
    useFolders.getState().init(),
    useFolders.getState().init(),
  ]);

  const state = useFolders.getState();
  expect(state.loaded).toBe(true);
  expect(state.folders).toEqual(TREE.folders);
  expect(state.placements).toEqual(TREE.placements);
  expect(backend.callsTo("catalog_folders")).toHaveLength(1);
});

test("a change in any window reads the tree again", async () => {
  let tree: CatalogFolders = { folders: [], placements: {} };
  const backend = mockBackend({ catalog_folders: () => tree });
  await useFolders.getState().init();
  expect(useFolders.getState().folders).toEqual([]);

  tree = TREE;
  await emitEvent("catalog://folders-changed");

  expect(useFolders.getState().folders).toEqual(TREE.folders);
  expect(backend.callsTo("catalog_folders")).toHaveLength(2);
});

test("a tree that cannot be read leaves every cluster at the top level", async () => {
  mockBackend({
    catalog_folders: () => {
      throw new Error("no");
    },
  });

  await useFolders.getState().init();
  await flush();

  const state = useFolders.getState();
  expect(state.loaded).toBe(true);
  expect(state.folders).toEqual([]);
  expect(state.placements).toEqual({});
});

test("the last read wins", async () => {
  const answers: ((tree: CatalogFolders) => void)[] = [];
  mockBackend({
    catalog_folders: () =>
      new Promise<CatalogFolders>((resolve) => answers.push(resolve)),
  });
  const first = useFolders.getState().init();
  await flush();
  const second = useFolders.getState().reload();
  await flush();

  answers[1]?.(TREE);
  await second;
  answers[0]?.({ folders: [], placements: {} });
  await first;

  expect(useFolders.getState().folders).toEqual(TREE.folders);
});
