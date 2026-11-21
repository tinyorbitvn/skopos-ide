import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { servedResource } from "../../test/graph";
import { flush, mockBackend } from "../../test/ipc";
import { metricsServer, usageSnapshot } from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import { useOverviewDrawer } from "./useOverviewDrawer";

const DEPLOYMENTS = servedResource("Deployment", "apps", "deployments");
const SERVICES = servedResource("Service", "", "services");
const NAMESPACES = servedResource("Namespace", "", "namespaces", false);
const ROUTES = servedResource(
  "HTTPRoute",
  "gateway.networking.k8s.io",
  "httproutes",
);
const SECRETS = servedResource("Secret", "", "secrets");
const RESOURCES = [DEPLOYMENTS, SERVICES, NAMESPACES, ROUTES, SECRETS];
/** The kinds the page opens; Secrets are served, but the page does not open them. */
const OPENABLE: readonly ResourceRef[] = [
  DEPLOYMENTS,
  SERVICES,
  NAMESPACES,
  ROUTES,
].map((r) => r.resource);

/** A page with rows that open objects, and a button that closes the drawer. */
function Page() {
  const drawer = useOverviewDrawer("c1", RESOURCES, OPENABLE);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it stands in for a page root, which only listens for the Escape that closes the drawer.
    <div onKeyDown={drawer.onKeyDown}>
      <button
        type="button"
        data-testid="open-deployment"
        onClick={() => drawer.open(DEPLOYMENTS.resource, "shop/web")}
      >
        web
      </button>
      <button
        type="button"
        data-testid="open-service"
        onClick={() => drawer.open(SERVICES.resource, "shop/web")}
      >
        web service
      </button>
      <button
        type="button"
        data-testid="open-namespace"
        onClick={() => drawer.open(NAMESPACES.resource, "/shop")}
      >
        shop
      </button>
      <button type="button" data-testid="close" onClick={() => drawer.close()}>
        close
      </button>
      {drawer.drawer}
    </div>
  );
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

async function show(entry = "/cluster/c1/workloads") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Page />
      <Where />
    </MemoryRouter>,
  );
  await act(flush);
}

const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  resetResourcesForTest();
  resetMetricsForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
  mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    metrics_provider: () => metricsServer(),
    metrics_usage: () => usageSnapshot([]),
    resources_subscribe: () => "sub",
    resources_unsubscribe: () => null,
    resources_subscribe_object: () => "object-sub",
    resource_get: () => new Promise(() => {}),
    resource_events: () => new Promise(() => {}),
  });
});

test("a row opens its object's drawer, keyed in the URL by the kind's plural and group (R3)", async () => {
  await show();
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  fireEvent.click(screen.getByTestId("open-deployment"));
  expect(text("where")).toBe(
    "/cluster/c1/workloads?open=deployments.apps&object=shop%2Fweb",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("Deployment");
  expect(text("detail-title")).toBe("web");
});

test("a core kind is keyed by its plural, and a cluster-scoped object by /<name>", async () => {
  await show();
  fireEvent.click(screen.getByTestId("open-namespace"));
  expect(text("where")).toBe(
    "/cluster/c1/workloads?open=namespaces&object=%2Fshop",
  );
  await act(flush);
  expect(text("detail-kind")).toBe("Namespace");
  expect(text("detail-title")).toBe("shop");
});

test("Escape from the drawer closes it and drops both keys, as close does", async () => {
  await show();
  fireEvent.click(screen.getByTestId("open-service"));
  await act(flush);
  expect(text("detail-kind")).toBe("Service");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe("/cluster/c1/workloads");

  fireEvent.click(screen.getByTestId("open-service"));
  await act(flush);
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
  fireEvent.click(screen.getByTestId("close"));
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(text("where")).toBe("/cluster/c1/workloads");
});

test("an Escape from outside the drawer leaves it open", async () => {
  await show();
  fireEvent.click(screen.getByTestId("open-deployment"));
  await act(flush);
  fireEvent.keyDown(screen.getByTestId("open-service"), { key: "Escape" });
  await act(flush);
  expect(screen.getByTestId("detail-drawer")).toBeTruthy();
  expect(text("where")).toBe(
    "/cluster/c1/workloads?open=deployments.apps&object=shop%2Fweb",
  );
});

test("the drawer opens from the URL for a kind the page lists", async () => {
  await show(
    "/cluster/c1/workloads?open=httproutes.gateway.networking.k8s.io&object=shop%2Fstore",
  );
  expect(text("detail-kind")).toBe("HTTPRoute");
  expect(text("detail-title")).toBe("store");
});

test.each([
  ["a kind the page does not open", "?open=secrets&object=shop%2Fkey"],
  [
    "a grouped kind keyed without its group",
    "?open=deployments&object=shop%2Fweb",
  ],
])("%s leaves the drawer closed", async (_, search) => {
  await show(`/cluster/c1/workloads${search}`);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
});

test("another kind under the same object key opens its own drawer", async () => {
  await show();
  fireEvent.click(screen.getByTestId("open-deployment"));
  await act(flush);
  expect(text("detail-kind")).toBe("Deployment");
  fireEvent.click(screen.getByTestId("open-service"));
  await act(flush);
  expect(text("where")).toBe(
    "/cluster/c1/workloads?open=services&object=shop%2Fweb",
  );
  expect(text("detail-kind")).toBe("Service");
});
