pub use securities_data::reports::sources::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use serde_json::json;
    const SOURCE_TTL: i64 = 12 * 60 * 60 * 1000;
    #[tokio::test]
    async fn app_cache_preserves_namespace_ttl_and_ignores_malformed_entries() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(temp.path().join("reports.sqlite")).unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        db.migrate(&root.join("migrations")).unwrap();
        let state = AppState::new(db, root, "127.0.0.1:8000".into()).unwrap();
        let key = "company-reports-source:v5:600036.SH";
        assert!(read_app(&state, key).await.unwrap().is_none());
        write_app(&state, key, &json!([{"title":"cached"}]), SOURCE_TTL)
            .await
            .unwrap();
        assert_eq!(
            read_app(&state, key).await.unwrap(),
            Some(json!([{"title":"cached"}]))
        );
        let stored = state
            .db
            .query(
                "SELECT namespace, expires_at FROM kv_cache WHERE key=?",
                vec![key.into()],
            )
            .await
            .unwrap();
        assert_eq!(stored[0]["namespace"], "company_reports_source");
        assert!(stored[0]["expires_at"].as_i64().unwrap() > chrono::Utc::now().timestamp_millis());
        state
            .db
            .execute(
                "UPDATE kv_cache SET value_json='not-json' WHERE key=?",
                vec![key.into()],
            )
            .await
            .unwrap();
        assert!(read_app(&state, key).await.unwrap().is_none());
        state
            .db
            .execute(
                "UPDATE kv_cache SET value_json='[]', expires_at=1 WHERE key=?",
                vec![key.into()],
            )
            .await
            .unwrap();
        assert!(read_app(&state, key).await.unwrap().is_none());
        assert!(write_app(&state, "unknown", &json!({}), 1).await.is_err());
    }
}
