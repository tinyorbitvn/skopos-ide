//! Named tunnels (tunnels spec): how a cluster's API server is reached through a proxy, and the
//! local gateway every consumer goes through.

pub(crate) mod gateway;
#[cfg(test)]
mod gateway_tests;
pub(crate) mod http;
pub(crate) mod migrate;
pub mod model;
pub(crate) mod no_proxy;
pub(crate) mod route;
pub(crate) mod runtime;
pub mod secrets;
pub mod state;
pub mod store;
pub(crate) mod upstream;

pub use model::{TunnelInput, TunnelKind};
pub use state::TunnelState;
pub use store::TunnelView;
