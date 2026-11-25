//! Finding the agents (agents spec §3.5, §4.2) with fake agent CLIs: shell scripts in the
//! temp home's `bin/`, the only folder on the core's PATH, as `tests/helm.rs` fakes helm, or in
//! the known install folders under that home.
//! Each script leaves a mark when it runs, so the tests also show that finding agents runs
//! none of them: probes come later. The tests of execute bits, links, `~/…` detail lines and
//! shell quoting run on Unix.

use std::path::{Path, PathBuf};

#[cfg(unix)]
use skopos_core::agents::registry::AgentState;
use skopos_core::agents::registry::AgentStatus;
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::paths::AppPaths;
use skopos_core::tools::ToolsConfig;
use tempfile::TempDir;

/// A temp root with a home folder whose `bin/` is the core's PATH, and `marks/`, where
/// each fake agent leaves a file named after it when it runs.
struct Fixture {
    root: TempDir,
}

impl Fixture {
    fn new() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("home/bin")).unwrap();
        std::fs::create_dir_all(root.path().join("marks")).unwrap();
        Fixture { root }
    }

    fn home(&self) -> PathBuf {
        self.root.path().join("home")
    }

    fn bin(&self) -> PathBuf {
        self.home().join("bin")
    }

    /// An executable script at `path` that leaves the mark `mark` when it runs. Windows
    /// runs any file, so there it is only a file.
    fn script(&self, path: &Path, mark: &str) -> PathBuf {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mark = self.root.path().join("marks").join(mark);
        std::fs::write(path, format!("#!/bin/sh\ntouch '{}'\n", mark.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_path_buf()
    }

    /// A fake `name` in the PATH folder.
    fn install(&self, name: &str) -> PathBuf {
        self.script(&self.bin().join(name), name)
    }

    /// A fake `name` in `folder`, a folder under the home folder off PATH.
    #[cfg(unix)]
    fn install_in(&self, folder: &str, name: &str) -> PathBuf {
        self.script(&self.home().join(folder).join(name), name)
    }

    /// A fake `name` as npm installs one: a script in its package, linked from the PATH
    /// folder. Gives the script's path.
    #[cfg(unix)]
    fn install_linked(&self, name: &str) -> PathBuf {
        let package = self.root.path().join("lib/node_modules").join(name);
        let script = self.script(&package.join("dist/index.js"), name);
        std::os::unix::fs::symlink(&script, self.bin().join(name)).unwrap();
        script
    }

    fn nothing_ran(&self) -> bool {
        std::fs::read_dir(self.root.path().join("marks"))
            .unwrap()
            .next()
            .is_none()
    }

    /// A core whose PATH is `home/bin` alone, and that looks in no other folder.
    async fn core(&self) -> AppCore {
        self.core_with(Some(Vec::new())).await
    }

    /// A core whose PATH is `home/bin` alone, and that looks in `agent_folders` after it:
    /// `None` for the known install folders of this OS under the temp home (and Homebrew's on
    /// macOS).
    async fn core_with(&self, agent_folders: Option<Vec<PathBuf>>) -> AppCore {
        let paths = AppPaths::under(&self.root.path().join("app"), &self.home());
        let core = AppCore::start_with_kubeconfig_env(paths, None)
            .await
            .unwrap();
        core.set_tools_config_for_test(ToolsConfig {
            search_path: Some(self.bin().into_os_string()),
            agent_folders,
            ..ToolsConfig::default()
        });
        core
    }
}

/// The path with its links resolved: what an agent runs from.
#[cfg(unix)]
fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap()
}

fn row<'a>(statuses: &'a [AgentStatus], id: &str) -> &'a AgentStatus {
    statuses.iter().find(|status| status.id == id).unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn the_status_lists_the_built_in_agents_then_the_custom_ones_and_runs_none() {
    let fixture = Fixture::new();
    fixture.install_linked("claude-agent-acp");
    fixture.install("claude");
    fixture.install("opencode");
    fixture.install("my-agent");
    let core = fixture.core().await;
    let mine = core.agent_custom_add("Mine", "my-agent --acp").unwrap();

    let statuses = core.agents_status().unwrap();

    let ids: Vec<&str> = statuses.iter().map(|status| status.id.as_str()).collect();
    assert_eq!(
        ids,
        ["claude", "codex", "opencode", "gemini", mine.id.as_str()]
    );
    let claude = row(&statuses, "claude");
    assert_eq!(claude.name, "Claude");
    // Found, and no probe has run yet.
    assert_eq!(claude.state, AgentState::Unknown);
    assert_eq!(
        claude.detail.as_deref(),
        Some("~/bin/claude · ACP adapter claude-agent-acp")
    );
    assert_eq!(claude.hint, None);
    assert!(!claude.custom);
    let codex = row(&statuses, "codex");
    assert_eq!(codex.state, AgentState::NotInstalled);
    assert_eq!(codex.detail, None);
    assert_eq!(
        codex.hint.as_deref(),
        Some(
            "Install codex-acp (npm install -g @agentclientprotocol/codex-acp), then check again."
        )
    );
    let opencode = row(&statuses, "opencode");
    assert_eq!(opencode.state, AgentState::Unknown);
    assert_eq!(
        opencode.detail.as_deref(),
        Some("~/bin/opencode · built-in ACP")
    );
    let gemini = row(&statuses, "gemini");
    assert_eq!(gemini.name, "Gemini CLI");
    assert_eq!(gemini.state, AgentState::NotInstalled);
    assert_eq!(
        gemini.hint.as_deref(),
        Some("Install Gemini CLI, then check again.")
    );
    assert_eq!(row(&statuses, &mine.id), &mine);
    assert_eq!(mine.name, "Mine");
    assert_eq!(mine.state, AgentState::Unknown);
    assert_eq!(mine.detail.as_deref(), Some("my-agent --acp"));
    assert_eq!(mine.hint, None);
    assert!(mine.custom);
    // No agent is Ready before a probe and none was chosen, so none is the default yet.
    assert!(statuses.iter().all(|status| !status.is_default));
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn agents_off_path_are_found_in_the_known_folders_and_a_cli_names_its_missing_adapter() {
    let fixture = Fixture::new();
    fixture.install_in(".local/bin", "codex");
    let opencode = fixture.install_in(".opencode/bin", "opencode");
    let adapter = fixture.install_in(".nvm/versions/node/v22.11.0/bin", "claude-agent-acp");
    fixture.install_in(".nvm/versions/node/v20.18.1/bin", "claude-agent-acp");
    let core = fixture.core_with(None).await;
    let home = fixture.home();

    let statuses = core.agents_status().unwrap();

    let codex = row(&statuses, "codex");
    assert_eq!(codex.state, AgentState::NotInstalled);
    assert_eq!(
        codex.detail.as_deref(),
        Some("~/.local/bin/codex · ACP adapter codex-acp missing")
    );
    assert_eq!(
        codex.hint.as_deref(),
        Some(
            "Install codex-acp (npm install -g @agentclientprotocol/codex-acp), then check again."
        )
    );
    let row_of_opencode = row(&statuses, "opencode");
    assert_eq!(row_of_opencode.state, AgentState::Unknown);
    assert_eq!(
        row_of_opencode.detail.as_deref(),
        Some("~/.opencode/bin/opencode · built-in ACP")
    );
    // The newest Node version's copy.
    let claude = row(&statuses, "claude");
    assert_eq!(claude.state, AgentState::Unknown);
    assert_eq!(
        claude.detail.as_deref(),
        Some("~/.nvm/versions/node/v22.11.0/bin/claude-agent-acp · ACP adapter claude-agent-acp")
    );

    let spec = core.agent_spec("opencode").unwrap();
    assert_eq!(spec.program, real(&opencode));
    assert_eq!(spec.path_dirs, [home.join(".opencode/bin")]);
    let spec = core.agent_spec("claude").unwrap();
    assert_eq!(spec.program, real(&adapter));
    assert_eq!(
        spec.path_dirs,
        [home.join(".nvm/versions/node/v22.11.0/bin")]
    );
    let err = core.agent_spec("codex").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);

    // Found on PATH, nothing is added to the agent's PATH.
    fixture.install("opencode");
    let spec = core.agent_spec("opencode").unwrap();
    assert!(spec.path_dirs.is_empty());
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn an_agent_runs_from_its_real_path_with_its_cli_and_environment() {
    let fixture = Fixture::new();
    let adapter = fixture.install_linked("claude-agent-acp");
    let cli = fixture.install_linked("claude");
    let core = fixture.core().await;

    let spec = core.agent_spec("claude").unwrap();

    assert_eq!(spec.id, "claude");
    assert_eq!(spec.name, "Claude");
    assert_eq!(spec.program, real(&adapter));
    assert!(spec.args.is_empty());
    assert_eq!(
        spec.env,
        [
            (
                "CLAUDE_CODE_EXECUTABLE".to_owned(),
                real(&cli).display().to_string()
            ),
            (
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_owned(),
                "1".to_owned()
            ),
        ]
    );
    // The detail line names the CLI where PATH has it.
    assert_eq!(spec.detail, "~/bin/claude · ACP adapter claude-agent-acp");
    assert!(!spec.custom);
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn an_agent_without_its_cli_gets_no_cli_variable() {
    let fixture = Fixture::new();
    let claude_adapter = fixture.install("claude-agent-acp");
    let codex_adapter = fixture.install("codex-acp");
    let codex = fixture.install("codex");
    let core = fixture.core().await;

    let claude = core.agent_spec("claude").unwrap();
    assert_eq!(
        claude.env,
        [(
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_owned(),
            "1".to_owned()
        )]
    );
    assert_eq!(claude.program, real(&claude_adapter));
    // Without `claude`, the detail line names the adapter.
    assert_eq!(
        claude.detail,
        "~/bin/claude-agent-acp · ACP adapter claude-agent-acp"
    );

    let spec = core.agent_spec("codex").unwrap();
    assert_eq!(spec.program, real(&codex_adapter));
    assert_eq!(
        spec.env,
        [("CODEX_PATH".to_owned(), real(&codex).display().to_string())]
    );
    assert_eq!(spec.detail, "~/bin/codex · ACP adapter codex-acp");
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn opencode_and_gemini_run_their_own_acp_mode() {
    let fixture = Fixture::new();
    let opencode = fixture.install("opencode");
    let gemini = fixture.install("gemini");
    let core = fixture.core().await;

    let spec = core.agent_spec("opencode").unwrap();
    assert_eq!(spec.name, "OpenCode");
    assert_eq!(spec.program, real(&opencode));
    assert_eq!(spec.args, ["acp"]);
    assert!(spec.env.is_empty());
    assert_eq!(spec.detail, "~/bin/opencode · built-in ACP");

    let spec = core.agent_spec("gemini").unwrap();
    assert_eq!(spec.name, "Gemini CLI");
    assert_eq!(spec.program, real(&gemini));
    assert_eq!(spec.args, ["--acp"]);
    assert!(spec.env.is_empty());
    assert_eq!(spec.detail, "~/bin/gemini · built-in ACP");
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn an_unknown_or_missing_agent_has_no_spec() {
    let fixture = Fixture::new();
    // Neither a file without the execute bit nor a folder is a program.
    std::fs::write(fixture.bin().join("gemini"), "#!/bin/sh\n").unwrap();
    std::fs::create_dir_all(fixture.bin().join("opencode")).unwrap();
    let my_agent = fixture.install("my-agent");
    let core = fixture.core().await;

    let unknown = core.agent_spec("nobody").unwrap_err();
    assert_eq!(unknown.code, ErrorCode::NotFound);
    let cases = [
        (
            "codex",
            "Install codex-acp (npm install -g @agentclientprotocol/codex-acp), then check again.",
        ),
        ("gemini", "Install Gemini CLI, then check again."),
        ("opencode", "Install OpenCode, then check again."),
    ];
    for (id, hint) in cases {
        let error = core.agent_spec(id).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{id}");
        assert_eq!(error.message, hint, "{id}");
    }

    // A custom agent whose program went away after it was added.
    let mine = core.agent_custom_add("Mine", "my-agent --acp").unwrap();
    std::fs::remove_file(&my_agent).unwrap();
    let error = core.agent_spec(&mine.id).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.message, "No such command: my-agent");
    let statuses = core.agents_status().unwrap();
    let gone = row(&statuses, &mine.id);
    assert_eq!(gone.state, AgentState::NotInstalled);
    assert_eq!(gone.hint.as_deref(), Some("No such command: my-agent"));
    assert_eq!(gone.detail.as_deref(), Some("my-agent --acp"));
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[tokio::test]
async fn adding_an_agent_checks_its_name_and_command() {
    let fixture = Fixture::new();
    fixture.install("my-agent");
    let core = fixture.core().await;

    let cases = [
        (" ", "my-agent", "Enter a name and a command."),
        ("Mine", "  ", "Enter a name and a command."),
        (
            "Mine",
            "missing-agent --acp",
            "No such command: missing-agent",
        ),
        // A relative path would depend on the app's working folder.
        ("Mine", "./my-agent", "No such command: ./my-agent"),
        // An unclosed quote: the first word as typed.
        ("Mine", "'my-agent --acp", "No such command: 'my-agent"),
        (
            "claude",
            "my-agent",
            "An agent named claude already exists.",
        ),
        (
            "Gemini CLI",
            "my-agent",
            "An agent named Gemini CLI already exists.",
        ),
    ];
    for (name, command, message) in cases {
        let error = core.agent_custom_add(name, command).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{name} / {command}");
        assert_eq!(error.message, message, "{name} / {command}");
    }
    assert!(core.agent_prefs().custom.is_empty());

    let added = core.agent_custom_add(" Mine ", " my-agent --acp ").unwrap();
    assert_eq!(added.name, "Mine");
    assert_eq!(added.detail.as_deref(), Some("my-agent --acp"));
    let hex = added.id.strip_prefix("custom-").unwrap();
    assert_eq!(hex.len(), 8, "{}", added.id);
    assert!(
        hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "{}",
        added.id
    );
    let taken = core.agent_custom_add("MINE", "my-agent").unwrap_err();
    assert_eq!(taken.code, ErrorCode::InvalidInput);
    assert_eq!(taken.message, "An agent named MINE already exists.");
    let custom = core.agent_prefs().custom;
    assert_eq!(custom.len(), 1);
    assert_eq!(custom[0].id, added.id);
    assert_eq!(custom[0].name, "Mine");
    assert_eq!(custom[0].command, "my-agent --acp");
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_custom_command_is_split_like_a_shell_and_found_on_path_or_under_home() {
    let fixture = Fixture::new();
    let on_path = fixture.install("my-agent");
    let under_home = fixture.script(&fixture.home().join("tools/agent"), "home-agent");
    let elsewhere = fixture.script(&fixture.root.path().join("opt/agent"), "opt-agent");
    let quoted_path = format!("'{}'", elsewhere.display());
    let core = fixture.core().await;

    let commands = [
        (
            "Quoted",
            r#"my-agent --mode "a b" --x=1"#,
            real(&on_path),
            vec!["--mode", "a b", "--x=1"],
        ),
        ("Home", "~/tools/agent acp", real(&under_home), vec!["acp"]),
        ("Elsewhere", quoted_path.as_str(), real(&elsewhere), vec![]),
    ];
    for (name, command, program, args) in commands {
        let added = core.agent_custom_add(name, command).unwrap();
        let spec = core.agent_spec(&added.id).unwrap();
        assert_eq!(spec.id, added.id);
        assert_eq!(spec.name, name);
        assert_eq!(spec.program, program, "{command}");
        assert_eq!(spec.args, args, "{command}");
        assert_eq!(spec.detail, command);
        assert!(spec.env.is_empty(), "{command}");
        assert!(spec.custom);
    }
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}

#[tokio::test]
async fn custom_agents_and_the_default_are_saved_and_a_removed_default_is_forgotten() {
    let fixture = Fixture::new();
    fixture.install("my-agent");
    let core = fixture.core().await;
    let mine = core.agent_custom_add("Mine", "my-agent --acp").unwrap();

    core.agent_default_set(&mine.id).unwrap();
    let statuses = core.agents_status().unwrap();
    let defaults: Vec<&str> = statuses
        .iter()
        .filter(|status| status.is_default)
        .map(|status| status.id.as_str())
        .collect();
    assert_eq!(defaults, [mine.id.as_str()]);
    // A listed agent that is not installed can be the default too.
    core.agent_default_set("codex").unwrap();
    assert!(row(&core.agents_status().unwrap(), "codex").is_default);
    let unknown = core.agent_default_set("nobody").unwrap_err();
    assert_eq!(unknown.code, ErrorCode::NotFound);
    core.agent_default_set(&mine.id).unwrap();
    core.shutdown().await;

    let core = fixture.core().await;
    let prefs = core.agent_prefs();
    assert_eq!(prefs.default_agent.as_deref(), Some(mine.id.as_str()));
    assert_eq!(prefs.custom.len(), 1);
    assert_eq!(prefs.custom[0].command, "my-agent --acp");
    // Built-in agents cannot be removed.
    for id in ["claude", "custom-ffffffff"] {
        let error = core.agent_custom_remove(id).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound, "{id}");
    }

    core.agent_custom_remove(&mine.id).unwrap();

    let prefs = core.agent_prefs();
    assert_eq!(prefs.default_agent, None);
    assert!(prefs.custom.is_empty());
    let statuses = core.agents_status().unwrap();
    assert_eq!(statuses.len(), 4);
    assert!(statuses.iter().all(|status| !status.is_default));
    let again = core.agent_custom_remove(&mine.id).unwrap_err();
    assert_eq!(again.code, ErrorCode::NotFound);
    assert!(fixture.nothing_ran());
    core.shutdown().await;
}
