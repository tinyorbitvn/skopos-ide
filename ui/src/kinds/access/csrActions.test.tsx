import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { mockBackend } from "../../test/ipc";
import "../index";
import type { CsrReview } from "../../ipc/generated/CsrReview";
import type { KubeObject } from "../objects";
import { type ActionContext, kindSpec } from "../registry";
import { approveCsrAction, CSR_ACTIONS, denyCsrAction } from "./csrActions";

afterEach(() => vi.restoreAllMocks());

const CSRS = {
  group: "certificates.k8s.io",
  version: "v1",
  plural: "certificatesigningrequests",
  kind: "CertificateSigningRequest",
  namespaced: false,
};

function ctx(answer: boolean) {
  const confirm = vi.fn<ActionContext["confirm"]>(async () => answer);
  const context: ActionContext = {
    clusterId: "c1",
    resource: CSRS,
    navigate: vi.fn(),
    confirm,
    openEditor: vi.fn(),
    dialog: vi.fn(),
  };
  return { context, confirm };
}

const OBJECT: KubeObject = {
  metadata: { name: "carol-x7k2p", uid: "u-1" },
  spec: {
    signerName: "kubernetes.io/kube-apiserver-client",
    username: "kubernetes-admin",
    expirationSeconds: 86400,
    request: "UkVR",
  },
  status: {},
};

/** What the core read for the confirm; its uid is the one approved. */
const review = (changes: Partial<CsrReview> = {}): CsrReview => ({
  uid: "u-1",
  signer: "kubernetes.io/kube-apiserver-client",
  requestor: "kubernetes-admin",
  expirationSeconds: 86400,
  info: {
    commonName: "carol",
    organizations: ["payments-devs"],
    keyAlgorithm: "ECDSA P-256",
    notAfter: null,
  },
  grants: [],
  grantsError: null,
  privileged: [],
  ...changes,
});

test("the kind lists Signer, Requestor, Duration and Condition, and both actions", () => {
  const spec = kindSpec("certificates.k8s.io", "certificatesigningrequests");
  expect(spec?.ownConditions).toBe(true);
  expect(spec?.actions?.map((a) => a.id)).toEqual(["csr-approve", "csr-deny"]);
  const ids = spec?.columns?.({ resource: CSRS } as never).map((c) => c.id);
  expect(ids).toEqual(
    expect.arrayContaining(["signer", "requestor", "duration", "condition"]),
  );
  expect(ids?.indexOf("condition")).toBe((ids?.indexOf("duration") ?? 0) + 1);
});

test("both actions show only while the request is pending, and neither asks for access", () => {
  for (const action of CSR_ACTIONS) {
    expect(action.requires).toBeUndefined();
    expect(action.visible?.(OBJECT)).toBe(true);
    expect(
      action.visible?.({
        ...OBJECT,
        status: { conditions: [{ type: "Approved", status: "True" }] },
      }),
    ).toBe(false);
  }
});

test("Approve shows what the core read, then approves that request by its uid", async () => {
  const backend = mockBackend({
    csr_review: () =>
      review({
        grants: [
          {
            binding: {
              kind: "RoleBinding",
              namespace: "payments",
              name: "devs-edit",
              resourceVersion: "7",
            },
            subject: { kind: "Group", name: "payments-devs" },
            roleKind: "ClusterRole",
            roleName: "edit",
          },
        ],
      }),
    csr_set_approval: () => null,
  });
  const success = vi.spyOn(toast, "success");
  const { context, confirm } = ctx(true);
  await approveCsrAction.run(context, OBJECT);
  expect(backend.callsTo("csr_review")).toEqual([
    { clusterId: "c1", name: "carol-x7k2p" },
  ]);
  const asked = confirm.mock.calls[0][0];
  expect(asked.title).toBe("Approve certificate request carol-x7k2p?");
  expect(asked.confirmLabel).toBe("Approve");
  expect(asked.danger).toBe(false);
  render(<>{asked.body}</>);
  for (const value of [
    "CN=carol, O=payments-devs",
    "kubernetes.io/kube-apiserver-client",
    "kubernetes-admin",
    "1d",
    "RoleBinding payments/devs-edit",
    "Group payments-devs",
    "ClusterRole edit",
  ]) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.queryByTestId("csr-approve-privileged")).toBeNull();
  expect(backend.callsTo("csr_set_approval")).toEqual([
    { clusterId: "c1", name: "carol-x7k2p", uid: "u-1", decision: "Approve" },
  ]);
  expect(success).toHaveBeenCalledWith("Approved carol-x7k2p");
});

test("Approve warns when the user or a group holds privileged access", async () => {
  mockBackend({
    csr_review: () =>
      review({ privileged: ["system:kube-controller-manager", "admins"] }),
    csr_set_approval: () => null,
  });
  const { context, confirm } = ctx(false);
  await approveCsrAction.run(context, OBJECT);
  const asked = confirm.mock.calls[0][0];
  expect(asked.danger).toBe(true);
  render(<>{asked.body}</>);
  expect(screen.getByTestId("csr-approve-privileged").textContent).toBe(
    "This certificate gives its holder the access of system:kube-controller-manager, admins. Approve only requests you expect.",
  );
});

test("Approve says so when the bindings cannot be read, and lists none", async () => {
  mockBackend({
    csr_review: () =>
      review({ grants: null, grantsError: "clusterrolebindings is forbidden" }),
  });
  const { context, confirm } = ctx(false);
  await approveCsrAction.run(context, OBJECT);
  render(<>{confirm.mock.calls[0][0].body}</>);
  expect(screen.getByTestId("csr-approve-grants-error").textContent).toBe(
    "Could not read the bindings that name this user and its groups: clusterrolebindings is forbidden",
  );
  expect(screen.queryByTestId("csr-approve-grants")).toBeNull();
});

test("a request the core cannot read is not offered for approval", async () => {
  const backend = mockBackend({
    csr_review: () => {
      throw {
        code: "InvalidInput",
        message:
          "the signing request has more than one CN, so the user it names is not clear",
        details: null,
      };
    },
  });
  const { context, confirm } = ctx(true);
  await expect(approveCsrAction.run(context, OBJECT)).rejects.toThrow(
    "more than one CN",
  );
  expect(confirm).not.toHaveBeenCalled();
  expect(backend.callsTo("csr_set_approval")).toEqual([]);
});

test("Deny asks, then denies the request shown by its uid; saying no sends nothing", async () => {
  const backend = mockBackend({ csr_set_approval: () => null });
  const success = vi.spyOn(toast, "success");
  const no = ctx(false);
  await denyCsrAction.run(no.context, OBJECT);
  expect(backend.callsTo("csr_set_approval")).toEqual([]);
  const yes = ctx(true);
  await denyCsrAction.run(yes.context, OBJECT);
  expect(yes.confirm.mock.calls[0][0]).toEqual({
    title: "Deny certificate request carol-x7k2p?",
    body: "The requester gets no certificate. Kubernetes deletes the request an hour later.",
    confirmLabel: "Deny",
    danger: true,
  });
  expect(backend.callsTo("csr_set_approval")).toEqual([
    { clusterId: "c1", name: "carol-x7k2p", uid: "u-1", decision: "Deny" },
  ]);
  expect(success).toHaveBeenCalledWith("Denied carol-x7k2p");
});

test("a refusal is thrown to the action runner", async () => {
  mockBackend({
    csr_review: () => review(),
    csr_set_approval: () => {
      throw {
        code: "Conflict",
        message: "the request was replaced since you reviewed it",
        details: null,
      };
    },
  });
  await expect(approveCsrAction.run(ctx(true).context, OBJECT)).rejects.toThrow(
    "the request was replaced since you reviewed it",
  );
});
