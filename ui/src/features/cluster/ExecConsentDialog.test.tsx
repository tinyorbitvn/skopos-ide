import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { ExecRequest } from "../../ipc/generated/ExecRequest";
import type { ExecRequestDetails } from "../../ipc/generated/ExecRequestDetails";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import {
  resetExecConsentForTest,
  useExecConsent,
} from "../../stores/execConsent";
import { clusterEntry, mockBackend } from "../../test/ipc";
import { ExecConsentDialog } from "./ExecConsentDialog";

const REQUEST: ExecRequest = {
  requestId: 7,
  kind: "exec",
  command: "/usr/local/bin/aws",
  argCount: 4,
  envNames: ["AWS_PROFILE"],
  server: "https://prod.example:6443",
  sourcePath: "/home/me/.kube/config",
  contextName: "prod",
  changed: false,
};

const DETAILS: ExecRequestDetails = {
  args: ["eks", "get-token", "--cluster-name", "S3CRET-ARG"],
  env: [{ name: "AWS_PROFILE", value: "S3CRET-ENV" }],
};

type Handlers = Parameters<typeof mockBackend>[0];

function open(handlers: Handlers) {
  useCatalog.setState({
    loading: false,
    error: null,
    clusters: [clusterEntry({ id: "c1", name: "Production" })],
  });
  const ipc = mockBackend({ cluster_exec_request: () => REQUEST, ...handlers });
  render(<ExecConsentDialog />);
  act(() => useExecConsent.getState().ask("c1"));
  return ipc;
}

async function show(handlers: Handlers = {}) {
  const ipc = open(handlers);
  await screen.findByTestId("exec-consent-dialog");
  return ipc;
}

function allowButton(): HTMLElement {
  return screen.getByRole("button", { name: "Allow and connect" });
}

beforeEach(() => {
  resetCatalogForTest();
  resetExecConsentForTest();
  vi.restoreAllMocks();
});

test("shows what would run without its arguments", async () => {
  const ipc = await show();

  expect(screen.getByText("Let this kubeconfig run a program?")).toBeTruthy();
  expect(screen.getByText(/To sign in to Production,/)).toBeTruthy();
  expect(screen.getByTestId("exec-consent-program").textContent).toBe(
    "/usr/local/bin/aws",
  );
  expect(screen.getByTestId("exec-consent-args").textContent).toContain(
    "4 arguments",
  );
  expect(screen.getByTestId("exec-consent-env").textContent).toBe(
    "AWS_PROFILE",
  );
  expect(screen.getByText("https://prod.example:6443")).toBeTruthy();
  expect(screen.getByText("/home/me/.kube/config · context prod")).toBeTruthy();
  expect(screen.queryByTestId("exec-consent-changed")).toBeNull();
  expect(document.body.textContent).not.toContain("S3CRET");
  expect(ipc.callsTo("cluster_exec_request_details")).toHaveLength(0);
});

test("never opens with Allow and connect focused", async () => {
  await show();

  expect(document.activeElement).not.toBe(allowButton());
});

test("Show arguments reads and shows the arguments and the values", async () => {
  const ipc = await show({ cluster_exec_request_details: () => DETAILS });

  fireEvent.click(screen.getByTestId("exec-consent-show"));

  await waitFor(() =>
    expect(screen.getByTestId("exec-consent-args").textContent).toContain(
      "S3CRET-ARG",
    ),
  );
  expect(screen.getByTestId("exec-consent-env").textContent).toBe(
    "AWS_PROFILE=S3CRET-ENV",
  );
  expect(screen.queryByTestId("exec-consent-show")).toBeNull();
  expect(ipc.callsTo("cluster_exec_request_details")).toEqual([
    { id: "c1", requestId: 7 },
  ]);
});

test("a program with no arguments and no environment offers nothing to show", async () => {
  await show({
    cluster_exec_request: () => ({ ...REQUEST, argCount: 0, envNames: [] }),
  });

  expect(screen.getByTestId("exec-consent-args").textContent).toBe("None");
  expect(screen.getByTestId("exec-consent-env").textContent).toBe("None");
  expect(screen.queryByTestId("exec-consent-show")).toBeNull();
});

test("says so when what runs changed since it was allowed", async () => {
  await show({ cluster_exec_request: () => ({ ...REQUEST, changed: true }) });

  expect(screen.getByTestId("exec-consent-changed").textContent).toBe(
    "The program, the cluster address or its TLS and proxy settings have changed since you allowed it.",
  );
});

test("Allow and connect allows the shown request, then connects", async () => {
  const ipc = await show({
    cluster_exec_allow: () => null,
    cluster_connect: () => ({ status: "connecting" }),
  });

  fireEvent.click(allowButton());

  await waitFor(() => expect(ipc.callsTo("cluster_connect")).toHaveLength(1));
  expect(ipc.calls.map((c) => c.cmd)).toEqual([
    "cluster_exec_request",
    "cluster_exec_allow",
    "cluster_connect",
  ]);
  expect(ipc.callsTo("cluster_exec_allow")).toEqual([
    { id: "c1", requestId: 7 },
  ]);
  expect(screen.queryByTestId("exec-consent-dialog")).toBeNull();
});

test("Cancel closes the dialog and allows nothing", async () => {
  const ipc = await show();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  await waitFor(() =>
    expect(screen.queryByTestId("exec-consent-dialog")).toBeNull(),
  );
  expect(useExecConsent.getState().clusterId).toBeNull();
  expect(ipc.callsTo("cluster_exec_allow")).toHaveLength(0);
  expect(ipc.callsTo("cluster_connect")).toHaveLength(0);
});

test("a stale request shows what the kubeconfig says now", async () => {
  let reads = 0;
  const ipc = await show({
    cluster_exec_request: () => {
      reads += 1;
      return reads === 1
        ? REQUEST
        : { ...REQUEST, requestId: 8, command: "/tmp/other" };
    },
    cluster_exec_allow: () =>
      Promise.reject({ code: "Conflict", message: "review it again" }),
  });

  fireEvent.click(allowButton());

  await waitFor(() =>
    expect(screen.getByTestId("exec-consent-program").textContent).toBe(
      "/tmp/other",
    ),
  );
  expect(ipc.callsTo("cluster_connect")).toHaveLength(0);
});

test("a kubeconfig that changed in between asks again", async () => {
  let reads = 0;
  await show({
    cluster_exec_request: () => {
      reads += 1;
      return reads === 1
        ? REQUEST
        : { ...REQUEST, requestId: 8, changed: true };
    },
    cluster_exec_allow: () => null,
    cluster_connect: () => ({
      status: "failed",
      kind: "execNotAllowed",
      message: "changed",
    }),
  });

  fireEvent.click(allowButton());

  expect(await screen.findByTestId("exec-consent-changed")).toBeTruthy();
});

test("a failed allow says so and does not connect", async () => {
  const error = vi.spyOn(toast, "error");
  const ipc = await show({
    cluster_exec_allow: () =>
      Promise.reject({ code: "Internal", message: "disk full" }),
  });

  fireEvent.click(allowButton());

  await waitFor(() =>
    expect(error).toHaveBeenCalledWith("Could not allow", "disk full"),
  );
  expect(screen.getByTestId("exec-consent-dialog")).toBeTruthy();
  expect(ipc.callsTo("cluster_connect")).toHaveLength(0);
});

test("closes when nothing is held any more", async () => {
  open({
    cluster_exec_request: () =>
      Promise.reject({ code: "NotFound", message: "nothing is waiting" }),
  });

  await waitFor(() => expect(useExecConsent.getState().clusterId).toBeNull());
  expect(screen.queryByTestId("exec-consent-dialog")).toBeNull();
});
