//! SSH tunnels with the system's OpenSSH client against `skopos-fakesshd` (tunnels spec §6.6):
//! the host key prompt, a password remembered and replayed, a wrong remembered password asked
//! again, a cancel, a keyboard-interactive code, and the server going away.

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use skopos_core::app_core::AppCore;
use skopos_core::paths::AppPaths;
use skopos_core::secrets::Secret;
use skopos_core::tunnels::{
    PromptKind, TunnelInput, TunnelKind, TunnelPrompt, TunnelState, TunnelView,
};
use skopos_fakesshd::{AuthMethod, FakeSshd, FakeSshdOptions, CODE_PROMPT, PASSWORD_PROMPT};
use support::ssh::{system_ssh, use_system_ssh, write_ssh_config};
use tempfile::TempDir;

const LIMIT: Duration = Duration::from_secs(30);
const FIRST: &str = "hunter2-first";
const SECOND: &str = "hunter2-second";

struct Real {
    core: AppCore,
    id: String,
    server: Option<FakeSshd>,
    known_hosts: PathBuf,
    root: TempDir,
}

/// A core with the SSH tunnel `bastion` to a fresh `skopos-fakesshd`; `trusted` puts the
/// server's key in `known_hosts` first.
async fn real(options: FakeSshdOptions, trusted: bool) -> Option<Real> {
    let ssh = system_ssh()?;
    let server = FakeSshd::start(options).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let known = if trusted {
        format!("{}\n", server.known_hosts_line())
    } else {
        String::new()
    };
    let (config, known_hosts) = write_ssh_config(root.path(), &known);
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    use_system_ssh(&core, &ssh, config);
    let view = core
        .tunnel_save(TunnelInput {
            id: None,
            name: "bastion".into(),
            kind: TunnelKind::Ssh {
                host: "127.0.0.1".into(),
                user: Some("me".into()),
                port: Some(server.port()),
                jump: None,
                identity_file: None,
            },
        })
        .unwrap();
    Some(Real {
        core,
        id: view.id,
        server: Some(server),
        known_hosts,
        root,
    })
}

impl Real {
    fn view(&self) -> TunnelView {
        self.core
            .tunnel_list()
            .into_iter()
            .find(|t| t.id == self.id)
            .unwrap()
    }

    async fn until(&self, what: &str, check: impl Fn(&TunnelView) -> bool) -> TunnelView {
        let started = Instant::now();
        loop {
            let view = self.view();
            if check(&view) {
                return view;
            }
            assert!(
                started.elapsed() < LIMIT,
                "timed out waiting for {what}: {:?}, log {:?}",
                view.state,
                view.log
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The next prompt that is not `seen`.
    async fn prompt_after(&self, seen: Option<&str>) -> TunnelPrompt {
        self.until("a prompt", |v| {
            v.prompt
                .as_ref()
                .is_some_and(|p| Some(p.id.as_str()) != seen)
        })
        .await
        .prompt
        .unwrap()
    }

    fn start_in_background(&self) -> tokio::task::JoinHandle<TunnelView> {
        let (core, id) = (self.core.clone(), self.id.clone());
        tokio::spawn(async move { core.tunnel_start(&id).await.unwrap() })
    }

    fn answer(&self, prompt: &TunnelPrompt, text: &str, remember: bool) {
        self.core
            .tunnel_prompt_answer(&prompt.id, Secret::new(text), remember)
            .unwrap();
    }

    /// Whether any file the app wrote holds `text`.
    fn files_hold(&self, text: &str) -> bool {
        fn walk(dir: &Path, text: &str) -> bool {
            std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .any(|entry| {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(&path, text)
                    } else {
                        std::fs::read(&path)
                            .is_ok_and(|bytes| String::from_utf8_lossy(&bytes).contains(text))
                    }
                })
        }
        walk(&self.root.path().join("app"), text)
    }
}

#[tokio::test]
async fn a_tunnel_comes_up_after_the_host_key_and_the_password() {
    let options = FakeSshdOptions {
        password: FIRST.into(),
        ..FakeSshdOptions::default()
    };
    let Some(r) = real(options, false).await else {
        return;
    };
    let fingerprint = r.server.as_ref().unwrap().fingerprint();
    let key = r.server.as_ref().unwrap().known_hosts_line();
    let starting = r.start_in_background();

    let host_key = r.prompt_after(None).await;
    assert_eq!(host_key.kind, PromptKind::HostKey);
    assert!(host_key.text.contains(&fingerprint), "{}", host_key.text);
    assert!(!host_key.can_remember);
    r.answer(&host_key, "", false);

    let password = r.prompt_after(Some(&host_key.id)).await;
    assert_eq!(password.kind, PromptKind::Password);
    r.answer(&password, FIRST, false);

    let view = tokio::time::timeout(LIMIT, starting)
        .await
        .unwrap()
        .unwrap();
    assert!(view.state.is_up(), "{:?}, log {:?}", view.state, view.log);
    let written = std::fs::read_to_string(&r.known_hosts).unwrap();
    let blob = key.split_whitespace().nth(2).unwrap();
    assert!(
        written.contains(blob),
        "ssh did not keep the trusted key: {written}"
    );
    r.core.tunnel_stop(&r.id).await.unwrap();
}

#[tokio::test]
async fn a_remembered_password_is_replayed_and_a_wrong_one_asked_again() {
    let options = FakeSshdOptions {
        password: FIRST.into(),
        ..FakeSshdOptions::default()
    };
    let Some(mut r) = real(options, true).await else {
        return;
    };
    let starting = r.start_in_background();
    let prompt = r.prompt_after(None).await;
    assert!(prompt.can_remember);
    r.answer(&prompt, FIRST, true);
    assert!(tokio::time::timeout(LIMIT, starting)
        .await
        .unwrap()
        .unwrap()
        .state
        .is_up());
    r.core.tunnel_stop(&r.id).await.unwrap();

    // The second start needs no person.
    let view = tokio::time::timeout(LIMIT, r.core.tunnel_start(&r.id))
        .await
        .expect("the remembered password was not replayed")
        .unwrap();
    assert!(view.state.is_up(), "{:?}, log {:?}", view.state, view.log);
    r.core.tunnel_stop(&r.id).await.unwrap();

    // The server's password changes: the remembered one is wrong once, then the person is asked.
    let old = r.server.take().unwrap();
    let addr = old.addr();
    old.stop().await;
    let changed = FakeSshdOptions {
        password: SECOND.into(),
        ..FakeSshdOptions::default()
    };
    r.server = Some(FakeSshd::start_on(addr, changed).await.unwrap());
    let starting = r.start_in_background();
    let again = r.prompt_after(None).await;
    assert_eq!(again.kind, PromptKind::Password);
    r.answer(&again, SECOND, false);
    let view = tokio::time::timeout(LIMIT, starting)
        .await
        .unwrap()
        .unwrap();
    assert!(view.state.is_up(), "{:?}, log {:?}", view.state, view.log);

    for secret in [FIRST, SECOND] {
        assert!(!r.files_hold(secret), "{secret} reached a file");
        assert!(
            !view.log.iter().any(|line| line.contains(secret)),
            "{secret} reached the log"
        );
    }
    r.core.tunnel_stop(&r.id).await.unwrap();
    // The wrong password was forgotten and the new one was not kept: the next start asks.
    let starting = r.start_in_background();
    let asked = r.prompt_after(None).await;
    assert_eq!(asked.kind, PromptKind::Password);
    r.core.tunnel_prompt_cancel(&asked.id).unwrap();
    let _ = tokio::time::timeout(LIMIT, starting).await;
}

#[tokio::test]
async fn a_cancelled_prompt_fails_the_tunnel() {
    let Some(r) = real(FakeSshdOptions::default(), true).await else {
        return;
    };
    let starting = r.start_in_background();
    let prompt = r.prompt_after(None).await;
    r.core.tunnel_prompt_cancel(&prompt.id).unwrap();
    let view = tokio::time::timeout(LIMIT, starting)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(view.state, TunnelState::Failed { .. }),
        "{:?}, log {:?}",
        view.state,
        view.log
    );
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        matches!(r.view().state, TunnelState::Failed { .. }),
        "it started again"
    );
}

#[tokio::test]
async fn a_keyboard_interactive_code_is_asked_as_other() {
    let options = FakeSshdOptions {
        method: AuthMethod::KeyboardInteractive,
        code: Some("123456".into()),
        ..FakeSshdOptions::default()
    };
    let Some(r) = real(options, true).await else {
        return;
    };
    let starting = r.start_in_background();
    let password = r.prompt_after(None).await;
    assert_eq!(password.kind, PromptKind::Password);
    assert!(
        password.text.contains(PASSWORD_PROMPT.trim()),
        "{}",
        password.text
    );
    r.answer(&password, "pw", false);
    let code = r.prompt_after(Some(&password.id)).await;
    assert_eq!(code.kind, PromptKind::Other);
    assert!(code.text.contains(CODE_PROMPT.trim()), "{}", code.text);
    assert!(!code.can_remember);
    r.answer(&code, "123456", false);
    let view = tokio::time::timeout(LIMIT, starting)
        .await
        .unwrap()
        .unwrap();
    assert!(view.state.is_up(), "{:?}, log {:?}", view.state, view.log);
    r.core.tunnel_stop(&r.id).await.unwrap();
}

#[tokio::test]
async fn the_server_going_away_reconnects_and_comes_back() {
    let Some(mut r) = real(FakeSshdOptions::default(), true).await else {
        return;
    };
    let _hold = r.core.tunnel_hold_for_test(&r.id);
    let starting = r.start_in_background();
    let prompt = r.prompt_after(None).await;
    r.answer(&prompt, "pw", true);
    assert!(tokio::time::timeout(LIMIT, starting)
        .await
        .unwrap()
        .unwrap()
        .state
        .is_up());

    let old = r.server.take().unwrap();
    let addr = old.addr();
    old.stop().await;
    r.until("reconnecting", |v| {
        matches!(v.state, TunnelState::Reconnecting { .. })
    })
    .await;
    r.server = Some(
        FakeSshd::start_on(addr, FakeSshdOptions::default())
            .await
            .unwrap(),
    );
    r.until("up again", |v| v.state.is_up()).await;
    r.core.tunnel_stop(&r.id).await.unwrap();
}
