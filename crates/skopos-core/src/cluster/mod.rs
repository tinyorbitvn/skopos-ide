//! Cluster connections.

mod connect;
mod control_plane;
mod distribution;
mod exec_command;
mod manager;
mod raw;
mod state;

pub use connect::ConnectTimeouts;
pub(crate) use connect::{with_proxy_url, write_proxy_url, ProxyOrigin};
pub use control_plane::{
    ApiServer, ControlPlane, ControlPlaneComponent, HealthCheck, HealthState, Leader, PodCounts,
};
pub use distribution::detect_distribution;
pub(crate) use exec_command::{exec_command, ExecConsent};
pub use exec_command::{ExecCommandKind, ExecEnvVar, ExecRequest, ExecRequestDetails};
pub(crate) use manager::{ClusterManager, HeldExec};
pub use manager::{ConnectionLogEntry, LogLevel};
pub(crate) use raw::get_raw;
pub use state::{ClusterInfo, ConnectionState, FailureKind};
