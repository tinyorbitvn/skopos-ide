import { LayoutGrid, List, Settings } from "lucide-react";
import { expect, test } from "vitest";
import { clusterEntry } from "../../test/ipc";
import { isTabRoute, tabInfo } from "./routes";

const CLUSTERS = [clusterEntry({ id: "kind-a", contextName: "kind-a" })];

test("every screen of today's route table is a tab route, with its query", () => {
  for (const path of [
    "/",
    "/catalog",
    "/preferences",
    "/cluster/kind-a",
    "/cluster/kind-a/workloads",
    "/cluster/kind-a/r/apps/deployments?ns=default",
    "/cluster/kind-a/port-forwards",
    "/cluster/kind-a/helm/charts",
    "/cluster/kind-a/helm/releases",
    "/cluster/kind-a/helm/install",
    "/cluster/kind-a/helm/upgrade/default/web",
    "/cluster/kind-a/settings",
    "/cluster/kind-a/map?object=x",
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
  expect(info.title).toBe("Workloads · Cluster");
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
  expect(info.title).toBe("Workloads · prod");
});
