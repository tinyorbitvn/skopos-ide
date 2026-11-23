import { expect, test } from "vitest";
import type { KubeObject } from "../objects";
import {
  csrCondition,
  csrConditions,
  durationText,
  isPending,
  subjectText,
} from "./csr";

const csr = (status: object): KubeObject => ({
  metadata: { name: "r" },
  spec: {},
  status,
});
const cond = (type: string, extra: object = {}) => ({
  type,
  status: "True",
  ...extra,
});

test("the condition is Denied, Failed, Issued, Approved or Pending, in that order", () => {
  expect(csrCondition(csr({}))).toEqual({ label: "Pending", tone: "warn" });
  expect(csrCondition(csr({ conditions: [cond("Approved")] }))).toEqual({
    label: "Approved",
    tone: "neutral",
  });
  expect(
    csrCondition(
      csr({ conditions: [cond("Approved")], certificate: "Q0VSVA==" }),
    ),
  ).toEqual({ label: "Issued", tone: "ok" });
  expect(
    csrCondition(
      csr({
        conditions: [cond("Approved"), cond("Failed")],
        certificate: "Q0VSVA==",
      }),
    ),
  ).toEqual({ label: "Failed", tone: "danger" });
  expect(
    csrCondition(csr({ conditions: [cond("Denied"), cond("Failed")] })),
  ).toEqual({
    label: "Denied",
    tone: "danger",
  });
  // A condition whose status is False does not count.
  expect(
    csrCondition(csr({ conditions: [cond("Approved", { status: "False" })] })),
  ).toEqual({
    label: "Pending",
    tone: "warn",
  });
  expect(isPending(csr({}))).toBe(true);
  expect(isPending(csr({ conditions: [cond("Approved")] }))).toBe(false);
});

test("a duration reads in its largest whole unit", () => {
  expect(durationText(604800)).toBe("7d");
  expect(durationText(3600)).toBe("1h");
  expect(durationText(600)).toBe("10m");
  expect(durationText(5400)).toBe("90m");
  expect(durationText(601)).toBe("601s");
  expect(durationText(undefined)).toBeUndefined();
  expect(durationText("7d")).toBeUndefined();
});

test("the subject lists the CN, then each O", () => {
  expect(
    subjectText({
      commonName: "carol",
      organizations: ["payments-devs", "oncall"],
      keyAlgorithm: "ECDSA P-256",
      notAfter: null,
    }),
  ).toBe("CN=carol, O=payments-devs, O=oncall");
  expect(
    subjectText({
      commonName: "dave",
      organizations: [],
      keyAlgorithm: "Other",
      notAfter: null,
    }),
  ).toBe("CN=dave");
});

test("condition rows keep their reason, message and update time", () => {
  expect(
    csrConditions(
      csr({
        conditions: [
          cond("Approved", {
            reason: "ApprovedInSkoposIDE",
            message: "Approved in SkoposIDE",
            lastUpdateTime: "2026-11-22T10:00:00Z",
          }),
          { type: "Broken" },
          "not a condition",
        ],
      }),
    ),
  ).toEqual([
    {
      type: "Approved",
      status: "True",
      reason: "ApprovedInSkoposIDE",
      message: "Approved in SkoposIDE",
      updated: "2026-11-22T10:00:00Z",
    },
    { type: "Broken", status: "", reason: "", message: "", updated: "" },
  ]);
});
