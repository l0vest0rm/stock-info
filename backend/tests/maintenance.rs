use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database, maintenance};
fn setup() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(root.path().join("stock-info.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, root.path().into(), "127.0.0.1:8000".into()).unwrap();
    std::fs::create_dir_all(root.path().join("config/knowledge")).unwrap();
    std::fs::write(root.path().join("config/knowledge/knowledge-processing.json"),json!({"reviewDir":"data/knowledge-review","topicFilter":{"enabled":true,"mode":"blacklist","bypassSourceTypes":["research_report"],"marketOverrideKeywords":["股票"],"blacklistRules":[{"id":"military","titleAll":["空军","联合训练"]}]}}).to_string()).unwrap();
    (root, state)
}
async fn import(state: &AppState, docs: Value) {
    let docs = docs.as_array().unwrap();
    stock_info_local::knowledge::ingest::writer::import_documents(state, docs, &json!({}))
        .await
        .unwrap();
}
#[tokio::test]
async fn remote_flags_and_unknown_operations_fail_before_mutation() {
    let (_dir, state) = setup();
    let before = state
        .db
        .query(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    for op in [
        "import-docs",
        "cleanup-docs",
        "cleanup-content",
        "migrate-localfs",
        "refresh-eastmoney-cookie",
    ] {
        assert!(
            maintenance::run(&state, op, &json!({"remote":true,"apply":true}))
                .await
                .is_err()
        );
    }
    assert!(
        maintenance::run(&state, "unknown", &json!({}))
            .await
            .is_err()
    );
    assert_eq!(
        state
            .db
            .query(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                vec![]
            )
            .await
            .unwrap(),
        before
    );
}
#[tokio::test]
async fn import_documents_sync_dedupes_and_filtered_reviews_never_recreate_sql_tables() {
    let (dir, state) = setup();
    let docs = dir.path().join("docs.jsonl");
    std::fs::write(&docs,"{\"docId\":\"one\",\"title\":\"Example\",\"sourceType\":\"research_report\",\"mdText\":\"# Evidence\"}\n").unwrap();
    let options = json!({"file":"docs.jsonl","syncFile":"sync.jsonl"});
    let first = maintenance::run(&state, "import-docs", &options)
        .await
        .unwrap();
    assert_eq!(first["imported"], 1);
    let second = maintenance::run(&state, "import-docs", &options)
        .await
        .unwrap();
    assert_eq!(second["skippedSynced"], 1);
    let review = maintenance::run(&state, "import-filtered", &json!({"file":"docs.jsonl"}))
        .await
        .unwrap();
    assert_eq!(review["imported"], 1);
    let loaded = stock_info_local::knowledge::review::load_rows(&state).unwrap();
    assert_eq!(loaded[0]["docId"], "one");
    assert_eq!(loaded[0]["content"], "# Evidence");
    assert!(
        state
            .db
            .query(
                "SELECT name FROM sqlite_master WHERE name='knowledge_filtered_docs'",
                vec![]
            )
            .await
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn retention_dry_run_preserves_docs_then_apply_cascades_refs_not_durable_ledgers() {
    let (_dir, state) = setup();
    import(&state,json!([{"docId":"old","title":"Old","sourceType":"local_news","publishedAt":"2000-01-01T00:00:00Z","mdText":"Old evidence"},{"docId":"timeless","title":"Timeless","sourceType":"local_news"}])).await;
    for namespace in ["private-active-portfolio-v1", "observation-ledger-v1"] {
        state
            .db
            .put_kv(namespace, "fixture", &json!({"keep":true}), None)
            .await
            .unwrap();
    }
    let dry = maintenance::run(
        &state,
        "cleanup-docs",
        &json!({"maxAgeDays":90,"skipRunRecord":true}),
    )
    .await
    .unwrap();
    assert_eq!(dry["expiredDocs"], 1);
    assert_eq!(dry["deletedDocs"], 0);
    let result = maintenance::run(
        &state,
        "cleanup-docs",
        &json!({"maxAgeDays":90,"apply":true}),
    )
    .await
    .unwrap();
    assert_eq!(result["deletedDocs"], 1);
    assert_eq!(
        state
            .db
            .query("SELECT doc_id FROM knowledge_docs", vec![])
            .await
            .unwrap(),
        vec![json!({"doc_id":"timeless"})]
    );
    assert!(
        state
            .db
            .query("SELECT doc_id FROM knowledge_doc_content_refs", vec![])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        state
            .db
            .query("SELECT namespace FROM kv_cache WHERE key='fixture'", vec![])
            .await
            .unwrap()
            .len(),
        2
    );
}
#[tokio::test]
async fn localfs_migration_keeps_document_metadata_and_original_file() {
    let (dir, state) = setup();
    import(&state,json!([{"docId":"oldfs","title":"Original title","sourceType":"research_report","mdText":"Temporary"}])).await;
    let markdown = dir.path().join("source.md");
    std::fs::write(&markdown, "# Local evidence\nPreserve original.").unwrap();
    let localfs = format!("localfs:{}", markdown.display());
    state
        .db
        .execute(
            "UPDATE knowledge_doc_content_refs SET content_key=? WHERE doc_id='oldfs'",
            vec![localfs.clone().into()],
        )
        .await
        .unwrap();
    let dry = maintenance::run(&state, "migrate-localfs", &json!({}))
        .await
        .unwrap();
    assert_eq!(dry["updated"], 1);
    assert_eq!(
        state
            .db
            .query(
                "SELECT content_key FROM knowledge_doc_content_refs WHERE doc_id='oldfs'",
                vec![]
            )
            .await
            .unwrap()[0]["content_key"],
        localfs
    );
    let changed = maintenance::run(&state, "migrate-localfs", &json!({"apply":true}))
        .await
        .unwrap();
    assert_eq!(changed["updated"], 1);
    let row = &state
        .db
        .query(
            "SELECT content_key FROM knowledge_doc_content_refs WHERE doc_id='oldfs'",
            vec![],
        )
        .await
        .unwrap()[0];
    assert!(
        row["content_key"]
            .as_str()
            .unwrap()
            .starts_with("knowledge-content/")
    );
    assert_eq!(
        stock_info_local::knowledge::read_content_text(
            &state,
            row["content_key"].as_str().unwrap()
        )
        .await
        .unwrap()
        .unwrap(),
        "# Local evidence\nPreserve original."
    );
    assert_eq!(
        state
            .db
            .query(
                "SELECT title FROM knowledge_docs WHERE doc_id='oldfs'",
                vec![]
            )
            .await
            .unwrap()[0]["title"],
        "Original title"
    );
    assert!(markdown.is_file());
}
#[tokio::test]
async fn content_cleanup_keeps_referenced_objects_and_restricts_featured_lifecycle() {
    let (dir, state) = setup();
    import(&state,json!([{"docId":"referenced","title":"Document","sourceType":"research_report","mdText":"Evidence"}])).await;
    let root = dir.path().join("data/local/knowledge-content");
    std::fs::write(root.join("orphan.md"), "old orphan").unwrap();
    let dry = maintenance::run(
        &state,
        "cleanup-content",
        &json!({"minAgeDays":0,"skipRunRecord":true}),
    )
    .await
    .unwrap();
    assert_eq!(dry["orphanObjects"], 1);
    assert_eq!(dry["deletedObjects"], 0);
    assert!(root.join("orphan.md").is_file());
    let changed = maintenance::run(
        &state,
        "cleanup-content",
        &json!({"minAgeDays":0,"apply":true}),
    )
    .await
    .unwrap();
    assert_eq!(changed["deletedObjects"], 1);
    assert_eq!(changed["missingRefs"], 0);
    assert!(!root.join("orphan.md").exists());
    assert!(
        maintenance::run(
            &state,
            "cleanup-content",
            &json!({"prefix":"featured-reports/","apply":true})
        )
        .await
        .is_err()
    );
    assert!(
        maintenance::run(
            &state,
            "cleanup-content",
            &json!({"prefix":"knowledge-content/../","apply":true})
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn historical_filter_retains_review_body_and_market_bypass() {
    let (_dir, state) = setup();
    import(&state,json!([{"docId":"blocked","title":"空军联合训练","sourceType":"local_news","mdText":"# Verifiable original"},{"docId":"market","title":"股票 空军联合训练","sourceType":"local_news"},{"docId":"report","title":"空军联合训练","sourceType":"research_report"}])).await;
    let dry = maintenance::run(&state, "filter-existing", &json!({}))
        .await
        .unwrap();
    assert_eq!(dry["filtered"], 1);
    assert_eq!(
        state
            .db
            .query("SELECT doc_id FROM knowledge_docs", vec![])
            .await
            .unwrap()
            .len(),
        3
    );
    let changed = maintenance::run(&state, "filter-existing", &json!({"apply":true}))
        .await
        .unwrap();
    assert_eq!(changed["filtered"], 1);
    assert_eq!(
        state
            .db
            .query("SELECT doc_id FROM knowledge_docs", vec![])
            .await
            .unwrap()
            .len(),
        2
    );
    let review = stock_info_local::knowledge::review::load_rows(&state).unwrap();
    assert_eq!(review[0]["docId"], "blocked");
    assert_eq!(review[0]["content"], "# Verifiable original");
}
#[tokio::test]
async fn storage_stats_reads_real_sqlite_and_local_objects() {
    let (_dir, state) = setup();
    import(&state,json!([{"docId":"stats","title":"Stats","sourceType":"research_report","mdText":"# Metrics"}])).await;
    let stats = maintenance::run(&state, "storage-stats", &json!({}))
        .await
        .unwrap();
    assert!(stats["sqlite"]["totalBytes"].as_i64().unwrap() > 0);
    assert_eq!(stats["localContent"]["objects"], 1);
    assert_eq!(stats["categories"][0]["rowCount"], 1);
}
#[cfg(unix)]
#[tokio::test]
async fn content_cleanup_rejects_symlink_objects_without_deletion() {
    let (dir, state) = setup();
    let root = dir.path().join("objects");
    std::fs::create_dir(&root).unwrap();
    let secret = dir.path().join("private.txt");
    std::fs::write(&secret, "private").unwrap();
    std::os::unix::fs::symlink(&secret, root.join("orphan.md")).unwrap();
    assert!(
        maintenance::run(
            &state,
            "cleanup-content",
            &json!({"contentDir":root,"minAgeDays":0,"apply":true})
        )
        .await
        .is_err()
    );
    assert!(secret.is_file());
}
