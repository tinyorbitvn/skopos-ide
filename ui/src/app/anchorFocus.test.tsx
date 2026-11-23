import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import { useAnchorFocus } from "./anchorFocus";

function Page(props: { target: string | null; ready: boolean }) {
  useAnchorFocus(props.target, props.ready);
  return (
    <section id="prefs-agents" tabIndex={-1} data-testid="target">
      Agents
    </section>
  );
}

test("focuses and scrolls to the named section once it is ready", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const { rerender, getByTestId } = render(
    <MemoryRouter>
      <Page target="prefs-agents" ready={false} />
    </MemoryRouter>,
  );
  expect(document.activeElement).not.toBe(getByTestId("target"));
  rerender(
    <MemoryRouter>
      <Page target="prefs-agents" ready />
    </MemoryRouter>,
  );
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(getByTestId("target")),
  );
  expect(scroll).toHaveBeenCalledWith({ block: "start" });
});

test("does nothing without a target", async () => {
  const { getByTestId } = render(
    <MemoryRouter>
      <Page target={null} ready />
    </MemoryRouter>,
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(document.activeElement).not.toBe(getByTestId("target"));
});
