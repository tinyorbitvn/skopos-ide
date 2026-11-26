//! Change cards and the person's answers to them (spec §3.2, §4.5). Each chat has one
//! `Approvals`: it sends the chat's change cards, holds the changes that wait for an answer and
//! keeps the chat's standing approvals, one per cluster. A change waits without a time limit
//! until the person answers or the chat stops.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use ts_rs::TS;

use crate::agents::diff::DiffLine;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::ResourceRef;

/// One change the agent asked for, as the stream draws it. The card is sent again, whole, each
/// time its state changes, under the same `id`. Stored chats keep it, so it reads back too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChangeCard {
    pub id: String,
    /// The cluster's name, for the chip.
    pub cluster: String,
    /// Such as `Change Deployment payments/api`.
    pub title: String,
    /// The agent's one-line summary, at most 200 characters.
    pub summary: String,
    /// Empty for restart, delete and exec.
    pub diff: Vec<DiffLine>,
    /// An exec's command, word by word, or a terminal command whole.
    pub command: Option<Vec<String>>,
    /// The Secrets the changed object reads, or the Pod an exec runs in reads, named while
    /// Secret values are hidden from agents. Such a change always waits for the person: neither
    /// `Don't ask` nor a standing approval covers it (spec §4.5).
    #[serde(default)]
    pub secrets: Vec<String>,
    pub state: ChangeState,
    /// `Deleted.`, `Exit code <n>` or `exit <n>` once applied. A rollout's line is the panel's (R5).
    pub result: Option<String>,
    /// The workload whose rollout the panel follows once the change is applied.
    pub rollout: Option<RolloutTarget>,
    /// The first 20 lines an exec printed, or the last 20 of a terminal command.
    pub output: Option<String>,
    /// A terminal command's cluster, whose `Agent · <cluster>` tab shows it (native agents spec
    /// §5.1). `None` for every other change.
    #[serde(default)]
    pub terminal: Option<ClusterId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ChangeState {
    /// The approval card: the change waits for the person.
    Waiting,
    /// `at` is the local time the change was applied, `HH:MM`. `standing` when the person
    /// approved every later change of the chat on this cluster too.
    Approved {
        at: String,
        standing: bool,
    },
    /// The done card: the cluster's setting allows it, or, with `standing`, an earlier
    /// `Approve for this chat` did.
    AppliedWithoutAsking {
        standing: bool,
    },
    /// A terminal command runs; the card's output follows it.
    Running,
    Denied,
    Stopped,
    /// A terminal command was stopped while it ran: by the person, or by the chat's Stop.
    StoppedRunning,
    Failed {
        message: String,
    },
}

/// What the panel follows after a change to a Deployment, StatefulSet or DaemonSet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RolloutTarget {
    pub cluster_id: ClusterId,
    pub resource: ResourceRef,
    pub namespace: String,
    pub name: String,
}

/// The buttons of an approval card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ChangeAnswer {
    Approve,
    ApproveForChat,
    Deny,
}

/// How a wait for an answer ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeAnswerOrStop {
    Answer(ChangeAnswer),
    /// The chat stopped, closed, or the tool call went away.
    Stopped,
}

struct Waiting {
    card: ChangeCard,
    reply: oneshot::Sender<ChangeAnswerOrStop>,
}

/// The cards, waits and standing approvals of one chat.
pub struct Approvals {
    cards: mpsc::Sender<ChangeCard>,
    waiting: Mutex<HashMap<String, Waiting>>,
    standing: Mutex<HashSet<ClusterId>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Held while a change waits. Dropped before an answer came, it ends the card stopped.
struct Pending<'a> {
    approvals: &'a Approvals,
    id: String,
    armed: bool,
}

impl Pending<'_> {
    fn done(mut self) {
        self.armed = false;
    }
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let left = lock(&self.approvals.waiting).remove(&self.id);
        if let Some(Waiting { mut card, .. }) = left {
            card.state = ChangeState::Stopped;
            let _ = self.approvals.cards.try_send(card);
        }
    }
}

impl Approvals {
    pub fn new(cards: mpsc::Sender<ChangeCard>) -> Arc<Approvals> {
        Arc::new(Approvals {
            cards,
            waiting: Mutex::default(),
            standing: Mutex::default(),
        })
    }

    /// Sends a card to the chat's stream. A closed stream drops it.
    pub async fn show(&self, card: ChangeCard) {
        let _ = self.cards.send(card).await;
    }

    /// Sends a card without waiting, for a drop guard. A full or closed stream drops it.
    pub(crate) fn show_now(&self, card: ChangeCard) {
        let _ = self.cards.try_send(card);
    }

    /// Sends the card, which must be `Waiting`, and waits for its answer.
    pub async fn ask(&self, card: ChangeCard) -> ChangeAnswerOrStop {
        let (reply, answer) = oneshot::channel();
        let id = card.id.clone();
        lock(&self.waiting).insert(
            id.clone(),
            Waiting {
                card: card.clone(),
                reply,
            },
        );
        let pending = Pending {
            approvals: self,
            id,
            armed: true,
        };
        self.show(card).await;
        let answer = answer.await.unwrap_or(ChangeAnswerOrStop::Stopped);
        pending.done();
        answer
    }

    /// The person's answer to the card `card_id`.
    pub fn answer(&self, card_id: &str, answer: ChangeAnswer) -> CoreResult<()> {
        let waiting = lock(&self.waiting).remove(card_id);
        let Some(waiting) = waiting else {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                "That change no longer waits for an answer.",
            ));
        };
        let _ = waiting.reply.send(ChangeAnswerOrStop::Answer(answer));
        Ok(())
    }

    /// Answers every waiting change as stopped. The gate draws each one's stopped card; a wait
    /// that has gone away gets its card drawn here.
    pub fn stop_all(&self) {
        let drained: Vec<Waiting> = lock(&self.waiting)
            .drain()
            .map(|(_, waiting)| waiting)
            .collect();
        for Waiting { mut card, reply } in drained {
            if reply.send(ChangeAnswerOrStop::Stopped).is_err() {
                card.state = ChangeState::Stopped;
                let _ = self.cards.try_send(card);
            }
        }
    }

    /// Whether `Approve for this chat` covers changes to this cluster.
    pub fn standing(&self, cluster: &ClusterId) -> bool {
        lock(&self.standing).contains(cluster)
    }

    pub fn grant_standing(&self, cluster: &ClusterId) {
        lock(&self.standing).insert(cluster.clone());
    }

    /// `Undo` on the card: later changes to this cluster ask again.
    pub fn undo_standing(&self, cluster: &ClusterId) {
        lock(&self.standing).remove(cluster);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card(id: &str) -> ChangeCard {
        ChangeCard {
            id: id.to_owned(),
            cluster: "prod".to_owned(),
            title: "Change ConfigMap default/c".to_owned(),
            summary: "Set a".to_owned(),
            diff: Vec::new(),
            command: None,
            secrets: Vec::new(),
            state: ChangeState::Waiting,
            result: None,
            rollout: None,
            output: None,
            terminal: None,
        }
    }

    fn approvals() -> (Arc<Approvals>, mpsc::Receiver<ChangeCard>) {
        let (cards, shown) = mpsc::channel(8);
        (Approvals::new(cards), shown)
    }

    fn ask_in_background(
        approvals: &Arc<Approvals>,
        id: &str,
    ) -> tokio::task::JoinHandle<ChangeAnswerOrStop> {
        let approvals = approvals.clone();
        let card = card(id);
        tokio::spawn(async move { approvals.ask(card).await })
    }

    #[tokio::test]
    async fn an_answer_reaches_the_change_that_waits_for_it() {
        let (approvals, mut shown) = approvals();
        let waiter = ask_in_background(&approvals, "a");
        let waiting = shown.recv().await.unwrap();
        assert_eq!(waiting.id, "a");
        assert_eq!(waiting.state, ChangeState::Waiting);
        approvals.answer("a", ChangeAnswer::ApproveForChat).unwrap();
        assert_eq!(
            waiter.await.unwrap(),
            ChangeAnswerOrStop::Answer(ChangeAnswer::ApproveForChat)
        );
        let again = approvals.answer("a", ChangeAnswer::Deny).unwrap_err();
        assert_eq!(again.code, ErrorCode::NotFound);
    }

    #[test]
    fn only_a_waiting_change_can_be_answered() {
        let (approvals, _shown) = approvals();
        let error = approvals
            .answer("missing", ChangeAnswer::Approve)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn stop_all_answers_every_waiting_change_as_stopped() {
        let (approvals, mut shown) = approvals();
        let first = ask_in_background(&approvals, "a");
        let second = ask_in_background(&approvals, "b");
        shown.recv().await.unwrap();
        shown.recv().await.unwrap();
        approvals.stop_all();
        assert_eq!(first.await.unwrap(), ChangeAnswerOrStop::Stopped);
        assert_eq!(second.await.unwrap(), ChangeAnswerOrStop::Stopped);
        assert!(
            shown.try_recv().is_err(),
            "the gate draws the stopped cards of waits that are still there"
        );
        let late = approvals.answer("a", ChangeAnswer::Approve).unwrap_err();
        assert_eq!(late.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn a_wait_that_goes_away_ends_its_card_stopped() {
        let (approvals, mut shown) = approvals();
        let waiter = ask_in_background(&approvals, "a");
        shown.recv().await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        let ended = shown.recv().await.unwrap();
        assert_eq!(ended.id, "a");
        assert_eq!(ended.state, ChangeState::Stopped);
        let late = approvals.answer("a", ChangeAnswer::Approve).unwrap_err();
        assert_eq!(late.code, ErrorCode::NotFound);
    }

    #[test]
    fn a_standing_approval_belongs_to_one_cluster_until_undone() {
        let (approvals, _shown) = approvals();
        let prod: ClusterId = "prod".to_owned();
        let stage: ClusterId = "stage".to_owned();
        assert!(!approvals.standing(&prod));
        approvals.grant_standing(&prod);
        assert!(approvals.standing(&prod));
        assert!(!approvals.standing(&stage));
        approvals.undo_standing(&prod);
        assert!(!approvals.standing(&prod));
    }

    #[test]
    fn a_card_stored_before_it_named_secrets_reads_back_with_none() {
        let mut stored = serde_json::to_value(card("c")).unwrap();
        assert_eq!(stored["secrets"], json!([]));
        stored.as_object_mut().unwrap().remove("secrets");
        assert_eq!(
            serde_json::from_value::<ChangeCard>(stored).unwrap(),
            card("c")
        );
    }

    #[test]
    fn states_and_answers_cross_to_the_webview_in_camel_case() {
        let approved = ChangeState::Approved {
            at: "14:02".to_owned(),
            standing: true,
        };
        assert_eq!(
            serde_json::to_value(&approved).unwrap(),
            json!({ "state": "approved", "at": "14:02", "standing": true })
        );
        assert_eq!(
            serde_json::to_value(ChangeState::AppliedWithoutAsking { standing: false }).unwrap(),
            json!({ "state": "appliedWithoutAsking", "standing": false })
        );
        assert_eq!(
            serde_json::to_value(ChangeState::Waiting).unwrap(),
            json!({ "state": "waiting" })
        );
        assert_eq!(
            serde_json::from_value::<ChangeAnswer>(json!("approveForChat")).unwrap(),
            ChangeAnswer::ApproveForChat
        );
        let rollout = RolloutTarget {
            cluster_id: "c1".to_owned(),
            resource: ResourceRef {
                group: "apps".into(),
                version: "v1".into(),
                plural: "deployments".into(),
                kind: "Deployment".into(),
                namespaced: true,
            },
            namespace: "payments".to_owned(),
            name: "api".to_owned(),
        };
        let mut stored = card("a");
        stored.rollout = Some(rollout);
        let text = serde_json::to_string(&stored).unwrap();
        assert!(text.contains("\"clusterId\":\"c1\""), "{text}");
        assert_eq!(serde_json::from_str::<ChangeCard>(&text).unwrap(), stored);
    }
}
