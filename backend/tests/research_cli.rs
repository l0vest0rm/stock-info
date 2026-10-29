use axum::{Json, Router, extract::Query, routing::get};
use serde_json::{Value, json};
use std::collections::HashMap;
use stock_info_local::{AppState, db::Database, research_cli};

#[tokio::test]
async fn native_institutional_snapshot_reads_local_api_and_writes_classified_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("web/src/config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("institutional-track-taxonomy.json"),
        include_str!("../../web/src/config/institutional-track-taxonomy.json"),
    )
    .unwrap();
    let rows=(0..300).map(|i|json!({"SECUCODE":format!("{}.SH",990000+i),"SECURITY_NAME_ABBR":format!("银行{i}"),"ALLCORP_NUM":1000-i,"MAX_TRADE_DATE":"2026-09-30","INDUSTRY":"银行","CONCEPT":["芯片"]})).collect::<Vec<_>>();
    let app = Router::new()
        .route(
            "/api/companies/filter",
            get(move |Query(_): Query<HashMap<String, String>>| {
                let rows = rows.clone();
                async move { Json(json!({"code":200,"data":{"data":rows}})) }
            }),
        )
        .route(
            "/api/companies/change",
            get(|| async { Json(json!({"code":200,"data":{"total":0,"diff":[]}})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let authority = listener.local_addr().unwrap().to_string();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let db = Database::open(dir.path().join("db.sqlite")).unwrap();
    let state = AppState::new(db, dir.path().into(), authority).unwrap();
    let result = research_cli::run(&state, "institutional-tracks", &json!({}))
        .await
        .unwrap();
    assert_eq!(result["rows"], 300);
    let snapshot: Value = serde_json::from_slice(
        &std::fs::read(config.join("institutional-track-snapshot.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["classificationVersion"], 2);
    assert_eq!(snapshot["rows"][0]["secondaryTrack"], "银行");
    assert_eq!(snapshot["rows"][0]["classificationBasis"], "industry");
    assert_eq!(snapshot["rows"][0]["concepts"], json!(["芯片"]));
    assert_eq!(snapshot["rows"][299]["rank"], 300);
    server.abort();
}

#[tokio::test]
async fn remote_api_rejected_before_any_output() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db.sqlite")).unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:8000".into()).unwrap();
    let error = research_cli::run(
        &state,
        "institutional-tracks",
        &json!({"baseUrl":"https://tinfo.cc"}),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("loopback"));
    assert!(!dir.path().join("web").exists());
}
