import { describe, expect, test, vi } from "vitest";
import type { TableColumn } from "../../design/VirtualTable";
import type { KubeObject } from "../../kinds/objects";
import {
  filterColumns,
  headerKey,
  parseDuration,
  parseNumber,
  rowValues,
} from "./columnFilter";

const column = (
  id: string,
  header: string,
  text: (o: KubeObject) => string | null = () => "x",
): TableColumn<KubeObject> => ({
  id,
  header,
  width: 80,
  render: () => null,
  filter: { text },
});
const keys = (columns: TableColumn<KubeObject>[]) =>
  filterColumns(columns, []).map((c) => c.key);

describe("headerKey", () => {
  test.each([
    ["Status", "status"],
    ["Cluster IP", "cluster-ip"],
    ["  Last   seen ", "last-seen"],
    ["Up-to-date", "up-to-date"],
    ["Ready=?", "ready?"],
    ["A:b!c<d>e", "abcde"],
    ["Pods (Ready)", "pods-(ready)"],
    ["Label", "label-column"],
    ["ANNO", "anno-column"],
    ["", "column"],
    [" : ", "column"],
  ])("%j is %j", (header, key) => {
    expect(headerKey(header)).toBe(key);
  });
});

describe("filterColumns", () => {
  test("keeps table order, skips columns without a filter, and marks hidden ones", () => {
    const actions: TableColumn<KubeObject> = {
      id: "actions",
      header: "Actions",
      width: 72,
      render: () => null,
    };
    const result = filterColumns(
      [
        column("name", "Name"),
        column("ip", "IP"),
        actions,
        column("node", "Node"),
      ],
      ["ip"],
    );
    expect(result.map((c) => [c.key, c.header, c.hidden])).toEqual([
      ["name", "Name", false],
      ["ip", "IP", true],
      ["node", "Node", false],
    ]);
  });

  test("the default Name and Namespace own their words; any other column takes the next free key", () => {
    expect(
      keys([
        column("name", "Name"),
        column("namespace", "Namespace"),
        column("printer-Name", "Name"),
        column("printer-Namespace", "Namespace"),
        column("status", "Status"),
        column("printer-Status", "Status"),
        column("printer-status", "status"),
        column("printer-Label", "Label"),
        column("printer-Label2", "label"),
      ]),
    ).toEqual([
      "name",
      "namespace",
      "name-2",
      "namespace-2",
      "status",
      "status-2",
      "status-3",
      "label-column",
      "label-column-2",
    ]);
  });

  test("a list without a Namespace column still keeps the word namespace", () => {
    expect(
      keys([column("name", "Name"), column("printer-Namespace", "Namespace")]),
    ).toEqual(["name", "namespace-2"]);
  });
});

describe("numbers and times", () => {
  test.each([
    ["0", 0],
    ["3", 3],
    ["-1", -1],
    ["2.5", 2.5],
    [" 7 ", 7],
    ["1e3", null],
    ["0x10", null],
    ["1,000", null],
    ["3m", null],
    [".5", null],
    ["", null],
  ])("parseNumber(%j) is %j", (text, value) => {
    expect(parseNumber(text)).toBe(value);
  });

  test.each([
    ["30s", 30],
    ["5m", 300],
    ["2h", 7200],
    ["7d", 604_800],
    ["1y", 31_536_000],
    ["2h30m", 9000],
    ["1d12h", 129_600],
    ["1H", 3600],
    [" 2m ", 120],
    ["90", null],
    ["1h 30m", null],
    ["1w", null],
    ["h", null],
    ["abc", null],
    ["", null],
  ])("parseDuration(%j) is %j", (text, value) => {
    expect(parseDuration(text)).toBe(value);
  });
});

describe("rowValues", () => {
  test("works out each cell once per row and time, and keeps the shown text and its lower case", () => {
    const text = vi.fn((o: KubeObject) => o.metadata.name.toUpperCase());
    const amount = vi.fn(() => 4);
    const columns = filterColumns(
      [
        {
          ...column("node", "Node"),
          filter: { text, measure: { kind: "number", amount } },
        },
      ],
      [],
    );
    const row: KubeObject = { metadata: { name: "Web" } };
    const values = rowValues(columns, 0);
    expect(values.cells(row).get("node")).toEqual({
      text: "WEB",
      lower: "web",
      amount: 4,
    });
    values.cells(row);
    values.cells(row);
    expect(text).toHaveBeenCalledTimes(1);
    expect(amount).toHaveBeenCalledTimes(1);

    rowValues(columns, 30_000).cells(row);
    expect(text).toHaveBeenCalledTimes(2);
    expect(text).toHaveBeenLastCalledWith(row, 30_000);
  });

  test("an empty cell has no text and no amount", () => {
    const columns = filterColumns([column("ip", "IP", () => null)], []);
    expect(
      rowValues(columns, 0)
        .cells({ metadata: { name: "x" } })
        .get("ip"),
    ).toEqual({ text: null, lower: null, amount: null });
  });
});
