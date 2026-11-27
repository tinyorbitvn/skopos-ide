//! SSH tunnels with a scripted `ssh` (tunnels spec §6.2, §6.4, §6.5; §6.6 "the state machine
//! with a fake ssh program"). The askpass is `skopos-agent-host`, which runs the app binary's
//! askpass mode.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use skopos_core::app_core::AppCore;
use skopos_core::paths::AppPaths;
use skopos_core::secrets::Secret;
use skopos_core::tools::ToolsConfig;
use skopos_core::tunnels::{
    PromptKind, SshTestHooks, TunnelInput, TunnelKind, TunnelPrompt, TunnelState, TunnelTimings,
    TunnelView,
};
use tempfile::TempDir;

const FAKE_SSH: &str = env!("CARGO_BIN_EXE_skopos-fakessh");
const ASKPASS: &str = env!("CARGO_BIN_EXE_skopos-agent-host");
const LIMIT: Duration = Duration::from_secs(15);

struct Fake {
    core: AppCore,
    id: String,
    plan: PathBuf,
    _root: TempDir,
}

fn timings() -> TunnelTimings {
    TunnelTimings {
        start: Duration::from_secs(10),
        prompt: Duration::from_secs(10),
        idle: Duration::from_secs(60),
        backoff: vec![Duration::from_millis(300)],
        reconnect_wait: Duration::from_millis(500),
    }
}

/// A core with one SSH tunnel, `bastion`, whose `ssh` is the fake following `plan`.
async fn fake(plan: &[&str]) -> Fake {
    fake_with(plan, Vec::new(), timings()).await
}

async fn fake_with(plan: &[&str], env: Vec<(OsString, OsString)>, timings: TunnelTimings) -> Fake {
    let root = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let plan_file = root.path().join("plan");
    std::fs::write(&plan_file, plan.join("\n")).unwrap();
    let mut env = env;
    env.push(("SKOPOS_FAKESSH_PLAN".into(), plan_file.clone().into()));
    core.set_ssh_test_hooks(SshTestHooks {
        askpass: Some(ASKPASS.into()),
        config_file: None,
        env,
    });
    core.set_tunnel_timings_for_test(timings);
    let mut prefs = core.prefs_get();
    prefs.ssh_path = Some(FAKE_SSH.into());
    core.prefs_set(prefs).unwrap();
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
    Fake {
        core,
        id: view.id,
        plan: plan_file,
        _root: root,
    }
}

impl Fake {
    fn view(&self) -> TunnelView {
        self.core
            .tunnel_list()
            .into_iter()
            .find(|t| t.id == self.id)
            .unwrap()
    }

    fn runs(&self) -> usize {
        std::fs::read_to_string(self.plan.with_extension("runs")).map_or(0, |t| t.lines().count())
    }

    fn args(&self) -> Vec<String> {
        std::fs::read_to_string(self.plan.with_extension("args"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// The `-D` port of the last run.
    fn port(&self) -> u16 {
        let last = self.args().pop().unwrap();
        let words: Vec<&str> = last.split_whitespace().collect();
        let at = words.iter().position(|w| *w == "-D").unwrap();
        words[at + 1].rsplit(':').next().unwrap().parse().unwrap()
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
                "timed out waiting for {what}: {:?}",
                view.state
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn prompt(&self) -> TunnelPrompt {
        self.until("a prompt", |v| v.prompt.is_some())
            .await
            .prompt
            .unwrap()
    }

    fn start_in_background(&self) -> tokio::task::JoinHandle<TunnelView> {
        let (core, id) = (self.core.clone(), self.id.clone());
        tokio::spawn(async move { core.tunnel_start(&id).await.unwrap() })
    }
}

fn listening(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn failed(message: &str) -> TunnelState {
    TunnelState::Failed {
        message: message.into(),
    }
}

#[tokio::test]
async fn start_brings_an_ssh_tunnel_up_and_stop_ends_ssh() {
    let f = fake(&["listen ; wait"]).await;
    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert!(view.state.is_up(), "{:?}", view.state);
    let args = f.args().pop().unwrap();
    assert!(args.starts_with("-N -D 127.0.0.1:"), "{args}");
    assert!(
        args.ends_with(
            "-o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -- bastion"
        ),
        "{args}"
    );
    let port = f.port();
    assert!(listening(port));
    let stopped = f.core.tunnel_stop(&f.id).await.unwrap();
    assert_eq!(stopped.state, TunnelState::Idle);
    assert!(!listening(port), "ssh still runs after Stop");
    assert_eq!(f.runs(), 1);
}

#[tokio::test]
async fn the_args_carry_the_fields() {
    let f = fake(&["listen ; wait"]).await;
    let identity = std::env::temp_dir().join("id_test");
    f.core
        .tunnel_save(TunnelInput {
            id: Some(f.id.clone()),
            name: "bastion".into(),
            kind: TunnelKind::Ssh {
                host: "bastion.corp".into(),
                user: Some("me".into()),
                port: Some(2222),
                jump: Some("jump.corp".into()),
                identity_file: Some(identity.to_string_lossy().into_owned()),
            },
        })
        .unwrap();
    f.core.tunnel_start(&f.id).await.unwrap();
    let args = f.args().pop().unwrap();
    let expected = format!(
        "-l me -p 2222 -J jump.corp -i {} -- bastion.corp",
        identity.display()
    );
    assert!(args.ends_with(&expected), "{args}");
    f.core.tunnel_stop(&f.id).await.unwrap();
}

#[tokio::test]
async fn a_start_that_never_comes_up_fails_without_retrying() {
    let line = "ssh: Could not resolve hostname bastion: Name or service not known";
    let f = fake(&[&format!("say {line} ; exit 255")]).await;
    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert_eq!(view.state, failed(line));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(f.runs(), 1, "a start that never came up is not retried");
    assert_eq!(f.view().log, vec![line.to_owned()]);
}

#[tokio::test]
async fn a_drop_while_in_use_reconnects_and_comes_back() {
    let f = fake(&[
        "listen ; sleep 1500 ; say Connection closed by 10.0.0.1 port 22 ; exit 255",
        "listen ; wait",
    ])
    .await;
    let _hold = f.core.tunnel_hold_for_test(&f.id);
    assert!(f.core.tunnel_start(&f.id).await.unwrap().state.is_up());
    f.until("reconnecting", |v| {
        v.state
            == TunnelState::Reconnecting {
                attempt: 1,
                last_error: "Connection closed by 10.0.0.1 port 22".into(),
            }
    })
    .await;
    f.until("up again", |v| v.state.is_up()).await;
    assert_eq!(f.runs(), 2);
    f.core.tunnel_stop(&f.id).await.unwrap();
}

#[tokio::test]
async fn a_start_during_a_reconnect_tries_again_at_once() {
    let slow = TunnelTimings {
        backoff: vec![Duration::from_secs(60)],
        ..timings()
    };
    let f = fake_with(
        &["listen ; sleep 1500 ; exit 255", "listen ; wait"],
        Vec::new(),
        slow,
    )
    .await;
    let _hold = f.core.tunnel_hold_for_test(&f.id);
    assert!(f.core.tunnel_start(&f.id).await.unwrap().state.is_up());
    f.until("reconnecting", |v| {
        matches!(v.state, TunnelState::Reconnecting { .. })
    })
    .await;
    let started = Instant::now();
    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert!(view.state.is_up(), "{:?}", view.state);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "Start waited for the backoff"
    );
    f.core.tunnel_stop(&f.id).await.unwrap();
}

#[tokio::test]
async fn a_drop_while_unused_goes_idle() {
    let f = fake(&["listen ; sleep 1500 ; exit 255", "listen ; wait"]).await;
    assert!(f.core.tunnel_start(&f.id).await.unwrap().state.is_up());
    f.until("idle", |v| v.state == TunnelState::Idle).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(f.runs(), 1, "nothing uses it, so it does not reconnect");
}

#[tokio::test]
async fn a_fatal_exit_fails_even_while_in_use() {
    let f = fake(&["listen ; sleep 1500 ; say Host key verification failed. ; exit 255"]).await;
    let _hold = f.core.tunnel_hold_for_test(&f.id);
    assert!(f.core.tunnel_start(&f.id).await.unwrap().state.is_up());
    f.until("failed", |v| {
        v.state == failed("Host key verification failed.")
    })
    .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(f.runs(), 1);
}

#[tokio::test]
async fn a_taken_port_starts_again_at_once_on_a_new_port() {
    let f = fake(&[
        "say bind [127.0.0.1]:5000: Address already in use ; exit 255",
        "listen ; wait",
    ])
    .await;
    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert!(view.state.is_up(), "{:?}", view.state);
    assert_eq!(f.runs(), 2);
    f.core.tunnel_stop(&f.id).await.unwrap();
}

#[tokio::test]
async fn an_unused_tunnel_stops_after_the_idle_time() {
    let short = TunnelTimings {
        idle: Duration::from_millis(300),
        ..timings()
    };
    let f = fake_with(&["listen ; wait"], Vec::new(), short).await;
    assert!(f.core.tunnel_start(&f.id).await.unwrap().state.is_up());
    let port = f.port();
    f.until("idle", |v| v.state == TunnelState::Idle).await;
    let started = Instant::now();
    while listening(port) {
        assert!(started.elapsed() < LIMIT, "ssh still runs when idle");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn an_old_ssh_is_refused() {
    let env = vec![("SKOPOS_FAKESSH_VERSION".into(), "OpenSSH_8.2p1 fake".into())];
    let f = fake_with(&["listen ; wait"], env, timings()).await;
    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert_eq!(
        view.state,
        failed("This ssh is OpenSSH_8.2p1; SSH tunnels need OpenSSH 8.4 or later")
    );
    assert_eq!(f.runs(), 0);
}

#[tokio::test]
async fn a_bad_or_missing_ssh_says_where_to_fix_it() {
    let f = fake(&["listen ; wait"]).await;
    let missing = std::env::temp_dir().join("no-such-dir").join("ssh");
    let mut prefs = f.core.prefs_get();
    prefs.ssh_path = Some(missing.to_string_lossy().into_owned());
    f.core.prefs_set(prefs.clone()).unwrap();
    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert_eq!(
        view.state,
        failed(&format!(
            "{} is not a program. Fix the ssh path in Preferences › Tools",
            missing.display()
        ))
    );
    prefs.ssh_path = None;
    f.core.prefs_set(prefs).unwrap();
    f.core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(OsString::new()),
        ..ToolsConfig::default()
    });
    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert_eq!(
        view.state,
        failed("ssh was not found on PATH. Install OpenSSH or set its path in Preferences › Tools")
    );
}

#[tokio::test]
async fn the_log_keeps_the_last_50_lines() {
    let says: Vec<String> = (1..=60).map(|n| format!("say line {n}")).collect();
    let f = fake(&[&format!("{} ; exit 255", says.join(" ; "))]).await;
    f.core.tunnel_start(&f.id).await.unwrap();
    let log = f.view().log;
    assert_eq!(log.len(), 50);
    assert_eq!(log.first().map(String::as_str), Some("line 11"));
    assert_eq!(log.last().map(String::as_str), Some("line 60"));
}

#[tokio::test]
async fn a_prompt_reaches_the_person_and_a_remembered_answer_is_replayed() {
    let f = fake(&["ask Enter passphrase for key '/k': ; expect hunter2 ; listen ; wait"]).await;
    let starting = f.start_in_background();
    let prompt = f.prompt().await;
    assert_eq!(prompt.kind, PromptKind::Passphrase);
    assert!(prompt.opens_at_once, "Start is the person's action");
    f.core
        .tunnel_prompt_answer(&prompt.id, Secret::new("hunter2"), true)
        .unwrap();
    assert!(starting.await.unwrap().state.is_up());
    f.core.tunnel_stop(&f.id).await.unwrap();

    let view = f.core.tunnel_start(&f.id).await.unwrap();
    assert!(
        view.state.is_up(),
        "the remembered answer was not replayed: {:?}",
        view.state
    );
    assert_eq!(f.runs(), 2);
    assert!(!view.log.iter().any(|line| line.contains("hunter2")));
    f.core.tunnel_stop(&f.id).await.unwrap();
}

#[tokio::test]
async fn a_cancelled_prompt_fails_the_tunnel() {
    let f = fake(&["ask Password: ; expect pw ; listen ; wait"]).await;
    let starting = f.start_in_background();
    let prompt = f.prompt().await;
    f.core.tunnel_prompt_cancel(&prompt.id).unwrap();
    let view = starting.await.unwrap();
    assert_eq!(
        view.state,
        failed("me@bastion: Permission denied (password).")
    );
    assert_eq!(f.runs(), 1);
}

#[tokio::test]
async fn a_prompt_during_a_reconnect_waits_as_needs_input() {
    let f = fake(&[
        "listen ; sleep 1500 ; exit 255",
        "ask Password: ; expect pw ; listen ; wait",
    ])
    .await;
    let _hold = f.core.tunnel_hold_for_test(&f.id);
    assert!(f.core.tunnel_start(&f.id).await.unwrap().state.is_up());
    let view = f
        .until("needs input", |v| {
            matches!(v.state, TunnelState::NeedsInput { .. })
        })
        .await;
    let prompt = view.prompt.unwrap();
    assert!(!prompt.opens_at_once, "nobody asked for this reconnect");
    f.core
        .tunnel_prompt_answer(&prompt.id, Secret::new("pw"), false)
        .unwrap();
    f.until("up again", |v| v.state.is_up()).await;
    f.core.tunnel_stop(&f.id).await.unwrap();
}
