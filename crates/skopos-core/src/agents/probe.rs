//! Agent probes (spec §4.2): start the agent as a chat would, with a scratch folder, send
//! `initialize` and `session/new` without MCP servers, then end it.

use std::path::Path;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::mpsc;

use super::acp::{AcpSession, StartError};
use super::registry::{AgentSpec, AgentState, AgentStatus};
use super::spawn;
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::paths::create_private_dir;

/// How long an agent may take to answer `initialize` and `session/new`.
pub const PROBE_LIMIT: Duration = Duration::from_secs(20);

/// Probes the agent `command` starts, in `cwd`, within `PROBE_LIMIT`. `name` fills the
/// no-answer reason.
pub async fn probe(command: Command, cwd: &Path, name: &str) -> AgentState {
    probe_within(command, cwd, name, PROBE_LIMIT).await
}

/// `probe` with its own time limit, for tests.
pub async fn probe_within(command: Command, cwd: &Path, name: &str, limit: Duration) -> AgentState {
    // A probe shows no updates.
    let (updates, _) = mpsc::channel(1);
    match tokio::time::timeout(
        limit,
        AcpSession::open(command, name, cwd, None, None, updates, None),
    )
    .await
    {
        Ok(Ok(session)) => {
            session.close().await;
            AgentState::Ready
        }
        Ok(Err(StartError::SignInNeeded)) => AgentState::SignInNeeded,
        Ok(Err(StartError::Failed(reason))) => AgentState::DoesNotStart { reason },
        // Dropping the start ends the agent's process group.
        Err(_) => AgentState::DoesNotStart {
            reason: format!("{name} didn't answer within {} seconds.", limit.as_secs()),
        },
    }
}

impl AppCore {
    /// Probes agent `id` and keeps its state for the app run (spec §4.2), then returns its
    /// status.
    pub async fn agent_probe(&self, id: &str) -> CoreResult<AgentStatus> {
        match self.agent_spec(id) {
            Ok(agent) => {
                let state = self.probe_agent(&agent).await?;
                self.agent_probes().set(id, state);
            }
            // Not installed: the status says so, and there is nothing to start.
            Err(error) if error.code == ErrorCode::InvalidInput => {}
            Err(error) => return Err(error),
        }
        self.agents_status()?
            .into_iter()
            .find(|status| status.id == id)
            .ok_or_else(|| {
                IpcError::new(ErrorCode::NotFound, "That agent is no longer in the list.")
            })
    }

    /// Probes `agent` natively, in its scratch folder, with the app's environment.
    async fn probe_agent(&self, agent: &AgentSpec) -> CoreResult<AgentState> {
        let agent_dir = self.data_dir().join("agents").join("probe").join(&agent.id);
        create_private_dir(&agent_dir)?;
        let env = spawn::agent_env(spawn::app_env(), agent, &[]);
        let command = spawn::agent_command(agent, &agent_dir, env);
        Ok(probe(command, &agent_dir, &agent.name).await)
    }
}
