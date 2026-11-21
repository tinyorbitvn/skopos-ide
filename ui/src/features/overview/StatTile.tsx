import { Link } from "react-router";
import type { IconComponent } from "../../design/icons";
import styles from "./StatTile.module.css";

/** A tile's tone: its icon chip and sub-line take it. */
export type TileTone = "ok" | "warn" | "danger" | "neutral";

export interface StatTileProps {
  /** The test id's stem: `overview-tile-<id>`. */
  id: string;
  icon: IconComponent;
  /** The large number, such as "11 / 12", or "—". */
  number: string;
  label: string;
  sub: string;
  tone: TileTone;
  /** The path it opens; null draws a disabled button. */
  to: string | null;
}

/**
 * A count that opens its list (spec §3.3). A react-router link, so the screen-link handlers
 * give it the same tab, new tab, beside and pin behaviours as the sidebar's links.
 */
export function StatTile(props: StatTileProps) {
  const Icon = props.icon;
  const testId = `overview-tile-${props.id}`;
  const body = (
    <>
      <span className={styles.chip} aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className={styles.number} data-testid={`${testId}-number`}>
        {props.number}
      </span>
      <span className={styles.label}>{props.label}</span>
      <span className={styles.sub} data-testid={`${testId}-sub`}>
        {props.sub}
      </span>
    </>
  );
  if (props.to === null) {
    return (
      <button
        type="button"
        className={styles.tile}
        data-tone={props.tone}
        data-testid={testId}
        disabled
      >
        {body}
      </button>
    );
  }
  return (
    <Link
      to={props.to}
      className={styles.tile}
      data-tone={props.tone}
      data-testid={testId}
    >
      {body}
    </Link>
  );
}
