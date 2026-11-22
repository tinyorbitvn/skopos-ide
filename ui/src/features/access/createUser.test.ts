import { expect, test } from "vitest";
import type { CertUserEvent } from "../../ipc/generated/CertUserEvent";
import {
  bindingLine,
  bindingName,
  type CreateForm,
  formErrors,
  grantIncomplete,
  INITIAL_FORM,
  INITIAL_RUN,
  plannedBinding,
  type RunState,
  runReducer,
  STEPS,
  savedText,
  slug,
  stepLabel,
  stepState,
  stepsFor,
  suggestedName,
  timeLeft,
  toRequest,
} from "./createUser";

const form = (over: Partial<CreateForm>): CreateForm => ({
  ...INITIAL_FORM,
  ...over,
});
const SYSTEM = "Names that start with system: are reserved for Kubernetes.";

test("each field error is the core's, and a field shows only its first problem", () => {
  expect(formErrors(form({ user: "  " }))).toEqual({
    user: "Enter a user name.",
  });
  expect(formErrors(form({ user: "system:me" }))).toEqual({ user: SYSTEM });
  expect(formErrors(form({ user: "a".repeat(65) }))).toEqual({
    user: "Use at most 64 characters.",
  });
  // Characters, not bytes, as in the core.
  expect(formErrors(form({ user: "é".repeat(64) }))).toEqual({});
  expect(formErrors(form({ user: "carol", groups: "a, b, a" }))).toEqual({
    groups: "Each group appears once.",
  });
  expect(
    formErrors(form({ user: "carol", groups: "ok, system:masters, ok" })),
  ).toEqual({
    groups: SYSTEM,
  });
  expect(
    formErrors(
      form({ user: "carol", grant: true, roleKind: "Role", role: "reader" }),
    ),
  ).toEqual({ namespace: "Pick a namespace for a Role." });
  expect(
    formErrors(form({ user: "carol", grant: true, role: "view" })),
  ).toEqual({});
});

test("the request has trimmed names, no empty groups, and the grant picked", () => {
  const base = form({
    user: " carol ",
    groups: " payments-devs, , oncall ,",
    lifetime: "86400",
  });
  expect(toRequest(base)).toEqual({
    userName: "carol",
    groups: ["payments-devs", "oncall"],
    lifetimeSeconds: 86400,
    binding: null,
  });
  expect(toRequest({ ...base, grant: true, role: " view " }).binding).toEqual({
    roleKind: "ClusterRole",
    roleName: "view",
    namespace: null,
  });
  expect(
    toRequest({
      ...base,
      grant: true,
      role: "view",
      scope: "namespace",
      namespace: " payments ",
    }).binding,
  ).toEqual({
    roleKind: "ClusterRole",
    roleName: "view",
    namespace: "payments",
  });
  // A Role is always in a namespace, whatever the ClusterRole scope says.
  expect(
    toRequest({
      ...base,
      grant: true,
      roleKind: "Role",
      role: "reader",
      namespace: "shop",
    }).binding,
  ).toEqual({ roleKind: "Role", roleName: "reader", namespace: "shop" });
});

test("a grant without a role, or a ClusterRole in one namespace without it, cannot be sent", () => {
  expect(grantIncomplete(form({}))).toBe(false);
  expect(grantIncomplete(form({ grant: true }))).toBe(true);
  expect(grantIncomplete(form({ grant: true, role: "view" }))).toBe(false);
  expect(
    grantIncomplete(form({ grant: true, role: "view", scope: "namespace" })),
  ).toBe(true);
  // A Role without a namespace is a field error instead.
  expect(
    grantIncomplete(form({ grant: true, roleKind: "Role", role: "reader" })),
  ).toBe(false);
});

test("slugs and binding names are the core's", () => {
  expect(slug("Carol.Smith@Corp", 253)).toBe("carol-smith-corp");
  expect(slug("--A--B--", 253)).toBe("a-b");
  expect(slug("system:node:x", 253)).toBe("system-node-x");
  expect(slug("", 253)).toBe("user");
  expect(slug("!!!", 253)).toBe("user");
  expect(slug("Zoë", 253)).toBe("zo");
  expect(slug(`${"a".repeat(49)}.b`, 50)).toBe("a".repeat(49));
  expect(bindingName("Carol", "edit")).toBe("carol-edit");
  expect(bindingName("!!!", "edit")).toBe("user-edit");
  const long = bindingName("u".repeat(200), "r".repeat(200));
  expect([...long].length).toBe(253);
  expect(long.endsWith("-")).toBe(false);
});

test("the binding line names the binding the core will make", () => {
  const grant = form({ user: "Carol", grant: true, role: "edit" });
  expect(plannedBinding(grant)).toEqual({
    kind: "ClusterRoleBinding",
    namespace: null,
    name: "carol-edit",
  });
  expect(
    bindingLine({
      kind: "ClusterRoleBinding",
      namespace: null,
      name: "carol-view",
    }),
  ).toBe("Creates ClusterRoleBinding carol-view.");
  const inPayments = plannedBinding({
    ...grant,
    scope: "namespace",
    namespace: "payments",
  });
  expect(inPayments).toEqual({
    kind: "RoleBinding",
    namespace: "payments",
    name: "carol-edit",
  });
  expect(inPayments && bindingLine(inPayments)).toBe(
    "Creates RoleBinding carol-edit in payments.",
  );
  expect(plannedBinding({ ...grant, user: " " })).toBeNull();
  expect(plannedBinding({ ...grant, role: "" })).toBeNull();
  expect(plannedBinding({ ...grant, scope: "namespace" })).toBeNull();
  expect(plannedBinding(form({ user: "carol" }))).toBeNull();
});

const EXPIRES = "2030-01-01T00:00:00Z";
const BINDING = {
  kind: "RoleBinding",
  namespace: "payments",
  name: "carol-view",
} as const;
const TO_APPROVE: CertUserEvent[] = [
  { type: "started", step: "generateKey" },
  { type: "started", step: "submit" },
  { type: "submitted", csrName: "carol-x7k2p" },
  { type: "started", step: "approve" },
];
const TO_SAVED: CertUserEvent[] = [
  ...TO_APPROVE,
  { type: "approved" },
  { type: "started", step: "waitForCertificate" },
  { type: "issued", expiresAt: EXPIRES },
  { type: "started", step: "save" },
  { type: "saved" },
];
const play = (events: CertUserEvent[]) =>
  events.reduce(runReducer, INITIAL_RUN);
const states = (run: RunState) =>
  Object.fromEntries(STEPS.map((step) => [step, stepState(run, step)]));

test("steps are pending, running, then done as the events come", () => {
  const sent = play(TO_APPROVE);
  expect(sent.csrName).toBe("carol-x7k2p");
  expect(states(sent)).toEqual({
    generateKey: "done",
    submit: "done",
    approve: "running",
    waitForCertificate: "pending",
    save: "pending",
    bind: "pending",
  });
  const done = play([
    ...TO_SAVED,
    { type: "started", step: "bind" },
    { type: "bound", binding: BINDING },
    { type: "done", expiresAt: EXPIRES, binding: BINDING },
  ]);
  expect(Object.values(states(done))).toEqual(STEPS.map(() => "done"));
  expect(done.end).toEqual({ type: "done", expiresAt: EXPIRES });
  expect(done.saved).toBe(true);
  expect(done.expiresAt).toBe(EXPIRES);
});

test("waiting for someone else's approval, then approved", () => {
  const waiting = play([
    ...TO_APPROVE,
    {
      type: "waitingForApproval",
      csrName: "carol-x7k2p",
      deadline: "2026-11-22T10:15:00Z",
    },
  ]);
  expect(stepState(waiting, "approve")).toBe("waiting");
  expect(stepLabel("approve", waiting, null)).toBe("Waiting for approval");
  expect(waiting.deadline).toBe("2026-11-22T10:15:00Z");
  const approved = play([
    ...TO_APPROVE,
    {
      type: "waitingForApproval",
      csrName: "carol-x7k2p",
      deadline: "2026-11-22T10:15:00Z",
    },
    { type: "approved" },
    { type: "started", step: "waitForCertificate" },
  ]);
  expect(approved.deadline).toBeNull();
  expect(stepState(approved, "approve")).toBe("done");
  expect(stepLabel("approve", approved, null)).toBe("Approve the request");
  expect(stepState(approved, "waitForCertificate")).toBe("running");
});

test("a failed step and a failed binding are marked failed", () => {
  const error = {
    code: "Forbidden",
    message: "The request was denied: Not today.",
    details: null,
  } as const;
  const failed = play([
    ...TO_APPROVE,
    { type: "failed", step: "approve", error },
  ]);
  expect(states(failed)).toMatchObject({
    approve: "failed",
    waitForCertificate: "pending",
  });
  expect(failed.end).toEqual({ type: "failed", step: "approve", error });
  const partial = play([
    ...TO_SAVED,
    { type: "started", step: "bind" },
    {
      type: "bindingFailed",
      binding: BINDING,
      error: { ...error, code: "Conflict", message: "exists" },
    },
    { type: "done", expiresAt: EXPIRES, binding: null },
  ]);
  expect(states(partial)).toMatchObject({ save: "done", bind: "failed" });
  expect(partial.bindingError?.message).toBe("exists");
  expect(stepLabel("bind", partial, null)).toBe(
    "Create RoleBinding carol-view",
  );
});

test("the bind step shows only with a grant, named as planned until the core names it", () => {
  const planned = {
    kind: "ClusterRoleBinding",
    namespace: null,
    name: "carol-view",
  } as const;
  expect(stepsFor(null)).toEqual(STEPS.filter((s) => s !== "bind"));
  expect(stepsFor(planned)).toEqual(STEPS);
  expect(stepLabel("bind", INITIAL_RUN, planned)).toBe(
    "Create ClusterRoleBinding carol-view",
  );
  expect(STEPS.map((s) => stepLabel(s, INITIAL_RUN, planned))).toEqual([
    "Generate a key",
    "Send the signing request",
    "Approve the request",
    "Wait for the certificate",
    "Save the kubeconfig",
    "Create ClusterRoleBinding carol-view",
  ]);
});

test("time left is minutes and seconds, rounded up, never below zero", () => {
  const at = Date.parse("2026-11-22T10:00:00Z");
  expect(timeLeft("2026-11-22T10:15:00Z", at)).toBe("15:00");
  expect(timeLeft("2026-11-22T10:15:00Z", at + 1)).toBe("15:00");
  expect(timeLeft("2026-11-22T10:15:00Z", at + 1000)).toBe("14:59");
  expect(timeLeft("2026-11-22T10:00:05Z", at)).toBe("0:05");
  expect(timeLeft("2026-11-22T09:59:00Z", at)).toBe("0:00");
});

test("the file name and the saved toast", () => {
  expect(suggestedName(" carol ")).toBe("carol.kubeconfig");
  expect(suggestedName("ops/carol\\x")).toBe("ops-carol-x.kubeconfig");
  expect(suggestedName("")).toBe("user.kubeconfig");
  expect(savedText("carol", EXPIRES)).toBe(
    `Saved the kubeconfig for carol · certificate expires ${new Date(EXPIRES).toLocaleString()}`,
  );
});
