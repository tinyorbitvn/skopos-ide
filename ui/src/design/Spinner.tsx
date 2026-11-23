import styles from "./Spinner.module.css";

/** A spinner. `hideLabel` keeps `label` for screen readers only, for a mark inside a row. */
export function Spinner({
  label,
  hideLabel,
}: {
  label?: string;
  hideLabel?: boolean;
}) {
  return (
    <span className={styles.wrap} role="status" aria-label={label ?? "Loading"}>
      <span className={styles.spinner} aria-hidden="true" />
      {label && !hideLabel ? (
        <span className={styles.label}>{label}</span>
      ) : null}
    </span>
  );
}
