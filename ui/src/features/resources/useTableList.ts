import { useRef } from "react";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  type ResourceListState,
  useResourceList,
} from "../../stores/resources";

/** A list that is not asked for yet, as the saved choice of namespaces is still read. */
export const WAITING: ResourceListState = {
  items: [],
  status: "syncing",
  message: null,
  loading: true,
};

/**
 * A table's list: the objects of `namespaces`, or of every namespace when none is
 * chosen. The backend is asked for the chosen namespaces only, so the list starts once
 * `ready` says the saved choice was read, and never with every namespace first. While
 * the list of a new choice loads, the rows of the one before stay for the table to
 * filter, so it does not blink.
 */
export function useTableList(
  clusterId: string,
  resource: ResourceRef,
  namespaces: readonly string[],
  ready: boolean,
): ResourceListState {
  const list = useResourceList(clusterId, ready ? resource : null, namespaces);
  const shown = `${clusterId}/${resource.group}/${resource.plural}`;
  const last = useRef<{ shown: string; list: ResourceListState } | null>(null);
  if (last.current?.shown !== shown) last.current = null;
  if (!ready) return WAITING;
  if (!list.loading) last.current = { shown, list };
  return list.loading && last.current ? last.current.list : list;
}
