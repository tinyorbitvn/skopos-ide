import styles from "./UsageDonut.module.css";

/** At this share the used arc turns to the warning tone, and at the next to the critical one. */
export const USAGE_WARN_AT = 80;
export const USAGE_CRITICAL_AT = 95;

export type UsageTone = "nominal" | "warning" | "critical";

/** The tone of a share: nominal below 80 %, warning from 80 %, critical from 95 %. */
export function usageTone(pct: number): UsageTone {
  if (pct >= USAGE_CRITICAL_AT) return "critical";
  if (pct >= USAGE_WARN_AT) return "warning";
  return "nominal";
}

/** The share's size in px: 20 on a donut from 90 px, 15 from 60, 11 from 40, else 10. */
export function donutFontPx(size: number): number {
  if (size >= 90) return 20;
  if (size >= 60) return 15;
  if (size >= 40) return 11;
  return 10;
}

const VIEW = 100;
const CENTER = VIEW / 2;
const RADIUS = 40;
const STROKE = 12;
const CIRCLE = 2 * Math.PI * RADIUS;
const DASH = "—";

export interface UsageDonutProps {
  /** Such as "CPU" or "Memory". */
  name: string;
  /** The whole percent of the total that is used; null when it is unknown. */
  pct: number | null;
  /** The used and total amounts as they read, such as "2.5" and "4"; null when unknown. */
  used: string | null;
  total: string | null;
  /** Such as "cores" or "GiB". */
  unit: string;
  /** Width and height in px. */
  size: number;
  testId?: string;
  /** The svg's accessible name, in place of "<name> <pct>%, <used> of <total> <unit>". */
  label?: string;
  /** Leaves out the caption, for a caller that draws its own text or none. */
  bare?: boolean;
}

/** The share and its amounts, or null when any of them is unknown or not a number. */
function known(
  props: UsageDonutProps,
): { pct: number; used: string; total: string } | null {
  const { pct, used, total } = props;
  if (
    pct === null ||
    !Number.isFinite(pct) ||
    used === null ||
    total === null
  ) {
    return null;
  }
  return { pct, used, total };
}

/**
 * Usage against a total (chart style 1, topology spec §4.3): a donut with its share in the
 * middle and its values beside it. The track is drawn, then the used arc from the top,
 * clockwise, in the tone of its level. Without a share only the track is drawn, and both
 * the middle and the values read "—".
 */
export function UsageDonut(props: UsageDonutProps) {
  const { name, unit, size } = props;
  const share = known(props);
  const arc = share === null ? 0 : Math.min(100, Math.max(0, share.pct)) / 100;
  // The share's size in px, in the viewBox's units.
  const fontSize = (donutFontPx(size) * VIEW) / size;
  return (
    <div
      className={styles.donut}
      data-testid={props.testId}
      data-tone={share === null ? undefined : usageTone(share.pct)}
    >
      <svg
        className={styles.chart}
        role="img"
        aria-label={
          props.label ??
          (share === null
            ? `${name} unknown`
            : `${name} ${share.pct}%, ${share.used} of ${share.total} ${unit}`)
        }
        width={size}
        height={size}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
      >
        <circle
          className={styles.track}
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          strokeWidth={STROKE}
        />
        {arc > 0 ? (
          <circle
            className={styles.arc}
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            strokeWidth={STROKE}
            strokeDasharray={`${arc * CIRCLE} ${CIRCLE}`}
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
          />
        ) : null}
        <text
          className={styles.pct}
          x={CENTER}
          y={CENTER}
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fontSize: `${fontSize}px` }}
        >
          {share === null ? DASH : `${share.pct}%`}
        </text>
      </svg>
      {props.bare ? null : (
        <div className={styles.caption} aria-hidden="true">
          <span className={styles.name}>{name}</span>
          <span className={styles.values}>
            {share === null ? DASH : `${share.used} / ${share.total} ${unit}`}
          </span>
        </div>
      )}
    </div>
  );
}
