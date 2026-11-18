import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockBackend } from "../../test/ipc";
import { SECRETS } from "../refs";
import { SecretDetail } from "./SecretDetail";

const secret = (name = "s", version = "5") => ({
  metadata: { name, namespace: "n", resourceVersion: version },
  type: "Opaque",
  data: { a: "", b: "" },
});

function show(object = secret(), handlers = {}) {
  const backend = mockBackend({
    secret_reveal: ({ key }: { key: string }) => ({
      value: `value-of-${key}`,
      binary: false,
    }),
    secret_update: () => null,
    ...handlers,
  });
  const view = render(
    <SecretDetail
      clusterId="c"
      object={object}
      resource={SECRETS}
      resources={[]}
    />,
  );
  return { backend, view };
}

const input = (key = "a") =>
  screen.getByTestId(`secret-input-${key}`) as HTMLTextAreaElement;
const type = (value: string, key = "a") =>
  fireEvent.change(input(key), { target: { value } });
const saveDisabled = () =>
  (screen.getByTestId("data-save") as HTMLButtonElement).disabled;
const option = (testId: string) =>
  screen.getByTestId(testId).querySelector("input") as HTMLInputElement;

test("no value is asked for until a key is revealed, and only that key", async () => {
  const { backend } = show();
  expect(backend.callsTo("secret_reveal")).toHaveLength(0);
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  expect(backend.callsTo("secret_reveal")).toHaveLength(1);
  expect(screen.getByTestId("secret-value-b").textContent).toBe("••••••");
});

test("hiding drops the value", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  expect(screen.queryByDisplayValue("value-of-a")).toBeNull();
});

test("a revealed value does not follow the drawer to another Secret", async () => {
  const { view } = show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("other")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  expect(screen.queryByDisplayValue("value-of-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("saving sends plain text for the changed key only and hides values again", async () => {
  const { backend } = show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  type("new");
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0]).toMatchObject({
    resourceVersion: "5",
    changes: [{ key: "a", value: { text: "new" } }],
  });
  await waitFor(() =>
    expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••"),
  );
});

test("a revealed value is a field at once, changed only while its text differs", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  expect(input().getAttribute("aria-label")).toBe("Value of a");
  expect(screen.queryByTestId("secret-edit-a")).toBeNull();
  expect(saveDisabled()).toBe(true);
  type("other");
  expect(saveDisabled()).toBe(false);
  type("value-of-a");
  expect(saveDisabled()).toBe(true);
});

test("the masked value is a button that reveals the key", async () => {
  const { backend } = show();
  const masked = screen.getByTestId("secret-value-a");
  expect(masked.tagName).toBe("BUTTON");
  expect(masked.getAttribute("type")).toBe("button");
  expect(masked.getAttribute("aria-label")).toBe("Reveal a");
  expect(masked.textContent).toBe("••••••");
  fireEvent.click(masked);
  await screen.findByDisplayValue("value-of-a");
  expect(backend.callsTo("secret_reveal")).toEqual([
    expect.objectContaining({ key: "a" }),
  ]);
  expect(screen.getByTestId("secret-reveal-a").getAttribute("aria-label")).toBe(
    "Hide a",
  );
});

test("a revealed key switches between raw and base64 without being changed", async () => {
  show();
  expect(screen.queryByTestId("secret-form-a")).toBeNull();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  const group = screen.getByRole("radiogroup", { name: "Encoding of a" });
  expect(group.getAttribute("data-testid")).toBe("secret-form-a");
  expect(option("secret-form-a-raw").checked).toBe(true);
  fireEvent.click(screen.getByTestId("secret-form-a-base64"));
  expect(input().value).toBe(btoa("value-of-a"));
  expect(saveDisabled()).toBe(true);
  fireEvent.click(screen.getByTestId("secret-form-a-raw"));
  expect(input().value).toBe("value-of-a");
  expect(saveDisabled()).toBe(true);
});

test("switching converts the text being typed", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  type("héllo");
  fireEvent.click(screen.getByTestId("secret-form-a-base64"));
  expect(input().value).toBe("aMOpbGxv");
  type("aMOp\nbGxvIQ==");
  fireEvent.click(screen.getByTestId("secret-form-a-raw"));
  expect(input().value).toBe("héllo!");
});

test("an edit in base64 is sent as base64", async () => {
  const { backend } = show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  fireEvent.click(screen.getByTestId("secret-form-a-base64"));
  type("/w==");
  expect(option("secret-form-a-raw").disabled).toBe(true);
  expect(screen.getByTestId("secret-form-a-raw").getAttribute("title")).toBe(
    "Binary value: edit it as base64.",
  );
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0].changes).toEqual([
    { key: "a", value: { base64: "/w==" } },
  ]);
});

test("a binary value opens in base64, with raw disabled, and can be edited", async () => {
  const { backend } = show(secret(), {
    secret_reveal: () => ({ value: "/w==", binary: true }),
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("/w==");
  expect(option("secret-form-a-base64").checked).toBe(true);
  expect(option("secret-form-a-raw").disabled).toBe(true);
  expect(screen.getByTestId("secret-form-a-raw").getAttribute("title")).toBe(
    "Binary value: edit it as base64.",
  );
  expect(screen.queryByText(/cannot be edited/)).toBeNull();
  expect(saveDisabled()).toBe(true);
  type("/+4=");
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0].changes).toEqual([
    { key: "a", value: { base64: "/+4=" } },
  ]);
});

test("text that is not base64 is flagged, cannot be saved and cannot turn raw", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  fireEvent.click(screen.getByTestId("secret-form-a-base64"));
  type("abc!");
  expect(screen.getByText("Not valid base64.")).toBeTruthy();
  expect(input().getAttribute("aria-invalid")).toBe("true");
  expect(saveDisabled()).toBe(true);
  expect(option("secret-form-a-raw").disabled).toBe(true);
  expect(screen.getByTestId("secret-form-a-raw").getAttribute("title")).toBe(
    "Not valid base64.",
  );
  type("YWJj\n");
  expect(screen.queryByText("Not valid base64.")).toBeNull();
  expect(saveDisabled()).toBe(false);
  expect(option("secret-form-a-raw").disabled).toBe(false);
});

test("a new key can be added as base64, once its value is base64", async () => {
  const { backend } = show();
  expect(option("data-new-form-raw").checked).toBe(true);
  expect(
    screen.getByRole("radiogroup", { name: "Encoding of new value" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "c" },
  });
  fireEvent.click(screen.getByTestId("data-new-form-base64"));
  fireEvent.change(screen.getByTestId("data-new-value"), {
    target: { value: "abc!" },
  });
  expect(screen.getByText("Not valid base64.")).toBeTruthy();
  expect((screen.getByTestId("data-add") as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByTestId("data-new-value"), {
    target: { value: "/w==" },
  });
  fireEvent.click(screen.getByTestId("data-add"));
  expect(input("c").value).toBe("/w==");
  expect(option("secret-form-c-base64").checked).toBe(true);
  expect(option("data-new-form-raw").checked).toBe(true);
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0].changes).toEqual([
    { key: "c", value: { base64: "/w==" } },
  ]);
});

test("switching the new value converts its text", () => {
  show();
  const newValue = () =>
    screen.getByTestId("data-new-value") as HTMLTextAreaElement;
  fireEvent.change(newValue(), { target: { value: "a" } });
  fireEvent.click(screen.getByTestId("data-new-form-base64"));
  expect(newValue().value).toBe("YQ==");
  fireEvent.click(screen.getByTestId("data-new-form-raw"));
  expect(newValue().value).toBe("a");
});

test("a key can be added and removed without revealing the others", async () => {
  const { backend } = show();
  fireEvent.click(screen.getByTestId("data-remove-b"));
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "c" },
  });
  fireEvent.change(screen.getByTestId("data-new-value"), {
    target: { value: "x" },
  });
  fireEvent.click(screen.getByTestId("data-add"));
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0].changes).toEqual([
    { key: "b", value: null },
    { key: "c", value: { text: "x" } },
  ]);
  expect(backend.callsTo("secret_reveal")).toHaveLength(0);
});

test("a reveal failure shows the API's message", async () => {
  show(secret(), {
    secret_reveal: () => {
      throw { code: "Forbidden", message: "secrets is forbidden" };
    },
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "secrets is forbidden",
    ),
  );
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("a change on the server masks what was revealed, unless it is being edited", async () => {
  const { view } = show(secret("s", "5"));
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("s", "6")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  expect(screen.queryByDisplayValue("value-of-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("a conflict keeps the typed text and offers a reload", async () => {
  show(secret(), {
    secret_update: () => {
      throw {
        code: "Conflict",
        message: "the object has been modified",
        details: null,
      };
    },
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  type("typed");
  fireEvent.click(screen.getByTestId("data-save"));
  await screen.findByTestId("data-conflict");
  expect(input().value).toBe("typed");
});

test("text being edited survives a change on the server, and reload masks it", async () => {
  const { view } = show(secret("s", "5"));
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  type("typed");
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("s", "6")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  expect(input().value).toBe("typed");
  fireEvent.click(screen.getByTestId("data-reload"));
  expect(screen.queryByTestId("secret-input-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("hiding a key being edited drops the typed text too", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  type("typed");
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  expect(screen.queryByTestId("secret-input-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
  expect(saveDisabled()).toBe(true);
});

test("an answer that arrives after the key was hidden is dropped", async () => {
  let answer: (value: unknown) => void = () => {};
  const { backend } = show(secret(), {
    secret_reveal: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await waitFor(() => expect(backend.callsTo("secret_reveal")).toHaveLength(1));
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  answer({ value: "late", binary: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("late")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("an answer that arrives after a change on the server is dropped", async () => {
  let answer: (value: unknown) => void = () => {};
  const { backend, view } = show(secret("s", "5"), {
    secret_reveal: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await waitFor(() => expect(backend.callsTo("secret_reveal")).toHaveLength(1));
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("s", "6")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  answer({ value: "late", binary: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("late")).toBeNull();
});

test("removing a key can be undone, and does not reveal it", async () => {
  const { backend } = show();
  fireEvent.click(screen.getByTestId("data-remove-b"));
  expect(screen.queryByTestId("secret-value-b")).toBeNull();
  expect(saveDisabled()).toBe(false);
  fireEvent.click(screen.getByTestId("data-remove-b"));
  expect(screen.getByTestId("secret-value-b").textContent).toBe("••••••");
  expect(saveDisabled()).toBe(true);
  expect(backend.callsTo("secret_reveal")).toHaveLength(0);
});

test("a removed key cannot be added back as new", () => {
  show();
  fireEvent.click(screen.getByTestId("data-remove-b"));
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "b" },
  });
  expect((screen.getByTestId("data-add") as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("reveal and hide are an eye icon button named for the key", async () => {
  show();
  const button = screen.getByTestId("secret-reveal-a");
  expect(button.getAttribute("aria-label")).toBe("Reveal a");
  expect(button.textContent).toBe("");
  expect(button.querySelector('[data-icon="eye"] svg')).not.toBeNull();
  fireEvent.click(button);
  await screen.findByDisplayValue("value-of-a");
  const hide = screen.getByTestId("secret-reveal-a");
  expect(hide.getAttribute("aria-label")).toBe("Hide a");
  expect(hide.querySelector('[data-icon="eye-off"] svg')).not.toBeNull();
});

test("base64 that differs only in whitespace is not a change", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("value-of-a");
  fireEvent.click(screen.getByTestId("secret-form-a-base64"));
  type(`${btoa("value-of-a")}\n`);
  expect(saveDisabled()).toBe(true);
});

test("a binary value turned into text is a change, even text that reads like its base64", async () => {
  const { backend } = show(secret(), {
    secret_reveal: () => ({ value: "/w==", binary: true }),
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByDisplayValue("/w==");
  type("YWJj");
  fireEvent.click(screen.getByTestId("secret-form-a-raw"));
  expect(input().value).toBe("abc");
  type("/w==");
  expect(saveDisabled()).toBe(false);
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0].changes).toEqual([
    { key: "a", value: { text: "/w==" } },
  ]);
});
