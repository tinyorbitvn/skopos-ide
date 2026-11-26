//! `run_in_terminal` (native agents spec §5.3): one shell command in the cluster's Agent
//! terminal, through the chat's change gate. Like every change it asks under `Ask every time`,
//! is refused under `Read only` and runs at once under `Don't ask`.

use std::time::Duration;

use rmcp::model::Tool;
use serde_json::json;
use tokio::sync::watch;

use super::changes::{
    clock_time, input_schema, not_connected_text, one_line, read_only_text, summary_property,
    ChatGate, DENIED, STOPPED,
};
use super::{ChangeOutcome, ScopeCluster, ToolScope};
use crate::agents::approvals::{
    Approvals, ChangeAnswer, ChangeAnswerOrStop, ChangeCard, ChangeState,
};
use crate::agents::terminal::shell::shell_command;
use crate::agents::terminal::{RunEnd, RunRequest, Stop};
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::prefs::{AgentChanges, ClusterAgentSettings};
use crate::sessions::{random_hex, resolve_shell};
use crate::tools::append_to_path;

pub(super) const RUN_IN_TERMINAL: &str = "run_in_terminal";
const DEFAULT_SECONDS: u64 = 120;
const MAX_SECONDS: u64 = 600;
/// The longest command, in bytes.
const MAX_COMMAND_BYTES: usize = 16 * 1024;
const STOPPED_BY_PERSON: &str = "Stopped by the person.";
const DESCRIPTION: &str = "Run one shell command on this computer in the cluster's Agent terminal, with KUBECONFIG set to the cluster's kubeconfig, and get its exit code and output (the last 64 KiB, colours removed). Each command starts a new shell in the chat's working folder, so cd and variables do not carry to the next one. The person sees the command and its output in the dock and may type into it. Each command counts as a change: it may wait for the person's approval, and the person may deny or stop it.";

pub(super) fn terminal_tool(scope: &ToolScope) -> Tool {
    let properties = json!({
        "command": {
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_COMMAND_BYTES,
            "description": "The shell command, as you would type it in a terminal.",
        },
        "timeout_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_SECONDS,
            "default": DEFAULT_SECONDS,
        },
        "summary": summary_property(),
    });
    Tool::new(
        RUN_IN_TERMINAL,
        DESCRIPTION,
        input_schema(properties, &["command"], scope),
    )
}

pub(super) fn terminal_seconds(asked: Option<u64>) -> u64 {
    asked.unwrap_or(DEFAULT_SECONDS).clamp(1, MAX_SECONDS)
}

pub(super) fn terminal_off_text(cluster: &str) -> String {
    format!("Terminal commands are off for {cluster}.")
}

fn timeout_text(seconds: u64) -> String {
    format!("The command did not finish within {seconds} seconds.")
}

fn disconnected_text(cluster: &str) -> String {
    format!("{cluster} was disconnected.")
}

/// `head`, then a blank line and the output when there is any.
fn with_output(head: &str, output: &str) -> String {
    if output.is_empty() {
        head.to_owned()
    } else {
        format!("{head}\n\n{output}")
    }
}

#[derive(Clone, Copy)]
enum Approval {
    WithoutAsking { standing: bool },
    Asked { standing: bool },
}

/// A running command's card. Dropped before the command ended, because the agent's call went
/// away, it draws the card stopped.
struct RunningCard<'a> {
    approvals: &'a Approvals,
    card: ChangeCard,
    armed: bool,
}

impl Drop for RunningCard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let mut card = self.card.clone();
            card.state = ChangeState::StoppedRunning;
            self.approvals.show_now(card);
        }
    }
}

impl ChatGate {
    pub(super) async fn run_terminal(
        &self,
        cluster: &ScopeCluster,
        command: &str,
        timeout_seconds: u64,
        summary: &str,
    ) -> ChangeOutcome {
        let settings = match terminal_allowed(&self.core, &self.scope, cluster, command) {
            Ok(settings) => settings,
            Err(text) => return ChangeOutcome::Refused { text },
        };
        let card = ChangeCard {
            id: random_hex(),
            cluster: cluster.name.clone(),
            title: format!("Run a command on {}", cluster.name),
            summary: one_line(summary),
            diff: Vec::new(),
            command: Some(vec![command.to_owned()]),
            secrets: Vec::new(),
            state: ChangeState::Waiting,
            result: None,
            rollout: None,
            output: None,
            terminal: Some(cluster.id.clone()),
        };
        let approval = if matches!(settings.changes, AgentChanges::DontAsk) {
            Approval::WithoutAsking { standing: false }
        } else if self.approvals.standing(&cluster.id) {
            Approval::WithoutAsking { standing: true }
        } else {
            match self.approvals.ask(card.clone()).await {
                ChangeAnswerOrStop::Answer(ChangeAnswer::Approve) => {
                    Approval::Asked { standing: false }
                }
                ChangeAnswerOrStop::Answer(ChangeAnswer::ApproveForChat) => {
                    self.approvals.grant_standing(&cluster.id);
                    Approval::Asked { standing: true }
                }
                ChangeAnswerOrStop::Answer(ChangeAnswer::Deny) => {
                    return self.ended(card, ChangeState::Denied, DENIED).await
                }
                ChangeAnswerOrStop::Stopped => {
                    return self.ended(card, ChangeState::Stopped, STOPPED).await
                }
            }
        };
        let request = match self.terminal_request(cluster, &card.id, command, timeout_seconds) {
            Ok(request) => request,
            Err(message) => {
                let mut card = card;
                card.state = ChangeState::Failed {
                    message: message.clone(),
                };
                self.approvals.show(card).await;
                return ChangeOutcome::Refused { text: message };
            }
        };
        let mut running = RunningCard {
            approvals: &self.approvals,
            card,
            armed: true,
        };
        running.card.state = ChangeState::Running;
        // The card shows Running at once, so that no answer button is left on an approved
        // command. A command queued behind another can be stopped from it as well.
        self.approvals.show(running.card.clone()).await;
        let terminal = self.terminals.get(&cluster.id);
        let (lines, mut fresh_lines) = watch::channel(String::new());
        let run = terminal.run(request, lines);
        tokio::pin!(run);
        let result = loop {
            tokio::select! {
                result = &mut run => break result,
                Ok(()) = fresh_lines.changed() => {
                    running.card.output = Some(fresh_lines.borrow_and_update().clone());
                    self.approvals.show(running.card.clone()).await;
                }
            }
        };
        running.armed = false;
        let mut card = running.card.clone();
        card.output = (!result.lines.is_empty()).then(|| result.lines.clone());
        let (state, outcome) = match &result.end {
            RunEnd::Exited(code) => {
                let line = format!("exit {code}");
                card.result = Some(line.clone());
                let state = match approval {
                    Approval::WithoutAsking { standing } => {
                        ChangeState::AppliedWithoutAsking { standing }
                    }
                    Approval::Asked { standing } => ChangeState::Approved {
                        at: clock_time(),
                        standing,
                    },
                };
                let text = with_output(&line, &result.text);
                (state, ChangeOutcome::Applied { text })
            }
            RunEnd::TimedOut => {
                let message = timeout_text(timeout_seconds);
                let text = with_output(&message, &result.text);
                (
                    ChangeState::Failed { message },
                    ChangeOutcome::Refused { text },
                )
            }
            RunEnd::Stopped(Stop::Person) => (
                ChangeState::StoppedRunning,
                ChangeOutcome::Refused {
                    text: with_output(STOPPED_BY_PERSON, &result.text),
                },
            ),
            RunEnd::Stopped(Stop::Chat) => (
                ChangeState::StoppedRunning,
                ChangeOutcome::Refused {
                    text: with_output(STOPPED, &result.text),
                },
            ),
            RunEnd::Stopped(Stop::Disconnected) => {
                let message = disconnected_text(&cluster.name);
                let text = with_output(&message, &result.text);
                (
                    ChangeState::Failed { message },
                    ChangeOutcome::Refused { text },
                )
            }
            RunEnd::Failed(message) => (
                ChangeState::Failed {
                    message: message.clone(),
                },
                ChangeOutcome::Refused {
                    text: message.clone(),
                },
            ),
        };
        card.state = state;
        self.approvals.show(card).await;
        outcome
    }

    /// The process to start: the terminal shell, the cluster's kubeconfig (the local
    /// terminal's, `cluster_kubeconfig_path`), the chat's work folder, the managed tools on
    /// `PATH`.
    fn terminal_request(
        &self,
        cluster: &ScopeCluster,
        card_id: &str,
        command: &str,
        timeout_seconds: u64,
    ) -> Result<RunRequest, String> {
        let kubeconfig = self
            .core
            .cluster_kubeconfig_path(&cluster.id)
            .map_err(|_| not_connected_text(&cluster.name))?;
        let token = self
            .core
            .cluster_cancel_token(&cluster.id)
            .map_err(|_| not_connected_text(&cluster.name))?;
        let (core, scope) = (self.core.clone(), self.scope.clone());
        let (recheck_cluster, recheck_command) = (cluster.clone(), command.to_owned());
        let shell = resolve_shell(self.core.prefs_get().terminal_shell.as_deref());
        let (program, args) = shell_command(&shell, command, cfg!(windows));
        Ok(RunRequest {
            card_id: card_id.to_owned(),
            command: command.to_owned(),
            program,
            args,
            kubeconfig,
            cwd: self.work_dir.clone(),
            path: append_to_path(
                std::env::var_os("PATH").as_deref(),
                &self.core.tools().managed_dirs(),
            ),
            timeout: Duration::from_secs(timeout_seconds),
            cluster: token,
            recheck: Box::new(move || {
                terminal_allowed(&core, &scope, &recheck_cluster, &recheck_command).map(|_| ())
            }),
        })
    }
}

/// The refusals of spec §5.3 in order; the cluster's settings when none applies. Run when the
/// call comes and again when the command takes its turn.
fn terminal_allowed(
    core: &AppCore,
    scope: &ToolScope,
    cluster: &ScopeCluster,
    command: &str,
) -> Result<ClusterAgentSettings, String> {
    if !scope.clusters.iter().any(|known| known.id == cluster.id) {
        return Err(format!(
            "{} is not one of this chat's clusters.",
            cluster.name
        ));
    }
    let settings = core.cluster_agent_settings(&cluster.id);
    if matches!(settings.changes, AgentChanges::ReadOnly) {
        return Err(read_only_text(&cluster.name));
    }
    if !settings.terminal {
        return Err(terminal_off_text(&cluster.name));
    }
    if !matches!(
        core.cluster_state(&cluster.id),
        ConnectionState::Connected { .. }
    ) {
        return Err(not_connected_text(&cluster.name));
    }
    if command.trim().is_empty() {
        return Err("Give the command to run.".to_owned());
    }
    if command.len() > MAX_COMMAND_BYTES {
        return Err("The command is longer than 16 KiB.".to_owned());
    }
    Ok(settings)
}
