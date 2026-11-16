import { type ReactElement, useEffect, useMemo, useRef } from "react";
import {
  EmptyState,
  ErrorNotice,
  Spinner,
  type TableColumn,
  Tabs,
} from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  DrawerLinkContext,
  type DrawerTarget,
  targetKey,
} from "../../kinds/detail/links";
import { DrawerKindContext } from "../../kinds/detail/parts";
import type { KubeObject } from "../../kinds/objects";
import { findResource } from "../../stores/resources";
import { DrawerMap, hasDrawerMap } from "../map/DrawerMap";
import { listLabel } from "../map/model";
import { DrawerMetrics } from "../metrics/DrawerMetrics";
import { metricsTargetOf } from "../metrics/targets";
import { useKindColumns } from "../resources/kindColumns";
import styles from "./DetailDrawer.module.css";
import { OVERVIEW } from "./drawerHistory";
import { EventsSection } from "./EventsSection";
import { OverviewSections } from "./OverviewSections";
import type { DrawerHistoryApi } from "./useDrawerHistory";
import { type DrawerObject, useDrawerObject } from "./useDrawerObject";

/** One of the drawer's tabs, as `Tabs` takes it. */
export interface DrawerTabItem {
  value: string;
  label: string;
  testId: string;
}

const OVERVIEW_TAB: DrawerTabItem = {
  value: OVERVIEW,
  label: "Overview",
  testId: "detail-tab-overview",
};
const METRICS_TAB: DrawerTabItem = {
  value: "metrics",
  label: "Metrics",
  testId: "detail-tab-metrics",
};
const MAP_TAB: DrawerTabItem = {
  value: "map",
  label: "Resource map",
  testId: "detail-tab-map",
};
const EVENTS_TAB: DrawerTabItem = {
  value: "events",
  label: "Events",
  testId: "detail-tab-events",
};

/** A kind the caller knows is served and listable, even when `resources` leaves it out. */
function knownInfo(resource: ResourceRef): ApiResourceInfo {
  return {
    resource,
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: false,
    canUpdate: false,
    canPatch: false,
    canDelete: false,
  };
}

function Body(props: {
  clusterId: string;
  resource: ResourceRef;
  object: KubeObject;
  resources: ApiResourceInfo[];
  columns: readonly TableColumn<KubeObject>[];
  tab: string;
  wide: boolean;
}) {
  const { clusterId, resource, object, resources, columns, tab, wide } = props;
  // The overview stays mounted under the other tabs, so unsaved edits survive a
  // tab switch. The metrics panel polls and the map watches the cluster, so each is
  // mounted only while it is shown.
  return (
    <>
      {tab === "map" ? (
        <DrawerMap
          clusterId={clusterId}
          kind={resource.kind}
          namespace={object.metadata.namespace ?? ""}
          name={object.metadata.name}
        />
      ) : null}
      {tab === "events" ? (
        <EventsSection
          clusterId={clusterId}
          kind={resource.kind}
          object={object}
        />
      ) : null}
      {tab === "metrics" ? (
        <section className={styles.section} data-testid="detail-metrics">
          <DrawerMetrics
            clusterId={clusterId}
            resource={resource}
            object={object}
          />
        </section>
      ) : null}
      <div
        hidden={tab !== OVERVIEW}
        className={wide ? styles.overviewColumns : undefined}
      >
        <OverviewSections
          clusterId={clusterId}
          resource={resource}
          object={object}
          resources={resources}
          columns={columns}
        />
      </div>
    </>
  );
}

/** What the drawer shows in place of an object (spec H50). */
function StateNotice(props: {
  read: DrawerObject;
  kind: string;
  target: DrawerTarget;
}) {
  const { read, kind, target } = props;
  switch (read.status) {
    case "notFound":
      return (
        <div data-testid="detail-not-found">
          <EmptyState
            title={`${kind} not found`}
            body={
              target.namespace
                ? `There is no ${kind} ${target.name} in namespace ${target.namespace}.`
                : `There is no ${kind} ${target.name} in the cluster.`
            }
          />
        </div>
      );
    case "forbidden":
      return (
        <div className={styles.fetchError} data-testid="detail-forbidden">
          <ErrorNotice
            title={`No access to this ${kind}`}
            message={read.message ?? "You do not have permission to read it."}
          />
        </div>
      );
    case "notServed":
      return (
        <div className={styles.fetchError} data-testid="detail-not-served">
          <ErrorNotice
            title={`${kind} objects are not available`}
            message={
              read.message ?? "The cluster does not serve this resource type."
            }
          />
        </div>
      );
    case "loading":
      return <Spinner label="Loading details" />;
    default:
      // "error" shows its notice above; the others show the object.
      return null;
  }
}

export interface DetailsEntryOptions {
  clusterId: string;
  history: DrawerHistoryApi;
  resources: ApiResourceInfo[];
  /**
   * A resource read as served and listable when `resources` leaves it out: the
   * screen's own resource, or a dock tab's root resource while discovery loads.
   */
  known: ResourceRef;
  /** The screen's columns for objects of `known`. Without them, the kind's own are used. */
  ownColumns?: readonly TableColumn<KubeObject>[];
}

/** The shown entry of a details history, read as the drawer reads it (spec H44–H53). */
export interface DetailsEntry {
  target: DrawerTarget;
  /** The shown entry's resource, or undefined when the cluster does not serve it. */
  info: ApiResourceInfo | undefined;
  read: DrawerObject;
  /** True when the entry is of `known` and the caller gave its columns. */
  own: boolean;
  kind: string;
  name: string;
  columns: readonly TableColumn<KubeObject>[];
  tabs: DrawerTabItem[];
  /** The selected tab: the entry's, or the Overview when that tab is not offered. */
  tab: string;
}

/**
 * Reads the history's shown entry: its resource, its object (live), its columns and
 * the tabs it offers. Null while nothing is shown. Remembers live objects, so a deleted
 * one keeps how it last looked.
 */
export function useDetailsEntry(
  options: DetailsEntryOptions,
): DetailsEntry | null {
  const { clusterId, history, resources, known, ownColumns } = options;
  const target = history.shown?.target ?? null;
  const isKnown =
    target !== null &&
    target.group === known.group &&
    target.plural === known.plural;
  const knownFallback = useMemo(() => knownInfo(known), [known]);
  const listed = target
    ? findResource(resources, target.group, target.plural)
    : undefined;
  const info = listed ?? (isKnown ? knownFallback : undefined);
  const lastSeen = target ? history.lastSeen(target) : null;
  const read = useDrawerObject(clusterId, info, target, lastSeen);
  const own = isKnown && ownColumns !== undefined;
  const linkedColumns = useKindColumns(
    clusterId,
    own ? undefined : info,
    resources,
    target?.namespace ?? null,
  );
  const columns =
    isKnown && ownColumns !== undefined ? ownColumns : linkedColumns;

  const { remember } = history;
  useEffect(() => {
    if (target && read.status === "live" && read.object) {
      remember(target, read.object);
    }
  }, [target, read.status, read.object, remember]);

  if (target === null) return null;

  const object = read.object;
  const entryResource = info?.resource;
  const kind = entryResource?.kind ?? lastSeen?.kind ?? target.plural;
  const name = object?.metadata.name ?? target.name;
  const metrics =
    read.status === "live" &&
    object !== null &&
    entryResource !== undefined &&
    metricsTargetOf(entryResource, object) !== null;
  // The Resource map is for the kinds an object map can focus on (spec E §11).
  const tabs = [
    OVERVIEW_TAB,
    ...(metrics ? [METRICS_TAB] : []),
    ...(entryResource && hasDrawerMap(entryResource) ? [MAP_TAB] : []),
    EVENTS_TAB,
  ];
  // Back restores the entry's tab, or the Overview when it is no longer offered.
  const wanted = history.shown?.tab ?? OVERVIEW;
  const tab = tabs.some((t) => t.value === wanted) ? wanted : OVERVIEW;
  return { target, info, read, own, kind, name, columns, tabs, tab };
}

export interface DetailsContentProps {
  clusterId: string;
  entry: DetailsEntry;
  resources: ApiResourceInfo[];
  /** Steps to the object a link names. */
  onOpen(target: DrawerTarget): void;
  onTabChange(tab: string): void;
  /** The dock's layout: the Overview's sections flow into columns (spec K10). */
  wide?: boolean;
}

/**
 * The notes, the tab row and the tab bodies of a details entry, shared by the drawer
 * and the dock's details tab (spec K9). Another shown object starts at the top.
 */
export function DetailsContent(props: DetailsContentProps): ReactElement {
  const { clusterId, entry, resources, onOpen, onTabChange } = props;
  const { target, info, read, kind, columns, tabs, tab } = entry;
  const contentRef = useRef<HTMLDivElement>(null);
  const shownKey = targetKey(target);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another shown object starts at the top.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [shownKey]);
  const { group, plural } = target;
  const kindKey = useMemo(() => ({ group, plural }), [group, plural]);
  const links = useMemo(() => ({ open: onOpen }), [onOpen]);

  const object = read.object;
  const entryResource = info?.resource;
  return (
    <>
      {read.status === "deleted" ? (
        <p
          className={styles.removed}
          role="status"
          data-testid="detail-removed"
        >
          This {kind} was deleted. What is shown is how it last looked.
        </p>
      ) : null}
      {read.status === "fetched" ? (
        <p className={styles.staticNote} data-testid="detail-static-note">
          Not updated live: you cannot watch{" "}
          {listLabel(target.plural, entryResource?.kind)}.
        </p>
      ) : null}
      {read.status === "error" ? (
        <div className={styles.fetchError} data-testid="detail-fetch-error">
          <ErrorNotice
            title={
              object
                ? `Could not load the latest ${kind}`
                : `Could not load this ${kind}`
            }
            message={read.message ?? ""}
            onRetry={read.retry}
          />
        </div>
      ) : null}
      {object && entryResource ? (
        <DrawerLinkContext.Provider value={links}>
          <DrawerKindContext.Provider value={kindKey}>
            <Tabs value={tab} onChange={onTabChange} tabs={tabs} />
            <div ref={contentRef} className={styles.content}>
              <Body
                key={shownKey}
                clusterId={clusterId}
                resource={entryResource}
                object={object}
                resources={resources}
                columns={columns}
                tab={tab}
                wide={props.wide ?? false}
              />
            </div>
          </DrawerKindContext.Provider>
        </DrawerLinkContext.Provider>
      ) : (
        <StateNotice read={read} kind={kind} target={target} />
      )}
    </>
  );
}
