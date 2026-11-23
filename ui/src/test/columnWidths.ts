import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/** UI state kept by a fake backend, as the app's store keeps it between runs. */
export function keptUiState(initial: Record<string, unknown> = {}) {
  const saved: Record<string, unknown> = { ...initial };
  return {
    saved,
    handlers: {
      ui_state_get: (a: { key: string }) => saved[a.key] ?? null,
      ui_state_set: (a: { key: string; value: unknown }) => {
        saved[a.key] = a.value;
        return null;
      },
    },
  };
}

/** The UI state that gives a table's column 200 px under the table's key. */
export function savedWidth(key: string, column: string) {
  return keptUiState({ [`column-widths:${key}`]: { [column]: 200 } });
}

/**
 * Checks that a table shows the 200 px saved for its column, and that a wider column is
 * saved under the same key.
 */
export async function expectKeptWidth(
  state: ReturnType<typeof keptUiState>,
  key: string,
  column: string,
): Promise<void> {
  const handle = () => screen.getByTestId(`column-resize-${column}`);
  await waitFor(() =>
    expect(handle().getAttribute("aria-valuenow")).toBe("200"),
  );
  fireEvent.keyDown(handle(), { key: "ArrowRight" });
  await waitFor(() =>
    expect(state.saved[`column-widths:${key}`]).toMatchObject({
      [column]: 216,
    }),
  );
}
