import { memo, useState } from "react";
import { Tooltip } from "../../design";
import type { ReachSnapshot } from "../../stores/reachability";
import styles from "./ReachMatrix.module.css";
import { type AxisEntry, cellOf } from "./reachModel";

function Head(props: { entry: AxisEntry }) {
  return (
    <>
      <span className={styles.headName}>{props.entry.label}</span>
      <span className={styles.headSub}>{props.entry.sub}</span>
    </>
  );
}

/**
 * A cell: its text, "Some Pods", and a tooltip with the verdict, ports and policies. The
 * tooltip mounts once the pointer first reaches the cell, so a full 100 × 100 matrix
 * stays light.
 */
function Cell(props: {
  snapshot: ReachSnapshot;
  from: string;
  to: string;
  dim: boolean;
  edge: boolean;
}) {
  const cell = cellOf(props.snapshot, props.from, props.to);
  const [tip, setTip] = useState(false);
  const className = [
    styles.cell,
    styles[cell.verdict ?? "none"],
    props.dim ? styles.dim : "",
  ].join(" ");
  // Screen readers get the verdict in words: "—" alone says nothing, and the color is
  // not read out.
  const said =
    cell.verdict === null
      ? undefined
      : [
          cell.tip[0],
          cell.verdict === "allowed" ? cell.text : null,
          cell.somePods ? "Some Pods" : null,
        ]
          .filter((part) => part !== null)
          .join(", ");
  const content = (
    <>
      <span className={styles.cellText}>{cell.text}</span>
      {cell.somePods ? <span className={styles.some}>Some Pods</span> : null}
    </>
  );
  const box =
    said === undefined ? (
      <span className={className}>{content}</span>
    ) : (
      <span className={className} role="img" aria-label={said}>
        {content}
      </span>
    );
  return (
    <td
      className={props.edge ? styles.edge : undefined}
      data-testid={`reach-cell-${props.from}--${props.to}`}
      data-verdict={cell.verdict ?? "none"}
      data-dim={props.dim ? "" : undefined}
      onPointerEnter={
        cell.verdict === null || tip ? undefined : () => setTip(true)
      }
    >
      {tip ? (
        <Tooltip
          content={cell.tip.map((line) => (
            <span key={line} className={styles.tipLine}>
              {line}
            </span>
          ))}
        >
          {box}
        </Tooltip>
      ) : (
        box
      )}
    </td>
  );
}

function Row(props: {
  snapshot: ReachSnapshot;
  row: AxisEntry;
  columns: AxisEntry[];
  /** The first outside column, which starts after the column separator. */
  edge: string | null;
  selected: string | null;
  onSelect(id: string): void;
}) {
  const { row, selected } = props;
  return (
    <tr>
      <th scope="row" className={styles.rowHead}>
        {row.outside ? (
          <span
            className={styles.headLabel}
            data-testid={`reach-row-${row.id}`}
          >
            <Head entry={row} />
          </span>
        ) : (
          <button
            type="button"
            className={styles.headButton}
            aria-pressed={selected === row.id}
            data-testid={`reach-row-${row.id}`}
            onClick={() => props.onSelect(row.id)}
          >
            <Head entry={row} />
          </button>
        )}
      </th>
      {props.columns.map((col) => (
        <Cell
          key={col.id}
          snapshot={props.snapshot}
          from={row.id}
          to={col.id}
          dim={selected !== null && row.id !== selected && col.id !== selected}
          edge={col.id === props.edge}
        />
      ))}
    </tr>
  );
}

/**
 * The matrix (spec §3.2): sources as rows, destinations as columns, the namespace's
 * workloads first, then the outside peers after a separator. The header row and the first
 * column stay put while it scrolls. A selected workload keeps its row and column bright.
 */
export const ReachMatrix = memo(function ReachMatrix(props: {
  snapshot: ReachSnapshot;
  rows: AxisEntry[];
  columns: AxisEntry[];
  selected: string | null;
  onSelect(id: string): void;
}) {
  const { snapshot, rows, columns, selected } = props;
  const inside = rows.filter((r) => !r.outside);
  const outside = rows.filter((r) => r.outside);
  const edge = columns.find((c) => c.outside)?.id ?? null;
  const row = (entry: AxisEntry) => (
    <Row
      key={entry.id}
      snapshot={snapshot}
      row={entry}
      columns={columns}
      edge={edge}
      selected={selected}
      onSelect={props.onSelect}
    />
  );
  return (
    <table
      className={styles.matrix}
      data-testid="reach-matrix"
      aria-label={`Connections in ${snapshot.namespace}`}
    >
      <thead>
        <tr>
          <td className={styles.corner} />
          {columns.map((col) => (
            <th
              key={col.id}
              scope="col"
              className={
                col.id === edge
                  ? `${styles.colHead} ${styles.edge}`
                  : styles.colHead
              }
              data-testid={`reach-col-${col.id}`}
              data-selected={col.id === selected ? "" : undefined}
            >
              <Head entry={col} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{inside.map(row)}</tbody>
      {outside.length === 0 ? null : (
        <tbody>
          <tr>
            <th
              scope="rowgroup"
              colSpan={columns.length + 1}
              className={styles.separator}
            >
              <span className={styles.separatorText}>
                From outside {snapshot.namespace}
              </span>
            </th>
          </tr>
          {outside.map(row)}
        </tbody>
      )}
    </table>
  );
});
