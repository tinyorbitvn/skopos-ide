import { useMemo } from "react";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { findResource } from "../../stores/resources";
import { useUiState } from "../../stores/uiState";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import {
  type Discovery,
  type KindRow,
  kindRow,
  type ListView,
  listView,
  type WorkloadKind,
} from "../workloads/counts";
import { useListIn } from "../workloads/useListIn";

/**
 * What every list of an overview page shares (R2): the cluster, its discovery, the
 * namespaces chosen in the lists, and whether that choice was read yet. A page builds it
 * once with `useSectionShared` and passes it to one `useSectionView` or `useSectionRow`
 * call per kind, since hooks may not run in a loop.
 */
export type SectionShared = readonly [
  clusterId: string,
  resources: ApiResourceInfo[],
  discovery: Discovery,
  namespaces: string[],
  ready: boolean,
];

const NO_NAMESPACES: string[] = [];

/**
 * The shared part of a page's lists, with the namespaces chosen in the lists (the
 * `namespaces:<clusterId>` UI state that `NamespaceFilter` writes); the page only reads it.
 */
export function useSectionShared(
  clusterId: string,
  resources: ApiResourceInfo[],
  discovery: Discovery,
): SectionShared {
  const [namespaces, , ready] = useUiState<string[]>(
    namespaceFilterKey(clusterId),
    NO_NAMESPACES,
  );
  return useMemo(
    () => [clusterId, resources, discovery, namespaces, ready] as const,
    [clusterId, resources, discovery, namespaces, ready],
  );
}

/**
 * A kind's list as an overview reads it, under the chosen namespaces: the store and the
 * subscription its list screen uses (spec §4.4). `label` names it in the reasons, as "Pods".
 */
export function useSectionView(
  shared: SectionShared,
  label: string,
  group: string,
  plural: string,
): ListView {
  const [clusterId, resources, discovery, namespaces, ready] = shared;
  const info = findResource(resources, group, plural);
  const list = useListIn(clusterId, info, namespaces, ready);
  return useMemo(
    () => listView(label, info, discovery, list, namespaces),
    [label, info, discovery, list, namespaces],
  );
}

/** A workload kind's row, counted as the Workloads overview counts it. */
export function useSectionRow(
  shared: SectionShared,
  kind: WorkloadKind,
): KindRow {
  const [clusterId, resources, discovery, namespaces, ready] = shared;
  const info = findResource(resources, kind.group, kind.plural);
  const list = useListIn(clusterId, info, namespaces, ready);
  return useMemo(
    () => kindRow(kind, info, discovery, list, namespaces),
    [kind, info, discovery, list, namespaces],
  );
}
