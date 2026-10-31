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

#[test]
fn safe_shutdown_is_not_reported_as_a_provider_failure() {
    let (_dir, state) = setup();
    let conn = state.db.connect().unwrap();
    conn.execute_batch("INSERT INTO acquisition_tasks(id,name,status,flow_id,config_json,created_at,updated_at) VALUES(1,'example','active','example','{}','x','x');
        INSERT INTO acquisition_runs(task_id,status,started_at,finished_at,error_message,metadata_json,created_at) VALUES(1,'interrupted','x','y','shutdown requested; SECRET checkpoint details','{\"new_records\":4}','x');").unwrap();
    let value = acquisition_status::snapshot(&state).unwrap();
    let run = &value["tasks"][0]["latest_run"];
    assert_eq!(run["status"], "interrupted");
    assert_eq!(run["new_records"], 4);
    assert!(run["issue"].as_str().unwrap().contains("安全检查点续跑"));
    assert!(!value.to_string().contains("SECRET"));
    assert_eq!(value["tasks"][0]["last_success_at"], Value::Null);
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

#[tokio::test]
async fn interval_settings_are_private_validated_and_preserve_task_state() {
    let (_dir, state) = setup();
    state.db.connect().unwrap().execute_batch("INSERT INTO acquisition_tasks(id,name,status,flow_id,config_json,state_json,created_at,updated_at) VALUES(1,'example','paused','example','{\"session\":\"PRIVATE\",\"proxy\":\"PRIVATE\"}','{\"cursor\":42}','x','x');").unwrap();
    let router = stock_info_local::router(state.clone(), std::path::Path::new("/unused"));
    for (id, host, origin, body, status) in [
        (
            1,
            "evil.example",
            "http://evil.example",
            json!({"interval_minutes":30}),
            403,
        ),
        (
            1,
            "127.0.0.1:18000",
            "http://evil.example",
            json!({"interval_minutes":30}),
            403,
        ),
        (
            1,
            "127.0.0.1:18000",
            "",
            json!({"interval_minutes":30}),
            403,
        ),
        (
            1,
            "127.0.0.1:18000",
            "http://127.0.0.1:18000",
            json!({"interval_minutes":0}),
            400,
        ),
        (
            1,
            "127.0.0.1:18000",
            "http://127.0.0.1:18000",
            json!({"interval_minutes":10081}),
            400,
        ),
        (
            1,
            "127.0.0.1:18000",
            "http://127.0.0.1:18000",
            json!({"interval_minutes":1.5}),
            422,
        ),
        (
            1,
            "127.0.0.1:18000",
            "http://127.0.0.1:18000",
            json!({"interval_minutes":30,"status":"active"}),
            422,
        ),
        (
            999,
            "127.0.0.1:18000",
            "http://127.0.0.1:18000",
            json!({"interval_minutes":30}),
            404,
        ),
        (
            1,
            "127.0.0.1:18000",
            "http://127.0.0.1:18000",
            json!({"interval_minutes":30}),
            200,
        ),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/local/acquisitions/{id}/interval"))
                    .header("host", host)
                    .header("origin", origin)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        let text = String::from_utf8(
            to_bytes(response.into_body(), 10000)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(!text.contains("PRIVATE"));
    }
    let value = acquisition_status::snapshot(&state).unwrap();
    assert_eq!(value["tasks"][0]["interval"], "30m");
    assert_eq!(value["tasks"][0]["status"], "paused");
    let conn = state.db.connect().unwrap();
    let config: String = conn
        .query_row(
            "SELECT config_json FROM acquisition_tasks WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&config).unwrap(),
        json!({"interval":"30m","session":"PRIVATE","proxy":"PRIVATE"})
    );
    let cursor: String = conn
        .query_row(
            "SELECT state_json FROM acquisition_tasks WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cursor, "{\"cursor\":42}");
    assert_eq!(
        conn.query_row("SELECT count(*) FROM acquisition_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn default_interval_and_next_due_are_based_on_attempt_start_not_completion() {
    let settings: acquisition::control::TaskSettings = serde_json::from_value(json!({})).unwrap();
    assert_eq!(settings.interval, "30m");
    assert_eq!(acquisition::config::Schedule::default().interval, "30m");
    let (_dir, state) = setup();
    state.db.connect().unwrap().execute_batch("INSERT INTO acquisition_tasks(id,name,status,flow_id,config_json,last_run_at,created_at,updated_at) VALUES(1,'example','active','example','{}','2026-10-31T01:10:00Z','x','x');
        INSERT INTO acquisition_runs(task_id,status,started_at,finished_at,created_at) VALUES(1,'failed','2026-10-31T01:00:00Z','2026-10-31T01:10:00Z','x');").unwrap();
    let value = acquisition_status::snapshot(&state).unwrap();
    assert_eq!(value["tasks"][0]["interval"], "30m");
    assert_eq!(
        value["tasks"][0]["next_run_at"],
        "2026-10-31T01:30:00+00:00"
    );
    assert_eq!(
        acquisition_runtime_store_start(&state).to_rfc3339(),
        "2026-10-31T01:00:00+00:00"
    );
}
fn acquisition_runtime_store_start(state: &AppState) -> chrono::DateTime<chrono::Utc> {
    stock_info_local::acquisition_runtime::store(state)
        .unwrap()
        .last_started_at("example")
        .unwrap()
        .unwrap()
}

#[test]
fn imported_history_without_run_records_uses_last_run_and_never_run_stays_unset() {
    let (_dir, state) = setup();
    state.db.connect().unwrap().execute_batch("INSERT INTO acquisition_tasks(id,name,status,flow_id,config_json,last_run_at,created_at,updated_at) VALUES(1,'imported','active','fixture','{}','2026-10-31 01:00:00','x','x'),(2,'new','active','fixture','{}',NULL,'x','x');").unwrap();
    let store = stock_info_local::acquisition_runtime::store(&state).unwrap();
    assert_eq!(
        store
            .last_started_at("imported")
            .unwrap()
            .unwrap()
            .to_rfc3339(),
        "2026-10-31T01:00:00+00:00"
    );
    assert!(store.last_started_at("new").unwrap().is_none());
    assert!(store.last_started_at("missing").unwrap().is_none());
    let value = acquisition_status::snapshot(&state).unwrap();
    assert_eq!(
        value["tasks"][0]["next_run_at"],
        "2026-10-31T01:30:00+00:00"
    );
    assert!(value["tasks"][1]["next_run_at"].is_null());
}
