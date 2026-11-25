import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PermissionCard as Card } from "../../ipc/generated/PermissionCard";
import { PermissionCard } from "./PermissionCard";

const waiting: Card = {
  id: "p1",
  toolCallId: "t1",
  title: "Run npm test",
  kind: "execute",
  command: "npm test",
  diffs: [],
  url: null,
  raw: null,
  options: [
    { id: "allow_once", name: "Allow", kind: "allowOnce" },
    { id: "allow_always", name: "Always allow", kind: "allowAlways" },
    { id: "reject_once", name: "Reject", kind: "rejectOnce" },
  ],
  state: { state: "waiting" },
};

describe("PermissionCard", () => {
  it("shows the command and the agent's options, and sends the chosen one", () => {
    const onChoose = vi.fn().mockResolvedValue(undefined);
    render(<PermissionCard card={waiting} live onChoose={onChoose} />);
    expect(screen.getByText("Run npm test")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Allow", "Always allow", "Reject"]);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(onChoose).toHaveBeenCalledWith("allow_always");
  });

  it("shows the answer instead of buttons once chosen", () => {
    const chosen: Card = {
      ...waiting,
      state: { state: "chosen", optionId: "reject_once", kind: "rejectOnce" },
    };
    render(<PermissionCard card={chosen} live onChoose={vi.fn()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Rejected once")).toBeTruthy();
  });

  it("reads Cancelled for a cancelled request and shows no buttons when the chat is not live", () => {
    render(
      <PermissionCard
        card={{ ...waiting, state: { state: "cancelled" } }}
        live={false}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows each edited file with its diff", () => {
    const edit: Card = {
      ...waiting,
      kind: "edit",
      title: "Edit values.yaml",
      command: null,
      diffs: [
        {
          path: "/w/values.yaml",
          lines: [{ kind: "added", text: "replicas: 3" }],
        },
      ],
    };
    render(<PermissionCard card={edit} live onChoose={vi.fn()} />);
    expect(screen.getByText("/w/values.yaml")).toBeTruthy();
    expect(screen.getByText(/replicas: 3/)).toBeTruthy();
  });
});
