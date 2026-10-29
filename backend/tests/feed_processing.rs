//! End-to-end native ingest/dedupe with disposable historical SQLite and local content.
use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database, feed_processing};
#[tokio::test]
async fn native_ingest_is_idempotent_and_does_not_extract_or_publish() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    std::fs::create_dir_all(root.join("config/knowledge")).unwrap();
    for file in ["information-feed-policy.json", "information-feed.json"] {
        std::fs::copy(
            project.join("config/knowledge").join(file),
            root.join("config/knowledge").join(file),
        )
        .unwrap();
    }
    let db = Database::open(root.join("fixture.sqlite")).unwrap();
    db.migrate(&project.join("migrations")).unwrap();
    let state = AppState::new(db.clone(), root.into(), "127.0.0.1:18081".into()).unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let input = root.join("feed.json");
    std::fs::write(&input,json!([{"sourceKey":"cls_telegraph","id":"test-1","title":"美联储宣布降息","body":"美联储宣布降息25个基点，新的利率政策今天实施。","publishedAt":now,"fetchedAt":now}]).to_string()).unwrap();
    let options = json!({"mode":"ingest","file":input});
    let first = feed_processing::process(&state, options.clone())
        .await
        .unwrap();
    assert_eq!(first["new"], 1, "{first}");
    assert_eq!(first["tagged"], 0);
    let second = feed_processing::process(&state, options).await.unwrap();
    assert_eq!(second["repeat"], 1, "{second}");
    let rows = db
        .query(
            "select metadata_json from knowledge_docs where source_type='information_feed'",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    let meta: Value = serde_json::from_str(rows[0]["metadata_json"].as_str().unwrap()).unwrap();
    assert_eq!(meta["informationExtraction"]["status"], "pending");
    assert!(meta["feed"]["publishedFingerprint"].is_null());
    let records = db
        .query(
            "select count(*) n from knowledge_information_records",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(records[0]["n"], 0);
    let result = feed_processing::backfill_relevance(&state, json!({"apply":false}))
        .await
        .unwrap();
    assert_eq!(result["counts"]["scanned"], 1);
}
#[tokio::test]
async fn invalid_options_fail_before_lock_or_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("fixture.sqlite")).unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:18082".into()).unwrap();
    assert!(
        feed_processing::process(&state, json!({"mode":"ingest","maxAgeHours":49}))
            .await
            .is_err()
    );
    assert!(!dir.path().join("data/local/information-feed.lock").exists());
}
