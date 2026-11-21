import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { PODS } from "../../kinds/refs";
import { logsTab } from "../../stores/dock";
import { flush, mockBackend } from "../../test/ipc";
import { formatSize, useLogDownload } from "./logDownload";

const TAB = logsTab("c1", PODS, {
  metadata: { name: "web-1", namespace: "shop" },
  spec: { containers: [{ name: "app" }] },
});

test.each<[number, string]>([
  [0, "0 B"],
  [1023, "1,023 B"],
  [1024, "1.0 KiB"],
  [1536, "1.5 KiB"],
  [1024 ** 2, "1.0 MiB"],
  [5 * 1024 ** 3, "5.0 GiB"],
  [3072 * 1024 ** 3, "3,072.0 GiB"],
])("%i bytes read %s", (bytes, text) => {
  expect(formatSize(bytes)).toBe(text);
});

test("a second press while the download runs calls the command once", async () => {
  const b = mockBackend({
    // Never answers: the download is still running.
    logs_download: () => new Promise(() => {}),
  });
  const { result } = renderHook(() => useLogDownload(TAB));

  await act(async () => {
    void result.current.download();
    void result.current.download();
    await flush();
  });
  expect(b.callsTo("logs_download")).toHaveLength(1);
  expect(result.current.saving).toBe(true);

  await act(async () => {
    void result.current.download();
    await flush();
  });
  expect(b.callsTo("logs_download")).toHaveLength(1);
});

test("the command gets the suggested name and no path, and the note names the path it wrote", async () => {
  const b = mockBackend({
    logs_download: () => ({ bytes: 1536, path: "/home/me/chosen.log" }),
  });
  const { result } = renderHook(() => useLogDownload(TAB));

  await act(() => result.current.download());
  const [call] = b.callsTo("logs_download");
  expect(call).toMatchObject({ clusterId: "c1", suggestedName: "web-1.log" });
  expect(call).not.toHaveProperty("destPath");
  expect(call).not.toHaveProperty("path");
  expect(result.current.note).toEqual({
    text: "Saved 1.5 KiB to /home/me/chosen.log",
    failed: false,
  });
});

test("a cancelled dialog ends quietly and download works again", async () => {
  const b = mockBackend({ logs_download: () => null });
  const { result } = renderHook(() => useLogDownload(TAB));

  await act(() => result.current.download());
  expect(result.current.note).toBeNull();
  expect(result.current.saving).toBe(false);

  await act(() => result.current.download());
  expect(b.callsTo("logs_download")).toHaveLength(2);
});

test("a command that fails is reported, and download works again", async () => {
  const b = mockBackend({
    logs_download: () => {
      throw "dialog unavailable";
    },
  });
  const { result } = renderHook(() => useLogDownload(TAB));

  await act(() => result.current.download());
  expect(result.current.note).toEqual({
    text: "Could not download the logs: dialog unavailable",
    failed: true,
  });
  expect(result.current.saving).toBe(false);

  await act(() => result.current.download());
  expect(b.callsTo("logs_download")).toHaveLength(2);
});
