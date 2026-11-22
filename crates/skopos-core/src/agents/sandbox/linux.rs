//! bubblewrap (spec §4.6, Linux): the arguments that build a chat's sandbox, the command that
//! starts the agent in it through the app binary's `--agent-init`, and whether bubblewrap can
//! start a sandbox on this machine. Written from bubblewrap's manual (`bwrap.xml`): options
//! apply in the order given, and a missing destination's folders are created.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::time::Duration;

use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::spec::{SandboxSpec, EMPTY_FOLDERS, MCP_SOCKET, PROXY_SOCKET};
use super::{configure, SandboxKind, SandboxStatus, AGENT_INIT};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::process::{self, Output, ProcessOutput, ProcessSpec};
use crate::tools::find_on_path;

/// Where the chat's runtime folder appears inside the sandbox, read-only.
pub const SANDBOX_RUN_DIR: &str = "/run/skopos";
/// Spec §3.5's reason when `bwrap` is missing.
pub const NOT_INSTALLED: &str =
    "bubblewrap is not installed. Install the bwrap command, then check again.";
/// Spec §4.6's check that bubblewrap can start a sandbox here.
const STATUS_ARGS: [&str; 7] = [
    "--ro-bind",
    "/",
    "/",
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "true",
];
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
/// Variables glibc drops from the environment of a setuid program, which bubblewrap is on some
/// systems. Their values are paths, never secrets, so they also go in as arguments, which
/// bubblewrap sets after it starts.
const SECURE_MODE_DROPS: [&str; 3] = ["TMPDIR", "TZDIR", "LOCPATH"];
const STATUS_OUTPUT_LIMIT: usize = 16 * 1024;

/// Spec §4.6's arguments, in order: the namespaces (all of them, a user namespace, no nested
/// ones) and a new session; the system read-only with fresh `/dev` and `/proc`; empty tmpfs
/// folders over `/tmp`, `/run`, `/var/tmp` and the home folder, the home last so a home under
/// one of the others (as in tests) still gets its own; the agent's paths bound back, writable
/// ones first, then each linked path from its real path; `/dev/null` over each hidden file; the
/// runtime folder at `/run/skopos`; `SECURE_MODE_DROPS` from the spec's environment; the
/// agent's folder as the working directory; then the app binary's `--agent-init` with the two
/// sockets, `--` and the agent's command. The rest of the environment is not in the arguments,
/// which any process of the person's can read: `bwrap_command` gives it.
pub fn bwrap_args(spec: &SandboxSpec) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for flag in [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--unshare-user",
        "--disable-userns",
    ] {
        add(&mut args, &[os(flag)]);
    }
    add(&mut args, &[os("--ro-bind"), os("/"), os("/")]);
    add(&mut args, &[os("--dev"), os("/dev")]);
    add(&mut args, &[os("--proc"), os("/proc")]);
    for folder in EMPTY_FOLDERS {
        add(&mut args, &[os("--tmpfs"), os(folder)]);
    }
    add(&mut args, &[os("--tmpfs"), spec.home.as_os_str()]);
    // The `-try` forms skip a path that has gone by the time the sandbox starts.
    for (flag, paths) in [
        ("--bind-try", &spec.read_write),
        ("--ro-bind-try", &spec.read_only),
    ] {
        for path in paths {
            add(&mut args, &[os(flag), path.as_os_str(), path.as_os_str()]);
        }
    }
    for link in &spec.linked {
        let flag = if link.writable {
            "--bind-try"
        } else {
            "--ro-bind-try"
        };
        add(
            &mut args,
            &[os(flag), link.target.as_os_str(), link.path.as_os_str()],
        );
    }
    for file in &spec.hidden_files {
        add(
            &mut args,
            &[os("--ro-bind"), os("/dev/null"), file.as_os_str()],
        );
    }
    add(
        &mut args,
        &[
            os("--ro-bind"),
            spec.run_dir.as_os_str(),
            os(SANDBOX_RUN_DIR),
        ],
    );
    for (name, value) in &spec.env {
        if SECURE_MODE_DROPS.contains(&name.as_str()) {
            add(&mut args, &[os("--setenv"), os(name), os(value)]);
        }
    }
    add(&mut args, &[os("--chdir"), spec.agent_dir.as_os_str()]);
    let run_dir = Path::new(SANDBOX_RUN_DIR);
    add(
        &mut args,
        &[os("--"), spec.app_binary.as_os_str(), os(AGENT_INIT)],
    );
    add(
        &mut args,
        &[
            run_dir.join(PROXY_SOCKET).as_os_str(),
            run_dir.join(MCP_SOCKET).as_os_str(),
            os("--"),
        ],
    );
    add(&mut args, &[spec.program.as_os_str()]);
    args.extend(spec.args.iter().map(OsString::from));
    args
}

fn add(args: &mut Vec<OsString>, items: &[&OsStr]) {
    args.extend(items.iter().map(|item| item.to_os_string()));
}

fn os(text: &str) -> &OsStr {
    OsStr::new(text)
}

/// `bwrap` with `bwrap_args`, found on the app's `PATH`, with only the spec's environment,
/// which bubblewrap passes on to `--agent-init` and the agent: kept out of the arguments, the
/// chat's token and provider keys stay out of `/proc/<pid>/cmdline`.
pub fn bwrap_command(spec: &SandboxSpec) -> CoreResult<Command> {
    let path = std::env::var_os("PATH");
    let bwrap = find_on_path("bwrap", path.as_deref())
        .ok_or_else(|| IpcError::new(ErrorCode::ToolMissing, NOT_INSTALLED))?;
    Ok(command_at(&bwrap, spec))
}

/// `bwrap_command` with the `bwrap` at `bwrap`.
fn command_at(bwrap: &Path, spec: &SandboxSpec) -> Command {
    let mut command = Command::new(bwrap);
    command
        .env_clear()
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .args(bwrap_args(spec));
    configure(&mut command);
    command
}

/// Whether bubblewrap, found on the app's `PATH`, can start a sandbox here.
pub async fn status() -> SandboxStatus {
    let path = std::env::var_os("PATH");
    status_at(path.as_deref()).await
}

/// `status` with the `PATH` given: `NotInstalled` without `bwrap` on it; `CannotStart` with the
/// first line of its stderr when spec §4.6's check fails, as it does where AppArmor restricts
/// user namespaces; else `Ready`.
pub(crate) async fn status_at(path_var: Option<&OsStr>) -> SandboxStatus {
    let Some(bwrap) = find_on_path("bwrap", path_var) else {
        return SandboxStatus::NotInstalled;
    };
    let check = ProcessSpec::new(bwrap, STATUS_ARGS, STATUS_TIMEOUT);
    let output = Output::Capture {
        stdout_limit: STATUS_OUTPUT_LIMIT,
        stderr_limit: STATUS_OUTPUT_LIMIT,
    };
    match process::run(check, output, CancellationToken::new()).await {
        Ok(output) if output.success() => SandboxStatus::Ready {
            kind: SandboxKind::Bubblewrap,
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
        Some(code) => format!("bwrap exited with code {code}"),
        None => "bwrap was stopped by a signal".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::agents::sandbox::spec::LinkedPath;

    const DATA: &str = "/home/u/.local/share/dev.skopos.SkoposIDE/agents";
    const PACKAGE: &str =
        "/home/u/.npm-global/lib/node_modules/@agentclientprotocol/claude-agent-acp";

    fn fixed_spec() -> SandboxSpec {
        let work = PathBuf::from(format!("{DATA}/work/claude"));
        let run = PathBuf::from(format!("{DATA}/run/0a1b2c3d"));
        SandboxSpec {
            agent_dir: work.clone(),
            run_dir: run.clone(),
            tmp_dir: run.join("tmp"),
            home: PathBuf::from("/home/u"),
            read_write: vec![work, PathBuf::from("/home/u/.claude"), run.join("tmp")],
            read_only: vec![
                PathBuf::from(PACKAGE),
                PathBuf::from("/usr"),
                PathBuf::from("/opt/SkoposIDE"),
            ],
            linked: Vec::new(),
            hidden_files: vec![PathBuf::from("/etc/skopos-test/config")],
            env: vec![
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), "/home/u".to_owned()),
                ("TERM".to_owned(), "dumb".to_owned()),
            ],
            app_binary: PathBuf::from("/opt/SkoposIDE/skopos-ide"),
            program: PathBuf::from(format!("{PACKAGE}/dist/index.js")),
            args: vec!["--verbose".to_owned()],
        }
    }

    #[test]
    fn the_bwrap_arguments_of_a_fixed_spec() {
        let args: Vec<String> = bwrap_args(&fixed_spec())
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        let work = format!("{DATA}/work/claude");
        let run = format!("{DATA}/run/0a1b2c3d");
        let tmp = format!("{run}/tmp");
        let program = format!("{PACKAGE}/dist/index.js");
        let expected: Vec<&str> = vec![
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--unshare-user",
            "--disable-userns",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/run",
            "--tmpfs",
            "/var/tmp",
            "--tmpfs",
            "/home/u",
            "--bind-try",
            work.as_str(),
            work.as_str(),
            "--bind-try",
            "/home/u/.claude",
            "/home/u/.claude",
            "--bind-try",
            tmp.as_str(),
            tmp.as_str(),
            "--ro-bind-try",
            PACKAGE,
            PACKAGE,
            "--ro-bind-try",
            "/usr",
            "/usr",
            "--ro-bind-try",
            "/opt/SkoposIDE",
            "/opt/SkoposIDE",
            "--ro-bind",
            "/dev/null",
            "/etc/skopos-test/config",
            "--ro-bind",
            run.as_str(),
            "/run/skopos",
            "--chdir",
            work.as_str(),
            "--",
            "/opt/SkoposIDE/skopos-ide",
            "--agent-init",
            "/run/skopos/proxy.sock",
            "/run/skopos/mcp.sock",
            "--",
            program.as_str(),
            "--verbose",
        ];
        assert_eq!(args, expected);
    }

    #[test]
    fn linked_paths_are_bound_from_their_real_paths_after_the_others() {
        let mut spec = fixed_spec();
        spec.linked = vec![
            LinkedPath {
                path: PathBuf::from("/home/u/.claude"),
                target: PathBuf::from("/home/u/dotfiles/claude"),
                writable: true,
            },
            LinkedPath {
                path: PathBuf::from("/home/u/shop"),
                target: PathBuf::from("/srv/shop"),
                writable: false,
            },
        ];
        let args: Vec<String> = bwrap_args(&spec)
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        let at = args
            .windows(3)
            .position(|window| window == ["--ro-bind-try", "/opt/SkoposIDE", "/opt/SkoposIDE"])
            .unwrap();
        assert_eq!(
            args[at + 3..at + 9],
            [
                "--bind-try",
                "/home/u/dotfiles/claude",
                "/home/u/.claude",
                "--ro-bind-try",
                "/srv/shop",
                "/home/u/shop",
            ]
        );
    }

    #[test]
    fn the_environment_is_given_to_bwrap_and_kept_out_of_its_arguments() {
        let mut spec = fixed_spec();
        let tmp = spec.tmp_dir.display().to_string();
        spec.env.extend([
            ("ANTHROPIC_API_KEY".to_owned(), "sk-ant-secret".to_owned()),
            ("TMPDIR".to_owned(), tmp.clone()),
        ]);
        let args: Vec<String> = bwrap_args(&spec)
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        for word in ["--clearenv", "ANTHROPIC_API_KEY", "TERM", "dumb"] {
            assert!(!args.iter().any(|arg| arg == word), "{word} is an argument");
        }
        // Only `TMPDIR`, which a setuid bubblewrap would drop, goes in as an argument too.
        let set: Vec<&[String]> = args
            .windows(3)
            .filter(|window| window[0] == "--setenv")
            .collect();
        assert_eq!(set, [["--setenv".to_owned(), "TMPDIR".to_owned(), tmp]]);
        assert!(!args.iter().any(|arg| arg.contains("sk-ant-secret")));
        let command = command_at(Path::new("/usr/bin/bwrap"), &spec);
        let envs: Vec<(String, String)> = command
            .as_std()
            .get_envs()
            .filter_map(|(name, value)| {
                Some((name.to_str()?.to_owned(), value?.to_str()?.to_owned()))
            })
            .collect();
        assert_eq!(envs.len(), spec.env.len());
        for pair in &spec.env {
            assert!(envs.contains(pair), "{pair:?} missing");
        }
    }

    /// A `bwrap` in `dir/bin` running `body`, and a `PATH` of that folder alone.
    fn fake_bwrap(dir: &Path, body: &str) -> OsString {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = bin.join("bwrap");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::join_paths([bin]).unwrap()
    }

    #[tokio::test]
    async fn without_bwrap_on_the_path_the_sandbox_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let path = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(
            status_at(Some(path.as_os_str())).await,
            SandboxStatus::NotInstalled
        );
        assert_eq!(status_at(None).await, SandboxStatus::NotInstalled);
    }

    #[tokio::test]
    async fn a_bwrap_that_cannot_start_a_sandbox_gives_its_first_line_of_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let path = fake_bwrap(
            dir.path(),
            "printf '\\n  bwrap: setting up uid map: Permission denied  \\nmore\\n' >&2; exit 1",
        );
        assert_eq!(
            status_at(Some(path.as_os_str())).await,
            SandboxStatus::CannotStart {
                error: "bwrap: setting up uid map: Permission denied".to_owned()
            }
        );
        let quiet = tempfile::tempdir().unwrap();
        let path = fake_bwrap(quiet.path(), "exit 3");
        assert_eq!(
            status_at(Some(path.as_os_str())).await,
            SandboxStatus::CannotStart {
                error: "bwrap exited with code 3".to_owned()
            }
        );
    }

    #[tokio::test]
    async fn a_bwrap_that_runs_the_probe_makes_the_sandbox_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = fake_bwrap(
            dir.path(),
            "[ \"$*\" = '--ro-bind / / --unshare-all --unshare-user --disable-userns true' ] || exit 9",
        );
        assert_eq!(
            status_at(Some(path.as_os_str())).await,
            SandboxStatus::Ready {
                kind: SandboxKind::Bubblewrap
            }
        );
    }
}
