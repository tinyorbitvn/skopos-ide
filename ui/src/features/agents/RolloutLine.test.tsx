import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RolloutLine } from "./RolloutLine";

const watched = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../../stores/objectWatch", () => ({
  useWatchedObject: () => ({
    object: watched.current,
    trimmed: true,
    source: "list",
    loading: false,
    status: "live",
    message: null,
  }),
}));

const TARGET = {
  clusterId: "a",
  resource: {
    group: "apps",
    version: "v1",
    plural: "deployments",
    kind: "Deployment",
    namespaced: true,
  },
  namespace: "ns",
  name: "web",
};

function deployment(resourceVersion: string, ready: number) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "ns", resourceVersion },
    spec: { replicas: 3 },
    status: { replicas: 3, readyReplicas: ready, availableReplicas: ready },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a row that already looks settled waits 3 s before Rolled out", () => {
  watched.current = deployment("1", 3);
  render(<RolloutLine target={TARGET} />);
  expect(screen.queryByTestId("agent-rollout")).toBeNull();
  act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getByTestId("agent-rollout").textContent).toBe(
    "Rolled out 3 of 3 Pods",
  );
});

test("a changed row that settles shows Rolled out at once", () => {
  watched.current = deployment("1", 1);
  const { rerender } = render(<RolloutLine target={TARGET} />);
  watched.current = deployment("2", 3);
  rerender(<RolloutLine target={TARGET} />);
  expect(screen.getByTestId("agent-rollout").textContent).toBe(
    "Rolled out 3 of 3 Pods",
  );
});

test("after 5 minutes an unfinished rollout says so", () => {
  watched.current = deployment("1", 1);
  render(<RolloutLine target={TARGET} />);
  act(() => vi.advanceTimersByTime(300_000));
  expect(screen.getByTestId("agent-rollout").textContent).toBe(
    "Rollout not finished: 1 of 3 Pods ready",
  );
});
