import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { mockBackend } from "../test/ipc";
import { connectAndAsk, connectCluster } from "./clusters";
import { resetExecConsentForTest, useExecConsent } from "./execConsent";

const NOT_ALLOWED: ConnectionState = {
  status: "failed",
  kind: "execNotAllowed",
  message: "not allowed yet",
};

beforeEach(() => {
  resetExecConsentForTest();
  vi.restoreAllMocks();
});

test("a connect that needs permission opens the consent dialog for that cluster", async () => {
  mockBackend({ cluster_connect: () => NOT_ALLOWED });

  const state = await connectAndAsk("c1");

  expect(state).toEqual(NOT_ALLOWED);
  expect(useExecConsent.getState().clusterId).toBe("c1");
});

test.each<ConnectionState>([
  { status: "connecting" },
  { status: "disconnected" },
  { status: "failed", kind: "unauthorized", message: "token expired" },
])("any other outcome leaves the dialog closed: %o", async (outcome) => {
  mockBackend({ cluster_connect: () => outcome });

  await connectAndAsk("c1");

  expect(useExecConsent.getState().clusterId).toBeNull();
});

test("a connect from outside a cluster screen asks too, and is not an error", async () => {
  const error = vi.spyOn(toast, "error");
  mockBackend({ cluster_connect: () => NOT_ALLOWED });

  await connectCluster("c1");

  expect(useExecConsent.getState().clusterId).toBe("c1");
  expect(error).not.toHaveBeenCalled();
});
