import { UsageDonut } from "../../design";
import styles from "./CapacityRow.module.css";

/** One donut of the Capacity card (spec §3.2). */
export interface CapacityItem {
  /** The test id's stem: `overview-capacity-<key>`. */
  key: string;
  /** The visible name: "CPU", "Memory" or "Pods". */
  name: string;
  /** The screen-reader name: the name, or "CPU requests" when requests stand in for usage. */
  label: string;
  /** The whole percent used; null when unknown. */
  pct: number | null;
  used: string | null;
  total: string | null;
  /** "cores", "GiB", "MiB" or "pods". */
  unit: string;
  /** "Requests N%", or null. */
  note: string | null;
}

const known = (item: CapacityItem) =>
  item.pct !== null && item.used !== null && item.total !== null;

/**
 * The Capacity card's 96 px donuts (spec §3.2), in columns of at least 120 px. Their text sits
 * under them, and beside them from 760 px of row.
 */
export function CapacityRow(props: { items: CapacityItem[] }) {
  return (
    <div className={styles.row}>
      {props.items.map((item) => {
        const testId = `overview-capacity-${item.key}`;
        const ok = known(item);
        return (
          <div key={item.key} className={styles.item} data-testid={testId}>
            <UsageDonut
              name={item.name}
              label={
                ok
                  ? `${item.label} ${item.pct}%, ${item.used} of ${item.total} ${item.unit}`
                  : `${item.label}: no data`
              }
              pct={item.pct}
              used={item.used}
              total={item.total}
              unit={item.unit}
              size={96}
              bare
            />
            <div className={styles.text} aria-hidden="true">
              <span className={styles.name}>{item.name}</span>
              <span className={styles.values} data-testid={`${testId}-values`}>
                {ok ? `${item.used} / ${item.total} ${item.unit}` : "No data"}
              </span>
              {item.note ? (
                <span className={styles.note} data-testid={`${testId}-note`}>
                  {item.note}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
