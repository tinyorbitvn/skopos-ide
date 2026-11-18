import { expect, test } from "vitest";
import {
  clusterPath,
  deleteSummary,
  type FolderTree,
  folderCount,
  freeName,
  moveProblem,
  moveTargets,
  placementOf,
  placeName,
  squash,
  type TreeRow,
  treeRows,
} from "./folderTree";

// prod > eu, us; Local; staging (empty). Clusters: two in eu, one in us, two in
// Local, one at the top level and one placed in a folder that is gone.
const TREE: FolderTree = {
  folders: [
    { id: "folder-1", name: "prod", parent: null },
    { id: "folder-2", name: "eu", parent: "folder-1" },
    { id: "folder-3", name: "us", parent: "folder-1" },
    { id: "folder-4", name: "Local", parent: null },
    { id: "folder-5", name: "staging", parent: null },
  ],
  placements: {
    "prod-eu-2": "folder-2",
    "prod-eu-1": "folder-2",
    "prod-us-1": "folder-3",
    "kind-b": "folder-4",
    "kind-a": "folder-4",
    lost: "folder-9",
  },
};

const CLUSTERS = [
  "prod-eu-2",
  "demo",
  "kind-b",
  "prod-us-1",
  "kind-a",
  "prod-eu-1",
  "lost",
].map((id) => ({ id, name: id }));

/** One line per row: two spaces per level, `+`/`-` for a closed/open folder and its count. */
function shape(rows: TreeRow<{ id: string; name: string }>[]): string[] {
  return rows.map((r) =>
    r.kind === "folder"
      ? `${"  ".repeat(r.depth)}${r.open ? "-" : "+"}${r.folder.name} (${r.count})`
      : `${"  ".repeat(r.depth)}${r.cluster.name}`,
  );
}

const allOpen = () => true;

test("folders come first, then clusters, each by name ignoring case (P29)", () => {
  expect(shape(treeRows(TREE, CLUSTERS, { open: allOpen }))).toEqual([
    "-Local (2)",
    "  kind-a",
    "  kind-b",
    "-prod (3)",
    "  -eu (2)",
    "    prod-eu-1",
    "    prod-eu-2",
    "  -us (1)",
    "    prod-us-1",
    "-staging (0)",
    "demo",
    "lost",
  ]);
});

test("a closed folder hides what it holds but still counts it", () => {
  const open = (id: string) => id !== "folder-1";
  expect(shape(treeRows(TREE, CLUSTERS, { open }))).toEqual([
    "-Local (2)",
    "  kind-a",
    "  kind-b",
    "+prod (3)",
    "-staging (0)",
    "demo",
    "lost",
  ]);
});

test("the count includes the clusters of subfolders, and only listed clusters", () => {
  expect(folderCount(TREE, CLUSTERS, "folder-1")).toBe(3);
  expect(folderCount(TREE, CLUSTERS.slice(0, 2), "folder-1")).toBe(1);
  expect(folderCount(TREE, CLUSTERS, "folder-5")).toBe(0);
});

test("a search matches cluster names and folder paths, and opens the folders of each match", () => {
  const closed = () => false;
  expect(
    shape(treeRows(TREE, CLUSTERS, { open: closed, query: "us-1" })),
  ).toEqual(["-prod (3)", "  -us (1)", "    prod-us-1"]);
  // A folder path, with or without spaces around the slash.
  for (const query of ["prod/eu", "Prod / EU", " prod/ eu "]) {
    expect(shape(treeRows(TREE, CLUSTERS, { open: closed, query }))).toEqual([
      "-prod (3)",
      "  -eu (2)",
      "    prod-eu-1",
      "    prod-eu-2",
    ]);
  }
  // A folder's name shows the folder and everything in it, even an empty one.
  expect(
    shape(treeRows(TREE, CLUSTERS, { open: closed, query: "stag" })),
  ).toEqual(["-staging (0)"]);
  expect(
    shape(treeRows(TREE, CLUSTERS, { open: closed, query: "nothing" })),
  ).toEqual([]);
});

test("a search can match more than the name", () => {
  const rows = treeRows(TREE, CLUSTERS, {
    open: allOpen,
    query: "file",
    matches: (c) => c.id === "demo",
  });
  expect(shape(rows)).toEqual(["demo"]);
});

test("paths and places name the folders from the top", () => {
  expect(squash("  Prod /  EU / x ")).toBe("prod/eu/x");
  expect(placementOf(TREE, "prod-eu-1")).toBe("folder-2");
  expect(placementOf(TREE, "lost")).toBeNull();
  expect(placementOf(TREE, "demo")).toBeNull();
  expect(clusterPath(TREE, { id: "prod-eu-1", name: "prod-eu-1" })).toBe(
    "prod / eu / prod-eu-1",
  );
  expect(clusterPath(TREE, { id: "demo", name: "demo" })).toBe("demo");
  expect(placeName(TREE, "folder-2")).toBe("prod / eu");
  expect(placeName(TREE, null)).toBe("Top level");
});

test("a folder cannot move into itself, a descendant, its own place or a clash (P28)", () => {
  const folder = (id: string) => ({ kind: "folder" as const, id });
  expect(moveProblem(TREE, folder("folder-1"), "folder-1")).toBe(
    "A folder cannot go inside itself.",
  );
  expect(moveProblem(TREE, folder("folder-1"), "folder-2")).toBe(
    "A folder cannot go inside itself.",
  );
  expect(moveProblem(TREE, folder("folder-2"), "folder-1")).toBe(
    "Already here",
  );
  expect(moveProblem(TREE, folder("folder-5"), null)).toBe("Already here");
  const clash: FolderTree = {
    ...TREE,
    folders: [...TREE.folders, { id: "folder-6", name: "EU", parent: null }],
  };
  expect(moveProblem(clash, folder("folder-6"), "folder-1")).toBe(
    "EU already exists here.",
  );
  expect(moveProblem(TREE, folder("folder-2"), null)).toBeNull();
  expect(moveProblem(TREE, folder("folder-9"), null)).toBe(
    "That folder no longer exists.",
  );
});

test("a cluster moves anywhere but where it is", () => {
  const cluster = (id: string) => ({ kind: "cluster" as const, id });
  expect(moveProblem(TREE, cluster("kind-a"), "folder-4")).toBe("Already here");
  expect(moveProblem(TREE, cluster("demo"), null)).toBe("Already here");
  expect(moveProblem(TREE, cluster("lost"), null)).toBe("Already here");
  expect(moveProblem(TREE, cluster("demo"), "folder-2")).toBeNull();
  expect(moveProblem(TREE, cluster("kind-a"), null)).toBeNull();
});

test("Move to lists Top level, then every folder but the item and its descendants, by path (P29)", () => {
  const names = (item: Parameters<typeof moveTargets>[1]) =>
    moveTargets(TREE, item).map((t) => [t.label, t.problem]);
  expect(names({ kind: "folder", id: "folder-1" })).toEqual([
    ["Top level", "Already here"],
    ["Local", null],
    ["staging", null],
  ]);
  expect(names({ kind: "cluster", id: "prod-eu-1" })).toEqual([
    ["Top level", null],
    ["Local", null],
    ["prod", null],
    ["prod / eu", "Already here"],
    ["prod / us", null],
    ["staging", null],
  ]);
});

test("the delete dialog counts what moves up and names the place (P29)", () => {
  expect(deleteSummary(TREE, CLUSTERS, "folder-1")).toEqual({
    empty: false,
    text: "Delete prod? Its 2 folders move to Top level.",
    clash: null,
  });
  expect(deleteSummary(TREE, CLUSTERS, "folder-2").text).toBe(
    "Delete eu? Its 2 clusters move to prod.",
  );
  expect(deleteSummary(TREE, CLUSTERS, "folder-3").text).toBe(
    "Delete us? Its 1 cluster moves to prod.",
  );
  expect(deleteSummary(TREE, CLUSTERS, "folder-5")).toEqual({
    empty: true,
    text: "Delete staging? It is empty.",
    clash: null,
  });
  const both: FolderTree = {
    folders: [
      { id: "f1", name: "a", parent: null },
      { id: "f2", name: "b", parent: "f1" },
    ],
    placements: { x: "f1" },
  };
  expect(deleteSummary(both, [{ id: "x", name: "x" }], "f1").text).toBe(
    "Delete a? Its 1 cluster and 1 folder move to Top level.",
  );
});

test("a delete whose subfolder's name the parent has already is refused (P28)", () => {
  const clash: FolderTree = {
    ...TREE,
    folders: [...TREE.folders, { id: "folder-6", name: "Eu", parent: null }],
  };
  expect(deleteSummary(clash, CLUSTERS, "folder-1").clash).toBe(
    "Top level already has a folder named eu. Rename one of them first.",
  );
});

test("a new folder takes the first free name among its siblings", () => {
  expect(freeName(TREE, null, "New folder")).toBe("New folder");
  const taken: FolderTree = {
    ...TREE,
    folders: [
      ...TREE.folders,
      { id: "f7", name: "new folder", parent: null },
      { id: "f8", name: "New folder 2", parent: null },
      { id: "f9", name: "New folder", parent: "folder-1" },
    ],
  };
  expect(freeName(taken, null, "New folder")).toBe("New folder 3");
  expect(freeName(taken, "folder-1", "New folder")).toBe("New folder 2");
});
