use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use stock_info_local::{AppState, acquisition_status, db::Database};
use tower::ServiceExt;

fn setup() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("status.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:18000".into()).unwrap();
    (dir, state)
}

#[test]
fn distinguishes_lifecycle_latest_attempt_and_last_success_without_leaking_material() {
    let (_dir, state) = setup();
    let conn = state.db.connect().unwrap();
    conn.execute_batch("INSERT INTO acquisition_tasks(id,name,status,flow_id,config_json,created_at,updated_at) VALUES(1,'example','paused','example','{\"interval\":\"5m\",\"proxy\":\"secret-proxy\"}','x','x');
        INSERT INTO acquisition_runs(id,task_id,status,started_at,finished_at,metadata_json,created_at) VALUES(1,1,'success','2026-10-30T01:00:00Z','2026-10-30T01:01:00Z','{\"new_records\":2}','x');
        INSERT INTO acquisition_runs(id,task_id,status,started_at,finished_at,error_message,created_at) VALUES(2,1,'failed','2026-10-31T01:00:00Z','2026-10-31T01:01:00Z','request failed https://upstream/?token=SECRET','x');
        INSERT INTO knowledge_docs(doc_id,source_type,title,metadata_json,updated_at) VALUES('acq_1_hash','information_feed','fixture','{\"acquisition\":{\"taskId\":1}}',0);
        INSERT INTO acquisition_sessions(name,site,runtime_type,credential_json,created_at,updated_at) VALUES('private','example','http','{\"cookie\":\"SECRET\"}','x','x');").unwrap();
    let before = conn.total_changes();
    for _ in 0..2 {
        let value = acquisition_status::snapshot(&state).unwrap();
        let task = &value["tasks"][0];
        assert_eq!(task["status"], "paused");
        assert_eq!(task["latest_run"]["status"], "failed");
        assert_eq!(task["last_success_at"], "2026-10-30T01:01:00Z");
        assert_eq!(task["record_count"], 1);
        assert_eq!(task["target_count"], 0);
        assert_eq!(task["interval"], "5m");
        assert!(!value.to_string().contains("SECRET"));
        assert!(!value.to_string().contains("secret-proxy"));
        assert!(!value.to_string().contains("https://upstream"));
    }
    assert_eq!(conn.total_changes(), before);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM acquisition_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn endpoint_is_read_only_local_no_store_and_empty_is_not_success() {
    let (_dir, state) = setup();
    let router = stock_info_local::router(state, std::path::Path::new("/unused"));
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/local/acquisitions")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap();
    assert_eq!(body["data"]["tasks"], json!([]));
    for (host, origin, method, status) in [
        ("evil.example", "", "GET", 403),
        ("127.0.0.1:18000", "https://evil.example", "GET", 403),
        ("127.0.0.1:18000", "", "POST", 403),
        ("127.0.0.1:18000", "http://127.0.0.1:18000", "POST", 405),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/api/local/acquisitions")
                    .header("host", host)
                    .header("origin", origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
}
