import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { isValidElement } from "react";
import { expect, test, vi } from "vitest";
import { Maximize2 } from "../../design/icons";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { STORAGE_CLASSES } from "../refs";
import { type ActionContext, kindSpec } from "../registry";
import "./index";
import { ResizeDialog } from "./ResizeDialog";

function claim(over: {
  phase?: string;
  capacity?: string;
  request?: string;
  className?: string | null;
}): KubeObject {
  return {
    metadata: { name: "data", namespace: "n" },
    spec: {
      resources: { requests: { storage: over.request ?? "10Gi" } },
      ...(over.className === null
        ? {}
        : { storageClassName: over.className ?? "fast" }),
    },
    status: {
      phase: over.phase ?? "Bound",
      capacity: { storage: over.capacity ?? "10Gi" },
    },
  };
}

async function open(
  object: KubeObject,
  storageClass: Record<string, unknown> | (() => never) = {
    allowVolumeExpansion: true,
  },
  handlers = {},
) {
  const backend = mockBackend({
    resource_get: () =>
      typeof storageClass === "function"
        ? storageClass()
        : { metadata: { name: "fast" }, ...storageClass },
    pvc_resize: () => null,
    ...handlers,
  });
  const close = vi.fn();
  render(<ResizeDialog clusterId="c" object={object} close={close} />);
  await act(flush);
  return { backend, close };
}

const input = () => screen.getByTestId("resize-size") as HTMLInputElement;
const confirm = () => screen.getByTestId("resize-confirm") as HTMLButtonElement;
const type = (value: string) =>
  fireEvent.change(input(), { target: { value } });

test("shows the capacity, the request and the class, and sends the new size", async () => {
  const { backend, close } = await open(claim({ request: "12Gi" }));
  expect(backend.callsTo("resource_get")[0]).toEqual({
    clusterId: "c",
    resource: STORAGE_CLASSES,
    namespace: null,
    name: "fast",
  });
  const facts = screen.getByTestId("resize-facts").textContent;
  expect(facts).toContain("Capacity10Gi");
  expect(facts).toContain("Requested12Gi");
  expect(facts).toContain("Storage classfast, allows expansion");
  expect(input().value).toBe("12Gi");
  type(" 20Gi ");
  fireEvent.click(confirm());
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(backend.callsTo("pvc_resize")).toEqual([
    { clusterId: "c", namespace: "n", name: "data", storage: "20Gi" },
  ]);
});

test.each([
  ["", "Enter a size such as 20Gi."],
  ["lots", "Enter a size such as 20Gi."],
  ["10Gi", "Enter a size larger than the current 10Gi."],
  ["10240Mi", "Enter a size larger than the current 10Gi."],
  ["5Gi", "Enter a size larger than the current 10Gi."],
])("refuses %j and sends nothing", async (value, message) => {
  const { backend } = await open(claim({}));
  type(value);
  expect(confirm().disabled).toBe(true);
  expect(screen.getByText(message)).toBeTruthy();
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(backend.callsTo("pvc_resize")).toHaveLength(0);
});

test("a size in other units that is larger is allowed", async () => {
  await open(claim({}));
  type("10241Mi");
  expect(confirm().disabled).toBe(false);
});

test.each([
  [
    "a claim that is not Bound",
    claim({ phase: "Pending" }),
    { allowVolumeExpansion: true },
    "This claim is Pending. Only a Bound claim can be resized.",
  ],
  [
    "a class that does not allow expansion",
    claim({}),
    {},
    "StorageClass fast does not allow volume expansion.",
  ],
  [
    "a claim with no class",
    claim({ className: null }),
    { allowVolumeExpansion: true },
    "This claim has no StorageClass, so it cannot be expanded.",
  ],
])("%s is not resized, and says why", async (_, object, sc, reason) => {
  const { backend } = await open(object, sc);
  expect(screen.getByTestId("resize-blocked").textContent).toBe(reason);
  type("20Gi");
  expect(confirm().disabled).toBe(true);
  expect(input().disabled).toBe(true);
  expect(backend.callsTo("pvc_resize")).toHaveLength(0);
});

test("a class that cannot be read leaves the decision to the API server", async () => {
  await open(claim({}), () => {
    throw { code: "Forbidden", message: "storageclasses is forbidden" };
  });
  expect(screen.getByTestId("resize-class-unknown").textContent).toContain(
    "storageclasses is forbidden",
  );
  type("20Gi");
  expect(confirm().disabled).toBe(false);
});

test("a refusal stays in the dialog with the API's message", async () => {
  const { close } = await open(claim({}), undefined, {
    pvc_resize: () => {
      throw {
        code: "Invalid",
        message: "field can not be less than previous value",
        details: null,
      };
    },
  });
  type("20Gi");
  fireEvent.click(confirm());
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "field can not be less than previous value",
    ),
  );
  expect(close).not.toHaveBeenCalled();
  expect(confirm().disabled).toBe(false);
});

test("a PersistentVolumeClaim has a Resize action that needs patch and opens the dialog", () => {
  const action = kindSpec("", "persistentvolumeclaims")?.actions?.find(
    (a) => a.id === "resize",
  );
  expect(action).toMatchObject({
    label: "Resize",
    icon: Maximize2,
    requires: "patch",
  });
  const dialog = vi.fn();
  action?.run(
    { clusterId: "c", dialog } as unknown as ActionContext,
    claim({}),
  );
  const shown = dialog.mock.calls[0][0](() => {});
  expect(isValidElement(shown) && shown.type).toBe(ResizeDialog);
  expect(kindSpec("", "persistentvolumes")?.actions ?? []).toHaveLength(0);
});
