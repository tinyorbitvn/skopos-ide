import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge, ErrorNotice, Input, Spinner } from "../../design";
import { ChevronRight } from "../../design/icons";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { KindSchema } from "../../ipc/generated/KindSchema";
import styles from "./ApiDocsPanel.module.css";
import { useKindSchema } from "./apiDocsCache";
import type { ApiDocsTarget } from "./apiDocsKind";
import {
  type FieldNode,
  type FieldSearch,
  fieldsLabel,
  indexFields,
  searchFields,
  type TreeRow,
  treeKey,
  visibleRows,
  withPath,
} from "./fieldRows";

/** Each row is one line; the virtualiser places rows by this height. */
const ROW_HEIGHT = 26;
const OVERSCAN = 12;
/** How far each level of the tree is indented, in px. */
const INDENT = 14;

/** The API docs of the kind a YAML tab holds, beside its editor (spec L18 to L26). */
export function ApiDocsPanel(props: {
  clusterId: string;
  target: ApiDocsTarget | null;
}) {
  // Kept above the kind's own view, so another kind keeps it (spec L26).
  const [query, setQuery] = useState("");
  return (
    <aside
      aria-label="API docs"
      data-testid="api-docs"
      className={styles.panel}
    >
      <PanelBody
        clusterId={props.clusterId}
        target={props.target}
        query={query}
        onQuery={setQuery}
      />
    </aside>
  );
}

/** One of the states of L25, or the kind's docs. */
function PanelBody(props: {
  clusterId: string;
  target: ApiDocsTarget | null;
  query: string;
  onQuery(query: string): void;
}) {
  const [state, retry] = useKindSchema(props.clusterId, props.target);
  if (state === null) {
    return (
      <p className={styles.state} data-testid="api-docs-no-kind">
        Add apiVersion and kind to see their fields.
      </p>
    );
  }
  if (state.status === "loading") {
    return (
      <div className={styles.state} data-testid="api-docs-loading">
        <Spinner label="Loading API docs" />
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div className={styles.error} data-testid="api-docs-error">
        <ErrorNotice
          title="API docs are not available"
          message={failureMessage(state.error)}
          details={
            state.error instanceof IpcFailure ? state.error.details : undefined
          }
          onRetry={retry}
        />
      </div>
    );
  }
  return (
    <FieldBrowser
      key={JSON.stringify([state.schema.apiVersion, state.schema.kind])}
      schema={state.schema}
      query={props.query}
      onQuery={props.onQuery}
    />
  );
}

/** One kind's header, search, field tree and details (spec L19 to L24). */
function FieldBrowser(props: {
  schema: KindSchema;
  query: string;
  onQuery(query: string): void;
}) {
  const { schema, query } = props;
  const index = useMemo(() => indexFields(schema.fields), [schema]);
  const byPath = useMemo(
    () => new Map(index.all.map((node) => [node.path, node])),
    [index],
  );
  const search = useMemo(() => searchFields(index, query), [index, query]);
  // What the user opened with no search; a search leaves it for when it is cleared (L20).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // What is open during a search: the search's ancestors, then what the user changes.
  const [searchExpanded, setSearchExpanded] = useState<{
    search: FieldSearch;
    expanded: ReadonlySet<string>;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // The row a key moved to, focused once it is drawn.
  const focusAfter = useRef<string | null>(null);

  let open: ReadonlySet<string> = expanded;
  if (search) {
    open =
      searchExpanded?.search === search
        ? searchExpanded.expanded
        : search.expanded;
  }
  const rows = useMemo(
    () => visibleRows(index, open, search),
    [index, open, search],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  // One tab stop: the selected row when it shows, else the first (L23).
  const tabStop =
    selected !== null && rows.some((row) => row.node.path === selected)
      ? selected
      : (rows[0]?.node.path ?? null);

  useEffect(() => {
    const path = focusAfter.current;
    if (path === null) return;
    const drawn = Array.from(
      scroller.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [],
    ).find((row) => row.dataset.path === path);
    if (drawn) {
      focusAfter.current = null;
      drawn.focus();
      return;
    }
    const at = rows.findIndex((row) => row.node.path === path);
    if (at < 0) focusAfter.current = null;
    else virtualizer.scrollToIndex(at);
  });

  function setOpen(next: ReadonlySet<string>): void {
    if (search) setSearchExpanded({ search, expanded: next });
    else setExpanded(next);
  }

  function toggle(path: string): void {
    setOpen(withPath(open, path, !open.has(path)));
  }

  function onKey(path: string, event: KeyboardEvent<HTMLDivElement>): void {
    const next = treeKey(event.key, rows, path, open);
    if (!next) return;
    event.preventDefault();
    if (next.expanded !== open) setOpen(next.expanded);
    setSelected(next.focus);
    if (next.focus !== path) focusAfter.current = next.focus;
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.title}>
          <h2 className={styles.kind} data-testid="api-docs-kind">
            {schema.kind}
          </h2>
          <span className={styles.version} data-testid="api-docs-version">
            <Badge tone="neutral">{schema.apiVersion}</Badge>
          </span>
        </div>
        {schema.description ? (
          <p
            className={styles.kindDescription}
            title={schema.description}
            data-testid="api-docs-kind-description"
          >
            {schema.description}
          </p>
        ) : null}
        {schema.truncated ? (
          <p className={styles.muted} data-testid="api-docs-truncated">
            Only the first 20,000 fields are shown.
          </p>
        ) : null}
      </header>
      <div className={styles.search}>
        <div className={styles.searchField}>
          <Input
            type="search"
            aria-label="Search fields"
            placeholder="Search fields"
            value={query}
            onChange={(event) => props.onQuery(event.target.value)}
            data-testid="api-docs-search"
          />
        </div>
        <span role="status" className={styles.hits} data-testid="api-docs-hits">
          {fieldsLabel(search ? search.matches.size : index.all.length)}
        </span>
      </div>
      {search && search.matches.size === 0 ? (
        <p className={styles.empty} data-testid="api-docs-empty">
          {`No field is named like "${query.trim()}".`}
        </p>
      ) : (
        <div ref={scroller} className={styles.scroller}>
          <div
            role="tree"
            aria-label={`${schema.kind} fields`}
            data-testid="api-docs-tree"
            className={styles.tree}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <FieldRow
                  key={row.node.path}
                  row={row}
                  start={item.start}
                  selected={row.node.path === selected}
                  tabStop={row.node.path === tabStop}
                  onSelect={setSelected}
                  onToggle={toggle}
                  onKey={onKey}
                />
              );
            })}
          </div>
        </div>
      )}
      <FieldDetails
        node={selected === null ? undefined : byPath.get(selected)}
        schema={schema}
      />
    </>
  );
}

/** One `treeitem` (spec L21). Click selects; the chevron opens and closes. */
function FieldRow(props: {
  row: TreeRow;
  start: number;
  selected: boolean;
  tabStop: boolean;
  onSelect(path: string): void;
  onToggle(path: string): void;
  onKey(path: string, event: KeyboardEvent<HTMLDivElement>): void;
}) {
  const { node, expandable, expanded } = props.row;
  const { field, path } = node;
  return (
    <div
      role="treeitem"
      aria-level={node.level}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={props.selected}
      tabIndex={props.tabStop ? 0 : -1}
      data-path={path}
      data-testid={`api-docs-field-${path}`}
      className={
        props.selected ? `${styles.row} ${styles.selected}` : styles.row
      }
      style={{
        height: ROW_HEIGHT,
        paddingLeft: `calc(var(--space-3) + ${(node.level - 1) * INDENT}px)`,
        transform: `translateY(${props.start}px)`,
      }}
      onClick={() => props.onSelect(path)}
      onKeyDown={(event) => props.onKey(path, event)}
    >
      {expandable ? (
        <button
          type="button"
          tabIndex={-1}
          className={
            expanded ? `${styles.chevron} ${styles.open}` : styles.chevron
          }
          aria-label={`${expanded ? "Collapse" : "Expand"} ${field.name}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle(path);
          }}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      ) : (
        <span className={styles.spacer} />
      )}
      <span className={styles.name}>{field.name}</span>
      {field.required ? (
        <span className={styles.required} title="Required">
          *
        </span>
      ) : null}
      <span className={styles.type}>
        {field.recursive ? `${field.typeLabel} (recursive)` : field.typeLabel}
      </span>
    </div>
  );
}

/** The selected field, or the kind when none is (spec L24). */
function FieldDetails(props: {
  node: FieldNode | undefined;
  schema: KindSchema;
}) {
  const { node } = props;
  if (!node) {
    return (
      <section
        aria-label="Field details"
        className={styles.detail}
        data-testid="api-docs-detail"
      >
        {props.schema.description ? (
          <p className={styles.description} data-testid="api-docs-description">
            {props.schema.description}
          </p>
        ) : null}
      </section>
    );
  }
  const { field } = node;
  const summary = [
    field.typeLabel,
    ...(field.required ? ["required"] : []),
    `Field of ${field.owner}`,
  ].join(" · ");
  return (
    <section
      aria-label="Field details"
      className={styles.detail}
      data-testid="api-docs-detail"
    >
      <p className={styles.path} data-testid="api-docs-path">
        {node.path}
      </p>
      <ul className={styles.facts} data-testid="api-docs-facts">
        <li>{summary}</li>
        {field.format ? <li>Format: {field.format}</li> : null}
        {field.enumValues.length > 0 ? (
          <li>One of: {field.enumValues.join(", ")}</li>
        ) : null}
        {field.defaultValue !== null ? (
          <li>Default: {JSON.stringify(field.defaultValue)}</li>
        ) : null}
      </ul>
      {field.description ? (
        <p className={styles.description} data-testid="api-docs-description">
          {field.description}
        </p>
      ) : null}
    </section>
  );
}
