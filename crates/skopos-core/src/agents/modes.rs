//! The app binary's hidden modes (spec §4.1), parsed before anything else starts: `--agent-mcp
//! <host:port>`, and the askpass mode of a tunnel's `ssh` (tunnels spec §6.3). They start no
//! tokio runtime: they run on plain threads with `std::net`.

use std::ffi::OsString;

use crate::agents::bridge::run_agent_mcp;
use crate::tunnels::askpass_mode::{askpass_requested, run_askpass};

/// The mode that bridges an agent's `skopos` MCP server to its chat.
pub const AGENT_MCP: &str = "--agent-mcp";
/// Where `--agent-mcp` finds the chat's token.
pub const TOKEN_VAR: &str = "SKOPOS_AGENT_TOKEN";
/// The exit code of a mode called the wrong way.
pub const USAGE: i32 = 2;

/// Runs the hidden mode the arguments or the environment name and gives its exit code; `None`
/// when they name none, and the app starts as usual.
pub fn run(args: impl Iterator<Item = OsString>) -> Option<i32> {
    let args: Vec<OsString> = args.skip(1).collect();
    // A tunnel's `ssh` runs the binary with the prompt as its only argument: only the
    // environment tells the askpass mode apart.
    if askpass_requested() {
        return Some(run_askpass(&args));
    }
    let (mode, rest) = args.split_first()?;
    match mode.to_str() {
        Some(AGENT_MCP) => Some(agent_mcp(rest)),
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
        ] {
            assert_eq!(run(args(words)), Some(USAGE), "{words:?}");
        }
    }
}
