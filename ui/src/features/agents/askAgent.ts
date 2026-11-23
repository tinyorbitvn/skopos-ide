import { useEffect } from "react";
import { Sparkles } from "../../design/icons";
import type { ObjectRef } from "../../ipc/generated/ObjectRef";
import { useAgentChat } from "../../stores/agentChat";
import type { ObjectActionItem } from "../resources/objectActions";
import { agentsSupported } from "./supported";

/**
 * The drawer's `Ask the agent about this <Kind>` (spec §3.1). While the drawer shows the
 * object it is also the palette's object.
 */
export function useAskAgentItem(
  object: ObjectRef | null,
): ObjectActionItem | null {
  const key = object ? JSON.stringify(object) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `object`.
  useEffect(() => {
    if (object === null || !agentsSupported()) return;
    useAgentChat.getState().setDrawerObject(object);
    return () => {
      const shown = useAgentChat.getState().drawerObject;
      if (shown && JSON.stringify(shown) === key) {
        useAgentChat.getState().setDrawerObject(null);
      }
    };
  }, [key]);
  if (object === null || !agentsSupported()) return null;
  return {
    id: "agent-ask",
    label: `Ask the agent about this ${object.kind}`,
    icon: Sparkles,
    danger: false,
    disabled: false,
    top: false,
    run: () => void useAgentChat.getState().askAbout(object),
  };
}
