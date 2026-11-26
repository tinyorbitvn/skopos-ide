import { Button, Markdown, Spinner, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ChangeAnswer } from "../../ipc/generated/ChangeAnswer";
import type { ChangeCard as Card } from "../../ipc/generated/ChangeCard";
import type { ChatItem } from "../../ipc/generated/ChatItem";
import type { ChatNotice } from "../../ipc/generated/ChatNotice";
import { ChangeCard } from "./ChangeCard";
import styles from "./ChatStream.module.css";
import { objectLabel } from "./chatModel";
import { PermissionCard } from "./PermissionCard";
import { PlanCard } from "./PlanCard";
import { ProposalCard } from "./ProposalCard";
import { AgentToolCard, ToolCard } from "./ToolCard";

const WEB_LINK = /^https?:\/\//i;

/** Opens a link of an agent's message, only http and https, through the app's opener (P11). */
export function openAgentLink(url: string): void {
  if (!WEB_LINK.test(url)) return;
  api
    .openExternal(url)
    .catch((error: unknown) =>
      toast.error("Could not open the link", failureMessage(error)),
    );
}

export interface ChatStreamProps {
  items: ChatItem[];
  busy: boolean;
  agentName: string;
  /** The chat runs: change cards take answers. */
  live: boolean;
  /** The running chat: proposal cards answer it. */
  chatId: string | null;
  /** Items read from a stored chat (no rollout line). */
  past: string[];
  undone: string[];
  onAnswer(cardId: string, answer: ChangeAnswer): Promise<void>;
  onChoose(cardId: string, optionId: string): Promise<void>;
  onUndo(card: Card): void;
  onShowTerminal(card: Card): void;
  onStopCommand(cardId: string): Promise<void>;
  onNewChat(): void;
}

function NoticeLine(props: {
  notice: ChatNotice;
  text: string;
  onNewChat(): void;
}) {
  const { kind } = props.notice;
  const danger =
    kind === "exited" || kind === "agentError" || kind === "signInNeeded";
  return (
    <p
      className={danger ? styles.noticeDanger : styles.notice}
      data-testid="agent-notice"
    >
      <span>{props.text}</span>
      {kind === "exited" ? (
        <Button size="sm" onClick={props.onNewChat}>
          New chat
        </Button>
      ) : null}
    </p>
  );
}

function StreamItem(props: ChatStreamProps & { item: ChatItem }) {
  const { item } = props;
  const body = item.body;
  switch (body.type) {
    case "user":
      return (
        <div className={styles.user}>
          {body.object ? (
            <span className={styles.userObject}>
              {objectLabel(body.object)}
            </span>
          ) : null}
          {body.tab ? (
            <span className={styles.userObject} data-testid="agent-user-tab">
              YAML tab · {body.tab.title}
            </span>
          ) : null}
          <p className={styles.userText}>{body.text}</p>
        </div>
      );
    case "agent":
      return (
        <div className={styles.agent}>
          <Markdown text={body.text} onLink={openAgentLink} />
        </div>
      );
    case "plan":
      return <PlanCard entries={body.entries} busy={props.busy} />;
    case "tool":
      return <ToolCard card={body.card} />;
    case "agentTool":
      return (
        <AgentToolCard
          title={body.title}
          status={body.status}
          details={body.details}
        />
      );
    case "change":
      return (
        <ChangeCard
          card={body.card}
          live={props.live}
          follow={!props.past.includes(item.id)}
          undone={props.undone.includes(body.card.id)}
          onAnswer={(answer) => props.onAnswer(body.card.id, answer)}
          onUndo={() => props.onUndo(body.card)}
          onShowTerminal={() => props.onShowTerminal(body.card)}
          onStop={() => props.onStopCommand(body.card.id)}
        />
      );
    case "proposal":
      return (
        <ProposalCard
          card={body.card}
          chatId={props.chatId}
          live={props.live}
        />
      );
    case "permission":
      return (
        <PermissionCard
          card={body.card}
          live={props.live}
          onChoose={(optionId) => props.onChoose(body.card.id, optionId)}
        />
      );
    case "notice":
      return (
        <NoticeLine
          notice={body.notice}
          text={body.text}
          onNewChat={props.onNewChat}
        />
      );
  }
}

/**
 * The chat (spec §3.2). The scroller lays out bottom-up, so it stays at the newest item
 * while the person has not scrolled up.
 */
export function ChatStream(props: ChatStreamProps) {
  const waitingForYou =
    props.live &&
    props.items.some(
      (item) =>
        item.body.type === "permission" &&
        item.body.card.state.state === "waiting",
    );
  return (
    <div
      role="log"
      aria-label="Chat"
      className={styles.stream}
      data-testid="agent-stream"
    >
      <div className={styles.flow}>
        {props.items.map((item) => (
          <StreamItem key={item.id} {...props} item={item} />
        ))}
        {props.busy ? (
          <div className={styles.working} data-testid="agent-working">
            <Spinner
              label={
                waitingForYou
                  ? "Waiting for you"
                  : `${props.agentName} is working…`
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
