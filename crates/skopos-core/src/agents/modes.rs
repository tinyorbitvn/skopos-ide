//! The app binary's hidden modes (spec §4.1), parsed before anything else starts: `--agent-mcp
//! <host:port>` and, on Linux, `--agent-init <proxy socket> <mcp socket> -- <command>`. Neither
//! starts a tokio runtime: they run on plain threads with `std::net`.

use std::ffi::OsString;

use crate::agents::bridge::run_agent_mcp;
use crate::agents::sandbox::{AGENT_INIT, AGENT_MCP};

/// Where `--agent-mcp` finds the chat's token.
pub const TOKEN_VAR: &str = "SKOPOS_AGENT_TOKEN";
/// The exit code of a mode called the wrong way.
pub const USAGE: i32 = 2;

/// Runs the hidden mode the second argument names and gives its exit code; `None` when it names
/// none, and the app starts as usual.
pub fn run(args: impl Iterator<Item = OsString>) -> Option<i32> {
    let mut args = args.skip(1);
    let mode = args.next()?;
    let rest: Vec<OsString> = args.collect();
    match mode.to_str() {
        Some(AGENT_MCP) => Some(agent_mcp(&rest)),
        Some(AGENT_INIT) => Some(agent_init(&rest)),
        _ => None,
    }
}

fn usage(message: &str) -> i32 {
    eprintln!("skopos: {message}");
    USAGE
}

fn agent_mcp(rest: &[OsString]) -> i32 {
    let [target] = rest else {
        return usage("--agent-mcp takes one address, as 127.0.0.1:<port>");
    };
    let Some(target) = target.to_str() else {
        return usage("--agent-mcp takes one address, as 127.0.0.1:<port>");
    };
    let token = std::env::var(TOKEN_VAR).unwrap_or_default();
    if token.is_empty() {
        return usage("SKOPOS_AGENT_TOKEN is not set");
    }
    run_agent_mcp(target, &token)
}

#[cfg(target_os = "linux")]
fn agent_init(rest: &[OsString]) -> i32 {
    match init_parts(rest) {
        Some((proxy, mcp, command)) => crate::agents::sandbox::init::run_agent_init(
            std::path::Path::new(proxy),
            std::path::Path::new(mcp),
            command,
        ),
        None => usage("--agent-init takes <proxy socket> <mcp socket> -- <command>"),
    }
}

#[cfg(not(target_os = "linux"))]
fn agent_init(_rest: &[OsString]) -> i32 {
    usage("--agent-init runs only on Linux")
}

/// `<proxy socket> <mcp socket> -- <command>`, the command not empty.
#[cfg(target_os = "linux")]
fn init_parts(rest: &[OsString]) -> Option<(&std::ffi::OsStr, &std::ffi::OsStr, &[OsString])> {
    match rest {
        [proxy, mcp, separator, command @ ..] if separator == "--" && !command.is_empty() => {
            Some((proxy.as_os_str(), mcp.as_os_str(), command))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> std::vec::IntoIter<OsString> {
        words
            .iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn other_arguments_start_the_app() {
        assert!(run(args(&[])).is_none());
        assert!(run(args(&["skopos-ide"])).is_none());
        assert!(run(args(&["skopos-ide", "--verbose"])).is_none());
        assert!(run(args(&["skopos-ide", "--agent-mcpx", "127.0.0.1:1"])).is_none());
    }

    #[test]
    fn a_mode_called_the_wrong_way_exits_2() {
        for words in [
            &["skopos-ide", "--agent-mcp"][..],
            &["skopos-ide", "--agent-mcp", "127.0.0.1:1", "extra"],
            &["skopos-ide", "--agent-init"],
            &[
                "skopos-ide",
                "--agent-init",
                "/run/skopos/proxy.sock",
                "/run/skopos/mcp.sock",
                "--",
            ],
            &[
                "skopos-ide",
                "--agent-init",
                "/run/skopos/proxy.sock",
                "/run/skopos/mcp.sock",
                "/bin/sh",
            ],
        ] {
            assert_eq!(run(args(words)), Some(USAGE), "{words:?}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_init_arguments_are_split_at_the_separator() {
        let words: Vec<OsString> = [
            "/run/skopos/proxy.sock",
            "/run/skopos/mcp.sock",
            "--",
            "/opt/agent/bin/agent",
            "--",
            "-x",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        let (proxy, mcp, command) = init_parts(&words).unwrap();
        assert_eq!(proxy, "/run/skopos/proxy.sock");
        assert_eq!(mcp, "/run/skopos/mcp.sock");
        assert_eq!(command, &words[3..]);
        assert!(init_parts(&words[..3]).is_none());
    }
}
