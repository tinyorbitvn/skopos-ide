import { expect, test } from "vitest";
import { RELEASE, updateState } from "../../test/updates";
import {
  DOWNLOAD_PAGE,
  downloadedText,
  downloadPercent,
  lastCheckedText,
  pendingRelease,
  releasePage,
  statusButtonText,
  willStopText,
  youHaveText,
} from "./updateText";

test("the release pages are the project's own", () => {
  expect(DOWNLOAD_PAGE).toBe(
    "https://github.com/vanlongme/skopos-ide/releases/latest",
  );
  expect(releasePage("0.10.0")).toBe(
    "https://github.com/vanlongme/skopos-ide/releases/tag/v0.10.0",
  );
});

test("download sizes are in MB with one decimal, and the share is known only with a total", () => {
  expect(downloadedText(12_400_000, 16_000_000)).toBe("12.4 of 16.0 MB");
  expect(downloadedText(4_000_000, null)).toBe("4.0 MB");
  expect(downloadPercent(4_000_000, 16_000_000)).toBe(25);
  expect(downloadPercent(16_000_000, 16_000_000)).toBe(100);
  expect(downloadPercent(4_000_000, null)).toBeNull();
  expect(downloadPercent(4_000_000, 0)).toBeNull();
});

test("the subtitle names the running version and the release date", () => {
  expect(youHaveText("0.9.0", RELEASE)).toBe(
    "You have 0.9.0 · Released Nov 25, 2026",
  );
  expect(youHaveText("0.9.0", { ...RELEASE, date: null })).toBe(
    "You have 0.9.0",
  );
});

test.each<[number, number, number, string | null]>([
  [0, 0, 0, null],
  [1, 0, 0, "1 terminal will stop."],
  [0, 2, 0, "2 port forwards will stop."],
  [2, 1, 0, "2 terminals and 1 port forward will stop."],
  [2, 1, 1, "2 terminals, 1 port forward and 1 unsaved edit will stop."],
  [0, 0, 3, "3 unsaved edits will stop."],
])(
  "%i terminals, %i forwards and %i edits: %j",
  (terminals, forwards, edits, text) => {
    expect(willStopText(terminals, forwards, edits)).toBe(text);
  },
);

test("the last check reads as a time ago", () => {
  const now = 1_795_608_000_000;
  const seconds = now / 1000;
  expect(lastCheckedText(null, now)).toBe("Never checked");
  expect(lastCheckedText(seconds - 30, now)).toBe("Last checked just now");
  expect(lastCheckedText(seconds - 60, now)).toBe("Last checked 1 minute ago");
  expect(lastCheckedText(seconds - 600, now)).toBe(
    "Last checked 10 minutes ago",
  );
  expect(lastCheckedText(seconds - 7200, now)).toBe("Last checked 2 hours ago");
  expect(lastCheckedText(seconds - 86_400 * 3, now)).toBe(
    "Last checked 3 days ago",
  );
});

test("the status bar offers an available or failed release unless it was skipped", () => {
  const available = updateState({
    phase: { type: "available", release: RELEASE },
  });
  expect(pendingRelease(available)).toEqual(RELEASE);
  expect(statusButtonText(available)).toBe("Update to 0.10.0");
  expect(
    pendingRelease(
      updateState({
        phase: { type: "failed", message: "offline", release: RELEASE },
      }),
    ),
  ).toEqual(RELEASE);
  expect(pendingRelease({ ...available, skipped: "0.10.0" })).toBeNull();
  expect(statusButtonText({ ...available, skipped: "0.10.0" })).toBeNull();
  expect(
    pendingRelease({
      ...available,
      phase: { type: "available", release: { ...RELEASE, version: "0.11.0" } },
      skipped: "0.10.0",
    })?.version,
  ).toBe("0.11.0");
  expect(statusButtonText(updateState())).toBeNull();
  expect(
    statusButtonText(
      updateState({ phase: { type: "upToDate" }, lastCheckedAt: 1 }),
    ),
  ).toBeNull();
});

test("while downloading, the status bar shows how far", () => {
  const downloading = (total: number | null) =>
    updateState({
      phase: {
        type: "downloading",
        version: "0.10.0",
        received: 6_720_000,
        total,
      },
    });
  expect(statusButtonText(downloading(16_000_000))).toBe(
    "Downloading 0.10.0 · 42%",
  );
  expect(statusButtonText(downloading(null))).toBe("Downloading 0.10.0");
  expect(
    statusButtonText(
      updateState({ phase: { type: "installing", version: "0.10.0" } }),
    ),
  ).toBe("Installing…");
});
