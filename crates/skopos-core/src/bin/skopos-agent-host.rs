//! Stands in for the app binary in the agent tests: it runs the hidden `--agent-mcp` mode. The app
//! bundles only `skopos-app`'s binary, so this one never ships.

fn main() {
    std::process::exit(skopos_core::agents::modes::run(std::env::args_os()).unwrap_or(2))
}
