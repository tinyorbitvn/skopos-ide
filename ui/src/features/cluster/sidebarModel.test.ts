import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import { crdTree } from "../../kinds/crdTree";
import { NAV_SCREENS, NAV_SECTIONS, type NavSection } from "../../kinds/nav";
import {
  clusterPath,
  itemPath,
  itemTestId,
  kindTestId,
  looseItems,
  openTabPaths,
  screenTestId,
  sectionActive,
  sidebarGroups,
} from "./sidebarModel";

function info(group: string, plural: string, kind = plural): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

function section(id: string): NavSection {
  const found = NAV_SECTIONS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
}

test("the groups after the screens hold the served sections in order, and empty groups drop", () => {
  const groups = sidebarGroups(
    [info("", "pods"), info("", "nodes"), info("apps", "deployments")],
    [],
  );
  expect(
    groups.map((g) => [g.group.id, g.group.label, g.sections.map((s) => s.id)]),
  ).toEqual([
    ["apps", "Apps", ["helm"]],
    ["cluster", "Cluster", ["nodes"]],
    ["resources", "Resources", ["workloads", "network"]],
  ]);
});

test("Custom Resources shows for served CRDs even when Definitions is not listable", () => {
  const served = [info("acme.io", "gadgets", "Gadget")];
  const groups = sidebarGroups(served, crdTree(served));
  expect(groups.map((g) => [g.group.id, g.sections.map((s) => s.id)])).toEqual([
    ["apps", ["helm"]],
    ["resources", ["network", "custom"]],
  ]);
  const custom = groups[1]?.sections[1];
  expect([custom?.label, custom?.items]).toEqual(["Custom Resources", []]);
});

test("links have the paths and test ids of today's sidebar", () => {
  expect(clusterPath("c 1", "")).toBe("/cluster/c%201");
  expect(clusterPath("c1", "map")).toBe("/cluster/c1/map");
  expect(
    itemPath("c1", {
      type: "route",
      label: "Port Forwarding",
      path: "port-forwards",
    }),
  ).toBe("/cluster/c1/port-forwards");
  expect(
    itemPath("c1", {
      type: "resource",
      label: "Pods",
      group: "",
      plural: "pods",
    }),
  ).toBe("/cluster/c1/r/core/pods");
  expect(kindTestId("", "pods")).toBe("nav-item-core-pods");
  expect(kindTestId("acme.io", "gadgets")).toBe("nav-item-acme.io-gadgets");
  expect(
    itemTestId({ type: "route", label: "Charts", path: "helm/charts" }),
  ).toBe("nav-helm/charts");
  expect(NAV_SCREENS.map(screenTestId)).toEqual(["nav-overview", "nav-map"]);
});

test("the items no branch lists are the section's loose items", () => {
  expect(looseItems(section("argo"))).toEqual([]);
  expect(looseItems(section("workloads"))).toEqual(section("workloads").items);
});

test("a section holds the current page on its items, its overview, its CRDs and their details", () => {
  const crds = crdTree([info("acme.io", "gadgets", "Gadget")]);
  const at = (path: string, id: string) =>
    sectionActive(path, "c1", section(id), crds);
  expect(at("/cluster/c1/r/core/pods", "workloads")).toBe(true);
  expect(at("/cluster/c1/r/core/pods/default/web", "workloads")).toBe(true);
  expect(at("/cluster/c1/workloads", "workloads")).toBe(true);
  expect(at("/cluster/c1/r/core/podsx", "workloads")).toBe(false);
  expect(at("/cluster/c2/r/core/pods", "workloads")).toBe(false);
  expect(at("/cluster/c1/r/acme.io/gadgets", "custom")).toBe(true);
  expect(at("/cluster/c1/r/argoproj.io/applications", "argo")).toBe(true);
  expect(at("/cluster/c1/helm/releases", "helm")).toBe(true);
  expect(at("/cluster/c1", "workloads")).toBe(false);
});

test("the open paths are each tab's shown entry, without query or hash", () => {
  const layout: WindowLayout = {
    label: "main",
    bounds: null,
    panes: [
      {
        id: "p1",
        width: 0.5,
        selected: "t1",
        tabs: [
          {
            id: "t1",
            pinned: false,
            history: [
              "/cluster/c1/r/core/pods",
              "/cluster/c1/r/apps/deployments?object=default%2Fweb",
            ],
            index: 1,
          },
          {
            id: "t2",
            pinned: true,
            history: ["/cluster/c1/map#top"],
            index: 0,
          },
        ],
      },
      {
        id: "p2",
        width: 0.5,
        selected: "t3",
        tabs: [
          {
            id: "t3",
            pinned: false,
            history: ["/cluster/c1/map?focus=default"],
            index: 0,
          },
        ],
      },
    ],
    focusedPane: 0,
  };
  expect([...openTabPaths(layout)]).toEqual([
    "/cluster/c1/r/apps/deployments",
    "/cluster/c1/map",
  ]);
});
