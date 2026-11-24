/** The Reachability page of a cluster, on `namespace` when given (network policies R8). */
export function reachabilityPath(
  clusterId: string,
  namespace?: string,
): string {
  const base = `/cluster/${encodeURIComponent(clusterId)}/network/reachability`;
  if (namespace === undefined) return base;
  return `${base}?${new URLSearchParams({ ns: namespace }).toString()}`;
}
