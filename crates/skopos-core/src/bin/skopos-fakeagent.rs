//! `skopos-fakeagent`: a scripted ACP agent for the core's tests (R1). It speaks ACP v1 as an
//! agent on stdio and plays the script that `--script <file>` or `SKOPOS_FAKEAGENT_SCRIPT`
//! names; `--log <file>` or `SKOPOS_FAKEAGENT_LOG` collects every request it gets, and
//! `--env-file <file>` or `SKOPOS_FAKEAGENT_ENV_FILE` gets its process id and environment at
//! start. It never ships: the app bundles only `skopos-app`'s binary.

use std::ffi::OsString;
use std::sync::Arc;

#[path = "fakeagent/agent.rs"]
mod agent;
#[path = "fakeagent/mcp_client.rs"]
mod mcp_client;
#[path = "fakeagent/script.rs"]
mod script;

#[tokio::main]
async fn main() {
    let options = match script::Options::from_args(std::env::args().skip(1), env_var) {
        Ok(options) => options,
        Err(error) => fail(2, &error),
    };
    if let Some(path) = &options.env_file {
        if let Err(error) = agent::write_env_file(path) {
            fail(2, &error);
        }
    }
    let script = match options.load_script() {
        Ok(script) => script,
        Err(error) => fail(2, &error),
    };
    let fake = match agent::Fake::new(script, options.log.as_deref()) {
        Ok(fake) => fake,
        Err(error) => fail(2, &error),
    };
    if let Err(error) = agent::run(Arc::new(fake)).await {
        fail(1, &error.message);
    }
}

fn env_var(name: &str) -> Option<OsString> {
    std::env::var_os(name)
}

fn fail(code: i32, message: &str) -> ! {
    eprintln!("skopos-fakeagent: {message}");
    std::process::exit(code)
}
