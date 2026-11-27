//! The askpass endpoint and the prompts with a core and no `ssh` (tunnels spec §6.3).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::askpass::{ssh_answer_account, AskState, Refusal};
use super::askpass_mode::{ask, AskReply, AskRequest};
use super::model::{TunnelInput, TunnelKind};
use super::prompts::{PromptKind, TunnelPrompt};
use super::state::TunnelState;
use super::timings::TunnelTimings;
use crate::app_core::AppCore;
use crate::paths::AppPaths;
use crate::secrets::Secret;

async fn core_with_ssh_tunnel() -> (AppCore, String, TempDir) {
    let root = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let view = core
        .tunnel_save(TunnelInput {
            id: None,
            name: "bastion".into(),
            kind: TunnelKind::Ssh {
                host: "bastion".into(),
                user: None,
                port: None,
                jump: None,
                identity_file: None,
            },
        })
        .unwrap();
    (core, view.id, root)
}

fn request(prompt: &str) -> AskRequest {
    AskRequest {
        prompt: prompt.into(),
        hint: None,
    }
}

fn spawn_ask(core: &AppCore, state: &Arc<AskState>, request: AskRequest) -> JoinHandle<AskReply> {
    let (core, state) = (core.clone(), state.clone());
    tokio::spawn(async move { core.tunnel_ask(&state, request).await })
}

fn text(reply: AskReply) -> Option<String> {
    match reply {
        AskReply::Answer { text } => Some(text),
        AskReply::No => None,
    }
}

/// Waits until the tunnel's view carries a prompt.
async fn prompt_of(core: &AppCore, id: &str) -> TunnelPrompt {
    let started = Instant::now();
    loop {
        let view = core.tunnel_list().into_iter().find(|t| t.id == id);
        if let Some(prompt) = view.and_then(|t| t.prompt) {
            return prompt;
        }
        assert!(started.elapsed() < Duration::from_secs(5), "no prompt");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(files_under(&path));
        } else {
            found.push(path);
        }
    }
    found
}

#[tokio::test]
async fn a_question_waits_for_the_answer_and_the_view_carries_it() {
    let (core, id, _root) = core_with_ssh_tunnel().await;
    let state = AskState::new(&id, true);
    let asking = spawn_ask(&core, &state, request("me@bastion's password: "));
    let prompt = prompt_of(&core, &id).await;
    assert_eq!(prompt.kind, PromptKind::Password);
    assert_eq!(prompt.text, "me@bastion's password: ");
    assert!(prompt.can_remember && prompt.opens_at_once);
    assert!(state.waiting());
    core.tunnel_prompt_answer(&prompt.id, Secret::new("hunter2"), false)
        .unwrap();
    assert_eq!(text(asking.await.unwrap()).as_deref(), Some("hunter2"));
    assert!(core.tunnel_list()[0].prompt.is_none());
    assert!(!state.waiting());
    let late = core
        .tunnel_prompt_answer(&prompt.id, Secret::new("x"), false)
        .unwrap_err();
    assert_eq!(late.message, "This prompt was answered already or is gone.");
}

#[tokio::test]
async fn a_remembered_answer_is_replayed_and_a_repeat_asks_again() {
    let (core, id, _root) = core_with_ssh_tunnel().await;
    let state = AskState::new(&id, true);
    let passphrase = "Enter passphrase for key '/home/me/.ssh/id_ed25519': ";
    let account = ssh_answer_account(&id, passphrase);

    let asking = spawn_ask(&core, &state, request(passphrase));
    let prompt = prompt_of(&core, &id).await;
    core.tunnel_prompt_answer(&prompt.id, Secret::new("s3cret"), true)
        .unwrap();
    assert_eq!(text(asking.await.unwrap()).as_deref(), Some("s3cret"));
    assert!(core.tunnel_def(&id).unwrap().remembered.contains(&account));

    // The next run gets it at once, without a prompt.
    state.new_run();
    let replayed = core.tunnel_ask(&state, request(passphrase)).await;
    assert_eq!(text(replayed).as_deref(), Some("s3cret"));

    // Shown again in the same run: it was wrong, so it is forgotten and the person is asked.
    let asking = spawn_ask(&core, &state, request(passphrase));
    let prompt = prompt_of(&core, &id).await;
    assert!(!core.tunnel_def(&id).unwrap().remembered.contains(&account));
    core.tunnel_prompt_answer(&prompt.id, Secret::new("right"), false)
        .unwrap();
    assert_eq!(text(asking.await.unwrap()).as_deref(), Some("right"));
}

#[tokio::test]
async fn a_cancel_refuses_this_and_later_prompts() {
    let (core, id, _root) = core_with_ssh_tunnel().await;
    let state = AskState::new(&id, true);
    let asking = spawn_ask(&core, &state, request("Password: "));
    let prompt = prompt_of(&core, &id).await;
    core.tunnel_prompt_cancel(&prompt.id).unwrap();
    assert!(text(asking.await.unwrap()).is_none());
    assert_eq!(state.refusal(), Some(Refusal::Cancelled));
    let later = core
        .tunnel_ask(&state, request("Verification code: "))
        .await;
    assert!(text(later).is_none());
    assert!(core.tunnel_list()[0].prompt.is_none(), "nobody was asked");
    state.new_run();
    assert_eq!(state.refusal(), None);
}

#[tokio::test]
async fn an_unanswered_prompt_gives_up_after_the_prompt_time() {
    let (core, id, _root) = core_with_ssh_tunnel().await;
    core.set_tunnel_timings_for_test(TunnelTimings {
        prompt: Duration::from_millis(200),
        ..TunnelTimings::default()
    });
    let state = AskState::new(&id, true);
    assert!(text(core.tunnel_ask(&state, request("Password: ")).await).is_none());
    assert_eq!(state.refusal(), Some(Refusal::Unanswered));
    assert!(core.tunnel_list()[0].prompt.is_none());
}

#[tokio::test]
async fn a_host_key_is_yes_a_confirmation_is_empty_and_codes_are_never_remembered() {
    let (core, id, _root) = core_with_ssh_tunnel().await;
    let state = AskState::new(&id, true);
    let host_key = "The authenticity of host 'bastion (10.0.0.1)' can't be established.\n\
                    ED25519 key fingerprint is SHA256:abc.\n\
                    Are you sure you want to continue connecting (yes/no/[fingerprint])? ";
    let asking = spawn_ask(&core, &state, request(host_key));
    let prompt = prompt_of(&core, &id).await;
    assert_eq!(prompt.kind, PromptKind::HostKey);
    assert!(!prompt.can_remember);
    core.tunnel_prompt_answer(&prompt.id, Secret::new(""), true)
        .unwrap();
    assert_eq!(text(asking.await.unwrap()).as_deref(), Some("yes"));

    let asking = spawn_ask(&core, &state, request("Verification code: "));
    let prompt = prompt_of(&core, &id).await;
    assert_eq!(prompt.kind, PromptKind::Other);
    core.tunnel_prompt_answer(&prompt.id, Secret::new("123456"), true)
        .unwrap();
    assert_eq!(text(asking.await.unwrap()).as_deref(), Some("123456"));

    let confirm = AskRequest {
        prompt: "Allow use of key id_ed25519?".into(),
        hint: Some("confirm".into()),
    };
    let asking = spawn_ask(&core, &state, confirm);
    let prompt = prompt_of(&core, &id).await;
    assert_eq!(prompt.kind, PromptKind::Confirm);
    core.tunnel_prompt_answer(&prompt.id, Secret::new("ignored"), true)
        .unwrap();
    assert_eq!(text(asking.await.unwrap()).as_deref(), Some(""));
    assert!(core.tunnel_def(&id).unwrap().remembered.is_empty());
}

#[tokio::test]
async fn a_prompt_nobody_started_sets_needs_input_and_back() {
    let (core, id, _root) = core_with_ssh_tunnel().await;
    let state = AskState::new(&id, false);
    let reconnecting = TunnelState::Reconnecting {
        attempt: 1,
        last_error: "Connection closed".into(),
    };
    core.tunnel_set_state(&id, reconnecting.clone());
    let asking = spawn_ask(&core, &state, request("Password: "));
    let prompt = prompt_of(&core, &id).await;
    assert!(!prompt.opens_at_once);
    let needs_input = TunnelState::NeedsInput {
        prompt_id: prompt.id.clone(),
    };
    let started = Instant::now();
    while core.tunnel_state(&id) != needs_input {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            core.tunnel_state(&id)
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    core.tunnel_prompt_answer(&prompt.id, Secret::new("pw"), false)
        .unwrap();
    asking.await.unwrap();
    assert_eq!(core.tunnel_state(&id), reconnecting);
}

#[tokio::test]
async fn an_answer_never_reaches_the_view_or_the_store() {
    let (core, id, root) = core_with_ssh_tunnel().await;
    let state = AskState::new(&id, true);
    let asking = spawn_ask(&core, &state, request("me@bastion's password: "));
    let prompt = prompt_of(&core, &id).await;
    core.tunnel_prompt_answer(&prompt.id, Secret::new("hunter2-unique"), true)
        .unwrap();
    asking.await.unwrap();
    let views = serde_json::to_string(&core.tunnel_list()).unwrap();
    assert!(!views.contains("hunter2-unique"));
    for file in files_under(root.path()) {
        let bytes = std::fs::read(&file).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains("hunter2-unique"),
            "{}",
            file.display()
        );
    }
}

#[tokio::test]
async fn the_endpoint_wants_its_token() {
    let (core, id, _root) = core_with_ssh_tunnel().await;
    let state = AskState::new(&id, true);
    let stop = CancellationToken::new();
    let (addr, token) = core
        .tunnel_ask_serve(state.clone(), stop.clone())
        .await
        .unwrap();
    assert!(addr.starts_with("127.0.0.1:"));

    let wrong = {
        let addr = addr.clone();
        tokio::task::spawn_blocking(move || ask(&addr, "wrong", &request("Password: ")).is_err())
    };
    assert!(wrong.await.unwrap(), "a wrong token gets no reply");

    let right = {
        let (addr, token) = (addr.clone(), token.expose().to_owned());
        tokio::task::spawn_blocking(move || {
            ask(&addr, &token, &request("Password: "))
                .ok()
                .and_then(text)
        })
    };
    let prompt = prompt_of(&core, &id).await;
    core.tunnel_prompt_answer(&prompt.id, Secret::new("pw"), false)
        .unwrap();
    assert_eq!(right.await.unwrap().as_deref(), Some("pw"));
    stop.cancel();
}
