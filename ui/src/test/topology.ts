import { act } from "@testing-library/react";
import type { PodState } from "../ipc/generated/PodState";
import type { TopologyEvent } from "../ipc/generated/TopologyEvent";
import type { TopologyNode } from "../ipc/generated/TopologyNode";
import type { TopologyPod } from "../ipc/generated/TopologyPod";
import type { TopologyRegion } from "../ipc/generated/TopologyRegion";
import type { TopologySnapshot } from "../ipc/generated/TopologySnapshot";
import type { TopologyZone } from "../ipc/generated/TopologyZone";
import { type Backend, flush, mockBackend } from "./ipc";

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

export interface TopologyBackend {
  backend: Backend;
  /** The subscription ids still open, oldest first. */
  open(): string[];
  /**
   * Sends an event on one open subscription, or on every open one, and lets it render.
   * A failure ends the subscriptions it is sent on, as the backend does.
   */
  send(event: TopologyEvent, subscriptionId?: string): Promise<void>;
}

/**
 * A backend whose topology subscriptions answer `t1`, `t2`… and keep their channels, so a
 * test can send snapshots and failures. `extra` adds other handlers.
 */
export function topologyBackend(
  extra: Parameters<typeof mockBackend>[0] = {},
): TopologyBackend {
  const channels = new Map<string, (event: TopologyEvent) => void>();
  const open = new Set<string>();
  let seq = 0;
  const backend = mockBackend({
    node_topology_subscribe: (a: {
      onEvent: { onmessage: (event: TopologyEvent) => void };
    }) => {
      seq += 1;
      const id = `t${seq}`;
      channels.set(id, a.onEvent.onmessage);
      open.add(id);
      return id;
    },
    node_topology_unsubscribe: (a: { subscriptionId: string }) => {
      open.delete(a.subscriptionId);
      return null;
    },
    ...extra,
  });
  return {
    backend,
    open: () => [...open],
    send: async (event, subscriptionId) => {
      await act(async () => {
        for (const id of [...open]) {
          if (subscriptionId !== undefined && id !== subscriptionId) continue;
          channels.get(id)?.(event);
          if (event.type === "failure") open.delete(id);
        }
        await flush();
      });
    },
  };
}

export function tpod(
  namespace: string,
  name: string,
  state: PodState = "Running",
  status: string = state,
): TopologyPod {
  return { namespace, name, state, status };
}

/** A Ready node of 4 cores, 16 GiB and 110 pods, with no labels, pods or requests. */
export function tnode(
  name: string,
  over: Partial<TopologyNode> = {},
): TopologyNode {
  return {
    name,
    labels: {},
    roles: [],
    ready: "Ready",
    unschedulable: false,
    taints: [],
    conditions: [],
    allocatable: { cpuMillis: 4000, memoryBytes: 16 * GIB, pods: 110 },
    requests: { cpuMillis: 0, memoryBytes: 0, pods: null },
    pods: [],
    ...over,
  };
}

export function tzone(
  name: string | null,
  nodes: TopologyNode[],
): TopologyZone {
  return { name, nodes };
}

/** A region whose counts are those of its zones' nodes and pods. */
export function tregion(
  name: string | null,
  zones: TopologyZone[],
): TopologyRegion {
  const nodes = zones.flatMap((z) => z.nodes);
  return {
    name,
    zones,
    nodeCount: nodes.length,
    podCount: nodes.reduce((sum, n) => sum + n.pods.length, 0),
  };
}

export function tsnapshot(
  regions: TopologyRegion[],
  podsHidden = false,
): TopologySnapshot {
  return {
    regions,
    nodeCount: regions.reduce((sum, r) => sum + r.nodeCount, 0),
    podCount: regions.reduce((sum, r) => sum + r.podCount, 0),
    podsHidden,
  };
}
