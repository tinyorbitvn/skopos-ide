import { Button, Input, Menu, type MenuItem } from "../../design";
import { ChevronDown } from "../../design/icons";
import { STATE_ORDER } from "./model";
import styles from "./Topology.module.css";

const HIGHLIGHT = "Highlight namespace";

/** Title and count, filter, highlight menu, legend and source note (topology spec §3.2). */
export function TopologyToolbar(props: {
  /** Null until the first snapshot. */
  count: string | null;
  query: string;
  onQuery(query: string): void;
  /** The highlight menu's namespaces, sorted. */
  namespaces: readonly string[];
  highlight: string | null;
  onHighlight(namespace: string | null): void;
  note: string;
}) {
  const items: MenuItem[] = [
    {
      id: "all",
      label: "All namespaces",
      testId: "topology-ns-all",
      onSelect: () => props.onHighlight(null),
    },
    ...props.namespaces.map(
      (namespace): MenuItem => ({
        id: `ns-${namespace}`,
        label: namespace,
        testId: `topology-ns-${namespace}`,
        onSelect: () => props.onHighlight(namespace),
      }),
    ),
  ];
  return (
    <div className={styles.toolbar}>
      <h2 className={styles.title}>Node topology</h2>
      {props.count === null ? null : (
        <span className={styles.count} data-testid="topology-count">
          {props.count}
        </span>
      )}
      <Input
        type="search"
        className={styles.filter}
        placeholder="Filter nodes"
        aria-label="Filter nodes"
        data-testid="topology-filter"
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
      />
      <Menu
        align="start"
        items={items}
        trigger={
          <Button size="sm" title={HIGHLIGHT} data-testid="topology-highlight">
            {props.highlight ?? HIGHLIGHT}
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
        }
      />
      <ul className={styles.legend} aria-label="Pod states">
        {STATE_ORDER.map((state) => (
          <li key={state} className={styles.legendItem}>
            <span
              className={styles.swatch}
              data-state={state}
              aria-hidden="true"
            />
            {state}
          </li>
        ))}
      </ul>
      <span className={styles.note} data-testid="topology-source">
        {props.note}
      </span>
    </div>
  );
}
