import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { DrawerTarget } from "../../kinds/detail/links";
import type { KubeObject } from "../../kinds/objects";
import {
  LINGER_MS,
  resetResourcesForTest,
  useResourceList,
} from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { useDrawerObject } from "./useDrawerObject";

function info(plural: string, kind: string, canList = true): ApiResourceInfo {
  return {
    resource: { group: "", version: "v1", plural, kind, namespaced: true },
    verbs: [],
    shortNames: [],
    canList,
    canWatch: canList,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

const SERVICES = info("services", "Service");
const CONFIGMAPS = info("configmaps", "ConfigMap");
const PODS = info("pods", "Pod");
const TARGET: DrawerTarget = {
  group: "",
  plural: "services",
  namespace: "n",
  name: "app",
};
const object = (name: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  metadata: { name, namespace: "n", resourceVersion: "1" },
  ...extra,
});

type Get = (a: { name: string }) => unknown;
type OnEvent = { onmessage: (e: WatchEvent) => void };

function backend(
  opts: {
    get?: Get;
    subscribe?: () => unknown;
    subscribeObject?: () => unknown;
  } = {},
) {
  let send: (e: WatchEvent) => void = () => {};
  let sendObject: (e: WatchEvent) => void = () => {};
  const b = mockBackend({
    resources_subscribe:
      opts.subscribe ??
      ((a: { onEvent: OnEvent }) => {
        send = a.onEvent.onmessage;
        return "sub";
      }),
    resources_subscribe_object:
      opts.subscribeObject ??
      ((a: { onEvent: OnEvent }) => {
        sendObject = a.onEvent.onmessage;
        return "object-sub";
      }),
    resources_unsubscribe: () => null,
    resource_get:
      opts.get ??
      (() => {
        throw { code: "NotFound", message: "not found" };
      }),
  });
  const deliver = (to: () => (e: WatchEvent) => void, e: WatchEvent) =>
    act(async () => {
      to()(e);
      await flush();
    });
  return {
    b,
    /** A snapshot of the list the screen holds. */
    snapshot: (items: KubeObject[]) =>
      deliver(() => send, { type: "snapshot", items } as WatchEvent),
    /** An event of the single-object watch. */
    object: (e: WatchEvent) => deliver(() => sendObject, e),
  };
}

/** The drawer's read, as a screen showing the list of `i`'s kind does it. */
const read = (
  i: ApiResourceInfo | undefined,
  target: DrawerTarget | null = TARGET,
  lastSeen: KubeObject | null = null,
) =>
  renderHook(() => {
    useResourceList("c1", i?.canList ? i.resource : null);
    return useDrawerObject("c1", i, target, lastSeen);
  });

/** The drawer's read with no list open, as for a linked object or a dock tab. */
const readAlone = (
  i: ApiResourceInfo,
  target: DrawerTarget = TARGET,
  lastSeen: KubeObject | null = null,
) =>
  renderHook(
    (props: { lastSeen: KubeObject | null }) =>
      useDrawerObject("c1", i, target, props.lastSeen),
    { initialProps: { lastSeen } },
  );

beforeEach(() => resetResourcesForTest());
afterEach(() => {
  resetResourcesForTest();
  vi.useRealTimers();
});

test("no target is loading and a kind the cluster does not serve is notServed", async () => {
  backend();
  expect(read(SERVICES, null).result.current.status).toBe("loading");
  const { result } = read(undefined);
  await act(flush);
  expect(result.current).toMatchObject({ status: "notServed", object: null });
});

test("a listed object is live from the shared list, and loading until the list syncs", async () => {
  const { b, snapshot } = backend();
  const { result } = read(SERVICES);
  await act(flush);
  expect(result.current.status).toBe("loading");
  await snapshot([object("app")]);
  expect(result.current.status).toBe("live");
  expect(result.current.object?.metadata.name).toBe("app");
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test("a listed object that goes away is deleted when one was seen, with no get", async () => {
  const { b, snapshot } = backend();
  const { result } = read(SERVICES, TARGET, object("app"));
  await act(flush);
  await snapshot([]);
  expect(result.current).toMatchObject({ status: "deleted" });
  expect(result.current.object?.metadata.name).toBe("app");
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test("an object the synced list lacks is confirmed with one get", async () => {
  const { b, snapshot } = backend({ get: () => object("app") });
  const { result } = read(SERVICES);
  await act(flush);
  await snapshot([]);
  await act(flush);
  expect(result.current.status).toBe("fetched");
  expect(b.callsTo("resource_get")).toEqual([
    {
      clusterId: "c1",
      resource: SERVICES.resource,
      namespace: "n",
      name: "app",
    },
  ]);
});

test.each([
  ["NotFound", "notFound"],
  ["Forbidden", "forbidden"],
  ["Unauthorized", "forbidden"],
  ["Unreachable", "error"],
])("a get failing with %s gives %s", async (code, status) => {
  const { snapshot } = backend({
    get: () => {
      throw { code, message: `${code} message` };
    },
  });
  const { result } = read(SERVICES);
  await act(flush);
  await snapshot([]);
  await act(flush);
  expect(result.current.status).toBe(status);
  if (status !== "notFound") {
    expect(result.current.message).toBe(`${code} message`);
  }
});

test("without list access there is no watch, one get, and Retry gets again", async () => {
  let fail = true;
  const { b } = backend({
    get: () => {
      if (fail) throw { code: "Internal", message: "boom" };
      return object("app");
    },
  });
  const { result } = read(info("services", "Service", false));
  await act(flush);
  expect(b.callsTo("resources_subscribe")).toHaveLength(0);
  expect(b.callsTo("resources_subscribe_object")).toHaveLength(0);
  expect(result.current).toMatchObject({ status: "error", message: "boom" });
  fail = false;
  act(() => result.current.retry());
  expect(result.current.status).toBe("loading");
  await act(flush);
  expect(result.current.status).toBe("fetched");
  expect(b.callsTo("resource_get")).toHaveLength(2);
});

const FORBIDDEN = () => {
  throw { code: "Forbidden", message: "services is forbidden" };
};

test("a list the user may not watch hands over to a watch of the one object", async () => {
  const { b, object: send } = backend({ subscribe: FORBIDDEN });
  const { result } = read(SERVICES);
  await act(flush);
  await act(flush);
  expect(b.callsTo("resources_subscribe_object")).toHaveLength(1);
  await send({ type: "snapshot", items: [object("app")] } as WatchEvent);
  expect(result.current.status).toBe("live");
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test("when the one object may not be watched either, the drawer falls back to a get", async () => {
  backend({
    subscribe: FORBIDDEN,
    subscribeObject: FORBIDDEN,
    get: () => object("app"),
  });
  const { result } = read(SERVICES);
  await act(flush);
  await act(flush);
  await act(flush);
  expect(result.current.status).toBe("fetched");
});

test("a list the cluster does not serve is notServed with the list's message", async () => {
  backend({
    subscribe: () => {
      throw {
        code: "Internal",
        message: "the server could not find the requested resource",
      };
    },
  });
  const { result } = read(SERVICES);
  await act(flush);
  await act(flush);
  expect(result.current).toMatchObject({
    status: "notServed",
    message: "the server could not find the requested resource",
  });
});

test("a trimmed Pod row is live with the whole object from a get", async () => {
  const whole = object("web", { spec: { nodeName: "n1" } });
  const { b, snapshot } = backend({ get: () => whole });
  const { result } = read(PODS, {
    group: "",
    plural: "pods",
    namespace: "n",
    name: "web",
  });
  await act(flush);
  await snapshot([object("web")]);
  await act(flush);
  expect(result.current.status).toBe("live");
  expect(result.current.object).toEqual(whole);
  expect(b.callsTo("resource_get")).toHaveLength(1);
});

const POD_TARGET: DrawerTarget = {
  group: "",
  plural: "pods",
  namespace: "n",
  name: "web",
};

test("with no list open, a trimmed kind reads the whole object from a single-object watch, with no get", async () => {
  const whole = object("web", { spec: { nodeName: "n1", volumes: [] } });
  const { b, object: event } = backend();
  const { result } = readAlone(PODS, POD_TARGET);
  await act(flush);
  expect(result.current.status).toBe("loading");
  expect(b.callsTo("resources_subscribe")).toHaveLength(0);
  expect(b.callsTo("resources_subscribe_object")).toEqual([
    {
      clusterId: "c1",
      resource: PODS.resource,
      namespace: "n",
      name: "web",
      onEvent: expect.anything(),
    },
  ]);
  await event({ type: "status", status: "syncing", message: null });
  await event({ type: "snapshot", items: [whole] } as WatchEvent);
  await event({ type: "status", status: "live", message: null });
  expect(result.current.status).toBe("live");
  expect(result.current.object).toEqual(whole);
  const changed = object("web", {
    metadata: { name: "web", namespace: "n", resourceVersion: "2" },
  });
  await event({ type: "batch", upserts: [changed], deletes: [] } as WatchEvent);
  expect(result.current.object).toEqual(changed);
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test("with the list open, the drawer reads its row and opens no object watch", async () => {
  const { b, snapshot } = backend();
  const { result } = read(SERVICES);
  await act(flush);
  await snapshot([object("app")]);
  expect(result.current.status).toBe("live");
  expect(b.callsTo("resources_subscribe")).toHaveLength(1);
  expect(b.callsTo("resources_subscribe_object")).toHaveLength(0);
});

test("a ConfigMap row from the list is trimmed, so it is shown whole from a get", async () => {
  const whole = object("app", { data: { key: "value" } });
  const { b, snapshot } = backend({ get: () => whole });
  const { result } = read(CONFIGMAPS, { ...TARGET, plural: "configmaps" });
  await act(flush);
  await snapshot([object("app", { data: { key: "" } })]);
  await act(flush);
  expect(result.current.status).toBe("live");
  expect(result.current.object).toEqual(whole);
  expect(b.callsTo("resource_get")).toHaveLength(1);
});

test("an object the object watch sees deleted is deleted, showing how it last looked", async () => {
  const { b, object: event } = backend();
  const seen = object("app");
  const { result, rerender } = readAlone(SERVICES);
  await act(flush);
  await event({ type: "snapshot", items: [seen] } as WatchEvent);
  expect(result.current.status).toBe("live");
  // The drawer's history remembers the live object.
  rerender({ lastSeen: seen });
  await event({
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "n", name: "app" }],
  } as WatchEvent);
  expect(result.current).toMatchObject({ status: "deleted", object: seen });
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test("an empty snapshot of the object watch is notFound, with no get", async () => {
  const { b, object: event } = backend();
  const { result } = readAlone(SERVICES);
  await act(flush);
  await event({ type: "snapshot", items: [] } as WatchEvent);
  expect(result.current).toMatchObject({ status: "notFound", object: null });
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test.each([
  ["a final status", "status"],
  ["a refused subscribe", "refused"],
])(
  "an object watch forbidden by %s falls back to a get, and a forbidden get is forbidden",
  async (_label, how) => {
    const { b, object: event } = backend({
      subscribeObject:
        how === "refused"
          ? () => {
              throw { code: "Forbidden", message: "watch is forbidden" };
            }
          : undefined,
      get: () => {
        throw { code: "Forbidden", message: "get is forbidden" };
      },
    });
    const { result } = readAlone(SERVICES);
    await act(flush);
    if (how === "status") {
      await event({
        type: "status",
        status: "forbidden",
        message: "watch is forbidden",
      });
    }
    await act(flush);
    expect(result.current).toMatchObject({
      status: "forbidden",
      message: "get is forbidden",
    });
    expect(b.callsTo("resource_get")).toHaveLength(1);
  },
);

test("an object watch the cluster does not serve is notServed with its message", async () => {
  const { object: event } = backend();
  const { result } = readAlone(SERVICES);
  await act(flush);
  await event({
    type: "status",
    status: "notServed",
    message: "the server could not find the requested resource",
  });
  expect(result.current).toMatchObject({
    status: "notServed",
    message: "the server could not find the requested resource",
  });
});

test("closing the drawer ends the object watch after the linger", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  const { b, object: event } = backend();
  const { unmount } = readAlone(SERVICES);
  await act(flush);
  await event({ type: "snapshot", items: [object("app")] } as WatchEvent);
  unmount();
  expect(b.callsTo("resources_unsubscribe")).toHaveLength(0);
  await act(async () => {
    vi.advanceTimersByTime(LINGER_MS);
    await flush();
  });
  expect(b.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "object-sub" },
  ]);
});

test("an object watch whose id arrives after the drawer closed is ended on arrival", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  let answer: (id: string) => void = () => {};
  const { b } = backend({
    subscribeObject: () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  });
  const { unmount } = readAlone(SERVICES);
  await act(flush);
  unmount();
  await act(async () => {
    vi.advanceTimersByTime(LINGER_MS);
    await flush();
  });
  expect(b.callsTo("resources_unsubscribe")).toHaveLength(0);
  await act(async () => {
    answer("late");
    await flush();
  });
  expect(b.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "late" },
  ]);
});
