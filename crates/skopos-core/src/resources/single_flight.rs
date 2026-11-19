//! One run at a time per key, shared by the callers that wait for it (perf spec §5).

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::watch;

use crate::error::{CoreResult, ErrorCode, IpcError};

/// A run that has not started yet, and where its answer goes.
struct Pending<T> {
    work: BoxFuture<'static, CoreResult<T>>,
    done: watch::Sender<Option<CoreResult<T>>>,
}

struct State<T> {
    /// The next run. Callers that arrive before the driver takes it join it.
    pending: Option<Pending<T>>,
    /// Whether a driver task is alive. It is cleared in the same critical section in
    /// which the driver finds nothing pending, so no run is left without a driver.
    driving: bool,
}

/// Runs one piece of work at a time. A caller waits for a run that starts after it
/// arrived: callers that arrive together share one run, and one that arrives while a run
/// is going queues exactly one more, which the callers after it share. The answer, error
/// included, goes to every caller of the run. The work runs on its own task, so a caller
/// that drops its future leaves the run and the others alone.
pub(crate) struct SingleFlight<T> {
    state: Mutex<State<T>>,
}

impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State {
                pending: None,
                driving: false,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `work` is used only when this call creates the next run; a call that joins a run
    /// pending already drops its own `work` unpolled.
    pub(crate) async fn run(
        self: &Arc<Self>,
        work: BoxFuture<'static, CoreResult<T>>,
    ) -> CoreResult<T> {
        let mut answer = {
            let mut state = self.lock();
            if let Some(pending) = &state.pending {
                pending.done.subscribe()
            } else {
                let (done, answer) = watch::channel(None);
                state.pending = Some(Pending { work, done });
                if !state.driving {
                    state.driving = true;
                    tokio::spawn(Arc::clone(self).drive());
                }
                answer
            }
        };
        let waited = answer.wait_for(Option::is_some).await;
        let result = match waited {
            Ok(guard) => guard.clone(),
            Err(_) => None,
        };
        result.unwrap_or_else(|| {
            Err(IpcError::new(
                ErrorCode::Internal,
                "the run stopped before it answered",
            ))
        })
    }

    /// Takes the pending run, runs it, answers its callers, and again until none is pending.
    async fn drive(self: Arc<Self>) {
        loop {
            let pending = {
                let mut state = self.lock();
                match state.pending.take() {
                    Some(pending) => pending,
                    None => {
                        state.driving = false;
                        return;
                    }
                }
            };
            let Pending { work, done } = pending;
            let answer = AssertUnwindSafe(work)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(IpcError::new(
                        ErrorCode::Internal,
                        "the run stopped unexpectedly",
                    ))
                });
            done.send_replace(Some(answer));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use futures::future::BoxFuture;
    use tokio::sync::Notify;

    use super::*;
    use crate::error::{CoreResult, ErrorCode, IpcError};

    /// A run that counts itself: its answer is its number, 1 for the first run.
    /// With a gate it waits for `notify_one` before it answers.
    fn counted(
        runs: &Arc<AtomicUsize>,
        gate: Option<&Arc<Notify>>,
    ) -> BoxFuture<'static, CoreResult<usize>> {
        let runs = Arc::clone(runs);
        let gate = gate.map(Arc::clone);
        Box::pin(async move {
            let number = runs.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(gate) = gate {
                gate.notified().await;
            }
            Ok(number)
        })
    }

    fn explode() -> usize {
        panic!("boom")
    }

    async fn until(mut done: impl FnMut() -> bool) {
        for _ in 0..1000 {
            if done() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("the condition never held");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn calls_that_arrive_before_a_run_starts_share_it() {
        let flight = Arc::new(SingleFlight::new());
        let runs = Arc::new(AtomicUsize::new(0));

        let (a, b, c) = tokio::join!(
            flight.run(counted(&runs, None)),
            flight.run(counted(&runs, None)),
            flight.run(counted(&runs, None)),
        );

        assert_eq!((a.unwrap(), b.unwrap(), c.unwrap()), (1, 1, 1));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_call_during_a_run_queues_exactly_one_more_run() {
        let flight = Arc::new(SingleFlight::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());

        let first = tokio::spawn({
            let (flight, work) = (Arc::clone(&flight), counted(&runs, Some(&gate)));
            async move { flight.run(work).await }
        });
        until(|| runs.load(Ordering::SeqCst) == 1).await;

        // Both arrive while the first run is going, so neither may take its answer.
        let second = tokio::spawn({
            let (flight, work) = (Arc::clone(&flight), counted(&runs, None));
            async move { flight.run(work).await }
        });
        let third = tokio::spawn({
            let (flight, work) = (Arc::clone(&flight), counted(&runs, None));
            async move { flight.run(work).await }
        });
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            runs.load(Ordering::SeqCst),
            1,
            "the queued run waits its turn"
        );

        gate.notify_one();
        assert_eq!(first.await.unwrap().unwrap(), 1);
        assert_eq!(second.await.unwrap().unwrap(), 2);
        assert_eq!(third.await.unwrap().unwrap(), 2);
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_error_reaches_every_waiter() {
        let flight: Arc<SingleFlight<usize>> = Arc::new(SingleFlight::new());
        let failing = || -> BoxFuture<'static, CoreResult<usize>> {
            Box::pin(async { Err(IpcError::new(ErrorCode::Unreachable, "no route")) })
        };

        let (a, b) = tokio::join!(flight.run(failing()), flight.run(failing()));

        for result in [a, b] {
            let error = result.unwrap_err();
            assert_eq!(error.code, ErrorCode::Unreachable);
            assert_eq!(error.message, "no route");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_caller_that_gives_up_does_not_cancel_the_run() {
        let flight = Arc::new(SingleFlight::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let quitter = tokio::spawn({
            let (flight, work) = (Arc::clone(&flight), counted(&runs, Some(&gate)));
            async move { flight.run(work).await }
        });
        let stayer = tokio::spawn({
            let (flight, work) = (Arc::clone(&flight), counted(&runs, Some(&gate)));
            async move { flight.run(work).await }
        });
        until(|| runs.load(Ordering::SeqCst) == 1).await;

        quitter.abort();
        gate.notify_one();

        assert_eq!(stayer.await.unwrap().unwrap(), 1);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_run_that_panics_fails_its_callers_and_the_next_call_runs() {
        let flight: Arc<SingleFlight<usize>> = Arc::new(SingleFlight::new());
        let panicking: BoxFuture<'static, CoreResult<usize>> = Box::pin(async {
            let number = explode();
            Ok(number)
        });

        let error = flight.run(panicking).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);

        let runs = Arc::new(AtomicUsize::new(0));
        assert_eq!(flight.run(counted(&runs, None)).await.unwrap(), 1);
    }
}
