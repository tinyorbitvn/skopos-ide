import { useEffect, useRef, useState } from "react";
import type { RolloutTarget } from "../../ipc/generated/RolloutTarget";
import { useWatchedObject } from "../../stores/objectWatch";
import styles from "./ChangeCard.module.css";
import { rolloutProgress } from "./chatModel";

const GRACE_MS = 3_000;
const LATE_MS = 300_000;

/**
 * The result line of an applied change to a workload (spec §4.5 rule 7, P10). A row that
 * looks settled before the controller saw the change must not read as done, so a settled
 * row counts once it changed since the line first rendered, or after 3 s.
 */
export function RolloutLine(props: { target: RolloutTarget }) {
  const { target } = props;
  const { object } = useWatchedObject(
    target.clusterId,
    target.resource,
    target.namespace,
    target.name,
  );
  const first = useRef<string | null | undefined>(undefined);
  const done = useRef<string | null>(null);
  const [grace, setGrace] = useState(false);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const g = setTimeout(() => setGrace(true), GRACE_MS);
    const l = setTimeout(() => setLate(true), LATE_MS);
    return () => {
      clearTimeout(g);
      clearTimeout(l);
    };
  }, []);

  if (object === undefined) return null;
  const version = object.metadata?.resourceVersion ?? null;
  if (first.current === undefined) first.current = version;
  const progress = rolloutProgress(target.resource.kind, object);
  if (
    done.current === null &&
    progress.settled &&
    (version !== first.current || grace)
  ) {
    done.current = `Rolled out ${progress.ready} of ${progress.desired} Pods`;
  }
  if (done.current !== null) {
    return (
      <p role="status" className={styles.ok} data-testid="agent-rollout">
        {done.current}
      </p>
    );
  }
  if (late) {
    return (
      <p role="status" className={styles.warning} data-testid="agent-rollout">
        {`Rollout not finished: ${progress.ready} of ${progress.desired} Pods ready`}
      </p>
    );
  }
  return null;
}
