import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { windowLabel } from "../ipc/window";
import { useUiState } from "./uiState";

/** The key of a window's collapsed sidebar (spec Q §3), this window's by default. */
export function sidebarCollapsedKey(label: string = windowLabel()): string {
  return `sidebar.collapsed.${label}`;
}

interface SidebarToggle {
  /** Collapses or expands the mounted sidebar column; null while none is mounted. */
  toggle: (() => void) | null;
  collapsed: boolean;
}

const IDLE: SidebarToggle = { toggle: null, collapsed: false };

/** The mounted column's state and toggle, lent to Ctrl+B and the palette command. */
export const useSidebarToggle = create<SidebarToggle>()(() => IDLE);

/**
 * This window's collapsed sidebar, kept with `useUiState` and expanded by default. The
 * column calls it; while mounted it publishes its toggle to `useSidebarToggle`.
 */
export function useSidebarCollapse(): [boolean, () => void] {
  const key = useMemo(() => sidebarCollapsedKey(), []);
  const [saved, setSaved] = useUiState<boolean>(key, false);
  const collapsed = saved === true;
  useEffect(() => {
    useSidebarToggle.setState({
      collapsed,
      toggle: () => setSaved(!collapsed),
    });
    return () => useSidebarToggle.setState(IDLE);
  }, [collapsed, setSaved]);
  return [collapsed, () => setSaved(!collapsed)];
}

/** Collapses or expands this window's sidebar. False when no sidebar is mounted. */
export function toggleSidebar(): boolean {
  const { toggle } = useSidebarToggle.getState();
  if (toggle === null) return false;
  toggle();
  return true;
}

export function resetSidebarToggleForTest(): void {
  useSidebarToggle.setState(IDLE);
}
