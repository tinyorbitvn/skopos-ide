import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { CsrDetail } from "./CsrDetail";

const CSRS: ResourceRef = {
  group: "certificates.k8s.io",
  version: "v1",
  plural: "certificatesigningrequests",
  kind: "CertificateSigningRequest",
  namespaced: false,
};

const REQUEST: KubeObject = {
  metadata: { name: "carol-x7k2p" },
  spec: {
    signerName: "kubernetes.io/kube-apiserver-client",
    username: "kubernetes-admin",
    groups: ["kubeadm:cluster-admins", "system:authenticated"],
    usages: ["client auth"],
    expirationSeconds: 604800,
    request: "UkVRVUVTVA==",
  },
  status: {},
};

async function show(object: KubeObject, notAfter: string | null = null) {
  const backend = mockBackend({
    certificate_request_describe: () => ({
      commonName: "carol",
      organizations: ["payments-devs", "oncall"],
      keyAlgorithm: "ECDSA P-256",
      notAfter,
    }),
  });
  render(
    <MemoryRouter>
      <CsrDetail clusterId="c" object={object} resource={CSRS} resources={[]} />
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

test("the request's facts, with the subject and key read from the request", async () => {
  const backend = await show(REQUEST);
  expect(backend.callsTo("certificate_request_describe")).toEqual([
    { request: "UkVRVUVTVA==", certificate: null },
  ]);
  for (const value of [
    "kubernetes.io/kube-apiserver-client",
    "kubernetes-admin",
    "kubeadm:cluster-admins, system:authenticated",
    "client auth",
    "7d",
    "CN=carol, O=payments-devs, O=oncall",
    "ECDSA P-256",
  ]) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.queryByText("Certificate expires")).toBeNull();
  expect(screen.getByText("No conditions.")).toBeTruthy();
});

test("an issued request shows when its certificate expires, and its conditions", async () => {
  const issued: KubeObject = {
    ...REQUEST,
    status: {
      certificate: "Q0VSVA==",
      conditions: [
        {
          type: "Approved",
          status: "True",
          reason: "ApprovedInSkoposIDE",
          message: "Approved in SkoposIDE",
          lastUpdateTime: "2026-11-22T10:00:00Z",
        },
      ],
    },
  };
  const backend = await show(issued, "2030-01-01T00:00:00Z");
  expect(backend.callsTo("certificate_request_describe")).toEqual([
    { request: "UkVRVUVTVA==", certificate: "Q0VSVA==" },
  ]);
  expect(
    screen.getByText(new Date("2030-01-01T00:00:00Z").toLocaleString()),
  ).toBeTruthy();
  const rows = screen.getByTestId("csr-conditions").textContent;
  expect(rows).toContain("ApprovedInSkoposIDE");
  expect(rows).toContain("Approved in SkoposIDE");
  expect(rows).toContain(new Date("2026-11-22T10:00:00Z").toLocaleString());
});
