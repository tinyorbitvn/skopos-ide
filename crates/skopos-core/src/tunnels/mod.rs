//! Named tunnels (tunnels spec): how a cluster's API server is reached through a proxy, and the
//! local gateway every consumer goes through.

pub(crate) mod askpass;
pub mod askpass_mode;
#[cfg(test)]
mod askpass_tests;
pub(crate) mod gateway;
#[cfg(test)]
mod gateway_tests;
pub(crate) mod http;
pub(crate) mod migrate;
pub mod model;
pub(crate) mod no_proxy;
pub(crate) mod port_owner;
pub mod prompts;
pub(crate) mod route;
pub(crate) mod runtime;
pub mod secrets;
pub(crate) mod ssh;
pub(crate) mod ssh_cmd;
pub mod state;
pub mod store;
pub mod timings;
pub(crate) mod upstream;

pub use model::{TunnelInput, TunnelKind};
pub use prompts::{PromptKind, TunnelPrompt};
pub use runtime::TunnelHold;
pub use ssh::{SshTestHooks, WINDOWS_ASKPASS};
pub use state::TunnelState;
pub use store::TunnelView;
pub use timings::TunnelTimings;
