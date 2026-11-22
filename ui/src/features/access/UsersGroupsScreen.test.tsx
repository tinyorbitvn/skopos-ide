import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import { Toaster } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { SubjectRemoval } from "../../ipc/generated/SubjectRemoval";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { UsersGroupsScreen } from "./UsersGroupsScreen";

beforeEach(() => {
  resetResourcesForTest();
  mockElementSize();
});

const RBAC = "rbac.authorization.k8s.io";
const user = (name: string) => ({ kind: "User", apiGroup: RBAC, name });
const group = (name: string) => ({ kind: "Group", apiGroup: RBAC, name });

function binding(
  namespace: string | undefined,
  name: string,
  role: [string, string],
  subjects: object[],
): KubeObject {
  return {
    metadata: { name, namespace, resourceVersion: "1" },
    roleRef: { apiGroup: RBAC, kind: role[0], name: role[1] },
    subjects,
  };
}

const CLUSTER = [
  binding(undefined, "alice-view", ["ClusterRole", "view"], [user("alice")]),
  binding(
    undefined,
    "admins",
    ["ClusterRole", "cluster-admin"],
    [group("system:masters")],
  ),
];
const NAMESPACED = [
  binding(
    "payments",
    "payments-devs-edit",
    ["ClusterRole", "edit"],
    [group("payments-devs"), user("alice")],
  ),
];

function Location() {
  const location = useLocation();
  return (
    <span data-testid="location">{`${location.pathname}${location.search}`}</span>
  );
}

const info = (plural: string, kind: string, namespaced: boolean) =>
  ({
    resource: { group: RBAC, version: "v1", plural, kind, namespaced },
  }) as unknown as ApiResourceInfo;
const RESOURCES = [
  info("clusterrolebindings", "ClusterRoleBinding", false),
  info("rolebindings", "RoleBinding", true),
  info("clusterroles", "ClusterRole", false),
  info("roles", "Role", true),
];

type RemoveArgs = { clusterId: string; subject: unknown; bindings: unknown[] };

/** Answers each binding list's subscription; `denied` plurals are refused. */
async function show(
  options: {
    cluster?: KubeObject[];
    namespaced?: KubeObject[];
    denied?: string[];
    at?: string;
    remove?: (args: RemoveArgs) => SubjectRemoval[];
  } = {},
) {
  const subs = new Map<string, (event: WatchEvent) => void>();
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      if (options.denied?.includes(a.resource.plural)) {
        throw {
          code: "Forbidden",
          message: `${a.resource.plural} is forbidden`,
        };
      }
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    access_subject_remove: (a: RemoveArgs) => options.remove?.(a) ?? [],
  });
  render(
    <MemoryRouter initialEntries={[options.at ?? "/cluster/c1/users-groups"]}>
      <UsersGroupsScreen clusterId="c1" resources={RESOURCES} />
      <Location />
      <Toaster />
    </MemoryRouter>,
  );
  await act(flush);
  const lists: Record<string, KubeObject[]> = {
    clusterrolebindings: options.cluster ?? CLUSTER,
    rolebindings: options.namespaced ?? NAMESPACED,
  };
  for (const [plural, items] of Object.entries(lists)) {
    await act(async () => {
      subs.get(plural)?.({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  }
  return backend;
}

const row = (key: string) => screen.getByTestId(`ug-row-${key}`);
const rowKeys = () =>
  screen
    .queryAllByTestId(/^ug-row-/)
    .map((r) => r.getAttribute("data-testid")?.slice("ug-row-".length));

test("lists the users and groups that bindings name, without system names", async () => {
  await show();
  expect(screen.getByTestId("ug-title").textContent).toBe("Users & Groups");
  expect(screen.getByTestId("ug-lead").textContent).toBe(
    "Kubernetes has no User or Group objects. This list comes from the subjects of RoleBindings and ClusterRoleBindings.",
  );
  expect(rowKeys()).toEqual(["User:alice", "Group:payments-devs"]);
  const alice = within(row("User:alice"));
  expect(alice.getByText("User")).toBeTruthy();
  expect(alice.getByText("2")).toBeTruthy();
  expect(alice.getByText("ClusterRole/edit, ClusterRole/view")).toBeTruthy();
  expect(alice.getByText("Cluster, payments")).toBeTruthy();
});

test("the kind, the search and Show system narrow or widen the list", async () => {
  await show();
  fireEvent.click(screen.getByRole("radio", { name: "Groups" }));
  expect(rowKeys()).toEqual(["Group:payments-devs"]);
  fireEvent.click(screen.getByRole("switch", { name: "Show system" }));
  expect(rowKeys()).toEqual(["Group:payments-devs", "Group:system:masters"]);
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  fireEvent.change(screen.getByLabelText("Search users and groups"), {
    target: { value: "ali" },
  });
  expect(rowKeys()).toEqual(["User:alice"]);
  fireEvent.change(screen.getByLabelText("Search users and groups"), {
    target: { value: "nobody" },
  });
  expect(screen.getByTestId("ug-no-match").textContent).toContain(
    "No users or groups match the filters.",
  );
});

test("one binding kind refused: a notice, and the subjects of the other", async () => {
  await show({ denied: ["rolebindings"] });
  expect(screen.getByTestId("ug-partial").textContent).toBe(
    "Some bindings can't be readYou may not list RoleBindings. The list shows users and groups from ClusterRoleBindings only.",
  );
  expect(rowKeys()).toEqual(["User:alice"]);
});

test("both refused: the error", async () => {
  await show({ denied: ["rolebindings", "clusterrolebindings"] });
  expect(screen.getByTestId("ug-error").textContent).toContain(
    "Could not load bindings",
  );
});

test("no user or group in any binding: the empty state", async () => {
  await show({ cluster: [], namespaced: [] });
  const empty = screen.getByTestId("ug-empty");
  expect(empty.textContent).toContain("No bindings name a user or group");
  expect(empty.textContent).toContain(
    "Create a user with a client certificate, or bind a role to a user or group.",
  );
});

test("a row opens its subject in the address", async () => {
  await show();
  fireEvent.click(row("User:alice"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/users-groups?subject=User%3Aalice",
  );
});

const ALICE_AT = "/cluster/c1/users-groups?subject=User%3Aalice";
const ALICE_VIEW = {
  kind: "ClusterRoleBinding",
  namespace: null,
  name: "alice-view",
  resourceVersion: "1",
} as const;
const DEVS_EDIT = {
  kind: "RoleBinding",
  namespace: "payments",
  name: "payments-devs-edit",
  resourceVersion: "1",
} as const;

const href = (name: string) =>
  decodeURIComponent(
    screen.getByRole("link", { name }).getAttribute("href") ?? "",
  );

async function confirmRemove() {
  fireEvent.click(screen.getByTestId("ug-drawer-remove"));
  const dialog = screen.getByTestId("ug-remove");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await flush();
  });
}

test("the address opens a subject's drawer, with links to each binding and its role", async () => {
  await show({ at: ALICE_AT });
  expect(screen.getByTestId("ug-drawer-kind").textContent).toBe("User");
  expect(screen.getByTestId("ug-drawer-title").textContent).toBe("alice");
  const crb = href("ClusterRoleBinding alice-view");
  expect(crb).toContain("/clusterrolebindings?");
  expect(crb).toContain("object=/alice-view");
  const rb = href("RoleBinding payments-devs-edit");
  expect(rb).toContain("/rolebindings?");
  expect(rb).toContain("object=payments/payments-devs-edit");
  expect(href("ClusterRole edit")).toContain("object=/edit");
  const rows = within(screen.getByTestId("ug-drawer-bindings"));
  expect(rows.getByText("Cluster")).toBeTruthy();
  expect(rows.getByText("payments")).toBeTruthy();
  fireEvent.click(screen.getByTestId("ug-drawer-close"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/users-groups",
  );
});

test("a Role in a RoleBinding links within the binding's namespace", async () => {
  await show({
    at: ALICE_AT,
    namespaced: [
      binding("shop", "alice-reader", ["Role", "shop-reader"], [user("alice")]),
    ],
  });
  expect(href("Role shop-reader")).toContain("object=shop/shop-reader");
});

test("Remove asks first, says what happens to each binding, then removes and reports", async () => {
  const backend = await show({
    at: ALICE_AT,
    remove: (a) =>
      [
        { binding: a.bindings[0], outcome: { type: "deleted" } },
        { binding: a.bindings[1], outcome: { type: "updated" } },
      ] as SubjectRemoval[],
  });
  fireEvent.click(screen.getByTestId("ug-drawer-remove"));
  const dialog = screen.getByTestId("ug-remove");
  expect(
    within(dialog).getByText("Remove User alice from 2 bindings?"),
  ).toBeTruthy();
  expect(
    [...dialog.querySelectorAll("li")].map((li) => li.textContent),
  ).toEqual([
    "ClusterRoleBinding alice-view · Delete · no other subjects",
    "RoleBinding payments/payments-devs-edit · Remove · 1 other subject stays",
  ]);
  expect(dialog.textContent).toContain(
    "Access through groups, such as system:authenticated, stays. The user's certificates stay valid until they expire, without this access.",
  );
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await flush();
  });
  expect(backend.callsTo("access_subject_remove")).toEqual([
    {
      clusterId: "c1",
      subject: { kind: "User", name: "alice" },
      bindings: [ALICE_VIEW, DEVS_EDIT],
    },
  ]);
  expect(await screen.findByText("Removed alice from 2 bindings")).toBeTruthy();
  expect(screen.queryByTestId("ug-remove")).toBeNull();
});

test("a group's confirm says its members lose the access", async () => {
  await show({ at: "/cluster/c1/users-groups?subject=Group%3Apayments-devs" });
  fireEvent.click(screen.getByTestId("ug-drawer-remove"));
  const dialog = screen.getByTestId("ug-remove");
  expect(
    within(dialog).getByText("Remove Group payments-devs from 1 binding?"),
  ).toBeTruthy();
  expect(dialog.textContent).toContain(
    "Every member of payments-devs loses the access these bindings give.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("ug-remove")).toBeNull();
});

test("a binding changed meanwhile is left as it was, and the result says so", async () => {
  await show({
    at: ALICE_AT,
    remove: (a) =>
      [
        { binding: a.bindings[0], outcome: { type: "conflict" } },
        { binding: a.bindings[1], outcome: { type: "updated" } },
      ] as SubjectRemoval[],
  });
  await confirmRemove();
  const result = screen.getByTestId("ug-result");
  expect(
    within(result).getByText("Removed alice from 1 of 2 bindings"),
  ).toBeTruthy();
  expect(
    [...result.querySelectorAll("li")].map((li) => li.textContent),
  ).toEqual([
    "ClusterRoleBinding alice-view · Changed since you opened it. Try again.",
  ]);
  fireEvent.click(screen.getByTestId("ug-result-close"));
  expect(screen.queryByTestId("ug-result")).toBeNull();
});

test("a binding that failed shows the API's message", async () => {
  await show({
    at: ALICE_AT,
    remove: (a) =>
      [
        { binding: a.bindings[0], outcome: { type: "deleted" } },
        {
          binding: a.bindings[1],
          outcome: {
            type: "failed",
            error: {
              code: "Forbidden",
              message: 'rolebindings "payments-devs-edit" is forbidden',
              details: null,
            },
          },
        },
      ] as SubjectRemoval[],
  });
  await confirmRemove();
  expect(screen.getByTestId("ug-result").textContent).toContain(
    'RoleBinding payments/payments-devs-edit · rolebindings "payments-devs-edit" is forbidden',
  );
});

test("a refused call closes the confirm with an error toast", async () => {
  await show({
    at: ALICE_AT,
    remove: () => {
      throw { code: "Unreachable", message: "the cluster did not answer" };
    },
  });
  await confirmRemove();
  expect(
    await screen.findByText("Could not remove alice from its bindings"),
  ).toBeTruthy();
  expect(screen.queryByTestId("ug-remove")).toBeNull();
});

test("system names cannot be removed, and the button says why", async () => {
  await show({
    at: "/cluster/c1/users-groups?subject=Group%3Asystem%3Amasters",
  });
  expect(screen.getByTestId("ug-drawer-title").textContent).toBe(
    "system:masters",
  );
  expect(
    (screen.getByTestId("ug-drawer-remove") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.focus(screen.getByTestId("ug-drawer-remove-why"));
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "Kubernetes manages system users and groups",
  );
});
