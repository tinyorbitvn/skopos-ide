import { Children, type ReactNode } from "react";
import styles from "./TileRow.module.css";

/**
 * Stat tiles in rows (spec §3.3 and R17): all in one row when each gets 170 px, else half of
 * them a row, at least two from 352 px, one a row below. The tiles of the last row widen.
 */
export function TileRow(props: { children: ReactNode }) {
  const n = Children.toArray(props.children).length;
  return (
    <div className={styles.frame}>
      <div className={styles.row} data-n={n}>
        {props.children}
      </div>
    </div>
  );
}
