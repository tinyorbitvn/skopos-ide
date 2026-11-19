import { useEffect, useRef, useState } from "react";
import { api } from "../../ipc/api";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { type DrawerTarget, targetKey } from "../../kinds/detail/links";
import type { KubeObject } from "../../kinds/objects";
import { useWatchedObject } from "../../stores/objectWatch";
import { useWholeObject } from "./useWholeObject";

export type DrawerObjectStatus =
  | "loading"
  | "live"
  | "fetched"
  | "deleted"
  | "notFound"
  | "forbidden"
  | "notServed"
  | "error";

export interface DrawerObject {
  status: DrawerObjectStatus;
  /** The object to show: live, fetched, last seen, or null. */
  object: KubeObject | null;
  /** The backend's message for forbidden, notServed and error. */
  message: string | null;
  retry(): void;
}

/** Stands in for a missing resource; `useWholeObject` reads it only with a key. */
const NONE: ResourceRef = {
  group: "",
  version: "",
  plural: "",
  kind: "",
  namespaced: false,
};

const NOOP = () => {};

interface Answer {
  owner: string;
  object: KubeObject | null;
  code: string | null;
  message: string | null;
}

/** One `resourceGet` for the target while `wanted`, again on retry. */
function useOneGet(
  clusterId: string,
  resource: ResourceRef | null,
  target: DrawerTarget | null,
  wanted: boolean,
): { answer: Answer | null; retry(): void } {
  const owner =
    wanted && resource && target
      ? `${clusterId}\n${resource.group}/${resource.plural}\n${targetKey(target)}`
      : "";
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The effect runs on `owner` and `attempt`; it reads the rest here.
  const latest = useRef({ clusterId, resource, target });
  latest.current = { clusterId, resource, target };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the get.
  useEffect(() => {
    const { clusterId: cluster, resource: ref, target: t } = latest.current;
    if (owner === "" || ref === null || t === null) return;
    // Only the answer to the latest request is kept.
    let current = true;
    api.resourceGet(cluster, ref, t.namespace, t.name).then(
      (value) => {
        if (current) {
          setAnswer({
            owner,
            object: value as KubeObject,
            code: null,
            message: null,
          });
        }
      },
      (error) => {
        if (current) {
          setAnswer({
            owner,
            object: null,
            code: error instanceof IpcFailure ? error.code : null,
            message: failureMessage(error),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [owner, attempt]);

  return {
    answer: owner !== "" && answer?.owner === owner ? answer : null,
    retry: () => {
      setAnswer(null);
      setAttempt((a) => a + 1);
    },
  };
}

/**
 * The object a drawer entry shows, and its state (spec H49, H50). A listable kind is
 * read live with `useWatchedObject`: from the list the store already has, so a link to
 * the screen's own kind shares its subscription, or else from a single-object watch.
 * An object a synced list lacks is confirmed with one `resourceGet`; the object watch
 * answers that itself. A kind the user cannot list or watch is read with one
 * `resourceGet`, again on Retry. Secrets come blanked from every read (H53).
 */
export function useDrawerObject(
  clusterId: string,
  info: ApiResourceInfo | undefined,
  target: DrawerTarget | null,
  lastSeen: KubeObject | null,
): DrawerObject {
  const watchedResource =
    info?.canList && target !== null ? info.resource : null;
  const watching = watchedResource !== null;
  const watched = useWatchedObject(
    clusterId,
    watchedResource,
    target?.namespace ?? null,
    target?.name ?? null,
  );
  const usable =
    watching &&
    watched.status !== "forbidden" &&
    watched.status !== "notServed";
  const found = usable ? watched.object : undefined;
  const fromList = usable && watched.source === "list";
  const key = target ? `${target.namespace ?? ""}/${target.name}` : null;
  // A trimmed row lacks what the drawer shows, so the drawer shows the fetched object,
  // or the one it last showed while that has the row's version.
  const whole = useWholeObject(
    clusterId,
    info?.resource ?? NONE,
    fromList && watched.trimmed ? key : null,
    found,
    lastSeen,
  );
  const needGet =
    info !== undefined &&
    target !== null &&
    (!info.canList ||
      watched.status === "forbidden" ||
      (fromList &&
        !watched.loading &&
        found === undefined &&
        lastSeen === null));
  const get = useOneGet(clusterId, info?.resource ?? null, target, needGet);

  const state = (
    status: DrawerObjectStatus,
    object: KubeObject | null = null,
    message: string | null = null,
    retry: () => void = NOOP,
  ): DrawerObject => ({ status, object, message, retry });

  if (target === null) return state("loading");
  if (info === undefined) return state("notServed");
  if (watching && watched.status === "notServed") {
    return state("notServed", null, watched.message);
  }
  if (found) {
    if (!watched.trimmed) return state("live", found);
    if (whole.error) {
      return state("error", whole.object, whole.error, whole.retry);
    }
    return whole.object ? state("live", whole.object) : state("loading");
  }
  if (usable && watched.loading) return state("loading");
  if (usable && lastSeen) return state("deleted", lastSeen);
  // The object watch's empty snapshot already says there is no such object.
  if (usable && !fromList) return state("notFound");
  const answer = get.answer;
  if (answer === null) return state("loading");
  if (answer.object) return state("fetched", answer.object, null, get.retry);
  if (answer.code === "NotFound")
    return state("notFound", null, answer.message);
  if (answer.code === "Forbidden" || answer.code === "Unauthorized") {
    return state("forbidden", null, answer.message, get.retry);
  }
  return state("error", null, answer.message, get.retry);
}
