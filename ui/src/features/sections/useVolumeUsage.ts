import { useEffect, useState } from "react";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { VolumeUsage } from "../../ipc/generated/VolumeUsage";

/** How often the Storage overview asks the kubelets again while it is open (spec §6). */
export const VOLUMES_POLL_MS = 30_000;

/** The volume stats of mounted claims (spec §3.6), as the kubelets last reported them. */
export interface VolumeUsageView {
  /** Sorted by namespace, then claim; null before the first answer or after a failed read. */
  items: VolumeUsage[] | null;
  /** No kubelet let us read its summary: there is no access to nodes/proxy. */
  forbidden: boolean;
  /** Why the last read failed, when it failed for another reason; else null. */
  error: string | null;
}

const WAITING: VolumeUsageView = { items: null, forbidden: false, error: null };
/** No node to ask (R8): no Pod under the selection mounts a claim. */
const NONE: VolumeUsageView = { items: [], forbidden: false, error: null };

/**
 * A forbidden read has the code the disk read gives (`Forbidden`); its message is the
 * volume read's own, so only the code is read, as `useNodesDisk` does.
 */
function isForbidden(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === "object" &&
    "code" in e &&
    String((e as { code: unknown }).code).toLowerCase() === "forbidden"
  );
}

/**
 * Reads the volume stats of the claims mounted on `nodes` now and every 30 s while the
 * window shows, as `useNodesDisk` reads the disks. No node asks nothing and reads as no
 * item (R8). The nodes go by value, so a list update that keeps the same nodes does not
 * start over. A poll is skipped while the last read is under way, and a hidden window asks
 * nothing until it shows again.
 */
export function useVolumeUsage(
  clusterId: string,
  nodes: readonly string[],
): VolumeUsageView {
  const key = nodes.join("\n");
  const [view, setView] = useState<VolumeUsageView>(WAITING);
  useEffect(() => {
    if (key === "") return;
    const wanted = key.split("\n");
    let alive = true;
    let reading = false;
    // A poll fell while the window was hidden.
    let missed = false;
    const read = () => {
      if (reading) return;
      if (document.visibilityState !== "visible") {
        missed = true;
        return;
      }
      missed = false;
      reading = true;
      api
        .volumesUsage(clusterId, wanted)
        .then((snapshot) => {
          if (!alive) return;
          setView({ items: snapshot.items, forbidden: false, error: null });
        })
        .catch((e: unknown) => {
          if (!alive) return;
          const forbidden = isForbidden(e);
          setView({
            items: null,
            forbidden,
            error: forbidden ? null : failureMessage(e),
          });
        })
        .finally(() => {
          reading = false;
        });
    };
    const onVisibility = () => {
      if (missed) read();
    };
    read();
    const timer = setInterval(read, VOLUMES_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clusterId, key]);
  return key === "" ? NONE : view;
}
