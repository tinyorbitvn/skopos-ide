import { useId } from "react";
import { ShareDonut, sharePct } from "./ShareDonut";
import styles from "./TopTable.module.css";

/** One row of a top table (spec §3.5). */
export interface TopRow {
  /** The test ids' stem: a namespace's name, or a Pod's `<namespace>/<name>`. */
  key: string;
  name: string;
  /** Under the name: "N pods", or the Pod's namespace. */
  sub: string;
  /** In the total's unit: cores or bytes. */
  amount: number;
  /** The amount as the Pods list shows it: "994m", "1.2 cores", "870Mi", "3.4Gi". */
  amountText: string;
  /** Opens the row's object in the drawer. */
  onOpen(): void;
}

export interface TopTableProps {
  /** The table's test id, and the stem of its rows' test ids. */
  id: string;
  title: string;
  /** "Namespace" or "Pod". */
  nameHead: string;
  /** "CPU" or "Memory". */
  valueHead: string;
  /** The cluster's allocatable in the amounts' unit; null when unknown. */
  total: number | null;
  /** What the share is of, in the donut's name: "CPU" or "memory". */
  what: string;
  rows: TopRow[];
}

/** The largest consumers with their share of the cluster (spec §3.5). */
export function TopTable(props: TopTableProps) {
  const titleId = useId();
  return (
    <div className={styles.top}>
      <h3 id={titleId} className={styles.title}>
        {props.title}
      </h3>
      <table
        aria-labelledby={titleId}
        className={styles.table}
        data-testid={props.id}
      >
        <thead>
          <tr className={styles.head}>
            <th scope="col" className={styles.name}>
              {props.nameHead}
            </th>
            <th scope="col" className={styles.value}>
              {props.valueHead}
            </th>
            <th scope="col" className={styles.share}>
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr className={styles.empty}>
              <td colSpan={3}>No usage reported yet</td>
            </tr>
          ) : (
            props.rows.map((row) => {
              const pct = sharePct(row.amount, props.total);
              return (
                <tr
                  key={row.key}
                  className={styles.row}
                  data-testid={`${props.id}-row-${row.key}`}
                >
                  <td className={styles.name}>
                    <button
                      type="button"
                      className={styles.open}
                      data-testid={`${props.id}-open-${row.key}`}
                      onClick={row.onOpen}
                    >
                      {row.name}
                    </button>
                    <span className={styles.sub}>{row.sub}</span>
                  </td>
                  <td className={styles.value}>{row.amountText}</td>
                  <td className={styles.share}>
                    <ShareDonut
                      pct={pct}
                      label={
                        pct === null
                          ? `${row.name}: share unknown`
                          : `${row.name} ${pct}% of the cluster's ${props.what}`
                      }
                    />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
