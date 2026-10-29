//! Real assembled-router acceptance for the private research editor boundary.
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::json;
use stock_info_local::{AppState, db::Database, observation, router};
use tower::ServiceExt;

#[tokio::test]
async fn assembled_editor_is_local_same_origin_read_only_and_versioned() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("test.sqlite")).unwrap();
    db.connect()
        .unwrap()
        .execute_batch(include_str!("../../migrations/0117_create_kv_cache.sql"))
        .unwrap();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let state = AppState::new(db.clone(), root, "127.0.0.1:8000".into()).unwrap();
    let app = router(state, dir.path());
    let path = "/api/research/observation/600036.SH";
    for (host, origin) in [
        ("evil.example:8000", None),
        ("127.0.0.1:8000", Some("https://evil.example")),
    ] {
        let mut request = Request::builder().uri(path).header("host", host);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
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
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(
        observation::versions(&db, "600036.SH", 100)
            .await
            .unwrap()
            .is_empty()
    );
    let mut draft = observation::research_template("bank");
    draft["thesis"]["changeReason"] = json!("assembled route fixture");
    for expected in [StatusCode::OK, StatusCode::CONFLICT] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("host", "127.0.0.1:8000")
                    .header("origin", "http://127.0.0.1:8000")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"expectedVersion":0,"draft":draft}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{path}?version=1"))
                .header("host", "127.0.0.1:8000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("{path}/history"))
                .header("host", "127.0.0.1:8000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        observation::versions(&db, "600036.SH", 100)
            .await
            .unwrap()
            .len(),
        1
    );
}
