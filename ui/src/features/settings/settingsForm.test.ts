import { expect, test } from "vitest";
import { IpcFailure } from "../../ipc/client";
import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import type { MetricsProviderSetting } from "../../ipc/generated/MetricsProviderSetting";
import { clusterSettings, prometheus } from "../../test/metrics";
import {
  checkIconFile,
  draftFrom,
  draftSecretAuth,
  emptyDraft,
  fileFieldOf,
  ICON_ERROR,
  ICON_MAX_BYTES,
  isDns1035Label,
  isDnsLabel,
  keepsSecret,
  LABEL_NAME_ERROR,
  LABEL_PAIR_ERROR,
  LABEL_VALUE_ERROR,
  MTLS_HTTP_ERROR,
  PASSWORD_ERROR,
  PATH_PREFIX_ERROR,
  PLAIN_HTTP_ERROR,
  PROMETHEUS_DEFAULTS,
  prometheusPrefill,
  type SettingsDraft,
  sameDraft,
  secretAuthOf,
  settingsFrom,
  splitNamespaces,
  statusText,
  TENANT_ERROR,
  TOKEN_ERROR,
  URL_ERROR,
  USERNAME_ERROR,
  validate,
} from "./settingsForm";

const SAVED: ClusterSettings = clusterSettings({
  displayName: "Prod",
  icon: "data:image/png;base64,AAAA",
  defaultNamespace: "shop",
  accessibleNamespaces: ["shop", "default"],
  terminalCwd: "/srv/work",
  proxyUrl: "http://proxy.example:3128",
  nodeShellImage: "alpine:3.22",
  metricsProvider: { kind: "metricsServer" },
});

const SAVED_MIMIR: ClusterSettings = clusterSettings({
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

/** A draft with a valid Prometheus-compatible URL picked, plus `over`. */
function url(over: Partial<SettingsDraft> = {}): SettingsDraft {
  return draft({
    provider: "remote",
    remoteUrl: "https://mimir.example.com/prometheus",
    ...over,
  });
}

/** No secret typed and none kept. */
const NO_SECRET = { typed: "", kept: false };

/** A draft with a valid Prometheus picked, plus `over`. */
function prom(over: Partial<SettingsDraft> = {}): SettingsDraft {
  return draft({
    provider: "prometheus",
    promNamespace: "mimir",
    promService: "mimir-gateway",
    promPort: "80",
    ...over,
  });
}

function draft(over: Partial<SettingsDraft> = {}): SettingsDraft {
  return { ...emptyDraft(), ...over };
}

test("a draft shows the saved settings as text, and saving it gives them back", () => {
  const d = draftFrom(SAVED);
  expect(d).toEqual({
    displayName: "Prod",
    icon: "data:image/png;base64,AAAA",
    defaultNamespace: "shop",
    accessibleNamespaces: "shop, default",
    terminalCwd: "/srv/work",
    nodeShellImage: "alpine:3.22",
    proxyUrl: "http://proxy.example:3128",
    provider: "metricsServer",
    promNamespace: "",
    promService: "",
    promPort: "",
    promScheme: "http",
    promPrefix: "",
    promTenant: "",
    promLabelName: "",
    promLabelValue: "",
    remoteUrl: "",
    remoteTenant: "",
    remoteLabelName: "",
    remoteLabelValue: "",
    remoteAuth: "none",
    remoteUsername: "",
    remoteCert: "",
    remoteKey: "",
    remoteCa: "",
    agentChanges: "ask",
    agentNamespacesOnly: false,
    agentNamespaces: "",
    agentSecretValues: false,
    agentExec: false,
    agentTerminal: false,
    agentDefault: null,
    agentNotes: "",
  });
  expect(settingsFrom(d)).toEqual(SAVED);
});

test("a saved Prometheus fills the three fields", () => {
  const d = draftFrom(
    clusterSettings({
      metricsProvider: {
        kind: "prometheus",
        namespace: "monitoring",
        service: "prometheus-server",
        port: 80,
        scheme: null,
        pathPrefix: null,
        tenant: null,
        matcher: null,
      },
    }),
  );
  expect([d.provider, d.promNamespace, d.promService, d.promPort]).toEqual([
    "prometheus",
    "monitoring",
    "prometheus-server",
    "80",
  ]);
});

test("empty and blank fields save null, and text is trimmed", () => {
  const out = settingsFrom(
    draft({
      displayName: "  ",
      terminalCwd: "",
      nodeShellImage: " alpine:3.22 ",
      proxyUrl: " ",
    }),
  );
  expect(out.displayName).toBeNull();
  expect(out.terminalCwd).toBeNull();
  expect(out.nodeShellImage).toBe("alpine:3.22");
  expect(out.proxyUrl).toBeNull();
});

test("Restore defaults is an empty draft with no icon, no namespaces and Detect", () => {
  expect(emptyDraft()).toEqual({
    displayName: "",
    icon: null,
    defaultNamespace: null,
    accessibleNamespaces: "",
    terminalCwd: "",
    nodeShellImage: "",
    proxyUrl: "",
    provider: "auto",
    promNamespace: "",
    promService: "",
    promPort: "",
    promScheme: "http",
    promPrefix: "",
    promTenant: "",
    promLabelName: "",
    promLabelValue: "",
    remoteUrl: "",
    remoteTenant: "",
    remoteLabelName: "",
    remoteLabelValue: "",
    remoteAuth: "none",
    remoteUsername: "",
    remoteCert: "",
    remoteKey: "",
    remoteCa: "",
    agentChanges: "ask",
    agentNamespacesOnly: false,
    agentNamespaces: "",
    agentSecretValues: false,
    agentExec: false,
    agentTerminal: false,
    agentDefault: null,
    agentNotes: "",
  });
  expect(settingsFrom(emptyDraft())).toEqual(clusterSettings());
});

test("saving gives the cluster's agent settings back as they were", () => {
  const saved = clusterSettings({
    displayName: "Prod",
    agent: {
      changes: "dontAsk",
      namespaces: ["ingest", "shop"],
      secretValues: true,
      exec: false,
      terminal: false,
      defaultAgent: "codex",
      notes: "Deploys go through Argo CD.",
    },
  });
  expect(settingsFrom(draftFrom(saved))).toEqual(saved);
});

test("the agent fields round-trip through the draft", () => {
  const saved = clusterSettings({
    agent: {
      changes: "dontAsk",
      namespaces: ["payments", "ingest"],
      secretValues: true,
      exec: true,
      terminal: false,
      defaultAgent: "codex",
      notes: "Deploys go through Argo CD.",
    },
  });
  const draft = draftFrom(saved);
  expect(draft).toMatchObject({
    agentChanges: "dontAsk",
    agentNamespacesOnly: true,
    agentNamespaces: "payments,ingest",
    agentSecretValues: true,
    agentExec: true,
    agentDefault: "codex",
    agentNotes: "Deploys go through Argo CD.",
  });
  expect(settingsFrom(draft).agent).toEqual(saved.agent);
});

test("all namespaces saves null, and the defaults restore Ask every time", () => {
  const draft = { ...emptyDraft(), agentNamespaces: "payments" };
  expect(settingsFrom(draft).agent.namespaces).toBeNull();
  expect(settingsFrom(emptyDraft()).agent).toEqual({
    changes: "ask",
    namespaces: null,
    secretValues: false,
    exec: false,
    terminal: false,
    defaultAgent: null,
    notes: "",
  });
});

test("Only these namespaces with none picked blocks Save", () => {
  const draft = {
    ...emptyDraft(),
    agentNamespacesOnly: true,
    agentNamespaces: "",
  };
  expect(validate(draft).agentNamespaces).toBe("Pick at least one namespace.");
  expect(
    validate({ ...draft, agentNamespaces: "payments" }).agentNamespaces,
  ).toBeUndefined();
});

test("accessible namespaces split on commas and spaces, de-duplicate, and name every bad entry", () => {
  expect(splitNamespaces("shop, default  shop,,Bad_NS -x\n")).toEqual([
    "shop",
    "default",
    "Bad_NS",
    "-x",
  ]);
  expect(splitNamespaces(" , ")).toEqual([]);
  expect(
    validate(draft({ accessibleNamespaces: "shop, default  shop,,Bad_NS -x" }))
      .accessibleNamespaces,
  ).toBe("Not a namespace name: Bad_NS, -x");
  expect(
    validate(draft({ accessibleNamespaces: `shop ${"a".repeat(64)}` }))
      .accessibleNamespaces,
  ).toBe(`Not a namespace name: ${"a".repeat(64)}`);
  expect(
    validate(draft({ accessibleNamespaces: "shop,default" }))
      .accessibleNamespaces,
  ).toBeUndefined();
  expect(
    settingsFrom(draft({ accessibleNamespaces: "shop, default shop" }))
      .accessibleNamespaces,
  ).toEqual(["shop", "default"]);
});

test("namespace and Service names follow DNS-1123 and DNS-1035 labels", () => {
  expect(isDnsLabel("a".repeat(63))).toBe(true);
  expect(isDnsLabel("a".repeat(64))).toBe(false);
  expect(isDnsLabel("9shop")).toBe(true);
  expect(isDnsLabel("Shop")).toBe(false);
  expect(isDnsLabel("shop-")).toBe(false);
  expect(isDnsLabel("")).toBe(false);
  expect(isDns1035Label("prometheus-server")).toBe(true);
  expect(isDns1035Label("9prometheus")).toBe(false);
  expect(isDns1035Label("a".repeat(64))).toBe(false);
});

test("a node shell image with whitespace inside is refused", () => {
  expect(
    validate(draft({ nodeShellImage: "alpine 3.22" })).nodeShellImage,
  ).toBe("An image reference, such as alpine:3.22");
  expect(
    validate(draft({ nodeShellImage: " alpine:3.22 " })).nodeShellImage,
  ).toBeUndefined();
  expect(
    validate(draft({ nodeShellImage: "" })).nodeShellImage,
  ).toBeUndefined();
});

test("a proxy with a user and password passes; a scheme-less or ftp proxy fails", () => {
  const error =
    "Use http://, https:// or socks5:// with a host and an optional port";
  const check = (proxyUrl: string) => validate(draft({ proxyUrl })).proxyUrl;
  expect(check("http://user:secret@proxy.example:3128")).toBeUndefined();
  expect(check("https://proxy.example")).toBeUndefined();
  expect(check("socks5://proxy.example:1080")).toBeUndefined();
  expect(check(" http://proxy.example:3128 ")).toBeUndefined();
  expect(check("")).toBeUndefined();
  expect(check("proxy.example:3128")).toBe(error);
  expect(check("ftp://proxy.example")).toBe(error);
  expect(check("http://")).toBe(error);
  expect(check("not a url")).toBe(error);
});

test("port 0 and 65536 fail, 1 and 65535 pass", () => {
  const port = (promPort: string) =>
    validate(
      draft({
        provider: "prometheus",
        promNamespace: "monitoring",
        promService: "prometheus-server",
        promPort,
      }),
    ).promPort;
  expect(port("0")).toBe("A port from 1 to 65535");
  expect(port("65536")).toBe("A port from 1 to 65535");
  expect(port("1")).toBeUndefined();
  expect(port("65535")).toBeUndefined();
  expect(port(" 9090 ")).toBeUndefined();
  expect(port("80a")).toBe("A port from 1 to 65535");
  expect(port("-1")).toBe("A port from 1 to 65535");
  expect(port("")).toBe("A port from 1 to 65535");
});

test("the Prometheus fields are checked only while Prometheus is picked", () => {
  const bad = { promNamespace: "Bad", promService: "9svc", promPort: "0" };
  expect(validate(draft({ provider: "prometheus", ...bad }))).toEqual({
    promNamespace: "A namespace name",
    promService: "A Service name",
    promPort: "A port from 1 to 65535",
  });
  expect(validate(draft({ provider: "auto", ...bad }))).toEqual({});
  expect(validate(emptyDraft())).toEqual({});
});

test("a saved Mimir fills every field, HTTPS stays HTTPS, and saving gives the setting back", () => {
  const d = draftFrom(SAVED_MIMIR);
  expect(d).toMatchObject({
    provider: "prometheus",
    promNamespace: "mimir",
    promService: "mimir-gateway",
    promPort: "80",
    promScheme: "https",
    promPrefix: "/prometheus",
    promTenant: "team-a",
    promLabelName: "cluster",
    promLabelValue: "prod",
  });
  expect(settingsFrom(d)).toEqual(SAVED_MIMIR);
});

test("the Prometheus payload holds each field normalised, filled or empty", () => {
  expect(
    settingsFrom(prom({ promNamespace: " mimir " })).metricsProvider,
  ).toEqual({
    kind: "prometheus",
    namespace: "mimir",
    service: "mimir-gateway",
    port: 80,
    scheme: null,
    pathPrefix: null,
    tenant: null,
    matcher: null,
  });
  expect(
    settingsFrom(
      prom({
        promScheme: "https",
        promPrefix: " /prometheus/ ",
        promTenant: " team-a ",
        promLabelName: " cluster ",
        promLabelValue: " prod ",
      }),
    ).metricsProvider,
  ).toEqual({
    kind: "prometheus",
    namespace: "mimir",
    service: "mimir-gateway",
    port: 80,
    scheme: "https",
    pathPrefix: "/prometheus",
    tenant: "team-a",
    // The value is kept as typed.
    matcher: { name: "cluster", value: " prod " },
  });
  expect(
    settingsFrom(
      prom({ promPrefix: " / ", promTenant: "   ", promLabelName: "  " }),
    ).metricsProvider,
  ).toMatchObject({
    scheme: null,
    pathPrefix: null,
    tenant: null,
    matcher: null,
  });
});

test("path prefix, tenant and cluster label are checked as the core checks them", () => {
  expect([
    PATH_PREFIX_ERROR,
    TENANT_ERROR,
    LABEL_NAME_ERROR,
    LABEL_PAIR_ERROR,
    LABEL_VALUE_ERROR,
  ]).toEqual([
    "The path prefix must be a path such as /prometheus.",
    "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters.",
    "A label name is letters, digits and _, and does not start with __.",
    "A cluster label needs a name and a value.",
    "A label value is at most 1024 characters.",
  ]);
  expect(validate(prom())).toEqual({});

  for (const ok of ["", " / ", "/prometheus", " /a/b-c_d.e~f/ "]) {
    expect([ok, validate(prom({ promPrefix: ok })).promPrefix]).toEqual([
      ok,
      undefined,
    ]);
  }
  for (const bad of [
    "prometheus",
    "/a/../b",
    "/a/./b",
    "/a?b=1",
    "/a%2fb",
    "/a b",
    "/é",
  ]) {
    expect([bad, validate(prom({ promPrefix: bad })).promPrefix]).toEqual([
      bad,
      PATH_PREFIX_ERROR,
    ]);
  }

  for (const ok of ["", "   ", " team-a ", "aZ09!-_.*'()", "t".repeat(150)]) {
    expect([ok, validate(prom({ promTenant: ok })).promTenant]).toEqual([
      ok,
      undefined,
    ]);
  }
  for (const bad of [
    "a|b",
    "team a",
    "team/a",
    "é",
    ".",
    " .. ",
    "__mimir_cluster",
    "t".repeat(151),
  ]) {
    expect([bad, validate(prom({ promTenant: bad })).promTenant]).toEqual([
      bad,
      TENANT_ERROR,
    ]);
  }

  const label = (promLabelName: string, promLabelValue: string) =>
    validate(prom({ promLabelName, promLabelValue }));
  expect(label(" cluster ", " prod ")).toEqual({});
  expect(label("  ", "")).toEqual({});
  expect(label("_x9", "1")).toEqual({});
  // 1024 characters, though each emoji is two UTF-16 units.
  expect(label("cluster", "😀".repeat(1024))).toEqual({});
  expect(label("cluster", "")).toEqual({ promLabelValue: LABEL_PAIR_ERROR });
  expect(label("", "prod")).toEqual({ promLabelName: LABEL_PAIR_ERROR });
  expect(label(" ", "prod")).toEqual({ promLabelName: LABEL_PAIR_ERROR });
  for (const bad of ["9cluster", "clus-ter", "__name__", "__x", "é"]) {
    expect([bad, label(bad, "prod")]).toEqual([
      bad,
      { promLabelName: LABEL_NAME_ERROR },
    ]);
  }
  expect(label("cluster", "v".repeat(1025))).toEqual({
    promLabelValue: LABEL_VALUE_ERROR,
  });

  // Only while Prometheus is picked.
  expect(
    validate(
      draft({
        provider: "auto",
        promPrefix: "x",
        promTenant: "a|b",
        promLabelName: "9",
      }),
    ),
  ).toEqual({});
});

test("the other providers save their kind alone", () => {
  for (const kind of ["auto", "metricsServer", "none"] as const) {
    expect(
      settingsFrom(draft({ provider: kind, promPort: "9090" })).metricsProvider,
    ).toEqual({ kind });
  }
});

test("the Prometheus prefill takes a detected Prometheus, else the defaults", () => {
  expect(
    prometheusPrefill(
      prometheus({ namespace: "mon", service: "prom", port: 9090 }),
    ),
  ).toEqual({ promNamespace: "mon", promService: "prom", promPort: "9090" });
  expect(
    prometheusPrefill({ kind: "metricsServer", chosenBy: "fallback" }),
  ).toEqual(PROMETHEUS_DEFAULTS);
  expect(prometheusPrefill(null)).toEqual({
    promNamespace: "observability",
    promService: "prometheus-operated",
    promPort: "9090",
  });
  expect(prometheusPrefill(undefined)).toEqual(PROMETHEUS_DEFAULTS);
});

test("an icon is a PNG or an SVG of at most 256 KB, by type or by name", () => {
  expect(ICON_MAX_BYTES).toBe(262_144);
  const file = (type: string, name: string, size: number) => ({
    type,
    name,
    size,
  });
  expect(checkIconFile(file("image/png", "a.png", 262_144))).toBeNull();
  expect(checkIconFile(file("image/svg+xml", "a.svg", 10))).toBeNull();
  expect(checkIconFile(file("", "a.SVG", 10))).toBeNull();
  expect(checkIconFile(file("", "a.png", 10))).toBeNull();
  expect(checkIconFile(file("image/png", "a.png", 262_145))).toBe(ICON_ERROR);
  expect(checkIconFile(file("image/jpeg", "a.png", 10))).toBe(ICON_ERROR);
  expect(checkIconFile(file("", "a.jpg", 10))).toBe(ICON_ERROR);
  expect(ICON_ERROR).toBe("Pick a PNG or SVG image up to 256 KB");
});

test("drafts are the same only when every field is", () => {
  expect(sameDraft(draftFrom(SAVED), draftFrom(SAVED))).toBe(true);
  const changes: Partial<SettingsDraft>[] = [
    { displayName: "x" },
    { icon: "x" },
    { defaultNamespace: "x" },
    { accessibleNamespaces: "x" },
    { terminalCwd: "x" },
    { nodeShellImage: "x" },
    { proxyUrl: "x" },
    { provider: "none" },
    { promNamespace: "x" },
    { promService: "x" },
    { promPort: "x" },
    { promScheme: "https" },
    { promPrefix: "x" },
    { promTenant: "x" },
    { promLabelName: "x" },
    { promLabelValue: "x" },
    { remoteUrl: "x" },
    { remoteTenant: "x" },
    { remoteLabelName: "x" },
    { remoteLabelValue: "x" },
    { remoteAuth: "bearer" },
    { remoteUsername: "x" },
    { remoteCert: "x" },
    { remoteKey: "x" },
    { remoteCa: "x" },
    { agentChanges: "readOnly" },
    { agentNamespacesOnly: true },
    { agentNamespaces: "x" },
    { agentSecretValues: true },
    { agentExec: true },
    { agentTerminal: true },
    { agentDefault: "codex" },
    { agentNotes: "x" },
  ];
  // One change per field.
  expect(changes).toHaveLength(Object.keys(emptyDraft()).length);
  for (const change of changes) {
    expect([change, sameDraft(emptyDraft(), draft(change))]).toEqual([
      change,
      false,
    ]);
  }
});

test("the status says what blocks a save, then what is unsaved, then what was saved", () => {
  const errors = { proxyUrl: "bad" };
  expect(statusText(errors, true, true)).toBe(
    "Fix the fields marked in red to save.",
  );
  expect(statusText({}, true, true)).toBe("Unsaved changes.");
  expect(statusText({}, false, true)).toBe(
    "Saved. Changes apply at once; the proxy applies on the next connect.",
  );
  expect(statusText({}, false, false)).toBe("");
});

test("a saved URL fills every field of its authentication, and saving gives the setting back", () => {
  expect(draftFrom(SAVED_URL)).toMatchObject({
    provider: "remote",
    remoteUrl: "https://mimir.example.com/prometheus",
    remoteTenant: "team-a",
    remoteLabelName: "cluster",
    remoteLabelValue: "prod",
    remoteAuth: "basic",
    remoteUsername: "me",
    remoteCert: "",
    remoteKey: "",
    remoteCa: "/etc/ssl/team-ca.pem",
  });
  expect(settingsFrom(draftFrom(SAVED_URL))).toEqual(SAVED_URL);

  const settings: MetricsProviderSetting[] = [
    {
      kind: "remote",
      url: "https://mimir.example.com",
      tenant: null,
      matcher: null,
      auth: { kind: "mtls", certPath: "/pki/me.crt", keyPath: "/pki/me.key" },
      caPath: null,
    },
    {
      kind: "remote",
      url: "http://127.0.0.1:9009/prometheus",
      tenant: null,
      matcher: null,
      auth: { kind: "bearer" },
      caPath: null,
    },
    {
      kind: "remote",
      url: "https://mimir.example.com",
      tenant: null,
      matcher: null,
      auth: { kind: "none" },
      caPath: "/etc/ssl/team-ca.pem",
    },
  ];
  for (const metricsProvider of settings) {
    const saved = clusterSettings({ metricsProvider });
    expect(settingsFrom(draftFrom(saved))).toEqual(saved);
  }
  expect(
    draftFrom(clusterSettings({ metricsProvider: settings[0] })),
  ).toMatchObject({
    remoteAuth: "mtls",
    remoteCert: "/pki/me.crt",
    remoteKey: "/pki/me.key",
  });
});

test("the URL payload holds each field normalised, filled or empty", () => {
  expect(settingsFrom(url()).metricsProvider).toEqual({
    kind: "remote",
    url: "https://mimir.example.com/prometheus",
    tenant: null,
    matcher: null,
    auth: { kind: "none" },
    caPath: null,
  });
  expect(
    settingsFrom(
      url({
        remoteUrl: " https://mimir.example.com/prometheus// ",
        remoteTenant: " team-a ",
        remoteLabelName: " cluster ",
        remoteLabelValue: " prod ",
        remoteAuth: "basic",
        remoteUsername: " me ",
        remoteCa: " /etc/ssl/team-ca.pem ",
      }),
    ).metricsProvider,
  ).toEqual({
    kind: "remote",
    url: "https://mimir.example.com/prometheus",
    tenant: "team-a",
    // The value is kept as typed.
    matcher: { name: "cluster", value: " prod " },
    auth: { kind: "basic", username: "me" },
    caPath: "/etc/ssl/team-ca.pem",
  });
  expect(
    settingsFrom(
      url({
        remoteAuth: "mtls",
        remoteCert: " /pki/me.crt ",
        remoteKey: " /pki/me.key ",
        remoteCa: "  ",
      }),
    ).metricsProvider,
  ).toMatchObject({
    auth: { kind: "mtls", certPath: "/pki/me.crt", keyPath: "/pki/me.key" },
    caPath: null,
  });
  expect(
    settingsFrom(url({ remoteAuth: "bearer", remoteUsername: "me" }))
      .metricsProvider,
  ).toMatchObject({ auth: { kind: "bearer" } });
});

test("the URL, its scheme and the user name are checked as the core checks them", () => {
  expect([
    URL_ERROR,
    PLAIN_HTTP_ERROR,
    MTLS_HTTP_ERROR,
    USERNAME_ERROR,
  ]).toEqual([
    "The URL must be http:// or https:// with a host, without a user name, query or fragment.",
    "Basic and Bearer credentials need https://, except to localhost.",
    "A client certificate needs https://.",
    "The user name must not be empty or contain ':'.",
  ]);
  for (const ok of [
    "https://mimir.example.com/prometheus",
    " https://mimir.example.com/prometheus/ ",
    "http://mimir.example.com:9009",
    "https://[2001:db8::1]:8443/prometheus",
  ]) {
    expect([ok, validate(url({ remoteUrl: ok }))]).toEqual([ok, {}]);
  }
  for (const bad of [
    "",
    "mimir.example.com",
    "ftp://mimir.example.com",
    "https://",
    "https://me@mimir.example.com",
    "https://me:pw@mimir.example.com",
    "https://mimir.example.com/?org=1",
    "https://mimir.example.com/?",
    "https://mimir.example.com/#top",
  ]) {
    expect([bad, validate(url({ remoteUrl: bad }))]).toEqual([
      bad,
      { remoteUrl: URL_ERROR },
    ]);
  }

  const secret = { typed: "s3cret", kept: false };
  const basic = { remoteAuth: "basic", remoteUsername: "me" } as const;
  for (const auth of [basic, { remoteAuth: "bearer" } as const]) {
    expect(
      validate(url({ ...auth, remoteUrl: "http://mimir.example.com" }), secret),
    ).toEqual({ remoteUrl: PLAIN_HTTP_ERROR });
    for (const local of [
      "http://localhost:9009/prometheus",
      "http://127.0.0.1:9009",
      "http://127.4.5.6",
      "http://[::1]:9009",
    ]) {
      expect([
        local,
        validate(url({ ...auth, remoteUrl: local }), secret),
      ]).toEqual([local, {}]);
    }
  }
  expect(validate(url({ remoteUrl: "http://mimir.example.com" }))).toEqual({});
  expect(
    validate(url({ remoteAuth: "mtls", remoteUrl: "http://localhost:9009" })),
  ).toEqual({ remoteUrl: MTLS_HTTP_ERROR });
  // Files are read by the save, not here (spec I60).
  expect(validate(url({ remoteAuth: "mtls" }))).toEqual({});

  for (const bad of ["", "  ", "me:you"]) {
    expect(
      validate(url({ remoteAuth: "basic", remoteUsername: bad }), secret),
    ).toEqual({ remoteUsername: USERNAME_ERROR });
  }
  expect(
    validate(url({ remoteAuth: "basic", remoteUsername: " me " }), secret),
  ).toEqual({});
});

test("the URL's tenant and cluster label follow the Prometheus rules, under their own fields", () => {
  expect(
    validate(
      url({
        remoteTenant: "team|b",
        remoteLabelName: "__name__",
        remoteLabelValue: "x",
      }),
    ),
  ).toEqual({ remoteTenant: TENANT_ERROR, remoteLabelName: LABEL_NAME_ERROR });
  expect(validate(url({ remoteLabelName: "cluster" }))).toEqual({
    remoteLabelValue: LABEL_PAIR_ERROR,
  });
  expect(validate(url({ remoteLabelValue: "prod" }))).toEqual({
    remoteLabelName: LABEL_PAIR_ERROR,
  });
  expect(
    validate(
      url({ remoteLabelName: "cluster", remoteLabelValue: "v".repeat(1025) }),
    ),
  ).toEqual({ remoteLabelValue: LABEL_VALUE_ERROR });
});

test("the URL's fields are checked only while it is picked", () => {
  const bad = {
    remoteUrl: "mimir",
    remoteTenant: "a|b",
    remoteAuth: "basic",
    remoteUsername: "",
  } as const;
  expect(validate(draft({ provider: "auto", ...bad }))).toEqual({});
  expect(validate(prom(bad))).toEqual({});
});

test("Basic and Bearer need the secret typed, unless the same authentication's is saved", () => {
  expect([PASSWORD_ERROR, TOKEN_ERROR]).toEqual([
    "Enter the password.",
    "Enter the token.",
  ]);
  const basic = url({ remoteAuth: "basic", remoteUsername: "me" });
  const bearer = url({ remoteAuth: "bearer" });
  expect(validate(basic)).toEqual({ remoteSecret: PASSWORD_ERROR });
  expect(validate(bearer, NO_SECRET)).toEqual({ remoteSecret: TOKEN_ERROR });
  expect(validate(basic, { typed: "s3cret", kept: false })).toEqual({});
  expect(validate(bearer, { typed: "", kept: true })).toEqual({});
  expect(validate(url({ remoteAuth: "mtls" }), NO_SECRET)).toEqual({});
  expect(validate(url(), NO_SECRET)).toEqual({});

  expect(draftSecretAuth(basic)).toBe("basic");
  expect(draftSecretAuth(bearer)).toBe("bearer");
  expect(draftSecretAuth(url({ remoteAuth: "mtls" }))).toBeNull();
  expect(draftSecretAuth(draft({ remoteAuth: "basic" }))).toBeNull();

  // Basic's saved password is never Bearer's token (spec I58).
  const saved = SAVED_URL.metricsProvider;
  expect(secretAuthOf(saved)).toBe("basic");
  expect(keepsSecret(saved, basic, true)).toBe(true);
  expect(keepsSecret(saved, basic, false)).toBe(false);
  expect(keepsSecret(saved, bearer, true)).toBe(false);
  expect(keepsSecret({ kind: "auto" }, basic, true)).toBe(false);
  expect(secretAuthOf({ kind: "auto" })).toBeNull();
  expect(
    secretAuthOf({
      ...saved,
      auth: { kind: "none" },
    } as MetricsProviderSetting),
  ).toBeNull();
});

test("a file the save refuses names its field in the details", () => {
  const refused = (details: string) =>
    new IpcFailure(
      "InvalidInput",
      "/pki/me.key holds no PEM certificate.",
      details,
    );
  expect(fileFieldOf(refused("caPath"))).toBe("remoteCa");
  expect(fileFieldOf(refused("certPath"))).toBe("remoteCert");
  expect(fileFieldOf(refused("keyPath"))).toBe("remoteKey");
  expect(fileFieldOf(refused("url"))).toBeNull();
  expect(fileFieldOf(new IpcFailure("Internal", "boom", "caPath"))).toBeNull();
  expect(fileFieldOf(new Error("boom"))).toBeNull();
});
