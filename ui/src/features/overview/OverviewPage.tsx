import type { KeyboardEvent, ReactNode } from "react";
import { Layers } from "../../design/icons";
import styles from "./OverviewPage.module.css";

/**
 * A section's overview page (section overviews spec §3.1): the list toolbar's look, an h2
 * title and the namespaces chosen in the lists, over a body that scrolls. The root is the frame
 * the details drawer opens over, as on a list screen, and hears the Escape that closes it.
 */
export function OverviewPage(props: {
  title: string;
  /** The root's test id, and the stem of `<testId>-title` and `<testId>-namespaces`. */
  testId: string;
  /** The lists' namespace choice; the note shows while it is not empty. */
  namespaces: readonly string[];
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const { testId, namespaces } = props;
  const chosen = namespaces.join(", ");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the root only listens for the Escape that closes the drawer, as on list screens.
    <div
      className={styles.page}
      data-testid={testId}
      onKeyDown={props.onKeyDown}
    >
      <div className={styles.toolbar}>
        <h2 className={styles.title} data-testid={`${testId}-title`}>
          {props.title}
        </h2>
        <div className={styles.grow} />
        {namespaces.length > 0 ? (
          <p
            className={styles.note}
            title={chosen}
            data-testid={`${testId}-namespaces`}
          >
            <Layers size={14} className={styles.noteIcon} />
            <span className={styles.noteText}>{`Namespaces: ${chosen}`}</span>
          </p>
        ) : null}
      </div>
      <div className={styles.body}>{props.children}</div>
    </div>
  );
}
