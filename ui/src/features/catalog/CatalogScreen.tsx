import { FolderPlus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Input,
  Spinner,
  toast,
} from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { CatalogFolder } from "../../ipc/generated/CatalogFolder";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import { useCatalog } from "../../stores/catalog";
import { useFolders } from "../../stores/folders";
import { useShell } from "../../stores/shell";
import { useUiState } from "../../stores/uiState";
import { AddClusterDialog } from "./AddClusterDialog";
import styles from "./CatalogScreen.module.css";
import {
  basename,
  CatalogTree,
  type Renaming,
  type TreeActions,
} from "./CatalogTree";
import { createFolder, deleteFolder, renameFolder } from "./folderActions";
import {
  type DeleteSummary,
  deleteSummary,
  type FolderTree,
  freeName,
  squash,
  treeRows,
} from "./folderTree";

/** The ui-state key of the folders the user closed (P29): new folders start open. */
export const CLOSED_FOLDERS_KEY = "catalog:folders:closed";

const NEW_FOLDER = "New folder";

/** Besides the name and the folder path: the context and the kubeconfig file's name. */
function matchesMore(cluster: ClusterEntry, needle: string): boolean {
  return [cluster.contextName, basename(cluster.source.path)].some((text) =>
    squash(text).includes(needle),
  );
}

export function CatalogScreen() {
  const clusters = useCatalog((s) => s.clusters);
  const warnings = useCatalog((s) => s.warnings);
  const loading = useCatalog((s) => s.loading);
  const error = useCatalog((s) => s.error);
  const reload = useCatalog((s) => s.reload);
  const folders = useFolders((s) => s.folders);
  const placements = useFolders((s) => s.placements);
  const [query, setQuery] = useState("");
  const addClusterOpen = useShell((s) => s.addClusterOpen);
  const closeAddCluster = useShell((s) => s.closeAddCluster);
  const [removing, setRemoving] = useState<ClusterEntry | null>(null);
  const [deleting, setDeleting] = useState<{
    folder: CatalogFolder;
    summary: DeleteSummary;
  } | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [closed, setClosed] = useUiState<string[]>(CLOSED_FOLDERS_KEY, []);

  const tree = useMemo<FolderTree>(
    () => ({ folders, placements }),
    [folders, placements],
  );

  const rows = useMemo(() => {
    const shut = new Set(closed);
    return treeRows(tree, clusters, {
      query,
      open: (id) => !shut.has(id),
      matches: matchesMore,
    });
  }, [tree, clusters, query, closed]);

  function expand(id: string): void {
    if (closed.includes(id)) setClosed(closed.filter((c) => c !== id));
  }

  async function newFolder(parent: string | null): Promise<void> {
    const name = freeName(tree, parent, NEW_FOLDER);
    const folder = await createFolder(parent, name);
    if (folder === null) return;
    if (parent !== null) expand(parent);
    setRenaming({ id: folder.id, value: folder.name, error: null });
  }

  async function saveName(): Promise<void> {
    if (renaming === null) return;
    const folder = folders.find((f) => f.id === renaming.id);
    if (folder === undefined || renaming.value.trim() === folder.name) {
      setRenaming(null);
      return;
    }
    const refused = await renameFolder(renaming.id, renaming.value);
    setRenaming((now) => {
      if (now?.id !== renaming.id) return now;
      return refused === null ? null : { ...now, error: refused };
    });
  }

  const actions: TreeActions = {
    tree,
    toggle: (id) =>
      setClosed(
        closed.includes(id) ? closed.filter((c) => c !== id) : [...closed, id],
      ),
    expand,
    newFolder: (parent) => void newFolder(parent),
    rename: (folder) =>
      setRenaming({ id: folder.id, value: folder.name, error: null }),
    remove: (folder) => {
      const summary = deleteSummary(tree, clusters, folder.id);
      // An empty folder goes without asking (P29).
      if (summary.empty) void deleteFolder(folder.id, folder.name);
      else setDeleting({ folder, summary });
    },
    removeCluster: setRemoving,
    renaming,
    typeName: (value) =>
      setRenaming((now) =>
        now === null ? now : { ...now, value, error: null },
      ),
    saveName: () => void saveName(),
    cancelName: () => setRenaming(null),
  };

  async function remove(cluster: ClusterEntry): Promise<void> {
    setRemoving(null);
    try {
      await api.catalogRemovePasted(cluster.id);
    } catch (failure) {
      toast.error(`Could not remove ${cluster.name}`, failureMessage(failure));
    }
  }

  let body: React.ReactNode;
  if (loading) {
    body = <Spinner />;
  } else if (error) {
    body = (
      <ErrorNotice
        title="The catalog could not be loaded"
        message={error}
        onRetry={() => void reload()}
      />
    );
  } else if (clusters.length === 0 && folders.length === 0) {
    body = (
      <div data-testid="catalog-table">
        <EmptyState
          title="No clusters yet"
          body={
            <>
              SkoposIDE lists every context in the files in <code>~/.kube</code>{" "}
              and in <code>$KUBECONFIG</code>. Add a kubeconfig file there, or
              paste one in.
            </>
          }
        />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div data-testid="catalog-table">
        <EmptyState title={`No clusters match "${query}"`} />
      </div>
    );
  } else {
    body = (
      // The card wraps the table only: the no-match EmptyState is a card of
      // its own, and spec §6.1 allows no raised card inside a raised card.
      <div className={styles.table}>
        <CatalogTree rows={rows} actions={actions} />
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.toolbar}>
        <Input
          aria-label="Search clusters by name or folder path"
          placeholder="Search by name or folder path"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="catalog-search"
        />
        <Button
          size="sm"
          title="A new folder at the top level, ready to name"
          data-testid="catalog-new-folder"
          disabled={loading || error !== null}
          onClick={() => void newFolder(null)}
        >
          <FolderPlus size={14} aria-hidden="true" />
          New folder
        </Button>
      </header>
      {warnings.length > 0 ? (
        <ul className={styles.warnings} data-testid="catalog-warnings">
          {warnings.map((w) => (
            <li key={w.path}>
              <strong>{w.path}</strong>: {w.message}
            </li>
          ))}
        </ul>
      ) : null}
      {body}
      <AddClusterDialog open={addClusterOpen} onClose={closeAddCluster} />
      <ConfirmDialog
        open={removing !== null}
        title="Remove pasted cluster"
        body={
          <>
            Remove <strong>{removing?.name}</strong> from the catalog? The
            pasted kubeconfig is deleted.
          </>
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={
          deleting?.summary.clash
            ? "Cannot delete this folder"
            : "Delete folder"
        }
        body={deleting?.summary.clash ?? deleting?.summary.text}
        confirmLabel="Delete"
        danger
        confirmDisabled={Boolean(deleting?.summary.clash)}
        testId="catalog-folder-delete-dialog"
        onConfirm={() => {
          if (deleting === null || deleting.summary.clash) return;
          setDeleting(null);
          void deleteFolder(deleting.folder.id, deleting.folder.name);
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
