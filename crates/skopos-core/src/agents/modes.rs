//! The app binary's hidden mode (spec §4.1), parsed before anything else starts: `--agent-mcp
//! <host:port>`. It starts no tokio runtime: it runs on plain threads with `std::net`.

use std::ffi::OsString;

use crate::agents::bridge::run_agent_mcp;

/// The mode that bridges an agent's `skopos` MCP server to its chat.
pub const AGENT_MCP: &str = "--agent-mcp";
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
