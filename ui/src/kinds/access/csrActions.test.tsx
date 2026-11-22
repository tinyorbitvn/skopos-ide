import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { mockBackend } from "../../test/ipc";
import "../index";
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

const pending = (organizations: string[]): [KubeObject, () => unknown] => [
  {
    metadata: { name: "carol-x7k2p" },
    spec: {
      signerName: "kubernetes.io/kube-apiserver-client",
      username: "kubernetes-admin",
      expirationSeconds: 86400,
      request: "UkVR",
    },
    status: {},
  },
  () => ({
    commonName: "carol",
    organizations,
    keyAlgorithm: "ECDSA P-256",
    notAfter: null,
  }),
];

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
  const [object] = pending([]);
  for (const action of CSR_ACTIONS) {
    expect(action.requires).toBeUndefined();
    expect(action.visible?.(object)).toBe(true);
    expect(
      action.visible?.({
        ...object,
        status: { conditions: [{ type: "Approved", status: "True" }] },
      }),
    ).toBe(false);
  }
});

test("Approve shows what the certificate will be, then approves", async () => {
  const [object, describe] = pending(["payments-devs"]);
  const backend = mockBackend({
    certificate_request_describe: describe,
    csr_set_approval: () => null,
  });
  const success = vi.spyOn(toast, "success");
  const { context, confirm } = ctx(true);
  await approveCsrAction.run(context, object);
  const asked = confirm.mock.calls[0][0];
  expect(asked.title).toBe("Approve certificate request carol-x7k2p?");
  expect(asked.confirmLabel).toBe("Approve");
  render(<>{asked.body}</>);
  for (const value of [
    "CN=carol, O=payments-devs",
    "kubernetes.io/kube-apiserver-client",
    "kubernetes-admin",
    "1d",
  ]) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.queryByTestId("csr-approve-system")).toBeNull();
  expect(backend.callsTo("csr_set_approval")).toEqual([
    { clusterId: "c1", name: "carol-x7k2p", decision: "Approve" },
  ]);
  expect(success).toHaveBeenCalledWith("Approved carol-x7k2p");
});

test("Approve warns when the certificate puts its holder in a system group", async () => {
  const [object, describe] = pending(["payments-devs", "system:masters"]);
  mockBackend({
    certificate_request_describe: describe,
    csr_set_approval: () => null,
  });
  const { context, confirm } = ctx(false);
  await approveCsrAction.run(context, object);
  const asked = confirm.mock.calls[0][0];
  expect(asked.danger).toBe(true);
  render(<>{asked.body}</>);
  expect(screen.getByTestId("csr-approve-system").textContent).toBe(
    "This certificate puts its holder in system:masters. Approve only requests you expect.",
  );
});

test("Deny asks, then denies; saying no sends nothing", async () => {
  const [object] = pending([]);
  const backend = mockBackend({ csr_set_approval: () => null });
  const success = vi.spyOn(toast, "success");
  const no = ctx(false);
  await denyCsrAction.run(no.context, object);
  expect(backend.callsTo("csr_set_approval")).toEqual([]);
  const yes = ctx(true);
  await denyCsrAction.run(yes.context, object);
  expect(yes.confirm.mock.calls[0][0]).toEqual({
    title: "Deny certificate request carol-x7k2p?",
    body: "The requester gets no certificate. Kubernetes deletes the request an hour later.",
    confirmLabel: "Deny",
    danger: true,
  });
  expect(backend.callsTo("csr_set_approval")).toEqual([
    { clusterId: "c1", name: "carol-x7k2p", decision: "Deny" },
  ]);
  expect(success).toHaveBeenCalledWith("Denied carol-x7k2p");
});

test("a refusal is thrown to the action runner", async () => {
  const [object, describe] = pending([]);
  mockBackend({
    certificate_request_describe: describe,
    csr_set_approval: () => {
      throw { code: "Forbidden", message: "may not approve", details: null };
    },
  });
  await expect(approveCsrAction.run(ctx(true).context, object)).rejects.toThrow(
    "may not approve",
  );
});
