//! The agent's own permission requests (native agents spec §4.2): each
//! `session/request_permission` becomes a card in the chat that waits, without a time limit,
//! for the person's choice. Stop, closing the chat, or the agent's process ending answers every
//! waiting card `Cancelled`. The app never picks an option for the person.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use agent_client_protocol::v1::schema::{
    PermissionOption, PermissionOptionKind, RequestPermissionRequest, ToolCallContent,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use ts_rs::TS;

use crate::agents::diff::{text_diff, DiffLine};
use crate::error::{CoreResult, ErrorCode, IpcError};

const ANSWERED: &str = "This request was already answered.";
const NOT_AN_OPTION: &str = "That option is not on this request.";
/// The title of a request whose tool call names none.
const UNTITLED: &str = "The agent's tool";
/// The most lines of raw input a card shows.
const RAW_LINES: usize = 40;

/// The kind of one of the agent's options, which picks the line an answered card shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ChoiceKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

/// One of the agent's options, with its id and name, in the agent's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PermissionChoice {
    pub id: String,
    pub name: String,
    pub kind: ChoiceKind,
}

/// A file the agent asks to change, and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PermissionState {
    /// The card shows the agent's options.
    Waiting,
    #[serde(rename_all = "camelCase")]
    Chosen { option_id: String, kind: ChoiceKind },
    /// The chat stopped, closed or ended before the person chose.
    Cancelled,
}

/// One permission request of the agent, as the stream draws it. The card is sent again, whole,
/// when it is answered, under the same `id`. Stored chats keep it with its final state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PermissionCard {
    pub id: String,
    pub tool_call_id: String,
    pub title: String,
    /// The ACP tool kind in lower case: `execute`, `edit`, `fetch`, `read`, `other`, …
    pub kind: String,
    pub command: Option<String>,
    pub diffs: Vec<FileDiff>,
    pub url: Option<String>,
    /// The raw input as pretty JSON, at most 40 lines, when nothing above applies.
    pub raw: Option<String>,
    pub options: Vec<PermissionChoice>,
    pub state: PermissionState,
}

struct Waiting {
    card: PermissionCard,
    reply: oneshot::Sender<Option<String>>,
}

/// The waiting permission requests of one chat.
pub struct Permissions {
    cards: mpsc::Sender<PermissionCard>,
    waiting: Mutex<HashMap<String, Waiting>>,
    next: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Permissions {
    /// Cards, new and answered, go to `cards`.
    pub fn new(cards: mpsc::Sender<PermissionCard>) -> Arc<Permissions> {
        Arc::new(Permissions {
            cards,
            waiting: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
        })
    }

    /// `p1`, `p2`, …
    pub fn next_id(&self) -> String {
        format!("p{}", self.next.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// Shows `card` and waits, without a time limit, for the person's choice. `None`:
    /// cancelled, or the chat no longer draws cards.
    pub async fn ask(&self, card: PermissionCard) -> Option<String> {
        let id = card.id.clone();
        let (reply, answer) = oneshot::channel();
        lock(&self.waiting).insert(
            id.clone(),
            Waiting {
                card: card.clone(),
                reply,
            },
        );
        if self.cards.send(card).await.is_err() {
            lock(&self.waiting).remove(&id);
            return None;
        }
        answer.await.unwrap_or(None)
    }

    /// The person's choice: the waiting request gets `option_id` and the card is sent again
    /// with it. An answered card, or an option the request does not have, is refused and the
    /// card keeps its state.
    pub fn answer(&self, card_id: &str, option_id: &str) -> CoreResult<()> {
        let mut waiting = lock(&self.waiting);
        let Some(entry) = waiting.get(card_id) else {
            return Err(IpcError::new(ErrorCode::NotFound, ANSWERED));
        };
        let Some(choice) = entry
            .card
            .options
            .iter()
            .find(|option| option.id == option_id)
            .cloned()
        else {
            return Err(IpcError::new(ErrorCode::InvalidInput, NOT_AN_OPTION));
        };
        let Some(Waiting { mut card, reply }) = waiting.remove(card_id) else {
            return Err(IpcError::new(ErrorCode::NotFound, ANSWERED));
        };
        drop(waiting);
        card.state = PermissionState::Chosen {
            option_id: choice.id.clone(),
            kind: choice.kind,
        };
        if self.cards.try_send(card).is_err() {
            tracing::warn!("cannot redraw an answered permission card");
        }
        let _ = reply.send(Some(choice.id));
        Ok(())
    }

    /// Answers every waiting request `Cancelled`, and sends each card again so.
    pub fn cancel_all(&self) {
        let drained: Vec<Waiting> = lock(&self.waiting)
            .drain()
            .map(|(_, waiting)| waiting)
            .collect();
        for Waiting { mut card, reply } in drained {
            card.state = PermissionState::Cancelled;
            if self.cards.try_send(card).is_err() {
                tracing::warn!("cannot redraw a cancelled permission card");
            }
            let _ = reply.send(None);
        }
    }
}

/// The card of the agent's `request`, waiting, under `id`: the tool call's title and kind,
/// and by kind its command, its diffs, its URL, or else its raw input.
pub(crate) fn permission_card(id: String, request: &RequestPermissionRequest) -> PermissionCard {
    let fields = &request.tool_call.fields;
    let kind = fields
        .kind
        .and_then(|kind| serde_json::to_value(kind).ok())
        .and_then(|kind| kind.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".to_owned());
    let input = fields.raw_input.as_ref();
    let command = match kind.as_str() {
        "execute" => input_text(input, "command"),
        _ => None,
    };
    let url = match kind.as_str() {
        "fetch" => input_text(input, "url"),
        _ => None,
    };
    let diffs: Vec<FileDiff> = fields
        .content
        .iter()
        .flatten()
        .filter_map(|content| match content {
            ToolCallContent::Diff(diff) => Some(FileDiff {
                path: diff.path.display().to_string(),
                lines: text_diff(diff.old_text.as_deref().unwrap_or_default(), &diff.new_text).0,
            }),
            _ => None,
        })
        .collect();
    let raw = if command.is_none() && url.is_none() && diffs.is_empty() {
        input.and_then(raw_lines)
    } else {
        None
    };
    PermissionCard {
        id,
        tool_call_id: request.tool_call.tool_call_id.0.to_string(),
        title: fields
            .title
            .clone()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| UNTITLED.to_owned()),
        kind,
        command,
        diffs,
        url,
        raw,
        options: request.options.iter().map(choice).collect(),
        state: PermissionState::Waiting,
    }
}

fn input_text(input: Option<&Value>, key: &str) -> Option<String> {
    input?.get(key)?.as_str().map(str::to_owned)
}

/// `input` as pretty JSON, its first 40 lines.
fn raw_lines(input: &Value) -> Option<String> {
    let text = serde_json::to_string_pretty(input).ok()?;
    Some(text.lines().take(RAW_LINES).collect::<Vec<_>>().join("\n"))
}

/// An option of a kind this client does not know is offered as a one-time rejection.
fn choice(option: &PermissionOption) -> PermissionChoice {
    let kind = match option.kind {
        PermissionOptionKind::AllowOnce => ChoiceKind::AllowOnce,
        PermissionOptionKind::AllowAlways => ChoiceKind::AllowAlways,
        PermissionOptionKind::RejectAlways => ChoiceKind::RejectAlways,
        _ => ChoiceKind::RejectOnce,
    };
    PermissionChoice {
        id: option.option_id.0.to_string(),
        name: option.name.clone(),
        kind,
    }
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::v1::schema::{Diff, ToolCallUpdate, ToolCallUpdateFields, ToolKind};
    use serde_json::json;

    use super::*;

    fn card(permissions: &Permissions) -> PermissionCard {
        PermissionCard {
            id: permissions.next_id(),
            tool_call_id: "t1".into(),
            title: "Run ls".into(),
            kind: "execute".into(),
            command: Some("ls".into()),
            diffs: vec![],
            url: None,
            raw: None,
            options: vec![
                PermissionChoice {
                    id: "allow_once".into(),
                    name: "Allow".into(),
                    kind: ChoiceKind::AllowOnce,
                },
                PermissionChoice {
                    id: "reject_once".into(),
                    name: "Reject".into(),
                    kind: ChoiceKind::RejectOnce,
                },
            ],
            state: PermissionState::Waiting,
        }
    }

    #[tokio::test]
    async fn an_answer_reaches_the_waiting_request_and_redraws_the_card() {
        let (sender, mut cards) = mpsc::channel(8);
        let permissions = Permissions::new(sender);
        let asked = card(&permissions);
        let id = asked.id.clone();
        let waiter = tokio::spawn({
            let permissions = permissions.clone();
            async move { permissions.ask(asked).await }
        });
        assert_eq!(cards.recv().await.unwrap().state, PermissionState::Waiting);
        permissions.answer(&id, "allow_once").unwrap();
        assert_eq!(waiter.await.unwrap(), Some("allow_once".to_owned()));
        let answered = cards.recv().await.unwrap();
        assert_eq!(
            answered.state,
            PermissionState::Chosen {
                option_id: "allow_once".into(),
                kind: ChoiceKind::AllowOnce
            }
        );
        let again = permissions.answer(&id, "allow_once").unwrap_err();
        assert_eq!(again.message, "This request was already answered.");
    }

    #[tokio::test]
    async fn an_unknown_option_is_refused_and_the_request_keeps_waiting() {
        let (sender, mut cards) = mpsc::channel(8);
        let permissions = Permissions::new(sender);
        let asked = card(&permissions);
        let id = asked.id.clone();
        let waiter = tokio::spawn({
            let permissions = permissions.clone();
            async move { permissions.ask(asked).await }
        });
        cards.recv().await.unwrap();
        let error = permissions.answer(&id, "allow_always").unwrap_err();
        assert_eq!(error.message, "That option is not on this request.");
        permissions.answer(&id, "reject_once").unwrap();
        assert_eq!(waiter.await.unwrap(), Some("reject_once".to_owned()));
    }

    #[tokio::test]
    async fn cancel_all_cancels_every_waiting_request() {
        let (sender, mut cards) = mpsc::channel(8);
        let permissions = Permissions::new(sender);
        let first = card(&permissions);
        let second = card(&permissions);
        let a = tokio::spawn({
            let p = permissions.clone();
            async move { p.ask(first).await }
        });
        let b = tokio::spawn({
            let p = permissions.clone();
            async move { p.ask(second).await }
        });
        cards.recv().await.unwrap();
        cards.recv().await.unwrap();
        permissions.cancel_all();
        assert_eq!(a.await.unwrap(), None);
        assert_eq!(b.await.unwrap(), None);
        assert_eq!(
            cards.recv().await.unwrap().state,
            PermissionState::Cancelled
        );
        assert_eq!(
            cards.recv().await.unwrap().state,
            PermissionState::Cancelled
        );
    }

    fn request(fields: ToolCallUpdateFields) -> RequestPermissionRequest {
        let options = vec![
            PermissionOption::new("no", "Reject", PermissionOptionKind::RejectOnce),
            PermissionOption::new("yes", "Allow", PermissionOptionKind::AllowOnce),
        ];
        RequestPermissionRequest::new("s1", ToolCallUpdate::new("t9", fields), options)
    }

    #[test]
    fn an_execute_request_shows_its_command_and_the_agent_s_options_in_order() {
        let fields = ToolCallUpdateFields::new()
            .title("Run ls".to_owned())
            .kind(ToolKind::Execute)
            .raw_input(json!({ "command": "ls -la" }));
        let card = permission_card("p1".to_owned(), &request(fields));
        assert_eq!(card.id, "p1");
        assert_eq!(card.tool_call_id, "t9");
        assert_eq!(card.title, "Run ls");
        assert_eq!(card.kind, "execute");
        assert_eq!(card.command.as_deref(), Some("ls -la"));
        assert_eq!((card.url, card.raw), (None, None));
        assert!(card.diffs.is_empty());
        assert_eq!(
            card.options,
            [
                PermissionChoice {
                    id: "no".into(),
                    name: "Reject".into(),
                    kind: ChoiceKind::RejectOnce,
                },
                PermissionChoice {
                    id: "yes".into(),
                    name: "Allow".into(),
                    kind: ChoiceKind::AllowOnce,
                },
            ]
        );
        assert_eq!(card.state, PermissionState::Waiting);
    }

    #[test]
    fn an_edit_request_shows_each_diff_and_a_fetch_its_url() {
        let diff = Diff::new("/work/a.txt", "one\nthree\n").old_text("one\ntwo\n".to_owned());
        let fields = ToolCallUpdateFields::new()
            .kind(ToolKind::Edit)
            .content(vec![ToolCallContent::Diff(diff)]);
        let card = permission_card("p2".to_owned(), &request(fields));
        assert_eq!(card.title, "The agent's tool");
        assert_eq!(card.kind, "edit");
        assert_eq!(card.diffs.len(), 1);
        assert_eq!(card.diffs[0].path, "/work/a.txt");
        assert_eq!(
            card.diffs[0].lines,
            text_diff("one\ntwo\n", "one\nthree\n").0
        );
        assert_eq!(card.raw, None);

        let fields = ToolCallUpdateFields::new()
            .kind(ToolKind::Fetch)
            .raw_input(json!({ "url": "https://example.com/a" }));
        let card = permission_card("p3".to_owned(), &request(fields));
        assert_eq!(card.url.as_deref(), Some("https://example.com/a"));
        assert_eq!(card.raw, None);
    }

    #[test]
    fn any_other_request_shows_its_raw_input_cut_to_40_lines() {
        let long: Vec<u32> = (0..100).collect();
        let fields = ToolCallUpdateFields::new()
            .kind(ToolKind::SwitchMode)
            .raw_input(json!({ "items": long }));
        let card = permission_card("p4".to_owned(), &request(fields));
        assert_eq!(card.kind, "switch_mode");
        let raw = card.raw.unwrap();
        assert_eq!(raw.lines().count(), 40);
        assert!(raw.starts_with("{\n  \"items\": [\n    0,"), "{raw}");

        let card = permission_card("p5".to_owned(), &request(ToolCallUpdateFields::new()));
        assert_eq!((card.kind.as_str(), card.raw), ("other", None));
    }
}
