import { Badge, Tooltip, useNow } from "../design";
import type { Tone } from "../design/Badge";
import type { TableColumn } from "../design/VirtualTable";
import type { StatusInfo } from "./columns";
import {
  type NodeCondition,
  type NodeConditions,
  nodeConditions,
  SCHEDULING_DISABLED,
} from "./nodes/nodeConditions";
import { formatAge, type KubeObject } from "./objects";
import styles from "./statusCells.module.css";
import type { OwnedPods } from "./workloads/ownedPods";
import { podSummary } from "./workloads/pod";
import { type WorkloadStatus, workloadStatus } from "./workloads/podStates";

/** The card names this many Pods of a state, then says how many more there are. */
export const MAX_NAMED_PODS = 5;

const SEVERITY: Record<Tone, number> = {
  danger: 0,
  warn: 1,
  info: 2,
  neutral: 3,
  ok: 4,
};

/** Sorts the worst first in ascending order, then by label (spec N18). */
export function severitySortValue(tone: Tone, label: string): string {
  return `${SEVERITY[tone]}:${label}`;
}

const podCount = (n: number) =>
  n === 0 ? "no Pods" : n === 1 ? "1 Pod" : `${n} Pods`;

/** Restarts, then why the Pod is not running: its status message or why it is unscheduled. */
export function podDetail(pod: KubeObject): string {
  const parts: string[] = [];
  const { restarts } = podSummary(pod);
  if (restarts > 0)
    parts.push(`restarted ${restarts} ${restarts === 1 ? "time" : "times"}`);
  const message = pod.status?.message;
  const conditions: { type?: string; status?: string; reason?: unknown }[] =
    Array.isArray(pod.status?.conditions) ? pod.status.conditions : [];
  const scheduled = conditions.find((c) => c?.type === "PodScheduled");
  if (typeof message === "string" && message !== "") parts.push(message);
  else if (
    scheduled?.status === "False" &&
    typeof scheduled.reason === "string"
  )
    parts.push(scheduled.reason);
  return parts.join(", ");
}

/** The Pods of one state by name, each with its detail, up to `MAX_NAMED_PODS`. */
export function podNames(pods: KubeObject[]): string {
  const sorted = [...pods].sort((a, b) =>
    a.metadata.name.localeCompare(b.metadata.name),
  );
  const named = sorted.slice(0, MAX_NAMED_PODS).map((pod) => {
    const detail = podDetail(pod);
    return detail ? `${pod.metadata.name} (${detail})` : pod.metadata.name;
  });
  const rest = sorted.length - named.length;
  return rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

/** What the cell says to a screen reader (spec N10). */
export function workloadSummary(status: WorkloadStatus, total: number): string {
  const { badge, count, states } = status;
  const head =
    count === undefined
      ? badge.label
      : `${badge.label}, ${count} of ${podCount(total)}`;
  if (total === 0) return `${head}; no Pods`;
  const others = states
    .filter((s) => count === undefined || s.label !== badge.label)
    .map((s) => `${s.label} ${s.pods.length}`);
  return [head, ...others].join("; ");
}

function WorkloadCard(props: {
  name: string;
  status: WorkloadStatus;
  total: number;
}) {
  const { name, status, total } = props;
  return (
    <div className={styles.body} data-testid="status-card">
      <div className={styles.title}>{`${name} — ${podCount(total)}`}</div>
      {status.states.map((s) => (
        <div key={s.label} className={styles.line}>
          <span className={styles.state}>
            <Badge tone={s.tone}>{s.label}</Badge>
          </span>
          <span className={styles.count}>{s.pods.length}</span>
          <span className={styles.detail}>{podNames(s.pods)}</span>
        </div>
      ))}
      {status.note !== undefined && (
        <div className={styles.note}>{status.note}</div>
      )}
    </div>
  );
}

function WorkloadStatusCell(props: {
  name: string;
  status: WorkloadStatus;
  total: number;
}) {
  const { status } = props;
  const summary = workloadSummary(status, props.total);
  return (
    <Tooltip
      variant="card"
      label={summary}
      content={<WorkloadCard {...props} />}
    >
      <span
        className={styles.status}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the Status card opens on keyboard focus (spec N10).
        tabIndex={0}
        role="img"
        aria-label={summary}
        data-testid="status-cell"
      >
        <Badge tone={status.badge.tone}>
          {status.badge.label}
          {status.count !== undefined && (
            <span className={styles.badgeCount}>{status.count}</span>
          )}
        </Badge>
        {status.more > 0 && (
          <span className={styles.more}>{`+${status.more}`}</span>
        )}
      </span>
    </Tooltip>
  );
}

/**
 * The Status column of a workload list (spec N6–N10). `own` is the status the kind showed
 * before; without the workload's Pods the cell shows it as it always did (spec N7).
 */
export function workloadStatusColumn(
  kindName: string,
  own: (o: KubeObject) => StatusInfo,
  owned: OwnedPods | undefined,
): TableColumn<KubeObject> {
  return {
    id: "status",
    header: "Status",
    width: 220,
    sortValue: (o) => {
      const pods = owned?.podsOf(o);
      const badge =
        pods === undefined
          ? own(o)
          : workloadStatus(own(o), o, pods, kindName).badge;
      return severitySortValue(badge.tone, badge.label);
    },
    filter: {
      text: (o) => {
        const pods = owned?.podsOf(o);
        return pods === undefined
          ? own(o).label
          : workloadStatus(own(o), o, pods, kindName).badge.label;
      },
    },
    render: (o) => {
      const status = own(o);
      const pods = owned?.podsOf(o);
      if (pods === undefined)
        return <Badge tone={status.tone}>{status.label}</Badge>;
      return (
        <WorkloadStatusCell
          name={o.metadata.name}
          status={workloadStatus(status, o, pods, kindName)}
          total={pods.length}
        />
      );
    },
  };
}

/** "‹reason›: ‹message›", or whichever of the two the condition has. */
export function conditionDetail(c: NodeCondition): string {
  return [c.reason, c.message]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .join(": ");
}

/** What a Node's cell says to a screen reader. */
export function nodeSummary(read: NodeConditions): string {
  return read.active.length === 0
    ? read.ready.label
    : `${read.ready.label}; ${read.active.map((a) => a.type).join(", ")}`;
}

/** The worse of readiness and the first active condition, then the readiness label. */
export function nodeSortValue(read: NodeConditions): string {
  const first = read.active[0];
  const tone =
    first && SEVERITY[first.tone] < SEVERITY[read.ready.tone]
      ? first.tone
      : read.ready.tone;
  return severitySortValue(tone, read.ready.label);
}

function NodeCard(props: { name: string; read: NodeConditions }) {
  const { name, read } = props;
  const now = useNow();
  const tones = new Map<NodeCondition, Tone>();
  for (const a of read.active) if (a.condition) tones.set(a.condition, a.tone);
  const cordoned = read.active.some((a) => a.condition === null);
  return (
    <div className={styles.body} data-testid="status-card">
      <div className={styles.title}>{`${name} — conditions`}</div>
      {read.conditions.map((c) => {
        const text = `${c.type} ${c.status ?? "Unknown"}`;
        const tone = c.type === "Ready" ? read.ready.tone : tones.get(c);
        return (
          <div key={c.type} className={styles.line}>
            <span className={styles.state}>
              {tone ? (
                <Badge tone={tone}>{text}</Badge>
              ) : (
                <span className={styles.inactive}>{text}</span>
              )}
            </span>
            <span className={styles.count}>
              {formatAge(c.lastTransitionTime, now)}
            </span>
            <span className={styles.detail}>{conditionDetail(c)}</span>
          </div>
        );
      })}
      {cordoned && (
        <div className={styles.line}>
          <span className={styles.state}>
            <Badge tone="warn">{SCHEDULING_DISABLED}</Badge>
          </span>
          <span className={styles.count}>-</span>
          <span className={styles.detail}>spec.unschedulable is true</span>
        </div>
      )}
      <div className={styles.note}>
        The time is how long each condition has had its status.
      </div>
    </div>
  );
}

function NodeStatusCell(props: { node: KubeObject }) {
  const read = nodeConditions(props.node);
  const summary = nodeSummary(read);
  const [first, ...rest] = read.active;
  return (
    <Tooltip
      variant="card"
      label={summary}
      content={<NodeCard name={props.node.metadata.name} read={read} />}
    >
      <span
        className={styles.status}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the Status card opens on keyboard focus (spec N15).
        tabIndex={0}
        role="img"
        aria-label={summary}
        data-testid="status-cell"
      >
        <Badge tone={read.ready.tone}>{read.ready.label}</Badge>
        {first && <Badge tone={first.tone}>{first.type}</Badge>}
        {rest.length > 0 && (
          <span className={styles.more}>{`+${rest.length}`}</span>
        )}
      </span>
    </Tooltip>
  );
}

/** The Status column of the Node list (spec N11–N15). */
export function nodeStatusColumn(): TableColumn<KubeObject> {
  return {
    id: "status",
    header: "Status",
    width: 280,
    sortValue: (o) => nodeSortValue(nodeConditions(o)),
    filter: { text: (o) => nodeSummary(nodeConditions(o)) },
    render: (o) => <NodeStatusCell node={o} />,
  };
}
