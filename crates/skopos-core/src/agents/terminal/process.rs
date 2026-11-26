//! One terminal command's process, in a PTY of its own (native agents spec §5.3).

use std::ffi::OsString;
use std::fmt::Display;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::sessions::{pty_size, TerminalSize};

/// How often the waiter looks at the process.
const WAIT_POLL: Duration = Duration::from_millis(50);

pub(crate) struct CommandSpec {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) kubeconfig: PathBuf,
    pub(crate) cwd: PathBuf,
    /// Replaces the inherited `PATH` when set.
    pub(crate) path: Option<OsString>,
    pub(crate) size: TerminalSize,
}

pub(crate) struct Spawned {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) reader: Box<dyn Read + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) child: Box<dyn Child + Send + Sync>,
}

pub(crate) fn start_error(error: impl Display) -> String {
    format!("The command could not start: {error}")
}

/// Starts the command with the cluster's `KUBECONFIG` in `cwd`.
pub(crate) fn spawn(spec: &CommandSpec) -> Result<Spawned, String> {
    let pair = native_pty_system()
        .openpty(pty_size(spec.size))
        .map_err(start_error)?;
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    command.env("KUBECONFIG", &spec.kubeconfig);
    command.env("TERM", "xterm-256color");
    if let Some(path) = &spec.path {
        command.env("PATH", path);
    }
    command.cwd(&spec.cwd);
    let child = pair.slave.spawn_command(command).map_err(start_error)?;
    // While this end stays open here, reading the master never sees the command's end.
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(start_error)?;
    let writer = pair.master.take_writer().map_err(start_error)?;
    Ok(Spawned {
        master: pair.master,
        reader,
        writer,
        child,
    })
}

/// Waits for the process on a thread of its own. Once `stop` is cancelled it ends the process
/// and everything it started: its session on Unix, its job on Windows. When the process exits
/// by itself, what it left running in the background ends too (Global Constraints), so that
/// nothing holds the PTY open.
pub(crate) fn spawn_waiter(
    mut child: Box<dyn Child + Send + Sync>,
    stop: CancellationToken,
) -> oneshot::Receiver<Option<u32>> {
    // portable-pty starts the shell with `setsid`, so its id is also its process group's.
    let group = child.process_id();
    #[cfg(windows)]
    let mut job = child.as_raw_handle().and_then(|handle| {
        crate::process::JobGuard::contain_handle(handle as windows_sys::Win32::Foundation::HANDLE)
            .ok()
    });
    let (exit, exit_rx) = oneshot::channel();
    std::thread::spawn(move || {
        let mut ended = false;
        let code = loop {
            if stop.is_cancelled() && !ended {
                ended = true;
                end_group(group);
                let _ = child.kill();
                #[cfg(windows)]
                drop(job.take());
            }
            match child.try_wait() {
                Ok(Some(status)) => break Some(status.exit_code()),
                Ok(None) => std::thread::sleep(WAIT_POLL),
                Err(_) => break None,
            }
        };
        // The shell is gone; end what it left behind.
        end_group(group);
        #[cfg(windows)]
        drop(job.take());
        let _ = exit.send(code);
    });
    exit_rx
}

/// Ends the process group `group` on Unix. On Windows the job does it when it is dropped.
fn end_group(group: Option<u32>) {
    #[cfg(unix)]
    if let Some(group) = group.and_then(|id| libc::pid_t::try_from(id).ok()) {
        // SAFETY: `kill` only sends a signal. A group id is not given to a new process while
        // a member of the group lives; with none left the call fails with ESRCH.
        unsafe { libc::kill(-group, libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    let _ = group;
}
