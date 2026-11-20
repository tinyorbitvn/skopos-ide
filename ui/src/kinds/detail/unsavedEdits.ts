import { createContext, useContext, useEffect } from "react";

/**
 * Set by a drawer: the parts inside it that hold unsaved edits, a token each. The drawer
 * reads it only when a click outside would close it, so it is a set and not state.
 */
export const UnsavedEditsContext = createContext<Set<object> | null>(null);

/**
 * Tells the drawer around the caller that it holds unsaved edits while `unsaved` is
 * true, so a click outside the drawer does not throw them away. Outside a drawer, as in
 * a dock tab, it does nothing.
 */
export function useUnsavedEdits(unsaved: boolean): void {
  const parts = useContext(UnsavedEditsContext);
  useEffect(() => {
    if (!unsaved || !parts) return;
    const token = {};
    parts.add(token);
    return () => {
      parts.delete(token);
    };
  }, [unsaved, parts]);
}
