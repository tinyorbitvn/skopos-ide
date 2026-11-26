import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { filterSections, PickerMenu, type PickerSection } from "./PickerMenu";

function sections(onPick: (id: string) => void): PickerSection[] {
  return [
    {
      id: "start",
      items: [
        { id: "blank", label: "Blank YAML", onSelect: () => onPick("blank") },
      ],
    },
    {
      id: "workloads",
      title: "Workloads",
      items: [
        {
          id: "deployment",
          label: "Deployment",
          keywords: ["apps"],
          onSelect: () => onPick("deployment"),
        },
        {
          id: "gateway",
          label: "Gateway",
          disabled: true,
          disabledHint: "Not served by this cluster",
          onSelect: () => onPick("gateway"),
        },
        { id: "job", label: "Job", onSelect: () => onPick("job") },
      ],
    },
  ];
}

function show(onPick = vi.fn()) {
  render(
    <PickerMenu
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          data-testid="open"
        >
          New
        </button>
      )}
      label="New tab"
      searchLabel="Search templates"
      sections={sections(onPick)}
      empty={(query) => `No template matches "${query}".`}
      testId="picker"
    />,
  );
  fireEvent.click(screen.getByTestId("open"));
  return onPick;
}

test("opens with the search focused and every section", () => {
  show();
  expect(document.activeElement).toBe(screen.getByTestId("picker-search"));
  expect(screen.getByText("Workloads")).toBeTruthy();
  expect(
    screen.getByTestId("menu-item-blank").getAttribute("aria-selected"),
  ).toBe("true");
});

test("search filters by label and keyword and hides empty sections", () => {
  show();
  fireEvent.change(screen.getByTestId("picker-search"), {
    target: { value: "apps" },
  });
  expect(screen.queryByTestId("menu-item-blank")).toBeNull();
  expect(screen.getByTestId("menu-item-deployment")).toBeTruthy();
  fireEvent.change(screen.getByTestId("picker-search"), {
    target: { value: "zzz" },
  });
  expect(screen.getByTestId("picker-empty").textContent).toBe(
    'No template matches "zzz".',
  );
});

test("arrows skip disabled items and Enter picks", () => {
  const onPick = show();
  const search = screen.getByTestId("picker-search");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(
    screen.getByTestId("menu-item-job").getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("job");
  expect(screen.queryByTestId("picker")).toBeNull();
});

test("a disabled item shows why and does nothing on click", () => {
  const onPick = show();
  const gateway = screen.getByTestId("menu-item-gateway");
  expect(gateway.getAttribute("aria-disabled")).toBe("true");
  expect(gateway.textContent).toContain("Not served by this cluster");
  fireEvent.click(gateway);
  expect(onPick).not.toHaveBeenCalled();
});

test("Escape closes and gives the focus back to the trigger; a click outside closes", () => {
  show();
  fireEvent.keyDown(screen.getByTestId("picker-search"), { key: "Escape" });
  expect(screen.queryByTestId("picker")).toBeNull();
  expect(document.activeElement).toBe(screen.getByTestId("open"));
  fireEvent.click(screen.getByTestId("open"));
  act(() => {
    window.dispatchEvent(new Event("pointerdown"));
  });
  expect(screen.queryByTestId("picker")).toBeNull();
});

test("filterSections keeps order and drops sections with nothing left", () => {
  const result = filterSections(sections(vi.fn()), "job");
  expect(result.map((s) => s.id)).toEqual(["workloads"]);
  expect(result[0].items.map((i) => i.id)).toEqual(["job"]);
});

test("a description shows under the label and the checked item is marked", () => {
  render(
    <PickerMenu
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          data-testid="open"
        >
          Model
        </button>
      )}
      label="Model"
      searchLabel="Search models"
      sections={[
        {
          id: "models",
          items: [
            {
              id: "fast",
              label: "Fast",
              description: "Quick answers",
              checked: true,
              onSelect: vi.fn(),
            },
            { id: "deep", label: "Deep", checked: false, onSelect: vi.fn() },
          ],
        },
      ]}
      empty={(query) => `No model matches "${query}".`}
      testId="models"
    />,
  );
  fireEvent.click(screen.getByTestId("open"));
  const fast = screen.getByTestId("menu-item-fast");
  expect(fast.textContent).toContain("Fast");
  expect(fast.textContent).toContain("Quick answers");
  expect(fast.getAttribute("aria-current")).toBe("true");
  expect(
    screen.getByTestId("menu-item-deep").getAttribute("aria-current"),
  ).toBeNull();
});
