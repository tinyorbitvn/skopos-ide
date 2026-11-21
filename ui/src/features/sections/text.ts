import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";

/** `<namespace>/<name>`, or `/<name>` for a cluster-scoped object: the drawer's `?object=` (R3). */
export { objectKey } from "../../kinds/objects";
/** At most one decimal, without a trailing ".0", for cores and GiB (spec §3.1). */
export { oneDecimal } from "../metrics/format";

const collator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

/** Names in natural order, ignoring case: `node-2` before `node-10` (spec §3.1). */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * Objects by namespace, then by name, both in natural order. A cluster-scoped object has
 * no namespace, so it comes first.
 */
export function byNamespaceName(a: KubeObject, b: KubeObject): number {
  return (
    naturalCompare(a.metadata.namespace ?? "", b.metadata.namespace ?? "") ||
    naturalCompare(a.metadata.name, b.metadata.name)
  );
}

/** A count with thousands commas: 1234 → "1,234" (spec §3.1). */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Up to two names, then how many more (spec §3.1): `a`, `a, b`, `a, b and 3 more`.
 * None gives "", so a caller says `None` itself.
 */
export function someNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} and ${formatCount(names.length - 2)} more`;
}

/** A count and its noun (spec §3.1's `plural`): `1 node`, `12 nodes`, `1,204 pods`. */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * The drawer's `?open=` key of a kind (R3): its plural for the core group (`pods`), else
 * `<plural>.<group>` (`deployments.apps`).
 */
export function openKeyOf(ref: ResourceRef): string {
  return ref.group === "" ? ref.plural : `${ref.plural}.${ref.group}`;
}
