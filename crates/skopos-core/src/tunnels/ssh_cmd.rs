//! What the SSH supervisor needs that runs no process (tunnels spec §6.2, §6.4, §6.5): the
//! argument array, the `ssh -V` check, how an exit reads, and the stderr ring.

#![allow(dead_code)] // Used by tunnels::ssh from Task 5.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::Path;

use super::model::SshFields;

/// How many stderr lines a tunnel keeps for its `Log` (spec §6.1).
pub(crate) const LOG_LINES: usize = 50;
/// The longest stderr line kept, in characters.
pub(crate) const LOG_LINE_MAX: usize = 500;
/// What a batch-mode `ssh` that would have had to ask shows (spec §6.5).
pub(crate) const CANNOT_ASK: &str = "This ssh cannot ask for input; load the key into ssh-agent";

/// Retrying cannot help after these (spec §6.4).
const FATAL: [&str; 4] = [
    "Permission denied",
    "Too many authentication failures",
    "Host key verification failed",
    HOST_KEY_CHANGED,
];
const HOST_KEY_CHANGED: &str = "REMOTE HOST IDENTIFICATION HAS CHANGED";
const PORT_TAKEN: &str = "Address already in use";

/// What the supervisor adds to the tunnel's own fields.
pub(crate) struct ArgOptions<'a> {
    /// The `-D` port on `127.0.0.1`.
    pub(crate) local_port: u16,
    /// `-o BatchMode=yes`: no prompts at all (Windows without askpass, spec §6.5).
    pub(crate) batch: bool,
    /// `-F <file>`, for tests, so they never read `~/.ssh/config`.
    pub(crate) config_file: Option<&'a Path>,
}

fn push_pair(args: &mut Vec<OsString>, flag: &str, value: impl Into<OsString>) {
    args.push(flag.into());
    args.push(value.into());
}

/// `[-F file] -N -D 127.0.0.1:<p> -o … [-l user] [-p port] [-J jump] [-i identity] -- host`
/// (spec §6.2). `--` keeps the host from ever reading as an option (T5).
pub(crate) fn ssh_args(fields: &SshFields<'_>, options: &ArgOptions<'_>) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    if let Some(file) = options.config_file {
        push_pair(&mut args, "-F", file.as_os_str());
    }
    args.push("-N".into());
    push_pair(&mut args, "-D", format!("127.0.0.1:{}", options.local_port));
    for option in [
        "ExitOnForwardFailure=yes",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
    ] {
        push_pair(&mut args, "-o", option);
    }
    if options.batch {
        push_pair(&mut args, "-o", "BatchMode=yes");
    }
    if let Some(user) = fields.user {
        push_pair(&mut args, "-l", user);
    }
    if let Some(port) = fields.port {
        push_pair(&mut args, "-p", port.to_string());
    }
    if let Some(jump) = fields.jump {
        push_pair(&mut args, "-J", jump);
    }
    if let Some(identity) = fields.identity_file {
        push_pair(&mut args, "-i", identity);
    }
    push_pair(&mut args, "--", fields.host);
    args
}

/// Reads `ssh -V` (OpenSSH writes it to stderr): OpenSSH 8.4 or later is needed for
/// `SSH_ASKPASS_REQUIRE` (spec §6.5). `Err` is what the tunnel shows.
pub(crate) fn check_version(output: &str) -> Result<(), String> {
    let word = output
        .split_whitespace()
        .next()
        .unwrap_or("unknown")
        .trim_end_matches(',');
    let new_enough = word
        .strip_prefix("OpenSSH_for_Windows_")
        .or_else(|| word.strip_prefix("OpenSSH_"))
        .and_then(major_minor)
        .is_some_and(|version| version >= (8, 4));
    if new_enough {
        Ok(())
    } else {
        Err(format!(
            "This ssh is {word}; SSH tunnels need OpenSSH 8.4 or later"
        ))
    }
}

/// `(9, 6)` from `9.6p1`, `(10, 0)` from `10p1`.
fn major_minor(text: &str) -> Option<(u32, u32)> {
    let digits: String = text
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = digits.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts
        .next()
        .filter(|p| !p.is_empty())
        .unwrap_or("0")
        .parse()
        .ok()?;
    Some((major, minor))
}

/// How an `ssh` run that ended reads (spec §6.2, §6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitKind {
    /// Authentication or the host key failed.
    Fatal,
    /// The `-D` port was taken: start again at once on another.
    PortTaken,
    /// Anything else, such as the network dropping.
    Dropped,
}

/// `lines` are the stderr lines of that run.
pub(crate) fn classify_exit(lines: &[String]) -> ExitKind {
    if lines
        .iter()
        .any(|line| FATAL.iter().any(|fatal| line.contains(fatal)))
    {
        return ExitKind::Fatal;
    }
    if lines.iter().any(|line| line.contains(PORT_TAKEN)) {
        return ExitKind::PortTaken;
    }
    ExitKind::Dropped
}

/// What a tunnel shows for a run that ended: its last stderr line, or how `ssh` exited. In
/// batch mode an authentication failure means `ssh` could not ask (spec §6.5).
pub(crate) fn exit_message(lines: &[String], code: Option<i32>, batch: bool) -> String {
    let changed_key = lines.iter().any(|line| line.contains(HOST_KEY_CHANGED));
    if batch && !changed_key && classify_exit(lines) == ExitKind::Fatal {
        return CANNOT_ASK.to_owned();
    }
    if let Some(last) = lines.iter().rev().find(|line| !line.trim().is_empty()) {
        return last.clone();
    }
    match code {
        Some(code) => format!("ssh exited with code {code}"),
        None => "ssh was stopped by a signal".to_owned(),
    }
}

/// The far side's reason in the `channel N: open failed: <reason>` line `ssh` writes when a
/// forward is refused.
pub(crate) fn open_failure(line: &str) -> Option<&str> {
    line.split_once("open failed: ")
        .map(|(_, reason)| reason.trim())
        .filter(|reason| !reason.is_empty())
}

/// The last `LOG_LINES` stderr lines of a tunnel's `ssh`, without control characters and cut
/// to `LOG_LINE_MAX` characters. `ssh` never prints an answer, and the askpass bridge writes
/// none here (T1).
#[derive(Debug, Default)]
pub(crate) struct LogRing {
    lines: VecDeque<String>,
    pushed: u64,
}

impl LogRing {
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        let clean: String = String::from_utf8_lossy(bytes)
            .chars()
            .map(|c| if c == '\t' { ' ' } else { c })
            .filter(|c| !c.is_control())
            .take(LOG_LINE_MAX)
            .collect();
        if self.lines.len() == LOG_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(clean);
        self.pushed += 1;
    }

    pub(crate) fn lines(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }

    /// How many lines were ever pushed: a mark for `since`.
    pub(crate) fn pushed(&self) -> u64 {
        self.pushed
    }

    /// The lines pushed after `mark` that the ring still holds.
    pub(crate) fn since(&self, mark: u64) -> Vec<String> {
        let new = usize::try_from(self.pushed.saturating_sub(mark))
            .unwrap_or(usize::MAX)
            .min(self.lines.len());
        self.lines
            .iter()
            .skip(self.lines.len() - new)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    fn lines(text: &[&str]) -> Vec<String> {
        text.iter().map(|line| (*line).to_owned()).collect()
    }

    #[test]
    fn the_args_carry_every_field_and_the_fixed_options() {
        let fields = SshFields {
            host: "bastion",
            user: Some("me"),
            port: Some(2222),
            jump: Some("jump.corp"),
            identity_file: Some("/keys/id"),
        };
        let options = ArgOptions {
            local_port: 5000,
            batch: false,
            config_file: None,
        };
        assert_eq!(
            words(&ssh_args(&fields, &options)),
            [
                "-N",
                "-D",
                "127.0.0.1:5000",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-l",
                "me",
                "-p",
                "2222",
                "-J",
                "jump.corp",
                "-i",
                "/keys/id",
                "--",
                "bastion",
            ]
        );
    }

    #[test]
    fn the_args_end_with_the_host_after_a_double_dash() {
        let fields = SshFields {
            host: "coder.ws",
            user: None,
            port: None,
            jump: None,
            identity_file: None,
        };
        let options = ArgOptions {
            local_port: 1,
            batch: true,
            config_file: Some(Path::new("cfg")),
        };
        let args = words(&ssh_args(&fields, &options));
        assert_eq!(&args[..2], ["-F", "cfg"]);
        assert!(args.windows(2).any(|pair| pair == ["-o", "BatchMode=yes"]));
        assert_eq!(&args[args.len() - 2..], ["--", "coder.ws"]);
        for absent in ["-l", "-p", "-J", "-i"] {
            assert!(!args.iter().any(|arg| arg == absent), "{absent}");
        }
    }

    #[test]
    fn openssh_8_4_and_later_pass_the_version_check() {
        for output in [
            "OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13 30 Jan 2024",
            "OpenSSH_8.4p1, LibreSSL 2.8.3",
            "OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2",
            "OpenSSH_10.0p2, OpenSSL 3.5.0 8 Apr 2025",
        ] {
            assert_eq!(check_version(output), Ok(()), "{output}");
        }
    }

    #[test]
    fn an_older_or_other_ssh_is_named() {
        let too_old = |word: &str| -> Result<(), String> {
            Err(format!(
                "This ssh is {word}; SSH tunnels need OpenSSH 8.4 or later"
            ))
        };
        assert_eq!(
            check_version("OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f"),
            too_old("OpenSSH_8.2p1")
        );
        assert_eq!(
            check_version("OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2"),
            too_old("OpenSSH_for_Windows_8.1p1")
        );
        assert_eq!(check_version("dropbear v2022.83"), too_old("dropbear"));
        assert_eq!(check_version(""), too_old("unknown"));
    }

    #[test]
    fn authentication_and_host_key_failures_are_fatal() {
        for line in [
            "me@bastion: Permission denied (publickey,password).",
            "Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures",
            "Host key verification failed.",
            "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
        ] {
            assert_eq!(classify_exit(&lines(&[line])), ExitKind::Fatal, "{line}");
        }
    }

    #[test]
    fn a_taken_port_and_a_drop_read_as_such() {
        assert_eq!(
            classify_exit(&lines(&[
                "bind [127.0.0.1]:5000: Address already in use",
                "Could not request local forwarding.",
            ])),
            ExitKind::PortTaken
        );
        assert_eq!(
            classify_exit(&lines(&["Connection to bastion closed by remote host."])),
            ExitKind::Dropped
        );
        assert_eq!(classify_exit(&[]), ExitKind::Dropped);
        assert_eq!(
            classify_exit(&lines(&[
                "Address already in use",
                "Permission denied (publickey)."
            ])),
            ExitKind::Fatal
        );
    }

    #[test]
    fn the_exit_message_is_the_last_line_or_how_ssh_exited() {
        assert_eq!(
            exit_message(&lines(&["first", "last", " "]), Some(255), false),
            "last"
        );
        assert_eq!(
            exit_message(&[], Some(255), false),
            "ssh exited with code 255"
        );
        assert_eq!(
            exit_message(&[], None, false),
            "ssh was stopped by a signal"
        );
        assert_eq!(
            exit_message(
                &lines(&["me@b: Permission denied (publickey)."]),
                Some(255),
                true
            ),
            CANNOT_ASK
        );
        assert_eq!(
            exit_message(
                &lines(&[
                    "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @",
                    "Host key verification failed.",
                ]),
                Some(255),
                true
            ),
            "Host key verification failed."
        );
    }

    #[test]
    fn an_open_failed_line_gives_the_far_sides_reason() {
        assert_eq!(
            open_failure("channel 2: open failed: connect failed: Connection refused"),
            Some("connect failed: Connection refused")
        );
        assert_eq!(open_failure("channel 2: open failed: "), None);
        assert_eq!(
            open_failure("Warning: Permanently added 'b' to the list"),
            None
        );
    }

    #[test]
    fn the_ring_keeps_50_clean_lines_and_knows_what_is_new() {
        let mut ring = LogRing::default();
        for n in 1..=60 {
            ring.push(format!("line {n}").as_bytes());
        }
        assert_eq!(ring.lines().len(), LOG_LINES);
        assert_eq!(ring.lines()[0], "line 11");
        assert_eq!(ring.pushed(), 60);
        let mark = ring.pushed();
        assert!(ring.since(mark).is_empty());
        ring.push(b"bell\x07 and\ttab\r");
        ring.push("x".repeat(600).as_bytes());
        assert_eq!(
            ring.since(mark),
            vec!["bell and tab".to_owned(), "x".repeat(LOG_LINE_MAX)]
        );
        assert_eq!(ring.since(0).len(), LOG_LINES);
    }
}
