use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use ts_rs::TS;

use crate::error::{CoreResult, ErrorCode, IpcError};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoreWarning {
    pub file: String,
    pub message: String,
}

#[derive(Deserialize)]
struct Envelope {
    version: u32,
    data: serde_json::Value,
}

#[derive(Serialize)]
struct EnvelopeRef<'a, T> {
    version: u32,
    data: &'a T,
}

/// A versioned JSON file with atomic writes and change subscription.
pub struct JsonStore<T> {
    path: PathBuf,
    version: u32,
    /// The value readers get. Held only to copy or to replace it and never while the file
    /// is written, so a reader, which may be the app's main thread, does not wait for the
    /// disk.
    state: Mutex<T>,
    /// Held for the whole of an update, so one at a time reads the value, changes it,
    /// writes the file and replaces the value.
    updating: Mutex<()>,
    tx: watch::Sender<T>,
    /// Set by a failed write of `try_update_kept`, cleared by a good one.
    save_failing: AtomicBool,
}

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Stands in for the parser's message, which can quote the offending value. An
/// error from converting a parsed value has no location, which reads as line 0.
fn json_error_text(err: &serde_json::Error) -> String {
    match err.line() {
        0 => "invalid store file".to_owned(),
        line => format!("invalid store file at line {line}, column {}", err.column()),
    }
}

/// Moves a file we cannot use aside so it is never overwritten or lost.
fn set_aside(path: &Path, kind: &str) -> String {
    let mut target = path.as_os_str().to_owned();
    target.push(format!(".{kind}-{}", unix_ts()));
    let target = PathBuf::from(target);
    match std::fs::rename(path, &target) {
        Ok(()) => format!("moved to {}", file_label(&target)),
        Err(e) => format!("could not be moved aside ({e})"),
    }
}

impl<T> JsonStore<T>
where
    T: Serialize + DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    pub fn open(path: PathBuf, version: u32) -> (Self, Option<StoreWarning>) {
        let (value, warning) = Self::load(&path, version);
        let (tx, _rx) = watch::channel(value.clone());
        (
            Self {
                path,
                version,
                state: Mutex::new(value),
                updating: Mutex::new(()),
                tx,
                save_failing: AtomicBool::new(false),
            },
            warning,
        )
    }

    fn load(path: &Path, version: u32) -> (T, Option<StoreWarning>) {
        let label = file_label(path);
        let warn = |message: String| StoreWarning {
            file: label.clone(),
            message,
        };
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (T::default(), None),
            Err(e) => {
                let moved = set_aside(path, "unreadable");
                return (
                    T::default(),
                    Some(warn(format!("{label} could not be read ({e}); {moved}"))),
                );
            }
        };
        let envelope: Envelope = match serde_json::from_slice(&bytes) {
            Ok(env) => env,
            Err(e) => {
                let moved = set_aside(path, "corrupt");
                let reason = json_error_text(&e);
                return (
                    T::default(),
                    Some(warn(format!("{label}: {reason}; {moved}"))),
                );
            }
        };
        if envelope.version > version {
            let moved = set_aside(path, "newer");
            return (
                T::default(),
                Some(warn(format!(
                    "{label} was written by a newer version ({}); {moved}",
                    envelope.version
                ))),
            );
        }
        match serde_json::from_value::<T>(envelope.data) {
            Ok(v) => (v, None),
            Err(e) => {
                let moved = set_aside(path, "corrupt");
                let reason = json_error_text(&e);
                (
                    T::default(),
                    Some(warn(format!("{label}: {reason}; {moved}"))),
                )
            }
        }
    }

    pub fn get(&self) -> T {
        self.lock().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut T)) -> CoreResult<T> {
        self.try_update(|value| {
            f(value);
            Ok(value.clone())
        })
    }

    /// As `update`, but `f` may refuse the change: its error leaves the value and the
    /// file as they were. No other update runs meanwhile, so a check in `f` sees the
    /// value it changes. A reader gets the value from before until the file is written.
    pub fn try_update<R>(&self, f: impl FnOnce(&mut T) -> CoreResult<R>) -> CoreResult<R> {
        let _updating = self.updating();
        let mut next = self.get();
        let out = f(&mut next)?;
        self.write(&next)?;
        self.replace(next);
        Ok(out)
    }

    /// As `try_update`, for a file whose changes must outlive a failed write (spec
    /// P44): when the file cannot be written, the change is kept in memory and sent
    /// to subscribers all the same, and the next good write saves it. Each failure is
    /// logged; the first one since the store opened or since the last good write also
    /// comes back as a warning to show the user, the others as `None`.
    pub fn try_update_kept<R>(
        &self,
        f: impl FnOnce(&mut T) -> CoreResult<R>,
    ) -> CoreResult<(R, Option<StoreWarning>)> {
        let _updating = self.updating();
        let mut next = self.get();
        let out = f(&mut next)?;
        let warning = self.keep(next);
        Ok((out, warning))
    }

    /// Writes `next` and sends it, keeping it in memory even when the write fails;
    /// the warning is the one `try_update_kept` gives back. The caller holds `updating`.
    fn keep(&self, next: T) -> Option<StoreWarning> {
        let warning = match self.write(&next) {
            Ok(()) => {
                self.save_failing.store(false, Ordering::Relaxed);
                None
            }
            Err(e) => {
                let file = file_label(&self.path);
                tracing::warn!("{file}: changes kept in memory, the file cannot be saved: {e}");
                let first = !self.save_failing.swap(true, Ordering::Relaxed);
                first.then(|| StoreWarning {
                    file,
                    message: format!(
                        "changes could not be saved ({e}); they are kept until the app quits"
                    ),
                })
            }
        };
        self.replace(next);
        warning
    }

    /// Makes `next` the value and sends it. The caller holds `updating`.
    fn replace(&self, next: T) {
        *self.lock() = next.clone();
        self.tx.send_replace(next);
    }

    pub fn subscribe(&self) -> watch::Receiver<T> {
        self.tx.subscribe()
    }

    fn lock(&self) -> MutexGuard<'_, T> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn updating(&self) -> MutexGuard<'_, ()> {
        self.updating.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self, value: &T) -> CoreResult<()> {
        let dir = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(dir)?;
        let bytes = serde_json::to_vec_pretty(&EnvelopeRef {
            version: self.version,
            data: value,
        })
        .map_err(|e| IpcError::new(ErrorCode::Internal, format!("cannot serialize: {e}")))?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tmp.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        tmp.write_all(&bytes)?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.path).map_err(|e| e.error)?;
        Ok(())
    }
}

impl<T> JsonStore<T>
where
    T: Serialize + DeserializeOwned + Default + Clone + PartialEq + Send + Sync + 'static,
{
    /// As `try_update_kept`, but a change that leaves the value as it was is neither
    /// written nor sent; the flag says whether the value changed.
    pub fn try_update_kept_if_changed<R>(
        &self,
        f: impl FnOnce(&mut T) -> CoreResult<R>,
    ) -> CoreResult<(R, bool, Option<StoreWarning>)> {
        let _updating = self.updating();
        let current = self.get();
        let mut next = current.clone();
        let out = f(&mut next)?;
        if next == current {
            return Ok((out, false, None));
        }
        let warning = self.keep(next);
        Ok((out, true, warning))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default, Clone, Serialize, Deserialize, PartialEq, Debug)]
    struct Sample {
        n: u32,
    }

    #[test]
    fn a_reader_does_not_wait_for_an_update_under_way() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let (store, _) = JsonStore::<Sample>::open(dir.path().join("a.json"), 1);
        let store = Arc::new(store);
        store.update(|v| v.n = 1).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        // An update that is held where it would be writing the file.
        let writer = {
            let store = store.clone();
            std::thread::spawn(move || {
                store
                    .update(|v| {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        v.n = 2;
                    })
                    .unwrap();
            })
        };
        entered_rx.recv().unwrap();

        let (read_tx, read_rx) = mpsc::channel();
        let reader = {
            let store = store.clone();
            std::thread::spawn(move || {
                let _ = read_tx.send(store.get().n);
            })
        };
        let read = read_rx.recv_timeout(Duration::from_secs(2));

        release_tx.send(()).unwrap();
        writer.join().unwrap();
        reader.join().unwrap();
        assert_eq!(read, Ok(1), "the reader waited for the update");
        assert_eq!(store.get().n, 2);
    }

    #[test]
    fn concurrent_updates_take_turns_and_none_is_lost() {
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let (store, _) = JsonStore::<Sample>::open(path.clone(), 1);
        let store = Arc::new(store);

        let writers: Vec<_> = (0..4)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        store.update(|v| v.n += 1).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }

        assert_eq!(store.get().n, 40);
        let (again, _) = JsonStore::<Sample>::open(path, 1);
        assert_eq!(again.get().n, 40, "the file holds the last value");
    }

    #[test]
    fn missing_file_gives_default_without_warning() {
        let dir = tempfile::tempdir().unwrap();
        let (s, w) = JsonStore::<Sample>::open(dir.path().join("a.json"), 1);
        assert!(w.is_none());
        assert_eq!(s.get(), Sample::default());
    }

    #[test]
    fn update_persists_atomically_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        s.update(|v| v.n = 7).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from("a.json")],
            "no temp files left behind"
        );
        let (again, _) = JsonStore::<Sample>::open(p, 1);
        assert_eq!(again.get().n, 7);
    }

    #[test]
    fn corrupt_file_is_preserved_and_defaults_used() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        std::fs::write(&p, "{ not json").unwrap();
        let (s, w) = JsonStore::<Sample>::open(p.clone(), 1);
        assert_eq!(s.get(), Sample::default());
        assert!(w.unwrap().message.contains("a.json"));
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("a.json.corrupt-")
            })
            .count();
        assert_eq!(kept, 1);
    }

    #[test]
    fn corrupt_store_warning_does_not_quote_values() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        std::fs::write(&p, r#"{"version":1,"data":{"n":"tok-SECRET"}}"#).unwrap();
        let (_, w) = JsonStore::<Sample>::open(p, 1);
        assert!(!w.unwrap().message.contains("tok-SECRET"));
    }

    #[test]
    fn malformed_envelope_warning_gives_a_location_and_no_values() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        std::fs::write(&p, "{\"version\":\"tok-SECRET\",\n\"data\":{}}").unwrap();
        let (_, w) = JsonStore::<Sample>::open(p, 1);
        let message = w.unwrap().message;
        assert!(!message.contains("tok-SECRET"), "{message}");
        assert!(
            message.contains("invalid store file at line 1, column "),
            "{message}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_preserved_and_defaults_used() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let saved = r#"{"version":1,"data":{"n":5}}"#;
        std::fs::write(&p, saved).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&p).is_ok() {
            eprintln!("skipped: root ignores file modes");
            return;
        }

        let (s, w) = JsonStore::<Sample>::open(p.clone(), 1);

        assert_eq!(s.get(), Sample::default());
        let message = w.unwrap().message;
        assert!(message.contains("moved to a.json.unreadable-"), "{message}");
        assert!(!p.exists());
        s.update(|v| v.n = 9).unwrap();
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|path| path.to_string_lossy().contains("a.json.unreadable-"))
            .unwrap();
        std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(kept).unwrap(), saved);
    }

    #[test]
    fn newer_version_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        std::fs::write(&p, r#"{"version":99,"data":{"n":5}}"#).unwrap();
        let (s, w) = JsonStore::<Sample>::open(p, 1);
        assert_eq!(s.get(), Sample::default());
        assert!(w.is_some());
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("a.json.newer-")
            })
            .count();
        assert_eq!(kept, 1);
    }

    #[test]
    fn a_refused_try_update_keeps_the_value_and_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        s.update(|v| v.n = 1).unwrap();
        let rx = s.subscribe();

        let refused = s.try_update(|v| {
            v.n = 2;
            Err::<(), _>(IpcError::new(ErrorCode::InvalidInput, "no"))
        });
        let kept = s.try_update(|v| {
            v.n += 10;
            Ok(v.n)
        });

        assert_eq!(refused.unwrap_err().message, "no");
        assert_eq!(kept.unwrap(), 11);
        assert_eq!(rx.borrow().n, 11);
        let (again, _) = JsonStore::<Sample>::open(p, 1);
        assert_eq!(again.get().n, 11);
    }

    #[test]
    fn subscribers_see_updates() {
        let dir = tempfile::tempdir().unwrap();
        let (s, _) = JsonStore::<Sample>::open(dir.path().join("a.json"), 1);
        let rx = s.subscribe();
        s.update(|v| v.n = 3).unwrap();
        assert_eq!(rx.borrow().n, 3);
    }

    #[cfg(unix)]
    #[test]
    fn file_mode_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        s.update(|v| v.n = 1).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn a_kept_update_survives_a_failed_write_and_warns_once_per_failing_run() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        let rx = s.subscribe();
        // The target path is now a directory, so persist (rename over it) fails.
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("x"), "x").unwrap();

        let first = s.try_update_kept(|v| {
            v.n = 1;
            Ok(v.n)
        });
        let second = s.try_update_kept(|v| {
            v.n += 1;
            Ok(v.n)
        });
        let refused = s.try_update_kept(|v| {
            v.n = 99;
            Err::<(), _>(IpcError::new(ErrorCode::InvalidInput, "no"))
        });

        let (n, warning) = first.unwrap();
        assert_eq!(n, 1);
        assert_eq!(warning.unwrap().file, "a.json");
        let (n, warning) = second.unwrap();
        assert_eq!(n, 2);
        assert!(warning.is_none(), "one warning per failing run");
        assert_eq!(refused.unwrap_err().message, "no");
        assert_eq!(s.get().n, 2);
        assert_eq!(rx.borrow().n, 2);

        std::fs::remove_dir_all(&p).unwrap();
        let (n, warning) = s.try_update_kept(|v| Ok(v.n)).unwrap();
        assert_eq!(n, 2);
        assert!(warning.is_none());
        let (again, _) = JsonStore::<Sample>::open(p.clone(), 1);
        assert_eq!(again.get().n, 2);
        std::fs::remove_file(&p).unwrap();
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("x"), "x").unwrap();
        let (n, warning) = s.try_update_kept(|v| Ok(v.n + 1)).unwrap();
        assert_eq!(n, 3);
        assert!(warning.is_some(), "a new failing run warns again");
    }

    #[test]
    fn a_kept_update_that_changes_nothing_writes_and_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        let mut rx = s.subscribe();

        let (n, changed, warning) = s.try_update_kept_if_changed(|v| Ok(v.n)).unwrap();

        assert_eq!((n, changed), (0, false));
        assert!(warning.is_none());
        assert!(!p.exists());
        assert!(!rx.has_changed().unwrap());

        let (_, changed, _) = s
            .try_update_kept_if_changed(|v| {
                v.n = 1;
                Ok(())
            })
            .unwrap();

        assert!(changed);
        assert!(rx.has_changed().unwrap());
        assert_eq!(rx.borrow_and_update().n, 1);
        assert!(p.exists());
    }

    #[test]
    fn failed_write_keeps_old_value() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        // The target path is now a directory, so persist (rename over it) fails.
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("x"), "x").unwrap();
        assert!(s.update(|v| v.n = 9).is_err());
        assert_eq!(s.get(), Sample::default());
    }
}
