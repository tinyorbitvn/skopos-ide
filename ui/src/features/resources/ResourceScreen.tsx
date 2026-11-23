import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  CheckMenu,
  EmptyState,
  ErrorNotice,
  Spinner,
  type TableColumn,
  type TableSort,
  useNowWhile,
  VirtualTable,
} from "../../design";
import { Columns3 } from "../../design/icons";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { groupFromSegment } from "../../kinds/nav";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { kindSpec } from "../../kinds/registry";
import { useClusterNamespaces } from "../../stores/clusters";
import { findResource } from "../../stores/resources";
import { useColumnWidths, useUiState } from "../../stores/uiState";
import { useClusterContext } from "../cluster/ClusterLayout";
import { DetailDrawer, isDrawerEscape } from "../details/DetailDrawer";
import { drawerTabOf } from "../details/drawerHistory";
import { useDrawerHistory } from "../details/useDrawerHistory";
import { useListUsage } from "../metrics/useListUsage";
import { useNodesDisk } from "../metrics/useNodesDisk";
import { filterColumns } from "./columnFilter";
import { DeleteDialog } from "./DeleteDialog";
import { cutText, FilterTokens } from "./FilterTokens";
import {
  buildFilterIndex,
  chipText,
  type FilterJoin,
  filterContext,
  type MatchChip,
  matchChips,
  type ObjectFilter,
  passes,
  typedFilter,
} from "./filter";
import { kindColumns, useCustomResourceDefinition } from "./kindColumns";
import { NamespaceFilter, namespaceFilterKey } from "./NamespaceFilter";
import { ObjectActionBar } from "./ObjectActionBar";
import { objectActions } from "./objectActions";
import { PropertyFilter } from "./PropertyFilter";
import { RowActions, useActionContext } from "./ResourceActions";
import styles from "./ResourceScreen.module.css";
import { useOwnedPods } from "./useOwnedPods";
import { useTableList } from "./useTableList";

const ACTIONS_COLUMN = "actions";
/** Always shown, so a row can always be told apart. */
const FIXED_COLUMNS: ReadonlySet<string> = new Set(["name", ACTIONS_COLUMN]);

/** A choice made in the columns menu, which wins over the column's default. */
type ColumnChoices = Record<string, "shown" | "hidden">;

function isHiddenBy(choices: ColumnChoices, c: TableColumn<KubeObject>) {
  return choices[c.id] ? choices[c.id] === "hidden" : Boolean(c.defaultHidden);
}

/** The same empty list on every render, so what is memoised on the namespaces holds. */
const NO_NAMESPACES: string[] = [];
/** What the suggestions read while they are closed. */
const NO_INDEX = buildFilterIndex([]);

function rowTestId(o: KubeObject): string {
  const { namespace, name } = o.metadata;
  return namespace
    ? `resource-row-${namespace}-${name}`
    : `resource-row-${name}`;
}

function emptyText(kind: string, namespaced: boolean, namespaces: string[]) {
  if (!namespaced) return `This cluster has no ${kind} objects.`;
  if (namespaces.length === 0)
    return `There are no ${kind} objects in any namespace.`;
  const names = namespaces.join(", ");
  return `There are no ${kind} objects in namespace${namespaces.length > 1 ? "s" : ""} ${names}.`;
}

/** The table of one resource type. Give it a `key` so another type starts afresh. */
export function ResourceScreen(props: {
  clusterId: string;
  info: ApiResourceInfo;
  resources: ApiResourceInfo[];
}) {
  const { clusterId, info, resources } = props;
  const { resource, canDelete } = info;
  const { kind, namespaced } = resource;

  const [savedNamespaces, setNamespaces, namespacesRead] = useUiState<string[]>(
    namespaceFilterKey(clusterId),
    [],
  );
  const namespaces = namespaced ? savedNamespaces : NO_NAMESPACES;
  const listReady = !namespaced || namespacesRead;
  const list = useTableList(clusterId, resource, namespaces, listReady);
  const crd = useCustomResourceDefinition(clusterId, info, resources);
  const { context, confirmDialog } = useActionContext(clusterId, resource);

  const [params, setParams] = useSearchParams();
  const openKey = params.get("object");
  // Open as drawer asks for the dock tab's drawer tab in the router state (spec K16).
  const location = useLocation();
  const history = useDrawerHistory(
    resource,
    openKey,
    drawerTabOf(location.state),
  );
  const screenRef = useRef<HTMLDivElement>(null);
  const lastRoot = useRef<string | null>(null);
  useEffect(() => {
    if (openKey !== null) lastRoot.current = openKey;
  }, [openKey]);
  const drawerOpen = openKey !== null;
  // On close, the root's row if it is still rendered, else the grid (spec H20).
  const fallbackFocus = () => {
    const root = screenRef.current;
    if (!root) return null;
    const key = lastRoot.current;
    if (key !== null) {
      const slash = key.indexOf("/");
      const id = rowTestId({
        metadata: {
          namespace: key.slice(0, slash) || undefined,
          name: key.slice(slash + 1),
        },
      });
      // Compared as a string, so a name needs no CSS escaping.
      const row = [
        ...root.querySelectorAll<HTMLElement>('[data-testid^="resource-row-"]'),
      ].find((el) => el.dataset.testid === id);
      if (row) return row;
    }
    return root.querySelector<HTMLElement>('[role="grid"]');
  };
  const shownTarget = history.shown?.target;
  // The active row is the shown object's, while it belongs to this list (spec H18).
  const activeKey =
    shownTarget &&
    shownTarget.group === resource.group &&
    shownTarget.plural === resource.plural
      ? `${shownTarget.namespace ?? ""}/${shownTarget.name}`
      : undefined;
  // The filter starts empty for each list and stays while the drawer opens (spec M22).
  const [search, setSearch] = useState("");
  const [tokens, setTokens] = useState<ObjectFilter[]>([]);
  const [join, setJoin] = useState<FilterJoin>("and");
  const filterBox = useRef<HTMLInputElement>(null);
  // Kept here because the table unmounts while no row matches.
  const [sort, setSort] = useState<TableSort | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<KubeObject[] | null>(null);
  const [choices, setChoices] = useUiState<ColumnChoices>(
    `columns:${resource.group}/${resource.plural}`,
    {},
  );
  // Kept per kind, as the column choices are, so each list keeps the widths it was given.
  const widths = useColumnWidths(`${resource.group}/${resource.plural}`);
  // The list holds only the chosen namespaces, so the choices are the cluster's own,
  // and those of the rows for a cluster whose namespaces could not be listed.
  const clusterNamespaces = useClusterNamespaces(clusterId);
  const allNamespaces = useMemo(() => {
    const found = new Set<string>(clusterNamespaces);
    for (const o of list.items) {
      if (o.metadata.namespace) found.add(o.metadata.namespace);
    }
    return [...found];
  }, [clusterNamespaces, list.items]);

  const namespaceRows = useMemo(() => {
    const allowed = new Set(namespaces);
    return list.items.filter(
      (o) => allowed.size === 0 || allowed.has(o.metadata.namespace ?? ""),
    );
  }, [list.items, namespaces]);
  const [suggesting, setSuggesting] = useState(false);

  // CPU and Memory for Pods and Nodes, and Disk for Nodes; undefined for every other kind.
  const metricsUsage = useListUsage(clusterId, resource, namespaces);
  const isNodes = resource.group === "" && resource.plural === "nodes";
  const nodeNames = useMemo(
    () => (isNodes ? list.items.map((o) => o.metadata.name).sort() : null),
    [isNodes, list.items],
  );
  const disk = useNodesDisk(clusterId, nodeNames);
  const usage = useMemo(
    () => (metricsUsage && disk ? { ...metricsUsage, disk } : metricsUsage),
    [metricsUsage, disk],
  );
  // Each workload's Pods, for the workload kinds' Status (spec N3); undefined otherwise.
  const owned = useOwnedPods(
    clusterId,
    listReady ? info : undefined,
    namespaces,
  );
  const columns = useMemo<TableColumn<KubeObject>[]>(() => {
    const actions = kindSpec(resource.group, resource.plural)?.actions ?? [];
    return [
      ...kindColumns(info, crd, usage, owned),
      {
        id: ACTIONS_COLUMN,
        header: "Actions",
        width: 72,
        stickyEnd: true,
        render: (o) => (
          <RowActions
            object={o}
            actions={actions}
            context={context}
            info={info}
            onDelete={(object) => setDeleting([object])}
          />
        ),
      },
    ];
  }, [info, crd, resource, context, usage, owned]);

  const kindActions = kindSpec(resource.group, resource.plural)?.actions ?? [];
  const KindDeleteDialog =
    kindSpec(resource.group, resource.plural)?.deleteDialog ?? DeleteDialog;

  const isHidden = (c: TableColumn<KubeObject>) => isHiddenBy(choices, c);
  // The same list while nothing it reads changes, so the table keeps its columns.
  const hiddenColumns = useMemo(
    () => columns.filter((c) => isHiddenBy(choices, c)).map((c) => c.id),
    [columns, choices],
  );

  // Every column a filter can read, with its key (column filter spec §3.1).
  const filterCols = useMemo(
    () => filterColumns(columns, hiddenColumns),
    [columns, hiddenColumns],
  );
  // While a filter is set, the rows follow the 30 s clock, so ages stay true (spec §3.7).
  const filtering = tokens.length > 0 || search.trim() !== "";
  const now = useNowWhile(filtering);
  const filterCtx = useMemo(
    () => filterContext(filterCols, now),
    [filterCols, now],
  );
  // The suggestions read the objects after the namespace filter (spec M17). They show
  // only while the box has focus, so the index is counted only then: on a large list each
  // watch batch would otherwise count every label and annotation again for nothing.
  const filterIndex = useMemo(
    () => (suggesting ? buildFilterIndex(namespaceRows, filterCtx) : NO_INDEX),
    [suggesting, namespaceRows, filterCtx],
  );
  const typed = useMemo(
    () => typedFilter(search, filterCtx),
    [search, filterCtx],
  );
  const rows = useMemo(
    () =>
      namespaceRows.filter((o) => passes(o, tokens, join, typed, filterCtx)),
    [namespaceRows, tokens, join, typed, filterCtx],
  );

  // The table's Name column shows the match chips; the drawer's Summary gets `columns`.
  const tableColumns = useMemo(() => {
    const filters = typed === null ? tokens : [...tokens, typed];
    if (filters.length === 0) return columns;
    return columns.map((c) =>
      c.id === "name"
        ? {
            ...c,
            render: (o: KubeObject) => (
              <span className={styles.nameCell}>
                <span className={styles.nameText}>{c.render(o)}</span>
                <MatchChips chips={matchChips(o, filters, filterCtx)} />
              </span>
            ),
          }
        : c,
    );
  }, [columns, tokens, typed, filterCtx]);

  // Only what is on screen is deleted, so a search cannot hide part of a bulk delete.
  const selectedRows = rows.filter((o) => selected.has(objectKey(o)));

  const openObject = (key: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (key === null) next.delete("object");
        else next.set("object", key);
        return next;
      },
      { replace: false },
    );

  if (list.status === "notServed" || list.status === "forbidden") {
    return (
      <div className={styles.screen}>
        <h2 className={styles.title} data-testid="resource-title">
          {kind}
        </h2>
        <div data-testid="resource-status">
          {list.status === "forbidden" ? (
            <ErrorNotice
              title={`No access to ${kind} objects`}
              message={
                list.message ?? "You do not have permission to list these."
              }
            />
          ) : (
            <ErrorNotice
              title={`${kind} objects are not available`}
              message={
                list.message ??
                "The cluster no longer serves this resource type."
              }
            />
          )}
        </div>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the root only listens for the Escape that closes the drawer (spec H19) and for the filter box's focus.
    <div
      ref={screenRef}
      className={styles.screen}
      data-testid="resource-screen"
      onKeyDown={(e) => {
        if (!isDrawerEscape(e)) return;
        e.stopPropagation();
        openObject(null);
      }}
      // The filter box opens its suggestions on focus or typing and closes them on blur.
      onFocus={(e) => {
        if (e.target === filterBox.current) setSuggesting(true);
      }}
      onChange={(e) => {
        if (e.target === filterBox.current) setSuggesting(true);
      }}
      onBlur={(e) => {
        if (e.target === filterBox.current) setSuggesting(false);
      }}
    >
      <div className={styles.toolbar}>
        <h2 className={styles.title} data-testid="resource-title">
          {kind}
        </h2>
        <PropertyFilter
          text={search}
          onTextChange={setSearch}
          tokens={tokens}
          onTokensChange={setTokens}
          index={filterIndex}
          context={filterCtx}
          inputRef={filterBox}
        />
        {namespaced ? (
          <NamespaceFilter
            namespaces={allNamespaces}
            selected={namespaces}
            onChange={setNamespaces}
          />
        ) : null}
        <CheckMenu
          trigger={
            <Button size="sm" aria-haspopup="menu" data-testid="columns-menu">
              <Columns3 size={14} aria-hidden="true" />
              Columns
            </Button>
          }
          items={columns
            .filter((c) => !FIXED_COLUMNS.has(c.id))
            .map((c) => ({
              id: c.id,
              label: c.header,
              checked: !isHidden(c),
              testId: `column-option-${c.id}`,
              onToggle: () =>
                setChoices({
                  ...choices,
                  [c.id]: isHidden(c) ? "shown" : "hidden",
                }),
            }))}
        />
        {list.status === "reconnecting" ? (
          <span
            className={styles.status}
            title={list.message ?? undefined}
            role="status"
            data-testid="resource-status"
          >
            <Badge tone="warn">Reconnecting</Badge>
          </span>
        ) : null}
        <div className={styles.grow} />
        <Button
          size="sm"
          variant="danger"
          disabled={!canDelete || selectedRows.length === 0}
          title={canDelete ? undefined : "You may not delete these objects."}
          onClick={() => setDeleting(selectedRows)}
          inert={drawerOpen}
          data-testid="bulk-delete"
        >
          Delete{selectedRows.length > 0 ? ` (${selectedRows.length})` : ""}
        </Button>
      </div>
      <FilterTokens
        tokens={tokens}
        onTokensChange={setTokens}
        join={join}
        onJoinChange={setJoin}
        onClear={() => {
          setTokens([]);
          setSearch("");
        }}
        shown={rows.length}
        total={namespaceRows.length}
        onFocusBox={() => filterBox.current?.focus()}
        context={filterCtx}
      />

      <div className={styles.body}>
        <div className={styles.main}>
          {list.loading ? (
            <Spinner label={`Loading ${kind} objects`} />
          ) : rows.length === 0 ? (
            <EmptyState
              title={`No ${kind} objects`}
              body={
                namespaceRows.length > 0
                  ? `No ${kind} objects match the filters.`
                  : emptyText(kind, namespaced, namespaces)
              }
            />
          ) : (
            <VirtualTable
              rows={rows}
              columns={tableColumns}
              rowKey={objectKey}
              rowTestId={rowTestId}
              rowCreated={(o) => o.metadata.creationTimestamp}
              rowLabel={(o) =>
                o.metadata.namespace
                  ? `${o.metadata.namespace}/${o.metadata.name}`
                  : o.metadata.name
              }
              hiddenColumns={hiddenColumns}
              {...widths}
              sort={sort}
              onSortChange={setSort}
              selected={selected}
              onSelectedChange={setSelected}
              testId="resource-table"
              onRowClick={(o) => {
                const key = objectKey(o);
                // The root's own row shows the root again (spec H18).
                if (key === openKey) history.reset();
                else openObject(key);
              }}
              activeKey={activeKey}
              endInert={drawerOpen}
            />
          )}
        </div>
      </div>
      <DetailDrawer
        fallbackFocus={fallbackFocus}
        clusterId={clusterId}
        resource={resource}
        history={history}
        onClose={() => openObject(null)}
        resources={resources}
        columns={columns}
        actions={(object) => (
          <ObjectActionBar
            items={objectActions({
              object,
              kindActions,
              info,
              context,
              onDelete: (o) => setDeleting([o]),
            })}
          />
        )}
      />

      {deleting ? (
        <KindDeleteDialog
          clusterId={clusterId}
          resource={resource}
          objects={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={(keys) => {
            setDeleting(null);
            const gone = new Set(keys);
            setSelected((s) => new Set([...s].filter((k) => !gone.has(k))));
          }}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}

/** The route of one resource list in a connected cluster. */
export function ResourceRoute() {
  const { group = "", plural = "" } = useParams();
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const info = findResource(resources, groupFromSegment(group), plural);
  if (info) {
    return (
      <ResourceScreen
        key={`${clusterId}/${group}/${plural}`}
        clusterId={clusterId}
        info={info}
        resources={resources}
      />
    );
  }
  if (resourcesLoading) return <Spinner label="Loading resources" />;
  return (
    <div className={styles.screen} data-testid="resource-status">
      {resourcesError ? (
        <ErrorNotice
          title="Could not load resources"
          message={resourcesError}
        />
      ) : (
        <EmptyState
          title="Resource not available"
          body="This cluster does not serve this resource."
        />
      )}
    </div>
  );
}

/** A chip shows this many characters of `‹key›=‹value›`, then an ellipsis (spec M20). */
const CHIP_CHARS = 44;

/** The first two match chips of a row, then `+‹n›` for the rest (spec M20). */
function MatchChips({ chips }: { chips: MatchChip[] }) {
  if (chips.length === 0) return null;
  const whole = (c: MatchChip) => `${c.kind} ${chipText(c)}`;
  const rest = chips.slice(2);
  return (
    <>
      {chips.slice(0, 2).map((c) => (
        <span
          key={whole(c)}
          className={styles.chip}
          title={whole(c)}
          data-testid="filter-chip"
        >
          <span className={styles.chipKind}>{c.kind}</span>
          <span className={styles.chipText}>
            {cutText(chipText(c), CHIP_CHARS)}
          </span>
        </span>
      ))}
      {rest.length > 0 ? (
        <span
          className={styles.more}
          title={rest.map(whole).join(", ")}
          data-testid="filter-chip-more"
        >
          +{rest.length}
        </span>
      ) : null}
    </>
  );
}
