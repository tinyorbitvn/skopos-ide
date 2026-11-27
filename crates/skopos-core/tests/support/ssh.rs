//! The system's OpenSSH client for the SSH tunnel tests (tunnels spec §6.6). `ssh` reads only
//! the test's own config (`-F`), never `~/.ssh/config` or `/etc/ssh/ssh_config`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use skopos_core::app_core::AppCore;
use skopos_core::tunnels::{SshTestHooks, TunnelTimings, WINDOWS_ASKPASS};

/// The askpass the tests hand `ssh`: `skopos-agent-host` runs the app's askpass mode (Task 3).
pub const ASKPASS: &str = env!("CARGO_BIN_EXE_skopos-agent-host");

/// `major.minor` of `OpenSSH_9.6p1` or `OpenSSH_for_Windows_8.1p1`.
fn version_of(text: &str) -> Option<(u32, u32)> {
    let word = text.split_whitespace().next()?;
    let number = word
        .strip_prefix("OpenSSH_for_Windows_")
        .or_else(|| word.strip_prefix("OpenSSH_"))?;
    let (major, rest) = number.split_once('.')?;
    let minor: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// The system's OpenSSH client. `None`, with a note, for a Windows `ssh.exe` that runs in
/// batch mode (spec §6.5): these tests need prompts.
pub fn system_ssh() -> Option<PathBuf> {
    let mut found = None;
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let inbox = PathBuf::from(root)
            .join("System32")
            .join("OpenSSH")
            .join("ssh.exe");
        if inbox.is_file() {
            found = Some(inbox);
        }
    }
    if found.is_none() {
        let name = if cfg!(windows) { "ssh.exe" } else { "ssh" };
        found = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .find(|candidate| candidate.is_file())
        });
    }
    let ssh = found.expect("these tests need the system's OpenSSH client");
    if cfg!(windows) {
        let output = std::process::Command::new(&ssh).arg("-V").output().unwrap();
        let text = String::from_utf8_lossy(&output.stderr).into_owned();
        if !WINDOWS_ASKPASS || version_of(&text).is_none_or(|v| v < (8, 5)) {
            eprintln!("not run: {} ({text}) runs in batch mode", ssh.display());
            return None;
        }
    }
    Some(ssh)
}

fn config_path(path: &Path) -> String {
    format!("\"{}\"", path.display().to_string().replace('\\', "/"))
}

/// Writes `ssh_config`, an empty global `known_hosts` and a `known_hosts` holding `known` into
/// `dir`. Returns the config's path, then the `known_hosts` path.
pub fn write_ssh_config(dir: &Path, known: &str) -> (PathBuf, PathBuf) {
    let known_hosts = dir.join("known_hosts");
    let global = dir.join("global_known_hosts");
    std::fs::write(&global, "").unwrap();
    std::fs::write(&known_hosts, known).unwrap();
    let config = dir.join("ssh_config");
    std::fs::write(
        &config,
        format!(
            "Host *\n  UserKnownHostsFile {}\n  GlobalKnownHostsFile {}\n  HashKnownHosts no\n  \
             IdentityAgent none\n  PubkeyAuthentication no\n  IdentitiesOnly yes\n  \
             PreferredAuthentications keyboard-interactive,password\n  \
             StrictHostKeyChecking ask\n  UpdateHostKeys no\n  ConnectTimeout 5\n  \
             NumberOfPasswordPrompts 2\n",
            config_path(&known_hosts),
            config_path(&global)
        ),
    )
    .unwrap();
    (config, known_hosts)
}

/// Points `core` at the system `ssh` with the test's config and askpass, and short timings.
pub fn use_system_ssh(core: &AppCore, ssh: &Path, config: PathBuf) {
    core.set_ssh_test_hooks(SshTestHooks {
        askpass: Some(ASKPASS.into()),
        config_file: Some(config),
        env: Vec::new(),
    });
    core.set_tunnel_timings_for_test(TunnelTimings {
        start: Duration::from_secs(20),
        prompt: Duration::from_secs(20),
        idle: Duration::from_secs(120),
        backoff: vec![Duration::from_millis(300)],
        reconnect_wait: Duration::from_millis(500),
    });
    let mut prefs = core.prefs_get();
    prefs.ssh_path = Some(ssh.to_string_lossy().into_owned());
    core.prefs_set(prefs).unwrap();
}
