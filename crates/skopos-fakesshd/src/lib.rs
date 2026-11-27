//! A small SSH server for the tunnel tests (tunnels spec §6.6), built on `russh`: password or
//! keyboard-interactive authentication, a fixed host key and `direct-tcpip` forwarding. It
//! never ships.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{HashAlg, PrivateKey};
use russh::server::{
    Auth, ChannelOpenHandle, Config, Handler, Msg, Response, RunningServerHandle, Server, Session,
};
use russh::{Channel, ChannelOpenFailure, MethodKind, MethodSet};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The keyboard-interactive prompts.
pub const PASSWORD_PROMPT: &str = "Password: ";
pub const CODE_PROMPT: &str = "Verification code: ";

/// How the server checks `user`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    /// The `password` method: `ssh` asks `<user>@<host>'s password: `.
    Password,
    /// `keyboard-interactive`: `Password: `, then `Verification code: ` when a code is set.
    KeyboardInteractive,
}

#[derive(Debug, Clone)]
pub struct FakeSshdOptions {
    pub user: String,
    pub password: String,
    pub method: AuthMethod,
    /// Asked after the password, with `keyboard-interactive` only.
    pub code: Option<String>,
    /// Targets the server resolves itself, `host:port` to an address, such as a name only a
    /// network beyond the bastion knows. Anything else is dialed as named.
    pub hosts: HashMap<String, SocketAddr>,
    /// The host key's seed: the same seed gives the same key, so a restarted server keeps it.
    pub key_seed: [u8; 32],
}

impl Default for FakeSshdOptions {
    fn default() -> Self {
        Self {
            user: "me".into(),
            password: "pw".into(),
            method: AuthMethod::Password,
            code: None,
            hosts: HashMap::new(),
            key_seed: [7; 32],
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

struct Shared {
    options: FakeSshdOptions,
    opened: Mutex<Vec<String>>,
}

struct Sshd(Arc<Shared>);

impl Server for Sshd {
    type Handler = Client;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Client {
        Client {
            shared: self.0.clone(),
            password_ok: false,
        }
    }
}

struct Client {
    shared: Arc<Shared>,
    /// Keyboard-interactive: the password was right and the code comes next.
    password_ok: bool,
}

fn ask(prompt: &'static str) -> Auth {
    Auth::Partial {
        name: "".into(),
        instructions: "".into(),
        prompts: vec![(prompt.into(), false)].into(),
    }
}

impl Handler for Client {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        let options = &self.shared.options;
        if options.method == AuthMethod::Password
            && user == options.user
            && password == options.password
        {
            return Ok(Auth::Accept);
        }
        Ok(Auth::reject())
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let options = self.shared.options.clone();
        if options.method != AuthMethod::KeyboardInteractive || user != options.user {
            return Ok(Auth::reject());
        }
        let Some(response) = response else {
            self.password_ok = false;
            return Ok(ask(PASSWORD_PROMPT));
        };
        let answer = response
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .next()
            .unwrap_or_default();
        if !self.password_ok {
            if answer != options.password {
                return Ok(Auth::reject());
            }
            if options.code.is_some() {
                self.password_ok = true;
                return Ok(ask(CODE_PROMPT));
            }
            return Ok(Auth::Accept);
        }
        self.password_ok = false;
        if Some(answer.as_str()) == options.code.as_deref() {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let target = format!("{host}:{port}");
        let mapped = self.shared.options.hosts.get(&target).copied();
        let shared = self.shared.clone();
        let host = host.to_owned();
        // Dialing here would hold up the session's other messages.
        tokio::spawn(async move {
            let dialed = match (mapped, u16::try_from(port)) {
                (Some(addr), _) => TcpStream::connect(addr).await,
                (None, Ok(port)) => TcpStream::connect((host.as_str(), port)).await,
                (None, Err(_)) => Err(std::io::Error::other("the port is out of range")),
            };
            match dialed {
                Ok(mut upstream) => {
                    reply.accept().await;
                    lock(&shared.opened).push(target);
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
                }
                Err(_) => reply.reject(ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }
}

/// A running server on `127.0.0.1`.
pub struct FakeSshd {
    addr: SocketAddr,
    key: PrivateKey,
    shared: Arc<Shared>,
    shutdown: RunningServerHandle,
    task: Option<JoinHandle<()>>,
}

impl FakeSshd {
    pub async fn start(options: FakeSshdOptions) -> std::io::Result<FakeSshd> {
        Self::start_on(SocketAddr::from(([127, 0, 0, 1], 0)), options).await
    }

    /// On `addr`, such as the address of a server that stopped, so `ssh` finds it again.
    pub async fn start_on(addr: SocketAddr, options: FakeSshdOptions) -> std::io::Result<FakeSshd> {
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&options.key_seed));
        let methods = match options.method {
            AuthMethod::Password => MethodSet::from(&[MethodKind::Password][..]),
            AuthMethod::KeyboardInteractive => {
                MethodSet::from(&[MethodKind::KeyboardInteractive][..])
            }
        };
        let config = Arc::new(Config {
            methods,
            keys: vec![key.clone()],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::ZERO),
            inactivity_timeout: None,
            ..Config::default()
        });
        let listener = TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            options,
            opened: Mutex::new(Vec::new()),
        });
        let mut server = Sshd(shared.clone());
        let (handle_tx, handle_rx) = oneshot::channel();
        // `run_on_socket` borrows the listener, so one task owns both.
        let task = tokio::spawn(async move {
            let running = server.run_on_socket(config, &listener);
            let _ = handle_tx.send(running.handle());
            let _ = running.await;
        });
        let shutdown = handle_rx
            .await
            .map_err(|_| std::io::Error::other("the SSH server did not start"))?;
        Ok(FakeSshd {
            addr,
            key,
            shared,
            shutdown,
            task: Some(task),
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// The host key as `known_hosts` names it for `127.0.0.1:<port>`.
    pub fn known_hosts_line(&self) -> String {
        let key = self.key.public_key().to_openssh().unwrap_or_default();
        format!("[127.0.0.1]:{} {key}", self.addr.port())
    }

    /// `SHA256:…`, as `ssh` shows it in the host key prompt.
    pub fn fingerprint(&self) -> String {
        self.key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string()
    }

    /// The `host:port` targets it opened, in order.
    pub fn opened(&self) -> Vec<String> {
        lock(&self.shared.opened).clone()
    }

    /// Disconnects every session and closes the port.
    pub async fn stop(mut self) {
        self.shutdown.shutdown("stopped".to_owned());
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for FakeSshd {
    fn drop(&mut self) {
        self.shutdown.shutdown("stopped".to_owned());
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
