//! Named tunnels (tunnels spec): how a cluster's API server is reached through a proxy, and the
//! local gateway every consumer goes through.

pub mod model;
pub mod store;

pub use model::{TunnelInput, TunnelKind};
pub use store::TunnelView;
