use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::path::PathBuf;
use stock_info_local::{AppState, db::Database, router};
use tempfile::TempDir;
use tower::ServiceExt;

fn migrations() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations")
}

fn setup() -> (TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("stock-info.sqlite")).unwrap();
    db.migrate(&migrations()).unwrap();
    (dir, db)
}

fn app(db: Database, dir: &TempDir) -> axum::Router {
    router(
        AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap(),
        dir.path(),
    )
}

async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[test]
fn existing_migrations_are_idempotent_and_durable_ledgers_survive_restart() {
    let (dir, db) = setup();
    let conn = db.connect().unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert!(version >= 148);
    let before: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for ns in ["observation-ledger-v1", "private-active-portfolio-v1"] {
        conn.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?1,'fixture','{}',NULL,1)", params![ns]).unwrap();
    }
    drop(conn);
    let reopened = Database::open(dir.path().join("stock-info.sqlite")).unwrap();
    assert_eq!(reopened.migrate(&migrations()).unwrap(), 0);
    let conn = reopened.connect().unwrap();
    let after: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(before, after);
    let records: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM kv_cache WHERE key='fixture' AND expires_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(records, 2);
    assert_eq!(
        conn.pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn failed_migration_rolls_back_changes_and_version() {
    let (dir, db) = setup();
    let fixture = dir.path().join("migrations");
    std::fs::create_dir(&fixture).unwrap();
    for file in std::fs::read_dir(migrations()).unwrap() {
        let file = file.unwrap();
        if file.path().extension().is_some_and(|ext| ext == "sql") {
            std::fs::copy(file.path(), fixture.join(file.file_name())).unwrap();
        }
    }
    let conn = db.connect().unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    std::fs::write(fixture.join("9999_failure.sql"), "INSERT INTO kv_cache(namespace,key,value_json,updated_at) VALUES('fixture','rolled-back','{}',1); SELECT * FROM definitely_missing_table;").unwrap();
    assert!(db.migrate(&fixture).is_err());
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        version
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM kv_cache WHERE namespace='fixture'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn future_database_version_is_rejected_without_changes() {
    let (dir, db) = setup();
    let conn = db.connect().unwrap();
    conn.pragma_update(None, "user_version", 9999).unwrap();
    assert!(db.migrate(&migrations()).is_err());
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        9999
    );
    drop(dir);
}

#[test]
fn concurrent_migrators_serialize_version_selection() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("stock-info.sqlite")).unwrap();
    let second = db.clone();
    let a = std::thread::spawn(move || db.migrate(&migrations()).unwrap());
    let b = std::thread::spawn(move || second.migrate(&migrations()).unwrap());
    assert!(a.join().unwrap() + b.join().unwrap() >= 148);
}

#[tokio::test]
async fn health_and_config_contracts_with_read_only_get() {
    let (dir, db) = setup();
    let app = app(db.clone(), &dir);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .header("host", "127.0.0.1:8000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let health = body(response).await;
    assert_eq!(health["data"]["runtime"], "rust");
    assert_eq!(health["data"]["sqlite"], true);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/companies/follow/forecast")
                .header("host", "127.0.0.1:8000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body(response).await["data"]["configured"], false);
    assert_eq!(
        db.connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM kv_cache WHERE namespace='companies_follow_config'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/companies/follow/forecast")
                .header("host", "127.0.0.1:8000")
                .header("origin", "http://127.0.0.1:8000")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"tracks":{"600036.sh":" bank "},"positions":{"600036.sh":5}})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let written = body(response).await["data"].clone();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/companies/follow/forecast")
                .header("host", "127.0.0.1:8000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body(response).await["data"], written);
    assert_eq!(written["tracks"], json!({"600036.SH":"bank"}));
    assert_eq!(
        db.connect()
            .unwrap()
            .query_row(
                "SELECT expires_at FROM kv_cache WHERE namespace='companies_follow_config'",
                [],
                |r| r.get::<_, Option<i64>>(0)
            )
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn host_origin_and_fetch_metadata_enforce_local_boundary() {
    let (dir, db) = setup();
    let app = app(db, &dir);
    for (host, origin, site) in [
        ("evil.example:8000", None, None),
        ("127.0.0.1:8000", Some("http://evil.example"), None),
        ("127.0.0.1:8000", Some("null"), None),
        ("127.0.0.1:8000", None, Some("cross-site")),
        ("127.0.0.1:8000", None, Some("same-site")),
        ("127.0.0.1:9000", None, None),
    ] {
        let mut req = Request::builder()
            .uri("/api/companies/follow/forecast")
            .header("host", host);
        if let Some(origin) = origin {
            req = req.header("origin", origin);
        }
        if let Some(site) = site {
            req = req.header("sec-fetch-site", site);
        }
        let response = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(body(response).await["data"], Value::Null);
    }
}

#[tokio::test]
async fn unknown_apis_never_fall_through_to_html_or_fake_success() {
    let (dir, db) = setup();
    let app = app(db, &dir);
    for path in [
        "/api/does-not-exist",
        "/api/research/no-such-operation",
        "/api/no-such/finance/path",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", "127.0.0.1:8000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(response).await["data"], Value::Null);
    }
    for invalid in ["[]", "null", "{", "12"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/companies/follow/forecast")
                    .header("host", "127.0.0.1:8000")
                    .header("content-type", "application/json")
                    .body(Body::from(invalid))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await["data"], Value::Null);
    }
}

#[tokio::test]
async fn market_snapshot_reuses_only_xueqiu_rows_and_preserves_legacy_shape() {
    let (dir, db) = setup();
    let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
    let today = chrono::Utc::now().date_naive().to_string();
    let row = json!({"code":"600036.SH","date":today,"close":10,"open":9,"high":11,"low":8,"volume":100,"turnover":null,"amount":1000,"amplitude":null,"pctChange":1,"changeAmount":0.1,"source":"xueqiu"});
    state.market_store().unwrap().put_json("kline/normal/600036.SH.json",&json!({"schemaVersion":2,"source":"xueqiu","rawResponseText":"{}","startDate":today,"endDate":today,"updatedAt":chrono::Utc::now().timestamp_millis(),"rows":[row]})).await.unwrap();
    let app = router(state, dir.path());
    for format in ["structured", "legacy"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/kline?code=600036&format={format}&from={today}&to={today}"
                    ))
                    .header("host", "127.0.0.1:8000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let data = body(response).await["data"].clone();
        assert_eq!(data.as_array().unwrap().len(), 1);
        if format == "structured" {
            assert_eq!(data[0], row);
        } else {
            assert_eq!(data[0].as_array().unwrap().len(), 12);
            assert_eq!(data[0][1], 10.0);
        }
    }
    for suffix in [
        "",
        "?code=600036&period=week",
        "?code=600036&fq=invalid",
        "?code=600036&format=invalid",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/kline{suffix}"))
                    .header("host", "127.0.0.1:8000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn retired_surfaces_are_not_restored_by_rust() {
    let (dir, db) = setup();
    let app = app(db, &dir);
    for (path, status) in [
        ("/api/auth/me", StatusCode::NOT_FOUND),
        ("/api/llm-tasks", StatusCode::GONE),
        ("/api/llm-tasks/old-job", StatusCode::GONE),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", "127.0.0.1:8000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(body(response).await["data"], Value::Null);
    }
}

#[tokio::test]
async fn legacy_content_port_is_read_only_cross_port_and_hides_private_api() {
    let (dir, db) = setup();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:8788".into()).unwrap();
    state
        .knowledge_store()
        .unwrap()
        .put("sample.pdf", b"%PDF-fixture".to_vec())
        .await
        .unwrap();
    let app = stock_info_local::content_router(state, "127.0.0.1:8000".into());
    for (method, path, origin, status) in [
        (
            "GET",
            "/knowledge-content/sample.pdf",
            "http://127.0.0.1:8000",
            StatusCode::OK,
        ),
        (
            "HEAD",
            "/knowledge-content/sample.pdf",
            "http://localhost:8000",
            StatusCode::OK,
        ),
        (
            "OPTIONS",
            "/knowledge-content/sample.pdf",
            "http://127.0.0.1:8000",
            StatusCode::NO_CONTENT,
        ),
        (
            "GET",
            "/api/research/portfolio/workspace",
            "http://127.0.0.1:8000",
            StatusCode::NOT_FOUND,
        ),
        (
            "GET",
            "/knowledge-content/sample.pdf",
            "https://evil.example",
            StatusCode::FORBIDDEN,
        ),
        (
            "POST",
            "/knowledge-content/sample.pdf",
            "http://127.0.0.1:8000",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "127.0.0.1:8788")
                    .header("origin", origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{method} {path} {origin}");
        if status.is_success() {
            assert_eq!(response.headers()["access-control-allow-origin"], origin);
            assert_ne!(response.headers()["access-control-allow-origin"], "*");
            if method == "HEAD" {
                assert!(
                    to_bytes(response.into_body(), 100)
                        .await
                        .unwrap()
                        .is_empty()
                );
            }
        }
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/knowledge-content/sample.pdf")
                .header("host", "127.0.0.1:8788")
                .header("origin", "http://127.0.0.1:8000")
                .header("range", "bytes=5-11")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-range"], "bytes 5-11/12");
    assert_eq!(
        &to_bytes(response.into_body(), 100).await.unwrap()[..],
        b"fixture"
    );
}

#[test]
fn http_cache_key_matches_original_node_cache_contract() {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("authorization", "Bearer private".parse().unwrap());
    headers.insert("cookie", "private=cookie".parse().unwrap());
    headers.insert("referer", "https://example.com/".parse().unwrap());
    let key = stock_info_local::http::cache_key(
        "GET",
        "https://example.com/data?q=600036",
        &headers,
        None,
    )
    .unwrap();
    assert_eq!(
        key,
        "9ab3849576f0e503a986caf79914bc0ee1fd1711e9c60762cfc6a94dbacc14ad"
    );
}

#[tokio::test]
async fn http_download_limits_reject_declared_and_streamed_oversize() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for response in [
        "HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n",
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).await;
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let error = stock_info_local::http::HttpClient::new()
            .unwrap()
            .bytes_limited(
                &format!("http://{address}/pdf"),
                reqwest::header::HeaderMap::new(),
                1000,
                5,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("byte limit"), "{error}");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn provider_rejection_keeps_validator_body_out_of_error_strings() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).await;
        let body = r#"{"error_code":"400016","private":"never-log-me"}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let error = stock_info_local::http::HttpClient::new()
        .unwrap()
        .text(
            &format!("http://{address}/?token=secret"),
            reqwest::Method::GET,
            reqwest::header::HeaderMap::new(),
            None,
        )
        .await
        .unwrap_err();
    assert!(!format!("{error:?} {error:#}").contains("never-log-me"));
    assert!(!format!("{error:?} {error:#}").contains("token=secret"));
    let rejection = error
        .downcast_ref::<stock_info_local::http::ProviderRejection>()
        .unwrap();
    assert_eq!(rejection.status, StatusCode::BAD_REQUEST);
    assert!(
        stock_info_local::xueqiu::validate_body(&rejection.body)
            .unwrap_err()
            .to_string()
            .contains("Cookie")
    );
    server.await.unwrap();
}
