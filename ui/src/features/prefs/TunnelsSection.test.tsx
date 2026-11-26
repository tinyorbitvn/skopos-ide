import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetTunnelsForTest } from "../../stores/tunnels";
import { clusterEntry, flush, mockBackend } from "../../test/ipc";
import { tunnel } from "../../test/tunnels";
import { TunnelsSection } from "./TunnelsSection";

beforeEach(() => {
  resetTunnelsForTest();
  resetCatalogForTest();
});
afterEach(() => vi.restoreAllMocks());

async function show(over: Parameters<typeof mockBackend>[0] = {}) {
  const backend = mockBackend({ tunnel_list: () => [tunnel()], ...over });
  render(
    <MemoryRouter initialEntries={["/preferences"]}>
      <TunnelsSection />
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
function type(id: string, value: string) {
  fireEvent.change(input(id), { target: { value } });
}

test("an empty list says what tunnels are for", async () => {
  await show({ tunnel_list: () => [] });
  expect(screen.getByTestId("prefs-tunnels-empty").textContent).toContain(
    "No tunnels. Add one to reach clusters behind a proxy or a bastion host",
  );
});

test("a failed read shows its message and Retry reads again", async () => {
  let fail = true;
  const backend = await show({
    tunnel_list: () => {
      if (fail) throw new Error("store unreadable");
      return [];
    },
  });
  expect(screen.getByText("Could not read the tunnels")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(screen.getByTestId("prefs-tunnels-empty")).toBeTruthy();
  expect(backend.callsTo("tunnel_list")).toHaveLength(2);
});

test("a row shows the target, the state with its reason and the clusters using it", async () => {
  await show({
    tunnel_list: () => [
      tunnel({
        clusterCount: 2,
        state: {
          status: "failed",
          message: "the proxy answered 403 Forbidden",
        },
      }),
    ],
  });
  const row = screen.getByTestId("prefs-tunnel-t1");
  expect(row.textContent).toContain("corp");
  expect(row.textContent).toContain("Proxy · http://proxy.corp:3128");
  expect(row.textContent).toContain("Failed");
  expect(row.textContent).toContain("Used by 2 clusters");
  expect(
    within(row).getByTitle("the proxy answered 403 Forbidden"),
  ).toBeTruthy();
  expect(within(row).queryByTestId("prefs-tunnel-stop-t1")).toBeNull();
});

test("Add tunnel checks the URL, then saves the tunnel and its password", async () => {
  const backend = await show({
    tunnel_list: () => [],
    tunnel_save: () => tunnel({ id: "t2", name: "edge" }),
    tunnel_set_password: () =>
      tunnel({ id: "t2", name: "edge", hasPassword: true }),
  });
  fireEvent.click(screen.getByTestId("prefs-tunnels-add"));
  type("tunnel-name", "edge");
  type("tunnel-url", "http://me:pw@proxy.corp:3128");
  fireEvent.click(screen.getByTestId("tunnel-save"));
  expect(
    screen.getByText("Put the user name and password in their own fields"),
  ).toBeTruthy();
  type("tunnel-url", " socks5://proxy.corp:1080 ");
  type("tunnel-username", "me");
  type("tunnel-password", "pw");
  fireEvent.click(screen.getByTestId("tunnel-save"));
  await act(flush);
  expect(backend.callsTo("tunnel_save")).toEqual([
    {
      tunnel: {
        id: null,
        name: "edge",
        kind: {
          type: "proxy",
          url: "socks5://proxy.corp:1080",
          username: "me",
        },
      },
    },
  ]);
  expect(backend.callsTo("tunnel_set_password")).toEqual([
    { id: "t2", password: "pw" },
  ]);
  expect(screen.queryByTestId("tunnel-dialog")).toBeNull();
});

test("a refused name shows under Name and the dialog stays", async () => {
  await show({
    tunnel_save: () => {
      throw new Error('A tunnel named "corp" exists already.');
    },
  });
  fireEvent.click(screen.getByTestId("prefs-tunnels-add"));
  type("tunnel-name", "corp");
  type("tunnel-url", "http://p:1");
  fireEvent.click(screen.getByTestId("tunnel-save"));
  await act(flush);
  expect(
    screen.getByText('A tunnel named "corp" exists already.'),
  ).toBeTruthy();
  expect(screen.getByTestId("tunnel-dialog")).toBeTruthy();
});

test("a saved password shows where it is kept, and Clear forgets it", async () => {
  const saved = tunnel({
    hasPassword: true,
    kind: { type: "proxy", url: "http://proxy.corp:3128", username: "me" },
  });
  const backend = await show({
    tunnel_list: () => [saved],
    tunnel_clear_password: () => tunnel(),
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-edit-t1"));
  expect(screen.getByTestId("tunnel-password-saved").textContent).toContain(
    "Saved in the keychain",
  );
  fireEvent.click(screen.getByTestId("tunnel-password-clear"));
  await act(flush);
  expect(backend.callsTo("tunnel_clear_password")).toEqual([{ id: "t1" }]);
  expect(input("tunnel-password").value).toBe("");
});

test("a password kept in memory says so", async () => {
  const note =
    "Kept until SkoposIDE quits: the system keychain is not available (no Secret Service)";
  await show({
    tunnel_list: () => [tunnel({ hasPassword: true, passwordNote: note })],
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-edit-t1"));
  expect(screen.getByTestId("tunnel-password-saved").textContent).toContain(
    note,
  );
});

test("Delete names the clusters that use the tunnel", async () => {
  useCatalog.setState({
    loading: false,
    error: null,
    clusters: [
      clusterEntry({ name: "prod", tunnel: "t1" }),
      clusterEntry({ name: "dev" }),
    ],
  });
  const backend = await show({ tunnel_delete: () => null });
  fireEvent.click(screen.getByTestId("prefs-tunnel-delete-t1"));
  const dialog = screen.getByTestId("tunnel-delete-dialog");
  expect(dialog.textContent).toContain("Delete tunnel corp?");
  expect(dialog.textContent).toContain("prod uses it and goes back to None.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await act(flush);
  expect(backend.callsTo("tunnel_delete")).toEqual([{ id: "t1" }]);
});

test("Test connection toasts the outcome, and Stop shows while it is up", async () => {
  const success = vi.spyOn(toast, "success");
  const failed = vi.spyOn(toast, "error");
  let answer = tunnel({ state: { status: "up" } });
  const backend = await show({
    tunnel_test: () => answer,
    tunnel_stop: () => tunnel(),
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-test-t1"));
  await act(flush);
  expect(success).toHaveBeenCalledWith('Tunnel "corp" is up');
  answer = tunnel({
    state: { status: "failed", message: "no answer within 15 s" },
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-test-t1"));
  await act(flush);
  expect(failed).toHaveBeenCalledWith(
    'Tunnel "corp" failed',
    "no answer within 15 s",
  );
  expect(backend.callsTo("tunnel_test")).toHaveLength(2);
});

test("Stop ends an up tunnel", async () => {
  const backend = await show({
    tunnel_list: () => [tunnel({ state: { status: "up" } })],
    tunnel_stop: () => tunnel(),
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-stop-t1"));
  await act(flush);
  expect(backend.callsTo("tunnel_stop")).toEqual([{ id: "t1" }]);
});
