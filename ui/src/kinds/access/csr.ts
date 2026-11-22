import { api } from "../../ipc/api";
import type { CertificateRequestInfo } from "../../ipc/generated/CertificateRequestInfo";
import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

export interface CsrConditionRow {
  type: string;
  status: string;
  reason: string;
  message: string;
  /** `lastUpdateTime`, else `lastTransitionTime`; "" when neither is set. */
  updated: string;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function csrConditions(o: KubeObject): CsrConditionRow[] {
  const list: unknown = o.status?.conditions;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === "object" && c !== null && typeof c.type === "string",
    )
    .map((c) => ({
      type: text(c.type),
      status: text(c.status),
      reason: text(c.reason),
      message: text(c.message),
      updated: text(c.lastUpdateTime) || text(c.lastTransitionTime),
    }));
}

/** Denied, Failed, Issued (a certificate is there), Approved or Pending, in that order. */
export function csrCondition(o: KubeObject): StatusInfo {
  const held = new Set(
    csrConditions(o)
      .filter((c) => c.status !== "False")
      .map((c) => c.type),
  );
  if (held.has("Denied")) return { label: "Denied", tone: "danger" };
  if (held.has("Failed")) return { label: "Failed", tone: "danger" };
  if (text(o.status?.certificate) !== "")
    return { label: "Issued", tone: "ok" };
  if (held.has("Approved")) return { label: "Approved", tone: "neutral" };
  return { label: "Pending", tone: "warn" };
}

export function isPending(o: KubeObject): boolean {
  return csrCondition(o).label === "Pending";
}

/** `spec.expirationSeconds` in its largest whole unit: "7d", "1h", "10m", "601s". */
export function durationText(seconds: unknown): string | undefined {
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds <= 0
  ) {
    return undefined;
  }
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function subjectText(info: CertificateRequestInfo): string {
  return [
    `CN=${info.commonName}`,
    ...info.organizations.map((o) => `O=${o}`),
  ].join(", ");
}

/** What the request asks for, read by the core from `spec.request` (and the certificate). */
export function describeRequest(
  o: KubeObject,
): Promise<CertificateRequestInfo> {
  const certificate = text(o.status?.certificate);
  return api.certificateRequestDescribe(
    text(o.spec?.request),
    certificate === "" ? null : certificate,
  );
}
