import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { CertUserEvent } from "../../ipc/generated/CertUserEvent";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { CreateUserDialog } from "./CreateUserDialog";

beforeEach(resetResourcesForTest);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type StartArgs = {
  clusterId: string;
  request: unknown;
  suggestedName: string;
  onEvent: { onmessage: (e: CertUserEvent) => void };
};

const EXPIRES = "2030-01-01T00:00:00Z";
const CANCELLED = "Cancelled. The signing request was deleted.";
const SAVED = `Saved the kubeconfig for carol · certificate expires ${new Date(EXPIRES).toLocaleString()}`;
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

function harness(start: (a: StartArgs) => unknown = () => "cert-user-1") {
  let send: (e: CertUserEvent) => void = () => {};
  const lists = new Map<string, (e: WatchEvent) => void>();
  const onClose = vi.fn();
  const success = vi.spyOn(toast, "success");
  const info = vi.spyOn(toast, "info");
  const backend = mockBackend({
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      lists.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    cert_user_create_start: (a: StartArgs) => {
      send = a.onEvent.onmessage;
      return start(a);
    },
    cert_user_create_cancel: () => null,
  });
  const view = render(<CreateUserDialog clusterId="c1" onClose={onClose} />);
  const emit = (...events: CertUserEvent[]) =>
    act(async () => {
      for (const event of events) send(event);
      await flush();
    });
  const list = (plural: string, items: KubeObject[]) =>
    act(async () => {
      lists.get(plural)?.({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  return { backend, onClose, success, info, emit, list, view };
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
const grantSwitch = () => screen.getByRole("switch", { name: "Grant access" });
const submit = () => screen.getByTestId("cu-submit") as HTMLButtonElement;
const step = (name: string) => screen.getByTestId(`cu-step-${name}`);
const buttons = () =>
  within(screen.getByTestId("cu-dialog"))
    .getAllByRole("button")
    .map((b) => b.textContent);
const options = (testId: string) =>
  [...screen.getByTestId(testId).querySelectorAll("option")].map(
    (o) => o.value,
  );

async function start(
  user: string,
  grant?: { namespace: string; role: string },
) {
  type("cu-user", user);
  if (grant) {
    fireEvent.click(grantSwitch());
    fireEvent.click(screen.getByRole("radio", { name: "One namespace" }));
    type("cu-namespace", grant.namespace);
    type("cu-role", grant.role);
  }
  await act(async () => {
    fireEvent.click(submit());
    await flush();
  });
}

test("field errors show after the first try, each under its field, and nothing is sent", async () => {
  const { backend } = harness();
  type("cu-user", "system:me");
  type("cu-groups", "a, b, a");
  fireEvent.click(grantSwitch());
  fireEvent.click(screen.getByRole("radio", { name: "Role" }));
  type("cu-role", "reader");
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => {
    fireEvent.click(submit());
    await flush();
  });
  expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([
    "Names that start with system: are reserved for Kubernetes.",
    "Each group appears once.",
    "Pick a namespace for a Role.",
  ]);
  expect(backend.callsTo("cert_user_create_start")).toEqual([]);
});

test("the binding line names what will be made, and an incomplete grant disables the button", () => {
  harness();
  expect(
    screen.getByText("Create a user with a client certificate"),
  ).toBeTruthy();
  expect(screen.getByTestId("cu-warning").textContent).toBe(
    "A client certificate can't be revoked. It works until it expires. To take access away, remove the user from its bindings.",
  );
  type("cu-user", "Carol");
  fireEvent.click(grantSwitch());
  expect(submit().disabled).toBe(true);
  expect(screen.queryByTestId("cu-binding-line")).toBeNull();
  type("cu-role", "view");
  expect(screen.getByTestId("cu-binding-line").textContent).toBe(
    "Creates ClusterRoleBinding carol-view.",
  );
  expect(submit().disabled).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "One namespace" }));
  expect(submit().disabled).toBe(true);
  type("cu-namespace", "payments");
  expect(screen.getByTestId("cu-binding-line").textContent).toBe(
    "Creates RoleBinding carol-view in payments.",
  );
  expect(submit().disabled).toBe(false);
});

test("role names come from the live list of the kind picked", async () => {
  const { list } = harness();
  fireEvent.click(grantSwitch());
  await act(flush);
  await list("clusterroles", [
    { metadata: { name: "view" } },
    { metadata: { name: "edit" } },
    { metadata: { name: "admin" } },
  ]);
  expect(options("cu-role-options")).toEqual(["admin", "edit", "view"]);
  fireEvent.click(screen.getByRole("radio", { name: "Role" }));
  type("cu-namespace", "payments");
  await act(flush);
  await list("roles", [
    { metadata: { name: "reader", namespace: "payments" } },
    { metadata: { name: "other", namespace: "shop" } },
  ]);
  expect(options("cu-role-options")).toEqual(["reader"]);
});

test("a run that may approve: the request sent, each step marked, then the toast and close", async () => {
  const { backend, onClose, success, emit } = harness();
  type("cu-user", " carol ");
  type("cu-groups", "payments-devs, , oncall");
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Certificate lifetime" }),
    {
      key: "Enter",
    },
  );
  fireEvent.click(await screen.findByRole("option", { name: "1 day" }));
  fireEvent.click(grantSwitch());
  fireEvent.click(screen.getByRole("radio", { name: "One namespace" }));
  type("cu-namespace", "payments");
  type("cu-role", "view");
  await act(async () => {
    fireEvent.click(submit());
    await flush();
  });
  expect(backend.callsTo("cert_user_create_start")).toEqual([
    expect.objectContaining({
      clusterId: "c1",
      suggestedName: "carol.kubeconfig",
      request: {
        userName: "carol",
        groups: ["payments-devs", "oncall"],
        lifetimeSeconds: 86400,
        binding: {
          roleKind: "ClusterRole",
          roleName: "view",
          namespace: "payments",
        },
      },
    }),
  ]);
  expect(screen.getByText("Creating carol")).toBeTruthy();
  await emit(...TO_APPROVE);
  const marks = [...screen.getByTestId("cu-steps").querySelectorAll("li")].map(
    (li) => li.dataset.state,
  );
  expect(marks).toEqual([
    "done",
    "done",
    "running",
    "pending",
    "pending",
    "pending",
  ]);
  expect(screen.getByTestId("cu-csr").textContent).toBe("carol-x7k2p");
  expect(step("bind").textContent).toBe("Create RoleBinding carol-view");
  expect(buttons()).toEqual(["Cancel"]);
  await emit(
    ...TO_SAVED.slice(TO_APPROVE.length),
    { type: "started", step: "bind" },
    { type: "bound", binding: BINDING },
    { type: "done", expiresAt: EXPIRES, binding: BINDING },
  );
  expect(success).toHaveBeenCalledWith(SAVED);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(backend.callsTo("cert_user_create_cancel")).toEqual([]);
});

test("a run that may not approve shows the command to run and counts down", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
  const { emit } = harness();
  await start("carol");
  await emit(...TO_APPROVE, {
    type: "waitingForApproval",
    csrName: "carol-x7k2p",
    deadline: "2026-11-22T10:15:00Z",
  });
  expect(step("approve").dataset.state).toBe("waiting");
  expect(step("approve").textContent).toBe("Waiting for approval");
  expect(screen.getByTestId("cu-waiting").textContent).toContain(
    "You may not approve this request. Ask someone who may approve kubernetes.io/kube-apiserver-client requests to run:",
  );
  expect(screen.getByTestId("cu-command").textContent).toBe(
    "kubectl certificate approve carol-x7k2p",
  );
  expect(screen.getByTestId("cu-left").textContent).toBe(
    "Waiting up to 15 minutes · 15:00 left",
  );
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByTestId("cu-left").textContent).toBe(
    "Waiting up to 15 minutes · 14:59 left",
  );
  await emit(
    { type: "approved" },
    { type: "started", step: "waitForCertificate" },
  );
  expect(screen.queryByTestId("cu-waiting")).toBeNull();
  expect(step("approve").dataset.state).toBe("done");
});

test("Cancel while running cancels the run, says the request was deleted, and ignores what follows", async () => {
  const { backend, onClose, success, info, emit } = harness();
  await start("carol");
  await emit(...TO_APPROVE);
  await act(async () => {
    fireEvent.click(screen.getByTestId("cu-cancel"));
    await flush();
  });
  expect(backend.callsTo("cert_user_create_cancel")).toEqual([
    { runId: "cert-user-1" },
  ]);
  expect(info).toHaveBeenCalledWith(CANCELLED);
  expect(onClose).toHaveBeenCalledTimes(1);
  await emit({ type: "cancelled" });
  expect(success).not.toHaveBeenCalled();
});

test("a cancel after the file is saved says the file is saved", async () => {
  const { success, info, emit } = harness();
  await start("carol", { namespace: "payments", role: "view" });
  await emit(...TO_SAVED, { type: "started", step: "bind" });
  await act(async () => {
    fireEvent.click(screen.getByTestId("cu-cancel"));
    await flush();
  });
  expect(success).toHaveBeenCalledWith(SAVED);
  expect(info).not.toHaveBeenCalled();
});

test("the binding failed after saving: the dialog stays with the notice and Close", async () => {
  const { backend, onClose, success, emit } = harness();
  await start("carol", { namespace: "payments", role: "view" });
  await emit(
    ...TO_SAVED,
    { type: "started", step: "bind" },
    {
      type: "bindingFailed",
      binding: BINDING,
      error: {
        code: "Conflict",
        message:
          'rolebindings.rbac.authorization.k8s.io "carol-view" already exists',
        details: null,
      },
    },
    { type: "done", expiresAt: EXPIRES, binding: null },
  );
  const ended = screen.getByTestId("cu-ended").textContent;
  expect(ended).toContain(
    "The kubeconfig is saved, but the RoleBinding was not created",
  );
  expect(ended).toContain(
    'rolebindings.rbac.authorization.k8s.io "carol-view" already exists',
  );
  expect(step("bind").dataset.state).toBe("failed");
  expect(success).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(buttons()).toEqual(["Close"]);
  fireEvent.click(screen.getByTestId("cu-close"));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(backend.callsTo("cert_user_create_cancel")).toEqual([]);
});

test("a failed run shows the core's message and Close", async () => {
  const { backend, onClose, emit } = harness();
  await start("carol");
  await emit(...TO_APPROVE, {
    type: "failed",
    step: "approve",
    error: {
      code: "Forbidden",
      message: "The request was denied: Not today.",
      details: null,
    },
  });
  expect(step("approve").dataset.state).toBe("failed");
  const ended = screen.getByTestId("cu-ended").textContent;
  expect(ended).toContain("Could not create the user");
  expect(ended).toContain("The request was denied: Not today.");
  fireEvent.click(screen.getByTestId("cu-close"));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(backend.callsTo("cert_user_create_cancel")).toEqual([]);
});

test("cancelling the save dialog goes back to the form", async () => {
  const { onClose, success, info } = harness(() => null);
  await start("carol");
  expect((screen.getByTestId("cu-user") as HTMLInputElement).value).toBe(
    "carol",
  );
  expect(submit().disabled).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

test("a start the core refuses shows its message on the form", async () => {
  harness(() => {
    throw {
      code: "InvalidInput",
      message: "the file must be saved in your home folder",
    };
  });
  await start("carol");
  expect(screen.getByText("Could not create the user")).toBeTruthy();
  expect(
    screen.getByText("the file must be saved in your home folder"),
  ).toBeTruthy();
  expect(screen.getByTestId("cu-user")).toBeTruthy();
});

test("leaving while a run is live cancels it", async () => {
  const { backend, info, emit, view } = harness();
  await start("carol");
  await emit(...TO_APPROVE);
  view.unmount();
  await act(flush);
  expect(backend.callsTo("cert_user_create_cancel")).toEqual([
    { runId: "cert-user-1" },
  ]);
  expect(info).toHaveBeenCalledWith(CANCELLED);
});

test("leaving while the save dialog is open cancels the run once it starts", async () => {
  let resolve: (id: string) => void = () => {};
  const { backend, view } = harness(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  await start("carol");
  view.unmount();
  await act(async () => {
    resolve("cert-user-1");
    await flush();
  });
  expect(backend.callsTo("cert_user_create_cancel")).toEqual([
    { runId: "cert-user-1" },
  ]);
});
