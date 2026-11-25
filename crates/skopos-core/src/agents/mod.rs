//! AI agents (agents spec 2026-11-22): the agent CLIs the person installed, run natively as the
//! person's own processes on Linux, macOS and Windows (native agents spec §4.1, §4.2), with a
//! kubeconfig of only their chat's clusters and SkoposIDE's tools.

pub mod acp;
pub mod approvals;
pub mod bridge;
pub mod chat;
pub mod chats;
pub mod diff;
pub mod editor_tab;
pub mod endpoint;
pub mod events;
pub mod known_folders;
pub(crate) mod kubeconfig;
pub mod mcp;
pub mod modes;
pub mod permissions;
pub mod probe;
pub mod prompt;
pub mod registry;
pub mod settings;
pub mod spawn;
pub mod tabs;

use std::ffi::OsString;
use std::path::PathBuf;

use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::prefs::{AgentChanges, AgentPrefs, ClusterAgentSettings, CustomAgent};
use crate::sessions::random_hex;
use known_folders::known_folders;
use registry::{
    default_agent, listed, resolve_custom, status_of, AgentSpec, AgentStatus, Listed, Resolved,
};

const NAME_AND_COMMAND: &str = "Enter a name and a command.";
/// An id no listed agent has, or a built-in agent's id given to a call for the person's.
const UNKNOWN_AGENT: &str = "That agent is no longer in the list.";

impl AppCore {
    /// The agent settings of Preferences.
    pub fn agent_prefs(&self) -> AgentPrefs {
        self.prefs_get().agents
    }

    /// Sets only what agents may change in `id` (Preferences → Agent changes, spec §4.8):
    /// no event, and the metrics caches and the keychain are left alone.
    pub fn cluster_agent_changes_set(
        &self,
        id: &ClusterId,
        changes: AgentChanges,
    ) -> CoreResult<()> {
        self.cluster_settings_update(id, |settings| settings.agent.changes = changes)
    }

    /// The agent settings of `id` as saved now, so a change applies to the next tool call
    /// of a running chat (spec §4.5).
    pub fn cluster_agent_settings(&self, id: &ClusterId) -> ClusterAgentSettings {
        self.cluster_settings_get(id).agent
    }

    /// Preferences → Agents (spec §3.5): the built-in agents, then the person's in the order
    /// added, each found on PATH, in a known install folder, or not. Nothing runs here: an installed agent shows the
    /// state its last probe of this app run gave (spec §4.2), `Unknown` before one.
    pub fn agents_status(&self) -> CoreResult<Vec<AgentStatus>> {
        let prefs = self.agent_prefs();
        let path_var = self.agent_path_var();
        let folders = self.agent_folders();
        let home = self.home_dir();
        let mut statuses: Vec<AgentStatus> = listed(&prefs)
            .iter()
            .map(|agent| {
                let resolved = agent.resolve(path_var.as_deref(), &folders, home);
                status_of(agent, &resolved, self.agent_probes().get(agent.id()))
            })
            .collect();
        let default = default_agent(&prefs, &statuses);
        for status in &mut statuses {
            status.is_default = default.as_deref() == Some(status.id.as_str());
        }
        Ok(statuses)
    }

    /// Adds an agent by command (spec §3.5) and gives its row. The command's first word is a
    /// program on PATH, an absolute path or a path under `~/`; names are compared ignoring
    /// case.
    pub fn agent_custom_add(&self, name: &str, command: &str) -> CoreResult<AgentStatus> {
        let (name, command) = (name.trim(), command.trim());
        if name.is_empty() || command.is_empty() {
            return Err(IpcError::new(ErrorCode::InvalidInput, NAME_AND_COMMAND));
        }
        let draft = CustomAgent {
            id: String::new(),
            name: name.to_owned(),
            command: command.to_owned(),
        };
        let path_var = self.agent_path_var();
        let folders = self.agent_folders();
        let resolved = resolve_custom(&draft, path_var.as_deref(), &folders, self.home_dir());
        if let Resolved::NotInstalled { hint, .. } = &resolved {
            return Err(IpcError::new(ErrorCode::InvalidInput, hint.clone()));
        }
        let wanted = name.to_lowercase();
        let added = self.prefs_try_update(|prefs| {
            if listed(&prefs.agents)
                .iter()
                .any(|agent| agent.name().to_lowercase() == wanted)
            {
                return Err(IpcError::new(
                    ErrorCode::InvalidInput,
                    format!("An agent named {name} already exists."),
                ));
            }
            let id = loop {
                let id = format!("custom-{}", &random_hex()[..8]);
                if prefs.agents.custom.iter().all(|agent| agent.id != id) {
                    break id;
                }
            };
            let added = CustomAgent { id, ..draft };
            prefs.agents.custom.push(added.clone());
            Ok(added)
        })?;
        // No probe has run for it, so it is not Ready, and it is new, so not chosen: it is
        // not the default.
        Ok(status_of(&Listed::Custom(&added), &resolved, None))
    }

    /// Removes an agent the person added. When it was the default, the first Ready agent is
    /// the default again.
    pub fn agent_custom_remove(&self, id: &str) -> CoreResult<()> {
        self.prefs_try_update(|prefs| {
            let agents = &mut prefs.agents;
            let before = agents.custom.len();
            agents.custom.retain(|agent| agent.id != id);
            if agents.custom.len() == before {
                return Err(unknown_agent());
            }
            if agents.default_agent.as_deref() == Some(id) {
                agents.default_agent = None;
            }
            Ok(())
        })?;
        self.agent_probes().clear(id);
        Ok(())
    }

    /// Makes `id` the agent new chats start with where a cluster names none (spec §3.5).
    pub fn agent_default_set(&self, id: &str) -> CoreResult<()> {
        self.prefs_try_update(|prefs| {
            if !listed(&prefs.agents).iter().any(|agent| agent.id() == id) {
                return Err(unknown_agent());
            }
            prefs.agents.default_agent = Some(id.to_owned());
            Ok(())
        })
    }

    /// What a chat or a probe starts for `id`: `NotFound` when no listed agent has that id,
    /// `InvalidInput` with its row's hint when it is not installed.
    pub fn agent_spec(&self, id: &str) -> CoreResult<AgentSpec> {
        let prefs = self.agent_prefs();
        let agents = listed(&prefs);
        let agent = agents
            .iter()
            .find(|agent| agent.id() == id)
            .ok_or_else(unknown_agent)?;
        let path_var = self.agent_path_var();
        let folders = self.agent_folders();
        match agent.resolve(path_var.as_deref(), &folders, self.home_dir()) {
            Resolved::Found(spec) => Ok(spec),
            Resolved::NotInstalled { hint, .. } => {
                Err(IpcError::new(ErrorCode::InvalidInput, hint))
            }
        }
    }

    /// The PATH agents are found on: the login shell's, which the app loads at start (spec
    /// §4.2), or the one a test sets with `set_tools_config_for_test`.
    pub(crate) fn agent_path_var(&self) -> Option<OsString> {
        self.tools().search_path()
    }

    /// The folders searched after that PATH: the known install folders of this OS under the
    /// home folder, or the ones a test sets with `set_tools_config_for_test`.
    pub(crate) fn agent_folders(&self) -> Vec<PathBuf> {
        self.tools()
            .agent_folders()
            .unwrap_or_else(|| known_folders(self.home_dir()))
    }
}

fn unknown_agent() -> IpcError {
    IpcError::new(ErrorCode::NotFound, UNKNOWN_AGENT)
}
