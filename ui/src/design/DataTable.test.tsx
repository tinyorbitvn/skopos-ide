import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { type Column, DataTable } from "./DataTable";

interface Row {
  id: string;
  name: string;
  age: number;
}
const rows: Row[] = [
  { id: "a", name: "bravo", age: 3 },
  { id: "b", name: "alpha", age: 9 },
  { id: "c", name: "charlie", age: 1 },
];
const columns: Column<Row>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    sortValue: (r) => r.name,
    render: (r) => r.name,
  },
  {
    id: "age",
    header: "Age",
    sortable: true,
    sortValue: (r) => r.age,
    render: (r) => String(r.age),
  },
  { id: "id", header: "Id", render: (r) => r.id },
];

afterEach(() => vi.restoreAllMocks());

function names(): string[] {
  return screen
    .getAllByTestId("row")
    .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent ?? "");
}

function renderTable(
  extra: Partial<Parameters<typeof DataTable<Row>>[0]> = {},
) {
  return render(
    <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} {...extra} />,
  );
}

test("renders all rows", () => {
  renderTable();
  expect(names()).toEqual(["bravo", "alpha", "charlie"]);
});

test("clicking a sortable header sorts ascending then descending", () => {
  renderTable();
  fireEvent.click(screen.getByRole("button", { name: /name/i }));
  expect(names()).toEqual(["alpha", "bravo", "charlie"]);
  fireEvent.click(screen.getByRole("button", { name: /name/i }));
  expect(names()).toEqual(["charlie", "bravo", "alpha"]);
});

test("sorts numerically using sortValue", () => {
  renderTable();
  fireEvent.click(screen.getByRole("button", { name: /age/i }));
  expect(names()).toEqual(["charlie", "bravo", "alpha"]);
});

test("onRowClick fires with the row", () => {
  const onRowClick = vi.fn();
  renderTable({ onRowClick });
  fireEvent.click(screen.getAllByTestId("row")[1] as HTMLElement);
  expect(onRowClick).toHaveBeenCalledWith(rows[1]);
});

test("renders the empty slot with no rows", () => {
  render(
    <DataTable
      rows={[]}
      columns={columns}
      rowKey={(r: Row) => r.id}
      empty={<p>Nothing here</p>}
    />,
  );
  expect(screen.getByText("Nothing here")).toBeTruthy();
});

test("a table can be named and a column aligned to the end", () => {
  render(
    <DataTable
      rows={rows}
      columns={[
        columns[0] as Column<Row>,
        { ...(columns[1] as Column<Row>), align: "end" },
      ]}
      rowKey={(r) => r.id}
      label="People"
    />,
  );
  const table = screen.getByRole("table", { name: "People" });
  const header = within(table).getByRole("columnheader", { name: /age/i });
  expect(getComputedStyle(header).textAlign).toBe("right");
  const [name, age] = within(table).getAllByRole("cell");
  expect(getComputedStyle(age as HTMLElement).textAlign).toBe("right");
  expect(getComputedStyle(name as HTMLElement).textAlign).not.toBe("right");
});

/**
 * Lays the header cells out as a browser would; jsdom has no layout. `shown` is each
 * column's width on screen, `natural` its width while the table measures at max-content.
 */
function headerWidths(
  shown: Record<string, number>,
  natural: Record<string, number> = {},
): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const table = this.closest("table");
      const measuring = table?.style.width === "max-content";
      const text = this.textContent ?? "";
      return {
        width: (measuring ? natural[text] : shown[text]) ?? 0,
      } as DOMRect;
    },
  );
}

const table = () => screen.getByTestId("table") as HTMLTableElement;
const colWidths = () =>
  [...table().querySelectorAll("col")].map((col) => col.style.width);

test("every column but the last has a handle; the first change fixes the widths on screen", () => {
  const changes: Record<string, number>[] = [];
  renderTable({
    testId: "table",
    onColumnWidthsChange: (w) => changes.push({ ...w }),
  });
  headerWidths({ Name: 120.4, Age: 60, Id: 200 });
  const age = screen.getByRole("separator", { name: "Resize Age" });
  expect(age.tabIndex).toBe(0);
  expect(screen.getByTestId("column-resize-name")).toBeTruthy();
  // The last column fills the rest of the table.
  expect(screen.queryByTestId("column-resize-id")).toBeNull();
  expect(table().style.tableLayout).toBe("");

  fireEvent.keyDown(age, { key: "ArrowRight" });
  expect(changes).toEqual([{ name: 120, age: 76 }]);
  expect(table().style.tableLayout).toBe("fixed");
  expect(table().style.width).toBe("max(100%, 244px)");
  expect(colWidths()).toEqual(["120px", "76px", ""]);
  expect(age.getAttribute("aria-valuenow")).toBe("76");
});

test("a double-click or Enter fits a column to its content", () => {
  renderTable({ testId: "table" });
  headerWidths({ Name: 100, Age: 100, Id: 100 }, { Name: 150.2, Age: 30 });
  fireEvent.doubleClick(screen.getByTestId("column-resize-name"));
  expect(colWidths()).toEqual(["151px", "100px", ""]);
  fireEvent.keyDown(screen.getByTestId("column-resize-age"), { key: "Enter" });
  // Never narrower than 48 px; the table is laid out as before once it has measured.
  expect(colWidths()).toEqual(["151px", "48px", ""]);
  expect(table().style.tableLayout).toBe("fixed");
  expect(table().style.width).toBe("max(100%, 247px)");
});

test("a table given its widths lays them out, not its columns' own", () => {
  renderTable({
    testId: "table",
    columns: [{ ...columns[0], width: "30%" }, ...columns.slice(1)],
    columnWidths: { name: 200, age: 80 },
  });
  expect(colWidths()).toEqual(["200px", "80px", ""]);
  const [name] = within(table()).getAllByRole("columnheader");
  expect((name as HTMLElement).style.width).toBe("");
});
