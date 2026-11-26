//! Named tunnels (tunnels spec): how a cluster's API server is reached through a proxy, and the
//! local gateway every consumer goes through.

pub mod model;
pub mod secrets;
pub mod store;

pub use model::{TunnelInput, TunnelKind};
pub use store::TunnelView;

// Used by the consumers of the next tasks.
#[allow(dead_code)]
pub(crate) mod http;
#[allow(dead_code)]
pub(crate) mod upstream;
