import { isValidElement } from "react";
import { expect, test } from "vitest";
import {
  Blocks,
  HardDrive,
  LayoutGrid,
  List,
  Namespace,
  Network,
  Server,
  Settings,
  ShieldCheck,
} from "../../design/icons";
import { ReachabilityScreen } from "../../features/network/ReachabilityScreen";
import { NamespacesOverview } from "../../features/sections/NamespacesOverview";
import { NetworkOverview } from "../../features/sections/NetworkOverview";
import { NodesOverview } from "../../features/sections/NodesOverview";
import { StorageOverview } from "../../features/sections/StorageOverview";
import { WorkloadsOverview } from "../../features/workloads/WorkloadsOverview";
import { NAV_SECTIONS } from "../../kinds/nav";
import { clusterEntry } from "../../test/ipc";
import { isTabRoute, tabInfo, tabRoutes } from "./routes";

const CLUSTERS = [clusterEntry({ id: "kind-a", contextName: "kind-a" })];

test("every screen of today's route table is a tab route, with its query", () => {
  for (const path of [
    "/",
    "/catalog",
    "/preferences",
    "/cluster/kind-a",
    "/cluster/kind-a/workloads",
    "/cluster/kind-a/nodes",
    "/cluster/kind-a/namespaces",
    "/cluster/kind-a/network",
    "/cluster/kind-a/storage",
    "/cluster/kind-a/r/apps/deployments?ns=default",
    "/cluster/kind-a/port-forwards",
    "/cluster/kind-a/helm/charts",
    "/cluster/kind-a/helm/releases",
    "/cluster/kind-a/helm/install",
    "/cluster/kind-a/helm/upgrade/default/web",
    "/cluster/kind-a/settings",
    "/cluster/kind-a/map?object=x",
    "/cluster/kind-a/node-topology?q=worker&ns=shop",
    "/cluster/kind-a/network/reachability?ns=payments",
  ]) {
    expect(isTabRoute(path), path).toBe(true);
  }
});

test("the Workspace and unknown paths are no tab routes (P6)", () => {
  for (const path of [
    "/workspace",
    "/cluster/kind-a/nope",
    "/cluster/kind-a/r/apps",
    "/catalog/x",
    "",
    "catalog",
  ]) {
    expect(isTabRoute(path), path).toBe(false);
  }
});

test("a cluster tab's title is the screen, then the cluster (P9)", () => {
  expect(tabInfo("/cluster/kind-a/r/apps/deployments?ns=x", CLUSTERS)).toEqual({
    title: "Deployments · kind-a",
    screen: "Deployments",
    clusterId: "kind-a",
    clusterName: "kind-a",
    icon: List,
  });
  expect(tabInfo("/cluster/kind-a", CLUSTERS).title).toBe("Overview · kind-a");
  expect(tabInfo("/cluster/kind-a/r/core/pods", CLUSTERS).screen).toBe("Pods");
  expect(tabInfo("/cluster/kind-a/map", CLUSTERS).screen).toBe("Resource map");
  expect(tabInfo("/cluster/kind-a/settings", CLUSTERS).screen).toBe("Settings");
  expect(tabInfo("/cluster/kind-a/helm/upgrade/ns/web", CLUSTERS).screen).toBe(
    "Upgrade web",
  );
  expect(
    tabInfo("/cluster/kind-a/node-topology?ns=shop", CLUSTERS),
  ).toMatchObject({
    title: "Topology · kind-a",
    screen: "Topology",
    icon: LayoutGrid,
  });
  expect(
    tabInfo("/cluster/kind-a/network/reachability?ns=payments", CLUSTERS),
  ).toMatchObject({
    title: "Reachability · kind-a",
    screen: "Reachability",
    icon: ShieldCheck,
  });
});

test("a section overview's tab is named after its page, with its section's icon (spec §3.7)", () => {
  expect(
    ["workloads", "nodes", "namespaces", "network", "storage"].map((page) => {
      const info = tabInfo(`/cluster/kind-a/${page}`, CLUSTERS);
      return [info.title, info.screen, info.clusterId, info.icon];
    }),
  ).toEqual([
    ["Workloads overview · kind-a", "Workloads overview", "kind-a", Blocks],
    ["Nodes overview · kind-a", "Nodes overview", "kind-a", Server],
    [
      "Namespaces overview · kind-a",
      "Namespaces overview",
      "kind-a",
      Namespace,
    ],
    ["Network overview · kind-a", "Network overview", "kind-a", Network],
    ["Storage overview · kind-a", "Storage overview", "kind-a", HardDrive],
  ]);
});

test("each overview route shows its page, and every sidebar Overview has one", () => {
  const cluster = tabRoutes().find((route) => route.path === "cluster/:id");
  const page = (path: string) => {
    const element = cluster?.children?.find((c) => c.path === path)?.element;
    return isValidElement(element) ? element.type : null;
  };
  expect(page("workloads")).toBe(WorkloadsOverview);
  expect(page("nodes")).toBe(NodesOverview);
  expect(page("namespaces")).toBe(NamespacesOverview);
  expect(page("network")).toBe(NetworkOverview);
  expect(page("storage")).toBe(StorageOverview);
  expect(page("network/reachability")).toBe(ReachabilityScreen);
  for (const section of NAV_SECTIONS) {
    if (section.overview === undefined) continue;
    expect([section.id, page(section.overview) === null]).toEqual([
      section.id,
      false,
    ]);
  }
});

test("a custom resource the sidebar does not list is named by its plural", () => {
  expect(tabInfo("/cluster/kind-a/r/e2e.test/widgets", CLUSTERS).screen).toBe(
    "widgets",
  );
});

test("a cluster that is not in the catalog is named Cluster", () => {
  const info = tabInfo("/cluster/gone/workloads", CLUSTERS);
  expect(info.clusterId).toBe("gone");
  expect(info.clusterName).toBe("Cluster");
  expect(info.title).toBe("Workloads overview · Cluster");
});

test("Catalog and Preferences tabs have no cluster", () => {
  expect(tabInfo("/catalog", CLUSTERS)).toEqual({
    title: "Catalog",
    screen: "Catalog",
    clusterId: null,
    clusterName: null,
    icon: LayoutGrid,
  });
  expect(tabInfo("/preferences", CLUSTERS)).toMatchObject({
    title: "Preferences",
    clusterId: null,
    icon: Settings,
  });
});

test("a cluster id with escaped characters is decoded", () => {
  const id = "arn:aws:eks:eu/prod";
  const info = tabInfo(`/cluster/${encodeURIComponent(id)}/workloads`, [
    clusterEntry({ id, contextName: "prod" }),
  ]);
  expect(info.clusterId).toBe(id);
  expect(info.title).toBe("Workloads overview · prod");
});
