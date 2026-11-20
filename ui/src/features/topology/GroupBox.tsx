import type { ReactNode } from "react";
import { MapIcon, Target } from "../../design/icons";
import styles from "./Topology.module.css";

/**
 * A region or a zone as a dashed box (topology spec §3.3). An SVG rect draws the dashes, so
 * their length is exact. A region's label is an h3 after a tab with the map icon; a zone's
 * is an h4 after a target icon. "No region" and "No zone" are muted. A region's zones sit
 * side by side and wrap; a zone's cards stack.
 */
export function GroupBox(props: {
  kind: "region" | "zone";
  label: string;
  muted: boolean;
  testId: string;
  children: ReactNode;
}) {
  const { kind, label } = props;
  const Heading = kind === "region" ? "h3" : "h4";
  return (
    <div
      className={styles.group}
      data-kind={kind}
      data-muted={props.muted ? "" : undefined}
      data-testid={props.testId}
    >
      <svg className={styles.dash} aria-hidden="true">
        <rect width="100%" height="100%" />
      </svg>
      <Heading className={styles.groupLabel}>
        {kind === "region" ? (
          <span className={styles.groupTab}>
            <MapIcon size={14} />
          </span>
        ) : (
          <Target size={12} className={styles.zoneIcon} />
        )}
        {label}
      </Heading>
      <div
        className={`${styles.groupBody} ${kind === "region" ? styles.zones : styles.nodes}`}
      >
        {props.children}
      </div>
    </div>
  );
}
