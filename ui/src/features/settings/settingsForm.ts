import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsProviderSetting } from "../../ipc/generated/MetricsProviderSetting";

/** Detect, Prometheus, metrics-server only or None. */
export type ProviderKind = MetricsProviderSetting["kind"];

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
}

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
  | "promLabelValue";

export type DraftErrors = Partial<Record<DraftField, string>>;

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

export function draftFrom(settings: ClusterSettings): SettingsDraft {
  const provider = settings.metricsProvider;
  const prom = provider.kind === "prometheus" ? provider : null;
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
  };
}

/** Restore defaults: empty fields, no icon, no accessible namespaces, Detect and HTTP. */
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
  };
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
function labelErrors(name: string, value: string): DraftErrors {
  if (name === "" && value === "") return {};
  if (name === "") return { promLabelName: LABEL_PAIR_ERROR };
  if (value === "") return { promLabelValue: LABEL_PAIR_ERROR };
  if (!isLabelName(name)) return { promLabelName: LABEL_NAME_ERROR };
  // Characters as the core counts them: an emoji is one, not two UTF-16 units.
  if (Array.from(value).length > LABEL_VALUE_MAX) {
    return { promLabelValue: LABEL_VALUE_ERROR };
  }
  return {};
}

export function validate(draft: SettingsDraft): DraftErrors {
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
      labelErrors(draft.promLabelName.trim(), draft.promLabelValue),
    );
  }
  return errors;
}

function textOrNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

function providerSetting(draft: SettingsDraft): MetricsProviderSetting {
  switch (draft.provider) {
    case "prometheus": {
      const labelName = draft.promLabelName.trim();
      return {
        kind: "prometheus",
        namespace: draft.promNamespace.trim(),
        service: draft.promService.trim(),
        port: Number(draft.promPort.trim()),
        scheme: draft.promScheme === "https" ? "https" : null,
        pathPrefix: pathPrefixOf(draft.promPrefix),
        tenant: textOrNull(draft.promTenant),
        matcher:
          labelName === "" && draft.promLabelValue === ""
            ? null
            : { name: labelName, value: draft.promLabelValue },
      };
    }
    case "auto":
      return { kind: "auto" };
    case "metricsServer":
      return { kind: "metricsServer" };
    case "none":
      return { kind: "none" };
    case "remote":
      // The page offers no URL option yet, so it never saves one.
      throw new Error(
        "the Settings page cannot save a Prometheus-compatible URL yet",
      );
  }
}

/** The settings to save, normalised as the core saves them: trimmed, empty text as null. */
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
