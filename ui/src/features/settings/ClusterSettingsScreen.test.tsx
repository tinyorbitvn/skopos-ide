import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { AgentStatus } from "../../ipc/generated/AgentStatus";
import type { ClusterAgentSettings } from "../../ipc/generated/ClusterAgentSettings";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import { resetAgentsForTest } from "../../stores/agents";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import {
  queryKey,
  resetMetricsForTest,
  useMetrics,
} from "../../stores/metrics";
import { CSS_FILES, cssRules } from "../../test/css";
import { type Backend, clusterEntry, flush, mockBackend } from "../../test/ipc";
import { clusterSettings, metricsResult, prometheus } from "../../test/metrics";
import { CONNECTED } from "../../test/terminal";
import { ClusterSettingsRoute } from "./ClusterSettingsScreen";
import { keptDraft, resetDraftsForTest } from "./drafts";

beforeEach(() => {
  resetCatalogForTest();
  resetMetricsForTest();
  resetDraftsForTest();
  resetAgentsForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function agentRow(partial: Partial<AgentStatus>): AgentStatus {
  return {
    id: "claude",
    name: "Claude",
    state: { state: "ready" },
    detail: "/usr/bin/claude",
    hint: null,
    isDefault: false,
    custom: false,
    ...partial,
  };
}

const ICON = "data:image/png;base64,AAAA";

const FULL = clusterSettings({
  displayName: "Prod",
  icon: ICON,
  defaultNamespace: "shop",
  accessibleNamespaces: ["shop", "default"],
  terminalCwd: "/srv/work",
  proxyUrl: "http://proxy.example:3128",
  nodeShellImage: "alpine:3.22",
  metricsProvider: { kind: "metricsServer" },
});

const SAVED_PROMETHEUS = clusterSettings({
  metricsProvider: {
    kind: "prometheus",
    namespace: "monitoring",
    service: "prometheus-server",
    port: 80,
    scheme: "https",
    pathPrefix: "/prom",
    tenant: null,
    matcher: null,
  },
});

async function show(
  options: {
    saved?: ClusterSettings;
    state?: ConnectionState;
    cluster?: Partial<ClusterEntry>;
    handlers?: Parameters<typeof mockBackend>[0];
  } = {},
) {
  useCatalog.setState({
    loading: false,
    error: null,
    clusters: [
      clusterEntry({
        id: "id-x",
        name: "x",
        contextName: "kind-x",
        state: options.state ?? { status: "disconnected" },
        ...options.cluster,
      }),
    ],
  });
  const backend = mockBackend({
    cluster_settings_get: () => options.saved ?? clusterSettings(),
    cluster_settings_set: () => null,
    agents_status: () => [
      agentRow({ isDefault: true }),
      agentRow({ id: "codex", name: "Codex" }),
    ],
    ...options.handlers,
  });
  render(
    <MemoryRouter initialEntries={["/cluster/id-x/settings"]}>
      <Routes>
        <Route
          path="/cluster/:id/settings"
          element={<ClusterSettingsRoute />}
        />
        <Route path="/cluster/:id" element={<p>overview page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const status = () => screen.getByTestId("settings-status").textContent;
const preview = () => screen.getByTestId("settings-icon-preview");
const radio = (kind: string) =>
  screen
    .getByTestId(`settings-metrics-${kind}`)
    .querySelector("input") as HTMLInputElement;
const PROM_FIELDS = [
  "settings-prom-namespace",
  "settings-prom-service",
  "settings-prom-port",
];
const promFields = () => PROM_FIELDS.map((id) => input(id).value);
const SAVED_MIMIR = clusterSettings({
  metricsProvider: {
    kind: "prometheus",
    namespace: "mimir",
    service: "mimir-gateway",
    port: 80,
    scheme: "https",
    pathPrefix: "/prometheus",
    tenant: "team-a",
    matcher: { name: "cluster", value: "prod" },
  },
});
const MIMIR_FIELDS = [
  "settings-prom-prefix",
  "settings-prom-tenant",
  "settings-prom-label-name",
  "settings-prom-label-value",
];
const mimirFields = () => MIMIR_FIELDS.map((id) => input(id).value);
const scheme = (value: "http" | "https") =>
  screen
    .getByTestId(`settings-prom-scheme-${value}`)
    .querySelector("input") as HTMLInputElement;

function type(id: string, value: string): void {
  fireEvent.change(input(id), { target: { value } });
}

/** The error under a field, or null. */
function errorOf(id: string): string | null {
  return (
    input(id).parentElement?.querySelector('[role="alert"]')?.textContent ??
    null
  );
}

function pickProvider(kind: string): void {
  fireEvent.click(screen.getByTestId(`settings-metrics-${kind}`));
}

function chooseIcon(file: File): void {
  fireEvent.change(screen.getByTestId("settings-icon-file"), {
    target: { files: [file] },
  });
}

const png = (size: number) =>
  new File([new Uint8Array(size)], "icon.png", { type: "image/png" });

async function save(): Promise<void> {
  fireEvent.click(button("settings-save"));
  await act(flush);
}

/** The settings of the first save. */
function savedPayload(backend: Backend): ClusterSettings | undefined {
  return backend.callsTo("cluster_settings_set")[0]?.settings as
    | ClusterSettings
    | undefined;
}

test("the head says what the kubeconfig runs and that TLS is not verified", async () => {
  await show({ cluster: { execCommand: "aws", insecureTls: true } });

  const tls = within(screen.getByTestId("settings-note-tls"));
  expect(tls.getByText("TLS not verified")).toBeTruthy();
  expect(
    tls.getByText(
      "This kubeconfig turns off TLS verification (insecure-skip-tls-verify), so the server's identity is not checked.",
    ),
  ).toBeTruthy();
  const exec = within(screen.getByTestId("settings-note-exec"));
  expect(exec.getByText("Exec plugin")).toBeTruthy();
  expect(
    exec.getByText(
      'Connecting runs "aws" from this kubeconfig to get credentials.',
    ),
  ).toBeTruthy();
});

test("the head has no such note for a kubeconfig that runs nothing and checks TLS", async () => {
  await show();
  await screen.findByTestId("settings-title");
  expect(screen.queryByTestId("settings-note-tls")).toBeNull();
  expect(screen.queryByTestId("settings-note-exec")).toBeNull();
});

test("the head names the cluster and its kubeconfig, and the fields show the saved settings", async () => {
  await show({ saved: FULL });
  expect(screen.getByTestId("settings-title").textContent).toBe(
    "Settings for x",
  );
  expect(screen.getByText(/^Context kind-x in /).textContent).toBe(
    "Context kind-x in /home/me/.kube/config. These settings stay in SkoposIDE; the kubeconfig file is not changed.",
  );
  expect(button("settings-back").textContent).toBe("Open x");
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual([
    "General",
    "Namespaces",
    "Terminal and node shell",
    "Network",
    "Metrics",
    "Agent",
  ]);
  expect(input("settings-display-name").value).toBe("Prod");
  expect(input("settings-display-name").placeholder).toBe("kind-x");
  expect(preview().getAttribute("src")).toBe(ICON);
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "shop",
  );
  expect(input("settings-accessible-namespaces").value).toBe("shop, default");
  expect(input("settings-terminal-cwd").value).toBe("/srv/work");
  expect(input("settings-node-shell-image").value).toBe("alpine:3.22");
  expect(input("settings-proxy-url").value).toBe("http://proxy.example:3128");
  expect(radio("metricsServer").checked).toBe(true);
  expect(screen.queryByTestId("settings-prom-namespace")).toBeNull();
  expect(status()).toBe("");
  expect(button("settings-save").disabled).toBe(true);
  expect(button("settings-reset").disabled).toBe(true);
});

test("each field carries its label and help, and the provider options their descriptions", async () => {
  await show();
  const field = (id: string) => input(id).parentElement?.textContent;
  expect(field("settings-display-name")).toBe(
    "Display nameShown in the hotbar, the catalog and the title",
  );
  expect(field("settings-accessible-namespaces")).toBe(
    "Accessible namespacesComma separated. When set, SkoposIDE watches only these",
  );
  expect(field("settings-terminal-cwd")).toBe(
    "Terminal working directoryWhere the local terminal of this cluster starts",
  );
  expect(field("settings-node-shell-image")).toBe(
    "Node shell imageThe privileged Pod that enters a node",
  );
  expect(field("settings-proxy-url")).toBe(
    "Proxy URLFor this cluster's API server. Empty uses the kubeconfig's proxy-url, if it has one",
  );
  expect(screen.getByRole("combobox", { name: "Default namespace" })).toBe(
    screen.getByTestId("settings-default-namespace"),
  );
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "From the kubeconfig",
  );
  const group = screen.getByRole("group", { name: "Metrics provider" });
  expect(group).toBe(screen.getByTestId("settings-metrics"));
  expect(
    ["auto", "prometheus", "remote", "metricsServer", "none"].map(
      (k) => screen.getByTestId(`settings-metrics-${k}`).textContent,
    ),
  ).toEqual([
    "DetectLook for a Prometheus Service across namespaces, then fall back to metrics-server",
    "Prometheus or Mimir in the clusterA Service you name, queried through the API server proxy",
    "Prometheus-compatible URLMimir, Grafana Cloud or another Prometheus API, reached directly",
    "metrics-server onlyCurrent CPU and memory, no history",
    "NoneNo metrics for this cluster",
  ]);
  expect(radio("auto").checked).toBe(true);
  expect(preview().textContent).toBe("No icon");
  expect(screen.queryByTestId("settings-icon-remove")).toBeNull();
});

test("every field's error shows under it; Save stays disabled and the status says why", async () => {
  await show();
  type("settings-accessible-namespaces", "shop, Bad_NS");
  type("settings-node-shell-image", "alpine 3.22");
  type("settings-proxy-url", "ftp://proxy.example");
  pickProvider("prometheus");
  type("settings-prom-namespace", "Bad");
  type("settings-prom-service", "9svc");
  type("settings-prom-port", "0");
  expect(errorOf("settings-accessible-namespaces")).toBe(
    "Not a namespace name: Bad_NS",
  );
  expect(errorOf("settings-node-shell-image")).toBe(
    "An image reference, such as alpine:3.22",
  );
  expect(errorOf("settings-proxy-url")).toBe(
    "Use http://, https:// or socks5:// with a host and an optional port",
  );
  expect(errorOf("settings-prom-namespace")).toBe("A namespace name");
  expect(errorOf("settings-prom-service")).toBe("A Service name");
  expect(errorOf("settings-prom-port")).toBe("A port from 1 to 65535");
  expect(input("settings-prom-port").getAttribute("aria-invalid")).toBe("true");
  expect(errorOf("settings-display-name")).toBeNull();
  expect(status()).toBe("Fix the fields marked in red to save.");
  expect(button("settings-save").disabled).toBe(true);

  type("settings-prom-port", "9090");
  expect(errorOf("settings-prom-port")).toBeNull();
});

test("Save sends the trimmed settings, toasts with the proxy line, forgets the provider and says Saved", async () => {
  const success = vi.spyOn(toast, "success");
  useMetrics.setState({
    providers: { "id-x": { value: prometheus(), error: null, loading: false } },
  });
  const backend = await show();
  type("settings-display-name", " Prod ");
  type("settings-accessible-namespaces", "shop, default shop");
  type("settings-proxy-url", "http://proxy.example:3128");
  expect(status()).toBe("Unsaved changes.");
  expect(button("settings-save").disabled).toBe(false);
  expect(keptDraft("id-x")?.proxyUrl).toBe("http://proxy.example:3128");

  await save();

  expect(backend.callsTo("cluster_settings_set")).toEqual([
    {
      id: "id-x",
      settings: clusterSettings({
        displayName: "Prod",
        accessibleNamespaces: ["shop", "default"],
        proxyUrl: "http://proxy.example:3128",
      }),
    },
  ]);
  expect(success).toHaveBeenCalledWith(
    "Saved the settings for Prod",
    "Reconnect to use the new proxy.",
  );
  expect(useMetrics.getState().providers["id-x"]).toBeUndefined();
  expect(keptDraft("id-x")).toBeUndefined();
  expect(status()).toBe(
    "Saved. Changes apply at once; the proxy applies on the next connect.",
  );
  expect(button("settings-save").disabled).toBe(true);
  expect(input("settings-display-name").value).toBe("Prod");

  type("settings-terminal-cwd", "/srv");
  expect(status()).toBe("Unsaved changes.");
});

test("a save that keeps the proxy toasts without the reconnect line, under the context name", async () => {
  const success = vi.spyOn(toast, "success");
  await show();
  type("settings-terminal-cwd", "/srv/work");
  await save();
  expect(success).toHaveBeenCalledWith(
    "Saved the settings for kind-x",
    undefined,
  );
});

test("a saved Prometheus shows its fields in the mono font and keeps its scheme and path prefix", async () => {
  const backend = await show({ saved: SAVED_PROMETHEUS });
  expect(radio("prometheus").checked).toBe(true);
  expect(promFields()).toEqual(["monitoring", "prometheus-server", "80"]);
  for (const id of PROM_FIELDS) {
    expect([id, input(id).classList.contains("mono")]).toEqual([id, true]);
  }
  type("settings-prom-port", "9091");
  await save();
  expect(savedPayload(backend)?.metricsProvider).toEqual({
    kind: "prometheus",
    namespace: "monitoring",
    service: "prometheus-server",
    port: 9091,
    scheme: "https",
    pathPrefix: "/prom",
    tenant: null,
    matcher: null,
  });
});

test("picking Prometheus fills the fields from the detected Prometheus, without asking the backend", async () => {
  useMetrics.setState({
    providers: {
      "id-x": {
        value: prometheus({
          namespace: "mon",
          service: "prom-server",
          port: 9090,
        }),
        error: null,
        loading: false,
      },
    },
  });
  const backend = await show();
  pickProvider("prometheus");
  expect(promFields()).toEqual(["mon", "prom-server", "9090"]);
  expect(backend.callsTo("metrics_provider")).toEqual([]);
  await save();
  expect(savedPayload(backend)?.metricsProvider).toEqual({
    kind: "prometheus",
    namespace: "mon",
    service: "prom-server",
    port: 9090,
    scheme: null,
    pathPrefix: null,
    tenant: null,
    matcher: null,
  });
});

test("with no Prometheus detected, picking Prometheus fills the defaults, and typed fields stay", async () => {
  await show();
  pickProvider("prometheus");
  expect(promFields()).toEqual([
    "observability",
    "prometheus-operated",
    "9090",
  ]);
  type("settings-prom-service", "prom");
  pickProvider("auto");
  expect(screen.queryByTestId("settings-prom-namespace")).toBeNull();
  pickProvider("prometheus");
  expect(promFields()).toEqual(["observability", "prom", "9090"]);
});

test("Restore defaults empties the draft without saving; Reset brings the saved settings back", async () => {
  const backend = await show({ saved: FULL });
  fireEvent.click(button("settings-restore"));
  expect(
    [
      "settings-display-name",
      "settings-accessible-namespaces",
      "settings-terminal-cwd",
      "settings-node-shell-image",
      "settings-proxy-url",
    ].map((id) => input(id).value),
  ).toEqual(["", "", "", "", ""]);
  expect(radio("auto").checked).toBe(true);
  expect(preview().textContent).toBe("No icon");
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "From the kubeconfig",
  );
  expect(status()).toBe("Unsaved changes.");
  expect(backend.callsTo("cluster_settings_set")).toEqual([]);
  expect(keptDraft("id-x")?.provider).toBe("auto");

  fireEvent.click(button("settings-reset"));
  expect(keptDraft("id-x")).toBeUndefined();
  expect(input("settings-display-name").value).toBe("Prod");
  expect(input("settings-proxy-url").value).toBe("http://proxy.example:3128");
  expect(radio("metricsServer").checked).toBe(true);
  expect(preview().getAttribute("src")).toBe(ICON);
  expect(status()).toBe("");
  expect(button("settings-reset").disabled).toBe(true);
});

test("a failed save toasts the error and keeps the draft", async () => {
  const error = vi.spyOn(toast, "error");
  await show({
    handlers: {
      cluster_settings_set: () => {
        throw {
          code: "InvalidInput",
          message: "the proxy URL is not valid",
          details: null,
        };
      },
    },
  });
  type("settings-display-name", "Prod");
  await save();
  expect(error).toHaveBeenCalledWith(
    "Could not save the settings for x",
    "the proxy URL is not valid",
  );
  expect(input("settings-display-name").value).toBe("Prod");
  expect(status()).toBe("Unsaved changes.");
  expect(button("settings-save").disabled).toBe(false);
});

test("a failed read shows the error with Retry, and Retry reads again", async () => {
  let reads = 0;
  await show({
    handlers: {
      cluster_settings_get: () => {
        reads += 1;
        if (reads === 1) {
          throw {
            code: "Internal",
            message: "the settings file is unreadable",
            details: null,
          };
        }
        return clusterSettings({ displayName: "Prod" });
      },
    },
  });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Could not read the settings");
  expect(alert.textContent).toContain("the settings file is unreadable");
  expect(screen.queryByTestId("settings-save")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(reads).toBe(2);
  expect(input("settings-display-name").value).toBe("Prod");
});

test("an icon of 262145 bytes is refused, 262144 is taken", async () => {
  const backend = await show();
  chooseIcon(png(262_145));
  await act(flush);
  expect(screen.getByTestId("settings-icon-error").textContent).toBe(
    "Pick a PNG or SVG image up to 256 KB",
  );
  expect(preview().textContent).toBe("No icon");
  expect(button("settings-save").disabled).toBe(true);

  chooseIcon(png(262_144));
  await waitFor(() => expect(preview().tagName).toBe("IMG"));
  const src = preview().getAttribute("src") ?? "";
  expect(src.startsWith("data:image/png;base64,")).toBe(true);
  expect(screen.queryByTestId("settings-icon-error")).toBeNull();
  await save();
  expect(savedPayload(backend)?.icon).toBe(src);
});

test("Choose image opens the file picker; another type is refused, an SVG is taken, and Remove clears the icon", async () => {
  const backend = await show({ saved: clusterSettings({ icon: ICON }) });
  const file = screen.getByTestId("settings-icon-file") as HTMLInputElement;
  expect(file.accept).toBe("image/png,image/svg+xml");
  const click = vi.spyOn(file, "click");
  fireEvent.click(button("settings-icon-choose"));
  expect(click).toHaveBeenCalledTimes(1);

  chooseIcon(new File(["x"], "icon.jpg", { type: "image/jpeg" }));
  await act(flush);
  expect(screen.getByTestId("settings-icon-error").textContent).toBe(
    "Pick a PNG or SVG image up to 256 KB",
  );
  expect(preview().getAttribute("src")).toBe(ICON);

  chooseIcon(new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }));
  await waitFor(() =>
    expect(preview().getAttribute("src")).toBe(
      "data:image/svg+xml;base64,PHN2Zy8+",
    ),
  );

  fireEvent.click(button("settings-icon-remove"));
  expect(preview().textContent).toBe("No icon");
  expect(screen.queryByTestId("settings-icon-remove")).toBeNull();
  await save();
  expect(savedPayload(backend)?.icon).toBeNull();
});

const AGENT: ClusterAgentSettings = {
  changes: "readOnly",
  namespaces: ["shop"],
  secretValues: true,
  exec: true,
  terminal: false,
  defaultAgent: "codex",
  notes: "Deploys go through Argo CD.",
};

test("Save sends the agent settings back as they were saved", async () => {
  const backend = await show({ saved: clusterSettings({ agent: AGENT }) });
  type("settings-display-name", "Prod");
  await save();
  expect(savedPayload(backend)?.agent).toEqual(AGENT);
});

test("the default namespace offers the kubeconfig, the cluster's namespaces and the saved one", async () => {
  const backend = await show({
    state: CONNECTED,
    saved: clusterSettings({ defaultNamespace: "legacy" }),
  });
  expect(button("settings-back").textContent).toBe("Back to x");
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "legacy",
  );
  fireEvent.keyDown(screen.getByTestId("settings-default-namespace"), {
    key: "Enter",
  });
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "From the kubeconfig",
    "default",
    "shop",
    "legacy",
  ]);
  fireEvent.click(screen.getByRole("option", { name: "shop" }));
  await act(flush);
  await save();
  expect(savedPayload(backend)?.defaultNamespace).toBe("shop");
});

test("the back button opens the cluster's Overview", async () => {
  await show();
  fireEvent.click(button("settings-back"));
  expect(screen.getByText("overview page")).toBeTruthy();
});

test("Prometheus or Mimir shows Scheme, Path prefix, Tenant and the Cluster label after Port, mono, with their placeholders", async () => {
  await show({ saved: SAVED_MIMIR });
  const order = [...PROM_FIELDS, "settings-prom-scheme", ...MIMIR_FIELDS];
  const inPage = Array.from(document.querySelectorAll("[data-testid]"))
    .map((e) => e.getAttribute("data-testid") ?? "")
    .filter((id) => order.includes(id));
  expect(inPage).toEqual(order);

  expect(screen.getByRole("radiogroup", { name: "Scheme" })).toBe(
    screen.getByTestId("settings-prom-scheme"),
  );
  expect(screen.getByTestId("settings-prom-scheme").textContent).toBe(
    "HTTPHTTPS",
  );
  expect(screen.getByText("Scheme").classList.contains("fieldLabel")).toBe(
    true,
  );
  expect(input("settings-prom-prefix").parentElement?.textContent).toBe(
    "Path prefix",
  );
  expect(input("settings-prom-tenant").parentElement?.textContent).toBe(
    "Tenant",
  );
  expect(MIMIR_FIELDS.map((id) => input(id).placeholder)).toEqual([
    "/prometheus for Mimir",
    "X-Scope-OrgID, empty for none",
    "cluster",
    "prod",
  ]);
  for (const id of MIMIR_FIELDS) {
    expect([id, input(id).classList.contains("mono")]).toEqual([id, true]);
  }
  const pair = screen.getByRole("group", { name: "Cluster label" });
  expect(pair.textContent).toBe("Cluster label=");
  expect(
    within(pair).getByRole("textbox", { name: "Cluster label name" }),
  ).toBe(input("settings-prom-label-name"));
  expect(
    within(pair).getByRole("textbox", { name: "Cluster label value" }),
  ).toBe(input("settings-prom-label-value"));
});

test("a saved Mimir fills every field and selects HTTPS", async () => {
  await show({ saved: SAVED_MIMIR });
  expect(promFields()).toEqual(["mimir", "mimir-gateway", "80"]);
  expect(scheme("https").checked).toBe(true);
  expect(scheme("http").checked).toBe(false);
  expect(mimirFields()).toEqual(["/prometheus", "team-a", "cluster", "prod"]);
  expect(status()).toBe("");
});

test("picking Prometheus or Mimir from another provider starts at HTTP with the new fields empty", async () => {
  await show({ saved: FULL });
  pickProvider("prometheus");
  expect(promFields()).toEqual([
    "observability",
    "prometheus-operated",
    "9090",
  ]);
  expect(scheme("http").checked).toBe(true);
  expect(mimirFields()).toEqual(["", "", "", ""]);
});

test("the path prefix, tenant and label show the core's errors under them and block Save", async () => {
  await show({ saved: SAVED_MIMIR });
  type("settings-prom-prefix", "prometheus");
  type("settings-prom-tenant", "team|b");
  type("settings-prom-label-name", "__name__");
  expect(errorOf("settings-prom-prefix")).toBe(
    "The path prefix must be a path such as /prometheus.",
  );
  expect(errorOf("settings-prom-tenant")).toBe(
    "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters.",
  );
  expect(errorOf("settings-prom-label-name")).toBe(
    "A label name is letters, digits and _, and does not start with __.",
  );
  expect(errorOf("settings-prom-label-value")).toBeNull();
  expect(status()).toBe("Fix the fields marked in red to save.");
  expect(button("settings-save").disabled).toBe(true);

  type("settings-prom-label-name", "cluster");
  type("settings-prom-label-value", "");
  expect(errorOf("settings-prom-label-name")).toBeNull();
  expect(errorOf("settings-prom-label-value")).toBe(
    "A cluster label needs a name and a value.",
  );
  type("settings-prom-label-value", "v".repeat(1025));
  expect(errorOf("settings-prom-label-value")).toBe(
    "A label value is at most 1024 characters.",
  );
});

test("Restore defaults empties the scheme, path prefix, tenant and label too", async () => {
  await show({ saved: SAVED_MIMIR });
  fireEvent.click(button("settings-restore"));
  expect(radio("auto").checked).toBe(true);
  pickProvider("prometheus");
  expect(scheme("http").checked).toBe(true);
  expect(promFields()).toEqual(["", "", ""]);
  expect(mimirFields()).toEqual(["", "", "", ""]);
});

test("Save sends the scheme, path prefix, tenant and label as the core saves them", async () => {
  const backend = await show({ saved: FULL });
  pickProvider("prometheus");
  type("settings-prom-namespace", "mimir");
  type("settings-prom-service", "mimir-gateway");
  type("settings-prom-port", "80");
  fireEvent.click(scheme("https"));
  type("settings-prom-prefix", " /prometheus/ ");
  type("settings-prom-tenant", " team-a ");
  type("settings-prom-label-name", " cluster ");
  type("settings-prom-label-value", "prod");
  await save();
  expect(savedPayload(backend)?.metricsProvider).toEqual(
    SAVED_MIMIR.metricsProvider,
  );
});

test("the new fields are labelled and spaced like the others, and the label pair wraps under a narrow window", () => {
  const decls = (file: string, selector: string) =>
    cssRules(CSS_FILES[file] ?? "").find((r) => r.selector === selector)
      ?.decls ?? [];
  const screenCss = "/src/features/settings/ClusterSettingsScreen.module.css";
  const inputCss = "/src/design/Input.module.css";
  expect(decls(screenCss, ".fieldLabel")).toEqual(decls(inputCss, ".label"));
  expect(decls(screenCss, ".schemeField")).toEqual(decls(inputCss, ".field"));
  expect(Object.fromEntries(decls(screenCss, ".labelPair"))).toMatchObject({
    "grid-column": "1 / -1",
    "min-width": "0",
  });
  expect(Object.fromEntries(decls(screenCss, ".labelRow"))).toMatchObject({
    display: "flex",
    "flex-wrap": "wrap",
  });
  expect(Object.fromEntries(decls(screenCss, ".labelPart"))).toEqual({
    flex: "1 1 160px",
    "min-width": "0",
  });
  expect(
    Object.fromEntries(decls(screenCss, ".promGrid"))["grid-template-columns"],
  ).toBe("repeat(auto-fit, minmax(160px, 1fr))");
});

test("Save drops the answers read under the old settings", async () => {
  const key = queryKey("id-x", { kind: "cluster" }, "1h");
  useMetrics.setState({
    queries: {
      [key]: { value: metricsResult({}), error: null, loading: false },
    },
  });
  await show();
  type("settings-terminal-cwd", "/srv");
  await save();
  expect(useMetrics.getState().queries[key]).toBeUndefined();
});

const SAVED_URL = clusterSettings({
  metricsProvider: {
    kind: "remote",
    url: "https://mimir.example.com/prometheus",
    tenant: "team-a",
    matcher: { name: "cluster", value: "prod" },
    auth: { kind: "basic", username: "me" },
    caPath: "/etc/ssl/team-ca.pem",
  },
});
const URL_FIELDS = [
  "settings-remote-url",
  "settings-remote-tenant",
  "settings-remote-label-name",
  "settings-remote-label-value",
];
const urlFields = () => URL_FIELDS.map((id) => input(id).value);
const KEYCHAIN_DOWN =
  "The system keychain is not available (no Secret Service). Use a client certificate or no authentication.";

const authOption = (kind: string) =>
  screen
    .getByTestId(`settings-remote-auth-${kind}`)
    .querySelector("input") as HTMLInputElement;

function pickAuth(kind: string): void {
  fireEvent.click(authOption(kind));
}

/** The test ids of the URL option's fields, in page order. */
function urlOptionIds(): string[] {
  return Array.from(document.querySelectorAll("[data-testid]"))
    .map((e) => e.getAttribute("data-testid") ?? "")
    .filter(
      (id) =>
        id.startsWith("settings-remote-") &&
        !/-(none|basic|bearer|mtls)$/.test(id),
    );
}

test("a Prometheus-compatible URL shows URL, Tenant, the Cluster label and Authentication, empty and with None, then each choice's fields", async () => {
  const backend = await show({ saved: FULL });
  pickProvider("remote");
  expect(radio("remote").checked).toBe(true);
  expect(urlFields()).toEqual(["", "", "", ""]);
  expect(authOption("none").checked).toBe(true);
  expect(urlOptionIds()).toEqual([
    ...URL_FIELDS,
    "settings-remote-auth",
    "settings-remote-ca",
    "settings-remote-ca-choose",
  ]);
  expect(screen.getByRole("radiogroup", { name: "Authentication" })).toBe(
    screen.getByTestId("settings-remote-auth"),
  );
  expect(screen.getByTestId("settings-remote-auth").textContent).toBe(
    "NoneBasicBearerClient certificate",
  );
  expect(URL_FIELDS.map((id) => input(id).placeholder)).toEqual([
    "https://mimir.example.com/prometheus",
    "X-Scope-OrgID, empty for none",
    "cluster",
    "prod",
  ]);
  for (const id of [...URL_FIELDS, "settings-remote-ca"]) {
    expect([id, input(id).classList.contains("mono")]).toEqual([id, true]);
  }
  expect(screen.getByLabelText("URL")).toBe(input("settings-remote-url"));
  expect(screen.getByLabelText("Tenant")).toBe(input("settings-remote-tenant"));
  expect(screen.getByLabelText("CA file")).toBe(input("settings-remote-ca"));
  expect(button("settings-remote-ca-choose").textContent).toBe("Choose…");

  pickAuth("basic");
  expect(urlOptionIds().slice(5)).toEqual([
    "settings-remote-username",
    "settings-remote-password",
    "settings-remote-ca",
    "settings-remote-ca-choose",
  ]);
  expect(screen.getByLabelText("Username")).toBe(
    input("settings-remote-username"),
  );
  expect(screen.getByLabelText("Password")).toBe(
    input("settings-remote-password"),
  );
  expect(input("settings-remote-password").type).toBe("password");

  pickAuth("bearer");
  expect(urlOptionIds().slice(5)).toEqual([
    "settings-remote-token",
    "settings-remote-ca",
    "settings-remote-ca-choose",
  ]);
  expect(screen.getByLabelText("Token")).toBe(input("settings-remote-token"));
  expect(input("settings-remote-token").type).toBe("password");

  pickAuth("mtls");
  expect(urlOptionIds().slice(5)).toEqual([
    "settings-remote-cert",
    "settings-remote-cert-choose",
    "settings-remote-key",
    "settings-remote-key-choose",
    "settings-remote-ca",
    "settings-remote-ca-choose",
  ]);
  expect(screen.getByLabelText("Certificate file")).toBe(
    input("settings-remote-cert"),
  );
  expect(screen.getByLabelText("Key file")).toBe(input("settings-remote-key"));

  // Only a saved Basic or Bearer setting asks the keychain.
  expect(backend.callsTo("metrics_secret_saved")).toEqual([]);
});

test("Choose… fills a file field from the file picker", async () => {
  const backend = await show({
    handlers: { "plugin:dialog|open": () => "/pki/me.crt" },
  });
  pickProvider("remote");
  pickAuth("mtls");
  fireEvent.click(button("settings-remote-cert-choose"));
  await act(flush);
  expect(input("settings-remote-cert").value).toBe("/pki/me.crt");
  expect(backend.callsTo("plugin:dialog|open")).toHaveLength(1);
});

test("a saved URL fills every field; the password field is empty and says the keychain holds it, and stays so on Save", async () => {
  const backend = await show({
    saved: SAVED_URL,
    handlers: { metrics_secret_saved: () => true },
  });
  expect(backend.callsTo("metrics_secret_saved")).toEqual([
    { clusterId: "id-x" },
  ]);
  expect(radio("remote").checked).toBe(true);
  expect(urlFields()).toEqual([
    "https://mimir.example.com/prometheus",
    "team-a",
    "cluster",
    "prod",
  ]);
  expect(authOption("basic").checked).toBe(true);
  expect(input("settings-remote-username").value).toBe("me");
  expect(input("settings-remote-ca").value).toBe("/etc/ssl/team-ca.pem");
  expect(input("settings-remote-password").value).toBe("");
  expect(input("settings-remote-password").placeholder).toBe(
    "Saved in the keychain",
  );
  expect(errorOf("settings-remote-password")).toBeNull();
  expect(status()).toBe("");

  type("settings-remote-tenant", "team-b");
  await save();
  expect(backend.callsTo("metrics_secret_set")).toEqual([]);
  expect(savedPayload(backend)?.metricsProvider).toEqual({
    ...SAVED_URL.metricsProvider,
    tenant: "team-b",
  });
});

test("with no secret saved, Basic blocks Save until the password is typed", async () => {
  await show({
    saved: SAVED_URL,
    handlers: { metrics_secret_saved: () => false },
  });
  expect(input("settings-remote-password").placeholder).toBe("");
  expect(errorOf("settings-remote-password")).toBe("Enter the password.");
  type("settings-remote-tenant", "team-b");
  expect(status()).toBe("Fix the fields marked in red to save.");
  expect(button("settings-save").disabled).toBe(true);

  type("settings-remote-password", "s3cret");
  expect(errorOf("settings-remote-password")).toBeNull();
  expect(button("settings-save").disabled).toBe(false);
});

test("Basic's saved password is not Bearer's token, and a typed password does not carry over", async () => {
  await show({
    saved: SAVED_URL,
    handlers: { metrics_secret_saved: () => true },
  });
  type("settings-remote-password", "typed");
  pickAuth("bearer");
  expect(input("settings-remote-token").value).toBe("");
  expect(input("settings-remote-token").placeholder).toBe("");
  expect(errorOf("settings-remote-token")).toBe("Enter the token.");
  expect(button("settings-save").disabled).toBe(true);
});

test("Save writes the typed secret first, then the settings, and forgets the typed secret", async () => {
  const backend = await show({
    saved: FULL,
    handlers: {
      metrics_secret_set: () => null,
      metrics_secret_saved: () => true,
    },
  });
  pickProvider("remote");
  type("settings-remote-url", " https://mimir.example.com/prometheus/ ");
  type("settings-remote-tenant", " team-a ");
  pickAuth("bearer");
  type("settings-remote-token", "t0ken");
  expect(button("settings-save").disabled).toBe(false);
  await save();
  await act(flush);

  const writes = backend.calls.filter((c) =>
    ["metrics_secret_set", "cluster_settings_set"].includes(c.cmd),
  );
  expect(writes).toEqual([
    {
      cmd: "metrics_secret_set",
      args: {
        clusterId: "id-x",
        secret: "t0ken",
        provider: expect.objectContaining({
          kind: "remote",
          auth: { kind: "bearer" },
        }),
      },
    },
    {
      cmd: "cluster_settings_set",
      args: {
        id: "id-x",
        settings: {
          ...FULL,
          metricsProvider: {
            kind: "remote",
            url: "https://mimir.example.com/prometheus",
            tenant: "team-a",
            matcher: null,
            auth: { kind: "bearer" },
            caPath: null,
          },
        },
      },
    },
  ]);
  expect(input("settings-remote-token").value).toBe("");
  expect(input("settings-remote-token").placeholder).toBe(
    "Saved in the keychain",
  );
  expect(errorOf("settings-remote-token")).toBeNull();
  expect(status()).toBe(
    "Saved. Changes apply at once; the proxy applies on the next connect.",
  );
  expect(keptDraft("id-x")).toBeUndefined();

  // A new token alone is a change, and replaces the saved one.
  type("settings-remote-token", "t0ken-2");
  expect(status()).toBe("Unsaved changes.");
  await save();
  expect(backend.callsTo("metrics_secret_set")).toEqual([
    {
      clusterId: "id-x",
      secret: "t0ken",
      provider: expect.objectContaining({ kind: "remote" }),
    },
    {
      clusterId: "id-x",
      secret: "t0ken-2",
      provider: expect.objectContaining({ kind: "remote" }),
    },
  ]);
});

test("a keychain that refuses the secret stops the save, toasts its error and keeps the draft", async () => {
  const error = vi.spyOn(toast, "error");
  const backend = await show({
    saved: FULL,
    handlers: {
      metrics_secret_set: () => {
        throw { code: "Unreachable", message: KEYCHAIN_DOWN, details: null };
      },
    },
  });
  pickProvider("remote");
  type("settings-remote-url", "https://mimir.example.com/prometheus");
  pickAuth("basic");
  type("settings-remote-username", "me");
  type("settings-remote-password", "s3cret");
  await save();
  expect(error).toHaveBeenCalledWith(
    "Could not save the password for x",
    KEYCHAIN_DOWN,
  );
  expect(backend.callsTo("cluster_settings_set")).toEqual([]);
  expect(input("settings-remote-password").value).toBe("s3cret");
  expect(status()).toBe("Unsaved changes.");
  expect(button("settings-save").disabled).toBe(false);
});

test("a file the core refuses with the secret shows under its field and saves nothing", async () => {
  const backend = await show({
    saved: FULL,
    handlers: {
      metrics_secret_set: () => {
        throw {
          code: "InvalidInput",
          message: "The CA file is not there.",
          details: "caPath",
        };
      },
    },
  });
  pickProvider("remote");
  type("settings-remote-url", "https://mimir.example.com/prometheus");
  pickAuth("basic");
  type("settings-remote-username", "me");
  type("settings-remote-password", "s3cret");
  type("settings-remote-ca", "/nope.pem");
  await save();
  expect(errorOf("settings-remote-ca")).toBe("The CA file is not there.");
  expect(backend.callsTo("cluster_settings_set")).toEqual([]);
});

test("the URL, its scheme and the user name show the core's errors under them", async () => {
  await show();
  pickProvider("remote");
  const urlError =
    "The URL must be http:// or https:// with a host, without a user name, query or fragment.";
  expect(errorOf("settings-remote-url")).toBe(urlError);
  type("settings-remote-url", "https://me@mimir.example.com");
  expect(errorOf("settings-remote-url")).toBe(urlError);
  type("settings-remote-url", "http://mimir.example.com");
  expect(errorOf("settings-remote-url")).toBeNull();
  pickAuth("bearer");
  expect(errorOf("settings-remote-url")).toBe(
    "Basic and Bearer credentials need https://, except to localhost.",
  );
  pickAuth("mtls");
  expect(errorOf("settings-remote-url")).toBe(
    "A client certificate needs https://.",
  );
  pickAuth("basic");
  type("settings-remote-url", "http://localhost:9009/prometheus");
  type("settings-remote-username", "me:you");
  expect(errorOf("settings-remote-url")).toBeNull();
  expect(errorOf("settings-remote-username")).toBe(
    "The user name must not be empty or contain ':'.",
  );
  type("settings-remote-tenant", "team|b");
  expect(errorOf("settings-remote-tenant")).toBe(
    "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters.",
  );
  expect(status()).toBe("Fix the fields marked in red to save.");
  expect(button("settings-save").disabled).toBe(true);
});

test("a file the save refuses shows its error under its field, until the field changes", async () => {
  const error = vi.spyOn(toast, "error");
  await show({
    saved: FULL,
    handlers: {
      cluster_settings_set: () => {
        throw {
          code: "InvalidInput",
          message: "/pki/me.crt holds no PEM certificate.",
          details: "certPath",
        };
      },
    },
  });
  pickProvider("remote");
  type("settings-remote-url", "https://mimir.example.com");
  pickAuth("mtls");
  type("settings-remote-cert", "/pki/me.crt");
  type("settings-remote-key", "/pki/me.key");
  await save();
  expect(errorOf("settings-remote-cert")).toBe(
    "/pki/me.crt holds no PEM certificate.",
  );
  expect(errorOf("settings-remote-key")).toBeNull();
  expect(error).not.toHaveBeenCalled();
  // The file may be fixed where it is, so the error does not block another Save.
  expect(button("settings-save").disabled).toBe(false);

  type("settings-remote-cert", "/pki/other.crt");
  expect(errorOf("settings-remote-cert")).toBeNull();
});

test("Restore defaults sets Detect, and the next Save sends it with no secret", async () => {
  const backend = await show({
    saved: SAVED_URL,
    handlers: { metrics_secret_saved: () => true },
  });
  fireEvent.click(button("settings-restore"));
  expect(radio("auto").checked).toBe(true);
  await save();
  expect(backend.callsTo("metrics_secret_set")).toEqual([]);
  expect(savedPayload(backend)?.metricsProvider).toEqual({ kind: "auto" });
});

// Review Focus 1: a password may hold spaces, so the page sends it as typed.
test("a typed password is saved as typed, spaces included", async () => {
  const backend = await show({
    saved: SAVED_URL,
    handlers: {
      metrics_secret_saved: () => false,
      metrics_secret_set: () => null,
    },
  });
  type("settings-remote-password", "  pa ss  ");
  expect(button("settings-save").disabled).toBe(false);
  await save();
  expect(backend.callsTo("metrics_secret_set")).toEqual([
    {
      clusterId: "id-x",
      secret: "  pa ss  ",
      provider: expect.objectContaining({ kind: "remote" }),
    },
  ]);
});

// Review Focus 3: a keychain that cannot be read counts as no saved secret, without a toast.
test("a keychain that cannot be read asks for the password, without a toast", async () => {
  const error = vi.spyOn(toast, "error");
  const backend = await show({
    saved: SAVED_URL,
    handlers: {
      metrics_secret_saved: () => {
        throw { code: "Unreachable", message: KEYCHAIN_DOWN, details: null };
      },
      metrics_secret_set: () => null,
    },
  });
  expect(input("settings-remote-password").placeholder).toBe("");
  expect(errorOf("settings-remote-password")).toBe("Enter the password.");
  expect(error).not.toHaveBeenCalled();

  type("settings-remote-password", "s3cret");
  expect(button("settings-save").disabled).toBe(false);
  await save();
  expect(backend.callsTo("metrics_secret_set")).toEqual([
    {
      clusterId: "id-x",
      secret: "s3cret",
      provider: expect.objectContaining({ kind: "remote" }),
    },
  ]);
  expect(error).not.toHaveBeenCalled();
});

test("an allowed exec command can be stopped from the head", async () => {
  const backend = await show({
    cluster: { execCommand: "aws", execAllowed: true },
    handlers: { cluster_exec_forget: () => null },
  });

  const allowed = within(screen.getByTestId("settings-exec-allowed"));
  expect(allowed.getByText("Allowed to run when you connect.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("settings-exec-forget"));

  await waitFor(() =>
    expect(backend.callsTo("cluster_exec_forget")).toEqual([{ id: "id-x" }]),
  );
});

test("the head offers nothing to stop for an exec command that is not allowed", async () => {
  await show({ cluster: { execCommand: "aws", execAllowed: false } });

  expect(screen.getByTestId("settings-note-exec")).toBeTruthy();
  expect(screen.queryByTestId("settings-exec-allowed")).toBeNull();
});

test("the Agent card saves with the page's draft", async () => {
  const backend = await show({
    state: CONNECTED,
    saved: FULL,
  });
  const card = await screen.findByTestId("settings-agent-card");
  fireEvent.click(within(card).getByRole("radio", { name: /Don't ask/ }));
  expect(
    within(card).getByText(
      "Changes run without asking. Use this only for a cluster you can rebuild.",
    ),
  ).toBeTruthy();
  expect(
    within(card).getByText(/Under Don't ask, an agent that changes workloads/),
  ).toBeTruthy();
  fireEvent.click(
    within(card).getByLabelText("Let the agent run commands in containers"),
  );
  fireEvent.change(within(card).getByLabelText("Notes for the agent"), {
    target: { value: "Use Argo CD." },
  });
  await save();
  expect(savedPayload(backend)).toMatchObject({
    agent: { changes: "dontAsk", exec: true, notes: "Use Argo CD." },
  });
});

test("the terminal switch saves with the page's draft", async () => {
  const backend = await show({ state: CONNECTED, saved: FULL });
  const card = await screen.findByTestId("settings-agent-card");
  const toggle = within(card).getByTestId("settings-agent-terminal");
  expect(toggle.textContent).toContain(
    "Let the agent run commands in a terminal",
  );
  expect(toggle.textContent).toContain(
    "The agent can run any shell command on this computer, in an Agent tab of the dock with this cluster's kubeconfig. Each command counts as a change and follows Changes above.",
  );
  fireEvent.click(within(toggle).getByRole("switch"));
  await save();
  expect(savedPayload(backend)).toMatchObject({
    agent: { terminal: true },
  });
});

test("Read only disables the terminal switch and says why", async () => {
  await show({ state: CONNECTED, saved: FULL });
  const card = await screen.findByTestId("settings-agent-card");
  fireEvent.click(within(card).getByRole("radio", { name: /Read only/ }));
  const toggle = within(card).getByTestId("settings-agent-terminal");
  expect(within(toggle).getByRole("switch").hasAttribute("disabled")).toBe(
    true,
  );
  expect(toggle.textContent).toContain(
    "Read only gives the agent no terminal.",
  );
  expect(toggle.textContent).not.toContain(
    "The agent can run any shell command",
  );
});

test("Only these namespaces needs a namespace before Save", async () => {
  await show({ saved: FULL });
  const card = await screen.findByTestId("settings-agent-card");
  fireEvent.click(
    within(card).getByRole("radio", { name: /Only these namespaces/ }),
  );
  expect(within(card).getByText("Pick at least one namespace.")).toBeTruthy();
  expect(button("settings-save").hasAttribute("disabled")).toBe(true);
});
