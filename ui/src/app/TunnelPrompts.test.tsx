import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import type { TunnelPrompt } from "../ipc/generated/TunnelPrompt";
import type { TunnelView } from "../ipc/generated/TunnelView";
import { resetTunnelsForTest, useTunnels } from "../stores/tunnels";
import { flush, mockBackend } from "../test/ipc";
import { tunnel } from "../test/tunnels";
import { TunnelPrompts } from "./TunnelPrompts";

beforeEach(() => resetTunnelsForTest());
afterEach(() => vi.restoreAllMocks());

function asking(partial: Partial<TunnelPrompt>): TunnelView {
  return tunnel({
    prompt: {
      id: "p1",
      tunnel: "t1",
      kind: "password",
      text: "me@bastion's password: ",
      canRemember: true,
      opensAtOnce: true,
      ...partial,
    },
  });
}

async function show(
  list: TunnelView[],
  over: Parameters<typeof mockBackend>[0] = {},
) {
  const backend = mockBackend({
    tunnel_list: () => list,
    tunnel_prompt_answer: () => null,
    tunnel_prompt_cancel: () => null,
    ...over,
  });
  render(<TunnelPrompts />);
  await act(flush);
  return backend;
}

test("a password prompt shows ssh's text, a masked field and Remember", async () => {
  const backend = await show([asking({})]);
  const dialog = screen.getByTestId("tunnel-prompt");
  expect(dialog.textContent).toContain('SSH for "corp"');
  expect(screen.getByTestId("tunnel-prompt-text").textContent).toBe(
    "me@bastion's password: ",
  );
  const field = screen.getByLabelText("Password") as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: "hunter2" } });
  fireEvent.click(screen.getByTestId("tunnel-prompt-remember"));
  fireEvent.click(screen.getByTestId("tunnel-prompt-continue"));
  await act(flush);
  expect(backend.callsTo("tunnel_prompt_answer")).toEqual([
    { promptId: "p1", answer: "hunter2", remember: true },
  ]);
  expect(screen.queryByTestId("tunnel-prompt")).toBeNull();
});

test("a host key asks to trust it, with no field and no Remember", async () => {
  const backend = await show([
    asking({
      kind: "hostKey",
      canRemember: false,
      text: "ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
    }),
  ]);
  expect(screen.getByTestId("tunnel-prompt-text").textContent).toContain(
    "SHA256:abc",
  );
  expect(screen.queryByTestId("tunnel-prompt-answer")).toBeNull();
  expect(screen.queryByTestId("tunnel-prompt-remember")).toBeNull();
  const trust = screen.getByTestId("tunnel-prompt-continue");
  expect(trust.textContent).toBe("Trust and connect");
  fireEvent.click(trust);
  await act(flush);
  expect(backend.callsTo("tunnel_prompt_answer")).toEqual([
    { promptId: "p1", answer: "", remember: false },
  ]);
});

test("a code is a plain field named Answer", async () => {
  await show([
    asking({ kind: "other", canRemember: false, text: "Verification code: " }),
  ]);
  const field = screen.getByLabelText("Answer") as HTMLInputElement;
  expect(field.type).toBe("text");
  expect(screen.queryByTestId("tunnel-prompt-remember")).toBeNull();
});

test("Cancel says no, and a failed send says so", async () => {
  const failed = vi.spyOn(toast, "error");
  const backend = await show([asking({})], {
    tunnel_prompt_cancel: () => {
      throw new Error("This prompt was answered already or is gone.");
    },
  });
  fireEvent.click(screen.getByTestId("tunnel-prompt-cancel"));
  await act(flush);
  expect(backend.callsTo("tunnel_prompt_cancel")).toEqual([{ promptId: "p1" }]);
  expect(failed).toHaveBeenCalledWith(
    "Could not send the answer",
    "This prompt was answered already or is gone.",
  );
  expect(screen.queryByTestId("tunnel-prompt")).toBeNull();
});

test("a prompt of a reconnect waits until the person asks for it", async () => {
  await show([asking({ opensAtOnce: false })]);
  expect(screen.queryByTestId("tunnel-prompt")).toBeNull();
  act(() => useTunnels.getState().ask("p1"));
  expect(screen.getByTestId("tunnel-prompt")).toBeTruthy();
});
