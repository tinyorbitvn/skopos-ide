//! How long SSH tunnels wait (tunnels spec §6.2, §6.4). Tests shorten them.

use std::time::Duration;

use super::runtime::IDLE_AFTER;
use crate::app_core::AppCore;

/// `Default` is the spec's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelTimings {
    /// How long `ssh` may take to come up, not counting prompts that wait for the person.
    pub start: Duration,
    /// How long a prompt waits for the person.
    pub prompt: Duration,
    /// How long an SSH tunnel nothing uses stays up.
    pub idle: Duration,
    /// The delays before reconnect attempts; the last one repeats.
    pub backoff: Vec<Duration>,
    /// How long a gateway connection waits for a reconnecting tunnel before `503`.
    pub reconnect_wait: Duration,
}

impl Default for TunnelTimings {
    fn default() -> Self {
        Self {
            start: Duration::from_secs(30),
            prompt: Duration::from_secs(120),
            idle: IDLE_AFTER,
            backoff: [1, 2, 4, 8, 16, 30].map(Duration::from_secs).to_vec(),
            reconnect_wait: Duration::from_secs(10),
        }
    }
}

impl TunnelTimings {
    /// The delay before reconnect attempt `attempt`, counted from 1.
    #[allow(dead_code)] // Used by tunnels::ssh from Task 5.
    pub(crate) fn backoff_for(&self, attempt: u32) -> Duration {
        let at = usize::try_from(attempt.saturating_sub(1)).unwrap_or(usize::MAX);
        self.backoff
            .get(at)
            .or(self.backoff.last())
            .copied()
            .unwrap_or(Duration::from_secs(30))
    }
}

impl AppCore {
    pub fn set_tunnel_timings_for_test(&self, timings: TunnelTimings) {
        *self
            .tunnel_runtime()
            .timings
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = timings;
    }

    pub(crate) fn tunnel_timings(&self) -> TunnelTimings {
        self.tunnel_runtime()
            .timings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backoff_climbs_then_stays_at_30_s() {
        let timings = TunnelTimings::default();
        let delays: Vec<u64> = (1..=8).map(|n| timings.backoff_for(n).as_secs()).collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 30, 30, 30]);
    }
}
