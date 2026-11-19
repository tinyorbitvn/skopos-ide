import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

type Obj = Pick<KubeObject, "metadata"> & Partial<KubeObject>;

/**
 * A claim's state as kubectl prints it: Pending until the scheduler allocates devices,
 * then Allocated, and Reserved while a Pod uses it.
 */
export function claimState(o: Obj): StatusInfo {
  if (o.metadata.deletionTimestamp) {
    return { label: "Terminating", tone: "neutral" };
  }
  const allocated = o.status?.allocation != null;
  const reserved =
    Array.isArray(o.status?.reservedFor) && o.status.reservedFor.length > 0;
  if (allocated && reserved) return { label: "Reserved", tone: "ok" };
  if (allocated) return { label: "Allocated", tone: "ok" };
  return { label: "Pending", tone: "warn" };
}

/** One device request of a claim (resource.k8s.io v1, or v1beta1's flat form). */
export interface DeviceRequestRow {
  name: string;
  /** The device classes it asks for; several for a first-available list. */
  classes: string[];
  mode: string;
  selectors: string[];
}

function selectorsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((s) => s?.cel?.expression)
    .filter((e): e is string => typeof e === "string" && e !== "");
}

function modeOf(value: { allocationMode?: string; count?: number }): string {
  if (value.allocationMode === "All") return "All";
  return String(value.count ?? 1);
}

/** The device requests of a claim's spec, or of a claim template's `spec.spec`. */
export function deviceRequests(spec: unknown): DeviceRequestRow[] {
  const requests = (spec as { devices?: { requests?: unknown } } | undefined)
    ?.devices?.requests;
  if (!Array.isArray(requests)) return [];
  return requests.map((r) => {
    if (Array.isArray(r?.firstAvailable)) {
      const subs = r.firstAvailable as Record<string, unknown>[];
      return {
        name: String(r.name ?? ""),
        classes: subs
          .map((s) => s.deviceClassName)
          .filter((c): c is string => typeof c === "string"),
        mode: "First available",
        selectors: subs.flatMap((s) => selectorsOf(s.selectors)),
      };
    }
    const exact = r?.exactly ?? r ?? {};
    return {
      name: String(r?.name ?? ""),
      classes:
        typeof exact.deviceClassName === "string"
          ? [exact.deviceClassName]
          : [],
      mode: modeOf(exact),
      selectors: selectorsOf(exact.selectors),
    };
  });
}

/** The device classes a claim or template asks for, joined, in request order. */
export function requestClasses(spec: unknown): string {
  const seen = new Set<string>();
  for (const r of deviceRequests(spec)) {
    for (const c of r.classes) seen.add(c);
  }
  return [...seen].join(", ");
}

/** One device the scheduler gave a claim. */
export interface AllocatedDevice {
  request: string;
  driver: string;
  pool: string;
  device: string;
}

export function allocatedDevices(o: Obj): AllocatedDevice[] {
  const results = o.status?.allocation?.devices?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    request: String(r?.request ?? ""),
    driver: String(r?.driver ?? ""),
    pool: String(r?.pool ?? ""),
    device: String(r?.device ?? ""),
  }));
}

/** The Pods (or other consumers) that hold the claim. */
export function reservedFor(
  o: Obj,
): { resource: string; name: string; group: string }[] {
  const list = o.status?.reservedFor;
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    resource: String(c?.resource ?? ""),
    name: String(c?.name ?? ""),
    group: String(c?.apiGroup ?? ""),
  }));
}

/** Where a slice's devices are: a node, every node, or the nodes a selector picks. */
export function sliceNode(o: Obj): string {
  const spec = o.spec ?? {};
  if (typeof spec.nodeName === "string" && spec.nodeName !== "") {
    return spec.nodeName;
  }
  if (spec.allNodes === true) return "All nodes";
  if (spec.nodeSelector) return "Selected nodes";
  if (spec.perDeviceNodeSelection === true) return "Per device";
  return "";
}

/** One device a slice offers, with its attributes and capacity as text. */
export interface SliceDevice {
  name: string;
  attributes: string[];
  capacity: string[];
}

function attributeValue(value: Record<string, unknown>): string {
  for (const key of ["string", "version", "int", "bool"]) {
    if (value[key] !== undefined) return String(value[key]);
  }
  return "";
}

export function sliceDevices(o: Obj): SliceDevice[] {
  const devices = o.spec?.devices;
  if (!Array.isArray(devices)) return [];
  return devices.map((d) => {
    // v1 puts the fields on the device; v1beta1 nests them under `basic`.
    const body = d?.basic ?? d ?? {};
    const attributes = Object.entries(
      (body.attributes ?? {}) as Record<string, Record<string, unknown>>,
    ).map(([key, value]) => `${key}=${attributeValue(value ?? {})}`);
    const capacity = Object.entries(
      (body.capacity ?? {}) as Record<string, unknown>,
    ).map(([key, value]) => {
      const amount =
        value && typeof value === "object"
          ? (value as { value?: unknown }).value
          : value;
      return `${key}=${String(amount ?? "")}`;
    });
    return { name: String(d?.name ?? ""), attributes, capacity };
  });
}

/** A class's CEL selectors. */
export function classSelectors(o: Obj): string[] {
  return selectorsOf(o.spec?.selectors);
}
