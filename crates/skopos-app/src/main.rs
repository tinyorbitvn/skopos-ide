#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // An agent runs this binary as its MCP bridge (`--agent-mcp`). That mode starts no runtime
    // and no window.
    if let Some(code) = skopos_core::agents::modes::run(std::env::args_os()) {
        std::process::exit(code);
    }
    // Still before the Tokio runtime starts; `run` logs the outcome once logging is up.
    let shell_env_warning = skopos_core::shell_env::apply_login_shell_env();
    skopos_app_lib::run(shell_env_warning)
}
