import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";

/** A kind the cluster serves, under one of its API versions. */
export interface ServedKind {
  apiVersion: string;
  kind: string;
}

/** Each served kind and version once, in the order discovery gave them. */
export function servedKinds(resources: ApiResourceInfo[]): ServedKind[] {
  const seen = new Set<string>();
  const kinds: ServedKind[] = [];
  for (const { resource } of resources) {
    const apiVersion = resource.group
      ? `${resource.group}/${resource.version}`
      : resource.version;
    const key = `${apiVersion} ${resource.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kinds.push({ apiVersion, kind: resource.kind });
  }
  return kinds;
}

/** Whether the cluster serves the kind. Every kind counts while the list is not known (spec T4). */
export function isServed(
  served: ServedKind[],
  apiVersion: string,
  kind: string,
): boolean {
  return (
    served.length === 0 ||
    served.some((s) => s.apiVersion === apiVersion && s.kind === kind)
  );
}
