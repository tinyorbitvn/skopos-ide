/**
 * The Catalog's folder tree as the core keeps it (spec P26 to P30): the rows of the
 * Catalog and the switcher, folder paths for the palette, and the checks the menus and
 * drags make before they ask the core.
 */
import type { CatalogFolder } from "../../ipc/generated/CatalogFolder";

export interface FolderTree {
  folders: CatalogFolder[];
  /** Cluster id to folder id. */
  placements: { [cluster: string]: string };
}

/** What the tree needs of a cluster. */
export interface TreeCluster {
  id: string;
  name: string;
}

export const TOP_LEVEL = "Top level";
export const ALREADY_HERE = "Already here";
const INSIDE_ITSELF = "A folder cannot go inside itself.";
const GONE = "That folder no longer exists.";

/** Ignoring case, numbers by their value (P29). */
const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

export function byName(a: string, b: string): number {
  return collator.compare(a, b);
}

function folderById(tree: FolderTree, id: string): CatalogFolder | undefined {
  return tree.folders.find((f) => f.id === id);
}

/** The folders right inside `parent` (null: the top level), by name. */
export function subfolders(
  tree: FolderTree,
  parent: string | null,
): CatalogFolder[] {
  return tree.folders
    .filter((f) => f.parent === parent)
    .sort((a, b) => byName(a.name, b.name));
}

/** The folder a cluster sits in; a placement in a folder that is gone counts as none. */
export function placementOf(tree: FolderTree, cluster: string): string | null {
  const id = tree.placements[cluster];
  return id !== undefined && folderById(tree, id) ? id : null;
}

/** Whether folder `id` is `ancestor` or sits somewhere inside it. */
export function isWithin(
  tree: FolderTree,
  id: string | null,
  ancestor: string,
): boolean {
  const seen = new Set<string>();
  let at = id;
  while (at !== null && !seen.has(at)) {
    if (at === ancestor) return true;
    seen.add(at);
    at = folderById(tree, at)?.parent ?? null;
  }
  return false;
}

/** The names from the top level down to folder `id`. */
function folderNames(tree: FolderTree, id: string | null): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let folder = id === null ? undefined : folderById(tree, id);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    names.unshift(folder.name);
    folder =
      folder.parent === null ? undefined : folderById(tree, folder.parent);
  }
  return names;
}

/** A place as menus name it: `prod / eu`, or "Top level". */
export function placeName(tree: FolderTree, id: string | null): string {
  const names = folderNames(tree, id);
  return names.length === 0 ? TOP_LEVEL : names.join(" / ");
}

/** A cluster with its folders before it: `prod / eu / prod-eu-1` (P30). */
export function clusterPath(tree: FolderTree, cluster: TreeCluster): string {
  return [
    ...folderNames(tree, placementOf(tree, cluster.id)),
    cluster.name,
  ].join(" / ");
}

/** Lower case, with no space around a `/`, so `Prod / EU` and `prod/eu` match. */
export function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .trim();
}

/** The listed clusters inside folder `id`, its subfolders included. */
export function folderCount(
  tree: FolderTree,
  clusters: TreeCluster[],
  id: string,
): number {
  return clusters.filter((c) => isWithin(tree, placementOf(tree, c.id), id))
    .length;
}

export type TreeRow<T extends TreeCluster> =
  | {
      kind: "folder";
      folder: CatalogFolder;
      depth: number;
      open: boolean;
      /** The clusters inside it, subfolders included. */
      count: number;
    }
  | { kind: "cluster"; cluster: T; depth: number };

export interface TreeOptions<T extends TreeCluster> {
  /** Whether a folder is open while there is no search. */
  open(id: string): boolean;
  query?: string;
  /** Other text a search matches on a cluster, given the squashed query. */
  matches?(cluster: T, needle: string): boolean;
}

/**
 * The rows of the tree: in each folder its subfolders, then its clusters, each by name
 * (P29). A search keeps the clusters whose name or folder path matches and the folders
 * whose path matches, with the folders above each of them shown and open.
 */
export function treeRows<T extends TreeCluster>(
  tree: FolderTree,
  clusters: T[],
  options: TreeOptions<T>,
): TreeRow<T>[] {
  const needle = squash(options.query ?? "");
  let shownFolders: Set<string> | null = null;
  let shownClusters: Set<string> | null = null;
  if (needle !== "") {
    const folders = new Set<string>();
    const kept = new Set<string>();
    const showUp = (id: string | null) => {
      let at = id;
      while (at !== null && !folders.has(at)) {
        folders.add(at);
        at = folderById(tree, at)?.parent ?? null;
      }
    };
    for (const folder of tree.folders) {
      if (squash(folderNames(tree, folder.id).join("/")).includes(needle)) {
        showUp(folder.id);
      }
    }
    for (const cluster of clusters) {
      const hit =
        squash(cluster.name).includes(needle) ||
        squash(clusterPath(tree, cluster)).includes(needle) ||
        options.matches?.(cluster, needle) === true;
      if (hit) {
        kept.add(cluster.id);
        showUp(placementOf(tree, cluster.id));
      }
    }
    shownFolders = folders;
    shownClusters = kept;
  }

  const byPlace = new Map<string | null, T[]>();
  for (const cluster of clusters) {
    const at = placementOf(tree, cluster.id);
    byPlace.set(at, [...(byPlace.get(at) ?? []), cluster]);
  }
  const rows: TreeRow<T>[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const folder of subfolders(tree, parent)) {
      if (shownFolders !== null && !shownFolders.has(folder.id)) continue;
      const open = shownFolders !== null || options.open(folder.id);
      rows.push({
        kind: "folder",
        folder,
        depth,
        open,
        count: folderCount(tree, clusters, folder.id),
      });
      if (open) walk(folder.id, depth + 1);
    }
    const here = [...(byPlace.get(parent) ?? [])].sort((a, b) =>
      byName(a.name, b.name),
    );
    for (const cluster of here) {
      if (shownClusters === null || shownClusters.has(cluster.id)) {
        rows.push({ kind: "cluster", cluster, depth });
      }
    }
  };
  walk(null, 0);
  return rows;
}

/** A folder or a cluster that a menu or a drag moves. */
export type MoveItem = { kind: "folder" | "cluster"; id: string };

/**
 * Why `item` cannot go into `target` (null: the top level), with the core's words
 * where it has them (P27, P28), or null when it can.
 */
export function moveProblem(
  tree: FolderTree,
  item: MoveItem,
  target: string | null,
): string | null {
  if (target !== null && !folderById(tree, target)) return GONE;
  if (item.kind === "cluster") {
    return placementOf(tree, item.id) === target ? ALREADY_HERE : null;
  }
  const folder = folderById(tree, item.id);
  if (!folder) return GONE;
  if (target !== null && isWithin(tree, target, folder.id)) {
    return INSIDE_ITSELF;
  }
  if (folder.parent === target) return ALREADY_HERE;
  const lower = folder.name.toLowerCase();
  const clash = tree.folders.some(
    (f) =>
      f.parent === target &&
      f.id !== folder.id &&
      f.name.toLowerCase() === lower,
  );
  return clash ? `${folder.name} already exists here.` : null;
}

export interface MoveTarget {
  /** Null: the top level. */
  id: string | null;
  label: string;
  problem: string | null;
}

/**
 * The places of "Move to ▸" (P29): the top level, then every folder by path, except a
 * moving folder itself and the folders inside it.
 */
export function moveTargets(tree: FolderTree, item: MoveItem): MoveTarget[] {
  const folders = tree.folders
    .filter((f) => item.kind === "cluster" || !isWithin(tree, f.id, item.id))
    .map((f) => ({ id: f.id, label: placeName(tree, f.id) }))
    .sort((a, b) => byName(a.label, b.label));
  return [{ id: null, label: TOP_LEVEL }, ...folders].map((t) => ({
    ...t,
    problem: moveProblem(tree, item, t.id),
  }));
}

function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface DeleteSummary {
  /** No cluster and no folder inside: it goes without a dialog. */
  empty: boolean;
  /** The dialog's question (P29). */
  text: string;
  /** Why the core will refuse it (P28), or null. */
  clash: string | null;
}

/** What deleting folder `id` moves up, and where to. */
export function deleteSummary(
  tree: FolderTree,
  clusters: TreeCluster[],
  id: string,
): DeleteSummary {
  const folder = folderById(tree, id);
  if (!folder) return { empty: true, text: "", clash: null };
  const inside = clusters.filter((c) => placementOf(tree, c.id) === id).length;
  const children = subfolders(tree, id);
  const parent =
    folder.parent === null
      ? TOP_LEVEL
      : (folderById(tree, folder.parent)?.name ?? TOP_LEVEL);
  const parts = [
    inside > 0 ? counted(inside, "cluster") : "",
    children.length > 0 ? counted(children.length, "folder") : "",
  ].filter((p) => p !== "");
  const verb = inside + children.length === 1 ? "moves" : "move";
  const text =
    parts.length === 0
      ? `Delete ${folder.name}? It is empty.`
      : `Delete ${folder.name}? Its ${parts.join(" and ")} ${verb} to ${parent}.`;
  const siblings = tree.folders.filter(
    (f) => f.parent === folder.parent && f.id !== id,
  );
  const blocked = children.find((child) =>
    siblings.some((s) => s.name.toLowerCase() === child.name.toLowerCase()),
  );
  return {
    empty: parts.length === 0,
    text,
    clash: blocked
      ? `${parent} already has a folder named ${blocked.name}. Rename one of them first.`
      : null,
  };
}
