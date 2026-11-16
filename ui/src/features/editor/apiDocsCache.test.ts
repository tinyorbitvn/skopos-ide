import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { failureMessage } from "../../ipc/client";
import { CONFIG_MAP, DEPLOYMENT } from "../../test/apiDocs";
import { flush, mockBackend } from "../../test/ipc";
import {
  loadKindSchema,
  resetApiDocsCacheForTest,
  useKindSchema,
} from "./apiDocsCache";

const APPS = { apiVersion: "apps/v1", kind: "Deployment" };
const CORE = { apiVersion: "v1", kind: "ConfigMap" };

afterEach(() => resetApiDocsCacheForTest());

test("each kind is asked for once per cluster and kept (spec L16)", async () => {
  const calls = mockBackend({
    api_schema: (args: { kind: string }) =>
      args.kind === "Deployment" ? DEPLOYMENT : CONFIG_MAP,
  });
  const first = renderHook(() => useKindSchema("c1", APPS));
  expect(first.result.current[0]).toEqual({ status: "loading" });
  await act(flush);
  expect(first.result.current[0]).toEqual({
    status: "ready",
    schema: DEPLOYMENT,
  });

  const second = renderHook(() => useKindSchema("c1", APPS));
  expect(second.result.current[0]).toEqual({
    status: "ready",
    schema: DEPLOYMENT,
  });
  expect(await loadKindSchema("c1", APPS)).toBe(DEPLOYMENT);
  await loadKindSchema("c2", APPS);

  expect(calls.callsTo("api_schema")).toEqual([
    { clusterId: "c1", apiVersion: "apps/v1", kind: "Deployment" },
    { clusterId: "c2", apiVersion: "apps/v1", kind: "Deployment" },
  ]);
});

test("two kinds open at once each get their own answer, and one failing leaves the other (spec L16)", async () => {
  let answer: (schema: unknown) => void = () => {};
  const calls = mockBackend({
    api_schema: (args: { kind: string }) => {
      if (args.kind === "Deployment") {
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
      throw {
        code: "NotFound",
        message: "The API docs for v1 have no ConfigMap.",
        details: null,
      };
    },
  });
  const apps = renderHook(() => useKindSchema("c1", APPS));
  const core = renderHook(() => useKindSchema("c1", CORE));
  await act(flush);

  expect(apps.result.current[0]).toEqual({ status: "loading" });
  const failed = core.result.current[0];
  expect(failed?.status).toBe("failed");
  expect(failed?.status === "failed" && failureMessage(failed.error)).toBe(
    "The API docs for v1 have no ConfigMap.",
  );

  await act(async () => {
    answer(DEPLOYMENT);
    await flush();
  });
  expect(apps.result.current[0]).toEqual({
    status: "ready",
    schema: DEPLOYMENT,
  });
  expect(core.result.current[0]?.status).toBe("failed");
  expect(calls.callsTo("api_schema").map((args) => args.kind)).toEqual([
    "Deployment",
    "ConfigMap",
  ]);
});

test("an error is not kept: Retry and a later tab ask again (spec L16)", async () => {
  let fail = true;
  const calls = mockBackend({
    api_schema: () => {
      if (fail) {
        throw {
          code: "Unreachable",
          message: "connection refused",
          details: null,
        };
      }
      return DEPLOYMENT;
    },
  });
  const first = renderHook(() => useKindSchema("c1", APPS));
  await act(flush);
  expect(first.result.current[0]?.status).toBe("failed");

  const later = renderHook(() => useKindSchema("c1", APPS));
  await act(flush);
  expect(later.result.current[0]?.status).toBe("failed");

  fail = false;
  act(() => first.result.current[1]());
  expect(first.result.current[0]).toEqual({ status: "loading" });
  await act(flush);
  expect(first.result.current[0]).toEqual({
    status: "ready",
    schema: DEPLOYMENT,
  });
  expect(calls.callsTo("api_schema")).toHaveLength(3);
});

test("no kind asks nothing", async () => {
  const calls = mockBackend({});
  const { result } = renderHook(() => useKindSchema("c1", null));
  await act(flush);

  expect(result.current[0]).toBeNull();
  expect(calls.callsTo("api_schema")).toEqual([]);
});
