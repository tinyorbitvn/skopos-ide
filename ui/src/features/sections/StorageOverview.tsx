import { useMemo } from "react";
import { EmptyState, Spinner } from "../../design";
import { Check, Layers, ShieldOff } from "../../design/icons";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import { STORAGE_CLASSES } from "../../kinds/refs";
import { useClusterContext } from "../cluster/ClusterLayout";
import {
  OverviewCard,
  OverviewCell,
  type OverviewCellValue,
  type OverviewColumn,
  OverviewGrid,
  OverviewPage,
  type OverviewRow,
  OverviewTable,
  TopTable,
} from "../overview";
import type { ListView } from "../workloads/counts";
import type { DonutValue } from "./nodesModel";
import styles from "./Sections.module.css";
import { useSectionShared, useSectionView } from "./sectionLists";
import {
  classRows,
  largestClaims,
  mountNodes,
  notListed,
  storageTiles,
  unboundClaims,
} from "./storageModel";
import { objectKey } from "./text";
import { TileGrid } from "./tiles";
import { useOverviewDrawer } from "./useOverviewDrawer";
import { useVolumeUsage, type VolumeUsageView } from "./useVolumeUsage";

/** The claims' kind; the drawer opens one by `?open=persistentvolumeclaims` (R3). */
const CLAIMS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "persistentvolumeclaims",
  kind: "PersistentVolumeClaim",
  namespaced: true,
};
/** The kinds the page opens in its drawer (spec §3.6). */
const OPENABLE: readonly ResourceRef[] = [CLAIMS, STORAGE_CLASSES];
const NO_NODES: string[] = [];
const NO_OBJECTS: KubeObject[] = [];

const NOT_SHOWN = "Volume usage is not shown";

const UNBOUND_COLUMNS: OverviewColumn[] = [
  { head: "Claim", width: "minmax(96px, 1fr)" },
  { head: "Status", width: "96px" },
  { head: "Reason", width: "minmax(0, 1.6fr)" },
];
const CLASS_COLUMNS: OverviewColumn[] = [
  { head: "StorageClass", width: "minmax(96px, 1fr)" },
  { head: "Provisioner", width: "minmax(0, 1.3fr)" },
  { head: "Expansion", width: "92px" },
  { head: "Requested of provisioned", width: "minmax(0, 1.3fr)" },
];

/** A requested-of-provisioned cell, nominal at any share: a full class is not a fault. */
function donutCell(donut: DonutValue): OverviewCellValue {
  const known =
    donut.pct !== null && donut.used !== null && donut.total !== null;
  return {
    donut: {
      ...donut,
      caption: known
        ? `${donut.used} / ${donut.total} ${donut.unit}`
        : "No data",
      level: "nominal",
    },
  };
}

function ClaimsLoading() {
  return (
    <div data-testid="storage-claims-loading">
      <Spinner label="Loading" />
    </div>
  );
}

function ClaimsEmpty(props: { title: string; text: string }) {
  return (
    <div data-testid="storage-claims-empty">
      <EmptyState title={props.title} body={props.text} />
    </div>
  );
}

/**
 * Largest claims' body (spec §3.6 and §7): the mounted claims with the most used bytes,
 * or why there are none to show.
 */
function LargestClaims(props: {
  claims: ListView;
  pods: ListView;
  usage: VolumeUsageView;
  onOpen(key: string): void;
}) {
  const { claims, pods, usage, onOpen } = props;
  if (claims.state === "loading" || pods.state === "loading") {
    return <ClaimsLoading />;
  }
  if (claims.state === "unavailable") {
    return (
      <ClaimsEmpty
        title={NOT_SHOWN}
        text={`${notListed(claims.cause, "PersistentVolumeClaims")}.`}
      />
    );
  }
  if (pods.state === "unavailable") {
    return (
      <ClaimsEmpty
        title={NOT_SHOWN}
        text={`${notListed(pods.cause, "Pods")}.`}
      />
    );
  }
  if (usage.forbidden) {
    return (
      <ClaimsEmpty
        title={NOT_SHOWN}
        text="Volume stats come from each node's kubelet through nodes/proxy, which is forbidden for your account."
      />
    );
  }
  if (usage.error !== null) {
    return (
      <ClaimsEmpty
        title={NOT_SHOWN}
        text={`Volume usage could not be read: ${usage.error.replace(/\.+$/, "")}.`}
      />
    );
  }
  if (usage.items === null) return <ClaimsLoading />;
  const rows = largestClaims(claims.items, usage.items);
  if (rows.length === 0) {
    return (
      <ClaimsEmpty
        title="No mounted claims"
        text="The kubelet reports the used bytes of a claim while a Pod mounts it."
      />
    );
  }
  return (
    <>
      <TopTable
        id="storage-claims"
        title="By used bytes"
        nameHead="Claim"
        valueHead="Used"
        shareHead="Usage"
        total={null}
        what="storage"
        rows={rows.map((row) => ({ ...row, onOpen: () => onOpen(row.key) }))}
      />
      <p className={styles.storageCaption} data-testid="storage-claims-footer">
        Used bytes: kubelet volume stats of mounted claims
      </p>
    </>
  );
}

/** Claims not Bound (spec §3.6), each with the reason its state and class give. */
function UnboundClaims(props: {
  claims: ListView;
  classes: ListView;
  onOpen(key: string): void;
}) {
  const { claims, classes, onOpen } = props;
  const rows =
    claims.state === "ready"
      ? unboundClaims(
          claims.items,
          classes.state === "ready" ? classes.items : NO_OBJECTS,
        ).map((row): OverviewRow => {
          const key = objectKey(row.claim);
          return {
            key,
            name: row.claim.metadata.name,
            sub: row.claim.metadata.namespace ?? "",
            title: key,
            onOpen: () => onOpen(key),
            cells: [
              { text: row.status, tone: "warn" },
              { text: row.reason, title: row.reason },
            ],
          };
        })
      : [];
  return (
    <OverviewTable
      id="storage-unbound"
      label="Claims not Bound"
      columns={UNBOUND_COLUMNS}
      rows={rows}
      loading={claims.state === "loading" || classes.state === "loading"}
      empty={
        claims.state === "unavailable"
          ? {
              icon: ShieldOff,
              title: notListed(claims.cause, "PersistentVolumeClaims"),
              text: "",
            }
          : { icon: Check, title: "Every claim is Bound", text: "" }
      }
    />
  );
}

/** Capacity by StorageClass (spec §3.6): requested of provisioned, class by class. */
function ClassCapacity(props: {
  classes: ListView;
  volumes: ListView;
  claims: ListView;
  onOpen(key: string): void;
}) {
  const { classes, volumes, claims, onOpen } = props;
  const blocked =
    classes.state === "unavailable"
      ? { view: classes, plural: "StorageClasses" }
      : volumes.state === "unavailable"
        ? { view: volumes, plural: "PersistentVolumes" }
        : null;
  const rows =
    classes.state === "ready" &&
    volumes.state === "ready" &&
    claims.state !== "loading"
      ? classRows(
          classes.items,
          volumes.items,
          claims.state === "ready" ? claims.items : null,
        ).map((row): OverviewRow => {
          const name = row.storageClass.metadata.name;
          return {
            key: name,
            name,
            sub: row.isDefault ? "Default" : "",
            onOpen: () => onOpen(objectKey(row.storageClass)),
            cells: [
              { text: row.provisioner, mono: true, title: row.provisioner },
              { text: row.expansion },
              donutCell(row.donut),
            ],
          };
        })
      : [];
  return (
    <OverviewTable
      id="storage-classes"
      label="Capacity by StorageClass"
      columns={CLASS_COLUMNS}
      rows={rows}
      minWidth={460}
      loading={
        blocked === null &&
        (classes.state === "loading" ||
          volumes.state === "loading" ||
          claims.state === "loading")
      }
      empty={
        blocked
          ? {
              icon: ShieldOff,
              title: "Capacity by StorageClass is not shown",
              text: `${notListed(blocked.view.cause, blocked.plural)}.`,
            }
          : { icon: Layers, title: "No StorageClasses", text: "" }
      }
    />
  );
}

/**
 * The Storage overview (spec §3.6): Largest claims and the Summary tiles, then Claims not
 * Bound and Capacity by StorageClass, with the drawer over them.
 */
export function StorageOverview() {
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const discovery = useMemo(
    () => ({ loading: resourcesLoading, error: resourcesError }),
    [resourcesLoading, resourcesError],
  );
  const shared = useSectionShared(clusterId, resources, discovery);
  const namespaces = shared[3];
  const claims = useSectionView(
    shared,
    "PersistentVolumeClaims",
    "",
    "persistentvolumeclaims",
  );
  const volumes = useSectionView(
    shared,
    "PersistentVolumes",
    "",
    "persistentvolumes",
  );
  const classes = useSectionView(
    shared,
    "StorageClasses",
    "storage.k8s.io",
    "storageclasses",
  );
  const pods = useSectionView(shared, "Pods", "", "pods");
  // R8: the nodes of the Pods that mount claims; none while the claims may not be listed.
  const nodes = useMemo(
    () =>
      pods.state === "ready" && claims.state !== "unavailable"
        ? mountNodes(pods.items)
        : NO_NODES,
    [pods, claims.state],
  );
  const usage = useVolumeUsage(clusterId, nodes);
  const drawer = useOverviewDrawer(clusterId, resources, OPENABLE);
  const tiles = useMemo(
    () => storageTiles({ clusterId, claims, volumes, classes }),
    [clusterId, claims, volumes, classes],
  );
  const openClaim = (key: string) => drawer.open(CLAIMS, key);

  return (
    <OverviewPage
      title="Storage overview"
      testId="storage-overview"
      namespaces={namespaces}
      onKeyDown={drawer.onKeyDown}
    >
      <OverviewGrid>
        <OverviewCell span={5}>
          <OverviewCard
            title="Largest claims"
            testId="storage-overview-card-claims"
          >
            <LargestClaims
              claims={claims}
              pods={pods}
              usage={usage}
              onOpen={openClaim}
            />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={7}>
          <OverviewCard title="Summary" testId="storage-overview-card-summary">
            <TileGrid tiles={tiles} />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={5}>
          <OverviewCard
            title="Claims not Bound"
            testId="storage-overview-card-unbound"
          >
            <UnboundClaims
              claims={claims}
              classes={classes}
              onOpen={openClaim}
            />
          </OverviewCard>
        </OverviewCell>
        <OverviewCell span={7}>
          <OverviewCard
            title="Capacity by StorageClass"
            testId="storage-overview-card-classes"
          >
            <ClassCapacity
              classes={classes}
              volumes={volumes}
              claims={claims}
              onOpen={(key) => drawer.open(STORAGE_CLASSES, key)}
            />
          </OverviewCard>
        </OverviewCell>
      </OverviewGrid>
      {drawer.drawer}
    </OverviewPage>
  );
}
