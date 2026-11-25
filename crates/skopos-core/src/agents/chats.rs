//! Stored chats (agents spec §3.4, §4.8): one JSON file per chat in `<data>/agents/chats/`,
//! named by its 8-hex id. The 100 newest chats of each scope are kept.

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use k8s_openapi::jiff::Timestamp;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::chat::ChatScope;
use super::events::{ChatItem, ChatItemBody};
use super::mcp::cards::CardDetails;
use super::permissions::PermissionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::paths::create_private_dir;

/// How many chats each scope keeps: each cluster's, and the global one.
pub const KEPT_PER_SCOPE: usize = 100;
/// The most a tool card's details keep when stored, in bytes.
pub const DETAILS_CAP: usize = 8 * 1024;

/// One chat as the history keeps it: the transcript as drawn.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoredChat {
    /// 8 hex characters.
    pub id: String,
    pub scope: ChatScope,
    /// The agent's id.
    pub agent: String,
    /// The agent's name when the chat ran, for the history.
    pub agent_name: String,
    /// The ACP session, for `session/load`.
    pub session_id: Option<String>,
    /// Whether the agent can load the session again.
    pub can_load: bool,
    /// The person's first message, one line.
    pub title: String,
    /// RFC 3339.
    pub created: String,
    /// RFC 3339.
    pub updated: String,
    pub items: Vec<ChatItem>,
}

/// One line of the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    /// The agent's name.
    pub agent: String,
    pub updated: String,
    /// How many clusters the chat reached, for the global history.
    #[ts(type = "number")]
    pub clusters: usize,
}

/// What the history reads of a chat file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatHead {
    id: String,
    scope: ChatScope,
    agent_name: String,
    title: String,
    updated: String,
}

/// The chats folder. Writes go one at a time, so retention sees every file.
pub struct ChatStore {
    dir: PathBuf,
    writes: Mutex<()>,
}

impl ChatStore {
    pub fn new(dir: PathBuf) -> ChatStore {
        ChatStore {
            dir,
            writes: Mutex::new(()),
        }
    }

    /// Whether a stored chat has this id.
    pub fn holds(&self, id: &str) -> bool {
        valid_id(id) && self.file(id).exists()
    }

    /// Writes the chat, its tool details cut to 8 KiB each, then deletes the oldest chats of
    /// its scope beyond 100.
    pub fn save(&self, chat: &StoredChat) -> CoreResult<()> {
        if !valid_id(&chat.id) {
            return Err(IpcError::new(
                ErrorCode::InvalidInput,
                format!("{} is not a chat id", chat.id),
            ));
        }
        let mut kept = chat.clone();
        for item in &mut kept.items {
            cut_details(&mut item.body);
        }
        let bytes = serde_json::to_vec(&kept).map_err(|error| {
            IpcError::new(
                ErrorCode::Internal,
                format!("cannot write chat {}: {error}", chat.id),
            )
        })?;
        let _one_writer = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        create_private_dir(&self.dir)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(self.file(&chat.id))
            .map_err(|error| error.error)?;
        self.prune(&chat.scope.scope_key());
        Ok(())
    }

    /// The scope's chats, newest first. A file that cannot be read is left out and logged.
    pub fn list(&self, scope: &ChatScope) -> Vec<ChatSummary> {
        self.heads_of(&scope.scope_key())
            .into_iter()
            .map(|head| ChatSummary {
                clusters: head.scope.clusters.len(),
                id: head.id,
                title: head.title,
                agent: head.agent_name,
                updated: head.updated,
            })
            .collect()
    }

    /// One stored chat. `NotFound` for an id that is not 8 hex characters, a missing file,
    /// and a file that cannot be read (logged). A permission card still waiting when the chat
    /// ended reads back cancelled (native agents spec §4.2).
    pub fn get(&self, id: &str) -> CoreResult<StoredChat> {
        let missing = || IpcError::new(ErrorCode::NotFound, format!("No chat {id}."));
        if !valid_id(id) {
            return Err(missing());
        }
        let path = self.file(id);
        match read_json::<StoredChat>(&path) {
            Ok(mut chat) if chat.id == id => {
                cancel_waiting_permissions(&mut chat);
                Ok(chat)
            }
            Ok(_) => {
                tracing::warn!("chat file {} names another chat", path.display());
                Err(missing())
            }
            Err(error) => {
                if path.exists() {
                    tracing::warn!("cannot read chat file {}: {error}", path.display());
                }
                Err(missing())
            }
        }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn prune(&self, key: &str) {
        for head in self.heads_of(key).iter().skip(KEPT_PER_SCOPE) {
            if let Err(error) = std::fs::remove_file(self.file(&head.id)) {
                tracing::warn!("cannot delete chat {}: {error}", head.id);
            }
        }
    }

    /// The readable chats of one scope key, newest first.
    fn heads_of(&self, key: &str) -> Vec<ChatHead> {
        let mut heads: Vec<ChatHead> = self
            .heads()
            .into_iter()
            .filter(|head| head.scope.scope_key() == key)
            .collect();
        heads.sort_by(|a, b| {
            when(&b.updated)
                .cmp(&when(&a.updated))
                .then_with(|| b.id.cmp(&a.id))
        });
        heads
    }

    /// Every readable `<8 hex>.json` of the folder; nothing else in it is read.
    fn heads(&self) -> Vec<ChatHead> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) => {
                if error.kind() != ErrorKind::NotFound {
                    tracing::warn!("cannot read {}: {error}", self.dir.display());
                }
                return Vec::new();
            }
        };
        let mut heads = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if !valid_id(id) {
                continue;
            }
            let path = entry.path();
            match read_json::<ChatHead>(&path) {
                Ok(head) if head.id == id => heads.push(head),
                Ok(_) => tracing::warn!("chat file {} names another chat", path.display()),
                Err(error) => tracing::warn!("cannot read chat file {}: {error}", path.display()),
            }
        }
        heads
    }
}

fn cancel_waiting_permissions(chat: &mut StoredChat) {
    for item in &mut chat.items {
        if let ChatItemBody::Permission { card } = &mut item.body {
            if card.state == PermissionState::Waiting {
                card.state = PermissionState::Cancelled;
            }
        }
    }
}

/// Exactly 8 lowercase hex characters, so a name never leads out of the folder.
fn valid_id(id: &str) -> bool {
    id.len() == 8
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// An RFC 3339 time for ordering; one that does not parse is the oldest.
fn when(text: &str) -> Timestamp {
    text.parse().unwrap_or(Timestamp::MIN)
}

/// Keeps a stored tool card's details to 8 KiB (spec §4.8): text at a character boundary,
/// tables by whole rows while the head and the rows fit.
fn cut_details(body: &mut ChatItemBody) {
    match body {
        ChatItemBody::Tool { card } => match &mut card.details {
            CardDetails::None => {}
            CardDetails::Text { text } => cut_text(text),
            CardDetails::Table { head, rows } => {
                let mut used: usize = head.iter().map(String::len).sum();
                let mut fit = 0;
                for row in rows.iter() {
                    let size: usize = row.iter().map(String::len).sum();
                    if used + size > DETAILS_CAP {
                        break;
                    }
                    used += size;
                    fit += 1;
                }
                rows.truncate(fit);
            }
        },
        ChatItemBody::AgentTool { details, .. } => cut_text(details),
        // A proposal's text can hold Secret values; only its card is saved (spec A12).
        ChatItemBody::Proposal { card } => {
            card.yaml.clear();
            card.diff.clear();
        }
        _ => {}
    }
}

fn cut_text(text: &mut String) {
    if text.len() <= DETAILS_CAP {
        return;
    }
    let mut end = DETAILS_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::acp::ToolStatus;
    use crate::agents::approvals::{ChangeCard, ChangeState};
    use crate::agents::diff::{DiffKind, DiffLine};
    use crate::agents::editor_tab::EditorTabMode;
    use crate::agents::events::ChatNotice;
    use crate::agents::mcp::cards::{CardTone, ToolCard};
    use crate::agents::permissions::{
        ChoiceKind, PermissionCard, PermissionChoice, PermissionState,
    };
    use crate::agents::tabs::{ProposalCard, ProposalState};

    fn store() -> (tempfile::TempDir, ChatStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path().join("chats"));
        (dir, store)
    }

    fn scope(clusters: &[&str], global: bool) -> ChatScope {
        ChatScope {
            clusters: clusters
                .iter()
                .map(|cluster| (*cluster).to_owned())
                .collect(),
            global,
        }
    }

    /// `n` seconds after midnight, so a larger `n` is newer.
    fn at(n: u32) -> String {
        format!(
            "2026-11-22T{:02}:{:02}:{:02}Z",
            n / 3600,
            n / 60 % 60,
            n % 60
        )
    }

    fn id(n: u32) -> String {
        format!("{n:08x}")
    }

    fn chat(n: u32, scope: ChatScope) -> StoredChat {
        StoredChat {
            id: id(n),
            scope,
            agent: "custom-0000000a".to_owned(),
            agent_name: "Fake".to_owned(),
            session_id: Some(format!("session-{n}")),
            can_load: true,
            title: format!("Chat {n}"),
            created: at(n),
            updated: at(n),
            items: vec![ChatItem {
                id: "item-1".to_owned(),
                body: ChatItemBody::User {
                    text: format!("Chat {n}"),
                    object: None,
                    tab: None,
                },
            }],
        }
    }

    fn tool(details: CardDetails) -> ChatItemBody {
        ChatItemBody::Tool {
            card: Box::new(ToolCard {
                id: "call-1".to_owned(),
                cluster: Some("fake".to_owned()),
                title: "Read logs · api-1 · last 100 lines".to_owned(),
                result: "100 lines".to_owned(),
                tone: CardTone::Normal,
                details,
                running: false,
            }),
        }
    }

    #[test]
    fn only_the_newest_100_chats_of_a_scope_are_kept() {
        let (_dir, store) = store();
        for n in 1..=101 {
            store.save(&chat(n, scope(&["c1"], false))).unwrap();
        }
        store.save(&chat(500, scope(&["c2"], false))).unwrap();
        store.save(&chat(501, scope(&["c1", "c2"], true))).unwrap();
        let kept = store.list(&scope(&["c1"], false));
        assert_eq!(kept.len(), KEPT_PER_SCOPE);
        assert_eq!(kept[0].id, id(101));
        assert_eq!(kept[99].id, id(2));
        assert_eq!(store.get(&id(1)).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(store.list(&scope(&["c2"], false)).len(), 1);
        assert_eq!(store.list(&scope(&["c1", "c2"], true)).len(), 1);
    }

    #[test]
    fn the_history_lists_a_scope_newest_first_with_its_cluster_count() {
        let (_dir, store) = store();
        let global = scope(&["c1", "c2", "c3"], true);
        for n in [3, 1, 2] {
            store.save(&chat(n, global.clone())).unwrap();
        }
        store.save(&chat(9, scope(&["c1"], false))).unwrap();
        let listed = store.list(&global);
        let ids: Vec<&str> = listed.iter().map(|summary| summary.id.as_str()).collect();
        assert_eq!(ids, [id(3), id(2), id(1)]);
        assert_eq!(
            listed[0],
            ChatSummary {
                id: id(3),
                title: "Chat 3".to_owned(),
                agent: "Fake".to_owned(),
                updated: at(3),
                clusters: 3,
            }
        );
    }

    #[test]
    fn an_unreadable_chat_file_is_left_out() {
        let (dir, store) = store();
        store.save(&chat(1, scope(&["c1"], false))).unwrap();
        let broken = dir.path().join("chats").join(format!("{}.json", id(2)));
        std::fs::write(broken, "{ not json").unwrap();
        let listed = store.list(&scope(&["c1"], false));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id(1));
        assert_eq!(store.get(&id(2)).unwrap_err().code, ErrorCode::NotFound);
        store.save(&chat(3, scope(&["c1"], false))).unwrap();
        assert_eq!(store.list(&scope(&["c1"], false)).len(), 2);
    }

    #[test]
    fn a_name_that_is_not_a_chat_id_is_never_read() {
        let (dir, store) = store();
        let chats = dir.path().join("chats");
        std::fs::create_dir_all(&chats).unwrap();
        let mut named = chat(1, scope(&["c1"], false));
        named.id = "notes".to_owned();
        std::fs::write(
            chats.join("notes.json"),
            serde_json::to_vec(&named).unwrap(),
        )
        .unwrap();
        assert!(store.list(&scope(&["c1"], false)).is_empty());
        for wrong in ["notes", "../chats/notes", "0000000G", "0000000", ""] {
            assert_eq!(
                store.get(wrong).unwrap_err().code,
                ErrorCode::NotFound,
                "{wrong}"
            );
        }
        assert!(!store.holds("notes"));
        assert_eq!(
            store.save(&named).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn tool_card_details_are_cut_to_8_kib_when_saved() {
        let (_dir, store) = store();
        let mut whole = chat(1, scope(&["c1"], false));
        let rows: Vec<Vec<String>> = (0..2000).map(|n| vec![format!("pod-{n:04}")]).collect();
        whole.items = vec![
            ChatItem {
                id: "item-1".to_owned(),
                body: tool(CardDetails::Text {
                    text: "é".repeat(10_000),
                }),
            },
            ChatItem {
                id: "item-2".to_owned(),
                body: tool(CardDetails::Table {
                    head: vec!["Name".to_owned()],
                    rows,
                }),
            },
            ChatItem {
                id: "item-3".to_owned(),
                body: ChatItemBody::AgentTool {
                    title: "Run ls".to_owned(),
                    status: ToolStatus::Completed,
                    details: "x".repeat(10_000),
                },
            },
        ];
        store.save(&whole).unwrap();
        let read = store.get(&id(1)).unwrap();
        match card_details(&read.items[0]) {
            CardDetails::Text { text } => assert_eq!(text.len(), DETAILS_CAP),
            other => panic!("{other:?}"),
        }
        match card_details(&read.items[1]) {
            // "Name" and 1,023 names of 8 bytes fit in 8,192 bytes.
            CardDetails::Table { head, rows } => {
                assert_eq!(head, &["Name"]);
                assert_eq!(rows.len(), 1023);
                assert_eq!(rows[1022], ["pod-1022"]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(agent_tool_details(&read.items[2]).len(), DETAILS_CAP);
        // The chat it saved from keeps its details whole.
        assert_eq!(agent_tool_details(&whole.items[2]).len(), 10_000);
    }

    fn card_details(item: &ChatItem) -> &CardDetails {
        match &item.body {
            ChatItemBody::Tool { card } => &card.details,
            other => panic!("not a tool card: {other:?}"),
        }
    }

    fn agent_tool_details(item: &ChatItem) -> &str {
        match &item.body {
            ChatItemBody::AgentTool { details, .. } => details,
            other => panic!("not an agent tool: {other:?}"),
        }
    }

    fn permission(id: &str, state: PermissionState) -> ChatItem {
        ChatItem {
            id: format!("item-{id}"),
            body: ChatItemBody::Permission {
                card: Box::new(PermissionCard {
                    id: id.to_owned(),
                    tool_call_id: "own-1".to_owned(),
                    title: "Run ls".to_owned(),
                    kind: "execute".to_owned(),
                    command: Some("ls".to_owned()),
                    diffs: Vec::new(),
                    url: None,
                    raw: None,
                    options: vec![PermissionChoice {
                        id: "allow_once".to_owned(),
                        name: "Allow".to_owned(),
                        kind: ChoiceKind::AllowOnce,
                    }],
                    state,
                }),
            },
        }
    }

    #[test]
    fn a_permission_card_still_waiting_reads_back_cancelled() {
        let (_dir, store) = store();
        let mut saved = chat(3, scope(&["c1"], false));
        let chosen = PermissionState::Chosen {
            option_id: "allow_once".to_owned(),
            kind: ChoiceKind::AllowOnce,
        };
        saved.items.push(permission("p1", chosen.clone()));
        saved.items.push(permission("p2", PermissionState::Waiting));
        store.save(&saved).unwrap();
        let states: Vec<PermissionState> = store
            .get(&id(3))
            .unwrap()
            .items
            .into_iter()
            .filter_map(|item| match item.body {
                ChatItemBody::Permission { card } => Some(card.state),
                _ => None,
            })
            .collect();
        assert_eq!(states, [chosen, PermissionState::Cancelled]);
    }

    #[test]
    fn a_stored_chat_reads_back_as_it_was_saved() {
        let (_dir, store) = store();
        let mut saved = chat(7, scope(&["c1"], false));
        let card = ChangeCard {
            id: "change-1".to_owned(),
            cluster: "fake".to_owned(),
            title: "Scale Deployment default/api to 3".to_owned(),
            summary: "Scale api to 3".to_owned(),
            diff: vec![
                DiffLine {
                    kind: DiffKind::Removed,
                    text: "replicas: 1".to_owned(),
                },
                DiffLine {
                    kind: DiffKind::Added,
                    text: "replicas: 3".to_owned(),
                },
            ],
            command: None,
            secrets: vec!["db".to_owned()],
            state: ChangeState::Approved {
                at: "10:42".to_owned(),
                standing: false,
            },
            result: Some("Applied.".to_owned()),
            rollout: None,
            output: None,
        };
        saved.items.push(ChatItem {
            id: "item-2".to_owned(),
            body: ChatItemBody::Change {
                card: Box::new(card),
            },
        });
        saved.items.push(ChatItem {
            id: "item-3".to_owned(),
            body: ChatItemBody::notice(ChatNotice::Stopped),
        });
        store.save(&saved).unwrap();
        assert!(store.holds(&id(7)));
        let read = store.get(&id(7)).unwrap();
        assert_eq!(
            serde_json::to_value(&read).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
    }

    #[test]
    fn a_saved_proposal_keeps_its_card_but_not_its_text_or_diff() {
        let (dir, store) = store();
        let mut whole = chat(1, scope(&["c1"], false));
        whole.items = vec![ChatItem {
            id: "proposal:p1".to_owned(),
            body: ChatItemBody::Proposal {
                card: Box::new(ProposalCard {
                    id: "p1".to_owned(),
                    tab_id: "create-1".to_owned(),
                    tab_title: "Create".to_owned(),
                    cluster: "kind".to_owned(),
                    cluster_id: "c1".to_owned(),
                    mode: EditorTabMode::Create,
                    target: None,
                    summary: "Add a Secret".to_owned(),
                    added: 1,
                    removed: 0,
                    state: ProposalState::Accepted,
                    yaml: "stringData:\n  password: hunter2\n".to_owned(),
                    diff: vec![DiffLine {
                        kind: DiffKind::Added,
                        text: "  password: hunter2".to_owned(),
                    }],
                }),
            },
        }];
        store.save(&whole).unwrap();
        let read = store.get(&id(1)).unwrap();
        match &read.items[0].body {
            ChatItemBody::Proposal { card } => {
                assert_eq!(
                    (card.summary.as_str(), card.state, card.added),
                    ("Add a Secret", ProposalState::Accepted, 1)
                );
                assert!(card.yaml.is_empty() && card.diff.is_empty());
            }
            other => panic!("not a proposal: {other:?}"),
        }
        let file =
            std::fs::read_to_string(dir.path().join("chats").join(format!("{}.json", id(1))))
                .unwrap();
        assert!(!file.contains("hunter2"));
    }
}
