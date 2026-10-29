pub use stock_info_local::{AppState, db};
mod knowledge {
    pub use stock_info_local::knowledge::information_records;
    pub fn object_key(key: &str) -> &str {
        key.strip_prefix("knowledge-content/").unwrap_or(key)
    }
    pub fn local_content_url(state: &crate::AppState, key: &str) -> String {
        format!("http://{}/{key}", state.authority)
    }
}
#[path = "../src/knowledge/ingest/writer.rs"]
mod writer;
use serde_json::{Value, json};
fn fixture() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let db = db::Database::open(dir.path().join("db.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:9000".into()).unwrap();
    (dir, state)
}
#[tokio::test]
async fn import_bodies_aliases_semantics_and_sync() {
    let (_dir, state) = fixture();
    let doc = json!({"docId":"../../恶意'doc","title":"Test ' report","targetCode":"HK00700","targetName":"腾讯控股","markdown":"# Heading\nbody\n".repeat(1000),"tags":["AI","ai","AI"],"publishedAt":"2026-01-01","fetchedAt":"volatile","recommendationScore":9,"metadata":{"inputRelativeFile":"reports/a.md","sourceMtimeMs":123,"sourceSize":55,"stockLinks":[{"code":"SH600519","name":"贵州茅台","aliases":["茅台"]}]}});
    let result = writer::import_documents(&state, std::slice::from_ref(&doc), &json!({}))
        .await
        .unwrap();
    assert_eq!(result["imported"], 1);
    let rows = state
        .db
        .query(
            "SELECT * FROM knowledge_docs WHERE doc_id=?",
            vec![doc["docId"].clone()],
        )
        .await
        .unwrap();
    assert_eq!(rows[0]["target_code"], "00700.HK");
    assert_eq!(rows[0]["rank_score"], 9);
    assert_eq!(rows[0]["sort_time"], "2026-01-01");
    let tags = state
        .db
        .query(
            "SELECT tag FROM knowledge_doc_tags WHERE doc_id=?",
            vec![doc["docId"].clone()],
        )
        .await
        .unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0]["tag"], "ai");
    let links = state
        .db
        .query(
            "SELECT code FROM knowledge_doc_security_links WHERE doc_id=? ORDER BY code",
            vec![doc["docId"].clone()],
        )
        .await
        .unwrap();
    assert_eq!(links.len(), 2);
    let alias = state
        .db
        .query("SELECT code FROM stock_alias WHERE alias='茅台'", vec![])
        .await
        .unwrap();
    assert_eq!(alias[0]["code"], "600519.SH");
    let entry = &result["entries"][0];
    assert_eq!(entry["contentEncoding"], "br");
    assert_eq!(entry["hasR2"], false);
    let key = entry["contentKey"].as_str().unwrap();
    let bytes = state
        .knowledge_store()
        .unwrap()
        .get(knowledge::object_key(key))
        .await
        .unwrap()
        .unwrap();
    let mut decompressed = String::new();
    std::io::Read::read_to_string(
        &mut brotli::Decompressor::new(bytes.as_slice(), 4096),
        &mut decompressed,
    )
    .unwrap();
    assert_eq!(decompressed, doc["markdown"].as_str().unwrap().trim());
    assert!(
        entry["contentUrl"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:9000/knowledge-content/")
    );
    let mut changed = doc.clone();
    changed["fetchedAt"] = "new fetch".into();
    changed["metadata"]["sourceMtimeMs"] = 456.into();
    let skipped = writer::import_documents(
        &state,
        &[changed.clone()],
        &json!({"syncEntries":result["entries"]}),
    )
    .await
    .unwrap();
    assert_eq!(skipped["skipped"], 1);
    changed["summary"] = "material update".into();
    let updated = writer::import_documents(
        &state,
        &[changed],
        &json!({"syncEntries":result["entries"]}),
    )
    .await
    .unwrap();
    assert_eq!(updated["imported"], 1);
}
#[tokio::test]
async fn retired_filtered_sql_import_refuses_without_creating_tables_or_objects() {
    let (_dir, state) = fixture();
    let row = json!({"doc":{"docId":"filtered1","title":"Filtered title","markdown":"content"},"topic":{"score":10},"file":"input/a.md"});
    let err = writer::import_filtered(&state, &[row], &json!({}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("retired by migration 0115"));
    assert!(
        state
            .db
            .query(
                "SELECT name FROM sqlite_master WHERE name LIKE 'knowledge_filtered%'",
                vec![]
            )
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!state.data_dir().join("knowledge-content").exists());
}
#[tokio::test]
async fn invalid_documents_cannot_partially_commit_and_feed_sources_are_rejected() {
    let (_dir, state) = fixture();
    let docs = vec![
        json!({"docId":"good","title":"Good","markdown":"body"}),
        json!({"docId":"bad"}),
    ];
    assert!(
        writer::import_documents(&state, &docs, &json!({}))
            .await
            .is_err()
    );
    assert!(
        state
            .db
            .query("SELECT * FROM knowledge_docs", vec![])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        writer::import_documents(
            &state,
            &[json!({"docId":"feed","title":"Feed","metadata":{"source":"cls_telegraph"}})],
            &json!({})
        )
        .await
        .is_err()
    );
    assert!(
        writer::import_documents(&state, &[], &json!({"remote":true}))
            .await
            .is_err()
    );
}
#[test]
fn fingerprint_only_ignores_transient_fields() {
    let a = json!({"docId":"a","publishedAt":"date","fetchedAt":"a","metadata":{"inputFile":"x","sourceMtimeMs":1},"score":100.0});
    let mut b = a.clone();
    b["fetchedAt"] = "b".into();
    b["metadata"]["sourceMtimeMs"] = 2.into();
    b["score"] = json!(100);
    assert_eq!(
        writer::import_fingerprint(&a),
        writer::import_fingerprint(&b)
    );
    assert_eq!(
        writer::import_fingerprint(&a),
        "sha256:v1:2bb6eca2cb374a523dc491bd049854b4292119420aae9a9e616e5cf1c6dec88b"
    );
    assert_eq!(
        writer::import_fingerprint(
            &json!({"metadata":{"10":3,"2":4,"z":1,"💩":5,"😀":6},"score":0.0000001})
        ),
        "sha256:v1:455a8bc396308ae33d9e5211d4f634ec0c92b2153a8ee82dcd1b71c9b362d80d"
    );
    b["title"] = "new".into();
    assert_ne!(
        writer::import_fingerprint(&a),
        writer::import_fingerprint(&b)
    );
    let a: Value = json!({"fetchedAt":"a"});
    let b = json!({"fetchedAt":"b"});
    assert_ne!(
        writer::import_fingerprint(&a),
        writer::import_fingerprint(&b)
    );
}

#[tokio::test]
async fn transaction_failure_rolls_back_docs_links_and_tags() {
    let (_dir, state) = fixture();
    state.db.execute("CREATE TRIGGER reject_writer_doc BEFORE INSERT ON knowledge_docs WHEN NEW.doc_id='rejected' BEGIN SELECT RAISE(ABORT,'fixture reject'); END", vec![]).await.unwrap();
    let result = writer::import_documents(&state, &[
        json!({"docId":"first","title":"First","targetCode":"AAPL.US","targetName":"Apple","tags":["tag"]}),
        json!({"docId":"rejected","title":"Second"})
    ], &json!({})).await;
    assert!(result.is_err());
    for table in [
        "knowledge_docs",
        "knowledge_doc_tags",
        "knowledge_doc_security_links",
        "knowledge_doc_content_refs",
    ] {
        assert!(
            state
                .db
                .query(format!("SELECT * FROM {table}"), vec![])
                .await
                .unwrap()
                .is_empty()
        );
    }
}
