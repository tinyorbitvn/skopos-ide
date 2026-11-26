//! `run_in_terminal` through a real chat gate on the fake cluster, with real local shells
//! (native agents spec §5.3, §5.4).

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::{Peer, RoleClient, ServiceExt};
use serde_json::{json, Value};
use skopos_core::agents::approvals::{Approvals, ChangeAnswer, ChangeCard, ChangeState};
use skopos_core::agents::mcp::changes::ChatGate;
use skopos_core::agents::mcp::{
    serve_mcp, ChangeGate, ChangeRequest, ChangeTool, ScopeCluster, ToolContext, ToolScope,
};
use skopos_core::agents::terminal::AgentTerminals;
use skopos_core::app_core::AppCore;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::{AgentChanges, ClusterAgentSettings, ClusterSettings, Prefs};
use skopos_fakekube::FakeKubeConfig;
use support::connected_fake;
use tempfile::TempDir;
use tokio::sync::mpsc;

const CLUSTER: &str = "fake";
const WAIT: Duration = Duration::from_secs(20);

fn script(unix: &str, windows: &str) -> String {
    if cfg!(windows) { windows } else { unix }.to_owned()
}

fn sleep_30() -> String {
    script("sleep 30", "ping -n 31 127.0.0.1 >NUL")
}

struct Chat {
    client: RunningService<RoleClient, ()>,
    cards: mpsc::Receiver<ChangeCard>,
    approvals: Arc<Approvals>,
    terminals: Arc<AgentTerminals>,
    gate: Arc<ChatGate>,
    work: TempDir,
}

impl Chat {
    async fn start(core: &AppCore, id: &ClusterId, global: bool) -> Chat {
        core.prefs_set(Prefs {
            terminal_shell: Some(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.to_owned()),
            ..core.prefs_get()
        })
        .unwrap();
        let scope = ToolScope {
            clusters: vec![ScopeCluster {
                id: id.clone(),
                name: CLUSTER.to_owned(),
            }],
            global,
        };
        let work = tempfile::tempdir().unwrap();
        let (change_cards, cards) = mpsc::channel(256);
        let approvals = Approvals::new(change_cards);
        let terminals = AgentTerminals::new();
        let gate = Arc::new(ChatGate {
            core: core.clone(),
            approvals: approvals.clone(),
            scope: scope.clone(),
            terminals: terminals.clone(),
            work_dir: work.path().to_path_buf(),
        });
        let (tool_cards, mut read_cards) = mpsc::channel(64);
        tokio::spawn(async move { while read_cards.recv().await.is_some() {} });
        let context = Arc::new(ToolContext {
            core: core.clone(),
            scope,
            cards: tool_cards,
            gate: gate.clone(),
            tabs: skopos_core::agents::tabs::EditorTabs::new(mpsc::channel(1).0),
        });
        let (server_end, client_end) = tokio::io::duplex(1 << 20);
        tokio::spawn(serve_mcp(Box::new(server_end), context));
        let client = ().serve(client_end).await.unwrap();
        Chat {
            client,
            cards,
            approvals,
            terminals,
            gate,
            work,
        }
    }

    fn work_dir(&self) -> PathBuf {
        self.work.path().to_path_buf()
    }

    async fn call(&self, args: Value) -> (bool, String) {
        call_with(self.client.peer(), args).await
    }

    fn call_in_background(&self, args: Value) -> tokio::task::JoinHandle<(bool, String)> {
        let peer = self.client.peer().clone();
        tokio::spawn(async move { call_with(&peer, args).await })
    }

    async fn next_card(&mut self) -> ChangeCard {
        tokio::time::timeout(WAIT, self.cards.recv())
            .await
            .expect("no change card came")
            .expect("the card stream closed")
    }

    /// Skips cards until one is in a state `wanted` accepts.
    async fn card_until(&mut self, wanted: impl Fn(&ChangeState) -> bool) -> ChangeCard {
        loop {
            let card = self.next_card().await;
            if wanted(&card.state) {
                return card;
            }
        }
    }

    async fn tool_names(&self) -> Vec<String> {
        self.client
            .list_all_tools()
            .await
            .unwrap()
            .into_iter()
            .map(|tool| tool.name.into_owned())
            .collect()
    }
}

/// Whether the call failed, and the text it answered with (as in `fake_agent_changes.rs`).
async fn call_with(peer: &Peer<RoleClient>, args: Value) -> (bool, String) {
    let Value::Object(args) = args else {
        panic!("the arguments must be an object");
    };
    let result = peer
        .call_tool(CallToolRequestParams::new("run_in_terminal".to_owned()).with_arguments(args))
        .await
        .unwrap();
    let text = result
        .content
        .iter()
        .filter_map(|block| block.as_text())
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (result.is_error == Some(true), text)
}

fn set_agent(core: &AppCore, id: &ClusterId, agent: ClusterAgentSettings) {
    let settings = ClusterSettings {
        agent,
        ..core.cluster_settings_get(id)
    };
    core.cluster_settings_set(id, settings).unwrap();
}

fn terminal_on(changes: AgentChanges) -> ClusterAgentSettings {
    ClusterAgentSettings {
        changes,
        terminal: true,
        ..ClusterAgentSettings::default()
    }
}

#[tokio::test]
async fn run_in_terminal_is_listed_only_with_terminal_on_and_not_read_only() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let chat = Chat::start(&core, &id, false).await;
    assert!(!chat
        .tool_names()
        .await
        .contains(&"run_in_terminal".to_owned()));
    set_agent(&core, &id, terminal_on(AgentChanges::Ask));
    assert!(chat
        .tool_names()
        .await
        .contains(&"run_in_terminal".to_owned()));
    set_agent(&core, &id, terminal_on(AgentChanges::ReadOnly));
    assert!(!chat
        .tool_names()
        .await
        .contains(&"run_in_terminal".to_owned()));
    let global = Chat::start(&core, &id, true).await;
    assert!(!global
        .tool_names()
        .await
        .contains(&"run_in_terminal".to_owned()));
    assert_eq!(
        global
            .call(json!({ "cluster": CLUSTER, "command": "echo x" }))
            .await,
        (true, "Changes to fake are read only for agents.".to_owned())
    );
}

#[tokio::test]
async fn a_call_for_a_cluster_with_terminal_off_is_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let chat = Chat::start(&core, &id, false).await;
    assert_eq!(
        chat.call(json!({ "command": "echo x" })).await,
        (true, "Terminal commands are off for fake.".to_owned())
    );
}

#[tokio::test]
async fn an_empty_or_long_command_is_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let chat = Chat::start(&core, &id, false).await;
    assert_eq!(
        chat.call(json!({ "command": "  " })).await,
        (true, "Give the command to run.".to_owned())
    );
    let long = format!("echo {}", "a".repeat(16 * 1024));
    assert_eq!(
        chat.call(json!({ "command": long })).await,
        (true, "The command is longer than 16 KiB.".to_owned())
    );
}

#[tokio::test]
async fn under_ask_nothing_runs_before_an_answer() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::Ask));
    let mut chat = Chat::start(&core, &id, false).await;
    let marker = chat.work_dir().join("ran");
    let command = script("echo ran > ran && echo done", "echo ran > ran & echo done");
    let call = chat.call_in_background(json!({ "command": command, "summary": "Mark it" }));
    let card = chat.next_card().await;
    assert_eq!(card.state, ChangeState::Waiting);
    assert_eq!(card.title, "Run a command on fake");
    assert_eq!(card.command, Some(vec![command.clone()]));
    assert_eq!(card.terminal, Some(id.clone()));
    assert_eq!(card.summary, "Mark it");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!marker.exists(), "the command ran before the answer");
    chat.approvals
        .answer(&card.id, ChangeAnswer::Approve)
        .unwrap();
    assert_eq!(chat.next_card().await.state, ChangeState::Running);
    let done = chat
        .card_until(|state| matches!(state, ChangeState::Approved { .. }))
        .await;
    assert_eq!(done.result.as_deref(), Some("exit 0"));
    assert!(done.output.as_deref().unwrap_or_default().contains("done"));
    let (failed, text) = call.await.unwrap();
    assert!(!failed, "{text}");
    assert!(text.starts_with("exit 0\n\n"), "{text}");
    assert!(marker.exists());
}

#[tokio::test]
async fn deny_runs_nothing() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::Ask));
    let mut chat = Chat::start(&core, &id, false).await;
    let marker = chat.work_dir().join("ran");
    let call = chat.call_in_background(json!({ "command": "echo ran > ran" }));
    let card = chat.next_card().await;
    chat.approvals.answer(&card.id, ChangeAnswer::Deny).unwrap();
    assert_eq!(chat.next_card().await.state, ChangeState::Denied);
    assert_eq!(
        call.await.unwrap(),
        (true, "The person denied this change.".to_owned())
    );
    assert!(!marker.exists());
}

#[tokio::test]
async fn under_dont_ask_it_runs_at_once_with_the_clusters_kubeconfig() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let mut chat = Chat::start(&core, &id, false).await;
    let command = script("echo kc=$KUBECONFIG; pwd", "echo kc=%KUBECONFIG% & cd");
    let (failed, text) = chat.call(json!({ "command": command })).await;
    assert!(!failed, "{text}");
    let kubeconfig = core.cluster_kubeconfig_path(&id).unwrap();
    assert!(
        text.contains(&format!("kc={}", kubeconfig.display())),
        "{text}"
    );
    let work = std::fs::canonicalize(chat.work_dir()).unwrap();
    assert!(
        text.lines()
            .any(|line| std::fs::canonicalize(line.trim()).ok().as_ref() == Some(&work)),
        "{text}"
    );
    assert_eq!(chat.next_card().await.state, ChangeState::Running);
    let done = chat
        .card_until(|state| !matches!(state, ChangeState::Running))
        .await;
    assert_eq!(
        done.state,
        ChangeState::AppliedWithoutAsking { standing: false }
    );
}

#[tokio::test]
async fn a_timeout_ends_the_command_and_says_so() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let mut chat = Chat::start(&core, &id, false).await;
    let (failed, text) = chat
        .call(json!({ "command": sleep_30(), "timeout_seconds": 1 }))
        .await;
    assert!(failed);
    assert!(
        text.starts_with("The command did not finish within 1 seconds."),
        "{text}"
    );
    let done = chat
        .card_until(|state| !matches!(state, ChangeState::Running))
        .await;
    assert_eq!(
        done.state,
        ChangeState::Failed {
            message: "The command did not finish within 1 seconds.".to_owned()
        }
    );
}

#[tokio::test]
async fn stop_ends_the_command_as_the_person() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let mut chat = Chat::start(&core, &id, false).await;
    let call = chat.call_in_background(json!({ "command": sleep_30() }));
    let running = chat
        .card_until(|state| matches!(state, ChangeState::Running))
        .await;
    assert!(chat.terminals.stop_card(&running.id));
    let (failed, text) = call.await.unwrap();
    assert!(failed);
    assert!(text.starts_with("Stopped by the person."), "{text}");
    let done = chat
        .card_until(|state| !matches!(state, ChangeState::Running))
        .await;
    assert_eq!(done.state, ChangeState::StoppedRunning);
}

#[tokio::test]
async fn the_chats_stop_ends_its_running_command() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let mut chat = Chat::start(&core, &id, false).await;
    let call = chat.call_in_background(json!({ "command": sleep_30() }));
    chat.card_until(|state| matches!(state, ChangeState::Running))
        .await;
    chat.terminals.stop_all();
    let (failed, text) = call.await.unwrap();
    assert!(failed);
    assert!(text.starts_with("The chat was stopped."), "{text}");
}

#[tokio::test]
async fn a_call_that_goes_away_ends_its_card_stopped() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let mut chat = Chat::start(&core, &id, false).await;
    let request = ChangeRequest {
        cluster: ScopeCluster {
            id: id.clone(),
            name: CLUSTER.to_owned(),
        },
        tool: ChangeTool::Terminal {
            command: sleep_30(),
            timeout_seconds: 60,
        },
        summary: String::new(),
    };
    let gate = chat.gate.clone();
    let decided = tokio::spawn(async move { gate.decide(request).await });
    chat.card_until(|state| matches!(state, ChangeState::Running))
        .await;
    decided.abort();
    let _ = decided.await;
    let done = chat
        .card_until(|state| !matches!(state, ChangeState::Running))
        .await;
    assert_eq!(done.state, ChangeState::StoppedRunning);
}

#[cfg(unix)]
#[tokio::test]
async fn the_agent_gets_the_last_64_kib_of_a_long_output() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let chat = Chat::start(&core, &id, false).await;
    let (failed, text) = chat
        .call(json!({ "command": "head -c 70000 /dev/zero | tr '\\0' a; echo; echo END" }))
        .await;
    assert!(!failed, "{}", &text[..80.min(text.len())]);
    assert!(
        text.starts_with("exit 0\n\n[earlier output cut]\n"),
        "{}",
        &text[..80]
    );
    assert!(text.trim_end().ends_with("END"));
    assert!(text.len() <= "exit 0\n\n[earlier output cut]\n".len() + 64 * 1024);
}

#[tokio::test]
async fn colour_codes_do_not_reach_the_agent() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    set_agent(&core, &id, terminal_on(AgentChanges::DontAsk));
    let chat = Chat::start(&core, &id, false).await;
    let command = script("printf '\\033[31mred\\033[0m\\n'", "echo red");
    let (failed, text) = chat.call(json!({ "command": command })).await;
    assert!(!failed, "{text}");
    assert!(!text.contains('\x1b'), "{text:?}");
    assert!(text.contains("red"), "{text}");
}
