import { IpcFailure } from "../../ipc/client";
import type { AgentChanges } from "../../ipc/generated/AgentChanges";
import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import type { LabelMatcher } from "../../ipc/generated/LabelMatcher";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsProviderSetting } from "../../ipc/generated/MetricsProviderSetting";
import type { RemoteAuth } from "../../ipc/generated/RemoteAuth";

/** Detect, Prometheus, a Prometheus-compatible URL, metrics-server only or None. */
export type ProviderKind = MetricsProviderSetting["kind"];

/** None, Basic, Bearer or a client certificate (`mtls`). */
export type AuthKind = RemoteAuth["kind"];

/** The authentications whose password or token the keychain keeps (spec I48). */
export type SecretAuth = "basic" | "bearer";

/** HTTP saves no scheme; HTTPS saves "https". */
export type SchemeChoice = "http" | "https";

/** The Settings page's fields as the user types them. */
export interface SettingsDraft {
  displayName: string;
  icon: string | null;
  defaultNamespace: string | null;
  /** As typed: names split by commas and spaces. */
  accessibleNamespaces: string;
  terminalCwd: string;
  nodeShellImage: string;
  proxyUrl: string;
  provider: ProviderKind;
  promNamespace: string;
  promService: string;
  promPort: string;
  promScheme: SchemeChoice;
  promPrefix: string;
  promTenant: string;
  /** The cluster label `name="value"`: the name is trimmed, the value kept as typed. */
  promLabelName: string;
  promLabelValue: string;
  /** The Prometheus-compatible URL's fields; its password or token is never part of the draft. */
  remoteUrl: string;
  remoteTenant: string;
  remoteLabelName: string;
  remoteLabelValue: string;
  remoteAuth: AuthKind;
  remoteUsername: string;
  remoteCert: string;
  remoteKey: string;
  remoteCa: string;
  /** The Agent card: what an agent may change on this cluster. */
  agentChanges: AgentChanges;
  /** "Only these namespaces" is chosen. */
  agentNamespacesOnly: boolean;
  /** The picked namespaces joined with `,`, so drafts compare by value. */
  agentNamespaces: string;
  /** The agent may read Secret values. */
  agentSecretValues: boolean;
  /** The agent may run commands in containers. */
  agentExec: boolean;
  /** The agent new chats start with, or null for the app default. */
  agentDefault: string | null;
  /** Notes sent to the agent at the start of every chat. */
  agentNotes: string;
}

/** The password or token field (spec I57, I58), kept apart from the draft. */
export interface SecretField {
  /** As typed; an empty field keeps the saved secret when `kept`. */
  typed: string;
  /** A secret is saved and the saved setting is `remote` with the draft's authentication. */
  kept: boolean;
}

/** The file fields, whose problems only the save finds (spec I60). */
export type FileField = "remoteCa" | "remoteCert" | "remoteKey";

export type DraftField =
  | "accessibleNamespaces"
  | "nodeShellImage"
  | "proxyUrl"
  | "promNamespace"
  | "promService"
  | "promPort"
  | "promPrefix"
  | "promTenant"
  | "promLabelName"
  | "promLabelValue"
  | "remoteUrl"
  | "remoteTenant"
  | "remoteLabelName"
  | "remoteLabelValue"
  | "remoteUsername"
  | "remoteSecret"
  | "agentNamespaces";

export type DraftErrors = Partial<Record<DraftField, string>>;

export const AGENT_NAMESPACES_ERROR = "Pick at least one namespace.";

export const ICON_MAX_BYTES = 262_144;
export const ICON_ERROR = "Pick a PNG or SVG image up to 256 KB";

/** The core's own texts for the fields it checks (spec I2, I3, I25). */
export const PATH_PREFIX_ERROR =
  "The path prefix must be a path such as /prometheus.";
export const TENANT_ERROR =
  "The tenant may hold only letters, digits and ! - _ . * ' ( ), up to 150 characters.";
export const LABEL_NAME_ERROR =
  "A label name is letters, digits and _, and does not start with __.";
export const LABEL_PAIR_ERROR = "A cluster label needs a name and a value.";
export const LABEL_VALUE_ERROR = "A label value is at most 1024 characters.";
/** The core's texts for the URL and its authentication (spec I32 to I34, I60). */
export const URL_ERROR =
  "The URL must be http:// or https:// with a host, without a user name, query or fragment.";
export const PLAIN_HTTP_ERROR =
  "Basic and Bearer credentials need https://, except to localhost.";
export const MTLS_HTTP_ERROR = "A client certificate needs https://.";
export const USERNAME_ERROR = "The user name must not be empty or contain ':'.";
/** Save with Basic or Bearer and no secret, typed or kept (spec I58). */
export const PASSWORD_ERROR = "Enter the password.";
export const TOKEN_ERROR = "Enter the token.";

/** The Prometheus fields when nothing better is known: the operator's governing Service. */
export const PROMETHEUS_DEFAULTS: Readonly<
  Pick<SettingsDraft, "promNamespace" | "promService" | "promPort">
> = {
  promNamespace: "observability",
  promService: "prometheus-operated",
  promPort: "9090",
};

const ICON_TYPES = ["image/png", "image/svg+xml"];
const ICON_NAME = /\.(png|svg)$/i;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const PROXY_PROTOCOLS = ["http:", "https:", "socks5:"];
const PROXY_ERROR =
  "Use http://, https:// or socks5:// with a host and an optional port";
/** A path prefix character other than `/`: one that needs no escaping in a URL path. */
const PATH_CHAR = /^[A-Za-z0-9._~-]$/;
/** Mimir's tenant ID characters. */
const TENANT_CHARS = /^[A-Za-z0-9!_.*'()-]+$/;
const RESERVED_TENANTS = [".", "..", "__mimir_cluster"];
const TENANT_MAX = 150;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LABEL_VALUE_MAX = 1024;
/** The core's `details` of a file it refuses: the setting's field (spec I35). */
const FILE_FIELDS: Record<string, FileField> = {
  caPath: "remoteCa",
  certPath: "remoteCert",
  keyPath: "remoteKey",
};

export function draftFrom(settings: ClusterSettings): SettingsDraft {
  const provider = settings.metricsProvider;
  const prom = provider.kind === "prometheus" ? provider : null;
  const remote = provider.kind === "remote" ? provider : null;
  const auth = remote?.auth;
  return {
    displayName: settings.displayName ?? "",
    icon: settings.icon,
    defaultNamespace: settings.defaultNamespace,
    accessibleNamespaces: settings.accessibleNamespaces.join(", "),
    terminalCwd: settings.terminalCwd ?? "",
    nodeShellImage: settings.nodeShellImage ?? "",
    proxyUrl: settings.proxyUrl ?? "",
    provider: provider.kind,
    promNamespace: prom?.namespace ?? "",
    promService: prom?.service ?? "",
    promPort: prom ? String(prom.port) : "",
    promScheme: prom?.scheme === "https" ? "https" : "http",
    promPrefix: prom?.pathPrefix ?? "",
    promTenant: prom?.tenant ?? "",
    promLabelName: prom?.matcher?.name ?? "",
    promLabelValue: prom?.matcher?.value ?? "",
    remoteUrl: remote?.url ?? "",
    remoteTenant: remote?.tenant ?? "",
    remoteLabelName: remote?.matcher?.name ?? "",
    remoteLabelValue: remote?.matcher?.value ?? "",
    remoteAuth: auth?.kind ?? "none",
    remoteUsername: auth?.kind === "basic" ? auth.username : "",
    remoteCert: auth?.kind === "mtls" ? auth.certPath : "",
    remoteKey: auth?.kind === "mtls" ? auth.keyPath : "",
    remoteCa: remote?.caPath ?? "",
    agentChanges: settings.agent.changes,
    agentNamespacesOnly: settings.agent.namespaces !== null,
    agentNamespaces: (settings.agent.namespaces ?? []).join(","),
    agentSecretValues: settings.agent.secretValues,
    agentExec: settings.agent.exec,
    agentDefault: settings.agent.defaultAgent,
    agentNotes: settings.agent.notes,
  };
}

/** Restore defaults: empty fields, no icon, no accessible namespaces, Detect, HTTP and None. */
export function emptyDraft(): SettingsDraft {
  return {
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
    agentDefault: null,
    agentNotes: "",
  };
}

/** The picked namespaces, in order. */
export function agentNamespaceList(draft: SettingsDraft): string[] {
  return draft.agentNamespaces === "" ? [] : draft.agentNamespaces.split(",");
}

/** Names split on commas and whitespace, without empty ones or repeats, in order. */
export function splitNamespaces(text: string): string[] {
  const names = new Set<string>();
  for (const part of text.split(/[\s,]+/)) {
    if (part !== "") names.add(part);
  }
  return [...names];
}

/** A DNS-1123 label, as a namespace name is. */
export function isDnsLabel(s: string): boolean {
  return s.length <= 63 && DNS_LABEL.test(s);
}

/** A DNS-1035 label, as a Service name is: it starts with a letter. */
export function isDns1035Label(s: string): boolean {
  return s.length <= 63 && DNS_1035_LABEL.test(s);
}

function isPort(s: string): boolean {
  if (!/^\d+$/.test(s)) return false;
  const port = Number(s);
  return port >= 1 && port <= 65535;
}

function isProxyUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return PROXY_PROTOCOLS.includes(url.protocol) && url.hostname !== "";
}

/** The path prefix as the core saves it: trimmed, without trailing `/`; null when empty. */
function pathPrefixOf(text: string): string | null {
  const prefix = text.trim().replace(/\/+$/, "");
  return prefix === "" ? null : prefix;
}

/** The core's `path_prefix_of` rule. */
function isPathPrefix(prefix: string): boolean {
  return (
    prefix.startsWith("/") &&
    Array.from(prefix).every((c) => c === "/" || PATH_CHAR.test(c)) &&
    !prefix.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/** Mimir's tenant ID rules (spec I2), on a trimmed, non-empty tenant. */
function isTenant(tenant: string): boolean {
  return (
    tenant.length <= TENANT_MAX &&
    TENANT_CHARS.test(tenant) &&
    !RESERVED_TENANTS.includes(tenant)
  );
}

/** A Prometheus label name that is not reserved (spec I3). */
function isLabelName(name: string): boolean {
  return LABEL_NAME.test(name) && !name.startsWith("__");
}

/** The cluster label's error, under the field that has to change, in the core's order. */
function labelErrors(
  name: string,
  value: string,
  [nameField, valueField]: [DraftField, DraftField],
): DraftErrors {
  if (name === "" && value === "") return {};
  if (name === "") return { [nameField]: LABEL_PAIR_ERROR };
  if (value === "") return { [valueField]: LABEL_PAIR_ERROR };
  if (!isLabelName(name)) return { [nameField]: LABEL_NAME_ERROR };
  // Characters as the core counts them: an emoji is one, not two UTF-16 units.
  if (Array.from(value).length > LABEL_VALUE_MAX) {
    return { [valueField]: LABEL_VALUE_ERROR };
  }
  return {};
}

/** The URL as the core saves it: trimmed, without trailing `/` (spec I32). */
function remoteUrlOf(text: string): string {
  return text.trim().replace(/\/+$/, "");
}

/**
 * The URL when the core accepts it (spec I32): http or https with a host, and no user
 * info, query or fragment. `?` and `#` start a query and a fragment even when empty.
 */
function parseRemoteUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const accepted =
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    !/[?#]/.test(text);
  return accepted ? url : null;
}

/** localhost, an address in 127.0.0.0/8 or ::1, as the URL parser writes them (spec I33). */
function isLoopback(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname) ||
    url.hostname === "[::1]"
  );
}

/** The URL option's errors, each under its field (spec I32 to I34, I58). */
function remoteErrors(draft: SettingsDraft, secret: SecretField): DraftErrors {
  const errors: DraftErrors = {};
  const auth = draft.remoteAuth;
  const url = parseRemoteUrl(remoteUrlOf(draft.remoteUrl));
  const https = url?.protocol === "https:";
  if (url === null) {
    errors.remoteUrl = URL_ERROR;
  } else if (
    (auth === "basic" || auth === "bearer") &&
    !https &&
    !isLoopback(url)
  ) {
    errors.remoteUrl = PLAIN_HTTP_ERROR;
  } else if (auth === "mtls" && !https) {
    errors.remoteUrl = MTLS_HTTP_ERROR;
  }
  const tenant = draft.remoteTenant.trim();
  if (tenant !== "" && !isTenant(tenant)) errors.remoteTenant = TENANT_ERROR;
  Object.assign(
    errors,
    labelErrors(draft.remoteLabelName.trim(), draft.remoteLabelValue, [
      "remoteLabelName",
      "remoteLabelValue",
    ]),
  );
  const username = draft.remoteUsername.trim();
  if (auth === "basic" && (username === "" || username.includes(":"))) {
    errors.remoteUsername = USERNAME_ERROR;
  }
  if (draftSecretAuth(draft) !== null && secret.typed === "" && !secret.kept) {
    errors.remoteSecret = auth === "basic" ? PASSWORD_ERROR : TOKEN_ERROR;
  }
  return errors;
}

/** The authentication whose password or token the keychain keeps for `setting`, or null. */
export function secretAuthOf(
  setting: MetricsProviderSetting,
): SecretAuth | null {
  if (setting.kind !== "remote") return null;
  const { kind } = setting.auth;
  return kind === "basic" || kind === "bearer" ? kind : null;
}

/** What the draft's secret field is for: Basic's password, Bearer's token, or nothing. */
export function draftSecretAuth(draft: SettingsDraft): SecretAuth | null {
  if (draft.provider !== "remote") return null;
  const auth = draft.remoteAuth;
  return auth === "basic" || auth === "bearer" ? auth : null;
}

/**
 * Whether an empty secret field keeps the saved secret (spec I58): one is saved, and the
 * saved setting is `remote` with the draft's authentication. Basic's password is never
 * Bearer's token.
 */
export function keepsSecret(
  saved: MetricsProviderSetting,
  draft: SettingsDraft,
  secretSaved: boolean,
): boolean {
  const auth = draftSecretAuth(draft);
  return secretSaved && auth !== null && secretAuthOf(saved) === auth;
}

/** The file field a refused save names in its details (spec I35, I60), or null. */
export function fileFieldOf(error: unknown): FileField | null {
  if (!(error instanceof IpcFailure) || error.code !== "InvalidInput") {
    return null;
  }
  return FILE_FIELDS[error.details ?? ""] ?? null;
}

/** The fields' errors; `secret` is the password or token field, which the draft leaves out. */
export function validate(
  draft: SettingsDraft,
  secret: SecretField = { typed: "", kept: false },
): DraftErrors {
  const errors: DraftErrors = {};
  const bad = splitNamespaces(draft.accessibleNamespaces).filter(
    (name) => !isDnsLabel(name),
  );
  if (bad.length > 0) {
    errors.accessibleNamespaces = `Not a namespace name: ${bad.join(", ")}`;
  }
  if (/\s/.test(draft.nodeShellImage.trim())) {
    errors.nodeShellImage = "An image reference, such as alpine:3.22";
  }
  const proxy = draft.proxyUrl.trim();
  if (proxy !== "" && !isProxyUrl(proxy)) errors.proxyUrl = PROXY_ERROR;
  if (draft.provider === "prometheus") {
    if (!isDnsLabel(draft.promNamespace.trim())) {
      errors.promNamespace = "A namespace name";
    }
    if (!isDns1035Label(draft.promService.trim())) {
      errors.promService = "A Service name";
    }
    if (!isPort(draft.promPort.trim())) {
      errors.promPort = "A port from 1 to 65535";
    }
    const prefix = pathPrefixOf(draft.promPrefix);
    if (prefix !== null && !isPathPrefix(prefix)) {
      errors.promPrefix = PATH_PREFIX_ERROR;
    }
    const tenant = draft.promTenant.trim();
    if (tenant !== "" && !isTenant(tenant)) errors.promTenant = TENANT_ERROR;
    Object.assign(
      errors,
      labelErrors(draft.promLabelName.trim(), draft.promLabelValue, [
        "promLabelName",
        "promLabelValue",
      ]),
    );
  }
  if (draft.provider === "remote") {
    Object.assign(errors, remoteErrors(draft, secret));
  }
  if (draft.agentNamespacesOnly && agentNamespaceList(draft).length === 0) {
    errors.agentNamespaces = AGENT_NAMESPACES_ERROR;
  }
  return errors;
}

function textOrNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/** The cluster label as the core saves it: the name trimmed, null when both are empty. */
function matcherOf(name: string, value: string): LabelMatcher | null {
  const trimmed = name.trim();
  return trimmed === "" && value === "" ? null : { name: trimmed, value };
}

function remoteAuthOf(draft: SettingsDraft): RemoteAuth {
  switch (draft.remoteAuth) {
    case "none":
      return { kind: "none" };
    case "basic":
      return { kind: "basic", username: draft.remoteUsername.trim() };
    case "bearer":
      return { kind: "bearer" };
    case "mtls":
      return {
        kind: "mtls",
        certPath: draft.remoteCert.trim(),
        keyPath: draft.remoteKey.trim(),
      };
  }
}

function providerSetting(draft: SettingsDraft): MetricsProviderSetting {
  switch (draft.provider) {
    case "prometheus":
      return {
        kind: "prometheus",
        namespace: draft.promNamespace.trim(),
        service: draft.promService.trim(),
        port: Number(draft.promPort.trim()),
        scheme: draft.promScheme === "https" ? "https" : null,
        pathPrefix: pathPrefixOf(draft.promPrefix),
        tenant: textOrNull(draft.promTenant),
        matcher: matcherOf(draft.promLabelName, draft.promLabelValue),
      };
    case "remote":
      return {
        kind: "remote",
        url: remoteUrlOf(draft.remoteUrl),
        tenant: textOrNull(draft.remoteTenant),
        matcher: matcherOf(draft.remoteLabelName, draft.remoteLabelValue),
        auth: remoteAuthOf(draft),
        caPath: textOrNull(draft.remoteCa),
      };
    case "auto":
      return { kind: "auto" };
    case "metricsServer":
      return { kind: "metricsServer" };
    case "none":
      return { kind: "none" };
  }
}

/**
 * The settings to save, normalised as the core saves them: trimmed, empty text as null.
 * The Agent card's fields become the cluster's `agent` settings.
 */
export function settingsFrom(draft: SettingsDraft): ClusterSettings {
  return {
    displayName: textOrNull(draft.displayName),
    icon: draft.icon,
    defaultNamespace: draft.defaultNamespace,
    accessibleNamespaces: splitNamespaces(draft.accessibleNamespaces),
    terminalCwd: textOrNull(draft.terminalCwd),
    proxyUrl: textOrNull(draft.proxyUrl),
    nodeShellImage: textOrNull(draft.nodeShellImage),
    metricsProvider: providerSetting(draft),
    agent: {
      changes: draft.agentChanges,
      namespaces: draft.agentNamespacesOnly ? agentNamespaceList(draft) : null,
      secretValues: draft.agentSecretValues,
      exec: draft.agentExec,
      defaultAgent: draft.agentDefault,
      notes: draft.agentNotes,
    },
  };
}

export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return (Object.keys(a) as (keyof SettingsDraft)[]).every(
    (key) => a[key] === b[key],
  );
}

/** What the Prometheus fields start with: the detected Prometheus, else the defaults. */
export function prometheusPrefill(
  detected: MetricsProvider | null | undefined,
): Pick<SettingsDraft, "promNamespace" | "promService" | "promPort"> {
  if (detected?.kind === "prometheus") {
    return {
      promNamespace: detected.namespace,
      promService: detected.service,
      promPort: String(detected.port),
    };
  }
  return { ...PROMETHEUS_DEFAULTS };
}

/** Why an icon file is refused, or null when it is a PNG or SVG of at most 256 KB. */
export function checkIconFile(file: {
  type: string;
  name: string;
  size: number;
}): string | null {
  const image =
    file.type === ""
      ? ICON_NAME.test(file.name)
      : ICON_TYPES.includes(file.type);
  return image && file.size <= ICON_MAX_BYTES ? null : ICON_ERROR;
}

export function statusText(
  errors: DraftErrors,
  changed: boolean,
  justSaved: boolean,
): string {
  if (Object.keys(errors).length > 0) {
    return "Fix the fields marked in red to save.";
  }
  if (changed) return "Unsaved changes.";
  if (justSaved) {
    return "Saved. Changes apply at once; the proxy applies on the next connect.";
  }
  return "";
}
