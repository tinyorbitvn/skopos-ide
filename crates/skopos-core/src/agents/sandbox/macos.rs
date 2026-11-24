//! Seatbelt (spec §4.6, macOS): the profile that builds a chat's sandbox, the command that starts
//! the agent under `sandbox-exec`, and whether Seatbelt can start a sandbox here. Written from
//! `sandbox-exec(1)` and the profile language as Apple's own profiles use it: `(deny default)`
//! first, then rules, a later rule winning over an earlier one it overlaps. Seatbelt matches
//! resolved paths, so every path goes in by its real path.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::paths::{links_on_the_way, real_path};
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
/// The person's keychains under the home folder, which the agent may read but not change. The
/// Security framework reads a keychain's file in the agent's own process, and an agent's sign-in
/// may live there: Claude Code keeps its own in the login keychain. An item's secret still comes
/// only through `securityd` and the item's access list, which asks the person before an item
/// another app made is opened.
const KEYCHAINS: &str = "Library/Keychains";
/// Spec §4.6's check that Seatbelt can start a sandbox here.
const STATUS_PROFILE: &str = "(version 1)(allow default)";
const STATUS_PROGRAM: &str = "/usr/bin/true";
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const STATUS_OUTPUT_LIMIT: usize = 16 * 1024;
/// Shared folders of other programs' files and sockets, which the Linux sandbox covers with
/// tmpfs; with the person's own temporary and cache folders, the agent may not read them.
const SYSTEM_TEMP_FOLDERS: [&str; 3] = ["/private/tmp", "/private/var/tmp", "/private/var/run"];
/// The `confstr(3)` names of the person's own folders under `/var/folders`, from Apple's
/// `<unistd.h>`: the per-user folder, the temporary folder and the cache folder.
const CS_DARWIN_USER_DIR: c_int = 65536;
const CS_DARWIN_USER_TEMP_DIR: c_int = 65537;
const CS_DARWIN_USER_CACHE_DIR: c_int = 65538;
/// The person's terminals, which the agent may read and write as their owner: a read takes
/// what they type, such as a password. `/dev/tty`, the agent's own terminal if any, stays open.
const OTHER_TERMINALS: [&str; 2] = [r"^/dev/ttys[0-9]+$", r"^/dev/(pty|tty)[p-w][0-9a-f]$"];

extern "C" {
    fn confstr(name: c_int, buf: *mut c_char, len: usize) -> usize;
}
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

/// Spec §4.6's profile for `spec`, with `temp_folders`.
pub fn profile(spec: &SandboxSpec, ports: ChatPorts) -> String {
    profile_with(spec, ports, &temp_folders())
}

/// `SYSTEM_TEMP_FOLDERS` and the person's own folder, temporary folder and cache folder, by
/// their real paths.
pub fn temp_folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = SYSTEM_TEMP_FOLDERS.iter().map(PathBuf::from).collect();
    for name in [
        CS_DARWIN_USER_DIR,
        CS_DARWIN_USER_TEMP_DIR,
        CS_DARWIN_USER_CACHE_DIR,
    ] {
        if let Some(folder) = configured_folder(name) {
            let real = real_path(&folder);
            if !folders.contains(&real) {
                folders.push(real);
            }
        }
    }
    folders
}

/// The folder `confstr(3)` gives for `name`, if any.
fn configured_folder(name: c_int) -> Option<PathBuf> {
    // SAFETY: with no buffer, `confstr` only gives the size the value needs.
    let size = unsafe { confstr(name, std::ptr::null_mut(), 0) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0 as c_char; size];
    // SAFETY: `buffer` holds `size` bytes, room for the value and its closing nul.
    let written = unsafe { confstr(name, buffer.as_mut_ptr(), size) };
    if written == 0 || written > size {
        return None;
    }
    // SAFETY: `confstr` wrote a nul-terminated string into `buffer`.
    let text = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    let folder = PathBuf::from(text.to_str().ok()?);
    folder.is_absolute().then_some(folder)
}

/// The profile, one rule a line, in this order: the opening rules; no reading under the home
/// folder or `temp_folders`, except the folders above an allowed path or a link the agent
/// passes, which it may `stat` on its way down; reading again each `read_write` and
/// `read_only` path, then the person's `KEYCHAINS`, and each link in a covered folder on the way
/// to a `linked` path, which a lookup through it reads; writing each
/// `read_write` path, `/dev/null` and its controlling terminal; no reading or writing the
/// hidden kubeconfig files and the person's other terminals, last among the file rules so that
/// no allowed folder opens them again; connecting to `localhost:<proxy>` and `localhost:<mcp>`
/// only; looking up `MACH_SERVICES` only.
fn profile_with(spec: &SandboxSpec, ports: ChatPorts, temp_folders: &[PathBuf]) -> String {
    let home = real_path(&spec.home);
    let read_write: Vec<PathBuf> = spec.read_write.iter().map(|path| real_path(path)).collect();
    let mut read_only: Vec<PathBuf> = spec.read_only.iter().map(|path| real_path(path)).collect();
    read_only.push(home.join(KEYCHAINS));
    let allowed: Vec<&PathBuf> = read_write.iter().chain(&read_only).collect();
    let mut rules: Vec<String> = OPENING.iter().map(|rule| rule.to_string()).collect();
    let covered: Vec<&PathBuf> = std::iter::once(&home).chain(temp_folders).collect();
    let mut links: Vec<PathBuf> = Vec::new();
    for linked in &spec.linked {
        for link in links_on_the_way(&linked.path) {
            let hidden = covered.iter().any(|folder| link.starts_with(folder));
            if hidden && !links.contains(&link) {
                links.push(link);
            }
        }
    }
    for folder in &covered {
        rules.push(format!("(deny file-read* (subpath {}))", quoted(folder)));
    }
    let passed: Vec<&PathBuf> = allowed.iter().copied().chain(&links).collect();
    let mut above: Vec<PathBuf> = Vec::new();
    for folder in &covered {
        for path in folders_above(folder, &passed) {
            if !above.contains(&path) {
                above.push(path);
            }
        }
    }
    for folder in &above {
        rules.push(format!(
            "(allow file-read-metadata (literal {}))",
            quoted(folder)
        ));
    }
    for path in &allowed {
        rules.push(format!("(allow file-read* (subpath {}))", quoted(path)));
    }
    for link in &links {
        rules.push(format!("(allow file-read* (literal {}))", quoted(link)));
    }
    for path in &read_write {
        rules.push(format!("(allow file-write* (subpath {}))", quoted(path)));
    }
    rules.push(r#"(allow file-write* (literal "/dev/null"))"#.to_owned());
    rules.push(r#"(allow file-write* (literal "/dev/tty"))"#.to_owned());
    let mut hidden: Vec<PathBuf> = Vec::new();
    for file in &spec.hidden_files {
        let real = real_path(file);
        if !hidden.contains(&real) {
            hidden.push(real);
        }
    }
    for file in &hidden {
        rules.push(format!(
            "(deny file-read* file-write* (literal {}))",
            quoted(file)
        ));
    }
    for terminals in OTHER_TERMINALS {
        rules.push(format!(
            r##"(deny file-read* file-write* (regex #"{terminals}"))"##
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
    use crate::agents::sandbox::spec::LinkedPath;

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
            linked: Vec::new(),
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
            r#"(deny file-read* (subpath "/private/tmp"))"#.to_owned(),
            r#"(deny file-read* (subpath "/private/var/folders/xy/T"))"#.to_owned(),
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
            format!(r#"(allow file-read* (subpath "{HOME}/Library/Keychains"))"#),
            format!(r#"(allow file-write* (subpath "{work}"))"#),
            format!(r#"(allow file-write* (subpath "{HOME}/.claude"))"#),
            format!(r#"(allow file-write* (subpath "{tmp}"))"#),
            r#"(allow file-write* (literal "/dev/null"))"#.to_owned(),
            r#"(allow file-write* (literal "/dev/tty"))"#.to_owned(),
            r#"(deny file-read* file-write* (literal "/etc/skopos-test/config"))"#.to_owned(),
            r##"(deny file-read* file-write* (regex #"^/dev/ttys[0-9]+$"))"##.to_owned(),
            r##"(deny file-read* file-write* (regex #"^/dev/(pty|tty)[p-w][0-9a-f]$"))"##
                .to_owned(),
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
        let text = profile_with(&fixed_spec(), PORTS, &fixed_temp_folders());
        assert_eq!(text.lines().collect::<Vec<_>>(), expected);
        assert!(text.ends_with(")\n"));
    }

    #[test]
    fn the_keychains_may_be_read_but_not_written() {
        let mut spec = fixed_spec();
        spec.read_write = Vec::new();
        spec.read_only = Vec::new();
        let text = profile_with(&spec, PORTS, &fixed_temp_folders());
        let lines: Vec<&str> = text.lines().collect();
        let keychains = format!("{HOME}/Library/Keychains");
        let wanted = [
            format!(r#"(deny file-read* (subpath "{HOME}"))"#),
            format!(r#"(allow file-read-metadata (literal "{HOME}"))"#),
            format!(r#"(allow file-read-metadata (literal "{HOME}/Library"))"#),
            format!(r#"(allow file-read* (subpath "{keychains}"))"#),
        ];
        let at: Vec<usize> = wanted
            .iter()
            .map(|rule| lines.iter().position(|line| line == rule).expect(rule))
            .collect();
        assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
        assert!(
            !lines
                .iter()
                .any(|line| line.contains("file-write") && line.contains(&keychains)),
            "{text}"
        );
    }

    fn fixed_temp_folders() -> Vec<PathBuf> {
        vec![
            PathBuf::from("/private/tmp"),
            PathBuf::from("/private/var/folders/xy/T"),
        ]
    }

    #[test]
    fn a_path_in_a_temporary_folder_is_read_again_with_the_folders_above_it_and_hidden_once() {
        let mut spec = fixed_spec();
        let tmp = PathBuf::from("/private/var/folders/xy/T/skopos-run/tmp");
        spec.read_write = vec![tmp.clone()];
        spec.read_only = Vec::new();
        spec.hidden_files = vec![
            PathBuf::from("/etc/skopos-test/config"),
            PathBuf::from("/etc/skopos-test/config"),
        ];
        let text = profile_with(&spec, PORTS, &fixed_temp_folders());
        let lines: Vec<&str> = text.lines().collect();
        let wanted = [
            r#"(deny file-read* (subpath "/private/var/folders/xy/T"))"#,
            r#"(allow file-read-metadata (literal "/private/var/folders/xy/T"))"#,
            r#"(allow file-read-metadata (literal "/private/var/folders/xy/T/skopos-run"))"#,
            r#"(allow file-read* (subpath "/private/var/folders/xy/T/skopos-run/tmp"))"#,
            r#"(allow file-write* (subpath "/private/var/folders/xy/T/skopos-run/tmp"))"#,
        ];
        let at: Vec<usize> = wanted
            .iter()
            .map(|rule| lines.iter().position(|line| line == rule).expect(rule))
            .collect();
        assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "{lines:?}");
        let hidden = r#"(deny file-read* file-write* (literal "/etc/skopos-test/config"))"#;
        assert_eq!(lines.iter().filter(|line| **line == hidden).count(), 1);
    }

    #[test]
    fn a_link_in_the_home_folder_on_the_way_to_a_linked_folder_may_be_read_and_nothing_past_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = real_path(dir.path());
        let home = root.join("home");
        let kube = root.join("outside/kube");
        std::fs::create_dir_all(home.join("dots")).unwrap();
        std::fs::create_dir_all(&kube).unwrap();
        // home/kube-link → dots/kube → outside/kube: both links sit in the hidden home.
        std::os::unix::fs::symlink("dots/kube", home.join("kube-link")).unwrap();
        std::os::unix::fs::symlink(&kube, home.join("dots/kube")).unwrap();
        let mut spec = fixed_spec();
        spec.home = home.clone();
        spec.read_write = Vec::new();
        spec.read_only = vec![kube.clone()];
        spec.linked = vec![LinkedPath {
            path: home.join("kube-link"),
            target: kube.clone(),
            writable: false,
        }];
        spec.hidden_files = vec![kube.join("config"), home.join("kube-link/config")];
        let text = profile_with(&spec, PORTS, &[]);
        let lines: Vec<&str> = text.lines().collect();
        let wanted = [
            format!("(deny file-read* (subpath {}))", quoted(&home)),
            format!("(allow file-read-metadata (literal {}))", quoted(&home)),
            format!(
                "(allow file-read-metadata (literal {}))",
                quoted(&home.join("dots"))
            ),
            format!("(allow file-read* (subpath {}))", quoted(&kube)),
            format!(
                "(allow file-read* (literal {}))",
                quoted(&home.join("kube-link"))
            ),
            format!(
                "(allow file-read* (literal {}))",
                quoted(&home.join("dots/kube"))
            ),
            format!(
                "(deny file-read* file-write* (literal {}))",
                quoted(&kube.join("config"))
            ),
        ];
        let at: Vec<usize> = wanted
            .iter()
            .map(|rule| lines.iter().position(|line| line == rule).expect(rule))
            .collect();
        assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "{lines:?}");
        let keychains = format!(
            "(allow file-read* (subpath {}))",
            quoted(&home.join(KEYCHAINS))
        );
        let opened: Vec<&&str> = lines
            .iter()
            .filter(|line| {
                line.starts_with("(allow file-read* ")
                    && line.contains(&*home.to_string_lossy())
                    && **line != keychains
            })
            .collect();
        assert_eq!(opened.len(), 2, "only the two links: {opened:?}");
    }

    #[test]
    fn the_temporary_folders_are_the_shared_ones_and_the_persons_own() {
        let folders = temp_folders();
        assert_eq!(folders[..3], SYSTEM_TEMP_FOLDERS.map(PathBuf::from));
        // The person's temporary folder is where `std::env::temp_dir` points on a Mac.
        assert!(folders.len() >= 4, "{folders:?}");
        assert!(
            folders[3].starts_with("/private/var/folders"),
            "{folders:?}"
        );
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
