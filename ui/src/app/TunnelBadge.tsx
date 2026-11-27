import { Badge } from "../design";
import { useTunnels } from "../stores/tunnels";
import styles from "./TunnelBadge.module.css";
import type { TunnelProblem } from "./tunnelProblem";

/**
 * A cluster's tunnel badge (tunnels spec §5.1). `Tunnel needs input` is a button that opens
 * the prompt (spec §6.1); it keeps the click from reaching the row under it.
 */
export function TunnelBadge(props: { problem: TunnelProblem; testId: string }) {
  const ask = useTunnels((s) => s.ask);
  const { problem } = props;
  const { promptId } = problem;
  if (promptId === null) {
    return (
      <span title={problem.detail} data-testid={props.testId}>
        <Badge tone={problem.tone}>{problem.label}</Badge>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.button}
      title={problem.detail}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        ask(promptId);
      }}
      data-testid={props.testId}
    >
      <Badge tone={problem.tone}>{problem.label}</Badge>
    </button>
  );
}
