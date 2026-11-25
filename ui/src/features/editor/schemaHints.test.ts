import { expect, test } from "vitest";
import type { SchemaField } from "../../ipc/generated/SchemaField";
import {
  apiVersionItems,
  fieldItems,
  hoverText,
  kindItems,
  topLevelItems,
  valueItems,
} from "./schemaHints";

function field(
  name: string,
  typeLabel: string,
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
    children: [],
    ...extra,
  };
}

test("hover shows name, type, required, default, values and the escaped description", () => {
  const text = hoverText(
    field("type", "string", {
      required: true,
      defaultValue: "ClusterIP",
      enumValues: ["ClusterIP", "NodePort"],
      description: "Type of *service* <b>x</b> [link](http://a)",
    }),
  );
  expect(text).toBe(
    "**type** `string` · required\n\nDefault: `ClusterIP`\n\nOne of: `ClusterIP`, `NodePort`\n\nType of \\*service\\* \\<b\\>x\\</b\\> \\[link\\]\\(http://a\\)",
  );
  expect(hoverText(field("replicas", "integer"))).toBe(
    "**replicas** `integer`",
  );
});

test("key items: missing fields only, required first, then A to Z, with insert text by type", () => {
  const items = fieldItems(
    [
      field("selector", "LabelSelector", {
        required: true,
        children: [field("matchLabels", "map[string]string")],
      }),
      field("template", "PodTemplateSpec", {
        required: true,
        children: [field("spec", "PodSpec")],
      }),
      field("replicas", "integer"),
      field("paused", "boolean"),
      field("ports", "[]ServicePort"),
      field("labels", "map[string]string"),
      field("port", "int-or-string"),
    ],
    ["template"],
    [{ key: "spec" }],
  );
  expect(items.map((i) => i.label)).toEqual([
    "selector",
    "labels",
    "paused",
    "port",
    "ports",
    "replicas",
  ]);
  expect(items.map((i) => i.insertText)).toEqual([
    "selector:\n  $0",
    "labels:\n  $0",
    "paused: $0",
    "port: $0",
    "ports:\n  - $0",
    "replicas: $0",
  ]);
  expect(items.every((i) => i.snippet)).toBe(true);
  expect(items[0]).toMatchObject({ detail: "LabelSelector · required" });
});

test("no status at the top, and no server-set metadata", () => {
  expect(
    fieldItems([field("spec", "X"), field("status", "Y")], [], []).map(
      (i) => i.label,
    ),
  ).toEqual(["spec"]);
  expect(
    fieldItems([field("status", "Y")], [], [{ key: "spec" }]).map(
      (i) => i.label,
    ),
  ).toEqual(["status"]);
  const meta = [
    field("name", "string"),
    field("uid", "string"),
    field("resourceVersion", "string"),
    field("managedFields", "[]X"),
  ];
  expect(
    fieldItems(meta, [], [{ key: "metadata" }]).map((i) => i.label),
  ).toEqual(["name"]);
});

test("value items: enum values, then booleans", () => {
  expect(
    valueItems(
      field("type", "string", { enumValues: ["ClusterIP", "NodePort"] }),
    ).map((i) => i.insertText),
  ).toEqual(["ClusterIP", "NodePort"]);
  expect(
    valueItems(field("paused", "boolean")).map((i) => i.insertText),
  ).toEqual(["true", "false"]);
  expect(valueItems(field("name", "string"))).toEqual([]);
});

test("with no kind: the top-level keys, then kinds and versions the cluster serves", () => {
  expect(topLevelItems(["apiVersion"]).map((i) => i.label)).toEqual([
    "kind",
    "metadata",
    "spec",
    "data",
    "stringData",
  ]);
  const served = [
    { apiVersion: "v1", kind: "Pod" },
    { apiVersion: "apps/v1", kind: "Deployment" },
    { apiVersion: "apps/v1", kind: "StatefulSet" },
  ];
  expect(kindItems(served).map((i) => i.label)).toEqual([
    "Deployment",
    "Pod",
    "StatefulSet",
  ]);
  expect(apiVersionItems(served, "Deployment").map((i) => i.label)).toEqual([
    "apps/v1",
  ]);
  expect(apiVersionItems(served, null).map((i) => i.label)).toEqual([
    "apps/v1",
    "v1",
  ]);
});
