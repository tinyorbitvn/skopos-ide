import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { TunnelKind } from "../../ipc/generated/TunnelKind";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetTunnelsForTest, useTunnels } from "../../stores/tunnels";
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
  let answer = tunnel({ state: { status: "up", since: 0 } });
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
    tunnel_list: () => [tunnel({ state: { status: "up", since: 0 } })],
    tunnel_stop: () => tunnel(),
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-stop-t1"));
  await act(flush);
  expect(backend.callsTo("tunnel_stop")).toEqual([{ id: "t1" }]);
});

test("an SSH row shows its target, and Reconnecting shows the last error", async () => {
  await show({
    tunnel_list: () => [
      tunnel({
        kind: {
          type: "ssh",
          host: "bastion",
          user: "me",
          port: null,
          jump: null,
          identityFile: null,
        },
        state: {
          status: "reconnecting",
          attempt: 2,
          lastError: "Connection closed by 10.0.0.1 port 22",
        },
      }),
    ],
  });
  const row = screen.getByTestId("prefs-tunnel-t1");
  expect(row.textContent).toContain("SSH · me@bastion");
  const badge = within(row).getByText("Reconnecting");
  expect(badge.closest("[title]")?.getAttribute("title")).toBe(
    "Connection closed by 10.0.0.1 port 22",
  );
});

const SSH_KIND: Extract<TunnelKind, { type: "ssh" }> = {
  type: "ssh",
  host: "bastion",
  user: "me",
  port: null,
  jump: null,
  identityFile: null,
};
const SSH = tunnel({ kind: SSH_KIND });
const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: [],
  namespacesRestricted: false,
  isAdmin: true,
};

test("Add tunnel with kind SSH checks the fields, then saves them", async () => {
  const backend = await show({
    tunnel_list: () => [],
    tunnel_save: () => tunnel({ ...SSH, id: "t2" }),
    "plugin:dialog|open": () => "/home/me/.ssh/id_ed25519",
  });
  fireEvent.click(screen.getByTestId("prefs-tunnels-add"));
  fireEvent.click(screen.getByTestId("tunnel-kind-ssh"));
  expect(screen.queryByTestId("tunnel-url")).toBeNull();
  expect(screen.getByTestId("tunnel-ssh-note").textContent).toBe(
    "While it runs, other programs on this computer can reach the same network through its local port",
  );
  type("tunnel-name", "bastion");
  type("tunnel-host", "-oProxyCommand=evil");
  type("tunnel-port", "70000");
  fireEvent.click(screen.getByTestId("tunnel-save"));
  expect(
    screen.getByText(
      'The host cannot start with "-" or hold spaces or control characters.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("The port is a number from 1 to 65535."),
  ).toBeTruthy();
  expect(backend.callsTo("tunnel_save")).toEqual([]);

  type("tunnel-host", " bastion.corp ");
  type("tunnel-port", "2222");
  type("tunnel-jump", "jump.corp");
  expect(screen.getByTestId("tunnel-identity").textContent).toBe(
    "No file picked",
  );
  fireEvent.click(screen.getByTestId("tunnel-identity-choose"));
  await act(flush);
  expect(screen.getByTestId("tunnel-identity").textContent).toBe(
    "/home/me/.ssh/id_ed25519",
  );
  fireEvent.click(screen.getByTestId("tunnel-save"));
  await act(flush);
  expect(backend.callsTo("tunnel_save")).toEqual([
    {
      tunnel: {
        id: null,
        name: "bastion",
        kind: {
          type: "ssh",
          host: "bastion.corp",
          user: null,
          port: 2222,
          jump: "jump.corp",
          identityFile: "/home/me/.ssh/id_ed25519",
        },
      },
    },
  ]);
  expect(backend.callsTo("tunnel_set_password")).toEqual([]);
  expect(screen.queryByTestId("tunnel-dialog")).toBeNull();
});

test("Edit of an SSH tunnel shows its fields, no kind choice, and Clear drops the identity file", async () => {
  await show({
    tunnel_list: () => [
      tunnel({ kind: { ...SSH_KIND, identityFile: "/home/me/.ssh/id" } }),
    ],
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-edit-t1"));
  expect(screen.queryByTestId("tunnel-kind")).toBeNull();
  expect(input("tunnel-host").value).toBe("bastion");
  expect(input("tunnel-user").value).toBe("me");
  expect(screen.getByTestId("tunnel-identity").textContent).toBe(
    "/home/me/.ssh/id",
  );
  fireEvent.click(screen.getByTestId("tunnel-identity-clear"));
  expect(screen.getByTestId("tunnel-identity").textContent).toBe(
    "No file picked",
  );
});

test("Start brings an SSH tunnel up and toasts the outcome", async () => {
  const success = vi.spyOn(toast, "success");
  const failed = vi.spyOn(toast, "error");
  let answer = tunnel({ ...SSH, state: { status: "up", since: 0 } });
  const backend = await show({
    tunnel_list: () => [SSH],
    tunnel_start: () => answer,
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-start-t1"));
  await act(flush);
  expect(success).toHaveBeenCalledWith('Tunnel "corp" is up');
  answer = tunnel({
    ...SSH,
    state: { status: "failed", message: "Host key verification failed." },
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-start-t1"));
  await act(flush);
  expect(failed).toHaveBeenCalledWith(
    'Tunnel "corp" failed',
    "Host key verification failed.",
  );
  expect(backend.callsTo("tunnel_start")).toEqual([{ id: "t1" }, { id: "t1" }]);
});

test("a proxy tunnel has no Start and no Log", async () => {
  await show();
  expect(screen.queryByTestId("prefs-tunnel-start-t1")).toBeNull();
  expect(screen.queryByTestId("prefs-tunnel-log-t1")).toBeNull();
});

test("Stop confirms and names the connected clusters, which disconnect", async () => {
  useCatalog.setState({
    loading: false,
    error: null,
    clusters: [
      clusterEntry({
        name: "prod",
        tunnel: "t1",
        state: { status: "connected", info: INFO },
      }),
      clusterEntry({ name: "dev", tunnel: "t1" }),
    ],
  });
  const backend = await show({
    tunnel_list: () => [
      tunnel({
        ...SSH,
        state: { status: "reconnecting", attempt: 1, lastError: "reset" },
      }),
    ],
    tunnel_stop: () => SSH,
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-stop-t1"));
  const dialog = screen.getByTestId("tunnel-stop-dialog");
  expect(dialog.textContent).toContain("Stop tunnel corp?");
  expect(dialog.textContent).toContain("prod disconnects.");
  expect(dialog.textContent).not.toContain("dev");
  expect(backend.callsTo("tunnel_stop")).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
  await act(flush);
  expect(backend.callsTo("tunnel_stop")).toEqual([{ id: "t1" }]);
});

test("the Log shows what ssh wrote, or says it wrote nothing", async () => {
  await show({
    tunnel_list: () => [
      tunnel({
        ...SSH,
        log: ["Connecting to bastion", "Permission denied (publickey)."],
      }),
      tunnel({ ...SSH, id: "t2", name: "edge", log: [] }),
    ],
  });
  expect(screen.getByTestId("prefs-tunnel-log-t1").textContent).toContain(
    "Connecting to bastion\nPermission denied (publickey).",
  );
  expect(screen.getByTestId("prefs-tunnel-log-t2").textContent).toContain(
    "No output from ssh yet",
  );
});

test("Answer… opens the tunnel's prompt", async () => {
  await show({
    tunnel_list: () => [
      tunnel({
        ...SSH,
        state: { status: "needsInput", promptId: "p1" },
        prompt: {
          id: "p1",
          tunnel: "t1",
          kind: "password",
          text: "me@bastion's password: ",
          canRemember: true,
          opensAtOnce: false,
        },
      }),
    ],
  });
  fireEvent.click(screen.getByTestId("prefs-tunnel-answer-t1"));
  expect(useTunnels.getState().asking).toBe("p1");
});
