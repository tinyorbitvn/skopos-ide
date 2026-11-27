import { failureMessage } from "../../ipc/client";
import type { TunnelKind } from "../../ipc/generated/TunnelKind";

/** The core's own texts (tunnels spec §5.1), so a refusal reads the same either way. */
export const PROXY_URL_ERROR =
  "Use http://, https:// or socks5:// with a host and an optional port";
export const PROXY_USERINFO_ERROR =
  "Put the user name and password in their own fields";
const NAME_MAX = 64;

export interface TunnelFields {
  name: string;
  url: string;
  username: string;
  password: string;
}

/** The SSH tunnel dialog's fields, as typed (tunnels spec §6.1). */
export interface SshTunnelFields {
  name: string;
  host: string;
  user: string;
  port: string;
  jump: string;
  identityFile: string;
}

export type TunnelProblems = Partial<
  Record<keyof TunnelFields | keyof SshTunnelFields | "form", string>
>;

/** The core's own texts for SSH fields (tunnels spec §6.2). */
export const SSH_HOST_NEEDED = "A host is needed.";
export const SSH_PORT_ERROR = "The port is a number from 1 to 65535.";
export const SSH_IDENTITY_ERROR = "The identity file must be an absolute path.";

/** What is wrong with a proxy URL, or `null`. The core checks it again on save. */
export function proxyUrlProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return PROXY_URL_ERROR;
  }
  if (!["http:", "https:", "socks5:"].includes(url.protocol))
    return PROXY_URL_ERROR;
  if (url.username !== "" || url.password !== "") return PROXY_USERINFO_ERROR;
  const bare = url.pathname === "" || url.pathname === "/";
  if (url.hostname === "" || !bare || url.search !== "" || url.hash !== "") {
    return PROXY_URL_ERROR;
  }
  return null;
}

/** `:` and the characters Rust's `char::is_control` refuses (C0, DEL and C1). */
function badUserChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return char === ":" || code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function nameProblem(text: string): string | null {
  const name = text.trim();
  if (name === "") return "A name is needed.";
  if ([...name].length > NAME_MAX) {
    return `A name has at most ${NAME_MAX} characters.`;
  }
  return null;
}

/** The checks that run once Save was pressed. */
export function checkTunnel(fields: TunnelFields): TunnelProblems {
  const problems: TunnelProblems = {};
  const name = nameProblem(fields.name);
  if (name !== null) problems.name = name;
  const url = proxyUrlProblem(fields.url);
  if (url !== null) problems.url = url;
  if ([...fields.username.trim()].some(badUserChar)) {
    problems.username = 'A user name cannot hold ":" or control characters.';
  }
  return problems;
}

/** Rust's `char::is_whitespace` or `char::is_control`. */
function badSshChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return /\s/u.test(char) || code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** A host, user or jump host ssh would read as an option (spec T5). */
function sshWordProblem(text: string, label: string): string | null {
  if (text.startsWith("-") || [...text].some(badSshChar)) {
    return `${label} cannot start with "-" or hold spaces or control characters.`;
  }
  return null;
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

/** The SSH checks that run once Save was pressed. The core checks them again. */
export function checkSshTunnel(fields: SshTunnelFields): TunnelProblems {
  const problems: TunnelProblems = {};
  const name = nameProblem(fields.name);
  if (name !== null) problems.name = name;
  const host = fields.host.trim();
  const hostProblem =
    host === "" ? SSH_HOST_NEEDED : sshWordProblem(host, "The host");
  if (hostProblem !== null) problems.host = hostProblem;
  const user = sshWordProblem(fields.user.trim(), "The user");
  if (user !== null) problems.user = user;
  const jump = sshWordProblem(fields.jump.trim(), "The jump host");
  if (jump !== null) problems.jump = jump;
  const port = fields.port.trim();
  const portOk =
    /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  if (port !== "" && !portOk) problems.port = SSH_PORT_ERROR;
  if (fields.identityFile !== "" && !isAbsolutePath(fields.identityFile)) {
    problems.identityFile = SSH_IDENTITY_ERROR;
  }
  return problems;
}

/** The kind `tunnel_save` takes. Empty fields are `null`, so `~/.ssh/config` fills them. */
export function sshKindOf(fields: SshTunnelFields): TunnelKind {
  const text = (value: string) => (value.trim() === "" ? null : value.trim());
  const port = fields.port.trim();
  return {
    type: "ssh",
    host: fields.host.trim(),
    user: text(fields.user),
    port: port === "" ? null : Number(port),
    jump: text(fields.jump),
    identityFile: fields.identityFile === "" ? null : fields.identityFile,
  };
}

/** Where a refusal of `tunnel_save` or `tunnel_set_password` shows. */
export function placeTunnelFailure(error: unknown): TunnelProblems {
  const message = failureMessage(error);
  if (message === PROXY_URL_ERROR || message === PROXY_USERINFO_ERROR) {
    return { url: message };
  }
  if (message.startsWith("A user name")) return { username: message };
  if (message.startsWith("A name") || message.startsWith("A tunnel named")) {
    return { name: message };
  }
  if (message.startsWith("Enter a password")) return { password: message };
  if (message === SSH_HOST_NEEDED || message.startsWith("The host cannot")) {
    return { host: message };
  }
  if (message.startsWith("The user cannot")) return { user: message };
  if (message.startsWith("The jump host")) return { jump: message };
  if (message === SSH_PORT_ERROR) return { port: message };
  if (message === SSH_IDENTITY_ERROR) return { identityFile: message };
  return { form: message };
}

/** A row's kind and target: `Proxy · <url>` or `SSH · user@host:port via jump`. */
export function targetText(kind: TunnelKind): string {
  if (kind.type === "proxy") return `Proxy · ${kind.url}`;
  const user = kind.user ? `${kind.user}@` : "";
  const port = kind.port ? `:${kind.port}` : "";
  const via = kind.jump ? ` via ${kind.jump}` : "";
  return `SSH · ${user}${kind.host}${port}${via}`;
}
