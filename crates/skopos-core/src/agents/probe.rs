//! Agent probes (spec §4.2): start the agent as a chat would, with a scratch folder, send
//! `initialize` and `session/new` without MCP servers, then end it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::acp::{AcpSession, StartError};
use super::endpoint::{new_token, Endpoint, Listen};
use super::proxy::{self, ProxyConfig, Resolver};
use super::registry::{AgentSpec, AgentState, AgentStatus};
use super::sandbox::env::{agent_env, path_of, proxy_url};
use super::sandbox::paths::kubeconfig_files;
use super::sandbox::spec::PROXY_SOCKET;
use super::sandbox::{
    build_spec, direct_command, sandbox_command, ChatPorts, SandboxStatus, SpecInput,
};
use super::settings::expand_home;
use crate::app_core::AppCore;
use crate::catalog::ClusterSource;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::paths::create_private_dir;
use crate::sessions::random_hex;

/// How long an agent may take to answer `initialize` and `session/new`.
pub const PROBE_LIMIT: Duration = Duration::from_secs(20);
const SANDBOX_NOT_READY: &str = "The agent sandbox isn't ready.";

/// Probes the agent `command` starts, in `cwd`, within `PROBE_LIMIT`. `name` fills the
/// no-answer reason.
pub async fn probe(command: Command, cwd: &Path, name: &str) -> AgentState {
    probe_within(command, cwd, name, PROBE_LIMIT).await
}

/// `probe` with its own time limit, for tests.
pub async fn probe_within(command: Command, cwd: &Path, name: &str, limit: Duration) -> AgentState {
    // A probe shows no updates.
    let (updates, _) = mpsc::channel(1);
    match tokio::time::timeout(limit, AcpSession::open(command, cwd, None, None, updates)).await {
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
    /// status. `Unsupported` on Windows.
    pub async fn agent_probe(&self, id: &str) -> CoreResult<AgentStatus> {
        super::supported()?;
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

    /// Probes `agent` in its scratch folder and a run folder of its own, which goes after.
    async fn probe_agent(&self, agent: &AgentSpec) -> CoreResult<AgentState> {
        let agents = self.data_dir().join("agents");
        let agent_dir = agents.join("probe").join(&agent.id);
        create_private_dir(&agent_dir)?;
        let run_dir = agents.join("run").join(&random_hex()[..8]);
        create_private_dir(&run_dir)?;
        create_private_dir(&run_dir.join("tmp"))?;
        let state = self.probe_in(agent, &agent_dir, &run_dir).await;
        if let Err(error) = std::fs::remove_dir_all(&run_dir) {
            tracing::warn!("cannot remove {}: {error}", run_dir.display());
        }
        state
    }

    async fn probe_in(
        &self,
        agent: &AgentSpec,
        agent_dir: &Path,
        run_dir: &Path,
    ) -> CoreResult<AgentState> {
        let sandboxed = !self.agent_sandbox_off();
        if sandboxed
            && !matches!(
                self.agent_sandbox_status(false).await,
                SandboxStatus::Ready { .. }
            )
        {
            return Err(IpcError::new(ErrorCode::InvalidInput, SANDBOX_NOT_READY));
        }
        let endpoint = Endpoint::bind(proxy_listen(sandboxed, run_dir)).await?;
        let ports = match endpoint.port() {
            Some(port) => ChatPorts {
                proxy: port,
                mcp: port,
            },
            None => ChatPorts::LINUX_SANDBOX,
        };
        let token = new_token();
        let prefs = self.agent_prefs();
        let home = self.home_dir().to_path_buf();
        let tmp_dir = run_dir.join("tmp");
        let env = agent_env(
            &|name: &str| std::env::var(name).ok(),
            agent,
            &proxy_url(&token, ports.proxy),
            &tmp_dir,
            &home,
        );
        let catalog: Vec<PathBuf> = self
            .catalog_list()
            .into_iter()
            .map(|entry| match entry.source {
                ClusterSource::Synced { path } | ClusterSource::Pasted { path } => {
                    PathBuf::from(path)
                }
            })
            .collect();
        let kubeconfigs = kubeconfig_files(
            &self.prefs_get().sync_sources,
            &catalog,
            std::env::var_os("KUBECONFIG").as_deref(),
        );
        let spec = build_spec(SpecInput {
            agent,
            agent_dir: agent_dir.to_path_buf(),
            run_dir: run_dir.to_path_buf(),
            home: &home,
            folders: prefs
                .folders
                .iter()
                .map(|folder| expand_home(folder, &home))
                .collect(),
            kubeconfigs,
            app_binary: std::env::current_exe()?,
            path_var: path_of(&env),
            env,
        });
        let command = if sandboxed {
            sandbox_command(&spec, ports)?
        } else {
            direct_command(&spec)
        };
        let mut hosts = agent.hosts.clone();
        hosts.extend(prefs.domains.iter().cloned());
        let config = ProxyConfig {
            token,
            hosts,
            resolve: Resolver::System,
        };
        // No chat is open to show a blocked host in.
        let (blocked, _) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let proxy = tokio::spawn(proxy::serve(endpoint, config, blocked, stop.clone()));
        let state = probe(command, agent_dir, &agent.name).await;
        stop.cancel();
        let _ = proxy.await;
        Ok(state)
    }
}

/// Linux's sandbox reaches the proxy through `proxy.sock` in the run folder (R3); macOS's,
/// and an agent without a sandbox, through an ephemeral `127.0.0.1` port.
fn proxy_listen(sandboxed: bool, run_dir: &Path) -> Listen {
    if sandboxed && cfg!(target_os = "linux") {
        Listen::Unix(run_dir.join(PROXY_SOCKET))
    } else {
        Listen::Tcp
    }
}
