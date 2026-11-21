//! The `Updates` service: one scheduler for the process, the state every window shows, and
//! the rules of in-app update spec §5.1.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{broadcast, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{Progress, UpdateMemory, UpdatePhase, UpdateSource, UpdateState};
use crate::app_core::CoreEvent;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::prefs::Prefs;
use crate::store::JsonStore;
use crate::tools::download::ProgressGate;

/// The first automatic check waits for the app to settle (spec D2).
const FIRST_CHECK: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Like tool downloads: at most one progress change per 200 ms.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

struct Started {
    source: Arc<dyn UpdateSource>,
    /// The window that shows a toast: the one used last.
    toast_window: Box<dyn Fn() -> String + Send + Sync>,
}

struct Inner {
    memory: JsonStore<UpdateMemory>,
    events: broadcast::Sender<CoreEvent>,
    current: String,
    phase: Mutex<UpdatePhase>,
    started: OnceLock<Started>,
    /// The running download's token, while one runs.
    download: Mutex<Option<CancellationToken>>,
    /// When the last check of this run ended, successful or not, for the scheduler.
    last_check: Mutex<Option<Instant>>,
    stop: CancellationToken,
}

/// The update service. Clones share everything.
#[derive(Clone)]
pub struct Updates {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

fn busy(phase: &UpdatePhase) -> bool {
    matches!(
        phase,
        UpdatePhase::Downloading { .. } | UpdatePhase::Installing { .. }
    )
}

impl Updates {
    pub fn new(
        memory: JsonStore<UpdateMemory>,
        events: broadcast::Sender<CoreEvent>,
        current: impl Into<String>,
    ) -> Updates {
        Updates {
            inner: Arc::new(Inner {
                memory,
                events,
                current: current.into(),
                phase: Mutex::new(UpdatePhase::Idle),
                started: OnceLock::new(),
                download: Mutex::new(None),
                last_check: Mutex::new(None),
                stop: CancellationToken::new(),
            }),
        }
    }

    /// Takes the source and, when `automatic`, starts the scheduler: a check 10 s from now,
    /// then every 6 hours, while `update_check` is on. Call it inside the Tokio runtime. A
    /// second call does nothing.
    pub fn start(
        &self,
        source: Arc<dyn UpdateSource>,
        automatic: bool,
        prefs: watch::Receiver<Prefs>,
        toast_window: impl Fn() -> String + Send + Sync + 'static,
    ) {
        let started = Started {
            source,
            toast_window: Box::new(toast_window),
        };
        if self.inner.started.set(started).is_err() {
            return;
        }
        // The blocker and the installer are known now.
        self.publish(None);
        if automatic {
            tokio::spawn(schedule(self.clone(), prefs));
        }
    }

    /// Stops the scheduler.
    pub fn stop(&self) {
        self.inner.stop.cancel();
    }

    pub fn state(&self) -> UpdateState {
        self.snapshot(None)
    }

    fn snapshot(&self, toast_window: Option<String>) -> UpdateState {
        let memory = self.inner.memory.get();
        let source = self.inner.started.get().map(|started| &started.source);
        UpdateState {
            phase: lock(&self.inner.phase).clone(),
            current: self.inner.current.clone(),
            blocker: source.and_then(|s| s.blocker()),
            installer: source.and_then(|s| s.installer()),
            skipped: memory.skipped_version,
            last_checked_at: memory.last_checked_at,
            toast_window,
        }
    }

    fn publish(&self, toast_window: Option<String>) {
        let state = self.snapshot(toast_window);
        let _ = self.inner.events.send(CoreEvent::UpdateState { state });
    }

    fn set_phase(&self, phase: UpdatePhase) {
        *lock(&self.inner.phase) = phase;
        self.publish(None);
    }

    fn source(&self) -> CoreResult<Arc<dyn UpdateSource>> {
        self.inner
            .started
            .get()
            .map(|started| started.source.clone())
            .ok_or_else(|| IpcError::new(ErrorCode::Internal, "updates have not started"))
    }

    pub(crate) fn last_check(&self) -> Option<Instant> {
        *lock(&self.inner.last_check)
    }

    /// Records a finished check; only a successful one is saved as "last checked" (R5).
    fn checked(&self, succeeded: bool) {
        *lock(&self.inner.last_check) = Some(Instant::now());
        if succeeded {
            if let Err(e) = self
                .inner
                .memory
                .update(|m| m.last_checked_at = Some(unix_now()))
            {
                tracing::warn!("cannot save when updates were last checked: {e}");
            }
        }
    }

    /// Sets a check's result, unless an install started meanwhile.
    fn apply_check(&self, next: UpdatePhase) -> bool {
        let mut phase = lock(&self.inner.phase);
        if busy(&phase) {
            return false;
        }
        *phase = next;
        true
    }

    /// Sets an automatic check's result. It leaves a running manual check alone, which shows
    /// its own result, and keeps a failed install's release, the Try Again target, unless the
    /// check found a release to offer instead.
    fn apply_automatic(&self, next: UpdatePhase) -> bool {
        let mut phase = lock(&self.inner.phase);
        let keep = match &*phase {
            UpdatePhase::Checking => true,
            UpdatePhase::Failed {
                release: Some(_), ..
            } => !matches!(next, UpdatePhase::Available { .. }),
            current => busy(current),
        };
        if keep {
            return false;
        }
        *phase = next;
        true
    }

    /// A check the user asked for: the dialog shows Checking, then the result or why it
    /// failed. A skipped version is still shown. Does nothing while an update installs.
    pub async fn check_now(&self) -> UpdateState {
        let Ok(source) = self.source() else {
            return self.state();
        };
        let started = {
            let mut phase = lock(&self.inner.phase);
            let free = !busy(&phase);
            if free {
                *phase = UpdatePhase::Checking;
            }
            free
        };
        if !started {
            return self.state();
        }
        self.publish(None);
        let result = source.check().await;
        self.checked(result.is_ok());
        let next = match result {
            Ok(Some(release)) => UpdatePhase::Available { release },
            Ok(None) => UpdatePhase::UpToDate,
            Err(e) => UpdatePhase::Failed {
                message: e.message,
                release: None,
            },
        };
        if self.apply_check(next) {
            self.publish(None);
        }
        self.state()
    }

    /// A scheduled check runs unseen. A failure is logged and the state stays as it was, so a
    /// known release survives a network failure. A release found for the first time, and
    /// not skipped, gets one toast.
    pub(crate) async fn check_automatic(&self) {
        let Some(started) = self.inner.started.get() else {
            return;
        };
        // No guard may live across the await below.
        let free = {
            let phase = lock(&self.inner.phase);
            !busy(&phase) && *phase != UpdatePhase::Checking
        };
        if !free {
            return;
        }
        let result = started.source.check().await;
        self.checked(result.is_ok());
        let next = match result {
            Ok(Some(release)) => UpdatePhase::Available { release },
            Ok(None) => UpdatePhase::UpToDate,
            Err(e) => {
                tracing::warn!("the automatic update check failed: {e}");
                return;
            }
        };
        let found = match &next {
            UpdatePhase::Available { release } => Some(release.version.clone()),
            _ => None,
        };
        if !self.apply_automatic(next) {
            return;
        }
        let toast = found.is_some_and(|version| self.first_notice(&version));
        self.publish(toast.then(|| (started.toast_window)()));
    }

    /// True once per version that is neither skipped nor already announced; remembers it.
    fn first_notice(&self, version: &str) -> bool {
        let memory = self.inner.memory.get();
        if memory.skipped_version.as_deref() == Some(version)
            || memory.notified_version.as_deref() == Some(version)
        {
            return false;
        }
        if let Err(e) = self
            .inner
            .memory
            .update(|m| m.notified_version = Some(version.to_owned()))
        {
            tracing::warn!("cannot save which update was announced: {e}");
        }
        true
    }

    /// Downloads the available release, verifies it and installs it; the caller restarts
    /// the app when this returns `Ok`. Refused while another install runs, when there is
    /// nothing to install, and when this copy cannot update itself.
    pub async fn install(&self) -> CoreResult<()> {
        let source = self.source()?;
        if let Some(blocker) = source.blocker() {
            return Err(IpcError::new(ErrorCode::Conflict, blocker));
        }
        let token = CancellationToken::new();
        let release = {
            let mut phase = lock(&self.inner.phase);
            let release = match &*phase {
                UpdatePhase::Available { release }
                | UpdatePhase::Failed {
                    release: Some(release),
                    ..
                } => release.clone(),
                UpdatePhase::Downloading { .. } | UpdatePhase::Installing { .. } => {
                    return Err(IpcError::new(
                        ErrorCode::Conflict,
                        "an update is already being installed",
                    ));
                }
                _ => {
                    return Err(IpcError::new(
                        ErrorCode::Conflict,
                        "there is no update to install",
                    ));
                }
            };
            *phase = UpdatePhase::Downloading {
                version: release.version.clone(),
                received: 0,
                total: None,
            };
            *lock(&self.inner.download) = Some(token.clone());
            release
        };
        self.publish(None);

        let downloaded = tokio::select! {
            () = token.cancelled() => None,
            result = source.download(self.progress(&release.version)) => Some(result),
        };
        *lock(&self.inner.download) = None;
        let package = match downloaded {
            None => {
                self.set_phase(UpdatePhase::Available { release });
                return Err(IpcError::new(
                    ErrorCode::Cancelled,
                    "the update download was cancelled",
                ));
            }
            Some(Err(e)) => {
                tracing::warn!("the update download failed: {e}");
                self.set_phase(UpdatePhase::Failed {
                    message: e.message.clone(),
                    release: Some(release),
                });
                return Err(e);
            }
            Some(Ok(package)) => package,
        };

        self.set_phase(UpdatePhase::Installing {
            version: release.version.clone(),
        });
        let installed = tokio::task::spawn_blocking(move || source.install(package))
            .await
            .unwrap_or_else(|e| {
                Err(IpcError::new(
                    ErrorCode::Internal,
                    format!("the installer stopped: {e}"),
                ))
            });
        if let Err(e) = &installed {
            tracing::warn!("the update was not installed: {e}");
            self.set_phase(UpdatePhase::Failed {
                message: e.message.clone(),
                release: Some(release),
            });
        }
        installed
    }

    /// Reports download progress while this download is the running one.
    fn progress(&self, version: &str) -> Progress {
        let updates = self.clone();
        let version = version.to_owned();
        let mut gate = ProgressGate::new(PROGRESS_EVERY);
        Box::new(move |received, total| {
            if !gate.ready(std::time::Instant::now()) {
                return;
            }
            {
                let mut phase = lock(&updates.inner.phase);
                // A cancelled download may still report: only a running one moves the bar.
                let running = matches!(
                    &*phase,
                    UpdatePhase::Downloading { version: v, .. } if *v == version
                );
                if !running {
                    return;
                }
                *phase = UpdatePhase::Downloading {
                    version: version.clone(),
                    received,
                    total,
                };
            }
            updates.publish(None);
        })
    }

    /// Stops a running download; `install` then returns to Available.
    pub fn cancel(&self) {
        if let Some(token) = lock(&self.inner.download).as_ref() {
            token.cancel();
        }
    }

    /// Hides `version` from the toast and the status bar until a newer one appears.
    pub fn skip(&self, version: String) -> CoreResult<()> {
        self.inner
            .memory
            .update(|m| m.skipped_version = Some(version))?;
        self.publish(None);
        Ok(())
    }
}

/// Checks 10 s after start, then every 6 hours, while `update_check` is on. Turning it on
/// checks at once when the last check of this run is older than 6 hours, or none ran.
async fn schedule(updates: Updates, mut prefs: watch::Receiver<Prefs>) {
    let stop = updates.inner.stop.clone();
    let mut enabled = prefs.borrow_and_update().update_check;
    let mut next = Instant::now() + FIRST_CHECK;
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep_until(next), if enabled => {
                // Stopping must not wait for a slow update server.
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = updates.check_automatic() => {}
                }
                next = Instant::now() + CHECK_EVERY;
            }
            changed = prefs.changed() => {
                if changed.is_err() {
                    return;
                }
                let now_enabled = prefs.borrow_and_update().update_check;
                if now_enabled && !enabled {
                    next = updates
                        .last_check()
                        .map_or_else(Instant::now, |at| at + CHECK_EVERY);
                }
                enabled = now_enabled;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use crate::updates::{BoxFuture, Package, Release};

    #[derive(Default)]
    struct Fake {
        checks: AtomicUsize,
        answers: Mutex<VecDeque<CoreResult<Option<Release>>>>,
        downloads: Mutex<VecDeque<CoreResult<Package>>>,
        /// While set, a download waits for `let_download_finish`.
        hold_download: AtomicBool,
        download_gate: tokio::sync::Notify,
        /// While set, a check waits forever, like an update server that never answers.
        hold_check: AtomicBool,
        installs: Mutex<Vec<String>>,
        blocker: Mutex<Option<String>>,
    }

    impl Fake {
        fn answer(&self, answer: CoreResult<Option<Release>>) {
            lock(&self.answers).push_back(answer);
        }
        fn checks(&self) -> usize {
            self.checks.load(Ordering::SeqCst)
        }
        fn let_download_finish(&self) {
            self.download_gate.notify_one();
        }
    }

    impl UpdateSource for Fake {
        fn check(&self) -> BoxFuture<'_, CoreResult<Option<Release>>> {
            Box::pin(async move {
                self.checks.fetch_add(1, Ordering::SeqCst);
                if self.hold_check.load(Ordering::SeqCst) {
                    std::future::pending::<()>().await;
                }
                let answer = lock(&self.answers).pop_front();
                answer.unwrap_or(Ok(None))
            })
        }

        fn download(&self, mut progress: Progress) -> BoxFuture<'_, CoreResult<Package>> {
            Box::pin(async move {
                progress(512, Some(1024));
                if self.hold_download.load(Ordering::SeqCst) {
                    self.download_gate.notified().await;
                }
                // A cancelled download may still report once more.
                progress(1024, Some(1024));
                let next = lock(&self.downloads).pop_front();
                next.unwrap_or_else(|| {
                    Ok(Package {
                        version: "0.10.0".into(),
                        bytes: vec![1, 2, 3],
                    })
                })
            })
        }

        fn install(&self, package: Package) -> CoreResult<()> {
            lock(&self.installs).push(package.version);
            Ok(())
        }

        fn blocker(&self) -> Option<String> {
            lock(&self.blocker).clone()
        }

        fn installer(&self) -> Option<String> {
            Some("appimage".into())
        }
    }

    fn release(version: &str) -> Release {
        Release {
            version: version.into(),
            notes: format!("Notes for {version}"),
            date: Some(1_764_000_000),
        }
    }

    struct Setup {
        updates: Updates,
        fake: Arc<Fake>,
        prefs: JsonStore<Prefs>,
        events: broadcast::Receiver<CoreEvent>,
        dir: tempfile::TempDir,
    }

    fn setup_in(dir: tempfile::TempDir, fake: Fake, automatic: bool) -> Setup {
        let (sender, events) = broadcast::channel(256);
        let (memory, _) = JsonStore::open(dir.path().join("updates.json"), 1);
        let (prefs, _) = JsonStore::<Prefs>::open(dir.path().join("prefs.json"), 1);
        let updates = Updates::new(memory, sender, "0.9.0");
        let fake = Arc::new(fake);
        updates.start(fake.clone(), automatic, prefs.subscribe(), || {
            "window-2".to_owned()
        });
        Setup {
            updates,
            fake,
            prefs,
            events,
            dir,
        }
    }

    fn setup(fake: Fake, automatic: bool) -> Setup {
        setup_in(tempfile::tempdir().unwrap(), fake, automatic)
    }

    /// Lets spawned tasks run up to their next timer.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn states(events: &mut broadcast::Receiver<CoreEvent>) -> Vec<UpdateState> {
        let mut out = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let CoreEvent::UpdateState { state } = event {
                out.push(state);
            }
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn automatic_checks_run_ten_seconds_after_start_then_every_six_hours() {
        let s = setup(Fake::default(), true);
        tokio::time::sleep(Duration::from_secs(9)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 0);
        tokio::time::sleep(Duration::from_secs(2)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 1);
        tokio::time::sleep(CHECK_EVERY - Duration::from_secs(2)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 1);
        tokio::time::sleep(Duration::from_secs(2)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn builds_without_automatic_checks_and_users_who_turned_them_off_check_only_when_asked() {
        let quiet = setup(Fake::default(), false);
        let off = setup(Fake::default(), true);
        off.prefs.update(|p| p.update_check = false).unwrap();
        tokio::time::sleep(CHECK_EVERY * 2).await;
        settle().await;
        assert_eq!(quiet.fake.checks(), 0);
        assert_eq!(off.fake.checks(), 0);

        quiet.updates.check_now().await;
        assert_eq!(quiet.fake.checks(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn turning_checks_on_checks_at_once_only_when_the_last_check_is_older_than_six_hours() {
        let s = setup(Fake::default(), true);
        tokio::time::sleep(Duration::from_secs(11)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 1);

        // Off and on again an hour later: the next check stays 6 hours after the last one.
        s.prefs.update(|p| p.update_check = false).unwrap();
        tokio::time::sleep(Duration::from_secs(3600)).await;
        s.prefs.update(|p| p.update_check = true).unwrap();
        settle().await;
        assert_eq!(s.fake.checks(), 1);
        tokio::time::sleep(CHECK_EVERY - Duration::from_secs(3600)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 2);

        // Off for longer than 6 hours: turning it on checks at once.
        s.prefs.update(|p| p.update_check = false).unwrap();
        tokio::time::sleep(CHECK_EVERY + Duration::from_secs(60)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 2);
        s.prefs.update(|p| p.update_check = true).unwrap();
        settle().await;
        assert_eq!(s.fake.checks(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn an_automatic_failure_keeps_the_known_release_and_says_nothing() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        fake.answer(Err(IpcError::new(ErrorCode::Unreachable, "dns failed")));
        let mut s = setup(fake, true);
        tokio::time::sleep(Duration::from_secs(11)).await;
        settle().await;
        tokio::time::sleep(CHECK_EVERY).await;
        settle().await;
        assert_eq!(s.fake.checks(), 2);
        assert_eq!(
            s.updates.state().phase,
            UpdatePhase::Available {
                release: release("0.10.0")
            }
        );
        let phases: Vec<UpdatePhase> = states(&mut s.events)
            .into_iter()
            .map(|st| st.phase)
            .collect();
        assert!(phases
            .iter()
            .all(|p| !matches!(p, UpdatePhase::Failed { .. } | UpdatePhase::Checking)));
    }

    #[tokio::test]
    async fn a_manual_check_shows_checking_then_its_failure() {
        let fake = Fake::default();
        fake.answer(Err(IpcError::new(
            ErrorCode::Unreachable,
            "cannot reach the update server: dns failed",
        )));
        let mut s = setup(fake, false);
        states(&mut s.events);
        let state = s.updates.check_now().await;
        assert_eq!(
            state.phase,
            UpdatePhase::Failed {
                message: "cannot reach the update server: dns failed".into(),
                release: None
            }
        );
        let phases: Vec<UpdatePhase> = states(&mut s.events)
            .into_iter()
            .map(|st| st.phase)
            .collect();
        assert_eq!(phases[0], UpdatePhase::Checking);
        assert_eq!(
            state.last_checked_at, None,
            "a failed check does not count as checked"
        );
    }

    #[tokio::test]
    async fn a_successful_check_saves_when_it_ran() {
        let s = setup(Fake::default(), false);
        let state = s.updates.check_now().await;
        assert_eq!(state.phase, UpdatePhase::UpToDate);
        let at = state.last_checked_at.expect("saved");
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        )
        .unwrap();
        assert!((now - at).abs() < 5);
    }

    #[tokio::test(start_paused = true)]
    async fn a_release_is_announced_once_per_version_even_after_a_restart() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        fake.answer(Ok(Some(release("0.10.0"))));
        let mut s = setup(fake, true);
        tokio::time::sleep(Duration::from_secs(11)).await;
        settle().await;
        tokio::time::sleep(CHECK_EVERY).await;
        settle().await;
        let toasts: Vec<Option<String>> = states(&mut s.events)
            .into_iter()
            .map(|st| st.toast_window)
            .filter(Option::is_some)
            .collect();
        assert_eq!(toasts, vec![Some("window-2".to_owned())]);
        assert_eq!(
            s.updates.state().toast_window,
            None,
            "a read never carries the toast"
        );

        // The next run remembers it.
        s.updates.stop();
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        let mut again = setup_in(s.dir, fake, true);
        tokio::time::sleep(Duration::from_secs(11)).await;
        settle().await;
        assert!(states(&mut again.events)
            .iter()
            .all(|st| st.toast_window.is_none()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_skipped_version_is_not_announced_but_a_newer_one_is() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        fake.answer(Ok(Some(release("0.10.0"))));
        fake.answer(Ok(Some(release("0.11.0"))));
        let mut s = setup(fake, false);
        s.updates.skip("0.10.0".into()).unwrap();
        assert_eq!(s.updates.state().skipped.as_deref(), Some("0.10.0"));

        // A manual check still shows the skipped version.
        let state = s.updates.check_now().await;
        assert_eq!(
            state.phase,
            UpdatePhase::Available {
                release: release("0.10.0")
            }
        );
        states(&mut s.events);

        s.updates.check_automatic().await;
        assert!(states(&mut s.events)
            .iter()
            .all(|st| st.toast_window.is_none()));
        s.updates.check_automatic().await;
        let toasts: Vec<Option<String>> = states(&mut s.events)
            .into_iter()
            .map(|st| st.toast_window)
            .filter(Option::is_some)
            .collect();
        assert_eq!(toasts.len(), 1);
        assert_eq!(
            s.updates.state().phase,
            UpdatePhase::Available {
                release: release("0.11.0")
            }
        );
    }

    #[tokio::test]
    async fn install_downloads_then_installs_and_reports_progress() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        let mut s = setup(fake, false);
        s.updates.check_now().await;
        states(&mut s.events);
        s.updates.install().await.unwrap();
        assert_eq!(*lock(&s.fake.installs), vec!["0.10.0".to_owned()]);
        let phases: Vec<UpdatePhase> = states(&mut s.events)
            .into_iter()
            .map(|st| st.phase)
            .collect();
        assert_eq!(
            phases.first(),
            Some(&UpdatePhase::Downloading {
                version: "0.10.0".into(),
                received: 0,
                total: None
            })
        );
        assert!(phases.contains(&UpdatePhase::Downloading {
            version: "0.10.0".into(),
            received: 512,
            total: Some(1024)
        }));
        assert_eq!(
            phases.last(),
            Some(&UpdatePhase::Installing {
                version: "0.10.0".into()
            })
        );
    }

    #[tokio::test]
    async fn a_second_install_is_refused_while_one_runs() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        fake.hold_download.store(true, Ordering::SeqCst);
        let s = setup(fake, false);
        s.updates.check_now().await;
        let first = tokio::spawn({
            let updates = s.updates.clone();
            async move { updates.install().await }
        });
        settle().await;
        let second = s.updates.install().await.unwrap_err();
        assert_eq!(second.code, ErrorCode::Conflict);
        s.fake.let_download_finish();
        first.await.unwrap().unwrap();
        assert_eq!(lock(&s.fake.installs).len(), 1);
    }

    #[tokio::test]
    async fn cancel_returns_to_available_and_a_second_install_works() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        fake.hold_download.store(true, Ordering::SeqCst);
        let s = setup(fake, false);
        s.updates.check_now().await;
        let running = tokio::spawn({
            let updates = s.updates.clone();
            async move { updates.install().await }
        });
        settle().await;
        s.updates.cancel();
        let cancelled = running.await.unwrap().unwrap_err();
        assert_eq!(cancelled.code, ErrorCode::Cancelled);
        assert_eq!(
            s.updates.state().phase,
            UpdatePhase::Available {
                release: release("0.10.0")
            }
        );
        // A report from the dropped download cannot bring "Downloading" back.
        let mut late = s.updates.progress("0.10.0");
        late(900, Some(1024));
        assert_eq!(
            s.updates.state().phase,
            UpdatePhase::Available {
                release: release("0.10.0")
            }
        );

        s.fake.hold_download.store(false, Ordering::SeqCst);
        s.updates.install().await.unwrap();
        assert_eq!(*lock(&s.fake.installs), vec!["0.10.0".to_owned()]);
    }

    #[tokio::test]
    async fn a_failed_download_can_be_tried_again() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        lock(&fake.downloads).push_back(Err(IpcError::new(
            ErrorCode::Unreachable,
            "the update could not be downloaded: reset",
        )));
        let s = setup(fake, false);
        s.updates.check_now().await;
        s.updates.install().await.unwrap_err();
        assert_eq!(
            s.updates.state().phase,
            UpdatePhase::Failed {
                message: "the update could not be downloaded: reset".into(),
                release: Some(release("0.10.0"))
            }
        );
        s.updates.install().await.unwrap();
        assert_eq!(lock(&s.fake.installs).len(), 1);
    }

    #[tokio::test]
    async fn a_copy_that_cannot_update_itself_refuses_to_install() {
        let fake = Fake::default();
        fake.answer(Ok(Some(release("0.10.0"))));
        *lock(&fake.blocker) = Some("Move SkoposIDE to Applications to update it.".into());
        let s = setup(fake, false);
        let state = s.updates.check_now().await;
        assert_eq!(
            state.blocker.as_deref(),
            Some("Move SkoposIDE to Applications to update it.")
        );
        assert_eq!(state.installer.as_deref(), Some("appimage"));
        let refused = s.updates.install().await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::Conflict);
        assert!(lock(&s.fake.installs).is_empty());
    }

    #[tokio::test]
    async fn nothing_to_install_is_refused() {
        let s = setup(Fake::default(), false);
        s.updates.check_now().await;
        assert_eq!(
            s.updates.install().await.unwrap_err().code,
            ErrorCode::Conflict
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stopping_does_not_wait_for_a_check_that_hangs() {
        let fake = Fake::default();
        fake.hold_check.store(true, Ordering::SeqCst);
        let s = setup(fake, true);
        tokio::time::sleep(Duration::from_secs(11)).await;
        settle().await;
        assert_eq!(s.fake.checks(), 1);
        assert_eq!(
            Arc::strong_count(&s.updates.inner),
            2,
            "the scheduler holds a clone"
        );
        s.updates.stop();
        settle().await;
        assert_eq!(
            Arc::strong_count(&s.updates.inner),
            1,
            "the scheduler ended without the check's answer"
        );
    }

    #[tokio::test]
    async fn an_automatic_check_leaves_a_running_manual_check_alone() {
        let mut s = setup(Fake::default(), false);
        *lock(&s.updates.inner.phase) = UpdatePhase::Checking;
        states(&mut s.events);
        s.updates.check_automatic().await;
        assert_eq!(s.fake.checks(), 0, "no second request while one runs");
        assert_eq!(s.updates.state().phase, UpdatePhase::Checking);
        assert!(states(&mut s.events).is_empty());
    }

    #[tokio::test]
    async fn an_automatic_check_keeps_a_failed_install_until_it_finds_a_release() {
        let fake = Fake::default();
        fake.answer(Ok(None));
        fake.answer(Ok(Some(release("0.11.0"))));
        let s = setup(fake, false);
        let failed = UpdatePhase::Failed {
            message: "the signature does not match".into(),
            release: Some(release("0.10.0")),
        };
        *lock(&s.updates.inner.phase) = failed.clone();

        s.updates.check_automatic().await;
        assert_eq!(
            s.updates.state().phase,
            failed,
            "Try Again still has its release"
        );

        s.updates.check_automatic().await;
        assert_eq!(
            s.updates.state().phase,
            UpdatePhase::Available {
                release: release("0.11.0")
            }
        );
    }
}
