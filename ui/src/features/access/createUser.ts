import type { BoundBinding } from "../../ipc/generated/BoundBinding";
import type { CertUserEvent } from "../../ipc/generated/CertUserEvent";
import type { CertUserRequest } from "../../ipc/generated/CertUserRequest";
import type { CertUserStep } from "../../ipc/generated/CertUserStep";
import type { IpcError } from "../../ipc/generated/IpcError";
import type { RoleGrant } from "../../ipc/generated/RoleGrant";
import type { RoleKind } from "../../ipc/generated/RoleKind";

/** The create form, as typed. */
export interface CreateForm {
  user: string;
  /** Comma-separated. */
  groups: string;
  /** Seconds, as the lifetime select's value. */
  lifetime: string;
  grant: boolean;
  roleKind: RoleKind;
  /** For a ClusterRole: the whole cluster or one namespace. A Role is always in one. */
  scope: "cluster" | "namespace";
  namespace: string;
  role: string;
}

export const INITIAL_FORM: CreateForm = {
  user: "",
  groups: "",
  lifetime: "604800",
  grant: false,
  roleKind: "ClusterRole",
  scope: "cluster",
  namespace: "",
  role: "",
};

export const LIFETIMES: { value: string; label: string }[] = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
  { value: "7776000", label: "90 days" },
  { value: "31536000", label: "1 year" },
];

// The core's limits (cert_user/request.rs).
const MAX_NAME_CHARS = 64;
const SYSTEM_PREFIX = "system:";
const OBJECT_NAME_CHARS = 253;

export interface FormErrors {
  user?: string;
  groups?: string;
  namespace?: string;
}

export function parseGroups(text: string): string[] {
  return text
    .split(",")
    .map((group) => group.trim())
    .filter((group) => group !== "");
}

function nameError(name: string): string | undefined {
  if (name.startsWith(SYSTEM_PREFIX)) {
    return "Names that start with system: are reserved for Kubernetes.";
  }
  if ([...name].length > MAX_NAME_CHARS) return "Use at most 64 characters.";
  return undefined;
}

/** The core's checks, each under its field: the first problem of each. */
export function formErrors(form: CreateForm): FormErrors {
  const errors: FormErrors = {};
  const user = form.user.trim();
  const userError = user === "" ? "Enter a user name." : nameError(user);
  if (userError) errors.user = userError;
  const groups = parseGroups(form.groups);
  for (const [index, group] of groups.entries()) {
    const groupError =
      nameError(group) ??
      (groups.indexOf(group) < index ? "Each group appears once." : undefined);
    if (groupError) {
      errors.groups = groupError;
      break;
    }
  }
  if (form.grant && form.roleKind === "Role" && form.namespace.trim() === "") {
    errors.namespace = "Pick a namespace for a Role.";
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The grant lacks what the form has no message for: a role, or the namespace of a
 * ClusterRole bound in one. Create and save… stays disabled.
 */
export function grantIncomplete(form: CreateForm): boolean {
  if (!form.grant) return false;
  if (form.role.trim() === "") return true;
  return (
    form.roleKind === "ClusterRole" &&
    form.scope === "namespace" &&
    form.namespace.trim() === ""
  );
}

export function grantOf(form: CreateForm): RoleGrant | null {
  if (!form.grant) return null;
  const wholeCluster =
    form.roleKind === "ClusterRole" && form.scope === "cluster";
  return {
    roleKind: form.roleKind,
    roleName: form.role.trim(),
    namespace: wholeCluster ? null : form.namespace.trim(),
  };
}

export function toRequest(form: CreateForm): CertUserRequest {
  return {
    userName: form.user.trim(),
    groups: parseGroups(form.groups),
    lifetimeSeconds: Number(form.lifetime),
    binding: grantOf(form),
  };
}

/** What the save dialog proposes. */
export function suggestedName(user: string): string {
  const name = user.trim().replace(/[/\\]/g, "-");
  return `${name === "" ? "user" : name}.kubeconfig`;
}

function cut(text: string, max: number): string {
  return [...text].slice(0, max).join("").replace(/-+$/, "");
}

/** As `slug` in the core: lowercase letters and digits, other runs become one dash. */
export function slug(text: string, max: number): string {
  let out = "";
  for (const c of text.toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) out += c;
    else if (!out.endsWith("-")) out += "-";
  }
  const kept = cut(out.replace(/^-+/, ""), max);
  return kept === "" ? "user" : kept;
}

/** As `binding_name` in the core: `<user slug>-<role slug>`. */
export function bindingName(user: string, role: string): string {
  return cut(
    `${slug(user, OBJECT_NAME_CHARS)}-${slug(role, OBJECT_NAME_CHARS)}`,
    OBJECT_NAME_CHARS,
  );
}

/** The binding the grant will make, once the form names a user, a role and a scope. */
export function plannedBinding(form: CreateForm): BoundBinding | null {
  const grant = grantOf(form);
  const user = form.user.trim();
  if (
    grant === null ||
    user === "" ||
    grant.roleName === "" ||
    grant.namespace === ""
  ) {
    return null;
  }
  return {
    kind: grant.namespace === null ? "ClusterRoleBinding" : "RoleBinding",
    namespace: grant.namespace,
    name: bindingName(user, grant.roleName),
  };
}

export function bindingLine(binding: BoundBinding): string {
  return binding.namespace === null
    ? `Creates ClusterRoleBinding ${binding.name}.`
    : `Creates RoleBinding ${binding.name} in ${binding.namespace}.`;
}

export type RunEnd =
  | { type: "done"; expiresAt: string }
  | { type: "failed"; step: CertUserStep; error: IpcError }
  | { type: "cancelled" };

/** A run as its events tell it. */
export interface RunState {
  /** The steps begun, in order. */
  started: CertUserStep[];
  csrName: string | null;
  /** RFC 3339, while someone else must approve. */
  deadline: string | null;
  expiresAt: string | null;
  saved: boolean;
  binding: BoundBinding | null;
  bindingError: IpcError | null;
  end: RunEnd | null;
}

export const INITIAL_RUN: RunState = {
  started: [],
  csrName: null,
  deadline: null,
  expiresAt: null,
  saved: false,
  binding: null,
  bindingError: null,
  end: null,
};

export function runReducer(run: RunState, event: CertUserEvent): RunState {
  switch (event.type) {
    case "started":
      return { ...run, started: [...run.started, event.step] };
    case "submitted":
      return { ...run, csrName: event.csrName };
    case "waitingForApproval":
      return { ...run, csrName: event.csrName, deadline: event.deadline };
    case "approved":
      return { ...run, deadline: null };
    case "issued":
      return { ...run, expiresAt: event.expiresAt };
    case "saved":
      return { ...run, saved: true };
    case "bound":
      return { ...run, binding: event.binding };
    case "bindingFailed":
      return { ...run, binding: event.binding, bindingError: event.error };
    case "done":
      return { ...run, end: { type: "done", expiresAt: event.expiresAt } };
    case "failed":
      return {
        ...run,
        end: { type: "failed", step: event.step, error: event.error },
      };
    case "cancelled":
      return { ...run, end: { type: "cancelled" } };
  }
}

export const STEPS: CertUserStep[] = [
  "generateKey",
  "submit",
  "approve",
  "waitForCertificate",
  "save",
  "bind",
];

/** The steps a run shows: `bind` only with a grant. */
export function stepsFor(planned: BoundBinding | null): CertUserStep[] {
  return planned === null ? STEPS.filter((step) => step !== "bind") : STEPS;
}

export type StepState = "pending" | "running" | "waiting" | "done" | "failed";

export function stepState(run: RunState, step: CertUserStep): StepState {
  if (run.end?.type === "failed" && run.end.step === step) return "failed";
  if (step === "bind" && run.bindingError !== null) return "failed";
  const at = run.started.indexOf(step);
  if (at === -1) return "pending";
  if (step === "approve" && run.deadline !== null) return "waiting";
  return at === run.started.length - 1 && run.end === null ? "running" : "done";
}

const LABELS: Record<CertUserStep, string> = {
  generateKey: "Generate a key",
  submit: "Send the signing request",
  approve: "Approve the request",
  waitForCertificate: "Wait for the certificate",
  save: "Save the kubeconfig",
  // Shown only with a grant, which names the binding.
  bind: "Create the binding",
};

export function stepLabel(
  step: CertUserStep,
  run: RunState,
  planned: BoundBinding | null,
): string {
  if (step === "approve" && run.deadline !== null)
    return "Waiting for approval";
  if (step === "bind") {
    const binding = run.binding ?? planned;
    if (binding !== null) return `Create ${binding.kind} ${binding.name}`;
  }
  return LABELS[step];
}

/** `m:ss` until the deadline, rounded up, never below zero. */
export function timeLeft(deadline: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function savedText(user: string, expiresAt: string): string {
  return `Saved the kubeconfig for ${user} · certificate expires ${new Date(expiresAt).toLocaleString()}`;
}
