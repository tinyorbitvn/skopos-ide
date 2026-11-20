/** The node topology of a cluster (topology spec §3.2). */
export function topologyPath(clusterId: string): string {
  return `/cluster/${encodeURIComponent(clusterId)}/node-topology`;
}
