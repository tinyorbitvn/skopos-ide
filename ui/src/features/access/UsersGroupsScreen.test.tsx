import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
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

/** Answers each binding list's subscription; `denied` plurals are refused. */
async function show(
  options: {
    cluster?: KubeObject[];
    namespaced?: KubeObject[];
    denied?: string[];
    at?: string;
  } = {},
) {
  const subs = new Map<string, (event: WatchEvent) => void>();
  mockBackend({
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
  });
  render(
    <MemoryRouter initialEntries={[options.at ?? "/cluster/c1/users-groups"]}>
      <UsersGroupsScreen clusterId="c1" />
      <Location />
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
