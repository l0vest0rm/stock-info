use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database, maintenance};

fn fixture() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(root.path().join("main.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, root.path().into(), "127.0.0.1:8000".into()).unwrap();
    (root, state)
}
async fn seed(state: &AppState, id: &str, metadata: Value) {
    state.db.execute("INSERT INTO knowledge_docs(doc_id,source_type,report_type,source_name,title,summary,url,published_at,fetched_at,event_time,target_name,target_code,discovery_method,access_method,content_preview,metadata_json,updated_at) VALUES(?,'research_report','research_report','本地导入','20261029 中信证券 招商银行 600036 盈利改善','','','','2026-10-30','2026-10-30','','','local_process_once','markdown','',?,123)",vec![json!(id),json!(metadata.to_string())]).await.unwrap();
}
#[tokio::test]
async fn dry_run_and_apply_repair_metadata_and_links_then_become_idempotent() {
    let (_dir, state) = fixture();
    seed(&state,"repair",json!({"originalFile":"20261029-中信证券-招商银行-600036-盈利改善.pdf","retained":true,"stockLinks":[{"code":"00700.hk"},{"code":"600036.sh"},{"code":""}]})).await;
    state
        .db
        .execute(
            "INSERT INTO knowledge_doc_security_links(doc_id,code) VALUES('repair','stale')",
            vec![],
        )
        .await
        .unwrap();
    let before = state
        .db
        .query("SELECT * FROM knowledge_docs", vec![])
        .await
        .unwrap();
    let dry = maintenance::run(&state, "pdf-metadata", &json!({}))
        .await
        .unwrap();
    assert_eq!(dry["dryRun"], true);
    assert_eq!(dry["candidates"], 1);
    assert_eq!(dry["updated"], 1);
    assert_eq!(dry["sample"][0]["title"], "盈利改善");
    assert_eq!(
        dry["sample"][0]["securityCodes"],
        json!(["600036.SH", "00700.HK"])
    );
    assert_eq!(
        state
            .db
            .query("SELECT * FROM knowledge_docs", vec![])
            .await
            .unwrap(),
        before
    );
    let applied = maintenance::run(&state, "pdf-metadata", &json!({"apply":true}))
        .await
        .unwrap();
    assert_eq!(applied["dryRun"], false);
    assert_eq!(applied["updated"], 1);
    let row = state
        .db
        .query("SELECT * FROM knowledge_docs WHERE doc_id='repair'", vec![])
        .await
        .unwrap()
        .remove(0);
    for (key, expected) in [
        ("source_name", "中信证券"),
        ("title", "盈利改善"),
        ("summary", "盈利改善"),
        ("published_at", "2026-10-29"),
        ("event_time", "2026-10-29"),
        ("target_name", "招商银行"),
        ("target_code", "600036.SH"),
        ("report_type", "company_report"),
        ("sort_time", "2026-10-29"),
        ("source_name_normalized", "中信证券"),
        ("target_code_normalized", "600036.SH"),
    ] {
        assert_eq!(row[key], expected, "{key}");
    }
    assert_eq!(row["updated_at"], 123);
    let metadata: Value = serde_json::from_str(row["metadata_json"].as_str().unwrap()).unwrap();
    assert_eq!(metadata["retained"], true);
    assert_eq!(metadata["filenameParse"]["targetCode"], "600036.SH");
    assert_eq!(
        state
            .db
            .query(
                "SELECT code FROM knowledge_doc_security_links ORDER BY code",
                vec![]
            )
            .await
            .unwrap(),
        vec![json!({"code":"00700.HK"}), json!({"code":"600036.SH"})]
    );
    let again = maintenance::run(&state, "pdf-metadata", &json!({"apply":true}))
        .await
        .unwrap();
    assert_eq!(again["updated"], 0);
    assert!(again.get("sample").is_none());
}
#[tokio::test]
async fn selection_and_existing_human_fields_preserve_original_sql_boundary() {
    let (_dir, state) = fixture();
    for id in [
        "kept",
        "wrong-source",
        "wrong-discovery",
        "not-pdf",
        "input-only",
        "upper-pdf",
    ] {
        seed(
            &state,
            id,
            json!({"originalFile":"公司-20260231-机构-公司-600036-新标题.pdf"}),
        )
        .await;
    }
    state.db.execute("UPDATE knowledge_docs SET source_name='人工来源',title='人工标题',summary='人工摘要',published_at='2026-01-02',event_time='2026-01-03',target_name='人工对象',target_code='00700.hk',report_type='custom' WHERE doc_id='kept'",vec![]).await.unwrap();
    state
        .db
        .execute(
            "UPDATE knowledge_docs SET source_type='local_news' WHERE doc_id='wrong-source'",
            vec![],
        )
        .await
        .unwrap();
    state
        .db
        .execute(
            "UPDATE knowledge_docs SET discovery_method='other' WHERE doc_id='wrong-discovery'",
            vec![],
        )
        .await
        .unwrap();
    state.db.execute("UPDATE knowledge_docs SET metadata_json='{\"originalFile\":\"file.md\"}' WHERE doc_id='not-pdf'",vec![]).await.unwrap();
    state.db.execute("UPDATE knowledge_docs SET metadata_json='{\"inputFile\":\"20260101-机构-标题.pdf\"}' WHERE doc_id='input-only'",vec![]).await.unwrap();
    state.db.execute("UPDATE knowledge_docs SET metadata_json='{\"originalFile\":\"20260101-机构-标题.PDF\"}' WHERE doc_id='upper-pdf'",vec![]).await.unwrap();
    let before = state
        .db
        .query(
            "SELECT * FROM knowledge_docs WHERE doc_id!='upper-pdf' ORDER BY doc_id",
            vec![],
        )
        .await
        .unwrap();
    let result = maintenance::run(&state, "pdf-metadata", &json!({"apply":true}))
        .await
        .unwrap();
    assert_eq!(result["candidates"], 2);
    assert_eq!(result["updated"], 1);
    assert_eq!(
        state
            .db
            .query(
                "SELECT * FROM knowledge_docs WHERE doc_id!='upper-pdf' ORDER BY doc_id",
                vec![]
            )
            .await
            .unwrap(),
        before
    );
}
#[tokio::test]
async fn one_failed_link_write_rolls_back_metadata_and_all_documents() {
    let (_dir, state) = fixture();
    seed(
        &state,
        "one",
        json!({"originalFile":"20261029-中信证券-招商银行-600036-盈利改善.pdf"}),
    )
    .await;
    seed(
        &state,
        "two",
        json!({"originalFile":"20261029-中信证券-招商银行-600036-盈利改善.pdf"}),
    )
    .await;
    let before = state
        .db
        .query("SELECT * FROM knowledge_docs ORDER BY doc_id", vec![])
        .await
        .unwrap();
    state.db.run(|conn|{conn.execute_batch("CREATE TRIGGER reject_repair_link BEFORE INSERT ON knowledge_doc_security_links WHEN NEW.doc_id='two' BEGIN SELECT RAISE(ABORT,'forced repair failure'); END;")?;Ok(())}).await.unwrap();
    assert!(
        maintenance::run(&state, "pdf-metadata", &json!({"apply":true}))
            .await
            .is_err()
    );
    assert_eq!(
        state
            .db
            .query("SELECT * FROM knowledge_docs ORDER BY doc_id", vec![])
            .await
            .unwrap(),
        before
    );
    assert!(
        state
            .db
            .query("SELECT * FROM knowledge_doc_security_links", vec![])
            .await
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn explicit_database_is_existing_only_and_does_not_change_default_database() {
    let (dir, state) = fixture();
    let other = Database::open(dir.path().join("other.sqlite")).unwrap();
    other
        .migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let other_state = AppState::new(other, dir.path().into(), "127.0.0.1:8000".into()).unwrap();
    seed(
        &other_state,
        "explicit",
        json!({"originalFile":"20261029-中信证券-招商银行-600036-盈利改善.pdf"}),
    )
    .await;
    let dry = maintenance::run(&state, "pdf-metadata", &json!({"dbFile":"other.sqlite"}))
        .await
        .unwrap();
    assert_eq!(dry["updated"], 1);
    assert!(
        dry["databaseFile"]
            .as_str()
            .unwrap()
            .ends_with("other.sqlite")
    );
    maintenance::run(
        &state,
        "pdf-metadata",
        &json!({"dbFile":"other.sqlite","apply":true}),
    )
    .await
    .unwrap();
    assert!(
        state
            .db
            .query("SELECT * FROM knowledge_docs", vec![])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        other_state
            .db
            .query("SELECT title FROM knowledge_docs", vec![])
            .await
            .unwrap()[0]["title"],
        "盈利改善"
    );
    assert!(
        maintenance::run(
            &state,
            "pdf-metadata",
            &json!({"dbFile":"missing.sqlite","apply":true})
        )
        .await
        .is_err()
    );
    assert!(!dir.path().join("missing.sqlite").exists());
    rusqlite::Connection::open(dir.path().join("empty.sqlite")).unwrap();
    assert!(
        maintenance::run(&state, "pdf-metadata", &json!({"dbFile":"empty.sqlite"}))
            .await
            .is_err()
    );
    assert!(
        maintenance::run(&state, "pdf-metadata", &json!({"remote":true,"apply":true}))
            .await
            .is_err()
    );
}
