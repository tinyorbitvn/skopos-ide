import { expect, test } from "vitest";
import type { SchemaField } from "../../ipc/generated/SchemaField";
import { childrenAt, fieldAt } from "./schemaLookup";

function field(
  name: string,
  typeLabel: string,
  children: SchemaField[] = [],
  extra: Partial<SchemaField> = {},
): SchemaField {
  return {
    name,
    typeLabel,
    required: false,
    description: "",
    owner: "",
    format: null,
    enumValues: [],
    defaultValue: null,
    recursive: false,
    children,
    ...extra,
  };
}

const CONTAINER = [
  field("name", "string", [], { required: true }),
  field("image", "string"),
];
const FIELDS = [
  field("metadata", "ObjectMeta", [
    field("name", "string"),
    field("labels", "map[string]string"),
  ]),
  field("spec", "PodSpec", [field("containers", "[]Container", CONTAINER)]),
  field("data", "map[string]Value", [field("inner", "string")]),
  field("matrix", "[][]Container", CONTAINER),
];

test("walks maps, list items and maps of objects", () => {
  expect(childrenAt(FIELDS, [{ key: "spec" }])?.map((f) => f.name)).toEqual([
    "containers",
  ]);
  expect(
    childrenAt(FIELDS, [
      { key: "spec" },
      { key: "containers" },
      { item: true },
    ]),
  ).toBe(CONTAINER);
  expect(
    childrenAt(FIELDS, [{ key: "data" }, { key: "anything" }])?.map(
      (f) => f.name,
    ),
  ).toEqual(["inner"]);
  expect(
    childrenAt(FIELDS, [{ key: "matrix" }, { item: true }, { item: true }]),
  ).toBe(CONTAINER);
});

test("a list or map that still expects its item or key has no fields", () => {
  expect(
    childrenAt(FIELDS, [{ key: "spec" }, { key: "containers" }]),
  ).toBeNull();
  expect(
    childrenAt(FIELDS, [{ key: "metadata" }, { key: "labels" }]),
  ).toBeNull();
  expect(childrenAt(FIELDS, [{ key: "nope" }])).toBeNull();
  expect(childrenAt(FIELDS, [{ item: true }])).toBeNull();
});

test("a map's own keys are no field", () => {
  expect(fieldAt(FIELDS, [{ key: "metadata" }], "labels")?.typeLabel).toBe(
    "map[string]string",
  );
  expect(
    fieldAt(FIELDS, [{ key: "metadata" }, { key: "labels" }], "app"),
  ).toBeNull();
  expect(
    fieldAt(
      FIELDS,
      [{ key: "spec" }, { key: "containers" }, { item: true }],
      "image",
    )?.name,
  ).toBe("image");
});
