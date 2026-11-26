//! A tunnel's state (tunnels spec §5.9). Phase 2 adds `Reconnecting` and `NeedsInput`.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "status")]
#[ts(export)]
pub enum TunnelState {
    /// Unused for `IDLE_AFTER`, stopped, or not used yet this run.
    Idle,
    /// The first dial since it was idle or failed is on its way.
    Starting,
    Up,
    /// The last dial failed; the next use tries again.
    Failed {
        message: String,
    },
}
