use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use stock_info_local::{AppState, db, knowledge::ingest};
fn fixture() -> (tempfile::TempDir, AppState, Value) {
    let dir = tempfile::tempdir().unwrap();
    let db = db::Database::open(dir.path().join("db.sqlite")).unwrap();
    db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:9000".into()).unwrap();
    fs::create_dir(dir.path().join("news")).unwrap();
    let config = json!({"database":"stock_info","remote":false,"inputDirs":["news"],"processedDir":"processed","failedDir":"failed","workDir":"work","reviewDir":"reviews","stateDir":"state","eastmoneyReports":{"enabled":false},"maxNewsAgeDays":0,"maxReportAgeDays":0,"llm":{"enabled":false},"topicFilter":{"enabled":true,"mode":"blacklist","blacklistRules":[{"id":"unrelated","titleAll":["空军","联合训练"]}]},"filteredReviewImport":{"enabled":false},"storageRetention":{"enabled":false}});
    (dir, state, config)
}
#[tokio::test]
async fn full_local_pipeline_filters_stores_and_replays_without_duplicates() {
    let (dir, state, config) = fixture();
    fs::write(dir.path().join("news/inbox.jsonl"),[
        json!({"docId":"native-kept","title":"AI GPU 新产品","content":"原始正文\n".repeat(400),"sourceName":"本地","tags":["AI"]}),
        json!({"docId":"native-filtered","title":"空军联合训练","content":"无关报道"}),
        json!({"docId":"native-delegated","title":"单独资讯任务接管","content":"feed","metadata":{"source":"cls_telegraph"}}),
    ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    let result = ingest::process_inboxes(&state, config.clone())
        .await
        .unwrap();
    assert_eq!(result["imported"], 1, "{result}");
    assert_eq!(result["filteredImported"], 0);
    assert_eq!(result["delegatedFeedDocs"], 1);
    assert_eq!(result["skippedByTopic"], 1);
    assert_eq!(
        state
            .db
            .query("SELECT doc_id FROM knowledge_docs", vec![])
            .await
            .unwrap(),
        vec![json!({"doc_id":"native-kept"})]
    );
    let review = stock_info_local::knowledge::review::load_rows(&state).unwrap();
    assert!(
        review
            .iter()
            .any(|row| row["docId"] == "native-filtered" && row["keep"] == false)
    );
    let refs = state
        .db
        .query(
            "SELECT content_key,content_encoding FROM knowledge_doc_content_refs",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["content_encoding"], "br");
    let body = stock_info_local::knowledge::read_content_text(
        &state,
        refs[0]["content_key"].as_str().unwrap(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(body.contains("原始正文"));
    assert!(dir.path().join("state/local-scan-state.json").is_file());
    assert!(
        dir.path()
            .join("state/knowledge-remote-sync.jsonl")
            .is_file()
    );
    assert!(
        dir.path()
            .join("data/knowledge-review/topic-filter-latest.jsonl")
            .is_file()
    );
    let again = ingest::process_inboxes(&state, config).await.unwrap();
    assert_eq!(again["imported"], 0);
    assert_eq!(again["skippedUnchangedFiles"], 1);
    let count = state
        .db
        .query("SELECT count(*) AS n FROM knowledge_docs", vec![])
        .await
        .unwrap();
    assert_eq!(count[0]["n"], 1);
}
#[tokio::test]
async fn malformed_source_is_quarantined_without_dangling_database_records() {
    let (dir, state, config) = fixture();
    fs::write(dir.path().join("news/broken.jsonl"), "{not-json}").unwrap();
    let result = ingest::process_inboxes(&state, config).await.unwrap();
    assert_eq!(result["results"][0]["status"], "failed");
    assert!(!dir.path().join("news/broken.jsonl").exists());
    assert!(dir.path().join("failed/broken.jsonl").exists());
    assert!(dir.path().join("failed/broken.jsonl.error.log").exists());
    let count = state
        .db
        .query("SELECT count(*) AS n FROM knowledge_docs", vec![])
        .await
        .unwrap();
    assert_eq!(count[0]["n"], 0);
}
#[tokio::test]
async fn remote_target_rejected_before_file_or_network_mutation() {
    let (dir, state, mut config) = fixture();
    config["remote"] = json!(true);
    assert!(
        ingest::process_once_with_config(&state, config)
            .await
            .unwrap_err()
            .to_string()
            .contains("retired")
    );
    assert!(!dir.path().join("state").exists());
}
#[tokio::test]
async fn explicit_full_rescan_reuses_import_fingerprint_and_does_not_lose_body() {
    let (dir, state, mut config) = fixture();
    fs::write(dir.path().join("news/a.md"), "# GPU test\n正文").unwrap();
    let first = ingest::process_inboxes(&state, config.clone())
        .await
        .unwrap();
    assert_eq!(first["imported"], 1);
    config["fullRescan"] = json!(true);
    let again = ingest::process_inboxes(&state, config).await.unwrap();
    assert_eq!(again["imported"], 1);
    let count = state
        .db
        .query("SELECT count(*) AS n FROM knowledge_docs", vec![])
        .await
        .unwrap();
    assert_eq!(count[0]["n"], 1);
}
