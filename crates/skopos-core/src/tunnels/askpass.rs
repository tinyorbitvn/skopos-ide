//! The askpass endpoint of an SSH tunnel (tunnels spec §6.3): the app binary's askpass mode
//! connects with the supervisor's token and relays `ssh`'s prompt. A remembered answer goes
//! back at once; anything else waits for the person in `Prompts`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::askpass_mode::{AskReply, AskRequest};
use super::model::TunnelDef;
use super::prompts::{classify, PromptAnswer, PromptKind};
use super::state::TunnelState;
use crate::agents::endpoint::{new_token, read_token_line, AsyncStream, Endpoint, Listen};
use crate::app_core::{AppCore, CoreEvent, WeakCore};
use crate::blocking::blocking;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::secrets::Secret;

const REQUEST_WAIT: Duration = Duration::from_secs(10);
const REQUEST_CAP: u64 = 64 * 1024;
pub(crate) const PROMPT_GONE: &str = "This prompt was answered already or is gone.";
pub(crate) const PROMPT_CANCELLED: &str = "The prompt was cancelled";
pub(crate) const PROMPT_UNANSWERED: &str = "The prompt got no answer within 2 minutes";

fn prompt_gone() -> IpcError {
    IpcError::new(ErrorCode::NotFound, PROMPT_GONE)
}

/// The keychain account of a remembered answer: the prompt's text, hashed (spec §5.3).
pub(crate) fn ssh_answer_account(tunnel: &str, prompt: &str) -> String {
    let hex: String = Sha256::digest(prompt.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{tunnel}:ssh:{hex}")
}

/// Why an `ssh` run fails although `ssh` may go on asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The person cancelled a prompt.
    Cancelled,
    /// A prompt got no answer in time.
    Unanswered,
}

#[derive(Default)]
struct AskRun {
    /// The remembered-answer accounts this run showed.
    seen: HashSet<String>,
    refusal: Option<Refusal>,
}

/// What the askpass endpoint of one SSH tunnel knows about the `ssh` run it serves.
pub(crate) struct AskState {
    pub(crate) tunnel: String,
    run: Mutex<AskRun>,
    /// Prompts that wait for the person now.
    waiting: AtomicUsize,
    /// A person started what runs: prompts open the dialog at once.
    at_once: AtomicBool,
}

/// Counts one waiting prompt until dropped, also when the wait is cancelled.
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl AskState {
    pub(crate) fn new(tunnel: &str, at_once: bool) -> Arc<AskState> {
        Arc::new(AskState {
            tunnel: tunnel.to_owned(),
            run: Mutex::new(AskRun::default()),
            waiting: AtomicUsize::new(0),
            at_once: AtomicBool::new(at_once),
        })
    }

    /// A new `ssh` run starts: what the last one saw no longer counts.
    pub(crate) fn new_run(&self) {
        *self.lock() = AskRun::default();
    }

    pub(crate) fn set_at_once(&self, on: bool) {
        self.at_once.store(on, Ordering::Relaxed);
    }

    pub(crate) fn at_once(&self) -> bool {
        self.at_once.load(Ordering::Relaxed)
    }

    /// Whether a prompt waits for the person now; the start limit does not count that time.
    pub(crate) fn waiting(&self) -> bool {
        self.waiting.load(Ordering::Relaxed) > 0
    }

    pub(crate) fn refusal(&self) -> Option<Refusal> {
        self.lock().refusal
    }

    fn refuse(&self, refusal: Refusal) {
        self.lock().refusal.get_or_insert(refusal);
    }

    /// `false` when this run showed the prompt already.
    fn first_showing(&self, account: &str) -> bool {
        self.lock().seen.insert(account.to_owned())
    }

    fn wait(&self) -> Waiting<'_> {
        self.waiting.fetch_add(1, Ordering::Relaxed);
        Waiting(&self.waiting)
    }

    fn lock(&self) -> MutexGuard<'_, AskRun> {
        self.run.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One connection of the askpass mode: the token line, one request line, one reply line.
async fn serve_ask(
    core: WeakCore,
    ask: Arc<AskState>,
    token: Secret,
    mut stream: Box<dyn AsyncStream>,
) {
    if !read_token_line(&mut stream, token.expose()).await {
        return;
    }
    let mut line = String::new();
    let read = {
        let mut reader = BufReader::new((&mut stream).take(REQUEST_CAP));
        tokio::time::timeout(REQUEST_WAIT, reader.read_line(&mut line)).await
    };
    if !matches!(read, Ok(Ok(read)) if read > 0) {
        return;
    }
    let Ok(request) = serde_json::from_str::<AskRequest>(&line) else {
        return;
    };
    let Some(app) = core.upgrade() else { return };
    let reply = app.tunnel_ask(&ask, request).await;
    drop(app);
    let Ok(mut body) = serde_json::to_vec(&reply) else {
        return;
    };
    body.push(b'\n');
    let _ = stream.write_all(&body).await;
    let _ = stream.flush().await;
}

impl AppCore {
    /// Binds the askpass endpoint of one SSH tunnel and serves it until `stop` (spec §6.3).
    /// Gives its address and token, for `ssh`'s environment.
    pub(crate) async fn tunnel_ask_serve(
        &self,
        ask: Arc<AskState>,
        stop: CancellationToken,
    ) -> CoreResult<(String, Secret)> {
        let endpoint = Endpoint::bind(Listen::Tcp).await?;
        let addr = format!("127.0.0.1:{}", endpoint.port());
        let token = Secret::new(new_token());
        let core = self.downgrade();
        let kept = token.clone();
        tokio::spawn(async move {
            loop {
                let stream = tokio::select! {
                    () = stop.cancelled() => return,
                    accepted = endpoint.accept() => match accepted {
                        Ok(stream) => stream,
                        Err(_) => continue,
                    },
                };
                let (core, ask, token, stop) =
                    (core.clone(), ask.clone(), kept.clone(), stop.clone());
                tokio::spawn(async move {
                    tokio::select! {
                        () = stop.cancelled() => {}
                        () = serve_ask(core, ask, token, stream) => {}
                    }
                });
            }
        });
        Ok((addr, token))
    }

    /// The reply to one prompt of `ssh` (spec §6.3).
    pub(crate) async fn tunnel_ask(&self, ask: &AskState, request: AskRequest) -> AskReply {
        if ask.refusal().is_some() {
            // The person said no, or nobody answered: every later prompt of the run is a no.
            return AskReply::No;
        }
        let Some(def) = self.tunnel_def(&ask.tunnel) else {
            return AskReply::No;
        };
        let kind = classify(&request.prompt, request.hint.as_deref());
        let account = ssh_answer_account(&def.id, &request.prompt);
        if kind.can_remember() {
            if ask.first_showing(&account) {
                if let Some(answer) = self.tunnel_remembered(&def, &account).await {
                    return AskReply::Answer {
                        text: answer.expose().to_owned(),
                    };
                }
            } else {
                // `ssh` asks again in the same run: the answer it got was wrong.
                self.tunnel_forget_answer(&def.id, &account).await;
            }
        }
        let runtime = self.tunnel_runtime();
        // Counted before the prompt shows, so the start limit stops at once.
        let waiting = ask.wait();
        let before = self.tunnel_state(&def.id);
        let (prompt, answer) = runtime
            .prompts
            .open(&def.id, kind, &request.prompt, ask.at_once());
        let needs_input = TunnelState::NeedsInput {
            prompt_id: prompt.id.clone(),
        };
        if prompt.opens_at_once {
            self.emit(CoreEvent::TunnelsChanged);
        } else {
            self.tunnel_set_state(&def.id, needs_input.clone());
        }
        let waited = tokio::time::timeout(self.tunnel_timings().prompt, answer).await;
        drop(waiting);
        runtime.prompts.close(&prompt.id);
        if self.tunnel_state(&def.id) == needs_input {
            self.tunnel_set_state(&def.id, before);
        }
        self.emit(CoreEvent::TunnelsChanged);
        match waited {
            Ok(Ok(PromptAnswer::Text { answer, remember })) => {
                if remember && kind.can_remember() {
                    self.tunnel_remember(&def.id, &account, answer.clone())
                        .await;
                }
                let text = match kind {
                    PromptKind::HostKey => "yes".to_owned(),
                    PromptKind::Confirm => String::new(),
                    PromptKind::Passphrase | PromptKind::Password | PromptKind::Other => {
                        answer.expose().to_owned()
                    }
                };
                AskReply::Answer { text }
            }
            Ok(Ok(PromptAnswer::Cancel)) => {
                ask.refuse(Refusal::Cancelled);
                AskReply::No
            }
            // The tunnel stopped: nobody will answer.
            Ok(Err(_)) => AskReply::No,
            Err(_) => {
                ask.refuse(Refusal::Unanswered);
                AskReply::No
            }
        }
    }

    /// The person's answer to a prompt (spec §6.3). The first answer from any window wins.
    pub fn tunnel_prompt_answer(
        &self,
        prompt_id: &str,
        answer: Secret,
        remember: bool,
    ) -> CoreResult<()> {
        self.tunnel_runtime()
            .prompts
            .answer(prompt_id, PromptAnswer::Text { answer, remember })
            .map(drop)
            .ok_or_else(prompt_gone)
    }

    /// The person cancelled a prompt: `ssh` reads a no, and the start fails.
    pub fn tunnel_prompt_cancel(&self, prompt_id: &str) -> CoreResult<()> {
        self.tunnel_runtime()
            .prompts
            .answer(prompt_id, PromptAnswer::Cancel)
            .map(drop)
            .ok_or_else(prompt_gone)
    }

    /// A remembered answer for exactly this prompt, if the tunnel kept one.
    async fn tunnel_remembered(&self, def: &TunnelDef, account: &str) -> Option<Secret> {
        let kept = def.remembered.iter().any(|kept| kept == account)
            || self.tunnel_secrets().memory_only(account).is_some();
        if !kept {
            return None;
        }
        let (core, account) = (self.clone(), account.to_owned());
        blocking(move || core.tunnel_secrets().get(&account))
            .await
            .ok()
            .flatten()
    }

    /// Keeps the answer: in the keychain when it takes it, else in memory for this run.
    async fn tunnel_remember(&self, id: &str, account: &str, answer: Secret) {
        let (core, id, account) = (self.clone(), id.to_owned(), account.to_owned());
        let saved = blocking(move || {
            let stored = core.tunnel_secrets().set(&account, answer).is_ok();
            core.tunnels_store().update(|all| {
                if let Some(tunnel) = all.iter_mut().find(|t| t.id == id) {
                    tunnel.remembered.retain(|kept| kept != &account);
                    if stored {
                        tunnel.remembered.push(account.clone());
                    }
                }
            })
        })
        .await;
        if let Err(e) = saved {
            tracing::warn!("a remembered SSH answer could not be noted: {}", e.message);
        }
    }

    /// Forgets a remembered answer that turned out wrong.
    async fn tunnel_forget_answer(&self, id: &str, account: &str) {
        let (core, id, account) = (self.clone(), id.to_owned(), account.to_owned());
        let forgot = blocking(move || {
            core.tunnel_secrets().delete(&account);
            core.tunnels_store().update(|all| {
                if let Some(tunnel) = all.iter_mut().find(|t| t.id == id) {
                    tunnel.remembered.retain(|kept| kept != &account);
                }
            })
        })
        .await;
        if let Err(e) = forgot {
            tracing::warn!("a wrong SSH answer could not be forgotten: {}", e.message);
        }
    }
}
