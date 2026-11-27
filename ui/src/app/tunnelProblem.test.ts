import { expect, test } from "vitest";
import type { ClusterInfo } from "../ipc/generated/ClusterInfo";
import { clusterEntry } from "../test/ipc";
import { tunnel } from "../test/tunnels";
import { tunnelProblem } from "./tunnelProblem";

const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: [],
  namespacesRestricted: false,
  isAdmin: true,
};
const FAILED = tunnel({
  state: { status: "failed", message: "the proxy answered 403 Forbidden" },
});

test("a connected cluster whose tunnel failed gets the badge with the reason", () => {
  const cluster = clusterEntry({
    tunnel: "t1",
    state: { status: "connected", info: INFO },
  });
  expect(tunnelProblem(cluster, [FAILED])).toEqual({
    label: "Tunnel failed",
    tone: "danger",
    detail: 'Tunnel "corp": the proxy answered 403 Forbidden',
  });
});

test("no badge while disconnected, without a tunnel, or while the tunnel is not failed", () => {
  const connected = { status: "connected", info: INFO } as const;
  expect(tunnelProblem(clusterEntry({ tunnel: "t1" }), [FAILED])).toBeNull();
  expect(
    tunnelProblem(clusterEntry({ tunnel: null, state: connected }), [FAILED]),
  ).toBeNull();
  expect(
    tunnelProblem(clusterEntry({ tunnel: "gone", state: connected }), [FAILED]),
  ).toBeNull();
  expect(
    tunnelProblem(clusterEntry({ tunnel: "t1", state: connected }), null),
  ).toBeNull();
  for (const state of [
    { status: "idle" },
    { status: "starting" },
    { status: "up", since: 0 },
  ] as const) {
    expect(
      tunnelProblem(clusterEntry({ tunnel: "t1", state: connected }), [
        tunnel({ state }),
      ]),
    ).toBeNull();
  }
});
