import { expect, test } from "vitest";
import {
  agentStateView,
  CHANGES_LABELS,
  countText,
  sandboxReason,
  whenText,
} from "./agentText";

test("agent states read as the Agents section names them", () => {
  expect(agentStateView({ state: "ready" })).toEqual({
    label: "Ready",
    tone: "ok",
  });
  expect(agentStateView({ state: "signInNeeded" })).toEqual({
    label: "Sign in needed",
    tone: "warn",
  });
  expect(agentStateView({ state: "notInstalled" })).toEqual({
    label: "Not installed",
    tone: "danger",
  });
  expect(agentStateView({ state: "doesNotStart", reason: "x" })).toEqual({
    label: "Doesn't start",
    tone: "danger",
  });
  expect(agentStateView({ state: "unknown" })).toEqual({
    label: "Checking",
    tone: "neutral",
  });
});

test("the three change settings have the spec's labels", () => {
  expect(CHANGES_LABELS).toEqual({
    ask: "Ask every time",
    readOnly: "Read only",
    dontAsk: "Don't ask",
  });
});

test("sandbox reasons name bubblewrap on Linux and Seatbelt on macOS", () => {
  expect(sandboxReason({ status: "notInstalled" }, false)).toBe(
    "bubblewrap is not installed. Install the bwrap command, then check again.",
  );
  expect(sandboxReason({ status: "cannotStart", error: "denied" }, false)).toBe(
    "bubblewrap could not start a sandbox: denied",
  );
  expect(sandboxReason({ status: "cannotStart", error: "denied" }, true)).toBe(
    "Seatbelt could not start a sandbox: denied",
  );
  expect(
    sandboxReason({ status: "ready", kind: "bubblewrap" }, false),
  ).toBeNull();
});

test("counts use the singular for one", () => {
  expect(countText(1, "cluster", "clusters")).toBe("1 cluster");
  expect(countText(3, "cluster", "clusters")).toBe("3 clusters");
  expect(countText(0, "Pod", "Pods")).toBe("0 Pods");
});

test("history times read as minutes, hours, Yesterday, then dates", () => {
  const now = new Date(2026, 10, 23, 15, 0, 0);
  const at = (d: Date) => d.toISOString();
  expect(whenText(at(new Date(2026, 10, 23, 14, 59, 40)), now)).toBe(
    "Just now",
  );
  expect(whenText(at(new Date(2026, 10, 23, 14, 58, 0)), now)).toBe(
    "2 min ago",
  );
  expect(whenText(at(new Date(2026, 10, 23, 12, 0, 0)), now)).toBe("3 h ago");
  expect(whenText(at(new Date(2026, 10, 22, 23, 0, 0)), now)).toBe("Yesterday");
  expect(whenText(at(new Date(2026, 10, 20, 9, 0, 0)), now)).toBe("Nov 20");
  expect(whenText(at(new Date(2025, 10, 20, 9, 0, 0)), now)).toBe(
    "Nov 20, 2025",
  );
  // A clock a little ahead of this one still reads as now.
  expect(whenText(at(new Date(2026, 10, 23, 15, 0, 30)), now)).toBe("Just now");
  expect(whenText("not a time", now)).toBe("");
});
