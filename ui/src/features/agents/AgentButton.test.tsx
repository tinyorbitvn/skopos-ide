import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test } from "vitest";
import { resetAgentChatForTest, useAgentChat } from "../../stores/agentChat";
import { AgentButton } from "./AgentButton";

const WAITING = {
  id: "k1",
  body: {
    type: "change" as const,
    card: {
      id: "k1",
      cluster: "prod",
      title: "Change Deployment a/b",
      summary: "",
      diff: [],
      command: null,
      secrets: [],
      state: { state: "waiting" as const },
      result: null,
      rollout: null,
      output: null,
      terminal: null,
    },
  },
};

beforeEach(() => resetAgentChatForTest());

function show() {
  render(
    <MemoryRouter>
      <AgentButton />
    </MemoryRouter>,
  );
  return screen.getByTestId("agent-toggle");
}

test("the button names its shortcut and is pressed while the panel is open", () => {
  const button = show();
  expect(button.getAttribute("aria-label")).toMatch(/^Agent \((Ctrl\+J|⌘J)\)$/);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  act(() =>
    useAgentChat.setState({
      open: true,
      start: { phase: "running", chatId: "c" },
    }),
  );
  expect(button.getAttribute("aria-pressed")).toBe("true");
});

test("a waiting change shows the dot while the panel is closed", () => {
  const button = show();
  act(() => useAgentChat.setState({ items: [WAITING] }));
  expect(screen.getByTestId("agent-waiting-dot")).toBeTruthy();
  expect(button.getAttribute("aria-label")).toMatch(
    /, a change is waiting for you$/,
  );
  act(() => useAgentChat.setState({ open: true }));
  expect(screen.queryByTestId("agent-waiting-dot")).toBeNull();
});

test("pressing it opens the panel", () => {
  useAgentChat.setState({ start: { phase: "ended" } });
  fireEvent.click(show());
  expect(useAgentChat.getState().open).toBe(true);
});
