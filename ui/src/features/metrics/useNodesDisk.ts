import { useEffect, useState } from "react";
import { api } from "../../ipc/api";
import type { NodeDisk } from "../../ipc/generated/NodeDisk";

/** How often the Nodes list asks the kubelets again while it is open. */
export const NODES_DISK_POLL_MS = 30_000;

/** The root filesystem of each node the list shows, from its kubelet's Summary API. */
export interface DiskView {
  /** By node name; null before the first answer or after an error. */
  items: Map<string, NodeDisk> | null;
  /** No node let us read its summary: there is no access to nodes/proxy. */
  forbidden: boolean;
}

export const NO_ACCESS_TIP =
  "No access to nodes/proxy, where kubelets report disk use";

function isForbidden(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === "object" &&
    "code" in e &&
    String((e as { code: unknown }).code).toLowerCase() === "forbidden"
  );
}

/**
 * Reads the disk of `names` now and every 30 s while the window shows; undefined while
 * there are no names (any list but Nodes). The names go by value, so a watch event that
 * keeps the same nodes does not start over. One read asks every kubelet, so a poll is
 * skipped while the last one is still under way, and a hidden window asks nothing until
 * it shows again.
 */
export function useNodesDisk(
  clusterId: string,
  names: string[] | null,
): DiskView | undefined {
  const key = names === null ? null : names.join("\n");
  const [view, setView] = useState<DiskView>({ items: null, forbidden: false });
  useEffect(() => {
    if (key === null || key === "") return;
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
        .nodesDiskUsage(clusterId, wanted)
        .then((snapshot) => {
          if (!alive) return;
          setView({
            items: new Map(snapshot.items.map((i) => [i.name, i])),
            forbidden: false,
          });
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setView({ items: null, forbidden: isForbidden(e) });
        })
        .finally(() => {
          reading = false;
        });
    };
    const onVisibility = () => {
      if (missed) read();
    };
    read();
    const timer = setInterval(read, NODES_DISK_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clusterId, key]);
  return key === null ? undefined : view;
}
