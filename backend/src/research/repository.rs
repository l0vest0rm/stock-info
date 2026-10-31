//! Durable report projections in the existing kv_cache. Expiry is deliberately
//! ignored for reads and cleared on writes: these are records, not cache entries.
use crate::db::Database;
use anyhow::Result;
use serde_json::{Value, json};

/// A terminal execution cannot change without a new revision. Avoid rewriting
/// large failed projections on every local worker tick; explicit recovery bumps
/// the revision, including receipt-only retries after business rejection.
pub async fn unchanged_failed_execution(db: &Database, task: &Value) -> Result<bool> {
    let Some(id) = task["runId"].as_str() else {
        return Ok(false);
    };
    if task["status"] != "failed" {
        return Ok(false);
    }
    Ok(db
        .get_kv(crate::web_workflow::RUNS, id)
        .await?
        .is_some_and(|run| {
            matches!(run["status"].as_str(), Some("failed" | "succeeded"))
                && run["revision"] == task["revision"]
        }))
}

/// Provider completion and business acceptance are separate outcomes. Retain
/// the raw successful receipt, but expose a terminal business failure rather
/// than a stale running state when the original report validator rejects it.
pub async fn projection_failed_task(db: &Database, expected: &Value, error: &str) -> Result<Value> {
    let Some(id) = expected["runId"].as_str() else {
        return Ok(expected.clone());
    };
    let Some(run) = db.get_kv(crate::web_workflow::RUNS, id).await? else {
        return Ok(expected.clone());
    };
    if run["status"] != "succeeded" {
        return Ok(expected.clone());
    }
    let mut task = crate::web_workflow::task_view(&run);
    task["status"] = json!("failed");
    task["errorMessage"] = json!(error);
    task["recoveryRequired"] = json!(true);
    Ok(task)
}

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
    if let Some(expected) = expected.filter(|e| e["task"]["runId"].is_string()) {
        db.execute("UPDATE kv_cache SET value_json=?,expires_at=NULL,updated_at=? WHERE namespace=? AND key=? AND json_extract(value_json,'$.task.runId')=? AND json_extract(value_json,'$.task.revision') IS ? AND json_extract(value_json,'$.task.updatedAt') IS ? AND json_extract(value_json,'$.projectedAt') IS ?",
            vec![serialized.into(),now.into(),namespace.into(),key.trim().to_uppercase().into(),expected["task"]["runId"].clone(),expected["task"]["revision"].clone(),expected["task"]["updatedAt"].clone(),expected["projectedAt"].clone()]).await?;
    } else if value["task"]["runId"].is_string() && expected.is_none() {
        db.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,expires_at=NULL,updated_at=excluded.updated_at WHERE json_extract(excluded.value_json,'$.task.createdAt')>coalesce(json_extract(kv_cache.value_json,'$.task.createdAt'),0) OR (json_extract(excluded.value_json,'$.task.runId')=json_extract(kv_cache.value_json,'$.task.runId') AND json_extract(excluded.value_json,'$.task.revision')>=coalesce(json_extract(kv_cache.value_json,'$.task.revision'),0) AND json_extract(excluded.value_json,'$.task.updatedAt')>=coalesce(json_extract(kv_cache.value_json,'$.task.updatedAt'),0))",
            vec![namespace.into(),key.trim().to_uppercase().into(),serialized.into(),now.into()]).await?;
    } else if let Some(expected) = expected {
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
    async fn rejected_receipt_is_terminal_without_mutating_provider_success() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("test.sqlite")).unwrap();
        db.migrate(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let run = json!({"runId":"receipt","status":"succeeded","revision":8,"updatedAt":20});
        db.put_kv(crate::web_workflow::RUNS, "receipt", &run, None)
            .await
            .unwrap();
        let task = projection_failed_task(
            &db,
            &json!({"runId":"receipt","status":"running","revision":7}),
            "missing chapters",
        )
        .await
        .unwrap();
        assert_eq!(task["status"], "failed");
        assert_eq!(task["revision"], 8);
        assert!(unchanged_failed_execution(&db, &task).await.unwrap());
        assert_eq!(
            db.get_kv(crate::web_workflow::RUNS, "receipt")
                .await
                .unwrap()
                .unwrap(),
            run
        );
        let mut recovered = run.clone();
        recovered["revision"] = json!(9);
        recovered["status"] = json!("queued");
        db.put_kv(crate::web_workflow::RUNS, "receipt", &recovered, None)
            .await
            .unwrap();
        assert!(!unchanged_failed_execution(&db, &task).await.unwrap());
    }
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
    #[tokio::test]
    async fn uuid_run_revision_fences_stale_business_projection() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("test.sqlite")).unwrap();
        db.migrate(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let old = json!({"task":{"runId":"uuid-a","taskId":"uuid-a","createdAt":10,"updatedAt":10,"revision":1},"markdown":"old"});
        save(&db, "research_financial_analysis", "AAPL.US", &old, None)
            .await
            .unwrap();
        let new = json!({"task":{"runId":"uuid-b","taskId":"uuid-b","createdAt":11,"updatedAt":11,"revision":1},"markdown":"new"});
        save(&db, "research_financial_analysis", "AAPL.US", &new, None)
            .await
            .unwrap();
        save(
            &db,
            "research_financial_analysis",
            "AAPL.US",
            &old,
            Some(&old),
        )
        .await
        .unwrap();
        assert_eq!(
            read(&db, "research_financial_analysis", "AAPL.US")
                .await
                .unwrap()
                .unwrap()["markdown"],
            "new"
        );
    }
}
