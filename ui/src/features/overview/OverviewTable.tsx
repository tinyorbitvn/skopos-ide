import type { CSSProperties } from "react";
import { Link } from "react-router";
import { EmptyState, UsageDonut } from "../../design";
import type { IconComponent } from "../../design/icons";
import type { UsageTone } from "../../design/UsageDonut";
import styles from "./OverviewTable.module.css";

/** A column of an overview table (section overviews spec §4.3). */
export interface OverviewColumn {
  /** The header. Heads are distinct within a table: each keys its column's cells. */
  head: string;
  /** A fixed or `fr` track, never `max-content`: each row is its own grid. */
  width: string;
  /** `end` right-aligns the column in the mono face, for numbers. */
  align?: "start" | "end";
}

/** A cell after the name: text, or a 36 px donut with its caption beside it. */
export type OverviewCellValue =
  | {
      text: string;
      /** `warn` warning text, `bad` critical text, `dim` tertiary text. */
      tone?: "warn" | "bad" | "dim";
      mono?: boolean;
      title?: string;
    }
  | {
      donut: {
        pct: number | null;
        used: string | null;
        total: string | null;
        unit: string;
        /** The donut's accessible name: "payments/compute requests.cpu 63%, 2.5 of 4 cores". */
        label: string;
        /** Beside the donut: "2.5 / 4 cores". */
        caption: string;
        /** The arc's level in place of the 80 % / 95 % rule. */
        level?: UsageTone;
      };
    };

/** A row: its name with a sub-line, then a cell per column after the first. */
export interface OverviewRow {
  /** The stem of `<id>-row-<key>` and `<id>-open-<key>`. */
  key: string;
  name: string;
  /** Under the name; none when empty. */
  sub: string;
  title?: string;
  /** Draws the name as a button that opens the drawer. */
  onOpen?: () => void;
  /** Draws the name as a link, such as the zone row's; with neither, it is plain text. */
  to?: string;
  /** One per column after the first. */
  cells: OverviewCellValue[];
}

export interface OverviewTableProps {
  /** The table's test id, and the stem of its parts' test ids. */
  id: string;
  /** A visible h3 over the table. */
  title?: string;
  /** The table's accessible name. */
  label: string;
  /** The first is the name column. */
  columns: OverviewColumn[];
  rows: OverviewRow[];
  /** In px: a narrower card scrolls the table sideways. */
  minWidth?: number;
  /** Draws `Loading` in place of the rows. */
  loading?: boolean;
  /** Drawn in place of the table while there is no row. */
  empty: { icon: IconComponent; title: string; text: string };
  /** A caption after the rows. */
  footer?: string;
}

const NO_TEXT: OverviewCellValue = { text: "" };

/** The row's name: a button that opens its object, a link, or plain text. */
function RowName(props: { id: string; row: OverviewRow }) {
  const { row } = props;
  const testId = `${props.id}-open-${row.key}`;
  if (row.onOpen) {
    return (
      <button
        type="button"
        className={styles.open}
        title={row.title}
        data-testid={testId}
        onClick={row.onOpen}
      >
        {row.name}
      </button>
    );
  }
  if (row.to !== undefined) {
    return (
      <Link
        to={row.to}
        className={styles.open}
        title={row.title}
        data-testid={testId}
      >
        {row.name}
      </Link>
    );
  }
  return (
    <span className={styles.plain} title={row.title}>
      {row.name}
    </span>
  );
}

function Cell(props: { value: OverviewCellValue; align: "start" | "end" }) {
  const { value, align } = props;
  if ("donut" in value) {
    const d = value.donut;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a cell of a row that is its own grid on the columns' tracks, which table layout does not draw.
      <span role="cell" className={styles.cell} data-align={align}>
        <UsageDonut
          name={d.label}
          label={d.label}
          pct={d.pct}
          used={d.used}
          total={d.total}
          unit={d.unit}
          size={36}
          bare
          tone={d.level}
        />
        <span className={styles.caption} aria-hidden="true">
          {d.caption}
        </span>
      </span>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a cell of a row that is its own grid on the columns' tracks, which table layout does not draw.
    <span
      role="cell"
      className={styles.cell}
      data-align={align}
      data-tone={value.tone}
      data-mono={value.mono ? "" : undefined}
      title={value.title}
    >
      <span className={styles.text}>{value.text}</span>
    </span>
  );
}

/**
 * A table of an overview card (section overviews spec §3.1, §4.3): a header row, then rows of
 * a name with a sub-line and cells of text or donuts. Each row is a grid on the columns'
 * tracks. While its lists load it reads `Loading`; with no row its empty state stands in.
 */
export function OverviewTable(props: OverviewTableProps) {
  const { id, columns, rows } = props;
  if (!props.loading && rows.length === 0) {
    return (
      <div data-testid={`${id}-empty`}>
        <EmptyState
          icon={props.empty.icon}
          title={props.empty.title}
          body={props.empty.text}
        />
      </div>
    );
  }
  const layout = {
    "--ot-columns": columns.map((c) => c.width).join(" "),
    ...(props.minWidth === undefined
      ? {}
      : { "--ot-min-width": `${props.minWidth}px` }),
  } as CSSProperties;
  const after = columns.slice(1);
  return (
    <div className={styles.frame}>
      {props.title ? <h3 className={styles.title}>{props.title}</h3> : null}
      <div className={styles.scroll}>
        {/* biome-ignore lint/a11y/useSemanticElements: each row is its own grid on the columns' tracks, which table layout does not draw. */}
        <div
          role="table"
          aria-label={props.label}
          className={styles.table}
          style={layout}
          data-testid={id}
        >
          {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: the header of a table whose rows are grids; it takes no focus. */}
          <div role="row" className={`${styles.row} ${styles.head}`}>
            {columns.map((column) => (
              // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a header of a row that is its own grid; it takes no focus.
              <span
                key={column.head}
                role="columnheader"
                className={styles.headCell}
                data-align={column.align ?? "start"}
              >
                {column.head}
              </span>
            ))}
          </div>
          {props.loading ? (
            // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a row of a table whose rows are grids; it takes no focus.
            <div
              role="row"
              className={styles.row}
              data-testid={`${id}-loading`}
            >
              {/* biome-ignore lint/a11y/useSemanticElements: a cell of a row that is its own grid. */}
              <span role="cell" className={styles.loading}>
                Loading
              </span>
            </div>
          ) : (
            rows.map((row) => (
              // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a row of a table whose rows are grids; its name is the control.
              <div
                key={row.key}
                role="row"
                className={styles.row}
                data-testid={`${id}-row-${row.key}`}
              >
                {/* biome-ignore lint/a11y/useSemanticElements: a cell of a row that is its own grid. */}
                <span role="cell" className={styles.name}>
                  <RowName id={id} row={row} />
                  {row.sub ? (
                    <span className={styles.sub}>{row.sub}</span>
                  ) : null}
                </span>
                {after.map((column, i) => (
                  <Cell
                    key={column.head}
                    value={row.cells[i] ?? NO_TEXT}
                    align={column.align ?? "start"}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>
      {props.footer && !props.loading ? (
        <p className={styles.footer} data-testid={`${id}-footer`}>
          {props.footer}
        </p>
      ) : null}
    </div>
  );
}
