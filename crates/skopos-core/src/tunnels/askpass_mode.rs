//! The app binary's askpass mode (tunnels spec §6.3). A tunnel's `ssh` runs the app binary as
//! `SSH_ASKPASS` with the prompt as its only argument (OpenSSH passes no flag), so the mode is
//! told apart by `SKOPOS_ASKPASS_TOKEN`, which only that `ssh` has. It relays the prompt to
//! the core and prints the answer. Like `--agent-mcp` it starts no runtime: plain `std::net`.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const ASKPASS_ADDR_VAR: &str = "SKOPOS_ASKPASS_ADDR";
pub const ASKPASS_TOKEN_VAR: &str = "SKOPOS_ASKPASS_TOKEN";
/// OpenSSH sets it to `confirm` for a yes/no question and to `none` for a notice.
pub const ASKPASS_PROMPT_VAR: &str = "SSH_ASKPASS_PROMPT";
/// Longer than a prompt may wait for the person (2 minutes), so the core answers first.
const ANSWER_WAIT: Duration = Duration::from_secs(150);
const CONNECT_WAIT: Duration = Duration::from_secs(5);
const REPLY_CAP: u64 = 64 * 1024;

/// What the mode sends after its token line, as one JSON line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskRequest {
    pub(crate) prompt: String,
    /// `SSH_ASKPASS_PROMPT`, when set.
    pub(crate) hint: Option<String>,
}

/// The core's reply, as one JSON line. No `Debug`: it can hold an answer (T1).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "reply")]
pub(crate) enum AskReply {
    /// Print `text` and exit 0.
    Answer { text: String },
    /// Exit 1, which `ssh` reads as no.
    No,
}

/// Whether this process was started as a tunnel's askpass.
pub fn askpass_requested() -> bool {
    std::env::var_os(ASKPASS_TOKEN_VAR).is_some_and(|token| !token.is_empty())
}

/// Runs the mode; `args` are the arguments after the program name. Returns the exit code.
pub fn run_askpass(args: &[OsString]) -> i32 {
    let hint = std::env::var(ASKPASS_PROMPT_VAR).ok();
    if hint.as_deref() == Some("none") {
        // A notice, such as "Confirm user presence for key": nothing to answer.
        return 0;
    }
    let token = std::env::var(ASKPASS_TOKEN_VAR).unwrap_or_default();
    let addr = std::env::var(ASKPASS_ADDR_VAR).unwrap_or_default();
    let prompt = args
        .first()
        .map(|arg| arg.to_string_lossy().into_owned())
        .unwrap_or_default();
    match ask(&addr, &token, &AskRequest { prompt, hint }) {
        Ok(AskReply::Answer { text }) => {
            let mut out = std::io::stdout().lock();
            if writeln!(out, "{text}").and_then(|()| out.flush()).is_err() {
                return 1;
            }
            0
        }
        Ok(AskReply::No) => 1,
        Err(e) => {
            eprintln!("skopos askpass: {e}");
            1
        }
    }
}

/// Sends the token line and the request to the core at `addr` and reads its reply.
pub(crate) fn ask(addr: &str, token: &str, request: &AskRequest) -> std::io::Result<AskReply> {
    let invalid =
        |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidInput, what.to_owned());
    let addr: SocketAddr = addr
        .parse()
        .map_err(|_| invalid("SKOPOS_ASKPASS_ADDR is not an address"))?;
    if !addr.ip().is_loopback() {
        return Err(invalid("SKOPOS_ASKPASS_ADDR is not on this computer"));
    }
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_WAIT)?;
    stream.set_read_timeout(Some(ANSWER_WAIT))?;
    let mut body = serde_json::to_vec(request)?;
    body.push(b'\n');
    stream.write_all(format!("{token}\n").as_bytes())?;
    stream.write_all(&body)?;
    stream.flush()?;
    let mut reply = String::new();
    BufReader::new(stream.take(REPLY_CAP)).read_line(&mut reply)?;
    serde_json::from_str(&reply).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "SkoposIDE sent no answer")
    })
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// A one-shot core: reads the token line and the request, then sends `reply` when the token
    /// is right. Gives back the request it read.
    fn fake_core(
        token: &'static str,
        reply: &'static str,
    ) -> (String, thread::JoinHandle<Option<AskRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line.trim_end() != token {
                return None;
            }
            line.clear();
            reader.read_line(&mut line).unwrap();
            let request: AskRequest = serde_json::from_str(&line).unwrap();
            stream.write_all(reply.as_bytes()).unwrap();
            Some(request)
        });
        (addr, handle)
    }

    fn request(prompt: &str) -> AskRequest {
        AskRequest {
            prompt: prompt.into(),
            hint: None,
        }
    }

    #[test]
    fn ask_sends_the_token_then_the_prompt_and_reads_the_answer() {
        let (addr, core) = fake_core("t0ken", "{\"reply\":\"answer\",\"text\":\"hunter2\"}\n");
        let sent = AskRequest {
            prompt: "Password: ".into(),
            hint: Some("confirm".into()),
        };
        let reply = ask(&addr, "t0ken", &sent).unwrap();
        assert!(matches!(reply, AskReply::Answer { text } if text == "hunter2"));
        assert_eq!(core.join().unwrap(), Some(sent));
    }

    #[test]
    fn no_is_read_and_a_broken_reply_is_an_error() {
        let (addr, _core) = fake_core("t", "{\"reply\":\"no\"}\n");
        assert!(matches!(
            ask(&addr, "t", &request("p")).unwrap(),
            AskReply::No
        ));
        let (addr, _core) = fake_core("t", "garbage\n");
        assert!(ask(&addr, "t", &request("p")).is_err());
    }

    #[test]
    fn only_a_loopback_address_is_asked() {
        assert!(ask("10.0.0.1:22", "t", &request("p")).is_err());
        assert!(ask("not an address", "t", &request("p")).is_err());
    }
}
