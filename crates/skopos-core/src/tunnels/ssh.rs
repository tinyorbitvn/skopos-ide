//! SSH tunnels (tunnels spec §6.2, §6.4, §6.5): one supervised `ssh -N -D` per running tunnel,
//! its askpass endpoint, reconnects with backoff while in use, and stopping when idle.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use tokio::net::TcpStream;
use tokio::process::{Child, ChildStderr, Command};
use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::askpass::{AskState, Refusal, PROMPT_CANCELLED, PROMPT_UNANSWERED};
use super::askpass_mode::{ASKPASS_ADDR_VAR, ASKPASS_TOKEN_VAR};
use super::http::authority;
use super::model::TunnelDef;
use super::port_owner::listener_is_ours;
use super::ssh_cmd::{
    check_version, classify_exit, exit_message, open_failure, ssh_args, ArgOptions, ExitKind,
    LogRing,
};
use super::state::TunnelState;
use super::timings::TunnelTimings;
use super::upstream::{DialError, ProxyUpstream, Stream};
use crate::app_core::{AppCore, CoreEvent, WeakCore};
use crate::process::{self, Output, ProcessSpec};
use crate::secrets::Secret;
use crate::tools::{find_on_path, is_executable};

/// Whether Windows `ssh.exe` gets the askpass bridge when `ssh -V` says 8.5 or later (spec
/// §6.5). The Windows CI job decides: `false` always runs it with `-o BatchMode=yes`, so any
/// prompt fails with `CANNOT_ASK`.
pub const WINDOWS_ASKPASS: bool = true;
/// How long a refused dial waits for the `open failed` line `ssh` writes (spec §6.2).
const OPEN_FAILURE_WAIT: Duration = Duration::from_millis(200);
/// A taken `-D` port starts `ssh` again at once, this many times in a row (spec §6.2).
const PORT_RETRIES: u32 = 3;
/// How often the supervisor looks whether `ssh` came up.
const UP_POLL: Duration = Duration::from_millis(100);
/// How long `ssh` gets to end after it is asked to.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// How long the stderr reader may lag behind an exit.
const STDERR_DRAIN: Duration = Duration::from_millis(500);
const VERSION_LIMIT: Duration = Duration::from_secs(10);
pub(crate) const SSH_MISSING: &str =
    "ssh was not found on PATH. Install OpenSSH or set its path in Preferences › Tools";
pub(crate) const STOPPED: &str = "The tunnel was stopped";

fn port_not_ours(port: u16) -> String {
    format!("Another user's program listens on 127.0.0.1:{port}, the tunnel's local port, so ssh was stopped")
}
const WAITS_FOR_ANSWER: &str = "a prompt waits for an answer";

/// Whether `ssh` runs with `-o BatchMode=yes`: on Windows, when the bridge is off or the
/// `ssh` is older than 8.5 (`check_version`). Elsewhere an old `ssh` fails instead.
pub(crate) fn ssh_batch(version: &Result<(), String>) -> bool {
    cfg!(windows) && (!WINDOWS_ASKPASS || version.is_err())
}

/// Who asks for the tunnel (spec §6.1, §6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    /// A connect, `Start` or `Test connection`: prompts open at once, a failed tunnel starts
    /// again, and a reconnect tries at once.
    Person,
    /// A connection through the gateway: never starts a failed tunnel again.
    Gateway,
}

/// What callers of `ssh_ensure_up` wait on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Phase {
    Starting,
    Up(u16),
    Reconnecting { attempt: u32, last_error: String },
    Failed(String),
    Stopped,
}

/// What tests change about how `ssh` runs.
#[derive(Debug, Clone, Default)]
pub struct SshTestHooks {
    /// Runs as `SSH_ASKPASS` instead of the app binary.
    pub askpass: Option<PathBuf>,
    /// Passed as `-F`, so tests never read `~/.ssh/config`.
    pub config_file: Option<PathBuf>,
    /// Added to the environment of `ssh` and of `ssh -V`.
    pub env: Vec<(OsString, OsString)>,
}

/// One running SSH tunnel.
pub(crate) struct Supervisor {
    generation: u64,
    stop: CancellationToken,
    ask: Arc<AskState>,
    phase: watch::Sender<Phase>,
    /// Ends a reconnect wait early: a person asked for the tunnel.
    kick: Notify,
    /// Set by every use since the idle check last looked, so a short connection between two
    /// checks still counts (spec §6.4).
    used: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
pub(crate) struct SshTunnels {
    running: DashMap<String, Arc<Supervisor>>,
    generation: AtomicU64,
    /// Each tunnel's stderr; it outlives the supervisor, so a failure's lines stay readable.
    logs: DashMap<String, Arc<Mutex<LogRing>>>,
    /// `ssh -V` outcomes, by program.
    versions: Mutex<HashMap<PathBuf, Result<(), String>>>,
    hooks: Mutex<SshTestHooks>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl SshTunnels {
    pub(crate) fn running(&self, id: &str) -> bool {
        self.running.contains_key(id)
    }

    fn is_current(&self, id: &str, generation: u64) -> bool {
        self.running
            .get(id)
            .is_some_and(|running| running.generation == generation)
    }

    fn log(&self, id: &str) -> Arc<Mutex<LogRing>> {
        self.logs.entry(id.to_owned()).or_default().clone()
    }

    pub(crate) fn log_lines(&self, id: &str) -> Vec<String> {
        self.logs
            .get(id)
            .map(|ring| lock(&ring).lines())
            .unwrap_or_default()
    }

    #[allow(dead_code)] // Used by the Test connection task.
    pub(crate) fn log_mark(&self, id: &str) -> u64 {
        self.logs.get(id).map_or(0, |ring| lock(&ring).pushed())
    }

    #[allow(dead_code)] // Used by the Test connection task.
    pub(crate) fn log_since(&self, id: &str, mark: u64) -> Vec<String> {
        self.logs
            .get(id)
            .map(|ring| lock(&ring).since(mark))
            .unwrap_or_default()
    }

    /// Ends the tunnel's `ssh` without waiting for it.
    pub(crate) fn cancel(&self, id: &str) {
        if let Some((_, supervisor)) = self.running.remove(id) {
            supervisor.stop.cancel();
            supervisor.phase.send_replace(Phase::Stopped);
        }
    }

    /// Forgets a deleted tunnel's `ssh` and its log.
    pub(crate) fn forget(&self, id: &str) {
        self.cancel(id);
        self.logs.remove(id);
    }
}

/// A free port on `127.0.0.1`: bound, then released for `ssh` (spec §6.2).
fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

/// How a supervisor ended.
enum End {
    Stopped,
    Idle,
    Failed(String),
}

/// How waiting for `ssh` to come up ended.
enum Started {
    Up,
    /// The port answers, but another user's program holds it (`port_owner`).
    PortTaken,
    Stopped,
    TimedOut,
    Exited(Option<i32>),
}

/// How an `ssh` that was up ended.
enum Held {
    Stopped,
    Idle,
    Exited(Option<i32>),
}

/// Moves the supervisor's phase and the tunnel's state together. A stopped or replaced
/// supervisor writes nothing: `Stop` wrote the state.
fn set(core: &WeakCore, supervisor: &Supervisor, id: &str, phase: Phase, state: TunnelState) {
    let Some(app) = core.upgrade() else { return };
    if !app
        .tunnel_runtime()
        .ssh
        .is_current(id, supervisor.generation)
    {
        return;
    }
    app.tunnel_set_state(id, state);
    supervisor.phase.send_replace(phase);
}

/// Reads `ssh`'s stderr into the tunnel's log until it closes.
async fn read_stderr(core: WeakCore, log: Arc<Mutex<LogRing>>, stderr: Option<ChildStderr>) {
    let Some(stderr) = stderr else { return };
    let (lines_tx, mut lines) = mpsc::channel(64);
    let reading = process::stream_lines(stderr, process::Stream::Stderr, lines_tx);
    let keeping = async {
        while let Some(line) = lines.recv().await {
            lock(&log).push(&line.bytes);
            if let Some(app) = core.upgrade() {
                app.emit(CoreEvent::TunnelsChanged);
            }
        }
    };
    tokio::join!(reading, keeping);
}

/// Waits until `127.0.0.1:<port>` accepts while `ssh` runs (spec §6.2). Time a prompt waits
/// for the person does not count.
async fn wait_up(
    child: &mut Child,
    port: u16,
    supervisor: &Supervisor,
    timings: &TunnelTimings,
) -> Started {
    let mut spent = Duration::ZERO;
    loop {
        tokio::select! {
            () = supervisor.stop.cancelled() => return Started::Stopped,
            status = child.wait() => {
                return Started::Exited(status.ok().and_then(|status| status.code()));
            }
            () = tokio::time::sleep(UP_POLL) => {}
        }
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return if listener_is_ours(port).await {
                Started::Up
            } else {
                Started::PortTaken
            };
        }
        if !supervisor.ask.waiting() {
            spent += UP_POLL;
        }
        if spent >= timings.start {
            return Started::TimedOut;
        }
    }
}

/// Runs while `ssh` is up: until it exits, the tunnel is stopped, or nothing used it for the
/// idle time (spec §6.4).
async fn hold_up(
    core: &WeakCore,
    id: &str,
    child: &mut Child,
    supervisor: &Supervisor,
    timings: &TunnelTimings,
) -> Held {
    let tick = (timings.idle / 3).clamp(Duration::from_millis(50), Duration::from_secs(30));
    let mut unused_since: Option<Instant> = None;
    loop {
        tokio::select! {
            () = supervisor.stop.cancelled() => return Held::Stopped,
            status = child.wait() => {
                return Held::Exited(status.ok().and_then(|status| status.code()));
            }
            () = tokio::time::sleep(tick) => {}
        }
        let Some(app) = core.upgrade() else {
            return Held::Stopped;
        };
        let used = supervisor.used.swap(false, Ordering::Relaxed);
        if used || app.tunnel_in_use(id) {
            unused_since = None;
        } else if unused_since.get_or_insert_with(Instant::now).elapsed() >= timings.idle {
            return Held::Idle;
        }
    }
}

/// Runs `ssh` for one tunnel until it is stopped, fails or goes idle.
async fn run_tunnel(core: &WeakCore, def: &TunnelDef, supervisor: &Arc<Supervisor>) -> End {
    let Some(app) = core.upgrade() else {
        return End::Stopped;
    };
    let program = match app.ssh_program() {
        Ok(program) => program,
        Err(message) => return End::Failed(message),
    };
    let version = app.ssh_version_ok(&program).await;
    let batch = ssh_batch(&version);
    if !batch {
        if let Err(message) = version {
            return End::Failed(message);
        }
    }
    let ask = if batch {
        None
    } else {
        match app
            .tunnel_ask_serve(supervisor.ask.clone(), supervisor.stop.clone())
            .await
        {
            Ok(served) => Some(served),
            Err(e) => return End::Failed(format!("cannot run ssh: {}", e.message)),
        }
    };
    let hooks = app.ssh_hooks();
    let log = app.tunnel_runtime().ssh.log(&def.id);
    let timings = app.tunnel_timings();
    drop(app);

    let mut was_up = false;
    let mut attempt: u32 = 0;
    let mut port_retries: u32 = 0;
    loop {
        supervisor.ask.new_run();
        let local_port = match free_port() {
            Ok(port) => port,
            Err(e) => return End::Failed(format!("cannot run ssh: {e}")),
        };
        let mark = lock(&log).pushed();
        let Some(app) = core.upgrade() else {
            return End::Stopped;
        };
        let spawned = app
            .ssh_command(&program, def, local_port, ask.as_ref(), &hooks)
            .and_then(|mut command| command.spawn().map_err(|e| format!("cannot run ssh: {e}")));
        drop(app);
        let mut child = match spawned {
            Ok(child) => child,
            Err(message) => return End::Failed(message),
        };
        // The job holds `ssh` and what it starts, such as the `-J` hop (spec §6.2).
        #[cfg(windows)]
        let _job = process::JobGuard::contain(&child).ok();
        let reader = tokio::spawn(read_stderr(core.clone(), log.clone(), child.stderr.take()));

        let code = match wait_up(&mut child, local_port, supervisor, &timings).await {
            Started::Up => {
                was_up = true;
                attempt = 0;
                port_retries = 0;
                // Prompts of a later reconnect wait for the person instead of opening.
                supervisor.ask.set_at_once(false);
                set(
                    core,
                    supervisor,
                    &def.id,
                    Phase::Up(local_port),
                    TunnelState::up_now(),
                );
                match hold_up(core, &def.id, &mut child, supervisor, &timings).await {
                    Held::Stopped => {
                        process::stop(&mut child, STOP_GRACE).await;
                        return End::Stopped;
                    }
                    Held::Idle => {
                        process::stop(&mut child, STOP_GRACE).await;
                        return End::Idle;
                    }
                    Held::Exited(code) => Some(code),
                }
            }
            Started::Stopped => {
                process::stop(&mut child, STOP_GRACE).await;
                return End::Stopped;
            }
            Started::PortTaken => {
                // Never the person's traffic to that program: `ssh` starts again on a new port.
                process::stop(&mut child, STOP_GRACE).await;
                let _ = tokio::time::timeout(STDERR_DRAIN, reader).await;
                if port_retries < PORT_RETRIES {
                    port_retries += 1;
                    continue;
                }
                return End::Failed(port_not_ours(local_port));
            }
            Started::TimedOut => {
                process::stop(&mut child, STOP_GRACE).await;
                None
            }
            Started::Exited(code) => Some(code),
        };
        let _ = tokio::time::timeout(STDERR_DRAIN, reader).await;
        let lines = lock(&log).since(mark);
        let (kind, message) = match (code, supervisor.ask.refusal()) {
            (None, _) => (
                ExitKind::Dropped,
                format!("ssh did not come up within {} s", timings.start.as_secs()),
            ),
            (Some(_), Some(Refusal::Unanswered)) => (ExitKind::Fatal, PROMPT_UNANSWERED.to_owned()),
            (Some(code), Some(Refusal::Cancelled)) => {
                let message = if lines.iter().any(|line| !line.trim().is_empty()) {
                    exit_message(&lines, code, batch)
                } else {
                    PROMPT_CANCELLED.to_owned()
                };
                (ExitKind::Fatal, message)
            }
            (Some(code), None) => (classify_exit(&lines), exit_message(&lines, code, batch)),
        };
        match kind {
            ExitKind::Fatal => return End::Failed(message),
            ExitKind::PortTaken if port_retries < PORT_RETRIES => {
                port_retries += 1;
                continue;
            }
            ExitKind::PortTaken | ExitKind::Dropped => {}
        }
        // A start that never came up fails: a mistyped host is not retried forever.
        if !was_up {
            return End::Failed(message);
        }
        let Some(app) = core.upgrade() else {
            return End::Stopped;
        };
        let in_use = app.tunnel_in_use(&def.id);
        drop(app);
        if !in_use {
            return End::Idle;
        }
        attempt += 1;
        set(
            core,
            supervisor,
            &def.id,
            Phase::Reconnecting {
                attempt,
                last_error: message.clone(),
            },
            TunnelState::Reconnecting {
                attempt,
                last_error: message,
            },
        );
        tokio::select! {
            () = supervisor.stop.cancelled() => return End::Stopped,
            () = supervisor.kick.notified() => {}
            () = tokio::time::sleep(timings.backoff_for(attempt)) => {}
        }
    }
}

/// The supervisor's task.
async fn supervise(core: WeakCore, def: TunnelDef, supervisor: Arc<Supervisor>) {
    let end = run_tunnel(&core, &def, &supervisor).await;
    if let Some(app) = core.upgrade() {
        app.ssh_finish(&def.id, &supervisor, end);
    }
    // Ends the askpass endpoint and anything else hanging off this run.
    supervisor.stop.cancel();
}

impl AppCore {
    /// Dials `host:port` through the tunnel's `ssh -D`: SOCKS5 without authentication, the
    /// name resolved on the far side (spec §6.2). A refusal carries the far side's reason.
    pub(crate) async fn ssh_dial(
        &self,
        def: &TunnelDef,
        host: &str,
        port: u16,
        origin: Origin,
    ) -> Result<Box<dyn Stream>, DialError> {
        let local = self.ssh_ensure_up(def, origin).await?;
        let ssh = &self.tunnel_runtime().ssh;
        let mark = ssh.log_mark(&def.id);
        let upstream = ProxyUpstream::new(&format!("socks5://127.0.0.1:{local}"), None)?;
        match upstream.dial(host, port).await {
            Ok(stream) => Ok(stream),
            Err(DialError::TimedOut) => Err(DialError::TimedOut),
            Err(_) => {
                let target = authority(host, port);
                let started = Instant::now();
                loop {
                    let reason = ssh
                        .log_since(&def.id, mark)
                        .iter()
                        .find_map(|line| open_failure(line).map(str::to_owned));
                    if let Some(reason) = reason {
                        return Err(DialError::Failed(format!(
                            "ssh could not open {target}: {reason}"
                        )));
                    }
                    if started.elapsed() >= OPEN_FAILURE_WAIT {
                        return Err(DialError::Failed(format!("ssh could not open {target}")));
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        }
    }

    pub fn set_ssh_test_hooks(&self, hooks: SshTestHooks) {
        *lock(&self.tunnel_runtime().ssh.hooks) = hooks;
    }

    fn ssh_hooks(&self) -> SshTestHooks {
        lock(&self.tunnel_runtime().ssh.hooks).clone()
    }

    /// The `ssh` to run: Preferences › Tools, else `ssh` on `PATH` (spec §6.1).
    fn ssh_program(&self) -> Result<PathBuf, String> {
        if let Some(path) = self.prefs_get().ssh_path {
            let program = PathBuf::from(&path);
            if program.is_absolute() && is_executable(&program) {
                return Ok(program);
            }
            return Err(format!(
                "{path} is not a program. Fix the ssh path in Preferences › Tools"
            ));
        }
        find_on_path("ssh", self.tools().search_path().as_deref())
            .ok_or_else(|| SSH_MISSING.to_owned())
    }

    /// `ssh -V`, once per program (spec §6.5).
    async fn ssh_version_ok(&self, program: &Path) -> Result<(), String> {
        let known = lock(&self.tunnel_runtime().ssh.versions)
            .get(program)
            .cloned();
        if let Some(known) = known {
            return known;
        }
        let mut spec = ProcessSpec::new(program, ["-V"], VERSION_LIMIT);
        spec.env = self.ssh_hooks().env;
        let output = Output::Capture {
            stdout_limit: 4096,
            stderr_limit: 4096,
        };
        let outcome = match process::run(spec, output, CancellationToken::new()).await {
            Ok(output) => check_version(&format!(
                "{}{}",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&output.stdout)
            )),
            Err(e) => Err(e.to_string()),
        };
        lock(&self.tunnel_runtime().ssh.versions).insert(program.to_owned(), outcome.clone());
        outcome
    }

    /// `ssh` for one run: an argument array, never a shell (T5); stdin null, stderr piped.
    fn ssh_command(
        &self,
        program: &Path,
        def: &TunnelDef,
        local_port: u16,
        ask: Option<&(String, Secret)>,
        hooks: &SshTestHooks,
    ) -> Result<Command, String> {
        let fields = def
            .kind
            .ssh_fields()
            .ok_or_else(|| "this tunnel is not an SSH tunnel".to_owned())?;
        let options = ArgOptions {
            local_port,
            batch: ask.is_none(),
            config_file: hooks.config_file.as_deref(),
        };
        let mut command = Command::new(program);
        command.args(ssh_args(&fields, &options));
        process::configure_agent(&mut command);
        command.stdin(Stdio::null()).stdout(Stdio::null());
        if let Some((addr, token)) = ask {
            let askpass = match &hooks.askpass {
                Some(path) => path.clone(),
                None => std::env::current_exe()
                    .map_err(|e| format!("cannot find the app binary: {e}"))?,
            };
            command
                .env("SSH_ASKPASS", askpass)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env(ASKPASS_ADDR_VAR, addr)
                .env(ASKPASS_TOKEN_VAR, token.expose());
        }
        command.envs(hooks.env.iter().map(|(key, value)| (key, value)));
        Ok(command)
    }

    /// Starts the tunnel's `ssh` if it is not running and waits until it is up; gives the
    /// `-D` port (spec §6.2, §6.4).
    pub(crate) async fn ssh_ensure_up(
        &self,
        def: &TunnelDef,
        origin: Origin,
    ) -> Result<u16, DialError> {
        let running = self
            .tunnel_runtime()
            .ssh
            .running
            .get(&def.id)
            .map(|entry| entry.value().clone());
        let supervisor = match running {
            Some(supervisor) => supervisor,
            None => {
                if origin == Origin::Gateway {
                    // Only a person starts a failed tunnel again (a wrong password would lock
                    // the account).
                    if let TunnelState::Failed { message } = self.tunnel_state(&def.id) {
                        return Err(DialError::Failed(message));
                    }
                }
                self.ssh_start(def, origin)
            }
        };
        supervisor.used.store(true, Ordering::Relaxed);
        if origin == Origin::Person {
            supervisor.ask.set_at_once(true);
            if self.tunnel_runtime().prompts.open_at_once(&def.id) {
                self.emit(CoreEvent::TunnelsChanged);
            }
        }
        self.ssh_wait(&def.id, &supervisor, origin).await
    }

    fn ssh_start(&self, def: &TunnelDef, origin: Origin) -> Arc<Supervisor> {
        let runtime = self.tunnel_runtime();
        let supervisor = Arc::new(Supervisor {
            generation: runtime.ssh.generation.fetch_add(1, Ordering::Relaxed) + 1,
            stop: runtime.shutdown_child(),
            ask: AskState::new(&def.id, origin == Origin::Person),
            phase: watch::channel(Phase::Starting).0,
            kick: Notify::new(),
            used: AtomicBool::new(false),
            task: Mutex::new(None),
        });
        match runtime.ssh.running.entry(def.id.clone()) {
            // Another caller started it a moment ago.
            Entry::Occupied(running) => return running.get().clone(),
            Entry::Vacant(free) => {
                free.insert(supervisor.clone());
            }
        }
        // The map's lock is released here: the state reads it.
        self.tunnel_set_state(&def.id, TunnelState::Starting);
        let task = tokio::spawn(supervise(self.downgrade(), def.clone(), supervisor.clone()));
        *lock(&supervisor.task) = Some(task);
        supervisor
    }

    async fn ssh_wait(
        &self,
        id: &str,
        supervisor: &Supervisor,
        origin: Origin,
    ) -> Result<u16, DialError> {
        let mut phase = supervisor.phase.subscribe();
        let mut first_attempt: Option<u32> = None;
        let mut stalled_since: Option<Instant> = None;
        let wait = self.tunnel_timings().reconnect_wait;
        loop {
            let now = phase.borrow_and_update().clone();
            match now {
                Phase::Up(port) => return Ok(port),
                Phase::Failed(message) => return Err(DialError::Failed(message)),
                Phase::Stopped => return Err(DialError::Failed(STOPPED.to_owned())),
                Phase::Starting => {}
                Phase::Reconnecting {
                    attempt,
                    last_error,
                } if origin == Origin::Person => match first_attempt {
                    // Try at once instead of after the backoff, and wait for that attempt.
                    None => {
                        first_attempt = Some(attempt);
                        supervisor.kick.notify_one();
                    }
                    Some(seen) if attempt > seen => {
                        return Err(DialError::Reconnecting(last_error));
                    }
                    Some(_) => {}
                },
                Phase::Reconnecting { .. } => {}
            }
            if origin == Origin::Gateway {
                // During `Reconnecting` or `NeedsInput` a connection waits up to
                // `reconnect_wait`, then gets 503 (spec §6.4).
                let state = self.tunnel_state(id);
                let stalled = matches!(
                    state,
                    TunnelState::Reconnecting { .. } | TunnelState::NeedsInput { .. }
                );
                if stalled && stalled_since.get_or_insert_with(Instant::now).elapsed() >= wait {
                    let last = match state {
                        TunnelState::Reconnecting { last_error, .. } => last_error,
                        _ => WAITS_FOR_ANSWER.to_owned(),
                    };
                    return Err(DialError::Reconnecting(last));
                }
                tokio::select! {
                    changed = phase.changed() => {
                        if changed.is_err() {
                            return Err(DialError::Failed(STOPPED.to_owned()));
                        }
                    }
                    () = tokio::time::sleep(UP_POLL) => {}
                }
            } else if phase.changed().await.is_err() {
                return Err(DialError::Failed(STOPPED.to_owned()));
            }
        }
    }

    /// Writes how the supervisor ended, unless `Stop` replaced it.
    fn ssh_finish(&self, id: &str, supervisor: &Supervisor, end: End) {
        let runtime = self.tunnel_runtime();
        if !runtime.ssh.is_current(id, supervisor.generation) {
            return;
        }
        let (phase, state) = match end {
            End::Stopped | End::Idle => (Phase::Stopped, TunnelState::Idle),
            End::Failed(message) => (
                Phase::Failed(message.clone()),
                TunnelState::Failed { message },
            ),
        };
        self.tunnel_set_state(id, state);
        supervisor.phase.send_replace(phase);
        runtime
            .ssh
            .running
            .remove_if(id, |_, running| running.generation == supervisor.generation);
        runtime.prompts.clear_tunnel(id);
        self.emit(CoreEvent::TunnelsChanged);
    }

    /// Ends the tunnel's `ssh` and waits until it is gone.
    pub(crate) async fn ssh_stop(&self, id: &str) {
        let runtime = self.tunnel_runtime();
        let Some((_, supervisor)) = runtime.ssh.running.remove(id) else {
            return;
        };
        supervisor.stop.cancel();
        supervisor.phase.send_replace(Phase::Stopped);
        runtime.prompts.clear_tunnel(id);
        let task = lock(&supervisor.task).take();
        if let Some(task) = task {
            let _ = tokio::time::timeout(STOP_GRACE * 3, task).await;
        }
    }

    /// Quitting stops every tunnel (spec §6.2), all at once so quitting waits at most one
    /// `ssh`'s grace.
    #[allow(dead_code)] // Used when the app quits, in a later task.
    pub(crate) async fn ssh_stop_all(&self) {
        let ids: Vec<String> = self
            .tunnel_runtime()
            .ssh
            .running
            .iter()
            .map(|entry| entry.key().clone())
            .collect();
        futures::future::join_all(ids.iter().map(|id| self.ssh_stop(id))).await;
    }
}
