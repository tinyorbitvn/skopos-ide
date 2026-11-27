//! The test SSH server's own contract: a fixed key per seed and a port that closes on stop.

use skopos_fakesshd::{FakeSshd, FakeSshdOptions};

#[tokio::test]
async fn the_same_seed_gives_the_same_host_key_on_the_same_port() {
    let first = FakeSshd::start(FakeSshdOptions::default()).await.unwrap();
    let addr = first.addr();
    let line = first.known_hosts_line();
    let fingerprint = first.fingerprint();
    assert!(
        line.starts_with(&format!("[127.0.0.1]:{} ssh-ed25519 ", addr.port())),
        "{line}"
    );
    assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
    first.stop().await;
    assert!(
        std::net::TcpStream::connect(addr).is_err(),
        "the port is still open after stop"
    );

    let again = FakeSshd::start_on(addr, FakeSshdOptions::default())
        .await
        .unwrap();
    assert_eq!(again.known_hosts_line(), line);
    assert_eq!(again.fingerprint(), fingerprint);
    again.stop().await;
}

#[tokio::test]
async fn it_greets_as_an_ssh_server() {
    use tokio::io::AsyncReadExt;
    let server = FakeSshd::start(FakeSshdOptions::default()).await.unwrap();
    let mut stream = tokio::net::TcpStream::connect(server.addr()).await.unwrap();
    let mut greeting = [0u8; 8];
    stream.read_exact(&mut greeting).await.unwrap();
    assert_eq!(&greeting, b"SSH-2.0-");
    server.stop().await;
}
