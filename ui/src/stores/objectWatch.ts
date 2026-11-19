import { useEffect, useMemo, useRef, useState } from "react";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { WatchStatus } from "../ipc/generated/WatchStatus";
import { type KubeObject, objectKey } from "../kinds/objects";
import { rowsAreTrimmed, useHeldList, useObjectWatch } from "./resources";

export interface WatchedObject {
  /** The object; undefined while it loads, when it does not exist and once deleted. */
  object: KubeObject | undefined;
  /**
   * Set when `object` is a list row of a kind whose rows are trimmed: read only the
   * fields such a row keeps, or fetch the object.
   */
  trimmed: boolean;
  /** "list" for a row of a list the store already has, "object" for a single-object watch. */
  source: "list" | "object" | null;
  loading: boolean;
  /** `forbidden` and `notServed` are final, as for a list. */
  status: WatchStatus;
  message: string | null;
}

const NOTHING: WatchedObject = {
  object: undefined,
  trimmed: false,
  source: null,
  loading: false,
  status: "syncing",
  message: null,
};

/**
 * One object, kept live without a watch of its whole resource. While the list store
 * has a list of the resource, because a component shows it or it lingers, the object
 * is that list's row, read without holding the list, so the backend sends one stream.
 * Otherwise a single-object watch is held, whose row is the whole object. The source
 * follows the store: a list opened later takes over, and a list dropped hands over to
 * the object watch. While the new source loads, the last answer for the same object
 * stays, so the switch shows no loading.
 */
export function useWatchedObject(
  clusterId: string,
  resource: ResourceRef | null,
  namespace: string | null,
  name: string | null,
): WatchedObject {
  const wanted = resource !== null && name !== null;
  const scoped = resource?.namespaced ? namespace : null;
  const key = wanted
    ? JSON.stringify([clusterId, resource.group, resource.plural, scoped, name])
    : null;
  const held = useHeldList(clusterId, wanted ? resource : null);
  // A list refused as a whole has no row to give, while a watch of the one object may
  // still be allowed (RBAC scoped to its namespace, say), so it counts as no list.
  const list = held?.status === "forbidden" ? null : held;
  // A list that a parent opens in the same commit, as a screen opened with its drawer
  // does, is in the store only once that commit's effects ran. The object watch waits
  // for them, so it does not start for an object such a list holds.
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => setSettled(key), [key]);
  const watching = wanted && list === null && settled === key;
  const watch = useObjectWatch(
    clusterId,
    watching ? resource : null,
    scoped,
    name,
  );
  const state = list ?? watch;
  const rowKey = `${scoped ?? ""}/${name ?? ""}`;
  const object = useMemo(
    () => state.items.find((o) => objectKey(o) === rowKey),
    [state.items, rowKey],
  );
  // The last loaded answer, kept only while the same object is asked for.
  const last = useRef<{ key: string; answer: WatchedObject } | null>(null);
  if (last.current?.key !== key) last.current = null;
  if (key === null || !wanted) return NOTHING;

  const answer: WatchedObject = {
    object,
    trimmed: list !== null && rowsAreTrimmed(resource),
    source: list !== null ? "list" : "object",
    loading: list === null && !watching ? true : state.loading,
    status: state.status,
    message: state.message,
  };
  if (!answer.loading) last.current = { key, answer };
  return answer.loading && last.current ? last.current.answer : answer;
}
