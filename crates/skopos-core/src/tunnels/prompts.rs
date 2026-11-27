//! The questions `ssh` asks (tunnels spec §6.3): how a prompt is classified, and the prompts
//! that wait for the person, which `TunnelView.prompt` carries to every window.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tokio::sync::oneshot;
use ts_rs::TS;

use crate::agents::endpoint::new_token;
use crate::secrets::Secret;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PromptKind {
    Passphrase,
    Password,
    /// A new host key to trust (`continue connecting`).
    HostKey,
    /// `SSH_ASKPASS_PROMPT=confirm`: a yes or no.
    Confirm,
    /// A code or a keyboard-interactive question.
    Other,
}

impl PromptKind {
    /// Only passphrases and passwords may be remembered (spec §6.3, T8).
    pub fn can_remember(self) -> bool {
        matches!(self, PromptKind::Passphrase | PromptKind::Password)
    }
}

/// A question that waits for the person. Its text is `ssh`'s, never an answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelPrompt {
    pub id: String,
    /// The tunnel's id.
    pub tunnel: String,
    pub kind: PromptKind,
    /// The prompt as `ssh` wrote it.
    pub text: String,
    pub can_remember: bool,
    /// The person started what asks, so every window opens the dialog at once (spec §6.1).
    pub opens_at_once: bool,
}

/// What `ssh`'s prompt is (spec §6.3). `hint` is `SSH_ASKPASS_PROMPT`.
pub(crate) fn classify(text: &str, hint: Option<&str>) -> PromptKind {
    if hint == Some("confirm") {
        return PromptKind::Confirm;
    }
    if text.contains("Enter passphrase for") {
        return PromptKind::Passphrase;
    }
    if text.contains("continue connecting") {
        return PromptKind::HostKey;
    }
    if text.trim_end().to_lowercase().ends_with("password:") {
        return PromptKind::Password;
    }
    PromptKind::Other
}

/// The person's answer. No `Debug`: it holds the secret (T1).
pub(crate) enum PromptAnswer {
    Text { answer: Secret, remember: bool },
    Cancel,
}

struct Pending {
    prompt: TunnelPrompt,
    reply: oneshot::Sender<PromptAnswer>,
}

/// The prompts that wait, oldest first.
#[derive(Default)]
pub(crate) struct Prompts {
    pending: Mutex<Vec<Pending>>,
}

impl Prompts {
    pub(crate) fn open(
        &self,
        tunnel: &str,
        kind: PromptKind,
        text: &str,
        opens_at_once: bool,
    ) -> (TunnelPrompt, oneshot::Receiver<PromptAnswer>) {
        let prompt = TunnelPrompt {
            id: new_token(),
            tunnel: tunnel.to_owned(),
            kind,
            text: text.to_owned(),
            can_remember: kind.can_remember(),
            opens_at_once,
        };
        let (reply, answer) = oneshot::channel();
        self.lock().push(Pending {
            prompt: prompt.clone(),
            reply,
        });
        (prompt, answer)
    }

    /// The tunnel's oldest waiting prompt.
    pub(crate) fn first(&self, tunnel: &str) -> Option<TunnelPrompt> {
        self.lock()
            .iter()
            .find(|pending| pending.prompt.tunnel == tunnel)
            .map(|pending| pending.prompt.clone())
    }

    /// Hands the answer to the prompt's waiter and gives the tunnel's id; `None` when no such
    /// prompt waits. The first answer from any window wins.
    pub(crate) fn answer(&self, id: &str, answer: PromptAnswer) -> Option<String> {
        let pending = {
            let mut all = self.lock();
            let at = all.iter().position(|pending| pending.prompt.id == id)?;
            all.remove(at)
        };
        // The waiter may have given up already; the prompt is gone either way.
        let _ = pending.reply.send(answer);
        Some(pending.prompt.tunnel)
    }

    /// Forgets a prompt whose wait ended.
    pub(crate) fn close(&self, id: &str) {
        self.lock().retain(|pending| pending.prompt.id != id);
    }

    /// Ends every prompt of the tunnel: their waiters read that nobody will answer.
    pub(crate) fn clear_tunnel(&self, tunnel: &str) {
        self.lock()
            .retain(|pending| pending.prompt.tunnel != tunnel);
    }

    /// The person acted on the tunnel: its prompts open at once (spec §6.1). `true` when one
    /// changed.
    pub(crate) fn open_at_once(&self, tunnel: &str) -> bool {
        let mut changed = false;
        for pending in self
            .lock()
            .iter_mut()
            .filter(|pending| pending.prompt.tunnel == tunnel && !pending.prompt.opens_at_once)
        {
            pending.prompt.opens_at_once = true;
            changed = true;
        }
        changed
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Pending>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::PromptKind::*;
    use super::*;

    #[test]
    fn prompts_are_classified_by_their_text() {
        assert_eq!(
            classify(
                "Enter passphrase for key '/home/me/.ssh/id_ed25519': ",
                None
            ),
            Passphrase
        );
        assert_eq!(classify("me@bastion's password: ", None), Password);
        assert_eq!(classify("(me@127.0.0.1) Password: ", None), Password);
        assert_eq!(
            classify(
                "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
                None
            ),
            HostKey
        );
        assert_eq!(
            classify("Allow use of key id_ed25519?", Some("confirm")),
            Confirm
        );
        assert_eq!(classify("Verification code: ", None), Other);
        assert!(Passphrase.can_remember() && Password.can_remember());
        assert!(!HostKey.can_remember() && !Confirm.can_remember() && !Other.can_remember());
    }

    #[tokio::test]
    async fn the_first_answer_wins_and_clearing_ends_the_wait() {
        let prompts = Prompts::default();
        let (prompt, answer) = prompts.open("t1", Password, "Password: ", false);
        assert_eq!(prompts.first("t1"), Some(prompt.clone()));
        assert!(prompts.open_at_once("t1"));
        assert!(prompts.first("t1").unwrap().opens_at_once);
        assert!(!prompts.open_at_once("t1"), "nothing left to change");
        let given = PromptAnswer::Text {
            answer: Secret::new("pw"),
            remember: false,
        };
        assert_eq!(prompts.answer(&prompt.id, given).as_deref(), Some("t1"));
        assert!(prompts.answer(&prompt.id, PromptAnswer::Cancel).is_none());
        assert!(matches!(answer.await, Ok(PromptAnswer::Text { .. })));
        assert_eq!(prompts.first("t1"), None);

        let (_, waiting) = prompts.open("t1", Other, "Code: ", true);
        prompts.clear_tunnel("t1");
        assert!(waiting.await.is_err());
    }
}
