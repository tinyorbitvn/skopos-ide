//! What stops each running subscription, and the window that asked for it. A page that
//! loads again, or a window that closes, takes its subscription ids with it, and a Tauri
//! channel can still be written after a reload. So nothing else would end what that page
//! subscribed to: its watches would go on, and their events would be sent to no one.

use dashmap::DashMap;
use tokio_util::sync::CancellationToken;

use crate::app_core::AppCore;

/// The running subscriptions of one kind, by id.
#[derive(Default)]
pub(crate) struct Subscriptions {
    running: DashMap<String, Running>,
}

struct Running {
    stop: CancellationToken,
    /// The label of the window that subscribed. `None` for a reader inside the core.
    owner: Option<String>,
}

impl Subscriptions {
    /// Makes `stop` what ends the subscription `id`, which `owner` asked for.
    pub(crate) fn insert(&self, id: String, stop: CancellationToken, owner: Option<&str>) {
        let owner = owner.map(str::to_owned);
        self.running.insert(id, Running { stop, owner });
    }

    /// Forgets a subscription that has ended by itself.
    pub(crate) fn forget(&self, id: &str) {
        self.running.remove(id);
    }

    /// Ends one subscription. An id that is unknown or already ended is ignored.
    pub(crate) fn stop(&self, id: &str) {
        if let Some((_, running)) = self.running.remove(id) {
            running.stop.cancel();
        }
    }

    /// Ends every subscription the window `owner` asked for, and none of another window's
    /// or of the core's own.
    pub(crate) fn stop_owned(&self, owner: &str) {
        // Listed first, so that no entry is held while its task is woken.
        let owned: Vec<String> = self
            .running
            .iter()
            .filter(|running| running.owner.as_deref() == Some(owner))
            .map(|running| running.key().clone())
            .collect();
        for id in owned {
            self.stop(&id);
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.running.len()
    }
}

impl AppCore {
    /// Ends the list, object, map, node topology, reachability and Helm subscriptions the
    /// window `owner` started, on every cluster, for when its page loads again or it closes. A
    /// watch that no other window reads stops as it does after an unsubscribe.
    pub fn subscriptions_stop_owned(&self, owner: &str) {
        self.watches().stop_owned(owner);
        self.graphs().stop_owned(owner);
        self.topologies().stop_owned(owner);
        self.reachabilities().stop_owned(owner);
        self.helm_releases_stop_owned(owner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_one_cancels_and_forgets_it() {
        let subscriptions = Subscriptions::default();
        let (first, second) = (CancellationToken::new(), CancellationToken::new());
        subscriptions.insert("watch-1".to_owned(), first.clone(), Some("main"));
        subscriptions.insert("watch-2".to_owned(), second.clone(), Some("main"));

        subscriptions.stop("watch-1");
        // Unknown, and ended already.
        subscriptions.stop("watch-9");
        subscriptions.stop("watch-1");

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert_eq!(subscriptions.len(), 1);
    }

    #[test]
    fn forgetting_one_leaves_its_token_alone() {
        let subscriptions = Subscriptions::default();
        let stop = CancellationToken::new();
        subscriptions.insert("watch-1".to_owned(), stop.clone(), Some("main"));

        subscriptions.forget("watch-1");

        assert!(!stop.is_cancelled());
        assert_eq!(subscriptions.len(), 0);
    }

    #[test]
    fn a_window_stops_its_own_and_no_other() {
        let subscriptions = Subscriptions::default();
        let tokens: Vec<CancellationToken> = (0..4).map(|_| CancellationToken::new()).collect();
        subscriptions.insert("watch-1".to_owned(), tokens[0].clone(), Some("main"));
        subscriptions.insert("watch-2".to_owned(), tokens[1].clone(), Some("window-2"));
        subscriptions.insert("watch-3".to_owned(), tokens[2].clone(), Some("window-2"));
        // A reader inside the core belongs to no window, whatever a window is called.
        subscriptions.insert("watch-4".to_owned(), tokens[3].clone(), None);

        subscriptions.stop_owned("window-2");

        let cancelled: Vec<bool> = tokens.iter().map(CancellationToken::is_cancelled).collect();
        assert_eq!(cancelled, [false, true, true, false]);
        assert_eq!(subscriptions.len(), 2);

        // A window with none is ignored.
        subscriptions.stop_owned("window-3");
        assert_eq!(subscriptions.len(), 2);
    }
}
