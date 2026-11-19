/** Whether a drag carries a file or a link, the two things a webview navigates to on drop. */
export function carriesFileOrLink(types: readonly string[]): boolean {
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Keeps a dropped file or link from navigating the window away from the app. Other drags,
 * such as text moved inside the editor, are left alone. Returns the function that removes
 * the listeners.
 */
export function installDropGuard(target: Window): () => void {
  const guard = (event: DragEvent): void => {
    const transfer = event.dataTransfer;
    if (!transfer || !carriesFileOrLink(Array.from(transfer.types))) return;
    event.preventDefault();
    if (event.type === "dragover") transfer.dropEffect = "none";
  };
  target.addEventListener("dragover", guard, true);
  target.addEventListener("drop", guard, true);
  return () => {
    target.removeEventListener("dragover", guard, true);
    target.removeEventListener("drop", guard, true);
  };
}
