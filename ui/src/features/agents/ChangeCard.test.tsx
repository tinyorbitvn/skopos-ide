import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ChangeCard as Card } from "../../ipc/generated/ChangeCard";
import { ChangeCard } from "./ChangeCard";

vi.mock("./RolloutLine", () => ({
  RolloutLine: () => <p data-testid="agent-rollout">rollout</p>,
}));

function card(partial: Partial<Card>): Card {
  return {
    id: "k1",
    cluster: "prod-eu-west",
    title: "Change Deployment payments/api",
    summary: "Set MODE=fast on main",
    diff: [
      { kind: "context", text: "env:" },
      { kind: "removed", text: "  value: slow" },
      { kind: "added", text: "  value: fast" },
    ],
    command: null,
    secrets: [],
    state: { state: "waiting" },
    result: null,
    rollout: {
      clusterId: "a",
      resource: {
        group: "apps",
        version: "v1",
        plural: "deployments",
        kind: "Deployment",
        namespaced: true,
      },
      namespace: "payments",
      name: "api",
    },
    output: null,
    terminal: null,
    ...partial,
  };
}

function show(
  c: Card,
  more: { live?: boolean; follow?: boolean; undone?: boolean } = {},
) {
  const onAnswer = vi.fn(async () => {});
  const onUndo = vi.fn();
  const onShowTerminal = vi.fn();
  const onStop = vi.fn();
  const { unmount } = render(
    <ChangeCard
      card={c}
      live={more.live ?? true}
      follow={more.follow ?? true}
      undone={more.undone ?? false}
      onAnswer={onAnswer}
      onUndo={onUndo}
      onShowTerminal={onShowTerminal}
      onStop={onStop}
    />,
  );
  return {
    onAnswer,
    onUndo,
    onShowTerminal,
    onStop,
    unmount,
    root: screen.getByTestId("agent-change-card"),
  };
}

test("a waiting card shows the diff, the note and three answers", () => {
  const { onAnswer, root } = show(card({}));
  expect(
    within(root).getByRole("group", { name: "Diff" }).textContent,
  ).toContain("+   value: fast");
  expect(
    within(root).getByText("The agent waits for your answer."),
  ).toBeTruthy();
  fireEvent.click(within(root).getByTestId("agent-approve-chat"));
  expect(onAnswer).toHaveBeenCalledWith("approveForChat");
  expect(within(root).getByTestId("agent-deny")).toBeTruthy();
  expect(within(root).getByTestId("agent-approve")).toBeTruthy();
});

test("a stored waiting card takes no answer", () => {
  const { root } = show(card({}), { live: false });
  expect(within(root).queryByTestId("agent-approve")).toBeNull();
});

test("approved for this chat offers Undo until it is undone", () => {
  const approved = card({
    state: { state: "approved", at: "14:02", standing: true },
  });
  const { onUndo, root } = show(approved);
  expect(within(root).getByText("Approved. Applied at 14:02.")).toBeTruthy();
  expect(
    within(root).getByText(/Later changes in this chat run without asking./),
  ).toBeTruthy();
  fireEvent.click(within(root).getByTestId("agent-undo"));
  expect(onUndo).toHaveBeenCalled();
  expect(within(root).getByTestId("agent-rollout")).toBeTruthy();
});

test("an undone approval keeps its outcome but drops the standing line", () => {
  const { root } = show(
    card({ state: { state: "approved", at: "14:02", standing: true } }),
    {
      undone: true,
    },
  );
  expect(within(root).getByText("Approved. Applied at 14:02.")).toBeTruthy();
  expect(within(root).queryByTestId("agent-undo")).toBeNull();
});

test("outcomes read as the spec words them", () => {
  const cases: [Card["state"], string][] = [
    [
      { state: "appliedWithoutAsking", standing: false },
      "Applied without asking. Your setting for prod-eu-west allows it.",
    ],
    [
      { state: "appliedWithoutAsking", standing: true },
      "Applied without asking. You approved changes for this chat.",
    ],
    [{ state: "denied" }, "Denied. The agent was told no."],
    [{ state: "stopped" }, "Stopped. Nothing was changed."],
    [
      { state: "failed", message: "admission webhook denied" },
      "Failed: admission webhook denied",
    ],
  ];
  for (const [state, text] of cases) {
    const { unmount } = render(
      <ChangeCard
        card={card({ state })}
        live
        follow
        undone={false}
        onAnswer={vi.fn()}
        onUndo={vi.fn()}
        onShowTerminal={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText(text)).toBeTruthy();
    unmount();
  }
});

test("Secrets the change exposes are named, and a past card follows no rollout", () => {
  const { root } = show(
    card({
      secrets: ["db-creds", "api-key"],
      state: { state: "approved", at: "09:00", standing: false },
    }),
    { follow: false },
  );
  expect(
    within(root).getByText(
      "This change lets a workload read these Secrets: db-creds, api-key.",
    ),
  ).toBeTruthy();
  expect(within(root).queryByTestId("agent-rollout")).toBeNull();
});

function command(partial: Partial<Card>): Card {
  return card({
    title: "Run a command on prod-eu-west",
    diff: [],
    rollout: null,
    command: ["kubectl get pods -A\nkubectl get nodes"],
    terminal: "a",
    ...partial,
  });
}

test("a running command shows its lines, Show in terminal and Stop", () => {
  const { onShowTerminal, onStop, root } = show(
    command({ state: { state: "running" }, output: "NAME READY\nweb 1/1" }),
  );
  expect(within(root).getByText("Running…")).toBeTruthy();
  expect(root.querySelector("pre")?.textContent).toBe(
    "kubectl get pods -A\nkubectl get nodes",
  );
  expect(root.textContent).toContain("web 1/1");
  fireEvent.click(within(root).getByTestId("agent-command-show"));
  expect(onShowTerminal).toHaveBeenCalled();
  fireEvent.click(within(root).getByTestId("agent-command-stop"));
  expect(onStop).toHaveBeenCalled();
});

test("a finished command keeps Show in terminal and loses Stop", () => {
  const { root } = show(
    command({
      state: { state: "appliedWithoutAsking", standing: false },
      result: "exit 0",
    }),
  );
  expect(within(root).getByTestId("agent-command-show")).toBeTruthy();
  expect(within(root).queryByTestId("agent-command-stop")).toBeNull();
  expect(root.textContent).toContain("exit 0");
});

test("a command stopped while it ran says so", () => {
  const { root } = show(command({ state: { state: "stoppedRunning" } }));
  expect(within(root).getByText("Stopped while it ran.")).toBeTruthy();
});

test("a waiting, denied or stored command has no terminal buttons", () => {
  for (const state of [{ state: "waiting" }, { state: "denied" }] as const) {
    const { root, unmount } = show(command({ state }));
    expect(within(root).queryByTestId("agent-command-show")).toBeNull();
    unmount();
  }
  const { root } = show(command({ state: { state: "running" } }), {
    live: false,
  });
  expect(within(root).queryByTestId("agent-command-show")).toBeNull();
  expect(within(root).queryByTestId("agent-command-stop")).toBeNull();
});
