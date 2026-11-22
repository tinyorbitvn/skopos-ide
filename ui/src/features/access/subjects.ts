import type { BindingKind } from "../../ipc/generated/BindingKind";
import type { BindingRef } from "../../ipc/generated/BindingRef";
import type { SubjectKind } from "../../ipc/generated/SubjectKind";
import { subjectRows } from "../../kinds/access/access";
import type { KubeObject } from "../../kinds/objects";

/** A binding that names a subject, as the person saw it. */
export interface SubjectBinding {
  kind: BindingKind;
  /** `null` for a ClusterRoleBinding. */
  namespace: string | null;
  name: string;
  resourceVersion: string;
  roleKind: string;
  roleName: string;
  /** How many subjects stay when this one is removed. */
  others: number;
}

/** A User or Group that at least one binding names. Kubernetes has no such object. */
export interface SubjectEntry {
  /** `User:alice`, the value of `?subject=`. */
  key: string;
  kind: SubjectKind;
  name: string;
  bindings: SubjectBinding[];
  /** The distinct roles, as `ClusterRole/edit`, sorted. */
  roles: string[];
  /** "Cluster" when a ClusterRoleBinding names it, then the namespaces, sorted. */
  scope: string[];
}

export type KindFilter = "all" | "users" | "groups";

export function subjectKey(kind: SubjectKind, name: string): string {
  return `${kind}:${name}`;
}

export function parseSubjectKey(
  key: string | null,
): { kind: SubjectKind; name: string } | null {
  if (key === null) return null;
  const at = key.indexOf(":");
  if (at < 0) return null;
  const kind = key.slice(0, at);
  const name = key.slice(at + 1);
  if ((kind !== "User" && kind !== "Group") || name === "") return null;
  return { kind, name };
}

export function isSystemName(name: string): boolean {
  return name.startsWith("system:");
}

export function usersGroupsPath(
  clusterId: string,
  kind?: SubjectKind,
  name?: string,
): string {
  const base = `/cluster/${encodeURIComponent(clusterId)}/users-groups`;
  return kind && name
    ? `${base}?subject=${encodeURIComponent(subjectKey(kind, name))}`
    : base;
}

function subjectKindOf(kind: string): SubjectKind | null {
  return kind === "User" || kind === "Group" ? kind : null;
}

function finish(entry: SubjectEntry): SubjectEntry {
  const roles = [
    ...new Set(entry.bindings.map((b) => `${b.roleKind}/${b.roleName}`)),
  ].sort();
  const namespaces = [
    ...new Set(
      entry.bindings.flatMap((b) =>
        b.namespace === null ? [] : [b.namespace],
      ),
    ),
  ].sort();
  const cluster = entry.bindings.some((b) => b.namespace === null);
  return {
    ...entry,
    roles,
    scope: cluster ? ["Cluster", ...namespaces] : namespaces,
  };
}

/** The Users and Groups that the bindings name, sorted by name. */
export function collectSubjects(
  clusterBindings: readonly KubeObject[],
  roleBindings: readonly KubeObject[],
): SubjectEntry[] {
  const entries = new Map<string, SubjectEntry>();
  const add = (object: KubeObject, kind: BindingKind) => {
    const subjects = subjectRows(object.subjects);
    const seen = new Set<string>();
    for (const subject of subjects) {
      const subjectKind = subjectKindOf(subject.kind);
      if (subjectKind === null) continue;
      const key = subjectKey(subjectKind, subject.name);
      if (seen.has(key)) continue;
      seen.add(key);
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = {
          key,
          kind: subjectKind,
          name: subject.name,
          bindings: [],
          roles: [],
          scope: [],
        };
        entries.set(key, entry);
      }
      entry.bindings.push({
        kind,
        namespace:
          kind === "RoleBinding" ? (object.metadata.namespace ?? null) : null,
        name: object.metadata.name,
        resourceVersion: object.metadata.resourceVersion ?? "",
        roleKind: String(object.roleRef?.kind ?? ""),
        roleName: String(object.roleRef?.name ?? ""),
        others: subjects.filter(
          (other) =>
            !(other.kind === subject.kind && other.name === subject.name),
        ).length,
      });
    }
  };
  for (const object of clusterBindings) add(object, "ClusterRoleBinding");
  for (const object of roleBindings) add(object, "RoleBinding");
  return [...entries.values()]
    .map(finish)
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind),
    );
}

export function filterSubjects(
  entries: readonly SubjectEntry[],
  filters: { query: string; kind: KindFilter; showSystem: boolean },
): SubjectEntry[] {
  const query = filters.query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filters.showSystem || !isSystemName(entry.name)) &&
      (filters.kind === "all" ||
        (filters.kind === "users"
          ? entry.kind === "User"
          : entry.kind === "Group")) &&
      (query === "" || entry.name.toLowerCase().includes(query)),
  );
}

export function bindingText(b: {
  kind: BindingKind;
  namespace: string | null;
  name: string;
}): string {
  return `${b.kind} ${b.namespace === null ? "" : `${b.namespace}/`}${b.name}`;
}

export function removalLine(b: SubjectBinding): string {
  if (b.others === 0) return "Delete · no other subjects";
  return `Remove · ${b.others} other ${b.others === 1 ? "subject stays" : "subjects stay"}`;
}

export function bindingsText(count: number): string {
  return count === 1 ? "1 binding" : `${count} bindings`;
}

export function toBindingRef(b: SubjectBinding): BindingRef {
  return {
    kind: b.kind,
    namespace: b.namespace,
    name: b.name,
    resourceVersion: b.resourceVersion,
  };
}
