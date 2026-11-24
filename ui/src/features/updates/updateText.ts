import type { Release } from "../../ipc/generated/Release";
import type { UpdateState } from "../../ipc/generated/UpdateState";

export const RELEASES = "https://github.com/vanlongme/skopos-ide/releases";
/** Where to download the app by hand. */
export const DOWNLOAD_PAGE = `${RELEASES}/latest`;

/** What a Microsoft Store copy shows instead of update checks (Store spec §3). */
export const STORE_MANAGED_TEXT = "Updates come from the Microsoft Store";

/** The release's page, with its full notes. */
export function releasePage(version: string): string {
  return `${RELEASES}/tag/v${version}`;
}

function counted(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/** "12.4 of 16.0 MB", or "12.4 MB" when the server sent no total. */
export function downloadedText(received: number, total: number | null): string {
  return total === null
    ? `${mb(received)} MB`
    : `${mb(received)} of ${mb(total)} MB`;
}

/** 0 to 100, or null when the total is unknown. */
export function downloadPercent(
  received: number,
  total: number | null,
): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.floor((received / total) * 100));
}

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Nov 25, 2026" from Unix seconds, in UTC like the release page. */
export function releaseDate(seconds: number): string {
  return DATE.format(new Date(seconds * 1000));
}

/** "You have 0.9.0 · Released Nov 25, 2026". */
export function youHaveText(current: string, release: Release): string {
  return release.date === null
    ? `You have ${current}`
    : `You have ${current} · Released ${releaseDate(release.date)}`;
}

/** What a restart ends, such as "2 terminals and 1 port forward will stop."; null for nothing. */
export function willStopText(
  terminals: number,
  forwards: number,
  edits: number,
): string | null {
  const parts = [
    terminals > 0 ? counted(terminals, "terminal") : null,
    forwards > 0 ? counted(forwards, "port forward") : null,
    edits > 0 ? counted(edits, "unsaved edit") : null,
  ].filter((part): part is string => part !== null);
  const last = parts.pop();
  if (last === undefined) return null;
  const list = parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
  return `${list} will stop.`;
}

/** "Last checked 10 minutes ago", or "Never checked". `at` is in Unix seconds. */
export function lastCheckedText(at: number | null, nowMs: number): string {
  if (at === null) return "Never checked";
  const minutes = Math.floor((nowMs / 1000 - at) / 60);
  if (minutes < 1) return "Last checked just now";
  if (minutes < 60) return `Last checked ${counted(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last checked ${counted(hours, "hour")} ago`;
  return `Last checked ${counted(Math.floor(hours / 24), "day")} ago`;
}

/** The release the app offers: available, or one whose install failed, unless skipped. */
export function pendingRelease(state: UpdateState): Release | null {
  const { phase } = state;
  const release =
    phase.type === "available"
      ? phase.release
      : phase.type === "failed"
        ? phase.release
        : null;
  return release !== null && release.version !== state.skipped ? release : null;
}

/** The status bar's update button, or null to show the version instead. */
export function statusButtonText(state: UpdateState): string | null {
  const { phase } = state;
  if (phase.type === "downloading") {
    const percent = downloadPercent(phase.received, phase.total);
    return percent === null
      ? `Downloading ${phase.version}`
      : `Downloading ${phase.version} · ${percent}%`;
  }
  if (phase.type === "installing") return "Installing…";
  const release = pendingRelease(state);
  return release === null ? null : `Update to ${release.version}`;
}
