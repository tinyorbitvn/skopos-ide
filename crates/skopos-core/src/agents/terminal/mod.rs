//! The Agent terminals of a chat (native agents spec §5): per cluster, the commands the agent
//! runs with `run_in_terminal`, one at a time, each in a PTY of its own, and the scrollback the
//! dock tab `Agent · <cluster>` shows.

pub(crate) mod output;
pub(crate) mod process;
pub(crate) mod shell;

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use self::output::OutputTail;
use self::process::{CommandSpec, Spawned};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::sessions::{
    spawn_writer, FlowControl, Master, SessionEvent, SessionOutput, TerminalSize,
};

/// The card shows this many of the newest lines.
pub(crate) const CARD_LINES: usize = 20;
/// While a command runs, its card's lines are sent again at most this often.
const CARD_REFRESH: Duration = Duration::from_millis(500);
/// Raw output kept for a tab that opens late.
const SCROLLBACK_LIMIT: usize = 256 * 1024;
/// The size commands get until a tab says its own.
const DEFAULT_SIZE: TerminalSize = TerminalSize {
    cols: 120,
    rows: 30,
};
const READ_CHUNK: usize = 16 * 1024;
const INPUT_BACKLOG: usize = 64;
/// How long output may still come after the process ended.
const DRAIN_LIMIT: Duration = Duration::from_secs(2);
/// How long a stopped process has to end.
const KILL_LIMIT: Duration = Duration::from_secs(5);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Why a command was stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stop {
    /// The card's Stop, or the person closed the tab.
    Person,
    /// The chat stopped or closed, or the agent's call went away.
    Chat,
    /// The cluster was disconnected.
    Disconnected,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RunEnd {
    Exited(u32),
    TimedOut,
    Stopped(Stop),
    Failed(String),
}

pub(crate) struct RunResult {
    pub(crate) end: RunEnd,
    /// For the agent: plain text, the last 64 KiB.
    pub(crate) text: String,
    /// For the card: the last `CARD_LINES` lines.
    pub(crate) lines: String,
}

pub(crate) struct RunRequest {
    /// The change card of the command, which its Stop names.
    pub(crate) card_id: String,
    /// As the agent wrote it, for the tab's `$ ` line.
    pub(crate) command: String,
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) kubeconfig: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(crate) path: Option<OsString>,
    pub(crate) timeout: Duration,
    /// The cluster's token: a disconnect stops the command.
    pub(crate) cluster: CancellationToken,
    /// Checked again once the command holds the terminal, just before it starts: while it
    /// waited for an answer or its turn, the person may have turned the terminal off, picked
    /// Read only, or the cluster may have gone. An error ends the command unstarted.
    pub(crate) recheck: Box<dyn FnOnce() -> Result<(), String> + Send + Sync>,
}

/// The Agent terminals of one chat, one per cluster.
#[derive(Default)]
pub struct AgentTerminals {
    terminals: Mutex<HashMap<ClusterId, Arc<AgentTerminal>>>,
}

impl AgentTerminals {
    pub fn new() -> Arc<AgentTerminals> {
        Arc::default()
    }

    pub(crate) fn get(&self, id: &ClusterId) -> Arc<AgentTerminal> {
        lock(&self.terminals)
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AgentTerminal::new()))
            .clone()
    }

    fn all(&self) -> Vec<Arc<AgentTerminal>> {
        lock(&self.terminals).values().cloned().collect()
    }

    /// Stops the command of the card `card_id`, as the person's Stop. Whether one ran.
    pub fn stop_card(&self, card_id: &str) -> bool {
        self.all()
            .iter()
            .any(|terminal| terminal.stop_card(card_id, Stop::Person))
    }

    /// Stops every running command, as the chat's Stop.
    pub fn stop_all(&self) {
        for terminal in self.all() {
            terminal.stop_running(Stop::Chat);
        }
    }
}

/// Where a tab takes the output.
#[derive(Clone)]
struct Sink {
    session: String,
    output: mpsc::Sender<SessionOutput>,
    flow: Arc<FlowControl>,
    /// The tab's session, ended when a newer tab takes its place.
    token: CancellationToken,
}

struct Running {
    card_id: String,
    stop: CancellationToken,
    reason: Arc<OnceLock<Stop>>,
    input: mpsc::Sender<Vec<u8>>,
    resize: watch::Sender<TerminalSize>,
}

struct Screen {
    scrollback: VecDeque<u8>,
    /// Whether the last byte printed ended a line.
    at_line_start: bool,
    size: TerminalSize,
    sink: Option<Sink>,
    running: Option<Running>,
}

pub(crate) struct AgentTerminal {
    /// Held while a command runs: one at a time (spec §5.3).
    turn: tokio::sync::Mutex<()>,
    /// Commands that wait for the turn, or hold it but have not shown as running yet, so that
    /// a Stop reaches them too.
    queued: Mutex<Vec<Queued>>,
    screen: Mutex<Screen>,
}

struct Queued {
    card_id: String,
    stop: CancellationToken,
    reason: Arc<OnceLock<Stop>>,
}

/// Stops the command when the run is dropped before its end, because the agent's call went
/// away, and takes it off the terminal.
struct StopOnDrop {
    terminal: Arc<AgentTerminal>,
    card_id: String,
    stop: CancellationToken,
    reason: Arc<OnceLock<Stop>>,
    armed: bool,
}

/// Takes the command off the queue when the run ends by any path.
struct QueueEntry {
    terminal: Arc<AgentTerminal>,
    card_id: String,
}

impl Drop for QueueEntry {
    fn drop(&mut self) {
        self.terminal.unqueue(&self.card_id);
    }
}

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.reason.set(Stop::Chat);
            self.stop.cancel();
            self.terminal.clear_running(&self.card_id);
        }
    }
}

/// The tab's line for a command: `$ ` and the command, its later lines after `> `.
fn command_line(command: &str) -> String {
    let shown = command.replace("\r\n", "\n").replace('\n', "\r\n> ");
    format!("\x1b[1m$ {shown}\x1b[0m\r\n")
}

fn end_line(end: &RunEnd) -> String {
    let text = match end {
        RunEnd::Exited(code) => format!("exit {code}"),
        RunEnd::TimedOut => "timed out".to_owned(),
        RunEnd::Stopped(_) => "stopped".to_owned(),
        RunEnd::Failed(message) => message.clone(),
    };
    format!("\x1b[2m{text}\x1b[0m\r\n")
}

impl AgentTerminal {
    pub(crate) fn new() -> AgentTerminal {
        AgentTerminal {
            turn: tokio::sync::Mutex::new(()),
            queued: Mutex::new(Vec::new()),
            screen: Mutex::new(Screen {
                scrollback: VecDeque::new(),
                at_line_start: true,
                size: DEFAULT_SIZE,
                sink: None,
                running: None,
            }),
        }
    }

    fn screen(&self) -> MutexGuard<'_, Screen> {
        lock(&self.screen)
    }

    /// Adds `data` to the scrollback and gives the tab to send it to, if one is attached.
    fn record(&self, data: &[u8]) -> Option<Sink> {
        let mut screen = self.screen();
        screen.scrollback.extend(data);
        let over = screen.scrollback.len().saturating_sub(SCROLLBACK_LIMIT);
        screen.scrollback.drain(..over);
        if let Some(&last) = data.last() {
            screen.at_line_start = last == b'\n';
        }
        screen.sink.clone()
    }

    /// Prints a line of the terminal's own, on a line of its own. A tab that does not take it
    /// within `DRAIN_LIMIT` misses it live; the scrollback keeps it.
    async fn line(&self, text: &str) {
        let fresh = self.screen().at_line_start;
        let data = if fresh {
            text.as_bytes().to_vec()
        } else {
            format!("\r\n{text}").into_bytes()
        };
        if let Some(sink) = self.record(&data) {
            let sent = tokio::time::timeout(DRAIN_LIMIT, async {
                sink.flow.ready().await;
                sink.flow.sent(data.len() as u64);
                sink.output.send(SessionOutput::Data(data)).await.is_ok()
            })
            .await;
            if matches!(sent, Ok(false)) {
                self.detach(&sink.session);
            }
        }
    }

    /// Takes the card `card_id` off the terminal, when it is the one that runs.
    fn clear_running(&self, card_id: &str) {
        let mut screen = self.screen();
        if screen
            .running
            .as_ref()
            .is_some_and(|running| running.card_id == card_id)
        {
            screen.running = None;
        }
    }

    /// Ends the tab `session` takes output from, when it is still the attached one. Whether it
    /// was.
    pub(crate) fn detach(&self, session: &str) -> bool {
        let mut screen = self.screen();
        if screen
            .sink
            .as_ref()
            .is_some_and(|sink| sink.session == session)
        {
            if let Some(sink) = screen.sink.take() {
                sink.flow.release();
            }
            return true;
        }
        false
    }

    /// Makes a tab the terminal's screen: `Started`, the scrollback, then what comes. A tab
    /// attached before is ended, without stopping the command. Under the lock, so that no
    /// live output can overtake the scrollback.
    pub(crate) fn attach(
        &self,
        session: &str,
        output: mpsc::Sender<SessionOutput>,
        flow: Arc<FlowControl>,
        token: CancellationToken,
    ) -> CoreResult<()> {
        let mut screen = self.screen();
        if let Some(old) = screen.sink.take() {
            old.flow.release();
            old.token.cancel();
        }
        let full = |_| {
            IpcError::new(
                ErrorCode::Internal,
                "The terminal could not start: its output is full.",
            )
        };
        output
            .try_send(SessionOutput::Event(SessionEvent::Started { tty: true }))
            .map_err(full)?;
        let scrollback: Vec<u8> = screen.scrollback.iter().copied().collect();
        if !scrollback.is_empty() {
            flow.sent(scrollback.len() as u64);
            output
                .try_send(SessionOutput::Data(scrollback))
                .map_err(full)?;
        }
        screen.sink = Some(Sink {
            session: session.to_owned(),
            output,
            flow,
            token,
        });
        Ok(())
    }

    /// The person's input, for the running command. Without one it is dropped.
    pub(crate) fn write(&self, data: Vec<u8>) {
        if let Some(running) = &self.screen().running {
            let _ = running.input.try_send(data);
        }
    }

    /// The tab's size, for the running command and the next ones.
    pub(crate) fn resize(&self, size: TerminalSize) {
        let mut screen = self.screen();
        screen.size = size;
        if let Some(running) = &screen.running {
            running.resize.send_replace(size);
        }
    }

    #[cfg(test)]
    pub(crate) fn running_card(&self) -> Option<String> {
        self.screen()
            .running
            .as_ref()
            .map(|running| running.card_id.clone())
    }

    /// Stops the running command and every command queued behind it.
    pub(crate) fn stop_running(&self, reason: Stop) {
        if let Some(running) = &self.screen().running {
            let _ = running.reason.set(reason);
            running.stop.cancel();
        }
        for queued in lock(&self.queued).iter() {
            let _ = queued.reason.set(reason);
            queued.stop.cancel();
        }
    }

    /// Stops the command of the card, running or still queued.
    pub(crate) fn stop_card(&self, card_id: &str, reason: Stop) -> bool {
        if let Some(running) = &self.screen().running {
            if running.card_id == card_id {
                let _ = running.reason.set(reason);
                running.stop.cancel();
                return true;
            }
        }
        match lock(&self.queued)
            .iter()
            .find(|queued| queued.card_id == card_id)
        {
            Some(queued) => {
                let _ = queued.reason.set(reason);
                queued.stop.cancel();
                true
            }
            None => false,
        }
    }

    fn unqueue(&self, card_id: &str) {
        lock(&self.queued).retain(|queued| queued.card_id != card_id);
    }

    /// Waits for the command before it, then runs this one. `lines` gets the card's last lines
    /// at most every `CARD_REFRESH` while it runs.
    pub(crate) async fn run(
        self: &Arc<Self>,
        mut request: RunRequest,
        lines: watch::Sender<String>,
    ) -> RunResult {
        let stop = request.cluster.child_token();
        let reason: Arc<OnceLock<Stop>> = Arc::new(OnceLock::new());
        lock(&self.queued).push(Queued {
            card_id: request.card_id.clone(),
            stop: stop.clone(),
            reason: reason.clone(),
        });
        let _queue_entry = QueueEntry {
            terminal: self.clone(),
            card_id: request.card_id.clone(),
        };
        let _turn = tokio::select! {
            biased;
            () = stop.cancelled() => return Self::stopped_before_start(&reason),
            turn = self.turn.lock() => turn,
        };
        if stop.is_cancelled() {
            return Self::stopped_before_start(&reason);
        }
        let recheck = std::mem::replace(&mut request.recheck, Box::new(|| Ok(())));
        if let Err(message) = recheck() {
            return RunResult {
                end: RunEnd::Failed(message),
                text: String::new(),
                lines: String::new(),
            };
        }
        self.line(&command_line(&request.command)).await;
        let mut guard = StopOnDrop {
            terminal: self.clone(),
            card_id: request.card_id.clone(),
            stop: stop.clone(),
            reason: reason.clone(),
            armed: true,
        };
        let size = self.screen().size;
        let spec = CommandSpec {
            program: request.program.clone(),
            args: request.args.clone(),
            kubeconfig: request.kubeconfig.clone(),
            cwd: request.cwd.clone(),
            path: request.path.clone(),
            size,
        };
        if stop.is_cancelled() {
            guard.armed = false;
            return Self::stopped_before_start(&reason);
        }
        let spawned = match tokio::task::spawn_blocking(move || process::spawn(&spec)).await {
            Ok(Ok(spawned)) => spawned,
            Ok(Err(message)) => return self.failed(&mut guard, message).await,
            Err(error) => return self.failed(&mut guard, process::start_error(error)).await,
        };
        let Spawned {
            master,
            reader,
            writer,
            child,
        } = spawned;
        let (input, input_rx) = mpsc::channel(INPUT_BACKLOG);
        spawn_writer(writer, input_rx);
        let (resize, mut resize_rx) = watch::channel(size);
        self.screen().running = Some(Running {
            card_id: request.card_id.clone(),
            stop: stop.clone(),
            reason: reason.clone(),
            input: input.clone(),
            resize,
        });
        // From here a Stop finds the command as running. One that came before ends it now.
        self.unqueue(&request.card_id);
        let tail = Arc::new(Mutex::new(OutputTail::default()));
        let fresh = Arc::new(AtomicBool::new(false));
        let reader_done = self.spawn_reader(reader, tail.clone(), fresh.clone(), input);
        let mut exit = process::spawn_waiter(child, stop.clone());
        let master = Master::new(master);
        let deadline = tokio::time::sleep(request.timeout);
        tokio::pin!(deadline);
        let mut refresh = tokio::time::interval(CARD_REFRESH);
        let end = loop {
            tokio::select! {
                // A stop wins over an exit that is ready too, since the stop caused that exit.
                biased;
                () = stop.cancelled() => {
                    let _ = tokio::time::timeout(KILL_LIMIT, &mut exit).await;
                    break RunEnd::Stopped(reason.get().copied().unwrap_or(Stop::Disconnected));
                }
                code = &mut exit => break match code {
                    Ok(Some(code)) => RunEnd::Exited(code),
                    _ => RunEnd::Failed("The command ended without an exit code.".to_owned()),
                },
                () = &mut deadline => {
                    stop.cancel();
                    let _ = tokio::time::timeout(KILL_LIMIT, &mut exit).await;
                    break RunEnd::TimedOut;
                }
                _ = refresh.tick() => {
                    if fresh.swap(false, Ordering::SeqCst) {
                        lines.send_replace(lock(&tail).last_lines(CARD_LINES));
                    }
                }
                changed = resize_rx.changed() => {
                    if changed.is_ok() {
                        let size = *resize_rx.borrow_and_update();
                        master.resize(size);
                    }
                }
            }
        };
        guard.armed = false;
        self.clear_running(&request.card_id);
        // Closing lets the reader see the end of the output.
        drop(master);
        let _ = tokio::time::timeout(DRAIN_LIMIT, reader_done).await;
        self.line(&end_line(&end)).await;
        let tail = lock(&tail);
        RunResult {
            end,
            text: tail.agent_text(),
            lines: tail.last_lines(CARD_LINES),
        }
    }

    fn stopped_before_start(reason: &OnceLock<Stop>) -> RunResult {
        RunResult {
            end: RunEnd::Stopped(reason.get().copied().unwrap_or(Stop::Chat)),
            text: String::new(),
            lines: String::new(),
        }
    }

    async fn failed(&self, guard: &mut StopOnDrop, message: String) -> RunResult {
        guard.armed = false;
        let end = RunEnd::Failed(message);
        self.line(&end_line(&end)).await;
        RunResult {
            end,
            text: String::new(),
            lines: String::new(),
        }
    }

    /// Reads until the PTY closes, into the agent's tail, the scrollback and the tab. Answers a
    /// Windows pseudoconsole's first cursor query itself, so a command never waits for a tab.
    fn spawn_reader(
        self: &Arc<Self>,
        mut reader: Box<dyn Read + Send>,
        tail: Arc<Mutex<OutputTail>>,
        fresh: Arc<AtomicBool>,
        input: mpsc::Sender<Vec<u8>>,
    ) -> oneshot::Receiver<()> {
        let terminal = self.clone();
        let handle = Handle::current();
        let (done, done_rx) = oneshot::channel();
        std::thread::spawn(move || {
            let mut chunk = vec![0; READ_CHUNK];
            let mut answered = !cfg!(windows);
            loop {
                let count = match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                let mut data = chunk[..count].to_vec();
                if !answered {
                    if let Some(rest) = output::without_cursor_query(&data) {
                        answered = true;
                        let _ = input.blocking_send(output::CURSOR_ANSWER.to_vec());
                        data = rest;
                    }
                }
                if data.is_empty() {
                    continue;
                }
                lock(&tail).push(&data);
                fresh.store(true, Ordering::SeqCst);
                if let Some(sink) = terminal.record(&data) {
                    handle.block_on(sink.flow.ready());
                    sink.flow.sent(data.len() as u64);
                    if sink
                        .output
                        .blocking_send(SessionOutput::Data(data))
                        .is_err()
                    {
                        terminal.detach(&sink.session);
                    }
                }
            }
            let _ = done.send(());
        });
        done_rx
    }

    #[cfg(test)]
    fn scrollback_text(&self) -> String {
        let bytes: Vec<u8> = self.screen().scrollback.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Only the flood test reads it, and that test runs on Unix only.
    #[cfg(all(test, unix))]
    fn scrollback_len(&self) -> usize {
        self.screen().scrollback.len()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    fn script(unix: &str, windows: &str) -> String {
        if cfg!(windows) { windows } else { unix }.to_owned()
    }

    fn request(folder: &std::path::Path, card: &str, command: &str, seconds: u64) -> RunRequest {
        let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
        let (program, args) = shell::shell_command(shell, command, cfg!(windows));
        RunRequest {
            card_id: card.to_owned(),
            command: command.to_owned(),
            program,
            args,
            kubeconfig: folder.join("kubeconfig"),
            cwd: folder.to_path_buf(),
            path: None,
            timeout: Duration::from_secs(seconds),
            cluster: CancellationToken::new(),
            recheck: Box::new(|| Ok(())),
        }
    }

    async fn run(terminal: &Arc<AgentTerminal>, request: RunRequest) -> RunResult {
        let (lines, _) = watch::channel(String::new());
        terminal.run(request, lines).await
    }

    /// Waits until the terminal runs the card `card`.
    async fn running(terminal: &AgentTerminal, card: &str) {
        let start = Instant::now();
        while terminal.running_card().as_deref() != Some(card) {
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "{card} never ran"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Collects a sink's data until it contains `wanted`.
    async fn read_until(
        rx: &mut mpsc::Receiver<SessionOutput>,
        flow: &FlowControl,
        wanted: &str,
    ) -> String {
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            while !output::plain_text(&text).contains(wanted) {
                match rx.recv().await {
                    Some(SessionOutput::Data(data)) => {
                        flow.acked(data.len() as u64);
                        text.push_str(&String::from_utf8_lossy(&data));
                    }
                    Some(SessionOutput::Event(_)) => {}
                    None => panic!("the sink closed before {wanted:?}: {text:?}"),
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{wanted:?} never came: {text:?}"));
        output::plain_text(&text)
    }

    #[tokio::test]
    async fn a_tab_gets_the_scrollback_first_then_live_output() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        run(
            &terminal,
            request(folder.path(), "k1", "echo first-run", 30),
        )
        .await;
        let (tx, mut rx) = mpsc::channel(32);
        let flow = Arc::new(FlowControl::new());
        terminal
            .attach("s1", tx, flow.clone(), CancellationToken::new())
            .unwrap();
        assert!(matches!(
            rx.recv().await,
            Some(SessionOutput::Event(SessionEvent::Started { tty: true }))
        ));
        let replay = read_until(&mut rx, &flow, "exit 0").await;
        assert!(replay.contains("$ echo first-run"), "{replay:?}");
        run(
            &terminal,
            request(folder.path(), "k2", "echo second-run", 30),
        )
        .await;
        let live = read_until(&mut rx, &flow, "second-run").await;
        assert!(live.contains("$ echo second-run"), "{live:?}");
    }

    #[tokio::test]
    async fn a_newer_tab_takes_over_without_stopping_the_command() {
        let terminal = Arc::new(AgentTerminal::new());
        let (one, _rx_one) = mpsc::channel(32);
        let old = CancellationToken::new();
        terminal
            .attach("s1", one, Arc::new(FlowControl::new()), old.clone())
            .unwrap();
        let (two, _rx_two) = mpsc::channel(32);
        terminal
            .attach(
                "s2",
                two,
                Arc::new(FlowControl::new()),
                CancellationToken::new(),
            )
            .unwrap();
        assert!(old.is_cancelled(), "the older tab's session was not ended");
        assert!(
            !terminal.detach("s1"),
            "the older tab is no longer attached"
        );
        assert!(terminal.detach("s2"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn what_the_person_types_reaches_the_running_command() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let (tx, mut rx) = mpsc::channel(32);
        let flow = Arc::new(FlowControl::new());
        terminal
            .attach("s1", tx, flow.clone(), CancellationToken::new())
            .unwrap();
        let task = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k1", "read answer; echo got-$answer", 30);
            async move { run(&terminal, request).await }
        });
        running(&terminal, "k1").await;
        terminal.write(b"yes\r".to_vec());
        read_until(&mut rx, &flow, "got-yes").await;
        assert_eq!(task.await.unwrap().end, RunEnd::Exited(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_resize_reaches_the_running_command() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        terminal.resize(TerminalSize { cols: 91, rows: 17 });
        let result = run(&terminal, request(folder.path(), "k1", "stty size", 30)).await;
        assert!(result.text.contains("17 91"), "{}", result.text);
    }

    #[tokio::test]
    async fn a_command_runs_with_the_kubeconfig_and_folder_and_gives_its_exit_code() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let command = script(
            "echo kc=$KUBECONFIG; echo cwd=$(pwd); exit 3",
            "echo kc=%KUBECONFIG% & echo cwd=%CD% & exit 3",
        );
        let result = run(&terminal, request(folder.path(), "k1", &command, 30)).await;
        assert_eq!(result.end, RunEnd::Exited(3));
        let kubeconfig = folder.path().join("kubeconfig");
        assert!(
            result
                .text
                .contains(&format!("kc={}", kubeconfig.display())),
            "{}",
            result.text
        );
        let cwd = std::fs::canonicalize(folder.path()).unwrap();
        let shown = result
            .text
            .lines()
            .find_map(|line| line.trim().strip_prefix("cwd="))
            .unwrap_or_default();
        assert_eq!(
            std::fs::canonicalize(shown).unwrap(),
            cwd,
            "{}",
            result.text
        );
    }

    #[tokio::test]
    async fn the_tab_sees_the_command_its_output_and_the_exit_line() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let result = run(
            &terminal,
            request(folder.path(), "k1", "echo skopos-tab", 30),
        )
        .await;
        assert_eq!(result.end, RunEnd::Exited(0));
        let screen = output::plain_text(&terminal.scrollback_text());
        let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
        assert_eq!(
            lines.first().copied(),
            Some("$ echo skopos-tab"),
            "{screen:?}"
        );
        assert!(lines.contains(&"skopos-tab"), "{screen:?}");
        assert_eq!(lines.last().copied(), Some("exit 0"), "{screen:?}");
    }

    #[tokio::test]
    async fn the_exit_line_starts_on_a_line_of_its_own() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let command = script("printf done", "<nul set /p =done");
        let result = run(&terminal, request(folder.path(), "k1", &command, 30)).await;
        assert!(
            result.text.trim_end().ends_with("done"),
            "{:?}",
            result.text
        );
        let screen = output::plain_text(&terminal.scrollback_text());
        assert!(
            screen.lines().any(|line| line.trim_end() == "exit 0"),
            "{screen:?}"
        );
    }

    #[tokio::test]
    async fn a_command_past_its_timeout_ends() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let command = script(
            "echo before; sleep 30",
            "echo before & ping -n 31 127.0.0.1 >NUL",
        );
        let started = Instant::now();
        let result = run(&terminal, request(folder.path(), "k1", &command, 1)).await;
        assert_eq!(result.end, RunEnd::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "{:?}",
            started.elapsed()
        );
        assert!(result.text.contains("before"), "{}", result.text);
        let screen = output::plain_text(&terminal.scrollback_text());
        assert!(
            screen.lines().any(|line| line.trim_end() == "timed out"),
            "{screen:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_timeout_ends_the_whole_process_tree() {
        let folder = tempfile::tempdir().unwrap();
        let pid_file = folder.path().join("bg.pid");
        let terminal = Arc::new(AgentTerminal::new());
        let command = format!("sleep 60 & echo $! > {}; wait", pid_file.display());
        let result = run(&terminal, request(folder.path(), "k1", &command, 1)).await;
        assert_eq!(result.end, RunEnd::TimedOut);
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let start = Instant::now();
        // SAFETY: signal 0 only checks that the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "the background sleep lives on"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[tokio::test]
    async fn stop_ends_a_running_command_with_its_reason() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let command = script("sleep 30", "ping -n 31 127.0.0.1 >NUL");
        let task = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k1", &command, 60);
            async move { run(&terminal, request).await }
        });
        running(&terminal, "k1").await;
        assert!(!terminal.stop_card("other", Stop::Person));
        assert!(terminal.stop_card("k1", Stop::Person));
        let result = task.await.unwrap();
        assert_eq!(result.end, RunEnd::Stopped(Stop::Person));
        let screen = output::plain_text(&terminal.scrollback_text());
        assert!(
            screen.lines().any(|line| line.trim_end() == "stopped"),
            "{screen:?}"
        );
    }

    #[tokio::test]
    async fn the_cluster_going_away_stops_the_command() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let request = request(
            folder.path(),
            "k1",
            &script("sleep 30", "ping -n 31 127.0.0.1 >NUL"),
            60,
        );
        let cluster = request.cluster.clone();
        let task = tokio::spawn({
            let terminal = terminal.clone();
            async move { run(&terminal, request).await }
        });
        running(&terminal, "k1").await;
        cluster.cancel();
        assert_eq!(task.await.unwrap().end, RunEnd::Stopped(Stop::Disconnected));
    }

    #[tokio::test]
    async fn dropping_the_run_ends_the_command() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let marker = folder.path().join("finished");
        let command = script(
            &format!("sleep 3; echo x > {}", marker.display()),
            &format!("ping -n 4 127.0.0.1 >NUL & echo x > {}", marker.display()),
        );
        let task = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k1", &command, 60);
            async move { run(&terminal, request).await }
        });
        running(&terminal, "k1").await;
        task.abort();
        let _ = task.await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(
            !marker.exists(),
            "the command ran on after its call went away"
        );
        assert_eq!(terminal.running_card(), None);
    }

    #[tokio::test]
    async fn a_second_command_waits_for_the_first() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let first = script(
            "sleep 1; echo first",
            "ping -n 2 127.0.0.1 >NUL & echo first",
        );
        let one = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k1", &first, 30);
            async move { run(&terminal, request).await }
        });
        running(&terminal, "k1").await;
        let two = run(&terminal, request(folder.path(), "k2", "echo second", 30)).await;
        assert_eq!(two.end, RunEnd::Exited(0));
        assert_eq!(one.await.unwrap().end, RunEnd::Exited(0));
        let screen = output::plain_text(&terminal.scrollback_text());
        let first_exit = screen.find("exit 0").unwrap();
        let second_line = screen.find("$ echo second").unwrap();
        assert!(first_exit < second_line, "{screen:?}");
    }

    #[tokio::test]
    async fn the_card_gets_the_last_lines_while_it_runs() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let command = script(
            "echo early; sleep 3",
            "echo early & ping -n 4 127.0.0.1 >NUL",
        );
        let (lines, mut seen) = watch::channel(String::new());
        let task = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k1", &command, 30);
            async move { terminal.run(request, lines).await }
        });
        tokio::time::timeout(Duration::from_secs(20), async {
            while !seen.borrow_and_update().contains("early") {
                seen.changed().await.unwrap();
            }
        })
        .await
        .expect("the card never saw early");
        assert!(!task.is_finished(), "the lines came only at the end");
        assert_eq!(task.await.unwrap().end, RunEnd::Exited(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_background_process_does_not_hold_the_result() {
        let folder = tempfile::tempdir().unwrap();
        let pid_file = folder.path().join("bg.pid");
        let terminal = Arc::new(AgentTerminal::new());
        let started = Instant::now();
        let command = format!("sleep 60 & echo $! > {}; echo started", pid_file.display());
        let result = run(&terminal, request(folder.path(), "k1", &command, 120)).await;
        assert_eq!(result.end, RunEnd::Exited(0));
        assert!(result.text.contains("started"));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let start = Instant::now();
        // SAFETY: signal 0 only checks that the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "the background sleep lives on"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_multi_line_command_runs_as_written() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let command = "echo \"a b\" 'c'\necho two";
        let result = run(&terminal, request(folder.path(), "k1", command, 30)).await;
        assert_eq!(result.end, RunEnd::Exited(0));
        assert!(result.text.contains("a b c"), "{}", result.text);
        assert!(result.text.contains("two"), "{}", result.text);
        let screen = output::plain_text(&terminal.scrollback_text());
        assert!(
            screen.starts_with("$ echo \"a b\" 'c'\n> echo two\n"),
            "{screen:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_flood_with_no_tab_ends_and_keeps_bounded_output() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let started = Instant::now();
        let result = run(
            &terminal,
            request(folder.path(), "k1", "yes skopos | head -n 200000", 120),
        )
        .await;
        assert_eq!(result.end, RunEnd::Exited(0));
        assert!(started.elapsed() < Duration::from_secs(60));
        assert!(result.text.starts_with("[earlier output cut]\n"));
        assert!(result.text.len() <= output::CUT_MARK.len() + 1 + output::AGENT_OUTPUT_LIMIT);
        assert!(terminal.scrollback_len() <= SCROLLBACK_LIMIT);
        assert_eq!(result.lines.lines().count(), CARD_LINES);
    }

    #[tokio::test]
    async fn a_command_that_cannot_start_fails_with_its_reason() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let mut request = request(folder.path(), "k1", "echo x", 30);
        request.program = folder.path().join("no-such-shell").display().to_string();
        let result = run(&terminal, request).await;
        let RunEnd::Failed(message) = result.end else {
            panic!("{:?}", result.end);
        };
        assert!(
            message.starts_with("The command could not start: "),
            "{message}"
        );
    }

    #[test]
    fn stop_all_and_stop_card_reach_every_cluster() {
        let terminals = AgentTerminals::new();
        let a = terminals.get(&"a".to_owned());
        let again = terminals.get(&"a".to_owned());
        assert!(Arc::ptr_eq(&a, &again));
        assert!(!terminals.stop_card("nothing"));
        terminals.stop_all();
    }

    #[tokio::test]
    async fn stop_all_also_ends_commands_queued_behind_the_running_one() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let long = script("sleep 30", "ping -n 30 127.0.0.1 >NUL");
        let one = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k1", &long, 60);
            async move { run(&terminal, request).await }
        });
        running(&terminal, "k1").await;
        let two = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k2", "echo second", 60);
            async move { run(&terminal, request).await }
        });
        while !lock(&terminal.queued)
            .iter()
            .any(|queued| queued.card_id == "k2")
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        terminal.stop_running(Stop::Chat);
        assert_eq!(one.await.unwrap().end, RunEnd::Stopped(Stop::Chat));
        assert_eq!(two.await.unwrap().end, RunEnd::Stopped(Stop::Chat));
        assert!(!output::plain_text(&terminal.scrollback_text()).contains("second"));
        assert_eq!(terminal.running_card(), None);
    }

    #[tokio::test]
    async fn a_failed_recheck_ends_the_command_unstarted() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let marker = folder.path().join("ran");
        let command = format!("echo x > {}", marker.display());
        let mut request = request(folder.path(), "k1", &command, 30);
        request.recheck = Box::new(|| Err("Terminal commands are off for fake.".to_owned()));
        let result = run(&terminal, request).await;
        assert_eq!(
            result.end,
            RunEnd::Failed("Terminal commands are off for fake.".to_owned())
        );
        assert!(!marker.exists(), "the command ran after its recheck failed");
        assert!(terminal.scrollback_text().is_empty());
        assert_eq!(terminal.running_card(), None);
    }

    #[tokio::test]
    async fn stop_card_ends_a_queued_command_alone() {
        let folder = tempfile::tempdir().unwrap();
        let terminal = Arc::new(AgentTerminal::new());
        let first = script(
            "sleep 1; echo first",
            "ping -n 2 127.0.0.1 >NUL & echo first",
        );
        let one = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k1", &first, 30);
            async move { run(&terminal, request).await }
        });
        running(&terminal, "k1").await;
        let two = tokio::spawn({
            let terminal = terminal.clone();
            let request = request(folder.path(), "k2", "echo second", 30);
            async move { run(&terminal, request).await }
        });
        while !lock(&terminal.queued)
            .iter()
            .any(|queued| queued.card_id == "k2")
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(terminal.stop_card("k2", Stop::Person));
        assert_eq!(two.await.unwrap().end, RunEnd::Stopped(Stop::Person));
        assert_eq!(one.await.unwrap().end, RunEnd::Exited(0));
    }
}
