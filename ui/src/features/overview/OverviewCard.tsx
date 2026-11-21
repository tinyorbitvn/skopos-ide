import { type ReactNode, useId } from "react";
import styles from "./OverviewCard.module.css";

/**
 * A card of an overview page (spec §3.1): a section named by its h2 title, with optional tools
 * at the right of its header.
 */
export function OverviewCard(props: {
  title: string;
  tools?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      className={styles.card}
      aria-labelledby={headingId}
      data-testid={props.testId}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.title}>
          {props.title}
        </h2>
        {props.tools ? <div className={styles.tools}>{props.tools}</div> : null}
      </header>
      <div className={styles.body}>{props.children}</div>
    </section>
  );
}
