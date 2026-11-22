//! Seatbelt (spec §4.6, macOS): the profile that builds a chat's sandbox, the command that starts
//! the agent under `sandbox-exec`, and whether Seatbelt can start a sandbox here. Written from
//! `sandbox-exec(1)` and the profile language as Apple's own profiles use it: `(deny default)`
//! first, then rules, a later rule winning over an earlier one it overlaps. Seatbelt matches
//! resolved paths, so every path goes in by its real path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::paths::real_path;
use super::spec::{ChatPorts, SandboxSpec};
use super::{configure, SandboxKind, SandboxStatus};
use crate::process::{self, Output, ProcessOutput, ProcessSpec};
use crate::tools::is_executable;

/// Seatbelt's command-line front end.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
/// The global Mach services the agent may look up: the Keychain and certificate trust that a
/// sign-in and TLS need, logging, notifications and user lookups. Never
/// `com.apple.coreservices.launchservicesd`, which would let the agent open apps outside the
/// sandbox.
pub const MACH_SERVICES: &[&str] = &[
    "com.apple.SecurityServer",
    "com.apple.securityd.xpc",
    "com.apple.system.logger",
    "com.apple.system.notification_center",
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.trustd.agent",
    "com.apple.logd",
];
/// Spec §4.6's check that Seatbelt can start a sandbox here.
const STATUS_PROFILE: &str = "(version 1)(allow default)";
const STATUS_PROGRAM: &str = "/usr/bin/true";
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const STATUS_OUTPUT_LIMIT: usize = 16 * 1024;
/// The rules every profile starts with: nothing but what follows, the agent's own processes and
/// signals among themselves, system settings, mapping code, and reading the system.
const OPENING: [&str; 8] = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec*)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-map-executable)",
    r#"(allow file-read* (subpath "/"))"#,
];

/// Spec §4.6's profile for `spec`, one rule a line, in this order: the opening rules; no reading
/// under the home folder, except the folders above an allowed path, which the agent may `stat`
/// on its way down; reading again each `read_write` and `read_only` path; writing each
/// `read_write` path, `/dev/null` and the terminals; no reading or writing the hidden kubeconfig
/// files, last among the file rules so that no allowed folder opens them again; connecting to
/// `localhost:<proxy>` and `localhost:<mcp>` only; looking up `MACH_SERVICES` only.
pub fn profile(spec: &SandboxSpec, ports: ChatPorts) -> String {
    let home = real_path(&spec.home);
    let read_write: Vec<PathBuf> = spec.read_write.iter().map(|path| real_path(path)).collect();
    let read_only: Vec<PathBuf> = spec.read_only.iter().map(|path| real_path(path)).collect();
    let allowed: Vec<&PathBuf> = read_write.iter().chain(&read_only).collect();
    let mut rules: Vec<String> = OPENING.iter().map(|rule| rule.to_string()).collect();
    rules.push(format!("(deny file-read* (subpath {}))", quoted(&home)));
    for folder in folders_above(&home, &allowed) {
        rules.push(format!(
            "(allow file-read-metadata (literal {}))",
            quoted(&folder)
        ));
    }
    for path in &allowed {
        rules.push(format!("(allow file-read* (subpath {}))", quoted(path)));
    }
    for path in &read_write {
        rules.push(format!("(allow file-write* (subpath {}))", quoted(path)));
    }
    rules.push(r#"(allow file-write* (literal "/dev/null"))"#.to_owned());
    rules.push(r##"(allow file-write* (regex #"^/dev/tty"))"##.to_owned());
    for file in &spec.hidden_files {
        rules.push(format!(
            "(deny file-read* file-write* (literal {}))",
            quoted(&real_path(file))
        ));
    }
    for port in [ports.proxy, ports.mcp] {
        rules.push(format!(
            r#"(allow network-outbound (remote ip "localhost:{port}"))"#
        ));
    }
    for service in MACH_SERVICES {
        rules.push(format!(
            "(allow mach-lookup (global-name {}))",
            quote(service)
        ));
    }
    let mut profile = rules.join("\n");
    profile.push('\n');
    profile
}

/// The folders from `home` down to each path under it, the paths themselves left out, each once.
fn folders_above(home: &Path, paths: &[&PathBuf]) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    for path in paths {
        let mut above: Vec<&Path> = path
            .ancestors()
            .skip(1)
            .take_while(|folder| folder.starts_with(home))
            .collect();
        above.reverse();
        for folder in above {
            if !folders.iter().any(|known| known == folder) {
                folders.push(folder.to_path_buf());
            }
        }
    }
    folders
}

fn quoted(path: &Path) -> String {
    quote(&path.display().to_string())
}

/// `text` as a profile string: in double quotes, with `"` and `\` escaped.
fn quote(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len() + 2);
    escaped.push('"');
    for character in text.chars() {
        if character == '"' || character == '\\' {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('"');
    escaped
}

/// `sandbox-exec -p <profile> <program> <args>` with only the spec's environment, in the agent's
/// folder; stdin, stdout and stderr piped, a kill when dropped, its own process group.
pub fn seatbelt_command(spec: &SandboxSpec, ports: ChatPorts) -> Command {
    let mut command = Command::new(SANDBOX_EXEC);
    command
        .arg("-p")
        .arg(profile(spec, ports))
        .arg(&spec.program)
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .current_dir(&spec.agent_dir);
    configure(&mut command);
    command
}

/// Whether Seatbelt can start a sandbox here.
pub async fn status() -> SandboxStatus {
    status_of(Path::new(SANDBOX_EXEC)).await
}

/// `status` with the `sandbox-exec` given: `NotInstalled` when it is missing; `CannotStart` with
/// the first line of its stderr when spec §4.6's check fails; else `Ready`.
pub(crate) async fn status_of(sandbox_exec: &Path) -> SandboxStatus {
    if !is_executable(sandbox_exec) {
        return SandboxStatus::NotInstalled;
    }
    let check = ProcessSpec::new(
        sandbox_exec,
        ["-p", STATUS_PROFILE, STATUS_PROGRAM],
        STATUS_TIMEOUT,
    );
    let output = Output::Capture {
        stdout_limit: STATUS_OUTPUT_LIMIT,
        stderr_limit: STATUS_OUTPUT_LIMIT,
    };
    match process::run(check, output, CancellationToken::new()).await {
        Ok(output) if output.success() => SandboxStatus::Ready {
            kind: SandboxKind::Seatbelt,
        },
        Ok(output) => SandboxStatus::CannotStart {
            error: first_line(&output),
        },
        Err(error) => SandboxStatus::CannotStart {
            error: error.to_string(),
        },
    }
}

/// The first line of stderr that is not blank, trimmed, or how the check ended.
fn first_line(output: &ProcessOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if let Some(line) = stderr.lines().map(str::trim).find(|line| !line.is_empty()) {
        return line.to_owned();
    }
    match output.code {
        Some(code) => format!("sandbox-exec exited with code {code}"),
        None => "sandbox-exec was stopped by a signal".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    const HOME: &str = "/Users/skopos-test";
    const DATA: &str = "/Users/skopos-test/Library/Application Support/dev.skopos.SkoposIDE/agents";
    const PACKAGE: &str = "/opt/skopos-test/lib/node_modules/@agentclientprotocol/claude-agent-acp";
    const APP_FOLDER: &str = "/Applications/SkoposIDE.app/Contents/MacOS";
    const PORTS: ChatPorts = ChatPorts {
        proxy: 50001,
        mcp: 50002,
    };

    fn fixed_spec() -> SandboxSpec {
        let work = PathBuf::from(format!("{DATA}/work/claude"));
        let run = PathBuf::from(format!("{DATA}/run/0a1b2c3d"));
        SandboxSpec {
            agent_dir: work.clone(),
            run_dir: run.clone(),
            tmp_dir: run.join("tmp"),
            home: PathBuf::from(HOME),
            read_write: vec![
                work,
                PathBuf::from(format!("{HOME}/.claude")),
                run.join("tmp"),
            ],
            read_only: vec![
                PathBuf::from(PACKAGE),
                PathBuf::from("/opt/skopos-test/node"),
                PathBuf::from(APP_FOLDER),
            ],
            hidden_files: vec![PathBuf::from("/etc/skopos-test/config")],
            env: vec![
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), HOME.to_owned()),
                ("TERM".to_owned(), "dumb".to_owned()),
            ],
            app_binary: PathBuf::from(format!("{APP_FOLDER}/skopos-ide")),
            program: PathBuf::from(format!("{PACKAGE}/dist/index.js")),
            args: vec!["--verbose".to_owned()],
        }
    }

    #[test]
    fn the_profile_of_a_fixed_spec() {
        let work = format!("{DATA}/work/claude");
        let tmp = format!("{DATA}/run/0a1b2c3d/tmp");
        let expected: Vec<String> = vec![
            "(version 1)".to_owned(),
            "(deny default)".to_owned(),
            "(allow process-fork)".to_owned(),
            "(allow process-exec*)".to_owned(),
            "(allow signal (target same-sandbox))".to_owned(),
            "(allow sysctl-read)".to_owned(),
            "(allow file-map-executable)".to_owned(),
            r#"(allow file-read* (subpath "/"))"#.to_owned(),
            format!(r#"(deny file-read* (subpath "{HOME}"))"#),
            format!(r#"(allow file-read-metadata (literal "{HOME}"))"#),
            format!(r#"(allow file-read-metadata (literal "{HOME}/Library"))"#),
            format!(r#"(allow file-read-metadata (literal "{HOME}/Library/Application Support"))"#),
            format!(
                r#"(allow file-read-metadata (literal "{HOME}/Library/Application Support/dev.skopos.SkoposIDE"))"#
            ),
            format!(r#"(allow file-read-metadata (literal "{DATA}"))"#),
            format!(r#"(allow file-read-metadata (literal "{DATA}/work"))"#),
            format!(r#"(allow file-read-metadata (literal "{DATA}/run"))"#),
            format!(r#"(allow file-read-metadata (literal "{DATA}/run/0a1b2c3d"))"#),
            format!(r#"(allow file-read* (subpath "{work}"))"#),
            format!(r#"(allow file-read* (subpath "{HOME}/.claude"))"#),
            format!(r#"(allow file-read* (subpath "{tmp}"))"#),
            format!(r#"(allow file-read* (subpath "{PACKAGE}"))"#),
            r#"(allow file-read* (subpath "/opt/skopos-test/node"))"#.to_owned(),
            format!(r#"(allow file-read* (subpath "{APP_FOLDER}"))"#),
            format!(r#"(allow file-write* (subpath "{work}"))"#),
            format!(r#"(allow file-write* (subpath "{HOME}/.claude"))"#),
            format!(r#"(allow file-write* (subpath "{tmp}"))"#),
            r#"(allow file-write* (literal "/dev/null"))"#.to_owned(),
            r##"(allow file-write* (regex #"^/dev/tty"))"##.to_owned(),
            r#"(deny file-read* file-write* (literal "/etc/skopos-test/config"))"#.to_owned(),
            r#"(allow network-outbound (remote ip "localhost:50001"))"#.to_owned(),
            r#"(allow network-outbound (remote ip "localhost:50002"))"#.to_owned(),
            r#"(allow mach-lookup (global-name "com.apple.SecurityServer"))"#.to_owned(),
            r#"(allow mach-lookup (global-name "com.apple.securityd.xpc"))"#.to_owned(),
            r#"(allow mach-lookup (global-name "com.apple.system.logger"))"#.to_owned(),
            r#"(allow mach-lookup (global-name "com.apple.system.notification_center"))"#
                .to_owned(),
            r#"(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))"#
                .to_owned(),
            r#"(allow mach-lookup (global-name "com.apple.trustd.agent"))"#.to_owned(),
            r#"(allow mach-lookup (global-name "com.apple.logd"))"#.to_owned(),
        ];
        let text = profile(&fixed_spec(), PORTS);
        assert_eq!(text.lines().collect::<Vec<_>>(), expected);
        assert!(text.ends_with(")\n"));
    }

    #[test]
    fn quotes_and_backslashes_in_paths_are_escaped() {
        let mut spec = fixed_spec();
        spec.read_only = vec![PathBuf::from(r#"/opt/skopos-test/odd "name"\dir"#)];
        let text = profile(&spec, PORTS);
        assert!(
            text.contains(r#"(allow file-read* (subpath "/opt/skopos-test/odd \"name\"\\dir"))"#),
            "{text}"
        );
    }

    #[test]
    fn the_agent_may_reach_only_the_chat_ports_and_the_listed_services() {
        let text = profile(&fixed_spec(), PORTS);
        assert_eq!(text.matches("network-outbound").count(), 2);
        assert!(!text.contains("network-inbound"));
        assert_eq!(
            text.matches("(allow mach-lookup").count(),
            MACH_SERVICES.len()
        );
        // It would let the agent open apps outside the sandbox.
        assert!(!text.contains("com.apple.coreservices.launchservicesd"));
    }

    #[test]
    fn the_command_runs_the_program_under_sandbox_exec_with_only_the_spec_environment() {
        let spec = fixed_spec();
        let text = profile(&spec, PORTS);
        let command = seatbelt_command(&spec, PORTS);
        let command = command.as_std();
        assert_eq!(command.get_program(), SANDBOX_EXEC);
        let args: Vec<&OsStr> = command.get_args().collect();
        assert_eq!(
            args,
            [
                OsStr::new("-p"),
                OsStr::new(&text),
                spec.program.as_os_str(),
                OsStr::new("--verbose"),
            ]
        );
        let mut envs: Vec<(String, String)> = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.unwrap().to_string_lossy().into_owned(),
                )
            })
            .collect();
        envs.sort();
        let mut given = spec.env.clone();
        given.sort();
        assert_eq!(envs, given);
        assert_eq!(command.get_current_dir(), Some(spec.agent_dir.as_path()));
    }

    /// A `sandbox-exec` in `dir` running `body`.
    fn fake_sandbox_exec(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("sandbox-exec");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn without_sandbox_exec_the_sandbox_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            status_of(&dir.path().join("sandbox-exec")).await,
            SandboxStatus::NotInstalled
        );
    }

    #[tokio::test]
    async fn a_sandbox_exec_that_cannot_run_the_probe_gives_its_first_line_of_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let failing = fake_sandbox_exec(
            dir.path(),
            "printf '\\nsandbox-exec: sandbox_apply: Operation not permitted\\n' >&2; exit 65",
        );
        assert_eq!(
            status_of(&failing).await,
            SandboxStatus::CannotStart {
                error: "sandbox-exec: sandbox_apply: Operation not permitted".to_owned()
            }
        );
        let quiet_dir = tempfile::tempdir().unwrap();
        let quiet = fake_sandbox_exec(quiet_dir.path(), "exit 3");
        assert_eq!(
            status_of(&quiet).await,
            SandboxStatus::CannotStart {
                error: "sandbox-exec exited with code 3".to_owned()
            }
        );
    }

    #[tokio::test]
    async fn a_sandbox_exec_that_runs_the_probe_makes_the_sandbox_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = fake_sandbox_exec(
            dir.path(),
            "[ \"$*\" = '-p (version 1)(allow default) /usr/bin/true' ] || exit 9",
        );
        assert_eq!(
            status_of(&path).await,
            SandboxStatus::Ready {
                kind: SandboxKind::Seatbelt
            }
        );
    }
}
