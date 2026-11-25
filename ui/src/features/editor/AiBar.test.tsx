import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetAgentChatForTest, useAgentChat } from "../../stores/agentChat";
import { AiBar } from "./AiBar";

let resolveAsk: (value: unknown) => void = () => {};

beforeEach(() => {
  resetAgentChatForTest();
  useAgentChat.setState({
    askFromTab: vi.fn(
      () =>
        new Promise((resolve) => {
          resolveAsk = resolve;
        }),
    ),
    stop: vi.fn(async () => {}),
  } as never);
});

function show(onClose = vi.fn()) {
  render(
    <AiBar
      tabId="create-1"
      placeholder="Describe the objects to create"
      disabled={false}
      onClose={onClose}
    />,
  );
  return onClose;
}

test("Enter sends and clears; the bar shows Working and Stop until the turn ends", async () => {
  show();
  const input = screen.getByTestId("yaml-ai-input") as HTMLTextAreaElement;
  expect(input.placeholder).toBe("Describe the objects to create");
  fireEvent.change(input, { target: { value: "a Service for web" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useAgentChat.getState().askFromTab).toHaveBeenCalledWith(
    "create-1",
    "a Service for web",
  );
  expect(input.value).toBe("");
  expect(screen.getByTestId("yaml-ai-bar").textContent).toContain("Working");
  fireEvent.click(screen.getByTestId("yaml-ai-stop"));
  expect(useAgentChat.getState().stop).toHaveBeenCalled();
  await act(async () => resolveAsk("sent"));
  expect(screen.queryByTestId("yaml-ai-stop")).toBeNull();
});

test("a failure shows its message and gives the text back", async () => {
  show();
  const input = screen.getByTestId("yaml-ai-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "go" } });
  fireEvent.click(screen.getByTestId("yaml-ai-send"));
  await act(async () =>
    resolveAsk({
      failed: "The agent may not read namespace payments on prod.",
    }),
  );
  expect(screen.getByTestId("yaml-ai-error").textContent).toBe(
    "The agent may not read namespace payments on prod.",
  );
  expect(input.value).toBe("go");
});

test("Shift+Enter adds a line and Esc closes", () => {
  const onClose = show();
  const input = screen.getByTestId("yaml-ai-input");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(useAgentChat.getState().askFromTab).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
