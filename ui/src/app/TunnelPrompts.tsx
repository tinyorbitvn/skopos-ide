import { useEffect } from "react";
import { promptToShow, useTunnels } from "../stores/tunnels";
import { TunnelPromptDialog } from "./TunnelPromptDialog";

/**
 * Shows `ssh`'s questions in every window (tunnels spec §6.1): the prompt the person chose,
 * else one that opens at once because the person started the action. The first answer from
 * any window wins.
 */
export function TunnelPrompts() {
  const tunnels = useTunnels((s) => s.tunnels);
  const asking = useTunnels((s) => s.asking);
  const answered = useTunnels((s) => s.answered);
  const load = useTunnels((s) => s.load);
  const finishPrompt = useTunnels((s) => s.finishPrompt);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = promptToShow({ tunnels, asking, answered });
  if (shown === null) return null;
  return (
    <TunnelPromptDialog
      key={shown.prompt.id}
      name={shown.tunnel.name}
      prompt={shown.prompt}
      onDone={() => finishPrompt(shown.prompt.id)}
    />
  );
}
