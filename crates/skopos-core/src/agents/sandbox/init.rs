//! `--agent-init` (spec §4.1, §4.6, Linux): the process bubblewrap starts in a chat's sandbox.
//! Inside the sandbox's own network namespace it listens on `127.0.0.1:3128` and
//! `127.0.0.1:3129` (R3) and forwards each connection to the proxy's and the MCP endpoint's Unix
//! sockets, bound in at `/run/skopos`. Then it runs the agent as its child under a seccomp filter
//! that refuses new Unix sockets and io_uring, and exits with the agent's code. The filter is
//! installed in the child only, between fork and exec, so the bridge keeps its Unix sockets. It
//! runs on plain threads, with no tokio runtime.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::thread;
use std::time::Duration;

use seccompiler::{
    BackendError, BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition,
    SeccompFilter, SeccompRule, TargetArch,
};

use super::spec::ChatPorts;

/// The bridge could not start: a port is taken, or the filter cannot be built.
pub const INIT_FAILED: i32 = 125;
/// The agent's program exists but cannot run.
pub const CANNOT_RUN: i32 = 126;
/// The agent's program does not exist.
pub const NOT_FOUND: i32 = 127;
/// Called without a command.
pub const USAGE: i32 = 2;
/// How long the bridge waits after a failed accept, so a lack of file descriptors does not spin.
const ACCEPT_PAUSE: Duration = Duration::from_millis(50);
/// On x86_64 the x32 ABI reaches the same system calls with this bit set in their numbers.
const X32_SYSCALL_BIT: i64 = 0x4000_0000;

/// Listens on both chat ports, keeps the agent from tracing the bridge, and runs `command`.
pub fn run_agent_init(proxy_sock: &Path, mcp_sock: &Path, command: &[OsString]) -> i32 {
    let ports = ChatPorts::LINUX_SANDBOX;
    let mut listeners = Vec::new();
    for (port, socket) in [(ports.proxy, proxy_sock), (ports.mcp, mcp_sock)] {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => listeners.push((listener, socket.to_path_buf())),
            Err(error) => {
                eprintln!("skopos: cannot listen on 127.0.0.1:{port}: {error}");
                return INIT_FAILED;
            }
        }
    }
    keep_from_tracing();
    run_with(listeners, command)
}

/// Serves each listener, forwarding its connections to its Unix socket, then runs `command`
/// under the agent filter with the bridge's stdin, stdout and stderr, and gives its exit code:
/// the agent's own, 128 and the signal when a signal ended it, 127 when its program does not
/// exist, 126 when it cannot run.
pub(crate) fn run_with(listeners: Vec<(TcpListener, PathBuf)>, command: &[OsString]) -> i32 {
    let Some((program, args)) = command.split_first() else {
        eprintln!("skopos: --agent-init needs a command");
        return USAGE;
    };
    let filter = match agent_filter() {
        Ok(filter) => filter,
        Err(error) => {
            eprintln!("skopos: cannot build the agent's seccomp filter: {error:?}");
            return INIT_FAILED;
        }
    };
    for (listener, socket) in listeners {
        thread::spawn(move || serve(listener, socket));
    }
    let mut agent = Command::new(program);
    agent.args(args);
    // SAFETY: the closure runs in the child between fork and exec. It only calls
    // `seccompiler::apply_filter` on a program built before the fork, which makes two system
    // calls (`prctl` and `seccomp`) and allocates nothing.
    unsafe {
        agent.pre_exec(move || install(&filter));
    }
    let mut child = match agent.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "skopos: cannot start {}: {error}",
                Path::new(program).display()
            );
            return if error.kind() == io::ErrorKind::NotFound {
                NOT_FOUND
            } else {
                CANNOT_RUN
            };
        }
    };
    match child.wait() {
        Ok(status) => exit_code(status),
        Err(error) => {
            eprintln!("skopos: lost the agent: {error}");
            INIT_FAILED
        }
    }
}

/// The agent's filter (spec §4.6): `socket` with `AF_UNIX` and the io_uring calls fail with
/// `EPERM`; everything else is allowed, `socketpair` among it, since runtimes use it for their
/// children's pipes.
pub fn agent_filter() -> Result<BpfProgram, BackendError> {
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    for number in syscall_numbers(libc::SYS_socket) {
        rules.insert(number, vec![unix_domain()?]);
    }
    for call in [
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ] {
        for number in syscall_numbers(call) {
            // No conditions: every call matches.
            rules.insert(number, Vec::new());
        }
    }
    let arch = TargetArch::try_from(std::env::consts::ARCH)?;
    SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        arch,
    )?
    .try_into()
}

/// The numbers a call is reached by: on x86_64 also its x32 number.
fn syscall_numbers(call: i64) -> Vec<i64> {
    if cfg!(target_arch = "x86_64") {
        vec![call, call | X32_SYSCALL_BIT]
    } else {
        vec![call]
    }
}

/// Matches a call whose first argument, the socket domain, is `AF_UNIX`.
fn unix_domain() -> Result<SeccompRule, BackendError> {
    SeccompRule::new(vec![SeccompCondition::new(
        0,
        SeccompCmpArgLen::Dword,
        SeccompCmpOp::Eq,
        libc::AF_UNIX as u64,
    )?])
}

/// Installs `filter` on the calling thread, which passes it on to what it executes.
fn install(filter: &BpfProgram) -> io::Result<()> {
    seccompiler::apply_filter(filter).map_err(|error| match error {
        seccompiler::Error::Prctl(error) | seccompiler::Error::Seccomp(error) => error,
        _ => io::Error::from_raw_os_error(libc::EINVAL),
    })
}

/// Makes the bridge non-dumpable, so the agent, its child, cannot trace it or read its memory
/// through `/proc` and so reach the Unix sockets the filter keeps from the agent. The agent's
/// own program is dumpable again after its exec, as usual.
fn keep_from_tracing() {
    let zero: libc::c_ulong = 0;
    // SAFETY: `PR_SET_DUMPABLE` reads its integer arguments and no memory of ours.
    let failed = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, zero, zero, zero, zero) } != 0;
    if failed {
        eprintln!(
            "skopos: cannot keep the agent from tracing the bridge: {}",
            io::Error::last_os_error()
        );
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    match (status.code(), status.signal()) {
        (Some(code), _) => code,
        (None, Some(signal)) => 128 + signal,
        (None, None) => INIT_FAILED,
    }
}

/// Forwards each connection on `listener` to `socket`, one thread pair per connection.
fn serve(listener: TcpListener, socket: PathBuf) {
    loop {
        match listener.accept() {
            Ok((connection, _)) => {
                let socket = socket.clone();
                thread::spawn(move || forward(connection, &socket));
            }
            Err(error) => {
                eprintln!("skopos: the port bridge cannot accept: {error}");
                thread::sleep(ACCEPT_PAUSE);
            }
        }
    }
}

/// Copies both ways between `connection` and a new connection to `socket`; each direction
/// closes the other side's writing half when it ends.
fn forward(connection: TcpStream, socket: &Path) {
    let target = match UnixStream::connect(socket) {
        Ok(target) => target,
        Err(error) => {
            eprintln!("skopos: cannot reach {}: {error}", socket.display());
            return;
        }
    };
    let (Ok(connection_back), Ok(target_back)) = (connection.try_clone(), target.try_clone())
    else {
        return;
    };
    thread::spawn(move || copy_then_close(connection, target_back));
    copy_then_close(target, connection_back);
}

/// A stream whose writing half closes on its own.
trait CloseWrite: Write {
    fn close_write(&self);
}

impl CloseWrite for TcpStream {
    fn close_write(&self) {
        let _ = self.shutdown(Shutdown::Write);
    }
}

impl CloseWrite for UnixStream {
    fn close_write(&self) {
        let _ = self.shutdown(Shutdown::Write);
    }
}

fn copy_then_close(mut from: impl Read, mut to: impl CloseWrite) {
    // A failed copy ends this direction like a closed one: the peer sees the end either way.
    let _ = io::copy(&mut from, &mut to);
    to.close_write();
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;

    use super::*;

    fn words(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_filter_refuses_unix_sockets_and_io_uring_but_not_other_sockets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("probe.sock");
        let seen = thread::spawn(move || {
            install(&agent_filter().unwrap()).unwrap();
            let unix = UnixListener::bind(&path)
                .map(|_| ())
                .map_err(|error| error.raw_os_error());
            let inet = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).is_ok();
            let pair = UnixStream::pair().is_ok();
            // SAFETY: a null parameter pointer; without the filter the kernel refuses it with
            // EFAULT before it reads anything.
            let uring = unsafe {
                libc::syscall(
                    libc::SYS_io_uring_setup,
                    1,
                    std::ptr::null_mut::<libc::c_void>(),
                )
            };
            let uring_error = io::Error::last_os_error().raw_os_error();
            (unix, inet, pair, uring, uring_error)
        })
        .join()
        .unwrap();
        assert_eq!(
            seen,
            (Err(Some(libc::EPERM)), true, true, -1, Some(libc::EPERM))
        );
    }

    #[test]
    fn the_exit_code_is_the_agents_or_128_and_the_signal() {
        assert_eq!(
            run_with(Vec::new(), &words(&["/bin/sh", "-c", "exit 3"])),
            3
        );
        assert_eq!(
            run_with(Vec::new(), &words(&["/bin/sh", "-c", "kill -9 $$"])),
            137
        );
        assert_eq!(
            run_with(Vec::new(), &words(&["/nonexistent-skopos/agent"])),
            NOT_FOUND
        );
        assert_eq!(run_with(Vec::new(), &[]), USAGE);
    }

    #[test]
    fn connections_on_each_port_arrive_on_its_unix_socket() {
        let dir = tempfile::tempdir().unwrap();
        let mut listeners = Vec::new();
        let mut ports = Vec::new();
        let mut endpoints = Vec::new();
        for name in ["proxy", "mcp"] {
            let socket = dir.path().join(format!("{name}.sock"));
            let endpoint = UnixListener::bind(&socket).unwrap();
            endpoints.push(thread::spawn(move || {
                let (stream, _) = endpoint.accept().unwrap();
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                (&stream)
                    .write_all(format!("{name} got {line}").as_bytes())
                    .unwrap();
            }));
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            ports.push(listener.local_addr().unwrap().port());
            listeners.push((listener, socket));
        }
        // The agent waits until the test is done with the ports.
        let done = dir.path().join("done");
        let mut command = words(&[
            "/bin/sh",
            "-c",
            r#"while [ ! -e "$0" ]; do sleep 0.1; done"#,
        ]);
        command.push(done.clone().into_os_string());
        let init = thread::spawn(move || run_with(listeners, &command));
        let mut replies = Vec::new();
        for (port, word) in ports.into_iter().zip(["one", "two"]) {
            let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            client.write_all(format!("{word}\n").as_bytes()).unwrap();
            client.shutdown(Shutdown::Write).unwrap();
            let mut reply = String::new();
            client.read_to_string(&mut reply).unwrap();
            replies.push(reply);
        }
        assert_eq!(replies, ["proxy got one\n", "mcp got two\n"]);
        std::fs::write(&done, "").unwrap();
        assert_eq!(init.join().unwrap(), 0);
        for endpoint in endpoints {
            endpoint.join().unwrap();
        }
    }
}
