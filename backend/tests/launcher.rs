#![cfg(unix)]
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn command(dir: &std::path::Path, api: u16, content: u16) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_stock-info-local"));
    cmd.current_dir(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap(),
    )
    .env("HOST", "127.0.0.1")
    .env("PORT", api.to_string())
    .env("KNOWLEDGE_CONTENT_LOCAL_PORT", content.to_string())
    .env("LOCAL_DB_PATH", dir.join("test.sqlite"))
    .env("LOCAL_DATA_DIR", dir)
    .env("KNOWLEDGE_CONTENT_LOCAL_DIR", dir.join("content"))
    .env("LOCAL_MARKET_DATA_DIR", dir.join("market"))
    .env("LOCAL_SCHEDULER", "0")
    .env("XUEQIU_COOKIE_REFRESH", "0")
    .env("LLM_RUNTIME", "production")
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    cmd
}
fn available() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn occupied_api_port_cannot_touch_database() {
    let dir = tempfile::tempdir().unwrap();
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let busy = held.local_addr().unwrap().port();
    let status = command(dir.path(), busy, available()).status().unwrap();
    assert!(!status.success());
    assert!(
        !dir.path().join("test.sqlite").exists(),
        "binding failure must precede SQLite open"
    );
}
#[test]
fn native_server_health_and_sigterm_drain_without_node_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let api = available();
    // A foreign content-port listener must neither block startup nor be stopped.
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let content = held.local_addr().unwrap().port();
    let mut child = Owned(command(dir.path(), api, content).spawn().unwrap());
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", api)) {
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            write!(
                stream,
                "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{api}\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(
                response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200"),
                "{response}"
            );
            assert!(response.contains("\"runtime\":\"rust\""));
            break;
        }
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "native server exited before health"
        );
        assert!(Instant::now() < until, "health readiness timeout");
        std::thread::sleep(Duration::from_millis(50));
    }
    // Content/converter routes are served on the API port, not a second socket.
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", api)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        stream,
        "GET /__health HTTP/1.0\r\nHost: 127.0.0.1:{api}\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200"),
        "{response}"
    );
    assert_eq!(held.local_addr().unwrap().port(), content);
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.0.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < until, "graceful SIGTERM timeout");
        std::thread::sleep(Duration::from_millis(25));
    }
    let db = rusqlite::Connection::open(dir.path().join("test.sqlite")).unwrap();
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
