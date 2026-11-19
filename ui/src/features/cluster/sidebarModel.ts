import { tabPath } from "../../app/tabs/layout";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { WindowLayout } from "../../ipc/generated/WindowLayout";
import type { CrdDomainRow } from "../../kinds/crdTree";
import {
  groupSegment,
  NAV_GROUPS,
  NAV_SECTIONS,
  type NavGroup,
  type NavItem,
  type NavScreen,
  type NavSection,
  navItemKey,
  resourcePath,
  visibleSections,
} from "../../kinds/nav";

/** A labelled group of the sidebar and its visible sections (spec Q §2). */
export interface SidebarGroup {
  group: NavGroup;
  sections: NavSection[];
}

/**
 * The groups after the first, which holds `NAV_SCREENS`: each with the sections the
 * cluster serves something for. Custom Resources shows while CRDs are served, even
 * without list access to Definitions. A group with no section drops.
 */
export function sidebarGroups(
  resources: ApiResourceInfo[],
  crds: CrdDomainRow[],
): SidebarGroup[] {
  const sections = visibleSections(resources);
  const custom = NAV_SECTIONS.find((s) => s.id === "custom");
  if (
    custom !== undefined &&
    crds.length > 0 &&
    !sections.some((s) => s.id === "custom")
  ) {
    sections.push({ ...custom, items: [] });
  }
  return NAV_GROUPS.filter((g) => g.id !== "top")
    .map((group) => ({
      group,
      sections: sections.filter((s) => s.group === group.id),
    }))
    .filter((g) => g.sections.length > 0);
}

/** A screen of the cluster: `""` is its home. */
export function clusterPath(clusterId: string, path: string): string {
  const base = `/cluster/${encodeURIComponent(clusterId)}`;
  return path === "" ? base : `${base}/${path}`;
}

export function itemPath(clusterId: string, item: NavItem): string {
  return item.type === "route"
    ? clusterPath(clusterId, item.path)
    : resourcePath(clusterId, item.group, item.plural);
}

export function kindTestId(group: string, plural: string): string {
  return `nav-item-${groupSegment(group)}-${plural}`;
}

export function itemTestId(item: NavItem): string {
  return item.type === "route"
    ? `nav-${item.path}`
    : kindTestId(item.group, item.plural);
}

export function screenTestId(screen: NavScreen): string {
  return `nav-${screen.id}`;
}

/** The items of a section that none of its branches lists. */
export function looseItems(section: NavSection): NavItem[] {
  const branched = new Set(
    (section.branches ?? []).flatMap((b) => b.items.map(navItemKey)),
  );
  return section.items.filter((i) => !branched.has(navItemKey(i)));
}

/** True on `path` itself and on the locations under it, such as a detail page. */
export function isAt(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Every location a section links to: its items, its overview and, for Custom Resources, its CRDs. */
export function sectionPaths(
  clusterId: string,
  section: NavSection,
  crds: CrdDomainRow[],
): string[] {
  const paths = section.items.map((i) => itemPath(clusterId, i));
  if (section.overview !== undefined) {
    paths.push(clusterPath(clusterId, section.overview));
  }
  if (section.id === "custom") {
    for (const row of crds) {
      for (const i of [...row.items, ...row.groups.flatMap((g) => g.items)]) {
        paths.push(resourcePath(clusterId, i.group, i.plural));
      }
    }
  }
  return paths;
}

/** True when the page on screen is one of the section's, or under one. */
export function sectionActive(
  pathname: string,
  clusterId: string,
  section: NavSection,
  crds: CrdDomainRow[],
): boolean {
  return sectionPaths(clusterId, section, crds).some((p) => isAt(pathname, p));
}

/** The location each tab of the window shows, without its query or hash (spec Q §2). */
export function openTabPaths(layout: WindowLayout): Set<string> {
  const paths = new Set<string>();
  for (const pane of layout.panes) {
    for (const tab of pane.tabs) paths.add(tabPath(tab).replace(/[?#].*$/, ""));
  }
  return paths;
}

/** A link of a rail flyout. */
export interface FlyoutLinkEntry {
  type: "link";
  key: string;
  label: string;
  path: string;
  testId: string;
  /** Active on the path only, not under it: the Workloads Overview. */
  end?: boolean;
}

/** A caption of a rail flyout: a branch or an API group above its kinds. */
export interface FlyoutCaptionEntry {
  type: "caption";
  key: string;
  label: string;
}

export type FlyoutEntry = FlyoutLinkEntry | FlyoutCaptionEntry;

export function railItemTestId(item: NavItem): string {
  return item.type === "route"
    ? `rail-item-${item.path}`
    : `rail-item-${groupSegment(item.group)}-${item.plural}`;
}

/**
 * What a section's flyout lists (spec Q §3): its Overview and loose items, each branch
 * under a caption with its label, and for Custom Resources each domain and API group
 * under a caption with its full name.
 */
export function flyoutEntries(
  clusterId: string,
  section: NavSection,
  crds: CrdDomainRow[],
): FlyoutEntry[] {
  const link = (item: NavItem): FlyoutLinkEntry => {
    const path = itemPath(clusterId, item);
    return {
      type: "link",
      key: `link:${path}`,
      label: item.label,
      path,
      testId: railItemTestId(item),
    };
  };
  const kind = (i: { label: string; group: string; plural: string }) =>
    link({
      type: "resource",
      label: i.label,
      group: i.group,
      plural: i.plural,
    });
  const entries: FlyoutEntry[] = [];
  if (section.overview !== undefined) {
    entries.push({
      type: "link",
      key: "overview",
      label: "Overview",
      path: clusterPath(clusterId, section.overview),
      testId: `rail-item-overview-${section.overview}`,
      end: true,
    });
  }
  entries.push(...looseItems(section).map(link));
  for (const b of section.branches ?? []) {
    entries.push(
      { type: "caption", key: `branch:${b.id}`, label: b.label },
      ...b.items.map(link),
    );
  }
  if (section.id === "custom") {
    for (const row of crds) {
      entries.push(
        { type: "caption", key: `domain:${row.domain}`, label: row.label },
        ...row.items.map(kind),
      );
      for (const g of row.groups) {
        entries.push(
          { type: "caption", key: `group:${g.group}`, label: g.group },
          ...g.items.map(kind),
        );
      }
    }
  }
  return entries;
}
