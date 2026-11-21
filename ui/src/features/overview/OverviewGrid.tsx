import type { ReactNode } from "react";
import styles from "./OverviewGrid.module.css";

/** How many of the 12 columns a card takes from 900 px of grid. */
export type OverviewSpan = 4 | 5 | 6 | 7 | 8 | 12;

/**
 * An overview page's 12-column grid (cluster overview spec §3.1). Its frame is the container
 * of its column rule, so the sidebar and split panes count, not the window.
 */
export function OverviewGrid(props: { children: ReactNode; testId?: string }) {
  return (
    <div className={styles.frame}>
      <div className={styles.grid} data-testid={props.testId}>
        {props.children}
      </div>
    </div>
  );
}

/** One card's place: the whole row under 900 px of grid, else `span` of the 12 columns. */
export function OverviewCell(props: {
  span: OverviewSpan;
  children: ReactNode;
}) {
  return (
    <div className={styles.cell} data-span={props.span}>
      {props.children}
    </div>
  );
}
