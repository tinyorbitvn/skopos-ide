import { cleanup, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { NO_ACCESS_TIP } from "../features/metrics/useNodesDisk";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { UsageItem } from "../ipc/generated/UsageItem";
import { usageItem } from "../test/metrics";
import "./index";
import { type KubeObject, objectKey } from "./objects";
import { kindSpec } from "./registry";
import {
  NOT_SERVED_TIP,
  nodeUsageColumns,
  type UsageView,
  usageColumns,
} from "./usageColumns";

const WEB: KubeObject = { metadata: { name: "web", namespace: "shop" } };
const IDLE: KubeObject = { metadata: { name: "idle", namespace: "shop" } };

function view(items: UsageItem[], notServed = false): UsageView {
  return {
    items: new Map(items.map((i) => [`${i.namespace}/${i.name}`, i])),
    notServed,
  };
}

/** The CPU and Memory cells of one row. */
function cells(usage: UsageView | undefined, row: KubeObject) {
  const [cpu, memory] = usageColumns(usage, objectKey);
  render(
    <>
      {cpu.render(row)}
      {memory.render(row)}
    </>,
  );
  return {
    cpu: screen.getByTestId("usage-cpu"),
    memory: screen.getByTestId("usage-memory"),
  };
}

test("the columns are CPU and Memory", () => {
  expect(
    usageColumns(undefined, objectKey).map((c) => [c.id, c.header]),
  ).toEqual([
    ["cpu", "CPU"],
    ["memory", "Memory"],
  ]);
});

test("cells read the row's item in the kubectl top style", () => {
  const { cpu, memory } = cells(
    view([
      usageItem({ name: "web", cpuCores: 1.25, memoryBytes: 1.2 * 2 ** 30 }),
    ]),
    WEB,
  );
  expect(cpu.textContent).toBe("1250m");
  expect(memory.textContent).toBe("1.2Gi");
  expect(cpu.getAttribute("title")).toBeNull();
});

test("small values read in millicores and Mi", () => {
  const { cpu, memory } = cells(
    view([
      usageItem({ name: "web", cpuCores: 0.004, memoryBytes: 21 * 2 ** 20 }),
    ]),
    WEB,
  );
  expect(cpu.textContent).toBe("4m");
  expect(memory.textContent).toBe("21Mi");
});

test("a row with no sample, and a list with no usage, read — with no tooltip", () => {
  const read = (usage: UsageView | undefined, row: KubeObject) => {
    const [cpu] = usageColumns(usage, objectKey);
    const { container } = render(<div>{cpu.render(row)}</div>);
    const cell = within(container).getByTestId("usage-cpu");
    return [cell.textContent, cell.getAttribute("title")];
  };
  expect(read(view([usageItem({ name: "web" })]), IDLE)).toEqual(["—", null]);
  expect(read(undefined, WEB)).toEqual(["—", null]);
  expect(read({ items: null, notServed: false }, WEB)).toEqual(["—", null]);
});

test("when metrics.k8s.io is not served, cells read — with a tooltip", () => {
  const { cpu, memory } = cells(view([usageItem({ name: "web" })], true), WEB);
  expect(cpu.textContent).toBe("—");
  expect(cpu.getAttribute("title")).toBe("metrics.k8s.io is not served");
  expect(memory.getAttribute("title")).toBe(NOT_SERVED_TIP);
});

test("they sort by the number, and a cell that shows — sorts by null", () => {
  const usage = view([
    usageItem({ name: "web", cpuCores: 0.5, memoryBytes: 2 ** 26 }),
    usageItem({ name: "broken", cpuCores: Number.NaN, memoryBytes: -1 }),
  ]);
  const [cpu, memory] = usageColumns(usage, objectKey);
  const broken: KubeObject = {
    metadata: { name: "broken", namespace: "shop" },
  };
  expect(cpu.sortValue?.(WEB)).toBe(0.5);
  expect(memory.sortValue?.(WEB)).toBe(2 ** 26);
  expect(cpu.sortValue?.(IDLE)).toBeNull();
  expect(cpu.sortValue?.(broken)).toBeNull();
  expect(memory.sortValue?.(broken)).toBeNull();
  const [notServed] = usageColumns(
    view([usageItem({ name: "web" })], true),
    objectKey,
  );
  expect(notServed.sortValue?.(WEB)).toBeNull();
});

function infoFor(
  plural: string,
  kind: string,
  namespaced: boolean,
): ApiResourceInfo {
  return {
    resource: { group: "", version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

test("Pods and Nodes show CPU and Memory where spec §11 puts them, and Nodes Disk too", () => {
  const shown = (plural: string, kind: string, namespaced: boolean) =>
    (kindSpec("", plural)?.columns?.(infoFor(plural, kind, namespaced)) ?? [])
      .filter((c) => !c.defaultHidden)
      .map((c) => c.header);
  expect(shown("pods", "Pod", true)).toEqual([
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "Node",
    "CPU",
    "Memory",
    "Age",
  ]);
  expect(shown("nodes", "Node", false)).toEqual([
    "Name",
    "Status",
    "Roles",
    "Version",
    "CPU",
    "Memory",
    "Disk",
    "Internal IP",
    "Taints",
    "Age",
  ]);
});

const NODE: KubeObject = {
  metadata: { name: "node-1" },
  status: { allocatable: { cpu: "4", memory: "16Gi" } },
};

function nodeView(items: UsageItem[], notServed = false): UsageView {
  return { items: new Map(items.map((i) => [i.name, i])), notServed };
}

test("a node's CPU and Memory are bars of its allocatable, with the share and both amounts", () => {
  const [cpu, memory] = nodeUsageColumns(
    nodeView([
      usageItem({
        namespace: null,
        name: "node-1",
        cpuCores: 0.5,
        memoryBytes: 14 * 2 ** 30,
      }),
    ]),
  );
  render(
    <>
      {cpu.render(NODE)}
      {memory.render(NODE)}
    </>,
  );
  const cpuCell = screen.getByTestId("usage-cpu");
  expect(cpuCell.getAttribute("title")).toBe("500m of 4 cores");
  expect(cpuCell.textContent).toBe("13%");
  const cpuBar = within(cpuCell).getByRole("meter", { name: "CPU used" });
  expect(cpuBar.getAttribute("aria-valuenow")).toBe("13");
  expect(cpuBar.getAttribute("data-level")).toBe("ok");
  const memoryCell = screen.getByTestId("usage-memory");
  expect(memoryCell.getAttribute("title")).toBe("14 GiB of 16 GiB");
  expect(memoryCell.textContent).toBe("88%");
  expect(within(memoryCell).getByRole("meter").getAttribute("data-level")).toBe(
    "warn",
  );
  expect(cpu.sortValue?.(NODE)).toBe(13);
});

test("a node with no allocatable reads the amount, and one with no sample reads —", () => {
  const [cpu] = nodeUsageColumns(
    nodeView([usageItem({ namespace: null, name: "node-1", cpuCores: 0.25 })]),
  );
  const bare: KubeObject = { metadata: { name: "node-1" } };
  const other: KubeObject = { metadata: { name: "node-2" } };
  render(
    <>
      {cpu.render(bare)}
      {cpu.render(other)}
    </>,
  );
  const [amount, none] = screen.getAllByTestId("usage-cpu");
  expect(amount.textContent).toBe("250m");
  expect(none.textContent).toBe("—");
  expect(screen.queryByRole("meter")).toBeNull();
  expect(cpu.sortValue?.(other)).toBeNull();
});

test("a full node's bar turns critical, and it never draws past the end", () => {
  const [cpu] = nodeUsageColumns(
    nodeView([usageItem({ namespace: null, name: "node-1", cpuCores: 4.4 })]),
  );
  render(<>{cpu.render(NODE)}</>);
  const bar = screen.getByRole("meter");
  expect(bar.getAttribute("data-level")).toBe("critical");
  expect(bar.getAttribute("aria-valuenow")).toBe("100");
  expect(screen.getByTestId("usage-cpu").textContent).toBe("110%");
});

test("a node's Disk is a bar of its root filesystem, and says when kubelets are out of reach", () => {
  const disk = (forbidden: boolean): UsageView => ({
    items: null,
    notServed: false,
    disk: {
      items: forbidden
        ? null
        : new Map([
            [
              "node-1",
              {
                name: "node-1",
                usedBytes: 30 * 2 ** 30,
                capacityBytes: 100 * 2 ** 30,
              },
            ],
          ]),
      forbidden,
    },
  });
  const [, , diskColumn] = nodeUsageColumns(disk(false));
  expect(diskColumn.header).toBe("Disk");
  render(<>{diskColumn.render(NODE)}</>);
  const cell = screen.getByTestId("usage-disk");
  expect(cell.textContent).toBe("30%");
  expect(cell.getAttribute("title")).toBe("30 GiB of 100 GiB");
  cleanup();

  const [, , blocked] = nodeUsageColumns(disk(true));
  render(<>{blocked.render(NODE)}</>);
  expect(screen.getByTestId("usage-disk").textContent).toBe("—");
  expect(screen.getByTestId("usage-disk").getAttribute("title")).toBe(
    NO_ACCESS_TIP,
  );
});

test("CPU and Memory give a filter the text their cells show, and no measure", () => {
  const usage = view([usageItem({ name: "web" })]);
  const [cpu, memory] = usageColumns(usage, objectKey);
  const shown = cells(usage, WEB);
  expect(cpu.filter?.text(WEB, 0)).toBe(shown.cpu.textContent);
  expect(memory.filter?.text(WEB, 0)).toBe(shown.memory.textContent);
  expect(cpu.filter?.measure).toBeUndefined();
  expect(cpu.filter?.text(IDLE, 0)).toBeNull();
});

test("a node's CPU and Memory give a filter the share their cells show", () => {
  const [cpu, memory] = nodeUsageColumns(
    nodeView([
      usageItem({
        namespace: null,
        name: "node-1",
        cpuCores: 0.5,
        memoryBytes: 14 * 2 ** 30,
      }),
    ]),
  );
  expect(cpu.filter?.text(NODE, 0)).toBe("13%");
  expect(memory.filter?.text(NODE, 0)).toBe("88%");
  expect(cpu.filter?.measure).toBeUndefined();
  expect(cpu.filter?.text({ metadata: { name: "node-2" } }, 0)).toBeNull();
});
