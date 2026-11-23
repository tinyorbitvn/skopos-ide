import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Scrolls the element with id `target` to the top of its scroller and focuses it, once
 * `ready` says the page rendered it (spec §3.1, P14). It runs again on every navigation to
 * the same address, so `Agent settings` pressed twice still lands on the section.
 */
export function useAnchorFocus(target: string | null, ready: boolean): void {
  const { key } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new location key re-runs it.
  useEffect(() => {
    if (target === null || !ready) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(target);
      if (!(element instanceof HTMLElement)) return;
      element.scrollIntoView({ block: "start" });
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ready, key]);
}
