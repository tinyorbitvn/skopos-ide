use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use notify_debouncer_full::file_id::{get_file_id, FileId};
use notify_debouncer_full::notify::event::{AccessKind, AccessMode};
use notify_debouncer_full::notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tokio::sync::watch;
use ts_rs::TS;

use super::parse::{parse_file, ContextEntry};
use super::sources::SyncSource;
use crate::error::sanitize_text;

const DEBOUNCE: Duration = Duration::from_millis(500);
pub(crate) const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const KUBECONFIG_MARKERS: [&str; 3] = ["clusters:", "contexts:", "kind: Config"];
/// A file whose mtime is nearer than this to the scan is read again next time: a write in
/// the same timestamp tick would leave the stamp as it was.
const MTIME_TRUST: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncWarning {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSnapshot {
    pub entries: Vec<ContextEntry>,
    pub warnings: Vec<SyncWarning>,
}

enum Message {
    Rescan,
    SetSources(Vec<SyncSource>),
    Stop,
}

/// Keeps a [`SyncSnapshot`] of every context in the sources up to date, on a
/// background thread driven by file events and a polling safety net.
pub struct KubeconfigSync {
    messages: mpsc::Sender<Message>,
    thread: Option<JoinHandle<()>>,
}

impl KubeconfigSync {
    pub fn start(
        sources: Vec<SyncSource>,
        poll_every: Duration,
    ) -> (KubeconfigSync, watch::Receiver<SyncSnapshot>) {
        let (publish, snapshots) = watch::channel(SyncSnapshot::default());
        let (messages, inbox) = mpsc::channel();
        let events = messages.clone();
        let spawned = std::thread::Builder::new()
            .name("kubeconfig-sync".to_owned())
            .spawn(move || {
                Worker::new(sources, publish, events).run(&inbox, poll_every);
            });
        let thread = match spawned {
            Ok(thread) => Some(thread),
            Err(e) => {
                tracing::error!("cannot start the kubeconfig sync thread: {e}");
                None
            }
        };
        (KubeconfigSync { messages, thread }, snapshots)
    }

    pub fn set_sources(&self, sources: Vec<SyncSource>) {
        // Sending fails only after the worker has gone, and then nothing reads sources.
        let _ = self.messages.send(Message::SetSources(sources));
    }

    pub fn stop(self) {
        // Drop does the work, so a sync that is dropped without `stop` also ends.
    }
}

impl Drop for KubeconfigSync {
    fn drop(&mut self) {
        let _ = self.messages.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Worker {
    sources: Vec<SyncSource>,
    publish: watch::Sender<SyncSnapshot>,
    debouncer: Option<Debouncer<RecommendedWatcher, RecommendedCache>>,
    /// Identity lets us notice a directory that was replaced, whose old watch is dead.
    watched: HashMap<PathBuf, FileId>,
    /// Paths already logged, so a persistent failure does not log on every poll.
    failed_watches: HashSet<PathBuf>,
    /// Directories of symlink targets, whose changes the source watches cannot see.
    target_dirs: BTreeSet<PathBuf>,
    /// The entries last accepted for each file, kept when a later read fails.
    accepted: HashMap<PathBuf, Vec<ContextEntry>>,
    /// The last successful parse of each file, so an unchanged file is not read again.
    cache: ParseCache,
}

impl Worker {
    fn new(
        sources: Vec<SyncSource>,
        publish: watch::Sender<SyncSnapshot>,
        events: mpsc::Sender<Message>,
    ) -> Self {
        let debouncer = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
            let rescan = match result {
                Ok(events) => events.iter().any(|event| triggers_rescan(&event.kind)),
                Err(errors) => {
                    tracing::debug!("kubeconfig watch errors: {errors:?}");
                    true
                }
            };
            if rescan {
                let _ = events.send(Message::Rescan);
            }
        })
        .map_err(|e| tracing::warn!("kubeconfig file watching is unavailable: {e}"))
        .ok();
        Self {
            sources,
            publish,
            debouncer,
            watched: HashMap::new(),
            failed_watches: HashSet::new(),
            target_dirs: BTreeSet::new(),
            accepted: HashMap::new(),
            cache: ParseCache::default(),
        }
    }

    fn run(mut self, inbox: &mpsc::Receiver<Message>, poll_every: Duration) {
        self.refresh();
        let mut last_refresh = Instant::now();
        loop {
            match inbox.recv_timeout(poll_every.saturating_sub(last_refresh.elapsed())) {
                Ok(Message::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Ok(Message::SetSources(sources)) => self.sources = sources,
                Ok(Message::Rescan) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            self.refresh();
            last_refresh = Instant::now();
        }
    }

    fn refresh(&mut self) {
        // Watches go first: a file written after this point raises an event, and
        // one written before it is seen by the scan, so nothing falls in between.
        self.update_watches();
        let snapshot = self.scan();
        self.update_watches();
        self.publish.send_if_modified(|current| {
            let changed = *current != snapshot;
            if changed {
                *current = snapshot;
            }
            changed
        });
    }

    fn update_watches(&mut self) {
        let Some(debouncer) = self.debouncer.as_mut() else {
            return;
        };
        let mut wanted: BTreeSet<PathBuf> = self.sources.iter().filter_map(watch_target).collect();
        wanted.extend(self.target_dirs.iter().cloned());

        self.watched.retain(|path, id| {
            let keep = wanted.contains(path) && get_file_id(path).ok().as_ref() == Some(&*id);
            if !keep {
                // Fails when the watch died with its directory, which is the same outcome.
                let _ = debouncer.unwatch(path);
            }
            keep
        });
        for path in wanted {
            if self.watched.contains_key(&path) {
                continue;
            }
            let watch = get_file_id(&path)
                .map_err(|e| e.to_string())
                .and_then(|id| {
                    debouncer
                        .watch(&path, RecursiveMode::NonRecursive)
                        .map(|()| id)
                        .map_err(|e| e.to_string())
                });
            match watch {
                Ok(id) => {
                    self.failed_watches.remove(&path);
                    self.watched.insert(path, id);
                }
                Err(e) => {
                    // Polling still covers this path.
                    if self.failed_watches.insert(path.clone()) {
                        tracing::warn!("cannot watch {}: {e}", path.display());
                    }
                }
            }
        }
    }

    fn scan(&mut self) -> SyncSnapshot {
        self.scan_at(SystemTime::now())
    }

    /// `scanned_at` is when this scan began, which decides which file times can be trusted.
    fn scan_at(&mut self, scanned_at: SystemTime) -> SyncSnapshot {
        let mut warnings = Vec::new();
        let candidates = collect_candidates(&self.sources, &self.accepted, &mut warnings);
        let mut accepted = HashMap::new();
        let mut entries = Vec::new();
        for candidate in &candidates {
            let previous = self.accepted.remove(&candidate.path).unwrap_or_default();
            let kept = read_candidate(
                candidate,
                previous,
                &mut self.cache,
                scanned_at,
                &mut warnings,
            );
            entries.extend(kept.iter().cloned());
            accepted.insert(candidate.path.clone(), kept);
        }
        self.accepted = accepted;
        self.cache.keep_only(&candidates);
        self.target_dirs = candidates
            .iter()
            .filter(|c| is_symlink(&c.path))
            .filter_map(|c| c.canonical.parent().map(Path::to_path_buf))
            .collect();

        entries.sort_by(|a, b| {
            (&a.context_name, &a.source_path).cmp(&(&b.context_name, &b.source_path))
        });
        warnings.sort_by(|a, b| (&a.path, &a.message).cmp(&(&b.path, &b.message)));
        SyncSnapshot { entries, warnings }
    }
}

/// Our own reads raise open and close events, so reacting to those would rescan forever.
fn triggers_rescan(kind: &EventKind) -> bool {
    !kind.is_access()
        || matches!(
            kind,
            EventKind::Access(AccessKind::Close(AccessMode::Write))
        )
}

/// The directory that reports changes to a source. A file's parent is used
/// rather than the file, because a rename over the file would end a watch on it.
fn watch_target(source: &SyncSource) -> Option<PathBuf> {
    let start = match source {
        SyncSource::Dir(path) => PathBuf::from(path),
        SyncSource::File(path) => {
            let path = Path::new(path);
            path.parent().unwrap_or(path).to_path_buf()
        }
    };
    start
        .ancestors()
        .find(|ancestor| !ancestor.as_os_str().is_empty() && ancestor.exists())
        .map(Path::to_path_buf)
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn is_skipped_name(name: &str) -> bool {
    name.starts_with('.')
        || name.ends_with(".lock")
        || name.ends_with(".bak")
        || name.ends_with('~')
}

/// What identifies one version of a file without reading it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    explicit: bool,
    modified: SystemTime,
    len: u64,
    /// A `chmod` changes neither the time nor the size, and can make the file unreadable.
    permissions: std::fs::Permissions,
    /// The device and inode where the platform has them, so a file replaced by another of the
    /// same size and time is noticed.
    identity: Option<(u64, u64)>,
}

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// The stamp of the file `path` leads to, links followed. `None` when it cannot be examined
/// or is not a regular file, and then nothing is cached.
fn stamp_of(path: &Path, explicit: bool) -> Option<FileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(FileStamp {
        explicit,
        modified: metadata.modified().ok()?,
        len: metadata.len(),
        permissions: metadata.permissions(),
        identity: file_identity(&metadata),
    })
}

/// The entries of each file's last successful parse, with the stamp they were read under.
#[derive(Debug, Default)]
struct ParseCache {
    entries: HashMap<PathBuf, (FileStamp, Vec<ContextEntry>)>,
    /// How many files were parsed, for tests.
    #[cfg(test)]
    parses: usize,
}

impl ParseCache {
    fn hit(&self, path: &Path, stamp: &FileStamp) -> Option<Vec<ContextEntry>> {
        let (cached, entries) = self.entries.get(path)?;
        (cached == stamp).then(|| entries.clone())
    }

    /// Keeps the result under `stamp`, unless the file is too new to tell its versions apart.
    fn store(
        &mut self,
        path: &Path,
        stamp: Option<FileStamp>,
        scanned_at: SystemTime,
        entries: Vec<ContextEntry>,
    ) {
        let settled = stamp.filter(|stamp| {
            scanned_at
                .duration_since(stamp.modified)
                .is_ok_and(|age| age >= MTIME_TRUST)
        });
        match settled {
            Some(stamp) => {
                self.entries.insert(path.to_path_buf(), (stamp, entries));
            }
            None => {
                self.entries.remove(path);
            }
        }
    }

    /// Forgets the files that are not candidates any more.
    fn keep_only(&mut self, candidates: &[Candidate]) {
        let kept: HashSet<&Path> = candidates.iter().map(|c| c.path.as_path()).collect();
        self.entries.retain(|path, _| kept.contains(path.as_path()));
    }
}

struct Candidate {
    /// The path as the source gives it, which entries and warnings report.
    path: PathBuf,
    /// Used only to recognise one file reached through two sources.
    canonical: PathBuf,
    explicit: bool,
}

fn warning(path: &Path, message: String) -> SyncWarning {
    SyncWarning {
        path: path.display().to_string(),
        message: sanitize_text(&message),
    }
}

fn collect_candidates(
    sources: &[SyncSource],
    accepted: &HashMap<PathBuf, Vec<ContextEntry>>,
    warnings: &mut Vec<SyncWarning>,
) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut by_canonical: HashMap<PathBuf, usize> = HashMap::new();
    let mut add = |path: PathBuf, explicit: bool| {
        let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        match by_canonical.get(&canonical) {
            Some(&index) => candidates[index].explicit |= explicit,
            None => {
                by_canonical.insert(canonical.clone(), candidates.len());
                candidates.push(Candidate {
                    path,
                    canonical,
                    explicit,
                });
            }
        }
    };
    for source in sources {
        match source {
            SyncSource::File(path) => add(PathBuf::from(path), true),
            SyncSource::Dir(path) => {
                for file in list_dir(Path::new(path), accepted, warnings) {
                    add(file, false);
                }
            }
        }
    }
    candidates
}

/// Sorted, so which of two links to one file wins does not depend on directory order.
fn list_dir(
    dir: &Path,
    accepted: &HashMap<PathBuf, Vec<ContextEntry>>,
    warnings: &mut Vec<SyncWarning>,
) -> Vec<PathBuf> {
    // Collected first, so an error midway through the listing counts like one at the start.
    let listing =
        std::fs::read_dir(dir).and_then(|items| items.collect::<std::io::Result<Vec<_>>>());
    let mut files: Vec<PathBuf> = match listing {
        Ok(items) => items
            .iter()
            .filter(|item| !is_skipped_name(&item.file_name().to_string_lossy()))
            .map(|item| item.path())
            .filter(|path| may_be_file(path))
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            warnings.push(warning(dir, format!("could not read the directory: {e}")));
            // A failed listing does not mean the files have gone, and dropping
            // their entries would disconnect their clusters on a brief outage.
            accepted
                .iter()
                .filter(|(path, entries)| !entries.is_empty() && path.parent() == Some(dir))
                .map(|(path, _)| path.clone())
                .collect()
        }
    };
    files.sort();
    files
}

/// A path that cannot be examined may still be a file with accepted entries,
/// so only a missing one is ruled out. `read_candidate` reports the others.
fn may_be_file(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(metadata) => metadata.is_file(),
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Returns the entries to keep for this file, adding a warning when they are
/// the previous ones because the current content could not be used. A file whose stamp is
/// the one of its last successful parse is not read.
fn read_candidate(
    candidate: &Candidate,
    previous: Vec<ContextEntry>,
    cache: &mut ParseCache,
    scanned_at: SystemTime,
    warnings: &mut Vec<SyncWarning>,
) -> Vec<ContextEntry> {
    let path = candidate.path.as_path();
    // Before the read: a write that lands after this makes the next stamp differ.
    let stamp = stamp_of(path, candidate.explicit);
    if let Some(entries) = stamp.as_ref().and_then(|stamp| cache.hit(path, stamp)) {
        return entries;
    }
    let bytes = match read_limited(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Vec::new(),
        Err(message) => {
            warnings.push(warning(path, message));
            return previous;
        }
    };
    #[cfg(test)]
    {
        cache.parses += 1;
    }
    match parse_file(path, &bytes) {
        Ok(parsed) if candidate.explicit || parsed.is_kubeconfig => {
            cache.store(path, stamp, scanned_at, parsed.entries.clone());
            parsed.entries
        }
        Ok(_) if previous.is_empty() => {
            cache.store(path, stamp, scanned_at, Vec::new());
            Vec::new()
        }
        Ok(_) => {
            warnings.push(warning(
                path,
                "the file is no longer a kubeconfig".to_owned(),
            ));
            previous
        }
        Err(message) => {
            if candidate.explicit || !previous.is_empty() || mentions_kubeconfig(path, &bytes) {
                warnings.push(warning(path, message));
            }
            previous
        }
    }
}

/// `Ok(None)` means the file does not exist, which is not a problem to report.
fn read_limited(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let unreadable = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => Ok(None),
        _ => Err(format!("could not read the file: {e}")),
    };
    let size = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(e) => return unreadable(e),
    };
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "the file is {size} bytes, over the 10 MiB limit, and was skipped"
        ));
    }
    std::fs::read(path).map(Some).or_else(unreadable)
}

/// Decides whether an unparsable file in a scanned directory is a broken
/// kubeconfig worth a warning, or an unrelated file to leave alone.
fn mentions_kubeconfig(path: &Path, bytes: &[u8]) -> bool {
    if path.file_name().is_some_and(|name| name == "config") {
        return true;
    }
    let text = String::from_utf8_lossy(bytes);
    KUBECONFIG_MARKERS
        .iter()
        .any(|marker| text.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_full::notify::event::{
        AccessKind, AccessMode, CreateKind, EventKind, ModifyKind, RemoveKind,
    };

    #[test]
    fn our_own_reads_do_not_trigger_a_rescan() {
        for kind in [
            EventKind::Access(AccessKind::Open(AccessMode::Any)),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
            EventKind::Access(AccessKind::Read),
        ] {
            assert!(!triggers_rescan(&kind), "{kind:?}");
        }
    }

    #[test]
    fn changes_trigger_a_rescan() {
        for kind in [
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Remove(RemoveKind::File),
            EventKind::Other,
        ] {
            assert!(triggers_rescan(&kind), "{kind:?}");
        }
    }

    // Linux only: inotify is what reports our own opens, and FSEvents may
    // replay the write made just before the watch started.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_scan_does_not_cause_another_scan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config"), "kind: Config\n").unwrap();
        let (publish, _snapshots) = watch::channel(SyncSnapshot::default());
        let (events, inbox) = mpsc::channel();
        let source = SyncSource::Dir(dir.path().display().to_string());
        let mut worker = Worker::new(vec![source], publish, events);

        worker.refresh();
        worker.refresh();

        assert!(matches!(
            inbox.recv_timeout(DEBOUNCE * 3),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }

    #[test]
    fn dir_scan_name_filter() {
        for name in [".hidden", "config.lock", "config.bak", "config~"] {
            assert!(is_skipped_name(name), "{name}");
        }
        for name in ["config", "dev.yaml", "lock", "bak"] {
            assert!(!is_skipped_name(name), "{name}");
        }
    }

    use std::fs::OpenOptions;
    use std::time::SystemTime;

    /// A valid kubeconfig with one context. Names of the same length give files of the
    /// same size.
    fn config_named(context: &str) -> String {
        format!(
            "apiVersion: v1\nkind: Config\n\
             clusters:\n- {{ name: c1, cluster: {{ server: \"https://x\" }} }}\n\
             users:\n- {{ name: u1, user: {{ token: t }} }}\n\
             contexts:\n- {{ name: {context}, context: {{ cluster: c1, user: u1 }} }}\n"
        )
    }

    fn worker_for(sources: Vec<SyncSource>) -> Worker {
        let (publish, _snapshots) = watch::channel(SyncSnapshot::default());
        let (events, _inbox) = mpsc::channel();
        Worker::new(sources, publish, events)
    }

    fn file_worker(path: &Path) -> Worker {
        worker_for(vec![SyncSource::File(path.display().to_string())])
    }

    /// Sets a file's modification time to `ago` before now, as a file left alone for that long.
    fn age(path: &Path, ago: Duration) {
        OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - ago)
            .unwrap();
    }

    fn context_names(snapshot: &SyncSnapshot) -> Vec<&str> {
        snapshot
            .entries
            .iter()
            .map(|entry| entry.context_name.as_str())
            .collect()
    }

    const HOUR: Duration = Duration::from_secs(3600);

    #[test]
    fn an_unchanged_old_file_is_parsed_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, config_named("aaa")).unwrap();
        age(&path, HOUR);
        let mut worker = file_worker(&path);

        let first = worker.scan();
        let second = worker.scan();
        let third = worker.scan();

        assert_eq!(context_names(&first), ["aaa"]);
        assert_eq!(second, first);
        assert_eq!(third, first);
        assert_eq!(worker.cache.parses, 1);
    }

    #[test]
    fn a_file_written_just_now_is_parsed_on_every_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, config_named("aaa")).unwrap();
        let mut worker = file_worker(&path);

        worker.scan();
        worker.scan();

        // Its mtime is within 2 s of the scan, so a second write in the same timestamp tick
        // could not be told apart.
        assert_eq!(worker.cache.parses, 2);
    }

    #[test]
    fn a_rewrite_of_the_same_size_with_a_later_mtime_is_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, config_named("aaa")).unwrap();
        age(&path, HOUR);
        let mut worker = file_worker(&path);
        assert_eq!(context_names(&worker.scan()), ["aaa"]);

        let before = std::fs::metadata(&path).unwrap().len();
        std::fs::write(&path, config_named("bbb")).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), before);
        // Later than the first write, and old enough to be cached too.
        age(&path, HOUR / 2);

        assert_eq!(context_names(&worker.scan()), ["bbb"]);
        assert_eq!(worker.cache.parses, 2);
        assert_eq!(context_names(&worker.scan()), ["bbb"]);
        assert_eq!(worker.cache.parses, 2, "the new file is cached in turn");
    }

    #[test]
    fn the_flag_that_makes_a_source_explicit_is_part_of_the_key() {
        let dir = tempfile::tempdir().unwrap();
        // Not named like a kubeconfig, and with no kubeconfig content: only an explicit
        // source accepts it.
        let path = dir.path().join("notes");
        std::fs::write(&path, "just: notes\n").unwrap();
        age(&path, HOUR);
        let as_file = SyncSource::File(path.display().to_string());
        let as_dir = SyncSource::Dir(dir.path().display().to_string());
        let mut worker = worker_for(vec![as_dir]);
        worker.scan();
        worker.scan();
        assert_eq!(worker.cache.parses, 1);

        worker.sources = vec![as_file];
        worker.scan();
        assert_eq!(worker.cache.parses, 2, "the same bytes, read another way");
    }

    #[test]
    fn a_deleted_file_loses_its_entries_and_its_cache() {
        let dir = tempfile::tempdir().unwrap();
        for (name, context) in [("a", "aaa"), ("b", "bbb")] {
            let path = dir.path().join(name);
            std::fs::write(&path, config_named(context)).unwrap();
            age(&path, HOUR);
        }
        let mut worker = worker_for(vec![SyncSource::Dir(dir.path().display().to_string())]);
        assert_eq!(context_names(&worker.scan()), ["aaa", "bbb"]);
        assert_eq!(worker.cache.entries.len(), 2);

        std::fs::remove_file(dir.path().join("a")).unwrap();

        assert_eq!(context_names(&worker.scan()), ["bbb"]);
        assert_eq!(worker.cache.entries.len(), 1);
        assert!(!worker.cache.entries.contains_key(&dir.path().join("a")));
    }

    #[test]
    fn a_failure_is_not_cached_and_keeps_the_previous_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, config_named("aaa")).unwrap();
        age(&path, HOUR);
        let mut worker = file_worker(&path);
        assert_eq!(context_names(&worker.scan()), ["aaa"]);

        std::fs::write(&path, "kind: Config\nclusters: [unclosed\n").unwrap();
        age(&path, HOUR / 2);
        let broken = worker.scan();
        assert_eq!(
            context_names(&broken),
            ["aaa"],
            "the last good entries stay"
        );
        assert_eq!(broken.warnings.len(), 1);
        let parses = worker.cache.parses;

        let again = worker.scan();
        assert_eq!(again.warnings.len(), 1, "it warns on every scan");
        assert_eq!(worker.cache.parses, parses + 1, "and is read again");
    }

    // Unix only: it needs `chmod`, and a root user could read the file anyway.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_keeps_its_previous_entries_with_a_warning() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, config_named("aaa")).unwrap();
        age(&path, HOUR);
        let mut worker = file_worker(&path);
        assert_eq!(context_names(&worker.scan()), ["aaa"]);
        assert_eq!(worker.cache.parses, 1, "it is cached now");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_ok() {
            return;
        }
        let snapshot = worker.scan();

        assert_eq!(context_names(&snapshot), ["aaa"]);
        assert_eq!(snapshot.warnings.len(), 1, "{snapshot:?}");
        assert!(
            snapshot.warnings[0]
                .message
                .contains("could not read the file"),
            "{snapshot:?}"
        );
    }

    #[test]
    fn the_cache_does_not_trust_a_time_in_the_future() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, config_named("aaa")).unwrap();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() + HOUR)
            .unwrap();
        let mut worker = file_worker(&path);

        worker.scan();
        worker.scan();

        assert_eq!(worker.cache.parses, 2);
    }
}
