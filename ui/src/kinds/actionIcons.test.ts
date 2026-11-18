import { expect, test } from "vitest";
import * as iconModule from "../design/icons";
import { type IconComponent, Pen, Trash2 } from "../design/icons";
import {
  forceFinalizeAction,
  objectActions,
} from "../features/resources/objectActions";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import "./index";
import { CONFIGMAPS } from "./refs";
import { type ActionContext, registeredKinds } from "./registry";

const INFO: ApiResourceInfo = {
  resource: CONFIGMAPS,
  verbs: [],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
};

const CONTEXT: ActionContext = {
  clusterId: "c",
  resource: CONFIGMAPS,
  navigate: () => {},
  confirm: async () => true,
  openEditor: () => {},
  dialog: () => {},
};

/** Edit YAML, Delete and Force finalize, which every kind offers. */
function sharedActions() {
  return [
    ...objectActions({
      object: { metadata: { name: "cfg", namespace: "n" } },
      kindActions: [],
      info: INFO,
      context: CONTEXT,
      onDelete: () => {},
    }),
    forceFinalizeAction,
  ];
}

test("each action shows one icon of the icon module wherever it is offered", () => {
  const exported = new Set<unknown>(Object.values(iconModule));
  const byId = new Map<string, Set<IconComponent>>();
  const offered = [
    ...registeredKinds().flatMap(({ spec }) => spec.actions ?? []),
    ...sharedActions(),
  ];
  expect(offered.length).toBeGreaterThan(20);
  for (const { id, icon } of offered) {
    expect(exported.has(icon), id).toBe(true);
    byId.set(id, (byId.get(id) ?? new Set()).add(icon));
  }
  for (const [id, icons] of byId) expect(icons.size, id).toBe(1);
});

test("Edit YAML is the pen and Delete is the trash can", () => {
  const items = sharedActions();
  expect(items.find((it) => it.id === "edit")?.icon).toBe(Pen);
  expect(Pen.iconName).toBe("pen");
  expect(items.find((it) => it.id === "delete")?.icon).toBe(Trash2);
  expect(Trash2.iconName).toBe("trash-2");
});
