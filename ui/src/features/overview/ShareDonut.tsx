import { UsageDonut } from "../../design";
import type { UsageTone } from "../../design/UsageDonut";

/** A share in percent: one decimal below 10 %, whole from 10 %; null without a total. */
export function sharePct(amount: number, total: number | null): number | null {
  if (
    total === null ||
    !(total > 0) ||
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    return null;
  }
  const pct = (amount / total) * 100;
  return pct < 10 ? Math.round(pct * 10) / 10 : Math.round(pct);
}

/**
 * A 36 px donut of a share of the cluster (spec §3.5), its percentage in the middle. The caller
 * names it; the amounts it passes to the donut only mark the share as known. `level` fixes the
 * arc's tone in place of the 80 % / 95 % rule.
 */
export function ShareDonut(props: {
  pct: number | null;
  label: string;
  level?: UsageTone;
}) {
  const known = props.pct !== null;
  return (
    <UsageDonut
      name="Share"
      label={props.label}
      pct={props.pct}
      used={known ? String(props.pct) : null}
      total={known ? "100" : null}
      unit="%"
      size={36}
      bare
      tone={props.level}
    />
  );
}
