import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import type { ChatItem } from "../../ipc/generated/ChatItem";
import type { PermissionCard } from "../../ipc/generated/PermissionCard";
import { mockBackend } from "../../test/ipc";
import { ChatStream, type ChatStreamProps } from "./ChatStream";

function show(items: ChatItem[], more: Partial<ChatStreamProps> = {}) {
  const props: ChatStreamProps = {
    items,
    busy: false,
    agentName: "Claude",
    live: true,
    chatId: null,
    past: [],
    undone: [],
    onAnswer: vi.fn(async () => {}),
    onChoose: vi.fn(async () => {}),
    onUndo: vi.fn(),
    onShowTerminal: vi.fn(),
    onStopCommand: vi.fn(),
    onNewChat: vi.fn(),
    ...more,
  };
  render(
    <MemoryRouter>
      <ChatStream {...props} />
    </MemoryRouter>,
  );
  return props;
}

test("a message shows its object, and the agent's Markdown opens only web links", () => {
  const ipc = mockBackend({ open_external: () => null });
  show([
    {
      id: "u",
      body: {
        type: "user",
        text: "Why is it restarting?",
        object: {
          cluster: "a",
          kind: "Pod",
          namespace: "payments",
          name: "api-1",
        },
      },
    },
    {
      id: "a",
      body: {
        type: "agent",
        text: "See [runbook](https://example.com/r) or [x](javascript:alert(1)) <b>bold</b>",
      },
    },
  ]);
  expect(screen.getByText("Pod payments/api-1")).toBeTruthy();
  expect(screen.getByText("Why is it restarting?")).toBeTruthy();
  expect(screen.getByText(/<b>bold<\/b>/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "x" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "runbook (example.com)" }),
  );
  expect(ipc.callsTo("open_external")).toEqual([
    { url: "https://example.com/r" },
  ]);
});

test("the working line names the agent", () => {
  show([], { busy: true });
  expect(
    within(screen.getByTestId("agent-working")).getByText("Claude is working…"),
  ).toBeTruthy();
});

test("plan steps are done, running or waiting, and a stopped turn shows no running step", () => {
  const plan: ChatItem = {
    id: "p",
    body: {
      type: "plan",
      entries: [
        { content: "List Pods", status: "completed" },
        { content: "Read logs", status: "inProgress" },
        { content: "Explain", status: "pending" },
      ],
    },
  };
  show([plan], { busy: true });
  const box = screen.getByRole("region", { name: "Plan" });
  expect(within(box).getByRole("img", { name: "Done" })).toBeTruthy();
  expect(within(box).getByRole("status", { name: "Running" })).toBeTruthy();
  expect(within(box).getAllByRole("img", { name: "Waiting" })).toHaveLength(1);
});

test("a stopped turn shows its running step as waiting", () => {
  show(
    [
      {
        id: "p",
        body: {
          type: "plan",
          entries: [{ content: "Read logs", status: "inProgress" }],
        },
      },
    ],
    { busy: false },
  );
  expect(screen.getByRole("img", { name: "Waiting" })).toBeTruthy();
});

test("a tool card shows its result and opens its table", () => {
  show([
    {
      id: "t",
      body: {
        type: "tool",
        card: {
          id: "t",
          cluster: "prod",
          title: "Listed Pods in payments",
          result: "3 Pods, 1 not ready",
          tone: "normal",
          details: {
            type: "table",
            head: ["Name", "Status"],
            rows: [["api-1", "Running"]],
          },
          running: false,
        },
      },
    },
  ]);
  const card = screen.getByTestId("agent-tool-card");
  expect(within(card).getByText("3 Pods, 1 not ready")).toBeTruthy();
  expect(within(card).getByText("prod")).toBeTruthy();
  const head = within(card).getByRole("button", { expanded: false });
  fireEvent.click(head);
  expect(within(card).getByRole("cell", { name: "api-1" })).toBeTruthy();
});

test("the agent's own tool shows its status and content", () => {
  show([
    {
      id: "o",
      body: {
        type: "agentTool",
        title: "Edit notes.md",
        status: "failed",
        details: "denied",
      },
    },
  ]);
  expect(screen.getByText("Failed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Edit notes.md/ }));
  expect(screen.getByText("denied")).toBeTruthy();
});

test("a stored notice of a kind no longer made shows its text, and an exited notice offers a new chat", () => {
  const props = show([
    {
      id: "n1",
      body: {
        type: "notice",
        notice: { kind: "unknown" },
        text: "The sandbox blocked x.io.",
      },
    },
    {
      id: "n2",
      body: {
        type: "notice",
        notice: { kind: "exited", agent: "Claude", reason: "exit 1" },
        text: "Claude stopped unexpectedly: exit 1.",
      },
    },
  ]);
  expect(screen.getByText("The sandbox blocked x.io.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Agent sandbox" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(props.onNewChat).toHaveBeenCalled();
});

test("a sign-in notice reads as an error with its hint", () => {
  show([
    {
      id: "n1",
      body: {
        type: "notice",
        notice: { kind: "stopped" },
        text: "Stopped.",
      },
    },
    {
      id: "n2",
      body: {
        type: "notice",
        notice: {
          kind: "signInNeeded",
          agent: "Claude",
          hint: "Run claude in a terminal and sign in, then check again.",
        },
        text: "Claude needs you to sign in. Run claude in a terminal and sign in, then check again.",
      },
    },
  ]);
  const [stopped, signIn] = screen.getAllByTestId("agent-notice");
  expect(signIn.textContent).toBe(
    "Claude needs you to sign in. Run claude in a terminal and sign in, then check again.",
  );
  expect(signIn.className).toBe("noticeDanger");
  expect(stopped.className).toBe("notice");
});

test("a user message shows the YAML tab it carried", () => {
  show([
    {
      id: "u",
      body: {
        type: "user",
        text: "Add a port",
        object: null,
        tab: { tabId: "t1", title: "New Service" },
      },
    },
  ]);
  expect(screen.getByTestId("agent-user-tab").textContent).toBe(
    "YAML tab · New Service",
  );
});

function permissionItem(state: PermissionCard["state"]): ChatItem {
  return {
    id: "perm",
    body: {
      type: "permission",
      card: {
        id: "p1",
        toolCallId: "t1",
        title: "Run npm test",
        kind: "execute",
        command: "npm test",
        diffs: [],
        url: null,
        raw: null,
        options: [{ id: "allow_once", name: "Allow", kind: "allowOnce" }],
        state,
      },
    },
  };
}

test("says Waiting for you while a permission card waits", () => {
  show([permissionItem({ state: "waiting" })], { busy: true });
  expect(screen.getByTestId("agent-working").textContent).toContain(
    "Waiting for you",
  );
});

test("says the agent is working when no permission card waits", () => {
  show([permissionItem({ state: "cancelled" })], { busy: true });
  expect(screen.getByTestId("agent-working").textContent).toContain(
    "is working",
  );
});
