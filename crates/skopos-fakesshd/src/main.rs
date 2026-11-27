//! `skopos-fakesshd [--user U] [--password P] [--port N] [--host name:port=addr]…`: the test
//! SSH server for the e2e tests. Prints `listening on 127.0.0.1:<port>` and
//! `known-host <line>`, then serves until killed. It never ships.

use std::net::SocketAddr;

use skopos_fakesshd::{FakeSshd, FakeSshdOptions};

#[tokio::main]
async fn main() {
    let mut options = FakeSshdOptions::default();
    let mut port: u16 = 0;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().unwrap_or_default();
        match flag.as_str() {
            "--user" => options.user = value,
            "--password" => options.password = value,
            "--port" => port = value.parse().unwrap_or(0),
            "--host" => match value
                .split_once('=')
                .map(|(name, addr)| (name, addr.parse()))
            {
                Some((name, Ok(addr))) => {
                    options.hosts.insert(name.to_owned(), addr);
                }
                _ => {
                    eprintln!("skopos-fakesshd: --host takes name:port=address, not {value}");
                    std::process::exit(2);
                }
            },
            other => {
                eprintln!("skopos-fakesshd: unknown flag {other}");
                std::process::exit(2);
            }
        }
    }
    let server = match FakeSshd::start_on(SocketAddr::from(([127, 0, 0, 1], port)), options).await {
        Ok(server) => server,
        Err(e) => {
            eprintln!("skopos-fakesshd: {e}");
            std::process::exit(1);
        }
    };
    println!("listening on {}", server.addr());
    println!("known-host {}", server.known_hosts_line());
    std::future::pending::<()>().await;
}
