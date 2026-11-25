import { beforeEach, expect, test, vi } from "vitest";
import type { KindSchema } from "../../ipc/generated/KindSchema";
import type { SchemaField } from "../../ipc/generated/SchemaField";
import { completionsAt, hoverAt } from "./hintProviders";

const load = vi.hoisted(() => vi.fn());
vi.mock("./apiDocsCache", () => ({ loadKindSchema: load }));

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

const DEPLOYMENT: KindSchema = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  description: "",
  truncated: false,
  fields: [
    field("apiVersion", "string"),
    field("kind", "string"),
    field("metadata", "ObjectMeta", { children: [field("name", "string")] }),
    field("spec", "DeploymentSpec", {
      children: [
        field("replicas", "integer", {
          description: "Number of desired pods.",
        }),
        field("paused", "boolean"),
      ],
    }),
    field("status", "DeploymentStatus"),
  ],
};

const SOURCE = {
  clusterId: "c1",
  fixedTarget: null,
  served: [
    { apiVersion: "apps/v1", kind: "Deployment" },
    { apiVersion: "v1", kind: "Pod" },
  ],
};

beforeEach(() => {
  load.mockReset();
  load.mockResolvedValue(DEPLOYMENT);
});

const TEXT =
  "apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: 2\n  \n";

test("hover on a key shows its docs over the key's range", async () => {
  const offset = TEXT.indexOf("replicas") + 2;
  const hover = await hoverAt(SOURCE, TEXT, offset);
  expect(load).toHaveBeenCalledWith("c1", {
    apiVersion: "apps/v1",
    kind: "Deployment",
  });
  expect(hover).toEqual({
    markdown: "**replicas** `integer`\n\nNumber of desired pods.",
    start: TEXT.indexOf("replicas"),
    end: TEXT.indexOf("replicas") + 8,
  });
});

test("completion at a new key lists the missing fields", async () => {
  const offset = TEXT.indexOf("  \n") + 2;
  const result = await completionsAt(SOURCE, TEXT, offset);
  expect(result?.items.map((i) => i.label)).toEqual(["paused"]);
  expect(result?.start).toBe(offset);
});

test("completion at a value lists booleans", async () => {
  const text = "apiVersion: apps/v1\nkind: Deployment\nspec:\n  paused: t";
  const result = await completionsAt(SOURCE, text, text.length);
  expect(result?.items.map((i) => i.label)).toEqual(["true", "false"]);
  expect(result?.start).toBe(text.length - 1);
});

test("with no kind: top-level keys, kinds and versions, with no schema asked", async () => {
  expect(
    (await completionsAt(SOURCE, "apiVersion: v1\n", 15))?.items.map(
      (i) => i.label,
    ),
  ).toEqual(["kind", "metadata", "spec", "data", "stringData"]);
  expect(
    (await completionsAt(SOURCE, "kind: ", 6))?.items.map((i) => i.label),
  ).toEqual(["Deployment", "Pod"]);
  expect(
    (await completionsAt(SOURCE, "kind: Pod\napiVersion: ", 22))?.items.map(
      (i) => i.label,
    ),
  ).toEqual(["v1"]);
  expect(load).not.toHaveBeenCalled();
});

test("an edit tab uses its own kind, whatever the text says", async () => {
  await hoverAt(
    { ...SOURCE, fixedTarget: { apiVersion: "apps/v1", kind: "Deployment" } },
    "spec:\n  replicas: 1\n",
    9,
  );
  expect(load).toHaveBeenCalledWith("c1", {
    apiVersion: "apps/v1",
    kind: "Deployment",
  });
});

test("no schema, no field and comments give nothing", async () => {
  load.mockRejectedValue(new Error("forbidden"));
  expect(await hoverAt(SOURCE, TEXT, TEXT.indexOf("replicas") + 2)).toBeNull();
  load.mockResolvedValue(DEPLOYMENT);
  const unknown = "apiVersion: apps/v1\nkind: Deployment\nspec:\n  nope: 1\n";
  expect(
    await hoverAt(SOURCE, unknown, unknown.indexOf("nope") + 1),
  ).toBeNull();
  expect(await completionsAt(SOURCE, "# spec\n", 3)).toBeNull();
});
