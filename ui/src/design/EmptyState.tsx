import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";
import type { IconComponent } from "./icons";

export function EmptyState(props: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  /** A 24 px icon over the title, as an overview card's empty state draws it. */
  icon?: IconComponent;
}) {
  const Icon = props.icon;
  return (
    <div className={styles.empty}>
      {Icon ? <Icon size={24} className={styles.glyph} /> : null}
      <h3 className={styles.title}>{props.title}</h3>
      {props.body ? <div className={styles.body}>{props.body}</div> : null}
      {props.action ? (
        <div className={styles.action}>{props.action}</div>
      ) : null}
    </div>
  );
}
