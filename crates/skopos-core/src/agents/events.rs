//! What a chat streams to the panel (agents spec §3.2, §3.3, R6): items with ids, each sent
//! again whole when it changes, the turn's working state, and the chat's end.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::acp::{PlanEntry, ToolStatus};
use super::approvals::ChangeCard;
use super::mcp::cards::ToolCard;
use crate::kubeconfig::ClusterId;

/// One message on a chat's channel.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum ChatEvent {
    /// A new item, or a new version of one already sent under the same `id`.
    Item { item: ChatItem },
    /// `true` when a turn starts, `false` when it has ended.
    Working { working: bool },
    /// The chat ended. `reason` is the notice of an agent that exited; `None` otherwise.
    Closed { reason: Option<String> },
}

/// One entry of the stream, as drawn and as stored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatItem {
    /// `item-<n>`, unique in its chat.
    pub id: String,
    pub body: ChatItemBody,
}

/// What an item shows. The cards are boxed so the small items stay small.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum ChatItemBody {
    /// What the person wrote, and the object they attached.
    User {
        text: String,
        object: Option<ObjectRef>,
    },
    /// The agent's message, whole as far as it has come.
    Agent { text: String },
    /// The agent's plan for this turn.
    Plan { entries: Vec<PlanEntry> },
    /// A call to SkoposIDE's tools, drawn from the MCP server's own record (spec §4.4).
    Tool { card: Box<ToolCard> },
    /// A tool of the agent's own, bounded by the sandbox.
    AgentTool {
        title: String,
        status: ToolStatus,
        details: String,
    },
    /// A change the agent asked for (spec §4.5).
    Change { card: Box<ChangeCard> },
    /// One of the app's lines, with its text.
    Notice { notice: ChatNotice, text: String },
}

impl ChatItemBody {
    /// A notice with the text the stream shows.
    pub fn notice(notice: ChatNotice) -> ChatItemBody {
        let text = notice.text();
        ChatItemBody::Notice { notice, text }
    }
}

/// The app's lines in the stream (spec §3.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum ChatNotice {
    Stopped,
    BlockedHost {
        host: String,
    },
    Exited {
        agent: String,
        reason: String,
    },
    AgentError {
        agent: String,
        message: String,
    },
    /// The agent asked for a sign-in during a turn; `hint` says how, for a built-in agent.
    SignInNeeded {
        agent: String,
        hint: Option<String>,
    },
    LengthLimit {
        agent: String,
    },
    TooManySteps {
        agent: String,
    },
    Declined {
        agent: String,
    },
}

impl ChatNotice {
    /// The notice as the stream writes it.
    pub fn text(&self) -> String {
        match self {
            ChatNotice::Stopped => "Stopped.".to_owned(),
            ChatNotice::BlockedHost { host } => format!("The sandbox blocked {host}."),
            ChatNotice::Exited { agent, reason } => {
                format!("{agent} stopped unexpectedly: {}.", sentence(reason))
            }
            ChatNotice::AgentError { agent, message } => {
                format!("{agent} reported an error: {}.", sentence(message))
            }
            ChatNotice::SignInNeeded { agent, hint } => match hint {
                Some(hint) => format!("{agent} needs you to sign in. {hint}"),
                None => format!("{agent} needs you to sign in."),
            },
            ChatNotice::LengthLimit { agent } => {
                format!("{agent} stopped: the reply hit its length limit.")
            }
            ChatNotice::TooManySteps { agent } => format!("{agent} stopped after too many steps."),
            ChatNotice::Declined { agent } => format!("{agent} declined to continue."),
        }
    }
}

/// A reason or a message as the middle of a sentence that adds its own period.
fn sentence(text: &str) -> &str {
    text.trim().trim_end_matches('.')
}

/// The object the person attached to a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObjectRef {
    pub cluster: ClusterId,
    pub kind: String,
    /// `None` for a cluster-scoped object.
    pub namespace: Option<String>,
    pub name: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agents::mcp::cards::{CardDetails, CardTone};

    fn claude() -> String {
        "Claude".to_owned()
    }

    #[test]
    fn notices_read_as_the_spec_writes_them() {
        assert_eq!(ChatNotice::Stopped.text(), "Stopped.");
        let blocked = ChatNotice::BlockedHost {
            host: "evil.example".to_owned(),
        };
        assert_eq!(blocked.text(), "The sandbox blocked evil.example.");
        let exited = ChatNotice::Exited {
            agent: claude(),
            reason: "out of memory".to_owned(),
        };
        assert_eq!(exited.text(), "Claude stopped unexpectedly: out of memory.");
        let error = ChatNotice::AgentError {
            agent: claude(),
            message: "rate limited".to_owned(),
        };
        assert_eq!(error.text(), "Claude reported an error: rate limited.");
        let signed_out = ChatNotice::SignInNeeded {
            agent: claude(),
            hint: Some("Run claude in a terminal and sign in, then check again.".to_owned()),
        };
        assert_eq!(
            signed_out.text(),
            "Claude needs you to sign in. Run claude in a terminal and sign in, then check again."
        );
        let signed_out = ChatNotice::SignInNeeded {
            agent: "Mine".to_owned(),
            hint: None,
        };
        assert_eq!(signed_out.text(), "Mine needs you to sign in.");
        assert_eq!(
            ChatNotice::LengthLimit { agent: claude() }.text(),
            "Claude stopped: the reply hit its length limit."
        );
        assert_eq!(
            ChatNotice::TooManySteps { agent: claude() }.text(),
            "Claude stopped after too many steps."
        );
        assert_eq!(
            ChatNotice::Declined { agent: claude() }.text(),
            "Claude declined to continue."
        );
    }

    #[test]
    fn an_exit_reason_ending_in_a_period_gets_one_period() {
        let exited = ChatNotice::Exited {
            agent: claude(),
            reason: "Killed.".to_owned(),
        };
        assert_eq!(exited.text(), "Claude stopped unexpectedly: Killed.");
        let error = ChatNotice::AgentError {
            agent: claude(),
            message: " Overloaded. \n".to_owned(),
        };
        assert_eq!(error.text(), "Claude reported an error: Overloaded.");
    }

    #[test]
    fn events_and_items_serialize_with_their_tags() {
        let item = ChatItem {
            id: "item-1".to_owned(),
            body: ChatItemBody::User {
                text: "Why?".to_owned(),
                object: Some(ObjectRef {
                    cluster: "c1".to_owned(),
                    kind: "Deployment".to_owned(),
                    namespace: Some("default".to_owned()),
                    name: "api".to_owned(),
                }),
            },
        };
        assert_eq!(
            serde_json::to_value(ChatEvent::Item { item }).unwrap(),
            json!({
                "type": "item",
                "item": {
                    "id": "item-1",
                    "body": {
                        "type": "user",
                        "text": "Why?",
                        "object": { "cluster": "c1", "kind": "Deployment", "namespace": "default", "name": "api" },
                    },
                },
            })
        );
        assert_eq!(
            serde_json::to_value(ChatEvent::Working { working: true }).unwrap(),
            json!({ "type": "working", "working": true })
        );
        assert_eq!(
            serde_json::to_value(ChatEvent::Closed { reason: None }).unwrap(),
            json!({ "type": "closed", "reason": null })
        );
        let notice = ChatItemBody::notice(ChatNotice::BlockedHost {
            host: "evil.example".to_owned(),
        });
        assert_eq!(
            serde_json::to_value(notice).unwrap(),
            json!({
                "type": "notice",
                "notice": { "kind": "blockedHost", "host": "evil.example" },
                "text": "The sandbox blocked evil.example.",
            })
        );
        let tool = ChatItemBody::AgentTool {
            title: "Run ls".to_owned(),
            status: ToolStatus::InProgress,
            details: String::new(),
        };
        assert_eq!(serde_json::to_value(tool).unwrap()["type"], "agentTool");
    }

    #[test]
    fn a_chat_item_with_a_tool_card_reads_back_as_it_was_written() {
        let card = ToolCard {
            id: "call-1".to_owned(),
            cluster: Some("fake".to_owned()),
            title: "List Pods · default".to_owned(),
            result: "2 Pods".to_owned(),
            tone: CardTone::Normal,
            details: CardDetails::Table {
                head: vec!["Namespace".to_owned(), "Name".to_owned()],
                rows: vec![
                    vec!["default".to_owned(), "api-1".to_owned()],
                    vec!["default".to_owned(), "api-2".to_owned()],
                ],
            },
            running: false,
        };
        let item = ChatItem {
            id: "item-3".to_owned(),
            body: ChatItemBody::Tool {
                card: Box::new(card),
            },
        };
        let written = serde_json::to_value(&item).unwrap();
        assert_eq!(written["body"]["type"], "tool");
        let back: ChatItem = serde_json::from_value(written.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), written);
    }
}
