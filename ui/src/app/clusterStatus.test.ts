import { expect, test } from "vitest";
import { clusterStatus } from "./clusterStatus";

test("a connect that waits for permission is not shown as a failure", () => {
  expect(
    clusterStatus({
      status: "failed",
      kind: "execNotAllowed",
      message: "not allowed yet",
    }),
  ).toEqual({ label: "Needs permission", tone: "warn" });
});

test("any other failure reads Failed", () => {
  expect(
    clusterStatus({ status: "failed", kind: "unreachable", message: "no" }),
  ).toEqual({ label: "Failed", tone: "danger" });
  expect(clusterStatus({ status: "connecting" })).toEqual({
    label: "Connecting",
    tone: "info",
  });
});
