import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import { baseColumns, numberColumn, statusColumn, textColumn } from "./columns";

const POD: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
const NODE: ResourceRef = {
  group: "",
  version: "v1",
  plural: "nodes",
  kind: "Node",
  namespaced: false,
};
const object = { metadata: { name: "x" } };

test("baseColumns puts name and namespace first and age last", () => {
  const extra = textColumn("a", "A", () => "1");
  expect(baseColumns(POD, extra).map((c) => c.id)).toEqual([
    "name",
    "namespace",
    "a",
    "age",
  ]);
  expect(baseColumns(NODE, extra).map((c) => c.id)).toEqual([
    "name",
    "a",
    "age",
  ]);
});

test("an empty text cell reads as a dash and sorts as empty", () => {
  const column = textColumn("a", "A", () => undefined);
  render(<div>{column.render(object)}</div>);
  expect(screen.getByText("-")).toBeTruthy();
  expect(column.sortValue?.(object)).toBe("");
});

test("a number column sorts numerically and treats a missing value as zero", () => {
  const column = numberColumn("n", "N", () => undefined);
  expect(column.sortValue?.(object)).toBe(0);
});

test("a status column shows a badge and sorts by its label", () => {
  const column = statusColumn(() => ({ label: "Running", tone: "ok" }));
  render(<div>{column.render(object)}</div>);
  expect(screen.getByText("Running")).toBeTruthy();
  expect(column.sortValue?.(object)).toBe("Running");
});

test("the helpers give a filter the text their cells show", () => {
  const scheduled = { metadata: { name: "x" }, spec: { nodeName: "w1" } };
  const node = textColumn("node", "Node", (o) => o.spec?.nodeName);
  expect(node.filter?.text(scheduled, 0)).toBe("w1");
  expect(node.filter?.text(object, 0)).toBeNull();
  expect(node.filter?.measure).toBeUndefined();

  const restarts = numberColumn(
    "restarts",
    "Restarts",
    (o) => o.spec?.restarts,
  );
  expect(restarts.filter?.text(object, 0)).toBe("0");
  expect(restarts.filter?.measure?.kind).toBe("number");
  expect(
    restarts.filter?.measure?.amount({ ...object, spec: { restarts: 3 } }, 0),
  ).toBe(3);

  const status = statusColumn(() => ({ label: "Running", tone: "ok" }));
  expect(status.filter?.text(object, 0)).toBe("Running");
});

test("Name, Namespace and Age give a filter the name, the namespace and the age", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const [name, namespace, age] = baseColumns(POD);
  const pod = {
    metadata: {
      name: "web",
      namespace: "shop",
      creationTimestamp: "2026-11-22T10:30:00Z",
    },
  };
  expect(name.filter?.text(pod, now)).toBe("web");
  expect(namespace.filter?.text(pod, now)).toBe("shop");
  expect(namespace.filter?.text(object, now)).toBeNull();
  expect(age.filter?.text(pod, now)).toBe("1h30m");
  expect(age.filter?.measure?.kind).toBe("duration");
  expect(age.filter?.measure?.amount(pod, now)).toBe(5400);
  expect(age.filter?.text(object, now)).toBeNull();
  expect(age.filter?.measure?.amount(object, now)).toBeNull();
});
