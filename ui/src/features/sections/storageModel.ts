import {
  Box,
  CalendarClock,
  Database,
  HardDrive,
  Layers,
  Unplug,
} from "../../design/icons";
import type { VolumeUsage } from "../../ipc/generated/VolumeUsage";
import { resourcePath } from "../../kinds/nav";
import type { KubeObject } from "../../kinds/objects";
import { isDefaultStorageClass, pvcStatus } from "../../kinds/storage/storage";
import { percentOf } from "../../kinds/usageColumns";
import { formatBytes, gibibytes, parseQuantity } from "../metrics/format";
import type { TopRow } from "../overview";
import type { ListView, UnavailableCause } from "../workloads/counts";
import type { DonutValue } from "./nodesModel";
import {
  byNamespaceName,
  countOf,
  formatCount,
  naturalCompare,
  objectKey,
  someNames,
} from "./text";
import { type SectionTile, waitingTile } from "./tiles";

/** Rows in Largest claims (spec §3.6). */
export const LARGEST_LIMIT = 5;

const CLAIMS = "PersistentVolumeClaims";
const VOLUMES = "PersistentVolumes";
const CLASSES = "StorageClasses";
const DASH = "—";

/**
 * Why a list is not there, in the words of the tiles' sub-lines (spec §3.1): "You may not
 * list PersistentVolumes". The cards add a period where it is a sentence.
 */
export function notListed(cause: UnavailableCause, plural: string): string {
  switch (cause) {
    case "forbidden":
      return `You may not list ${plural}`;
    case "notServed":
      return `This cluster does not serve ${plural}`;
    case "error":
      return `Could not list ${plural}`;
  }
}

/** `status.phase`, or "" when there is none (spec §5). */
function phaseOf(o: KubeObject): string {
  const phase: unknown = o.status?.phase;
  return typeof phase === "string" ? phase : "";
}

function deleting(o: KubeObject): boolean {
  return Boolean(o.metadata.deletionTimestamp);
}

/** Bound and not being deleted: the claims the Bound tile counts (spec §3.6). */
function isBound(claim: KubeObject): boolean {
  return !deleting(claim) && phaseOf(claim) === "Bound";
}

/** The StorageClass a claim or a volume names; "" when it names none. */
function classOf(o: KubeObject): string {
  const name: unknown = o.spec?.storageClassName;
  return typeof name === "string" ? name : "";
}

function byName(a: KubeObject, b: KubeObject): number {
  return naturalCompare(a.metadata.name, b.metadata.name);
}

/** Names naturally, then namespaces (spec §3.1). */
function byNameThenNamespace(a: KubeObject, b: KubeObject): number {
  return (
    byName(a, b) ||
    naturalCompare(a.metadata.namespace ?? "", b.metadata.namespace ?? "")
  );
}

/** Their names, two and "and N more" at most; "None" when there are none. */
function namesOr(objects: readonly KubeObject[]): string {
  if (objects.length === 0) return "None";
  return someNames(
    [...objects].sort(byNameThenNamespace).map((o) => o.metadata.name),
  );
}

const CLAIM_TILES = [
  { id: "bound", icon: HardDrive, label: "PVCs Bound" },
  { id: "pending", icon: CalendarClock, label: "PVCs Pending" },
  { id: "lost", icon: Unplug, label: "PVCs Lost" },
] as const;
const VOLUME_TILES = [
  { id: "available", icon: Database, label: "PVs Available" },
  { id: "released", icon: Box, label: "PVs Released" },
] as const;
const CLASS_TILE = {
  id: "classes",
  icon: Layers,
  label: "StorageClasses",
} as const;

/** PVCs Bound, Pending and Lost; a claim being deleted counts in none of them. */
function claimTiles(view: ListView, to: string): SectionTile[] {
  if (view.state !== "ready") {
    return CLAIM_TILES.map((tile) =>
      waitingTile(view, { ...tile, plural: CLAIMS, to }),
    );
  }
  const live = view.items.filter((c) => !deleting(c));
  const inPhase = (phase: string) => live.filter((c) => phaseOf(c) === phase);
  const bound = inPhase("Bound");
  const pending = inPhase("Pending");
  const lost = inPhase("Lost");
  const [boundTile, pendingTile, lostTile] = CLAIM_TILES;
  return [
    {
      ...boundTile,
      number: formatCount(bound.length),
      sub: `Of ${countOf(view.items.length, "claim")}`,
      tone: "ok",
      to,
    },
    {
      ...pendingTile,
      number: formatCount(pending.length),
      sub: namesOr(pending),
      tone: pending.length > 0 ? "warn" : "ok",
      to,
    },
    {
      ...lostTile,
      number: formatCount(lost.length),
      sub: namesOr(lost),
      tone: lost.length > 0 ? "danger" : "ok",
      to,
    },
  ];
}

function releasedSub(n: number): string {
  if (n === 0) return "None";
  return n === 1 ? "Its claim is gone" : "Their claims are gone";
}

/** PVs Available and Released; a volume being deleted counts in neither. */
function volumeTiles(view: ListView, to: string): SectionTile[] {
  if (view.state !== "ready") {
    return VOLUME_TILES.map((tile) =>
      waitingTile(view, { ...tile, plural: VOLUMES, to }),
    );
  }
  const live = view.items.filter((v) => !deleting(v));
  const available = live.filter((v) => phaseOf(v) === "Available").length;
  const released = live.filter((v) => phaseOf(v) === "Released").length;
  const [availableTile, releasedTile] = VOLUME_TILES;
  return [
    {
      ...availableTile,
      number: formatCount(available),
      sub: available > 0 ? "Ready for a claim" : "None",
      tone: "neutral",
      to,
    },
    {
      ...releasedTile,
      number: formatCount(released),
      sub: releasedSub(released),
      tone: released > 0 ? "warn" : "neutral",
      to,
    },
  ];
}

/** StorageClasses, naming the default one (the first by name when several say so). */
function classTile(view: ListView, to: string): SectionTile {
  if (view.state !== "ready") {
    return waitingTile(view, { ...CLASS_TILE, plural: CLASSES, to });
  }
  const fallback = [...view.items].sort(byName).find(isDefaultStorageClass);
  return {
    ...CLASS_TILE,
    number: formatCount(view.items.length),
    sub: fallback ? `Default: ${fallback.metadata.name}` : "No default class",
    tone: "neutral",
    to,
  };
}

/**
 * The Summary card's six tiles (spec §3.6). Claims are under the selection; volumes and
 * classes are cluster-scoped. Each tile opens its kind's list.
 */
export function storageTiles(input: {
  clusterId: string;
  claims: ListView;
  volumes: ListView;
  classes: ListView;
}): SectionTile[] {
  const { clusterId } = input;
  return [
    ...claimTiles(
      input.claims,
      resourcePath(clusterId, "", "persistentvolumeclaims"),
    ),
    ...volumeTiles(
      input.volumes,
      resourcePath(clusterId, "", "persistentvolumes"),
    ),
    classTile(
      input.classes,
      resourcePath(clusterId, "storage.k8s.io", "storageclasses"),
    ),
  ];
}

/** The claim a Pod volume mounts; null for any other volume. */
function claimNameOf(volume: unknown): string | null {
  if (volume === null || typeof volume !== "object") return null;
  const source: unknown = (volume as { persistentVolumeClaim?: unknown })
    .persistentVolumeClaim;
  if (source === null || typeof source !== "object") return null;
  const name: unknown = (source as { claimName?: unknown }).claimName;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * The nodes `volumes_usage` asks (R8): the `spec.nodeName` of each Pod with a volume whose
 * `persistentVolumeClaim.claimName` names a claim, in natural order and once each.
 */
export function mountNodes(pods: readonly KubeObject[]): string[] {
  const nodes = new Set<string>();
  for (const pod of pods) {
    const node: unknown = pod.spec?.nodeName;
    const volumes: unknown = pod.spec?.volumes;
    if (typeof node !== "string" || node === "" || !Array.isArray(volumes)) {
      continue;
    }
    if (volumes.some((v) => claimNameOf(v) !== null)) nodes.add(node);
  }
  return [...nodes].sort(naturalCompare);
}

/**
 * A Largest claims row, its donut the claim's own usage. The component adds `onOpen`, the
 * drawer the row opens.
 */
export type ClaimRow = Omit<TopRow, "onOpen"> & {
  own: NonNullable<TopRow["own"]>;
};

function claimRow(key: string, claim: KubeObject, item: VolumeUsage): ClaimRow {
  const name = claim.metadata.name;
  const storageClass = classOf(claim);
  const pct = percentOf({ used: item.usedBytes, total: item.capacityBytes });
  return {
    key,
    name,
    sub:
      storageClass === ""
        ? item.namespace
        : `${item.namespace} · ${storageClass}`,
    amount: item.usedBytes,
    amountText: formatBytes(item.usedBytes),
    own: {
      pct,
      label:
        pct === null
          ? `${name}: no data`
          : `${name} ${pct}%, ${gibibytes(item.usedBytes)} of ${gibibytes(item.capacityBytes)} GiB`,
    },
  };
}

/**
 * Largest claims (spec §3.6): the mounted claims of `claims` (the list under the selection)
 * with the most used bytes, then by name, at most `limit`. A claim is mounted while the
 * kubelets report it; one reported twice keeps its larger used bytes.
 */
export function largestClaims(
  claims: readonly KubeObject[],
  usage: readonly VolumeUsage[],
  limit = LARGEST_LIMIT,
): ClaimRow[] {
  const listed = new Map(claims.map((c) => [objectKey(c), c]));
  const mounted = new Map<string, { claim: KubeObject; item: VolumeUsage }>();
  for (const item of usage) {
    const key = `${item.namespace}/${item.claim}`;
    const claim = listed.get(key);
    if (claim === undefined) continue;
    const seen = mounted.get(key);
    if (seen === undefined || item.usedBytes > seen.item.usedBytes) {
      mounted.set(key, { claim, item });
    }
  }
  return [...mounted.entries()]
    .sort(
      ([, a], [, b]) =>
        b.item.usedBytes - a.item.usedBytes ||
        byNameThenNamespace(a.claim, b.claim),
    )
    .slice(0, limit)
    .map(([key, { claim, item }]) => claimRow(key, claim, item));
}

function finalizersOf(o: KubeObject): string[] {
  const list: unknown = (o.metadata as { finalizers?: unknown }).finalizers;
  return Array.isArray(list)
    ? list.filter((f): f is string => typeof f === "string")
    : [];
}

function provisionerOf(storageClass: KubeObject): string {
  const provisioner: unknown = storageClass.provisioner;
  return typeof provisioner === "string" && provisioner !== ""
    ? provisioner
    : DASH;
}

/** The first reason of spec §3.6 that applies to a claim that is not Bound. */
function unboundReason(
  claim: KubeObject,
  status: string,
  classes: ReadonlyMap<string, KubeObject>,
): string {
  const finalizers = finalizersOf(claim);
  if (deleting(claim) && finalizers.length > 0) {
    return `Being deleted; waiting for the finalizer ${finalizers.join(", ")}`;
  }
  const phase = phaseOf(claim);
  if (phase === "Pending") {
    const storageClass = classes.get(classOf(claim));
    if (storageClass?.volumeBindingMode === "WaitForFirstConsumer") {
      return "Waiting for a Pod to use it (WaitForFirstConsumer)";
    }
    if (storageClass) {
      return `Waiting for ${provisionerOf(storageClass)} to provision a volume`;
    }
    return "Waiting for a matching PersistentVolume";
  }
  if (phase === "Lost") {
    const volumeName: unknown = claim.spec?.volumeName;
    const name =
      typeof volumeName === "string" && volumeName !== "" ? volumeName : DASH;
    return `Its PersistentVolume ${name} no longer exists`;
  }
  return status;
}

/**
 * Claims not Bound (spec §3.6): the claims under the selection that are not Bound, a claim
 * being deleted among them, by namespace and name. The status is the list's Status text.
 */
export function unboundClaims(
  claims: readonly KubeObject[],
  classes: readonly KubeObject[],
): { claim: KubeObject; status: string; reason: string }[] {
  const byClassName = new Map(classes.map((c) => [c.metadata.name, c]));
  return claims
    .filter((c) => !isBound(c))
    .sort(byNamespaceName)
    .map((claim) => {
      const status = pvcStatus(claim).label;
      return {
        claim,
        status,
        reason: unboundReason(claim, status, byClassName),
      };
    });
}

/** The sum of the quantities `storage` reads; one that is not a quantity counts 0. */
function sumStorage(
  objects: readonly KubeObject[],
  storage: (o: KubeObject) => unknown,
): number {
  return objects.reduce((sum, o) => sum + (parseQuantity(storage(o)) ?? 0), 0);
}

/** Requested of provisioned in GiB; no data without volumes or without the claims. */
function requestedDonut(
  name: string,
  requested: number | null,
  provisioned: number,
): DonutValue {
  const pct =
    requested === null
      ? null
      : percentOf({ used: requested, total: provisioned });
  if (pct === null || requested === null) {
    return {
      pct: null,
      used: null,
      total: null,
      unit: "GiB",
      label: `${name} requested: no data`,
    };
  }
  const used = gibibytes(requested);
  const total = gibibytes(provisioned);
  return {
    pct,
    used,
    total,
    unit: "GiB",
    label: `${name} requested ${pct}%, ${used} of ${total} GiB`,
  };
}

/** One row of Capacity by StorageClass. */
export interface ClassRow {
  storageClass: KubeObject;
  isDefault: boolean;
  provisioner: string;
  /** "Allowed" or "Not allowed". */
  expansion: string;
  donut: DonutValue;
}

/**
 * Capacity by StorageClass (spec §3.6), one row per class by name: the Bound claims'
 * `status.capacity.storage` of the class (under the selection) against its volumes'
 * `spec.capacity.storage`. `claims` is null while the claims may not be listed, which
 * leaves every donut without data.
 */
export function classRows(
  classes: readonly KubeObject[],
  volumes: readonly KubeObject[],
  claims: readonly KubeObject[] | null,
): ClassRow[] {
  return [...classes].sort(byName).map((storageClass) => {
    const name = storageClass.metadata.name;
    const provisioned = sumStorage(
      volumes.filter((v) => classOf(v) === name),
      (v) => v.spec?.capacity?.storage,
    );
    const requested =
      claims === null
        ? null
        : sumStorage(
            claims.filter((c) => isBound(c) && classOf(c) === name),
            (c) => c.status?.capacity?.storage,
          );
    return {
      storageClass,
      isDefault: isDefaultStorageClass(storageClass),
      provisioner: provisionerOf(storageClass),
      expansion:
        storageClass.allowVolumeExpansion === true ? "Allowed" : "Not allowed",
      donut: requestedDonut(name, requested, provisioned),
    };
  });
}
