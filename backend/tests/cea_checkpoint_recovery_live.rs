//! Explicit original-checkpoint recovery. Reads an exported run/binding snapshot,
//! never opens the user's DB. Writes only isolated SQLite plus that run's original
//! SDK artifact directory (whose identity must remain unchanged). No submission.
use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database, web_workflow};

#[tokio::test]
#[ignore = "requires explicit CEA_LIVE_RUN_SNAPSHOT and logged-in original Profile; writes original SDK result artifacts"]
async fn recover_original_company_checkpoint_in_isolation() {
    let snapshot = std::env::var("CEA_LIVE_RUN_SNAPSHOT").unwrap();
    let snapshot: Value = serde_json::from_slice(&std::fs::read(snapshot).unwrap()).unwrap();
    let run = &snapshot["run"];
    assert_eq!(run["status"], "failed");
    assert_eq!(run["binding"]["namespace"], "company_report_discovery");
    let original_checkpoint = run["checkpoint"].clone();
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("isolated.sqlite")).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    db.migrate(&root.join("migrations")).unwrap();
    let id = run["runId"].as_str().unwrap();
    let key = run["binding"]["key"].as_str().unwrap();
    db.put_kv(web_workflow::RUNS, id, run, None).await.unwrap();
    db.put_kv("company_report_discovery", key, &snapshot["binding"], None)
        .await
        .unwrap();
    let state = AppState::new(db.clone(), root.into(), "127.0.0.1:18099".into()).unwrap();
    assert_eq!(state.setting("LLM_RUNTIME"), "local");
    assert!(
        web_workflow::recover_with_status(&state, run, &["failed"])
            .await
            .unwrap()
            .1
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(180),
        web_workflow::tick(&state),
    )
    .await
    .unwrap()
    .unwrap();
    let recovered = db.get_kv(web_workflow::RUNS, id).await.unwrap().unwrap();
    assert_eq!(
        recovered["status"], "succeeded",
        "{}",
        recovered["errorMessage"]
    );
    assert_eq!(
        recovered["checkpoint"]["fingerprint"],
        original_checkpoint["fingerprint"]
    );
    let disk_checkpoint: Value = serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(run["directory"].as_str().unwrap())
                .join("output/workflow-state.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        disk_checkpoint["fingerprint"],
        original_checkpoint["fingerprint"]
    );
    assert_eq!(
        disk_checkpoint["locator_updates"]["answer_body"]["from_css"],
        "[data-markdown-text-style='assistant-message']"
    );
    assert!(web_workflow::extract_result(&recovered["result"]).is_ok());
    let capability = stock_info_local::company::reports::capability(&state, key)
        .await
        .unwrap();
    assert_eq!(capability["task"]["status"], "completed");
    let projected = db
        .get_kv("company_report_discovery", key)
        .await
        .unwrap()
        .unwrap();
    assert!(projected["report"]["projection"]["reportsFound"].is_number());
    // Prove the browser receipt passed the existing business validator, then
    // read the same projection through the actual API without providers.
    use tower::ServiceExt;
    let app = stock_info_local::router(state, root);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!(
                    "/api/company/reports/discovery-capability?code={key}"
                ))
                .header("host", "127.0.0.1:18099")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["data"]["task"]["status"], "completed");
    println!(
        "{}",
        json!({"isolatedBusinessValidation":"passed","apiRead":"passed","reportsFound":projected["report"]["projection"]["reportsFound"]})
    );
}
