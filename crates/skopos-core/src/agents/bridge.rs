//! `--agent-mcp <host:port>` (spec §4.1): the `skopos` MCP server entry the agent launches. It
//! connects to the chat's MCP endpoint, sends the chat's token as the first line, then copies its
//! stdin to the endpoint and the endpoint's replies to its stdout. Plain threads and `std::net`.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::thread;

/// The exit code when the endpoint cannot be reached or the connection fails.
pub const FAILED: i32 = 1;

/// Bridges this process's stdin and stdout to `target`: 0 when the endpoint closes the
/// connection, 1 when it cannot be reached or the connection fails (with a line on stderr).
pub fn run_agent_mcp(target: &str, token: &str) -> i32 {
    let stream = match TcpStream::connect(target) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("skopos: cannot reach the chat at {target}: {error}");
            return FAILED;
        }
    };
    match pipe(stream, token, io::stdin(), io::stdout()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("skopos: the chat connection failed: {error}");
            FAILED
        }
    }
}

/// Sends `token` and a newline, then copies `input` to `stream` on a thread of its own, closing
/// the stream's writing half when `input` ends, and `stream` to `output`. Returns when the
/// endpoint closes, whether or not `input` has ended.
pub(crate) fn pipe(
    mut stream: TcpStream,
    token: &str,
    mut input: impl Read + Send + 'static,
    mut output: impl Write,
) -> io::Result<()> {
    stream.write_all(format!("{token}\n").as_bytes())?;
    let mut upstream = stream.try_clone()?;
    thread::spawn(move || {
        // A failed copy ends this direction like a closed input: the endpoint sees the end.
        let _ = io::copy(&mut input, &mut upstream);
        let _ = upstream.shutdown(Shutdown::Write);
    });
    io::copy(&mut stream, &mut output)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Cursor};
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn the_token_goes_first_then_both_ways_until_the_endpoint_closes() {
        let endpoint = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = endpoint.local_addr().unwrap();
        let heard = thread::spawn(move || {
            let (mut stream, _) = endpoint.accept().unwrap();
            let mut heard = String::new();
            stream.read_to_string(&mut heard).unwrap();
            stream.write_all(b"{\"id\":1,\"result\":{}}\n").unwrap();
            heard
        });
        let input = Cursor::new(b"{\"id\":1,\"method\":\"initialize\"}\n".to_vec());
        let mut output = Vec::new();
        pipe(
            TcpStream::connect(address).unwrap(),
            "t0k3n",
            input,
            &mut output,
        )
        .unwrap();
        assert_eq!(
            heard.join().unwrap(),
            "t0k3n\n{\"id\":1,\"method\":\"initialize\"}\n"
        );
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "{\"id\":1,\"result\":{}}\n"
        );
    }

    #[test]
    fn a_closed_endpoint_ends_the_bridge_while_its_input_stays_open() {
        let endpoint = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = endpoint.local_addr().unwrap();
        let heard = thread::spawn(move || {
            let (stream, _) = endpoint.accept().unwrap();
            let mut token = String::new();
            BufReader::new(&stream).read_line(&mut token).unwrap();
            (&stream).write_all(b"bye\n").unwrap();
            token
        });
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let _writer = TcpStream::connect(source.local_addr().unwrap()).unwrap();
        let (input, _) = source.accept().unwrap();
        let mut output = Vec::new();
        pipe(
            TcpStream::connect(address).unwrap(),
            "t0k3n",
            input,
            &mut output,
        )
        .unwrap();
        assert_eq!(heard.join().unwrap(), "t0k3n\n");
        assert_eq!(output, b"bye\n");
    }

    #[test]
    fn nothing_listening_exits_1() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(run_agent_mcp(&format!("127.0.0.1:{port}"), "t0k3n"), FAILED);
    }
}
