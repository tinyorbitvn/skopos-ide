//! The YAML tab a chat holds and the proposals the agent made for it (YAML authoring spec A6,
//! A10, A11). Each change to a card is sent whole on `cards`; the chat's pump draws it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use ts_rs::TS;

use crate::agents::diff::DiffLine;
use crate::agents::editor_tab::{EditTarget, EditorTab, EditorTabMode, HiddenValue};
use crate::agents::mcp::ScopeCluster;
use crate::error::CoreResult;
use crate::kubeconfig::ClusterId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProposalState {
    Waiting,
    Accepted,
    Rejected,
    Replaced,
    TabClosed,
}

/// A proposal the agent made for a tab (spec A11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProposalCard {
    pub id: String,
    pub tab_id: String,
    pub tab_title: String,
    /// The cluster's name in the chat.
    pub cluster: String,
    pub cluster_id: ClusterId,
    pub mode: EditorTabMode,
    pub target: Option<EditTarget>,
    pub summary: String,
    pub added: u32,
    pub removed: u32,
    pub state: ProposalState,
    /// The whole proposed text, Secret values restored: live only, never saved (spec A12).
    #[serde(default)]
    pub yaml: String,
    #[serde(default)]
    pub diff: Vec<DiffLine>,
}

/// The tab the chat's prompts last carried.
#[derive(Clone)]
pub struct AttachedTab {
    pub tab: EditorTab,
    pub cluster: ScopeCluster,
    /// What the agent's copy hides, to restore in a proposal.
    pub hidden: Vec<HiddenValue>,
}

#[derive(Default)]
struct TabsState {
    attached: Option<AttachedTab>,
    /// Each tab's waiting proposal.
    waiting: HashMap<String, ProposalCard>,
}

pub struct EditorTabs {
    cards: mpsc::Sender<ProposalCard>,
    state: Mutex<TabsState>,
}

impl EditorTabs {
    pub fn new(cards: mpsc::Sender<ProposalCard>) -> Arc<EditorTabs> {
        Arc::new(EditorTabs {
            cards,
            state: Mutex::new(TabsState::default()),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, TabsState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn attach(&self, tab: AttachedTab) {
        self.state().attached = Some(tab);
    }

    pub fn attached(&self) -> Option<AttachedTab> {
        self.state().attached.clone()
    }

    /// The tab closed: it is no longer attached, and its waiting proposal is `TabClosed`.
    pub async fn detach(&self, tab_id: &str) {
        let closed = {
            let mut state = self.state();
            if state
                .attached
                .as_ref()
                .is_some_and(|a| a.tab.tab_id == tab_id)
            {
                state.attached = None;
            }
            state.waiting.remove(tab_id)
        };
        if let Some(mut card) = closed {
            card.state = ProposalState::TabClosed;
            let _ = self.cards.send(card).await;
        }
    }

    /// Shows a new proposal; the tab's waiting one becomes `Replaced`.
    pub async fn propose(&self, card: ProposalCard) {
        let replaced = self
            .state()
            .waiting
            .insert(card.tab_id.clone(), card.clone());
        let _ = self.cards.send(card).await;
        if let Some(mut old) = replaced {
            old.state = ProposalState::Replaced;
            let _ = self.cards.send(old).await;
        }
    }

    /// The person's answer. A proposal no longer waiting is left as it is.
    pub async fn answer(&self, proposal_id: &str, accepted: bool) -> CoreResult<()> {
        let answered = {
            let mut state = self.state();
            let tab = state
                .waiting
                .iter()
                .find(|(_, card)| card.id == proposal_id)
                .map(|(tab, _)| tab.clone());
            tab.and_then(|tab| state.waiting.remove(&tab))
        };
        if let Some(mut card) = answered {
            card.state = if accepted {
                ProposalState::Accepted
            } else {
                ProposalState::Rejected
            };
            let _ = self.cards.send(card).await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::editor_tab::EditorTabMode;

    fn card(id: &str, tab: &str) -> ProposalCard {
        ProposalCard {
            id: id.into(),
            tab_id: tab.into(),
            tab_title: "Create".into(),
            cluster: "kind".into(),
            cluster_id: "c1".to_owned(),
            mode: EditorTabMode::Create,
            target: None,
            summary: "Add a Service".into(),
            added: 3,
            removed: 0,
            state: ProposalState::Waiting,
            yaml: "kind: Service\n".into(),
            diff: Vec::new(),
        }
    }

    fn tabs() -> (Arc<EditorTabs>, mpsc::Receiver<ProposalCard>) {
        let (sender, receiver) = mpsc::channel(8);
        (EditorTabs::new(sender), receiver)
    }

    #[tokio::test]
    async fn a_new_proposal_replaces_the_tabs_waiting_one() {
        let (tabs, mut cards) = tabs();
        tabs.propose(card("p1", "t1")).await;
        tabs.propose(card("p2", "t1")).await;
        assert_eq!(cards.recv().await.unwrap().state, ProposalState::Waiting);
        assert_eq!(cards.recv().await.unwrap().id, "p2");
        let replaced = cards.recv().await.unwrap();
        assert_eq!(
            (replaced.id.as_str(), replaced.state),
            ("p1", ProposalState::Replaced)
        );
    }

    #[tokio::test]
    async fn an_answer_sets_the_state_once() {
        let (tabs, mut cards) = tabs();
        tabs.propose(card("p1", "t1")).await;
        tabs.answer("p1", true).await.unwrap();
        tabs.answer("p1", false).await.unwrap();
        cards.recv().await.unwrap();
        assert_eq!(cards.recv().await.unwrap().state, ProposalState::Accepted);
        assert!(cards.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_closed_tab_is_detached_and_its_proposal_marked() {
        let (tabs, mut cards) = tabs();
        let tab = EditorTab {
            tab_id: "t1".into(),
            title: "Create".into(),
            cluster: "c1".to_owned(),
            mode: EditorTabMode::Create,
            yaml: String::new(),
            target: None,
            default_namespace: "default".into(),
        };
        let cluster = ScopeCluster {
            id: tab.cluster.clone(),
            name: "kind".into(),
        };
        tabs.attach(AttachedTab {
            tab,
            cluster,
            hidden: Vec::new(),
        });
        tabs.propose(card("p1", "t1")).await;
        tabs.detach("other").await;
        assert!(tabs.attached().is_some());
        tabs.detach("t1").await;
        assert!(tabs.attached().is_none());
        cards.recv().await.unwrap();
        assert_eq!(cards.recv().await.unwrap().state, ProposalState::TabClosed);
    }
}
