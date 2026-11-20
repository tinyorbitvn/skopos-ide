import { memo } from "react";
import { Badge, StatusDot, Tooltip, UsageDonut } from "../../design";
import { Server, TriangleAlert } from "../../design/icons";
import type { TopologyNode } from "../../ipc/generated/TopologyNode";
import type { UsageItem } from "../../ipc/generated/UsageItem";
import {
  conditionBadges,
  cpuUsage,
  memoryUsage,
  plural,
  podCountText,
  READY_TONE,
  taintLine,
} from "./model";
import { PodGrid } from "./PodGrid";
import styles from "./Topology.module.css";

/** The donuts' size in px (topology spec §3.4). */
const DONUT_PX = 40;

/**
 * One node (topology spec §3.4): a 240 px card. Its header (server tab, name, status dot
 * and role chips) opens the node's drawer. The badges row holds the conditions, Cordoned
 * and the taint count, worst first, and shows only when one of them does. Memoized, so a
 * new snapshot redraws only the cards whose node changed.
 */
export const NodeCard = memo(function NodeCard(props: {
  node: TopologyNode;
  /** The node's usage while metrics-server serves it; else its requests are drawn. */
  usage: UsageItem | undefined;
  podsHidden: boolean;
  onOpen(name: string): void;
  /** The highlighted namespace: other namespaces' squares fade. */
  highlight: string | null;
  onOpenPod(key: string): void;
}) {
  const { node, usage, podsHidden, onOpen } = props;
  const badges = conditionBadges(node);
  const hasBadges =
    badges.length > 0 || node.unschedulable || node.taints.length > 0;
  return (
    <article
      className={styles.card}
      data-testid={`topology-card-${node.name}`}
      data-ready={node.ready}
      data-cordoned={node.unschedulable ? "" : undefined}
    >
      <button
        type="button"
        className={styles.cardHeader}
        title={node.name}
        data-testid={`topology-node-${node.name}`}
        data-keeps-drawer=""
        onClick={() => onOpen(node.name)}
      >
        <span className={styles.nodeTab}>
          <Server size={14} />
        </span>
        <span className={styles.nodeName}>{node.name}</span>
        <StatusDot tone={READY_TONE[node.ready]} label={node.ready} />
        {node.roles.map((role) => (
          <Badge key={role} tone="neutral">
            {role}
          </Badge>
        ))}
      </button>
      <div className={styles.cardBody}>
        {hasBadges ? (
          <div
            className={styles.badges}
            data-testid={`topology-badges-${node.name}`}
          >
            {badges.map((badge) => (
              <Badge key={badge.label} tone={badge.tone}>
                {badge.label}
              </Badge>
            ))}
            {node.unschedulable ? <Badge tone="warn">Cordoned</Badge> : null}
            {node.taints.length === 0 ? null : (
              <Tooltip
                content={node.taints.map((taint) => (
                  <span
                    key={`${taint.key}:${taint.effect}`}
                    className={styles.tipLine}
                  >
                    {taintLine(taint)}
                  </span>
                ))}
              >
                <button
                  type="button"
                  className={styles.taints}
                  data-testid={`topology-taints-${node.name}`}
                  data-keeps-drawer=""
                >
                  <TriangleAlert size={12} />
                  {plural(node.taints.length, "taint")}
                </button>
              </Tooltip>
            )}
          </div>
        ) : null}
        <div className={styles.donuts}>
          <UsageDonut
            {...cpuUsage(node, usage)}
            size={DONUT_PX}
            testId={`topology-cpu-${node.name}`}
          />
          <UsageDonut
            {...memoryUsage(node, usage)}
            size={DONUT_PX}
            testId={`topology-memory-${node.name}`}
          />
        </div>
        {podsHidden ? null : (
          <p
            className={styles.podCount}
            data-testid={`topology-pod-count-${node.name}`}
          >
            {podCountText(node)}
          </p>
        )}
        {podsHidden || node.pods.length === 0 ? null : (
          <PodGrid
            node={node.name}
            pods={node.pods}
            highlight={props.highlight}
            onOpen={props.onOpenPod}
          />
        )}
      </div>
    </article>
  );
});
