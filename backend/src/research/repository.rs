//! Durable report projections in the existing kv_cache. Expiry is deliberately
//! ignored for reads and cleared on writes: these are records, not cache entries.
use crate::db::Database;
use anyhow::Result;
use serde_json::{Value, json};

pub async fn read(db: &Database, namespace: &str, key: &str) -> Result<Option<Value>> {
    let rows = db
        .query(
            "SELECT value_json FROM kv_cache WHERE namespace=? AND key=?",
            vec![namespace.into(), key.trim().to_uppercase().into()],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|row| row["value_json"].as_str())
        .and_then(|s| serde_json::from_str(s).ok()))
}

pub async fn save(
    db: &Database,
    namespace: &str,
    key: &str,
    value: &Value,
    expected: Option<&Value>,
) -> Result<()> {
    let mut value = value.clone();
    value["storageVersion"] = json!(1);
    value["retention"] = json!("durable");
    let serialized = serde_json::to_string(&value)?;
    let now = chrono::Utc::now().timestamp_millis();
    if let Some(expected) = expected {
        db.execute("UPDATE kv_cache SET value_json=?,expires_at=NULL,updated_at=? WHERE namespace=? AND key=? AND json_extract(value_json,'$.task.name') IS ? AND json_extract(value_json,'$.task.createdAt') IS ? AND json_extract(value_json,'$.task.updatedAt') IS ? AND json_extract(value_json,'$.task.taskId') IS ? AND json_extract(value_json,'$.projectedAt') IS ?",
            vec![serialized.into(),now.into(),namespace.into(),key.trim().to_uppercase().into(),expected["task"]["name"].clone(),expected["task"]["createdAt"].clone(),expected["task"]["updatedAt"].clone(),expected["task"]["taskId"].clone(),expected["projectedAt"].clone()]).await?;
    } else {
        db.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,expires_at=NULL,updated_at=excluded.updated_at WHERE coalesce(json_extract(excluded.value_json,'$.task.createdAt'),0)>coalesce(json_extract(kv_cache.value_json,'$.task.createdAt'),0) OR (coalesce(json_extract(excluded.value_json,'$.task.createdAt'),0)=coalesce(json_extract(kv_cache.value_json,'$.task.createdAt'),0) AND coalesce(json_extract(excluded.value_json,'$.task.taskId'),0)>=coalesce(json_extract(kv_cache.value_json,'$.task.taskId'),0) AND coalesce(json_extract(excluded.value_json,'$.task.updatedAt'),0)>=coalesce(json_extract(kv_cache.value_json,'$.task.updatedAt'),0))",
            vec![namespace.into(),key.trim().to_uppercase().into(),serialized.into(),now.into()]).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stale_observation_cannot_replace_new_submission_or_result() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("records.sqlite")).unwrap();
        db.migrate(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let old = json!({"task":{"taskId":1,"name":"report:AAPL.US","createdAt":1,"updatedAt":1},"projectedAt":null,"markdown":null});
        let next = json!({"task":{"taskId":2,"name":"report:AAPL.US","createdAt":2,"updatedAt":2},"projectedAt":null,"markdown":null});
        save(&db, "research_financial_analysis", "aapl.us", &old, None)
            .await
            .unwrap();
        save(&db, "research_financial_analysis", "aapl.us", &next, None)
            .await
            .unwrap();
        save(
            &db,
            "research_financial_analysis",
            "aapl.us",
            &json!({"markdown":"stale","task":old["task"]}),
            Some(&old),
        )
        .await
        .unwrap();
        let stored = read(&db, "research_financial_analysis", "AAPL.US")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored["task"]["taskId"], 2);
        assert_eq!(stored["markdown"], Value::Null);
        assert_eq!(stored["retention"], "durable");
        save(&db, "research_financial_analysis", "AAPL.US", &old, None)
            .await
            .unwrap();
        assert_eq!(
            read(&db, "research_financial_analysis", "AAPL.US")
                .await
                .unwrap()
                .unwrap(),
            stored
        );
        let expiry = db
            .query(
                "SELECT expires_at FROM kv_cache WHERE namespace='research_financial_analysis'",
                vec![],
            )
            .await
            .unwrap();
        assert!(expiry[0]["expires_at"].is_null());
    }
}
