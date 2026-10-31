use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database, router, web_workflow};
use tower::ServiceExt;

#[test]
fn local_workflow_api_contract_in_isolated_process() {
    let dir = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "workflow_contract_child", "--nocapture"])
        .env("WEB_WORKFLOW_CONTRACT_CHILD", "1")
        .env("LLM_RUNTIME", "local")
        .env("LOCAL_DATA_DIR", dir.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn workflow_contract_child() {
    if std::env::var("WEB_WORKFLOW_CONTRACT_CHILD").is_err() {
        return;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = std::path::PathBuf::from(std::env::var("LOCAL_DATA_DIR").unwrap());
    let db = Database::open(path.join("isolated.sqlite")).unwrap();
    db.migrate(&root.join("migrations")).unwrap();
    let state = AppState::new(db.clone(), root.into(), "127.0.0.1:18099".into()).unwrap();
    let app = router(state.clone(), root);
    for name in [
        "research:financial-analysis:300308.SZ",
        "research:investment-analysis:300308.SZ",
        "macro:analysis:global",
        "company:report-discovery:300308.SZ",
    ] {
        // Admission alone must not open a browser or invoke a provider.
        let run = web_workflow::submit_report(
            &state,
            &json!({"name":name,"prompt":"private-contract-marker","reasoningEffort":"xhigh"}),
        )
        .await
        .unwrap();
        let id = run["runId"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(id).is_ok());
        assert_eq!(run["taskId"], run["runId"]);
        assert!(run["checkpoint"].is_null());
        let before = db.get_kv(web_workflow::RUNS, id).await.unwrap().unwrap();
        let uri = format!("/api/research/web-workflows/{id}");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header("host", "127.0.0.1:18099")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["data"]["task"]["runId"], id);
        for private in [
            "private-contract-marker",
            "workflowSnapshot",
            "inputFingerprint",
            "directory",
            "variables",
            "endpoint",
            "checkpoint",
        ] {
            assert!(
                !String::from_utf8_lossy(&bytes).contains(private),
                "leaked {private}"
            );
        }
        assert_eq!(
            before,
            db.get_kv(web_workflow::RUNS, id).await.unwrap().unwrap()
        );
        for (host, origin) in [
            ("evil.test", "http://evil.test"),
            ("127.0.0.1:18099", "http://evil.test"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(&uri)
                        .header("host", host)
                        .header("origin", origin)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("{uri}/cancel"))
                    .header("host", "127.0.0.1:18099")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["data"]["providerRequestRetracted"], false);
        assert_eq!(
            db.get_kv(web_workflow::RUNS, id).await.unwrap().unwrap()["status"],
            "interrupted"
        );
    }
}
