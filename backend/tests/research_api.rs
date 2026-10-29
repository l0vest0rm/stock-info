use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use stock_info_local::{
    AppState,
    db::Database,
    research::{self, repository},
};
use tower::ServiceExt;

async fn decode(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn analysis_pages_read_existing_records_without_scheduling_or_provider_calls() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("research.sqlite")).unwrap();
    db.migrate(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(
        db.clone(),
        dir.path().to_path_buf(),
        "127.0.0.1:8000".into(),
    )
    .unwrap();
    let app = Router::new()
        .nest("/api", research::routes())
        .with_state(state);
    let stored = json!({"snapshotJson":"{\"securityCode\":\"600036.SH\",\"schemaVersion\":\"financial-analysis-input.v1\",\"codeVersion\":\"financial-analysis-code.v7\"}","markdown":"existing published report","citationsJson":"[]","sourcesJson":"[]","terminalEvidenceJson":"{}","projectedAt":10,"pendingProjection":true,"task":{"taskId":1,"name":"research:financial-analysis:600036.SH","status":"running","createdAt":1,"updatedAt":2,"completedAt":null,"errorMessage":null}});
    repository::save(
        &db,
        "research_financial_analysis",
        "600036.SH",
        &stored,
        None,
    )
    .await
    .unwrap();
    let before=db.query("SELECT namespace,key,value_json,expires_at,updated_at FROM kv_cache ORDER BY namespace,key",vec![]).await.unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/research/company/600036.SH/financial-analysis")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = decode(response).await;
    assert_eq!(body["data"]["availability"], "available");
    assert_eq!(
        body["data"]["report"]["markdown"],
        "existing published report"
    );
    assert_eq!(body["data"]["reportVersion"]["status"], "current");
    assert_eq!(body["data"]["task"]["status"], "running");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/research/company/600036.SH/investment-analysis")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = decode(response).await;
    assert_eq!(body["data"]["availability"], "empty");
    assert!(body["data"]["report"].is_null());
    assert_eq!(db.query("SELECT namespace,key,value_json,expires_at,updated_at FROM kv_cache ORDER BY namespace,key",vec![]).await.unwrap(),before);
    assert_eq!(
        db.query("SELECT count(*) AS count FROM http_cache", vec![])
            .await
            .unwrap()[0]["count"],
        0
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/research/company/UNSUPPORTED/financial-analysis")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(decode(response).await["data"], Value::Null);
}
