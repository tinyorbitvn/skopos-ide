import { create } from "zustand";
import { api } from "../ipc/api";
import { events } from "../ipc/events";
import type { CatalogFolder } from "../ipc/generated/CatalogFolder";

export interface FoldersState {
  folders: CatalogFolder[];
  /** Cluster id to folder id; a cluster without one is at the top level (P26). */
  placements: { [cluster: string]: string };
  /** True once the tree was read, or found unreadable. */
  loaded: boolean;
  /** Reads the tree and follows its changes, once per page. */
  init(): Promise<void>;
  /** Reads the tree again. */
  reload(): Promise<void>;
}

const EMPTY = {
  folders: [],
  placements: {},
  loaded: false,
} satisfies Partial<FoldersState>;

let started: Promise<void> | null = null;
// The last read wins: a change event can start a read while another is on its way.
let readSeq = 0;

/**
 * The Catalog's folder tree, as the core keeps it (spec P26). Every window reads it
 * again when any window changes it (`catalog://folders-changed`, P28). A tree that
 * cannot be read leaves every cluster at the top level; the core reports its own
 * file problems.
 */
export const useFolders = create<FoldersState>()((set) => {
  async function read(): Promise<void> {
    const seq = ++readSeq;
    try {
      const tree = await api.catalogFolders();
      if (seq === readSeq) {
        set({
          folders: tree.folders,
          placements: tree.placements,
          loaded: true,
        });
      }
    } catch {
      if (seq === readSeq) set({ loaded: true });
    }
  }

  return {
    ...EMPTY,
    init() {
      started ??= events
        .onCatalogFoldersChanged(() => void read())
        .then(read, read);
      return started;
    },
    reload: read,
  };
});

/** Puts the store back to its first-run state, for a test with a fresh backend. */
export function resetFoldersForTest(): void {
  started = null;
  readSeq = 0;
  useFolders.setState(EMPTY);
}
