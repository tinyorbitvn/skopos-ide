//! A refused cluster-wide `helm list`, remembered for a minute (perf spec §2a). The memo
//! is pure: callers pass the clock, so tests need no sleeping.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::error::IpcError;
use crate::kubeconfig::ClusterId;

/// How long a refused cluster-wide list is believed.
pub(crate) const REFUSAL_TTL: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Entry {
    /// The connection that was refused. A reconnect has another epoch.
    epoch: u64,
    at: Instant,
    error: IpcError,
}

/// Which clusters refused `helm list --all-namespaces`, and the error they gave.
#[derive(Debug, Default)]
pub(crate) struct RefusalMemo {
    entries: HashMap<ClusterId, Entry>,
}

impl RefusalMemo {
    /// The refusal still in force for this connection at `now`. An entry of another
    /// connection, or one that has expired, is dropped.
    pub(crate) fn recall(&mut self, id: &ClusterId, epoch: u64, now: Instant) -> Option<IpcError> {
        let live = self.entries.get(id).is_some_and(|entry| {
            entry.epoch == epoch && now.saturating_duration_since(entry.at) < REFUSAL_TTL
        });
        if live {
            return self.entries.get(id).map(|entry| entry.error.clone());
        }
        self.entries.remove(id);
        None
    }

    pub(crate) fn remember(&mut self, id: ClusterId, epoch: u64, now: Instant, error: IpcError) {
        self.entries.insert(
            id,
            Entry {
                epoch,
                at: now,
                error,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::error::{ErrorCode, IpcError};

    fn refusal() -> IpcError {
        IpcError::new(ErrorCode::Forbidden, "secrets is forbidden")
    }

    #[test]
    fn a_cluster_with_nothing_remembered_recalls_nothing() {
        let mut memo = RefusalMemo::default();
        assert_eq!(memo.recall(&"c1".to_owned(), 1, Instant::now()), None);
    }

    #[test]
    fn a_refusal_is_recalled_with_its_error_until_it_expires() {
        let mut memo = RefusalMemo::default();
        let start = Instant::now();
        memo.remember("c1".to_owned(), 7, start, refusal());
        let just_before = start + REFUSAL_TTL - Duration::from_millis(1);
        assert_eq!(memo.recall(&"c1".to_owned(), 7, start), Some(refusal()));
        assert_eq!(
            memo.recall(&"c1".to_owned(), 7, just_before),
            Some(refusal())
        );
        assert_eq!(memo.recall(&"c1".to_owned(), 7, start + REFUSAL_TTL), None);
    }

    #[test]
    fn an_expired_refusal_stays_forgotten() {
        let mut memo = RefusalMemo::default();
        let start = Instant::now();
        memo.remember("c1".to_owned(), 7, start, refusal());
        let later = start + REFUSAL_TTL + Duration::from_secs(1);
        assert_eq!(memo.recall(&"c1".to_owned(), 7, later), None);
        // Even a clock that reads earlier again does not bring it back.
        assert_eq!(memo.recall(&"c1".to_owned(), 7, start), None);
    }

    #[test]
    fn a_reconnect_resets_the_memo() {
        let mut memo = RefusalMemo::default();
        let start = Instant::now();
        memo.remember("c1".to_owned(), 7, start, refusal());
        assert_eq!(memo.recall(&"c1".to_owned(), 8, start), None);
        assert_eq!(memo.recall(&"c1".to_owned(), 7, start), None);
    }

    #[test]
    fn each_cluster_has_its_own_refusal() {
        let mut memo = RefusalMemo::default();
        let start = Instant::now();
        memo.remember("c1".to_owned(), 7, start, refusal());
        assert_eq!(memo.recall(&"c2".to_owned(), 7, start), None);
        assert_eq!(memo.recall(&"c1".to_owned(), 7, start), Some(refusal()));
    }

    #[test]
    fn a_new_refusal_replaces_the_old_one() {
        let mut memo = RefusalMemo::default();
        let start = Instant::now();
        memo.remember("c1".to_owned(), 7, start, refusal());
        let again = start + Duration::from_secs(50);
        memo.remember("c1".to_owned(), 7, again, refusal());
        let after_first_expiry = start + Duration::from_secs(70);
        assert_eq!(
            memo.recall(&"c1".to_owned(), 7, after_first_expiry),
            Some(refusal())
        );
    }
}
