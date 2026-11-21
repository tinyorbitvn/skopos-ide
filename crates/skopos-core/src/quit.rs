//! The app's quit, step by step (P34). Each step is logged with the time since the quit
//! began, and a watch thread ends the process if it is still running a while later, so a
//! quit that stalls cannot leave a process behind with no window. The thread is not part
//! of the async runtime and does not need the main thread, either of which a stalled quit
//! may be stuck in.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// How long a quit may take before the watch ends the process: well past the windows'
/// save before quitting and the core's shutdown, each of which has its own limit.
pub const QUIT_LIMIT: Duration = Duration::from_secs(20);
/// How long the watch waits after its log line, so the log writer can save it.
const LOG_DRAIN: Duration = Duration::from_millis(200);

#[derive(Default)]
struct Steps {
    began: Option<Instant>,
    watched: bool,
    done: Vec<(Duration, String)>,
}

impl Steps {
    fn elapsed(&mut self) -> Duration {
        self.began.get_or_insert_with(Instant::now).elapsed()
    }

    /// The steps so far with their times since the quit began, oldest first.
    fn report(&self) -> String {
        let mut report = String::new();
        for (at, step) in &self.done {
            let _ = write!(report, "\n  +{:.2}s {step}", at.as_secs_f64());
        }
        report
    }
}

/// The steps of the quit so far, and its watch.
#[derive(Clone, Default)]
pub struct QuitWatch {
    steps: Arc<Mutex<Steps>>,
}

impl QuitWatch {
    fn steps(&self) -> MutexGuard<'_, Steps> {
        self.steps.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The quit reached `step`. The first step starts its clock.
    pub fn step(&self, step: &str) {
        let mut steps = self.steps();
        let at = steps.elapsed();
        steps.done.push((at, step.to_owned()));
        drop(steps);
        tracing::info!("quit +{:.2}s: {step}", at.as_secs_f64());
    }

    /// The quit has begun with `step`. The first call starts the watch: if the process is
    /// still running `limit` later, the steps so far are logged and `stalled` runs, which
    /// ends the process. Later calls only add their step.
    pub fn begin(&self, step: &str, limit: Duration, stalled: impl FnOnce() + Send + 'static) {
        self.step(step);
        if std::mem::replace(&mut self.steps().watched, true) {
            return;
        }
        let watch = self.clone();
        let spawned = thread::Builder::new()
            .name("quit-watch".to_owned())
            .spawn(move || {
                thread::sleep(limit);
                let report = watch.steps().report();
                tracing::error!(
                    "the app is still running {limit:?} after it began to quit, so it ends now; \
                     the quit got this far:{report}"
                );
                thread::sleep(LOG_DRAIN);
                stalled();
            });
        if let Err(e) = spawned {
            tracing::warn!("cannot watch the quit: {e}");
        }
    }
}

/// Ends the process at once. Unlike `std::process::exit` it runs no exit handlers, which
/// a stalled quit may be the one stuck in.
pub fn exit_now(code: i32) -> ! {
    #[cfg(unix)]
    {
        // SAFETY: `_exit` takes no pointers and ends the process; nothing runs after it.
        unsafe { libc::_exit(code) }
    }
    #[cfg(not(unix))]
    {
        std::process::exit(code)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn a_quit_still_running_after_its_limit_is_ended_once() {
        let watch = QuitWatch::default();
        let (ended, end) = mpsc::channel();
        let again = ended.clone();

        watch.begin(
            "main asked to close",
            Duration::from_millis(50),
            move || {
                ended.send(()).unwrap();
            },
        );
        watch.begin("exit requested", Duration::from_millis(50), move || {
            again.send(()).unwrap();
        });

        assert!(end.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(end.recv_timeout(Duration::from_millis(500)).is_err());
    }

    #[test]
    fn the_report_lists_every_step_in_order_from_the_first() {
        let watch = QuitWatch::default();
        watch.step("main window destroyed");
        thread::sleep(Duration::from_millis(20));
        watch.step("core shut down");

        let steps = watch.steps();
        let report = steps.report();

        assert!(
            report.starts_with("\n  +0.00s main window destroyed"),
            "{report}"
        );
        let (at, last) = steps.done.last().unwrap();
        assert_eq!(last, "core shut down");
        assert!(*at >= Duration::from_millis(20));
        assert!(report.ends_with(&format!("+{:.2}s core shut down", at.as_secs_f64())));
    }

    #[test]
    fn steps_alone_start_no_watch() {
        let watch = QuitWatch::default();
        watch.step("core shut down");
        assert!(!watch.steps().watched);
    }
}
