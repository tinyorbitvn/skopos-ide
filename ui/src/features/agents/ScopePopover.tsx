import { clusterStatus } from "../../app/clusterStatus";
import type { CurrentCluster } from "../../app/currentCluster";
import { StatusDot } from "../../design";
import type { ChatScope } from "../../ipc/generated/ChatScope";
import { useCatalog } from "../../stores/catalog";
import { PanelPopover } from "./PanelPopover";
import styles from "./PanelPopover.module.css";

/**
 * The scope popover (spec §3.2): this cluster, or several clusters with a checkbox each.
 * Each pick starts a new chat; the checkboxes keep the popover open, and the last checked
 * cluster cannot be unchecked.
 */
export function ScopePopover(props: {
  scope: ChatScope | null;
  page: CurrentCluster | null;
  onPick(scope: ChatScope): void;
  onClose(): void;
}) {
  const clusters = useCatalog((s) => s.clusters);
  const ids = clusters.map((c) => c.id);
  const global = props.scope?.global ?? props.page === null;
  const checked = global ? (props.scope?.clusters ?? ids) : [];
  const page = props.page;
  const onThis =
    page !== null && !global && props.scope?.clusters[0] === page.id;

  function toggle(id: string): void {
    const next = checked.includes(id)
      ? checked.filter((c) => c !== id)
      : [...checked, id];
    props.onPick({
      clusters: ids.filter((c) => next.includes(c)),
      global: true,
    });
  }

  return (
    <PanelPopover
      label="Scope"
      testId="agent-scope-popover"
      onClose={props.onClose}
    >
      <fieldset className={styles.options}>
        <legend className={styles.legend}>Scope</legend>
        {page !== null ? (
          <label className={styles.option}>
            <input
              type="radio"
              name="agent-scope"
              checked={onThis}
              onChange={() => {
                props.onPick({ clusters: [page.id], global: false });
                props.onClose();
              }}
              data-testid="agent-scope-this"
            />
            <span>This cluster</span>
            <span className={styles.muted}>{page.name}</span>
          </label>
        ) : null}
        <label className={styles.option}>
          <input
            type="radio"
            name="agent-scope"
            checked={global}
            onChange={() => props.onPick({ clusters: ids, global: true })}
            data-testid="agent-scope-several"
          />
          <span>Several clusters</span>
        </label>
        <ul className={styles.nested}>
          {clusters.map((cluster) => {
            const on = checked.includes(cluster.id);
            const status = clusterStatus(cluster.state);
            return (
              <li key={cluster.id}>
                <label className={styles.option}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!global || (on && checked.length === 1)}
                    onChange={() => toggle(cluster.id)}
                    data-testid={`agent-scope-cluster-${cluster.id}`}
                  />
                  <StatusDot tone={status.tone} label={status.label} />
                  <span>{cluster.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p className={styles.note}>
        A chat across clusters can read every cluster you check. Changes still
        ask you first.
      </p>
    </PanelPopover>
  );
}
