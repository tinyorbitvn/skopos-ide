import { failureMessage } from "../../ipc/client";

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

export type TunnelProblems = Partial<
  Record<keyof TunnelFields | "form", string>
>;

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

/** The checks that run once Save was pressed. */
export function checkTunnel(fields: TunnelFields): TunnelProblems {
  const problems: TunnelProblems = {};
  const name = fields.name.trim();
  if (name === "") problems.name = "A name is needed.";
  else if ([...name].length > NAME_MAX) {
    problems.name = `A name has at most ${NAME_MAX} characters.`;
  }
  const url = proxyUrlProblem(fields.url);
  if (url !== null) problems.url = url;
  if ([...fields.username.trim()].some(badUserChar)) {
    problems.username = 'A user name cannot hold ":" or control characters.';
  }
  return problems;
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
  return { form: message };
}
