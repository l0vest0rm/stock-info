//! Conservative, local-only feed maintenance. All deletion decisions are rechecked atomically.
use super::{lock, metadata, read_body, rules};
use crate::AppState;
use anyhow::{Result, bail};
use chrono::DateTime;
use rusqlite::{TransactionBehavior, params};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, PathBuf},
};

const SNAPSHOT_SQL: &str = "select d.doc_id,d.source_type,d.title,d.url,d.published_at,d.fetched_at,d.sort_time,d.metadata_json,c.content_key,c.content_sha256,(select count(*) from knowledge_information_records r where r.doc_id=d.doc_id) as record_count from knowledge_docs d join knowledge_doc_content_refs c on c.doc_id=d.doc_id where d.source_type='information_feed' order by d.title,d.published_at,d.doc_id";
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn truthy(v: &Value) -> bool {
    !v.is_null() && v != false && v.as_str() != Some("") && v.as_f64() != Some(0.0)
}
fn retained(row: &Value, meta: &Value) -> bool {
    row["record_count"].as_i64().unwrap_or(0) > 0
        || truthy(&meta["informationExtraction"]["current"])
        || meta["informationExtraction"]["categoryCandidates"]
            .as_array()
            .is_some_and(|v| !v.is_empty())
        || meta["feed"].get("records").is_some()
        || meta["feed"]["taggingStatus"] == "complete"
}
fn time(row: &Value) -> Option<i64> {
    ["published_at", "fetched_at"].iter().find_map(|k| {
        DateTime::parse_from_rfc3339(text(&row[*k]))
            .ok()
            .map(|d| d.timestamp_millis())
    })
}
fn candidate(row: &Value, meta: &Value, body: &str) -> Value {
    let mut value = row.clone();
    value["body"] = body.into();
    value["feed"] = meta["feed"].clone();
    for k in ["sourceKey", "sourceItemId", "entityCodes"] {
        value[k] = meta["feed"][k].clone();
    }
    value
}
fn snapshot(conn: &rusqlite::Connection, id: &str) -> Result<Value> {
    let sql = format!("select * from ({SNAPSHOT_SQL}) where doc_id=?");
    let mut stmt = conn.prepare(&sql)?;
    let keys = stmt.column_names().map(str::to_owned).collect::<Vec<_>>();
    let row = stmt.query_row([id], |r| {
        let mut out = serde_json::Map::new();
        for (i, k) in keys.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => n.into(),
                ValueRef::Text(s) => String::from_utf8_lossy(s).into_owned().into(),
                _ => Value::Null,
            };
            out.insert(k.clone(), v);
        }
        Ok(Value::Object(out))
    })?;
    Ok(row)
}
fn validate_snapshot(expected: &Value, actual: &Value, drop: bool) -> Result<()> {
    for key in [
        "title",
        "published_at",
        "fetched_at",
        "content_key",
        "content_sha256",
        "metadata_json",
    ] {
        if expected[key] != actual[key] {
            bail!(
                "reconciliation input changed: {}",
                text(&expected["doc_id"])
            );
        }
    }
    let meta = metadata(actual)?;
    if actual["source_type"] != "information_feed"
        || truthy(&meta["feed"]["publishedFingerprint"])
        || truthy(&meta["feed"]["publishAllowed"])
    {
        bail!("published or non-feed documents require coordinated reconciliation");
    }
    if drop && retained(actual, &meta) {
        bail!("reconciliation cannot delete extracted information");
    }
    Ok(())
}
fn merge_refs(keep: &mut Value, drop: &Value) {
    let mut refs = Vec::<Value>::new();
    let mut indexes = BTreeMap::new();
    for item in keep["feed"]["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(drop["feed"]["sources"].as_array().into_iter().flatten())
    {
        let key = ["sourceKey", "sourceItemId", "url", "contentHash"]
            .map(|k| text(&item[k]))
            .join("|");
        if let Some(i) = indexes.get(&key) {
            refs[*i] = item.clone();
        } else {
            indexes.insert(key, refs.len());
            refs.push(item.clone());
        }
    }
    if !keep["feed"].is_object() {
        keep["feed"] = json!({});
    }
    keep["feed"]["sources"] = refs.into();
}

pub async fn reconcile(state: &AppState, options: Value) -> Result<Value> {
    let apply = options["apply"].as_bool().unwrap_or(false);
    if apply && state.setting("LLM_RUNTIME") != "local" {
        bail!("local feed reconciliation requires LLM_RUNTIME=local");
    }
    let _guard = if apply {
        Some(lock(state).await?)
    } else {
        None
    };
    let rows = state.db.query(SNAPSHOT_SQL, vec![]).await?;
    let mut groups = BTreeMap::<String, Vec<(Value, Value, String)>>::new();
    for row in rows {
        let meta = metadata(&row)?;
        if let Some(body) = read_body(state, text(&row["content_key"])).await? {
            // Never classify bytes inconsistent with the stored immutable content reference.
            if super::sha(&body) != text(&row["content_sha256"]) {
                continue;
            }
            groups
                .entry(text(&row["title"]).into())
                .or_default()
                .push((row, meta, body));
        }
    }
    let mut pairs = Vec::<(Value, Value)>::new();
    for group in groups.values() {
        let mut kept = Vec::<&(Value, Value, String)>::new();
        for item in group {
            let (row, meta, body) = item;
            let found = if meta["feed"]["kind"] == "new" && !retained(row, meta) {
                kept.iter().find(|(r,m,b)| {
                m["feed"]["kind"]=="new" && time(r).zip(time(row)).is_some_and(|(a,b)|(a-b).abs()<=7*86400000)
                && rules::classify(&candidate(row,meta,body),&[candidate(r,m,b)])["kind"]=="repeat"
            }).copied()
            } else {
                None
            };
            if let Some((keep, _, _)) = found {
                pairs.push((keep.clone(), row.clone()));
            } else {
                kept.push(item);
            }
        }
    }
    let mut output = json!({"dryRun":!apply,"repeatedCards":pairs.len(),"pairs":pairs.iter().map(|(k,d)|json!({"keep":k["doc_id"],"drop":d["doc_id"],"title":d["title"]})).collect::<Vec<_>>()});
    if !apply || pairs.is_empty() {
        return Ok(output);
    }
    let transaction_pairs = pairs.clone();
    state
        .db
        .run(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let drops = transaction_pairs
                .iter()
                .map(|(_, d)| text(&d["doc_id"]))
                .collect::<BTreeSet<_>>();
            if drops.len() != transaction_pairs.len()
                || transaction_pairs
                    .iter()
                    .any(|(k, _)| drops.contains(text(&k["doc_id"])))
            {
                bail!("invalid cyclic or repeated reconciliation pairs");
            }
            for (keep, drop) in &transaction_pairs {
                validate_snapshot(keep, &snapshot(&tx, text(&keep["doc_id"]))?, false)?;
                validate_snapshot(drop, &snapshot(&tx, text(&drop["doc_id"]))?, true)?;
            }
            for (keep, drop) in &transaction_pairs {
                let current = snapshot(&tx, text(&keep["doc_id"]))?;
                let mut meta = metadata(&current)?;
                merge_refs(&mut meta, &metadata(drop)?);
                let n = tx.execute(
                    "update knowledge_docs set metadata_json=? where doc_id=? and metadata_json=?",
                    params![
                        serde_json::to_string(&meta)?,
                        text(&keep["doc_id"]),
                        text(&current["metadata_json"])
                    ],
                )?;
                if n != 1 {
                    bail!("reconciliation metadata changed");
                }
                if tx.execute(
                    "delete from knowledge_docs where doc_id=?",
                    [text(&drop["doc_id"])],
                )? != 1
                {
                    bail!("reconciliation document disappeared");
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    let mut removed = 0;
    for (_, drop) in &pairs {
        let key = text(&drop["content_key"]).to_owned();
        let local = state.clone();
        // Refcount and deletion share the write lease: a concurrent importer
        // cannot insert a new reference between the check and unlink.
        let deleted = state
            .db
            .run(move |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let refs: i64 = tx.query_row(
                    "select count(*) from knowledge_doc_content_refs where content_key=?",
                    [&key],
                    |r| r.get(0),
                )?;
                let removed = refs == 0 && remove_unreferenced_content(&local, &key)?;
                tx.commit()?;
                Ok(removed)
            })
            .await?;
        if deleted {
            removed += 1;
        }
    }
    output["reconciled"] = pairs.len().into();
    output["removedFiles"] = removed.into();
    Ok(output)
}

fn remove_unreferenced_content(state: &AppState, key: &str) -> Result<bool> {
    let Some(relative) = key.strip_prefix("knowledge-content/") else {
        return Ok(false);
    };
    let relative = std::path::Path::new(relative);
    if relative
        .components()
        .any(|p| !matches!(p, Component::Normal(_)))
    {
        bail!("invalid content key");
    }
    let configured = state.setting("KNOWLEDGE_CONTENT_LOCAL_DIR");
    let root = if configured.is_empty() {
        state.data_dir().join("knowledge-content")
    } else {
        state.root.join(configured)
    };
    if !root.exists() {
        return Ok(false);
    }
    let root = root.canonicalize()?;
    let mut path = root.clone();
    for part in relative.components() {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => bail!("content symlink is forbidden"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.into()),
            _ => {}
        }
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn backup_metadata(state: &AppState, rows: &[Value]) -> Result<PathBuf> {
    let configured = state.setting("INFORMATION_FEED_RELEVANCE_BACKUP_DIR");
    let dir = if configured.is_empty() {
        state.root.join("data/local/backups")
    } else {
        state.root.join(configured)
    };
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "information-feed-relevance-{}-{}.jsonl",
        chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S%.3fZ"),
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    for row in rows {
        serde_json::to_writer(
            &mut file,
            &json!({"doc_id":row["doc_id"],"metadata_json":row["metadata_json"]}),
        )?;
        file.write_all(b"\n")?;
    }
    file.sync_all()?;
    Ok(path)
}

pub async fn backfill_relevance(state: &AppState, options: Value) -> Result<Value> {
    let apply = options["apply"].as_bool().unwrap_or(false);
    let _guard = if apply {
        Some(lock(state).await?)
    } else {
        None
    };
    let rows = state.db.query(SNAPSHOT_SQL, vec![]).await?;
    let stocks=state.db.query("select s.code,s.short_name,a.alias from stock s left join stock_alias a on a.code=s.code where s.information_feed_focus=1",vec![]).await?;
    let entries = rules::stock_entries(&stocks);
    let policy = state.config("config/knowledge/information-feed-policy.json")?;
    let mut counts = json!({"scanned":0,"unchanged":0,"pass":0,"reject":0,"uncertain":0,"missingBody":0,"invalidContent":0,"changed":0});
    let mut samples = Vec::new();
    let mut audits = Vec::new();
    let mut updates = Vec::<(Value, Value)>::new();
    for row in &rows {
        increment(&mut counts, "scanned");
        let Some(body) = read_body(state, text(&row["content_key"])).await? else {
            increment(&mut counts, "missingBody");
            continue;
        };
        if super::sha(&body) != text(&row["content_sha256"]) {
            increment(&mut counts, "invalidContent");
            continue;
        }
        let mut meta = metadata(row)?;
        let gate = rules::evaluate_relevance(text(&row["title"]), &body, &entries, &policy)?;
        increment(&mut counts, text(&gate["decision"]));
        if gate["effectiveDisposition"] == "reject" {
            if samples.len() < 20 {
                samples.push(json!({"docId":row["doc_id"],"title":row["title"],"reason":gate["reasonCodes"]}));
            }
            let mut audit = gate.clone();
            for (k, v) in [
                ("sourceKey", meta["feed"]["sourceKey"].clone()),
                ("sourceItemId", meta["feed"]["sourceItemId"].clone()),
                ("url", row["url"].clone()),
                ("title", row["title"].clone()),
                ("publishedAt", row["published_at"].clone()),
            ] {
                audit[k] = v;
            }
            audits.push(audit);
        }
        if meta["feed"]["investmentGate"] == gate {
            increment(&mut counts, "unchanged");
            continue;
        }
        if !meta["feed"].is_object() {
            meta["feed"] = json!({});
        }
        meta["feed"]["investmentGate"] = gate;
        updates.push((row.clone(), meta));
        increment(&mut counts, "changed");
    }
    let mut output = json!({"apply":apply,"counts":counts,"rejectedSamples":samples});
    if apply {
        let backup = backup_metadata(state, &rows)?;
        output["backupFile"] = backup.to_string_lossy().into_owned().into();
        state.db.run(move|conn|{let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for(row,meta)in updates{let n=tx.execute("update knowledge_docs set metadata_json=? where doc_id=? and metadata_json=? and title=? and source_type='information_feed' and exists(select 1 from knowledge_doc_content_refs c where c.doc_id=knowledge_docs.doc_id and c.content_key=? and c.content_sha256=?)",params![serde_json::to_string(&meta)?,text(&row["doc_id"]),text(&row["metadata_json"]),text(&row["title"]),text(&row["content_key"]),text(&row["content_sha256"])])?;if n!=1{bail!("concurrent feed metadata/content change: {}",text(&row["doc_id"]));}}
            tx.commit()?;Ok(())}).await?;
        let configured = state.setting("INFORMATION_FEED_RELEVANCE_AUDIT_FILE");
        let path = if configured.is_empty() {
            state
                .root
                .join("data/local/information-feed-relevance-rejected.jsonl")
        } else {
            state.root.join(configured)
        };
        for audit in audits {
            crate::runtime_jobs::append_rejected_feed(&audit, &path)?;
        }
    }
    Ok(output)
}
fn increment(value: &mut Value, key: &str) {
    value[key] = (value[key].as_u64().unwrap_or(0) + 1).into();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_snapshot_observes_record_insert_before_deletion() -> Result<()> {
        // Existing table names only; this isolated in-memory fixture cannot
        // migrate, write or inspect a user's local database.
        let conn = rusqlite::Connection::open_in_memory()?;
        conn.execute_batch("create table knowledge_docs(doc_id text primary key,source_type text,title text,url text,published_at text,fetched_at text,sort_time text,metadata_json text);create table knowledge_doc_content_refs(doc_id text,content_key text,content_sha256 text);create table knowledge_information_records(doc_id text);insert into knowledge_docs values('f_1','information_feed','title','','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z','','{}');insert into knowledge_doc_content_refs values('f_1','knowledge-content/f_1.md','hash');")?;
        let scanned = snapshot(&conn, "f_1")?;
        assert_eq!(scanned["record_count"], 0);
        conn.execute(
            "insert into knowledge_information_records values('f_1')",
            [],
        )?;
        let current = snapshot(&conn, "f_1")?;
        // A concurrent successful extraction may add records without changing
        // the scanned metadata. The transactional second read still blocks it.
        assert!(validate_snapshot(&scanned, &current, true).is_err());
        assert!(validate_snapshot(&scanned, &current, false).is_ok());
        Ok(())
    }
    #[test]
    fn extraction_retention_is_conservative() {
        for meta in [
            json!({"informationExtraction":{"current":{}}}),
            json!({"feed":{"records":[]}}),
            json!({"feed":{"taggingStatus":"complete"}}),
            json!({"informationExtraction":{"categoryCandidates":[{}]}}),
        ] {
            assert!(retained(&json!({"record_count":0}), &meta));
        }
        assert!(!retained(&json!({"record_count":0}), &json!({})));
    }
    #[test]
    fn source_merge_keeps_distinct_content_versions() {
        let mut a = json!({"feed":{"sources":[{"sourceKey":"a","contentHash":"1"}]}});
        merge_refs(
            &mut a,
            &json!({"feed":{"sources":[{"sourceKey":"a","contentHash":"2"},{"sourceKey":"a","contentHash":"1"}]}}),
        );
        assert_eq!(a["feed"]["sources"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn snapshot_rejects_concurrent_content_and_publication() {
        let expected =
            json!({"source_type":"information_feed","metadata_json":"{}","content_sha256":"a"});
        let mut actual = expected.clone();
        actual["content_sha256"] = "b".into();
        assert!(validate_snapshot(&expected, &actual, true).is_err());
        let published = json!({"source_type":"information_feed","metadata_json":"{\"feed\":{\"publishAllowed\":true}}"});
        assert!(validate_snapshot(&published, &published, false).is_err());
    }
}
