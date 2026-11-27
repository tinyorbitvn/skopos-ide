//! Stands in for the app binary in the agent and tunnel tests: it runs the hidden modes
//! (`--agent-mcp`, and the askpass mode of a tunnel's `ssh`). The app bundles only `skopos-app`'s
//! binary, so this one never ships.

fn main() {
    std::process::exit(skopos_core::agents::modes::run(std::env::args_os()).unwrap_or(2))
}
