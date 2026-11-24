//! The agents SkoposIDE runs (agents spec §3.5): the four built-in ones and the ones the
//! person adds by command, found on PATH, else in the known install folders. Finding an agent
//! runs nothing; its probe (spec §4.2) gives its state.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use dashmap::DashMap;
use serde::Serialize;
use ts_rs::TS;

use crate::agents::cli_login::KeychainLogin;
use crate::agents::settings::expand_home;
use crate::prefs::{AgentPrefs, CustomAgent};
use crate::tools::{find_on_path, is_executable};

/// A built-in agent: what runs, what the sandbox lets it keep and reach, and its hints
/// (spec §3.5, §4.6, §4.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentDef {
    pub id: &'static str,
    pub name: &'static str,
    /// The command that speaks ACP, found on PATH.
    pub program: &'static str,
    pub args: &'static [&'static str],
    /// The agent's own CLI, which an adapter runs. The adapter starts without it.
    pub cli: Option<&'static str>,
    /// The variable that gives the adapter the CLI's path.
    pub cli_env: Option<&'static str>,
    /// The adapter's name in the detail line; `None` for a CLI with ACP built in.
    pub adapter: Option<&'static str>,
    /// Where it keeps its settings and sign-in, relative to the home folder.
    pub settings: &'static [&'static str],
    /// Its model provider's hosts, which the proxy lets it reach.
    pub hosts: &'static [&'static str],
    /// The provider keys it gets when the app's environment has them.
    pub key_vars: &'static [&'static str],
    pub extra_env: &'static [(&'static str, &'static str)],
    pub install_hint: &'static str,
    pub sign_in_hint: &'static str,
    /// Where its CLI keeps its sign-in in the macOS keychain, which the app hands it.
    pub keychain_login: Option<KeychainLogin>,
}

/// The built-in agents in the order Preferences → Agents lists them.
pub const BUILTIN_AGENTS: [AgentDef; 4] = [
    AgentDef {
        id: "claude",
        name: "Claude",
        program: "claude-agent-acp",
        args: &[],
        cli: Some("claude"),
        cli_env: Some("CLAUDE_CODE_EXECUTABLE"),
        adapter: Some("claude-agent-acp"),
        settings: &[".claude", ".claude.json", ".config/anthropic"],
        hosts: &[
            "api.anthropic.com",
            "claude.ai",
            "platform.claude.com",
            "claude.com",
        ],
        key_vars: &["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        extra_env: &[("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")],
        install_hint: "Install claude-agent-acp (npm install -g @agentclientprotocol/claude-agent-acp), then check again.",
        sign_in_hint: "Run claude in a terminal and sign in, then check again.",
        keychain_login: Some(KeychainLogin {
            service: "Claude Code-credentials",
            var: "CLAUDE_CODE_OAUTH_TOKEN",
        }),
    },
    AgentDef {
        id: "codex",
        name: "Codex",
        program: "codex-acp",
        args: &[],
        cli: Some("codex"),
        cli_env: Some("CODEX_PATH"),
        adapter: Some("codex-acp"),
        settings: &[".codex"],
        hosts: &["api.openai.com", "chatgpt.com", "auth.openai.com"],
        key_vars: &["OPENAI_API_KEY", "CODEX_API_KEY"],
        extra_env: &[],
        install_hint: "Install codex-acp (npm install -g @agentclientprotocol/codex-acp), then check again.",
        sign_in_hint: "Run codex login in a terminal, then check again.",
        keychain_login: None,
    },
    AgentDef {
        id: "opencode",
        name: "OpenCode",
        program: "opencode",
        args: &["acp"],
        cli: None,
        cli_env: None,
        adapter: None,
        settings: &[".config/opencode", ".local/share/opencode", ".cache/opencode"],
        hosts: &["opencode.ai"],
        key_vars: &[],
        extra_env: &[],
        install_hint: "Install OpenCode, then check again.",
        sign_in_hint: "Run opencode auth login in a terminal, then check again.",
        keychain_login: None,
    },
    AgentDef {
        id: "gemini",
        name: "Gemini CLI",
        program: "gemini",
        args: &["--acp"],
        cli: None,
        cli_env: None,
        adapter: None,
        settings: &[".gemini"],
        hosts: &[
            "generativelanguage.googleapis.com",
            "cloudcode-pa.googleapis.com",
            "oauth2.googleapis.com",
        ],
        key_vars: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        extra_env: &[],
        install_hint: "Install Gemini CLI, then check again.",
        sign_in_hint: "Run gemini in a terminal and sign in, then check again.",
        keychain_login: None,
    },
];

/// What starts an installed agent: for the sandbox (spec §4.6) and the ACP client.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentSpec {
    pub id: String,
    pub name: String,
    /// The command's real path, links resolved: the file the sandbox makes readable.
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The CLI's variable when the CLI was found, then the agent's fixed variables.
    pub env: Vec<(String, String)>,
    /// The detail line of its row.
    pub detail: String,
    /// Absolute. The sandbox leaves out the ones that do not exist.
    pub settings: Vec<PathBuf>,
    pub hosts: Vec<String>,
    pub key_vars: Vec<String>,
    /// The real paths of the command and of the CLI, whose install roots the sandbox makes
    /// readable.
    pub install_paths: Vec<PathBuf>,
    /// The folders its command or CLI was found in off `PATH`, among the known install
    /// folders, which its `PATH` ends with: a script's `#!/usr/bin/env node` finds the `node`
    /// beside it.
    pub path_dirs: Vec<PathBuf>,
    pub custom: bool,
}

/// An agent found, or the hint that says how to install it, with the detail line of what was
/// found when that is a CLI without its adapter.
// Built once per row and moved out at once: boxing the spec would buy nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Found(AgentSpec),
    NotInstalled {
        hint: String,
        detail: Option<String>,
    },
}

/// A program found: where, and the known folder it was found in when `PATH` lacks it.
struct Located {
    path: PathBuf,
    known_folder: Option<PathBuf>,
}

/// `name` on `path_var`, else in the first of `folders` that has it (`find_on_path` for a
/// name with a `/`).
fn locate(name: &str, path_var: Option<&OsStr>, folders: &[PathBuf]) -> Option<Located> {
    if let Some(path) = find_on_path(name, path_var) {
        return Some(Located {
            path,
            known_folder: None,
        });
    }
    if name.contains('/') {
        return None;
    }
    folders
        .iter()
        .find(|folder| is_executable(&folder.join(name)))
        .map(|folder| Located {
            path: folder.join(name),
            known_folder: Some(folder.clone()),
        })
}

/// The known folders the programs were found in, each once, in the programs' order.
fn path_dirs<'a>(found: impl IntoIterator<Item = &'a Located>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for folder in found
        .into_iter()
        .filter_map(|located| located.known_folder.clone())
    {
        if !dirs.contains(&folder) {
            dirs.push(folder);
        }
    }
    dirs
}

/// How to sign in to `agent`: its built-in agent's hint, `None` for the person's own agents.
pub fn sign_in_hint(agent: &AgentSpec) -> Option<&'static str> {
    if agent.custom {
        return None;
    }
    BUILTIN_AGENTS
        .iter()
        .find(|def| def.id == agent.id)
        .map(|def| def.sign_in_hint)
}

/// Where `agent`'s CLI keeps its sign-in in the macOS keychain: its built-in agent's, `None` for
/// the person's own agents.
pub fn keychain_login(agent: &AgentSpec) -> Option<&'static KeychainLogin> {
    if agent.custom {
        return None;
    }
    BUILTIN_AGENTS
        .iter()
        .find(|def| def.id == agent.id)
        .and_then(|def| def.keychain_login.as_ref())
}

/// Finds a built-in agent on `path_var`, else in `folders`, the known install folders. Its
/// program alone makes it installed; its CLI goes in `cli_env` when found too. A CLI found
/// without its adapter gives the detail line that says the adapter is missing.
pub fn resolve(
    def: &AgentDef,
    path_var: Option<&OsStr>,
    folders: &[PathBuf],
    home: &Path,
) -> Resolved {
    let cli = def.cli.and_then(|cli| locate(cli, path_var, folders));
    let Some(program) = locate(def.program, path_var, folders) else {
        let detail = match (&cli, def.adapter) {
            (Some(cli), Some(adapter)) => Some(format!(
                "{} · ACP adapter {adapter} missing",
                shown(&cli.path, home)
            )),
            _ => None,
        };
        return Resolved::NotInstalled {
            hint: def.install_hint.to_owned(),
            detail,
        };
    };
    let dirs = path_dirs(std::iter::once(&program).chain(&cli));
    let (program, cli) = (program.path, cli.map(|cli| cli.path));
    let mut env = Vec::new();
    let mut install_paths = vec![real_path(&program)];
    if let (Some(cli), Some(var)) = (&cli, def.cli_env) {
        let cli = real_path(cli);
        env.push((var.to_owned(), cli.display().to_string()));
        install_paths.push(cli);
    }
    env.extend(
        def.extra_env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
    );
    let detail = match def.adapter {
        Some(adapter) => format!(
            "{} · ACP adapter {adapter}",
            shown(cli.as_deref().unwrap_or(&program), home)
        ),
        None => format!("{} · built-in ACP", shown(&program, home)),
    };
    Resolved::Found(AgentSpec {
        id: def.id.to_owned(),
        name: def.name.to_owned(),
        program: install_paths[0].clone(),
        args: owned(def.args),
        env,
        detail,
        settings: def.settings.iter().map(|path| home.join(path)).collect(),
        hosts: owned(def.hosts),
        key_vars: owned(def.key_vars),
        install_paths,
        path_dirs: dirs,
        custom: false,
    })
}

/// Finds the program of an agent the person added: the first word of its command, split as
/// a shell splits it, on `path_var` or else in `folders`. It gets no settings, hosts or keys
/// (spec §4.6, §4.7).
pub fn resolve_custom(
    agent: &CustomAgent,
    path_var: Option<&OsStr>,
    folders: &[PathBuf],
    home: &Path,
) -> Resolved {
    let not_found = |word: &str| Resolved::NotInstalled {
        hint: format!("No such command: {word}"),
        detail: None,
    };
    // An unclosed quote: name the first word as typed.
    let Ok(words) = shell_words::split(&agent.command) else {
        return not_found(agent.command.split_whitespace().next().unwrap_or_default());
    };
    let Some((first, args)) = words.split_first() else {
        return not_found("");
    };
    let Some(located) = locate_word(first, path_var, folders, home) else {
        return not_found(first);
    };
    let dirs = path_dirs([&located]);
    let program = real_path(&located.path);
    Resolved::Found(AgentSpec {
        id: agent.id.clone(),
        name: agent.name.clone(),
        program: program.clone(),
        args: args.to_vec(),
        env: Vec::new(),
        detail: agent.command.clone(),
        settings: Vec::new(),
        hosts: Vec::new(),
        key_vars: Vec::new(),
        install_paths: vec![program],
        path_dirs: dirs,
        custom: true,
    })
}

/// `~/x` is a path under the home folder; any other word is what `locate` takes.
fn locate_word(
    word: &str,
    path_var: Option<&OsStr>,
    folders: &[PathBuf],
    home: &Path,
) -> Option<Located> {
    if word.starts_with("~/") {
        let path = expand_home(word, home);
        return is_executable(&path).then_some(Located {
            path,
            known_folder: None,
        });
    }
    locate(word, path_var, folders)
}

/// `path` with its links resolved, as the sandbox must bind it; `path` itself when that fails.
fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `path` with the home folder written `~`, as the detail line shows it.
fn shown(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

/// An agent's state in its row (spec §3.5, §4.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum AgentState {
    /// Installed, and not probed yet in this app run.
    Unknown,
    Ready,
    SignInNeeded,
    NotInstalled,
    DoesNotStart {
        reason: String,
    },
}

/// One row of Preferences → Agents (spec §3.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentStatus {
    pub id: String,
    pub name: String,
    pub state: AgentState,
    /// The monospace line: where the agent is, or the person's command. For a built-in agent
    /// that is not installed, its CLI found without the adapter, else `None`.
    pub detail: Option<String>,
    /// How to install it or sign in, or why it doesn't start.
    pub hint: Option<String>,
    /// The agent new chats start with (spec §3.5).
    pub is_default: bool,
    pub custom: bool,
    /// Its provider's hosts, for the sandbox's Network rows. None for the person's agents.
    pub hosts: Vec<String>,
}

/// The chosen default while it is listed, whatever its state; else the first Ready agent in
/// list order (spec §3.5).
pub fn default_agent(prefs: &AgentPrefs, states: &[AgentStatus]) -> Option<String> {
    let chosen = prefs
        .default_agent
        .as_deref()
        .filter(|id| states.iter().any(|status| status.id == *id));
    chosen.map(str::to_owned).or_else(|| {
        states
            .iter()
            .find(|status| status.state == AgentState::Ready)
            .map(|status| status.id.clone())
    })
}

/// The probe results of this app run, by agent id (spec §4.2).
#[derive(Debug, Default)]
pub struct AgentProbes {
    states: DashMap<String, AgentState>,
}

impl AgentProbes {
    pub fn get(&self, id: &str) -> Option<AgentState> {
        self.states.get(id).map(|state| state.value().clone())
    }

    pub fn set(&self, id: &str, state: AgentState) {
        self.states.insert(id.to_owned(), state);
    }

    pub fn clear(&self, id: &str) {
        self.states.remove(id);
    }
}

/// An agent of Preferences → Agents.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Listed<'a> {
    Builtin(&'a AgentDef),
    Custom(&'a CustomAgent),
}

impl Listed<'_> {
    pub(crate) fn id(&self) -> &str {
        match self {
            Listed::Builtin(def) => def.id,
            Listed::Custom(agent) => &agent.id,
        }
    }

    pub(crate) fn name(&self) -> &str {
        match self {
            Listed::Builtin(def) => def.name,
            Listed::Custom(agent) => &agent.name,
        }
    }

    pub(crate) fn resolve(
        &self,
        path_var: Option<&OsStr>,
        folders: &[PathBuf],
        home: &Path,
    ) -> Resolved {
        match self {
            Listed::Builtin(def) => resolve(def, path_var, folders, home),
            Listed::Custom(agent) => resolve_custom(agent, path_var, folders, home),
        }
    }

    /// The person's agents have no sign-in the app knows of.
    fn sign_in_hint(&self) -> Option<&'static str> {
        match self {
            Listed::Builtin(def) => Some(def.sign_in_hint),
            Listed::Custom(_) => None,
        }
    }

    fn hosts(&self) -> Vec<String> {
        match self {
            Listed::Builtin(def) => owned(def.hosts),
            Listed::Custom(_) => Vec::new(),
        }
    }
}

/// The built-in agents, then the person's in the order added.
pub(crate) fn listed(prefs: &AgentPrefs) -> Vec<Listed<'_>> {
    let builtins: &'static [AgentDef] = &BUILTIN_AGENTS;
    builtins
        .iter()
        .map(Listed::Builtin)
        .chain(prefs.custom.iter().map(Listed::Custom))
        .collect()
}

/// The row of `agent`: when it is installed, its probe's state (`Unknown` before one) with
/// the hint that goes with it. `is_default` is the caller's to set.
pub(crate) fn status_of(
    agent: &Listed<'_>,
    resolved: &Resolved,
    probe: Option<AgentState>,
) -> AgentStatus {
    let (state, detail, hint) = match resolved {
        Resolved::NotInstalled { hint, detail } => {
            (AgentState::NotInstalled, detail.clone(), Some(hint.clone()))
        }
        Resolved::Found(spec) => {
            let state = probe.unwrap_or(AgentState::Unknown);
            let hint = match &state {
                AgentState::SignInNeeded => agent.sign_in_hint().map(str::to_owned),
                AgentState::DoesNotStart { reason } => Some(reason.clone()),
                AgentState::Unknown | AgentState::Ready | AgentState::NotInstalled => None,
            };
            (state, Some(spec.detail.clone()), hint)
        }
    };
    let detail = match agent {
        // The person's command, whether or not its program is found.
        Listed::Custom(custom) => Some(custom.command.clone()),
        Listed::Builtin(_) => detail,
    };
    AgentStatus {
        id: agent.id().to_owned(),
        name: agent.name().to_owned(),
        state,
        detail,
        hint,
        is_default: false,
        custom: matches!(agent, Listed::Custom(_)),
        hosts: agent.hosts(),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::ffi::OsString;

    use super::*;

    fn builtin(id: &str) -> &'static AgentDef {
        let builtins: &'static [AgentDef] = &BUILTIN_AGENTS;
        builtins.iter().find(|def| def.id == id).unwrap()
    }

    #[test]
    fn the_built_in_agents_are_the_spec_table_in_its_order() {
        let ids: Vec<&str> = BUILTIN_AGENTS.iter().map(|def| def.id).collect();
        assert_eq!(ids, ["claude", "codex", "opencode", "gemini"]);
        let names: Vec<&str> = BUILTIN_AGENTS.iter().map(|def| def.name).collect();
        assert_eq!(names, ["Claude", "Codex", "OpenCode", "Gemini CLI"]);

        let claude = builtin("claude");
        assert_eq!(claude.program, "claude-agent-acp");
        assert!(claude.args.is_empty());
        assert_eq!(claude.cli, Some("claude"));
        assert_eq!(claude.cli_env, Some("CLAUDE_CODE_EXECUTABLE"));
        assert_eq!(claude.adapter, Some("claude-agent-acp"));
        assert_eq!(
            claude.extra_env,
            [("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")]
        );
        let codex = builtin("codex");
        assert_eq!(codex.program, "codex-acp");
        assert_eq!(codex.cli, Some("codex"));
        assert_eq!(codex.cli_env, Some("CODEX_PATH"));
        assert_eq!(codex.adapter, Some("codex-acp"));
        assert!(codex.extra_env.is_empty());
        for (id, program, args) in [
            ("opencode", "opencode", "acp"),
            ("gemini", "gemini", "--acp"),
        ] {
            let def = builtin(id);
            assert_eq!(def.program, program);
            assert_eq!(def.args, [args]);
            assert_eq!((def.cli, def.cli_env, def.adapter), (None, None, None));
            assert!(def.extra_env.is_empty());
        }
        for def in &BUILTIN_AGENTS {
            // Relative to the home folder; the sandbox joins them to it.
            assert!(
                def.settings
                    .iter()
                    .all(|path| !path.starts_with('/') && !path.starts_with('~')),
                "{}",
                def.id
            );
            assert!(!def.hosts.is_empty(), "{}", def.id);
            assert!(
                def.install_hint.ends_with(", then check again."),
                "{}",
                def.id
            );
            assert!(
                def.sign_in_hint.ends_with(", then check again."),
                "{}",
                def.id
            );
        }
    }

    /// Unix paths: on Windows `/home/me` is not absolute.
    #[cfg(unix)]
    #[test]
    fn a_path_under_the_home_folder_is_shown_with_a_tilde() {
        let home = Path::new("/home/me");
        assert_eq!(
            shown(Path::new("/home/me/.local/bin/claude"), home),
            "~/.local/bin/claude"
        );
        assert_eq!(shown(home, home), "~");
        assert_eq!(
            shown(Path::new("/usr/local/bin/claude"), home),
            "/usr/local/bin/claude"
        );
        assert_eq!(
            shown(Path::new("/home/meow/bin/claude"), home),
            "/home/meow/bin/claude"
        );
    }

    fn found(detail: &str) -> Resolved {
        Resolved::Found(AgentSpec {
            detail: detail.to_owned(),
            ..AgentSpec::default()
        })
    }

    #[test]
    fn an_installed_agent_shows_its_probe_state_with_the_hint_that_goes_with_it() {
        let claude = Listed::Builtin(builtin("claude"));
        let detail = "~/.local/bin/claude · ACP adapter claude-agent-acp";

        let status = status_of(&claude, &found(detail), None);
        assert_eq!(
            status,
            AgentStatus {
                id: "claude".to_owned(),
                name: "Claude".to_owned(),
                state: AgentState::Unknown,
                detail: Some(detail.to_owned()),
                hint: None,
                is_default: false,
                custom: false,
                hosts: vec![
                    "api.anthropic.com".to_owned(),
                    "claude.ai".to_owned(),
                    "platform.claude.com".to_owned(),
                    "claude.com".to_owned(),
                ],
            }
        );
        let ready = status_of(&claude, &found(detail), Some(AgentState::Ready));
        assert_eq!((ready.state, ready.hint), (AgentState::Ready, None));
        let signed_out = status_of(&claude, &found(detail), Some(AgentState::SignInNeeded));
        assert_eq!(signed_out.state, AgentState::SignInNeeded);
        assert_eq!(
            signed_out.hint.as_deref(),
            Some("Run claude in a terminal and sign in, then check again.")
        );
        let reason = "Claude didn't answer within 20 seconds.";
        let broken = status_of(
            &claude,
            &found(detail),
            Some(AgentState::DoesNotStart {
                reason: reason.to_owned(),
            }),
        );
        assert_eq!(broken.hint.as_deref(), Some(reason));
        assert_eq!(broken.detail.as_deref(), Some(detail));
    }

    #[test]
    fn a_missing_agent_is_not_installed_whatever_its_last_probe_said() {
        let codex = Listed::Builtin(builtin("codex"));
        let missing = Resolved::NotInstalled {
            hint: builtin("codex").install_hint.to_owned(),
            detail: None,
        };

        let status = status_of(&codex, &missing, Some(AgentState::Ready));

        assert_eq!(status.state, AgentState::NotInstalled);
        assert_eq!(status.detail, None);
        assert_eq!(
            status.hint.as_deref(),
            Some("Install codex-acp (npm install -g @agentclientprotocol/codex-acp), then check again.")
        );
    }

    #[test]
    fn a_running_agents_sign_in_hint_is_its_built_in_ones_and_none_for_the_persons_own() {
        let mut agent = crate::agents::sandbox::test_agent(std::path::Path::new("/bin/claude"));
        agent.id = "claude".to_owned();
        assert_eq!(sign_in_hint(&agent), None);
        agent.custom = false;
        assert_eq!(
            sign_in_hint(&agent),
            Some("Run claude in a terminal and sign in, then check again.")
        );
        agent.id = "unknown".to_owned();
        assert_eq!(sign_in_hint(&agent), None);
    }

    #[test]
    fn only_claude_keeps_its_sign_in_in_the_keychain() {
        let mut agent = crate::agents::sandbox::test_agent(std::path::Path::new("/bin/claude"));
        agent.id = "claude".to_owned();
        assert_eq!(keychain_login(&agent), None);
        agent.custom = false;
        assert_eq!(
            keychain_login(&agent),
            Some(&KeychainLogin {
                service: "Claude Code-credentials",
                var: "CLAUDE_CODE_OAUTH_TOKEN",
            })
        );
        agent.id = "codex".to_owned();
        assert_eq!(keychain_login(&agent), None);
    }

    #[test]
    fn a_custom_agent_shows_its_command_and_has_no_sign_in_hint_or_hosts() {
        let agent = CustomAgent {
            id: "custom-0a1b2c3d".to_owned(),
            name: "Mine".to_owned(),
            command: "my-agent --acp".to_owned(),
        };
        let mine = Listed::Custom(&agent);

        let signed_out = status_of(&mine, &found("ignored"), Some(AgentState::SignInNeeded));
        assert_eq!(signed_out.id, "custom-0a1b2c3d");
        assert_eq!(signed_out.name, "Mine");
        assert_eq!(signed_out.state, AgentState::SignInNeeded);
        assert_eq!(signed_out.hint, None);
        assert_eq!(signed_out.detail.as_deref(), Some("my-agent --acp"));
        assert!(signed_out.custom);
        assert!(signed_out.hosts.is_empty());

        let missing = Resolved::NotInstalled {
            hint: "No such command: my-agent".to_owned(),
            detail: None,
        };
        let status = status_of(&mine, &missing, None);
        assert_eq!(status.state, AgentState::NotInstalled);
        assert_eq!(status.detail.as_deref(), Some("my-agent --acp"));
        assert_eq!(status.hint.as_deref(), Some("No such command: my-agent"));
    }

    fn row(id: &str, state: AgentState) -> AgentStatus {
        AgentStatus {
            id: id.to_owned(),
            name: id.to_owned(),
            state,
            detail: None,
            hint: None,
            is_default: false,
            custom: false,
            hosts: Vec::new(),
        }
    }

    #[test]
    fn the_default_is_the_chosen_agent_while_it_is_listed_else_the_first_ready_one() {
        let rows = [
            row("claude", AgentState::NotInstalled),
            row("codex", AgentState::Unknown),
            row("opencode", AgentState::Ready),
            row("custom-0a1b2c3d", AgentState::Ready),
        ];
        let chosen = |id: Option<&str>| AgentPrefs {
            default_agent: id.map(str::to_owned),
            ..AgentPrefs::default()
        };

        assert_eq!(
            default_agent(&chosen(None), &rows).as_deref(),
            Some("opencode")
        );
        assert_eq!(
            default_agent(&chosen(Some("custom-0a1b2c3d")), &rows).as_deref(),
            Some("custom-0a1b2c3d")
        );
        // Not installed now, and still the person's choice.
        assert_eq!(
            default_agent(&chosen(Some("claude")), &rows).as_deref(),
            Some("claude")
        );
        // An agent that was removed is no default.
        assert_eq!(
            default_agent(&chosen(Some("custom-ffffffff")), &rows).as_deref(),
            Some("opencode")
        );
        assert_eq!(
            default_agent(&chosen(None), &[row("claude", AgentState::Unknown)]),
            None
        );
    }

    #[test]
    fn probe_results_are_kept_until_cleared() {
        let probes = AgentProbes::default();
        assert_eq!(probes.get("claude"), None);
        probes.set("claude", AgentState::SignInNeeded);
        probes.set("claude", AgentState::Ready);
        assert_eq!(probes.get("claude"), Some(AgentState::Ready));
        assert_eq!(probes.get("codex"), None);
        probes.clear("claude");
        assert_eq!(probes.get("claude"), None);
    }

    /// A temp home folder, by its real path as `resolve` gives programs, with an empty `bin/`
    /// that is the whole `PATH`.
    #[cfg(unix)]
    struct Home {
        _root: tempfile::TempDir,
        home: PathBuf,
    }

    #[cfg(unix)]
    impl Home {
        fn new() -> Home {
            let root = tempfile::tempdir().unwrap();
            let home = real_path(root.path());
            std::fs::create_dir_all(home.join("bin")).unwrap();
            Home { _root: root, home }
        }

        fn path_var(&self) -> OsString {
            self.home.join("bin").into_os_string()
        }

        /// An executable `name` in `folder`, a folder under the home folder.
        fn program(&self, folder: &str, name: &str) -> PathBuf {
            use std::os::unix::fs::PermissionsExt;
            let folder = self.home.join(folder);
            std::fs::create_dir_all(&folder).unwrap();
            let path = folder.join(name);
            std::fs::write(&path, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn folder(&self, folder: &str) -> PathBuf {
            self.home.join(folder)
        }

        fn resolve(&self, id: &str, known: &[&str]) -> Resolved {
            let known: Vec<PathBuf> = known.iter().map(|folder| self.folder(folder)).collect();
            resolve(
                builtin(id),
                Some(self.path_var().as_os_str()),
                &known,
                &self.home,
            )
        }
    }

    #[cfg(unix)]
    fn spec_of(resolved: Resolved) -> AgentSpec {
        match resolved {
            Resolved::Found(spec) => spec,
            Resolved::NotInstalled { hint, .. } => panic!("not found: {hint}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_off_path_is_found_in_a_known_folder_which_its_path_then_ends_with() {
        let home = Home::new();
        let opencode = home.program(".opencode/bin", "opencode");

        let spec = spec_of(home.resolve("opencode", &[".local/bin", ".opencode/bin"]));

        assert_eq!(spec.program, opencode);
        assert_eq!(spec.install_paths, [opencode]);
        assert_eq!(spec.detail, "~/.opencode/bin/opencode · built-in ACP");
        assert_eq!(spec.path_dirs, [home.folder(".opencode/bin")]);
    }

    #[cfg(unix)]
    #[test]
    fn path_comes_before_the_known_folders() {
        let home = Home::new();
        let on_path = home.program("bin", "gemini");
        home.program(".local/bin", "gemini");

        let spec = spec_of(home.resolve("gemini", &[".local/bin"]));

        assert_eq!(spec.program, on_path);
        assert!(spec.path_dirs.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn an_adapter_and_its_cli_are_each_found_where_they_are() {
        let home = Home::new();
        let adapter = home.program(".nvm/versions/node/v22.11.0/bin", "claude-agent-acp");
        let cli = home.program(".local/bin", "claude");

        let spec =
            spec_of(home.resolve("claude", &[".local/bin", ".nvm/versions/node/v22.11.0/bin"]));

        assert_eq!(spec.program, adapter);
        assert_eq!(spec.install_paths, [adapter, cli.clone()]);
        assert_eq!(
            spec.env[0],
            (
                "CLAUDE_CODE_EXECUTABLE".to_owned(),
                cli.display().to_string()
            )
        );
        assert_eq!(
            spec.detail,
            "~/.local/bin/claude · ACP adapter claude-agent-acp"
        );
        // The adapter's folder first: its `node` is the one a script there means.
        assert_eq!(
            spec.path_dirs,
            [
                home.folder(".nvm/versions/node/v22.11.0/bin"),
                home.folder(".local/bin")
            ]
        );

        // The adapter on PATH and the CLI off it: only the CLI's folder is added.
        let home = Home::new();
        home.program("bin", "codex-acp");
        home.program(".local/bin", "codex");
        let spec = spec_of(home.resolve("codex", &[".local/bin"]));
        assert_eq!(spec.path_dirs, [home.folder(".local/bin")]);
        assert_eq!(spec.detail, "~/.local/bin/codex · ACP adapter codex-acp");
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_its_adapter_names_the_adapter_that_is_missing() {
        let home = Home::new();
        home.program(".local/bin", "codex");
        let codex = builtin("codex");

        let resolved = home.resolve("codex", &[".local/bin"]);

        assert_eq!(
            resolved,
            Resolved::NotInstalled {
                hint: codex.install_hint.to_owned(),
                detail: Some("~/.local/bin/codex · ACP adapter codex-acp missing".to_owned()),
            }
        );
        let status = status_of(&Listed::Builtin(codex), &resolved, Some(AgentState::Ready));
        assert_eq!(status.state, AgentState::NotInstalled);
        assert_eq!(
            status.detail.as_deref(),
            Some("~/.local/bin/codex · ACP adapter codex-acp missing")
        );
        assert_eq!(status.hint.as_deref(), Some(codex.install_hint));

        // Neither the CLI nor the adapter: nothing to show but the hint.
        let empty = Home::new();
        assert_eq!(
            empty.resolve("codex", &[".local/bin"]),
            Resolved::NotInstalled {
                hint: codex.install_hint.to_owned(),
                detail: None,
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_custom_command_is_found_in_a_known_folder_too() {
        let home = Home::new();
        let mine = home.program(".bun/bin", "my-agent");
        let agent = CustomAgent {
            id: "custom-0a1b2c3d".to_owned(),
            name: "Mine".to_owned(),
            command: "my-agent --acp".to_owned(),
        };

        let spec = spec_of(resolve_custom(
            &agent,
            Some(home.path_var().as_os_str()),
            &[home.folder(".bun/bin")],
            &home.home,
        ));

        assert_eq!(spec.program, mine);
        assert_eq!(spec.args, ["--acp"]);
        assert_eq!(spec.path_dirs, [home.folder(".bun/bin")]);
        // Not in any folder searched.
        let missing = resolve_custom(&agent, Some(home.path_var().as_os_str()), &[], &home.home);
        assert_eq!(
            missing,
            Resolved::NotInstalled {
                hint: "No such command: my-agent".to_owned(),
                detail: None,
            }
        );
    }
}
