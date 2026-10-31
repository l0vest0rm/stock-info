//! Acquisition results live directly in existing business documents. No shadow records table.
use acquisition::storage::{CollectedRecord, RecordStorage};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub struct KnowledgeStorage;
fn doc_id(task: i64, key: &str) -> String {
    format!("acq_{task}_{key}")
}
impl RecordStorage for KnowledgeStorage {
    fn contains(&self, c: &Connection, task: i64, key: &str) -> Result<bool> {
        Ok(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM knowledge_docs WHERE doc_id=?1)",
            [doc_id(task, key)],
            |r| r.get(0),
        )?)
    }
    fn write(&self, tx: &Transaction<'_>, r: &CollectedRecord<'_>) -> Result<bool> {
        let id = doc_id(r.task_id, r.dedup_key);
        let previous: Option<String> = tx
            .query_row(
                "SELECT metadata_json FROM knowledge_docs WHERE doc_id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(raw) = previous {
            // Enrich tags without replacing the authoritative original payload/content.
            let mut meta: Value = serde_json::from_str(&raw)?;
            let mut tags: BTreeSet<acquisition::tags::Tag> =
                serde_json::from_value(meta["acquisition"]["tags"].clone())?;
            tags.extend(r.tags.iter().cloned());
            meta["acquisition"]["tags"] = json!(tags);
            tx.execute(
                "UPDATE knowledge_docs SET metadata_json=?1 WHERE doc_id=?2",
                params![meta.to_string(), id],
            )?;
            return Ok(false);
        }
        let c = r.content;
        let now = chrono::Utc::now();
        let meta = json!({"acquisition":{"taskId":r.task_id,"taskName":r.task_name,"runId":r.run_id,"dedupKey":r.dedup_key,"source":r.source,"raw":r.raw,"content":c,"tags":r.tags}});
        // Canonical body stays inline in SQLite: one transaction with checkpoint,
        // no object-store write can become orphaned or acknowledge unfinished work.
        let body = if c.body.is_empty() {
            &c.summary
        } else {
            &c.body
        };
        let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
        tx.execute("INSERT INTO knowledge_docs(doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,access_method,summary,content_preview,inline_content,inline_content_sha256,metadata_json,sort_time,source_name_normalized,updated_at) VALUES(?1,'information_feed','news',?2,?3,?4,?5,?6,'inline',?7,?8,?9,?10,?11,?12,?13,?14)",params![id,c.source_name,c.title,c.source_url.as_deref().unwrap_or(""),c.published_at,now.to_rfc3339(),c.summary,body.chars().take(280).collect::<String>(),body,hash,meta.to_string(),c.published_at.as_deref().unwrap_or(&now.to_rfc3339()),c.source_name.to_lowercase(),now.timestamp_millis()])?;
        Ok(true)
    }
}
