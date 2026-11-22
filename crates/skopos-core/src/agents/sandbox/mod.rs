//! The agent sandbox (spec §4.6). `spec` decides what a chat's sandbox allows, `env` the agent's
//! environment, `paths` where installs lie and which kubeconfig files to hide. Per OS,
//! `sandbox_command` starts the agent inside it: bubblewrap on Linux (`linux`), Seatbelt on
//! macOS. No agent runs outside it (spec §6.1) except through `direct_command`, the test-only
//! switch of R2. Windows has no sandbox, so nothing starts there.

pub mod env;
#[cfg(target_os = "linux")]
pub mod init;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod paths;
pub mod spec;

use std::process::Stdio;

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::app_core::AppCore;
use crate::error::CoreResult;
pub use spec::{build_spec, ChatPorts, SandboxSpec, SpecInput};

/// The app binary's hidden mode that runs the port bridge inside the Linux sandbox.
pub const AGENT_INIT: &str = "--agent-init";
/// The app binary's hidden mode that the agent launches as its `skopos` MCP server.
pub const AGENT_MCP: &str = "--agent-mcp";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SandboxKind {
    Bubblewrap,
    Seatbelt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "status")]
#[ts(export)]
pub enum SandboxStatus {
    Ready { kind: SandboxKind },
    NotInstalled,
    CannotStart { error: String },
    Unsupported,
}

/// The status for the app run: the machine's sandbox does not change while the app runs, except
/// when the person installs bubblewrap and checks again (`refresh`).
static STATUS: Mutex<Option<SandboxStatus>> = Mutex::const_new(None);

/// Whether this machine can start the agent sandbox.
#[cfg(target_os = "linux")]
pub async fn sandbox_status() -> SandboxStatus {
    linux::status().await
}

/// Whether this machine can start the agent sandbox.
#[cfg(target_os = "macos")]
pub async fn sandbox_status() -> SandboxStatus {
    macos::status().await
}

/// Whether this machine can start the agent sandbox.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub async fn sandbox_status() -> SandboxStatus {
    SandboxStatus::Unsupported
}

/// The command that starts the agent of `spec` inside its sandbox, with stdin, stdout and stderr
/// piped, a kill when dropped, and its own process group.
#[cfg(target_os = "linux")]
pub fn sandbox_command(spec: &SandboxSpec, _ports: ChatPorts) -> CoreResult<Command> {
    linux::bwrap_command(spec)
}

/// The command that starts the agent of `spec` inside its sandbox, under the chat's Seatbelt
/// profile, which lets it reach only `ports` on the loopback.
#[cfg(target_os = "macos")]
pub fn sandbox_command(spec: &SandboxSpec, ports: ChatPorts) -> CoreResult<Command> {
    Ok(macos::seatbelt_command(spec, ports))
}

/// The command that starts the agent of `spec` inside its sandbox.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn sandbox_command(_spec: &SandboxSpec, _ports: ChatPorts) -> CoreResult<Command> {
    Err(crate::error::IpcError::new(
        crate::error::ErrorCode::Unsupported,
        "Agents are not available on Windows.",
    ))
}

/// R2's test-only start: the agent's program with its arguments, environment and folder, and no
/// sandbox. Chats and probes use it only while the sandbox is off for tests.
pub fn direct_command(spec: &SandboxSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .current_dir(&spec.agent_dir);
    configure(&mut command);
    command
}

/// What every agent command has: stdin and stdout piped for ACP, stderr piped for the log, a
/// kill when the handle is dropped, and on Unix a process group of its own, so ending a chat
/// stops everything the agent started.
pub(crate) fn configure(command: &mut Command) {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
}

impl AppCore {
    /// The sandbox's status, found once per app run; `refresh` finds it again, as `Check
    /// again` does. `Unsupported` on Windows.
    pub async fn agent_sandbox_status(&self, refresh: bool) -> SandboxStatus {
        let mut kept = STATUS.lock().await;
        if !refresh {
            if let Some(status) = kept.as_ref() {
                return status.clone();
            }
        }
        let status = sandbox_status().await;
        *kept = Some(status.clone());
        status
    }
}

/// An agent for the sandbox builders' tests: its program alone, with no settings, keys or
/// extra variables.
#[cfg(test)]
pub(crate) fn test_agent(program: &std::path::Path) -> crate::agents::registry::AgentSpec {
    crate::agents::registry::AgentSpec {
        id: "probe".to_owned(),
        name: "Probe".to_owned(),
        program: program.to_path_buf(),
        args: Vec::new(),
        env: Vec::new(),
        detail: String::new(),
        settings: Vec::new(),
        hosts: Vec::new(),
        key_vars: Vec::new(),
        install_paths: vec![program.to_path_buf()],
        custom: true,
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::*;
    use crate::paths::AppPaths;

    /// A spec that runs `program` in `agent_dir` with `env`, and allows nothing else.
    fn spec_in(
        agent_dir: &Path,
        program: &str,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> SandboxSpec {
        SandboxSpec {
            agent_dir: agent_dir.to_path_buf(),
            run_dir: agent_dir.join("run"),
            tmp_dir: agent_dir.join("run/tmp"),
            home: agent_dir.join("home"),
            read_write: vec![agent_dir.to_path_buf()],
            read_only: Vec::new(),
            linked: Vec::new(),
            hidden_files: Vec::new(),
            env: env
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            app_binary: PathBuf::from(program),
            program: PathBuf::from(program),
            args: args.iter().map(|arg| arg.to_string()).collect(),
        }
    }

    #[test]
    fn the_status_is_tagged_by_status_in_camel_case() {
        let ready = SandboxStatus::Ready {
            kind: SandboxKind::Bubblewrap,
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            json!({"status": "ready", "kind": "bubblewrap"})
        );
        let seatbelt = SandboxStatus::Ready {
            kind: SandboxKind::Seatbelt,
        };
        assert_eq!(
            serde_json::to_value(seatbelt).unwrap(),
            json!({"status": "ready", "kind": "seatbelt"})
        );
        assert_eq!(
            serde_json::to_value(SandboxStatus::NotInstalled).unwrap(),
            json!({"status": "notInstalled"})
        );
        let failed = SandboxStatus::CannotStart {
            error: "setting up uid map: Permission denied".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(failed).unwrap(),
            json!({"status": "cannotStart", "error": "setting up uid map: Permission denied"})
        );
        assert_eq!(
            serde_json::to_value(SandboxStatus::Unsupported).unwrap(),
            json!({"status": "unsupported"})
        );
    }

    #[tokio::test]
    async fn the_status_is_kept_for_the_app_run_until_refreshed() {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
        let core = AppCore::start_with_kubeconfig_env(paths, None)
            .await
            .unwrap();
        let kept = SandboxStatus::CannotStart {
            error: "kept from earlier".to_owned(),
        };
        *STATUS.lock().await = Some(kept.clone());
        assert_eq!(core.agent_sandbox_status(false).await, kept);
        let fresh = core.agent_sandbox_status(true).await;
        assert_eq!(fresh, sandbox_status().await);
        assert_eq!(core.agent_sandbox_status(false).await, fresh);
        #[cfg(windows)]
        assert_eq!(fresh, SandboxStatus::Unsupported);
        core.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_direct_command_gives_the_agent_only_the_spec_environment_and_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = paths::real_path(dir.path()).join("work");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let env = [("PATH", "/usr/bin:/bin"), ("PROBE", "on")];
        let printed = direct_command(&spec_in(&agent_dir, "/usr/bin/env", &[], &env))
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
        let folder = direct_command(&spec_in(&agent_dir, "/bin/pwd", &["-P"], &env))
            .output()
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(folder.stdout).unwrap().trim_end(),
            agent_dir.display().to_string()
        );
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_no_agent_starts() {
        let spec = spec_in(Path::new("C:\\agents"), "C:\\agent.exe", &[], &[]);
        let error = sandbox_command(&spec, ChatPorts { proxy: 1, mcp: 2 }).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Unsupported);
        assert_eq!(error.message, "Agents are not available on Windows.");
    }
}
