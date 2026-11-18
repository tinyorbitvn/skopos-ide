import { toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { CatalogFolder } from "../../ipc/generated/CatalogFolder";
import { useFolders } from "../../stores/folders";
import type { MoveItem } from "./folderTree";

/**
 * The folder changes the Catalog makes (spec P28). Each asks the core, then reads the
 * tree again at once rather than wait for the change event every window gets. A
 * refusal shows where it happens: the rename's under the name (its caller), the
 * others in a toast (P44).
 */
function reread(): void {
  void useFolders.getState().reload();
}

/** A new folder named `name` in `parent` (null: the top level), or null when refused. */
export async function createFolder(
  parent: string | null,
  name: string,
): Promise<CatalogFolder | null> {
  try {
    const folder = await api.catalogFolderCreate(parent, name);
    reread();
    return folder;
  } catch (error) {
    toast.error("Could not add a folder", failureMessage(error));
    return null;
  }
}

/** Null when renamed, else why not (P27), for the line under the name. */
export async function renameFolder(
  id: string,
  name: string,
): Promise<string | null> {
  try {
    await api.catalogFolderRename(id, name);
    reread();
    return null;
  } catch (error) {
    return failureMessage(error);
  }
}

/** Moves a folder or places a cluster in `target` (null: the top level); true when done. */
export async function moveItem(
  item: MoveItem,
  target: string | null,
  name: string,
): Promise<boolean> {
  try {
    if (item.kind === "folder") await api.catalogFolderMove(item.id, target);
    else await api.catalogClusterPlace(item.id, target);
    reread();
    return true;
  } catch (error) {
    toast.error(`Could not move ${name}`, failureMessage(error));
    return false;
  }
}

/** Its clusters and subfolders move to its parent (P28). */
export async function deleteFolder(id: string, name: string): Promise<void> {
  try {
    await api.catalogFolderDelete(id);
    reread();
  } catch (error) {
    toast.error(`Could not delete ${name}`, failureMessage(error));
  }
}
