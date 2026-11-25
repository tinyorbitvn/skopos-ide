//! How an agent starts (native agents spec §4.2): as the person's own process, with the app's
//! environment, the chat's variables, and the chat's folder as its working folder.

use std::ffi::OsString;
use std::path::Path;

use tokio::process::Command;

use crate::agents::registry::AgentSpec;
use crate::process::configure_agent;

/// Gives `--agent-mcp` the chat's token.
pub(crate) const TOKEN_VAR: &str = "SKOPOS_AGENT_TOKEN";

/// The app's environment, which holds the login shell's (`shell_env.rs`). A variable whose
/// name or value is not Unicode is left out, where `std::env::vars` would panic.
pub(crate) fn app_env() -> impl Iterator<Item = (String, String)> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
}

/// The app's environment, with the agent's install folders after `PATH`, then the agent's own
/// variables, then `extra` (the chat's), each later value replacing an earlier one.
pub(crate) fn agent_env(
    base: impl IntoIterator<Item = (String, String)>,
    agent: &AgentSpec,
    extra: &[(String, String)],
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base.into_iter().collect();
    let path_key = env
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
        .map(|(name, _)| name.clone())
        .unwrap_or_else(|| "PATH".to_owned());
    if !agent.path_dirs.is_empty() {
        let current = env
            .iter()
            .find(|(name, _)| *name == path_key)
            .map(|(_, value)| OsString::from(value))
            .unwrap_or_default();
        // An empty entry would mean the working folder; a missing PATH splits into one.
        let mut dirs: Vec<_> = std::env::split_paths(&current)
            .filter(|dir| !dir.as_os_str().is_empty())
            .collect();
        dirs.extend(agent.path_dirs.iter().cloned());
        if let Ok(joined) = std::env::join_paths(dirs) {
            set(&mut env, &path_key, joined.to_string_lossy().into_owned());
        }
    }
    for (name, value) in agent.env.iter().chain(extra.iter()) {
        set(&mut env, name, value.clone());
    }
    env
}

fn set(env: &mut Vec<(String, String)>, name: &str, value: String) {
    env.retain(|(existing, _)| existing != name);
    env.push((name.to_owned(), value));
}

/// The agent's command: its program and arguments, exactly `env`, in `cwd`.
pub(crate) fn agent_command(agent: &AgentSpec, cwd: &Path, env: Vec<(String, String)>) -> Command {
    let mut command = Command::new(&agent.program);
    command
        .args(&agent.args)
        .env_clear()
        .envs(env)
        .current_dir(cwd);
    configure_agent(&mut command);
    command
}

/// An agent for tests: its program alone, with no variables of its own.
#[cfg(test)]
pub(crate) fn test_agent(program: &Path) -> AgentSpec {
    AgentSpec {
        id: "probe".to_owned(),
        name: "Probe".to_owned(),
        program: program.to_path_buf(),
        args: Vec::new(),
        env: Vec::new(),
        detail: String::new(),
        path_dirs: Vec::new(),
        custom: true,
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::path::PathBuf;

    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
        env.iter()
            .find(|(existing, _)| existing == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn the_app_s_variables_are_kept() {
        let agent = test_agent(Path::new("/bin/agent"));
        let base = pairs(&[("HOME", "/home/me"), ("LANG", "en_US.UTF-8")]);
        let env = agent_env(base.clone(), &agent, &[]);
        assert_eq!(env, base);
    }

    #[cfg(unix)]
    #[test]
    fn the_agent_s_install_folders_come_after_path() {
        let mut agent = test_agent(Path::new("/bin/agent"));
        agent.path_dirs = vec![
            PathBuf::from("/home/me/.opencode/bin"),
            PathBuf::from("/home/me/.local/bin"),
        ];
        let env = agent_env(pairs(&[("PATH", "/usr/bin:/bin")]), &agent, &[]);
        assert_eq!(
            value(&env, "PATH"),
            Some("/usr/bin:/bin:/home/me/.opencode/bin:/home/me/.local/bin")
        );
        // Without a PATH, the install folders are the whole of it.
        let env = agent_env(Vec::new(), &agent, &[]);
        assert_eq!(
            value(&env, "PATH"),
            Some("/home/me/.opencode/bin:/home/me/.local/bin")
        );
    }

    #[test]
    fn the_agent_s_then_the_chat_s_variables_replace_the_app_s() {
        let mut agent = test_agent(Path::new("/bin/agent"));
        agent.env = pairs(&[("CLAUDE_CODE_EXECUTABLE", "/opt/claude"), ("MODE", "agent")]);
        let base = pairs(&[
            ("KUBECONFIG", "/home/me/.kube/config"),
            ("MODE", "app"),
            ("CLAUDE_CODE_EXECUTABLE", "/usr/bin/claude"),
        ]);
        let extra = pairs(&[("KUBECONFIG", "/run/chat/kubeconfig"), ("MODE", "chat")]);
        let env = agent_env(base, &agent, &extra);
        assert_eq!(value(&env, "KUBECONFIG"), Some("/run/chat/kubeconfig"));
        assert_eq!(value(&env, "CLAUDE_CODE_EXECUTABLE"), Some("/opt/claude"));
        assert_eq!(value(&env, "MODE"), Some("chat"));
        // Each name once.
        assert_eq!(env.len(), 3);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_command_runs_with_exactly_its_environment_in_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(dir.path()).unwrap();
        let env = pairs(&[("PATH", "/usr/bin:/bin"), ("PROBE", "on")]);
        let printed = agent_command(&test_agent(Path::new("/usr/bin/env")), &folder, env.clone())
            .output()
            .await
            .unwrap();
        let mut lines: Vec<String> = String::from_utf8(printed.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        lines.sort();
        assert_eq!(lines, ["PATH=/usr/bin:/bin", "PROBE=on"]);
        let mut pwd = test_agent(Path::new("/bin/pwd"));
        pwd.args = vec!["-P".to_owned()];
        let printed = agent_command(&pwd, &folder, env).output().await.unwrap();
        assert_eq!(
            String::from_utf8(printed.stdout).unwrap().trim_end(),
            folder.display().to_string()
        );
    }
}
