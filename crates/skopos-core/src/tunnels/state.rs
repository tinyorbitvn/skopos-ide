//! A tunnel's state (tunnels spec §5.9).

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "status")]
#[ts(export)]
pub enum TunnelState {
    /// Unused for the idle time, stopped, or not used yet this run.
    Idle,
    /// The first dial (proxy) or the first `ssh` run (SSH) since it was idle or failed.
    Starting,
    /// `since` is when it came up, in milliseconds since the epoch.
    Up {
        #[ts(type = "number")]
        since: i64,
    },
    /// An SSH tunnel whose `ssh` dropped while in use (spec §6.4); `attempt` counts the tries
    /// since it was last up.
    #[serde(rename_all = "camelCase")]
    Reconnecting { attempt: u32, last_error: String },
    /// A prompt during a reconnect waits for the person (spec §6.4).
    #[serde(rename_all = "camelCase")]
    NeedsInput { prompt_id: String },
    /// The last start or dial failed; for SSH, only a person's action starts it again.
    Failed { message: String },
}

impl TunnelState {
    pub(crate) fn up_now() -> TunnelState {
        TunnelState::Up { since: now_ms() }
    }

    pub fn is_up(&self) -> bool {
        matches!(self, TunnelState::Up { .. })
    }
}

/// Milliseconds since the epoch; 0 if the clock is before it.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn states_serialize_with_camel_case_fields() {
        let json_of = |state: TunnelState| serde_json::to_value(state).unwrap();
        assert_eq!(
            json_of(TunnelState::Up { since: 5 }),
            json!({ "status": "up", "since": 5 })
        );
        assert_eq!(
            json_of(TunnelState::Reconnecting {
                attempt: 2,
                last_error: "gone".into()
            }),
            json!({ "status": "reconnecting", "attempt": 2, "lastError": "gone" })
        );
        assert_eq!(
            json_of(TunnelState::NeedsInput {
                prompt_id: "p1".into()
            }),
            json!({ "status": "needsInput", "promptId": "p1" })
        );
        assert!(TunnelState::up_now().is_up());
        assert!(!TunnelState::Starting.is_up());
    }
}
