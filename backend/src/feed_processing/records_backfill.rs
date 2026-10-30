//! Offline, archive-first migration of legacy extraction metadata. Never invokes a model.
use crate::{AppState, knowledge::information_records::*};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const LEGACY_KEYS: &[&str] = &[
    "records",
    "categoryCandidates",
    "taggingStatus",
    "taggingInputFingerprint",
    "taggingContentSha256",
    "tagContract",
    "tagCategoryCatalogHash",
    "tagPromptHash",
    "tagCandidatePolicyHash",
    "taggedAt",
    "lastTagAttemptAt",
    "nextRetryAt",
    "tagLeaseOwner",
    "tagLeaseUntil",
    "tagAttempts",
    "lastTagError",
    "lastAttemptContract",
    "lastAttemptCategoryCatalogHash",
    "lastAttemptPromptHash",
    "lastAttemptCandidatePolicyHash",
];
fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn clear_legacy(meta: &mut Value) {
    if let Some(feed) = meta["feed"].as_object_mut() {
        for key in LEGACY_KEYS {
            feed.remove(*key);
        }
    }
}
fn legacy_contract() -> Result<Value> {
    crate::knowledge::information_records::extraction_contracts()?
        .into_iter()
        .find(|contract| contract["contractVersion"] == "feed-tag-v5")
        .context("missing v5 legacy extraction contract")
}
fn query(conn: &Connection, sql: &str, values: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let names = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(statement
        .query_map(values, |row| {
            let mut out = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                    ValueRef::Blob(v) => json!(v),
                };
                out.insert(name.clone(), value);
            }
            Ok(Value::Object(out))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
fn snapshot(conn: &Connection, id: &str, new_schema: bool) -> Result<Value> {
    let mut row=query(conn,"SELECT d.*,c.content_key,c.content_url,c.content_type,c.content_encoding,c.content_bytes,c.content_sha256 FROM knowledge_docs d LEFT JOIN knowledge_doc_content_refs c ON c.doc_id=d.doc_id WHERE d.doc_id=?",&[&id])?.pop().context("information document not found")?;
    row["meta"] = serde_json::from_str(s(&row["metadata_json"]))?;
    row["records"] = json!(query(
        conn,
        if new_schema {
            "SELECT * FROM knowledge_information_records WHERE doc_id=? ORDER BY sort_order"
        } else {
            "SELECT r.information_id,x.version_id AS doc_id,r.entity,NULL AS entity_key,r.information_type,r.category,r.period,r.statement,r.forecast_measurement_json,r.sort_order,r.created_at FROM knowledge_information_records r JOIN knowledge_document_results x ON x.result_id=r.result_id WHERE x.version_id=? ORDER BY r.sort_order"
        },
        &[&id]
    )?);
    row["tags"] = json!(query(
        conn,
        "SELECT * FROM knowledge_doc_tags WHERE doc_id=? ORDER BY tag",
        &[&id]
    )?);
    Ok(row)
}
fn identity(row: &Value) -> String {
    let mut fields = json!({});
    for key in [
        "doc_id",
        "title",
        "published_at",
        "source_type",
        "content_key",
        "content_sha256",
        "metadata_json",
        "records",
        "tags",
    ] {
        fields[key] = row[key].clone();
    }
    sha256_text(&canonical_json(&fields))
}
fn legacy_record(value: &Value) -> Result<Value> {
    ensure!(
        value.as_object().is_some_and(|o| o.keys().all(|key| [
            "entity",
            "informationType",
            "category",
            "period",
            "statement",
            "forecastMeasurement"
        ]
        .contains(&key.as_str())))
            && [
                "fact",
                "guidance",
                "forecast",
                "opinion",
                "event",
                "relationship"
            ]
            .contains(&s(&value["informationType"]))
            && ["entity", "category", "statement"]
                .iter()
                .all(|key| value[*key].is_string() && !s(&value[*key]).trim().is_empty())
            && (value["period"].is_null() || value["period"].is_string())
            && (value["forecastMeasurement"].is_null() || value["forecastMeasurement"].is_object()),
        "legacy record cannot be represented without data loss"
    );
    Ok(
        json!({"entity":value["entity"],"informationType":value["informationType"],"category":value["category"],"period":if value["period"]==""{Value::Null}else{value["period"].clone()},"statement":value["statement"],"forecastMeasurement":value["forecastMeasurement"]}),
    )
}
fn preserve_ids(previous: &[Value], rows: &mut [Value]) -> Result<()> {
    ensure!(
        previous.len() == rows.len(),
        "conflicting relational and JSON record counts"
    );
    let mut groups = HashMap::<String, Vec<&Value>>::new();
    for old in previous {
        groups
            .entry(canonical_json(&row_to_information(old)?))
            .or_default()
            .push(old);
    }
    for row in rows {
        let key = canonical_json(&row_to_information(row)?);
        let old = groups
            .get_mut(&key)
            .and_then(|group| {
                if group.is_empty() {
                    None
                } else {
                    Some(group.remove(0))
                }
            })
            .context("conflicting relational and JSON record content")?;
        row["information_id"] = old["information_id"].clone();
        row["created_at"] = old["created_at"].clone();
    }
    Ok(())
}
fn plan(
    snapshot: &Value,
    body: Option<&str>,
    aliases: &[Value],
    contract: &Value,
    policy: &Value,
    ontology: &Value,
    time: i64,
) -> Result<Value> {
    let mut meta = snapshot["meta"].clone();
    let feed = meta["feed"].clone();
    let previous = meta["informationExtraction"].clone();
    let has_legacy = LEGACY_KEYS.iter().any(|key| feed.get(*key).is_some());
    let mut records = snapshot["records"]
        .as_array()
        .context("invalid snapshot records")?
        .clone();
    if !has_legacy {
        if previous["current"].is_object() && s(&previous["current"]["recordsDigest"]).is_empty() {
            meta["informationExtraction"]["current"]["recordsDigest"] =
                json!(sha256_text(&records_digest_input(&records)?));
            meta["informationExtraction"]["current"]["recordCount"] = json!(records.len());
            return Ok(
                json!({"kind":"legacy_relational","meta":meta,"records":records,"issues":["historical extraction provenance is unknown"]}),
            );
        }
        return Ok(json!({"kind":"unchanged"}));
    }
    ensure!(
        feed["taggingStatus"] != "processing"
            || feed["tagLeaseUntil"].as_i64().unwrap_or(0) <= time,
        "active legacy extraction lease; stop the writer before backfill"
    );
    let mut issues = Vec::<String>::new();
    let candidates = if feed["categoryCandidates"].is_array() {
        feed["categoryCandidates"].clone()
    } else {
        Value::Null
    };
    let mut status =
        if ["pending", "processing", "complete", "failed"].contains(&s(&feed["taggingStatus"])) {
            s(&feed["taggingStatus"])
        } else {
            "pending"
        };
    if status == "processing" {
        status = "pending";
    }
    let attempt = json!({"contractVersion":feed["lastAttemptContract"],"promptHash":feed["lastAttemptPromptHash"],"categoryCatalogHash":feed["lastAttemptCategoryCatalogHash"],"candidatePolicyHash":feed["lastAttemptCandidatePolicyHash"],"model":null,"inputFingerprint":null,"attempts":feed["tagAttempts"].as_u64().unwrap_or(0),"attemptedAt":feed["lastTagAttemptAt"],"nextRetryAt":feed["nextRetryAt"],"error":feed["lastTagError"],"leaseOwner":null,"leaseUntil":null});
    let has_json = feed.get("records").is_some();
    if has_json {
        let formal = feed["records"]
            .as_array()
            .context("legacy records is not an array; quarantine requires an explicit archive")?
            .iter()
            .map(legacy_record)
            .collect::<Result<Vec<_>>>()?;
        let old_contract = json!({"contractVersion":feed["tagContract"],"promptHash":feed["tagPromptHash"],"categoryCatalogHash":feed["tagCategoryCatalogHash"],"candidatePolicyHash":feed["tagCandidatePolicyHash"],"model":contract["model"]});
        let input = body
            .unwrap_or("")
            .chars()
            .scan(0, |n, c| {
                *n += c.len_utf16();
                (*n <= 12000).then_some(c)
            })
            .collect::<String>();
        let parser_valid = match super::extraction::parse_extraction(
            &serde_json::to_string(
                &json!({"records":formal,"categoryCandidates":candidates.as_array().cloned().unwrap_or_default()}),
            )?,
            &input,
            ontology,
        ) {
            Ok(parsed) if canonical_json(&parsed["records"]) == canonical_json(&json!(formal)) => {
                true
            }
            Ok(_) => {
                issues.push("parser would alter legacy record content".into());
                false
            }
            Err(error) => {
                issues.push(error.to_string());
                false
            }
        };
        if candidates.is_null() {
            issues.push("category candidate assessment is unknown".into());
        }
        if body.is_none()
            || s(&feed["taggingContentSha256"]).is_empty()
            || sha256_text(body.unwrap_or("")) != s(&feed["taggingContentSha256"])
            || feed["taggingContentSha256"] != snapshot["content_sha256"]
        {
            issues.push("legacy content binding cannot be verified".into());
        }
        if !contract_matches(&old_contract, contract) {
            issues.push("legacy extraction contract is stale or unknown".into());
        }
        if body.is_none()
            || s(&feed["taggingInputFingerprint"]).is_empty()
            || super::extraction::fingerprint(snapshot, body.unwrap_or(""), contract)
                != s(&feed["taggingInputFingerprint"])
        {
            issues.push("legacy input fingerprint cannot be verified".into());
        }
        if !feed["taggedAt"]
            .as_i64()
            .is_some_and(|v| v > 0 && v <= 9_007_199_254_740_991)
        {
            ensure!(
                formal.is_empty(),
                "legacy records have no reliable extraction time"
            );
            issues.push("legacy extraction completion time is unknown".into());
        }
        let verified = parser_valid
            && issues
                .iter()
                .all(|issue| issue == "category candidate assessment is unknown");
        let company_candidates = body
            .map(|body| {
                super::rules::company_candidates(aliases, s(&snapshot["title"]), body, policy)
            })
            .unwrap_or_else(|| json!([]));
        let fp = if s(&feed["taggingInputFingerprint"]).is_empty() {
            format!("legacy:{}", sha256_text(&canonical_json(&json!(formal))))
        } else {
            s(&feed["taggingInputFingerprint"]).to_owned()
        };
        let existing = records.clone();
        records = super::extraction::make_rows(
            s(&snapshot["doc_id"]),
            &fp,
            &formal,
            &company_candidates,
            feed["taggedAt"].as_i64().unwrap_or(0),
        );
        if previous["current"].is_object() || !existing.is_empty() {
            preserve_ids(&existing, &mut records)?;
        }
        let mut current = old_contract;
        for(key,value)in json!({"storageVersion":INFORMATION_STORAGE_VERSION,"outcome":extraction_outcome(&records,candidates.as_array().map(Vec::as_slice)),"inputFingerprint":feed["taggingInputFingerprint"],"contentSha256":feed["taggingContentSha256"],"title":if verified{snapshot["title"].clone()}else{Value::Null},"publishedAt":if verified{snapshot["published_at"].clone()}else{Value::Null},"completedAt":feed["taggedAt"],"recordsDigest":sha256_text(&records_digest_input(&records)?),"recordCount":records.len(),"categoryCandidateCount":candidates.as_array().map(Vec::len),"provenanceStatus":if verified{"verified"}else{"legacy_unverified"}}).as_object().unwrap(){current[key]=value.clone();}
        if !verified {
            current["model"] = Value::Null;
        }
        meta["informationExtraction"] = json!({"storageVersion":INFORMATION_STORAGE_VERSION,"status":status,"current":current,"categoryCandidates":candidates,"lastAttempt":attempt});
        if !issues.is_empty() {
            meta["informationExtraction"]["migrationIssues"] = json!(issues);
        }
    } else if previous["current"].is_object() {
        meta["informationExtraction"]["current"]["recordsDigest"] =
            json!(sha256_text(&records_digest_input(&records)?));
        meta["informationExtraction"]["current"]["recordCount"] = json!(records.len());
        issues.push("retained legacy relational outcome without inventing provenance".into());
    } else {
        if status == "complete" {
            status = "pending";
            issues.push("legacy completion has no records array; outcome is unknown".into());
        }
        meta["informationExtraction"] = json!({"storageVersion":INFORMATION_STORAGE_VERSION,"status":status,"current":null,"categoryCandidates":candidates,"lastAttempt":attempt});
        if !issues.is_empty() {
            meta["informationExtraction"]["migrationIssues"] = json!(issues);
        }
    }
    clear_legacy(&mut meta);
    Ok(
        json!({"kind":if has_json{"records"}else{"state"},"meta":meta,"records":records,"issues":issues}),
    )
}
fn archive(dir: &Path, snapshot: &Value) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let text = canonical_json(&json!({"snapshot":snapshot})) + "\n";
    let path = dir.join(format!(
        "{}-{}.json",
        sha256_text(s(&snapshot["doc_id"])),
        identity(snapshot)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    ensure!(
        std::fs::read(&path)? == text.as_bytes(),
        "backfill archive verification failed"
    );
    Ok(())
}
fn apply(conn: &mut Connection, snapshot: &Value, plan: &Value) -> Result<()> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let id = s(&snapshot["doc_id"]);
    let latest = self::snapshot(&tx, id, true)?;
    ensure!(
        identity(&latest) == identity(snapshot),
        "document changed after backfill planning"
    );
    let records = plan["records"].as_array().context("invalid plan records")?;
    ensure!(
        records.iter().all(|r| r["doc_id"] == id),
        "cross-document information replacement refused"
    );
    let old = snapshot["records"]
        .as_array()
        .context("invalid snapshot records")?;
    for row in records {
        if let Some(previous) = old
            .iter()
            .find(|previous| previous["information_id"] == row["information_id"])
        {
            ensure!(
                canonical_json(&row_to_information(previous)?)
                    == canonical_json(&row_to_information(row)?),
                "an existing information ID cannot be assigned different content"
            );
        }
    }
    tx.execute(
        "DELETE FROM knowledge_information_records WHERE doc_id=?",
        [id],
    )?;
    for row in records {
        tx.execute("INSERT INTO knowledge_information_records(information_id,doc_id,entity,entity_key,information_type,category,period,statement,forecast_measurement_json,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![s(&row["information_id"]),id,s(&row["entity"]),row["entity_key"].as_str(),s(&row["information_type"]),s(&row["category"]),row["period"].as_str(),s(&row["statement"]),s(&row["forecast_measurement_json"]),row["sort_order"].as_i64(),row["created_at"].as_i64()])?;
    }
    let mut meta = plan["meta"].clone();
    if meta["informationExtraction"]["current"].is_object() {
        meta["informationExtraction"]["current"]["recordsDigest"] =
            json!(sha256_text(&records_digest_input(records)?));
        meta["informationExtraction"]["current"]["recordCount"] = json!(records.len());
    }
    tx.execute("DELETE FROM knowledge_doc_tags WHERE doc_id=? AND (tag LIKE 'company:%' OR tag LIKE 'category:%' OR tag LIKE 'topic:%' OR tag LIKE 'theme:%' OR tag LIKE 'focus:%')",[id])?;
    let current = &meta["informationExtraction"]["current"];
    if !s(&current["inputFingerprint"]).is_empty() && current["provenanceStatus"] == "verified" {
        for tag in tags_for_information_rows(records) {
            tx.execute("INSERT INTO knowledge_doc_tags(doc_id,tag,weight,tagging_input_fingerprint,contract_version) VALUES(?,?,?,?,?)",params![id,s(&tag["tag"]),tag["weight"].as_i64(),s(&current["inputFingerprint"]),s(&current["contractVersion"])])?;
        }
    }
    ensure!(
        tx.execute(
            "UPDATE knowledge_docs SET metadata_json=?,updated_at=? WHERE doc_id=?",
            params![
                serde_json::to_string(&meta)?,
                chrono::Utc::now().timestamp_millis(),
                id
            ]
        )? == 1,
        "metadata update failed"
    );
    let saved = self::snapshot(&tx, id, true)?;
    ensure!(
        canonical_json(&saved["records"]) == canonical_json(&json!(records))
            && saved["meta"]["feed"].get("records").is_none(),
        "backfill read-back mismatch"
    );
    tx.commit()?;
    Ok(())
}
async fn with_conn<T, F>(
    state: &AppState,
    database: Option<PathBuf>,
    apply: bool,
    f: F,
) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
{
    if let Some(path) = database {
        tokio::task::spawn_blocking(move || {
            let flags = if apply {
                OpenFlags::SQLITE_OPEN_READ_WRITE
            } else {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            };
            let mut conn = Connection::open_with_flags(path, flags)?;
            conn.pragma_update(None, "foreign_keys", true)?;
            conn.busy_timeout(std::time::Duration::from_secs(30))?;
            f(&mut conn)
        })
        .await?
    } else {
        state.db.run(f).await
    }
}
async fn body(state: &AppState, key: &str, root: Option<&Path>) -> Result<Option<String>> {
    let Some(key) = key.strip_prefix("knowledge-content/") else {
        return Ok(None);
    };
    if let Some(root) = root {
        if key.is_empty()
            || Path::new(key)
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Ok(None);
        }
        let root = match root.canonicalize() {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let path = root.join(key);
        let path = match path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !path.starts_with(&root) {
            return Ok(None);
        }
        let bytes = std::fs::read(path)?;
        let mut decoded = Vec::new();
        if key.ends_with(".br") {
            brotli::Decompressor::new(bytes.as_slice(), 4096)
                .take(32 * 1024 * 1024 + 1)
                .read_to_end(&mut decoded)?;
        } else {
            decoded = bytes;
        }
        ensure!(
            decoded.len() <= 32 * 1024 * 1024,
            "knowledge body too large"
        );
        return Ok(Some(String::from_utf8(decoded)?));
    }
    crate::knowledge::read_content_text(state, &format!("knowledge-content/{key}")).await
}
/// Defaults to a dry run. Apply archives originals before a per-document CAS transaction.
/// `errors` is retained in the report; CLI callers must exit unsuccessfully when nonempty.
pub async fn backfill_records(state: &AppState, options: &Value) -> Result<Value> {
    let is_apply = options["apply"] == true;
    let database = options["database"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(|v| state.root.join(v));
    let doc_id = s(&options["docId"]).to_owned();
    let select_id = doc_id.clone();
    let (new_schema,ids,aliases)=with_conn(state,database.clone(),is_apply,move|conn|{
        let schema=query(conn,"PRAGMA table_info(knowledge_information_records)",&[])?.iter().any(|column|column["name"]=="doc_id");ensure!(!is_apply||schema,"apply migration 0142 before backfilling; preflight without --apply is supported on the old schema");
        let sql=format!("SELECT doc_id FROM knowledge_docs WHERE (source_type='information_feed' OR json_type(metadata_json,'$.informationExtraction') IS NOT NULL {}) {} ORDER BY doc_id",if schema{""}else{"OR EXISTS(SELECT 1 FROM knowledge_document_results x WHERE x.version_id=knowledge_docs.doc_id)"},if select_id.is_empty(){""}else{"AND doc_id=?"});
        let ids=if select_id.is_empty(){query(conn,&sql,&[])?}else{query(conn,&sql,&[&select_id])?};
        let aliases=query(conn,"SELECT s.short_name AS alias,s.code,s.short_name AS name FROM stock s UNION ALL SELECT a.alias,a.code,s.short_name AS name FROM stock_alias a JOIN stock s ON s.code=a.code",&[])?;Ok((schema,ids,aliases))
    }).await?;
    let archive_dir = state.root.join(
        options["archiveDir"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or("data/local/information-records-archives"),
    );
    let content_dir = options["contentDir"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(|v| state.root.join(v));
    let config = state.config("config/knowledge/information-feed.json")?;
    let ontology = state.config("config/knowledge/knowledge-ontology.json")?;
    let contract = legacy_contract()?;
    let mut result = json!({"dryRun":!is_apply,"schema":if new_schema{INFORMATION_STORAGE_VERSION}else{"legacy"},"scanned":0,"changed":0,"unchanged":0,"records":0,"verified":0,"unverified":0,"quarantined":0,"errors":[],"issueCounts":{},"archiveDir":if is_apply{json!(archive_dir.to_string_lossy())}else{Value::Null}});
    for id in ids {
        result["scanned"] = json!(result["scanned"].as_u64().unwrap() + 1);
        let doc_id = s(&id["doc_id"]).to_owned();
        let load_id = doc_id.clone();
        let operation=async{
            let original=with_conn(state,database.clone(),is_apply,move|conn|{let tx=conn.transaction()?;let row=snapshot(&tx,&load_id,new_schema)?;tx.commit()?;Ok(row)}).await?;
            let content=body(state,s(&original["content_key"]),content_dir.as_deref()).await?;
            let plan=match plan(&original,content.as_deref(),&aliases,&contract,&config["companyCandidates"],&ontology,chrono::Utc::now().timestamp_millis()){
                Ok(plan)=>plan,Err(error)=>{
                    let message=error.to_string();ensure!(options["quarantine"]==true||options["quarantineInvalid"]==true,"{message}");ensure!(!["conflicting","active legacy","changed"].iter().any(|v|message.contains(v)),"{message}");
                    let mut meta=original["meta"].clone();clear_legacy(&mut meta);let mut ext=meta["informationExtraction"].clone();if !ext.is_object(){ext=json!({});}ext["storageVersion"]=json!(INFORMATION_STORAGE_VERSION);ext["status"]=json!("failed");ext["current"]=meta["informationExtraction"]["current"].clone();ext["categoryCandidates"]=Value::Null;ext["migrationIssues"]=json!([message]);ext["lastAttempt"]=json!({"error":"malformed legacy extraction quarantined; see local archive","attempts":0});meta["informationExtraction"]=ext;
                    json!({"kind":"quarantine","meta":meta,"records":original["records"],"issues":[message]})
                }
            };
            if plan["kind"]=="unchanged"{return Ok::<Value,anyhow::Error>(plan);}
            if is_apply{archive(&archive_dir,&original)?;let saved_plan=plan.clone();with_conn(state,database.clone(),true,move|conn|apply(conn,&original,&saved_plan)).await?;}
            Ok(plan)
        }.await;
        match operation {
            Ok(plan) => {
                if plan["kind"] == "unchanged" {
                    result["unchanged"] = json!(result["unchanged"].as_u64().unwrap() + 1);
                    continue;
                }
                result["changed"] = json!(result["changed"].as_u64().unwrap() + 1);
                result["records"] = json!(
                    result["records"].as_u64().unwrap()
                        + plan["records"].as_array().map_or(0, Vec::len) as u64
                );
                for issue in plan["issues"].as_array().into_iter().flatten() {
                    let key = s(issue);
                    let count = result["issueCounts"][key].as_u64().unwrap_or(0);
                    result["issueCounts"][key] = json!(count + 1);
                }
                let kind = if plan["kind"] == "quarantine" {
                    "quarantined"
                } else if plan["meta"]["informationExtraction"]["current"]["provenanceStatus"]
                    == "verified"
                {
                    "verified"
                } else if plan["meta"]["informationExtraction"]["current"].is_object() {
                    "unverified"
                } else {
                    ""
                };
                if !kind.is_empty() {
                    result[kind] = json!(result[kind].as_u64().unwrap() + 1);
                }
            }
            Err(error) => result["errors"]
                .as_array_mut()
                .unwrap()
                .push(json!({"docId":doc_id,"error":error.to_string()})),
        }
    }
    if new_schema {
        let violations = with_conn(state, database, is_apply, |conn| {
            query(conn, "PRAGMA foreign_key_check", &[])
        })
        .await?;
        if !violations.is_empty() {
            result["errors"]
                .as_array_mut()
                .unwrap()
                .push(json!({"error":"foreign key check failed"}));
        }
        result["foreignKeyViolations"] = json!(violations);
    }
    if let Some(report) = options["report"].as_str().filter(|v| !v.is_empty()) {
        let path = state.root.join(report);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600);
        }
        let mut file = open.open(path)?;
        file.write_all(serde_json::to_string_pretty(&result)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ontology() -> Value {
        serde_json::from_str(include_str!(
            "../../../config/knowledge/knowledge-ontology.json"
        ))
        .unwrap()
    }
    #[test]
    fn provenance_never_invented_and_active_lease_is_retained() {
        let contract = legacy_contract().unwrap();
        let record = json!({"entity":"甲","informationType":"fact","category":"revenue","period":"2026Q1","statement":"甲营收增加","forecastMeasurement":null});
        let row = json!({"doc_id":"f_a","title":"甲营收","published_at":null,"source_type":"information_feed","content_sha256":null,"meta":{"feed":{"records":[record],"taggedAt":1,"taggingStatus":"complete"}},"records":[],"tags":[]});
        let plan = plan(&row, None, &[], &contract, &json!({}), &ontology(), 100).unwrap();
        assert_eq!(
            plan["meta"]["informationExtraction"]["current"]["provenanceStatus"],
            "legacy_unverified"
        );
        assert!(plan["meta"]["informationExtraction"]["current"]["model"].is_null());
        assert!(plan["meta"]["feed"].get("records").is_none());
        let mut row = row;
        row["meta"]["feed"]["taggingStatus"] = json!("processing");
        row["meta"]["feed"]["tagLeaseUntil"] = json!(101);
        assert!(self::plan(&row, None, &[], &contract, &json!({}), &ontology(), 100).is_err());
    }
    #[test]
    fn conflicting_counts_cannot_be_dropped() {
        let mut next = [json!({})];
        assert!(preserve_ids(&[], &mut next).is_err());
    }
    #[test]
    fn sqlite_apply_rechecks_snapshot_and_rolls_back_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("fixture.sqlite")).unwrap();
        db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let mut conn = db.connect().unwrap();
        let meta = json!({"feed":{"taggingStatus":"pending"}});
        conn.execute("INSERT INTO knowledge_docs(doc_id,source_type,title,metadata_json,updated_at) VALUES('f_a','information_feed','甲营收',?,0)",[serde_json::to_string(&meta).unwrap()]).unwrap();
        let original = snapshot(&conn, "f_a", true).unwrap();
        let next = plan(
            &original,
            None,
            &[],
            &legacy_contract().unwrap(),
            &json!({}),
            &ontology(),
            100,
        )
        .unwrap();
        assert_ne!(next["kind"], "unchanged");
        conn.execute(
            "UPDATE knowledge_docs SET title='并发修改' WHERE doc_id='f_a'",
            [],
        )
        .unwrap();
        assert!(apply(&mut conn, &original, &next).is_err());
        assert!(
            snapshot(&conn, "f_a", true).unwrap()["meta"]["feed"]
                .get("taggingStatus")
                .is_some()
        );
        conn.execute(
            "UPDATE knowledge_docs SET title='甲营收' WHERE doc_id='f_a'",
            [],
        )
        .unwrap();
        apply(&mut conn, &original, &next).unwrap();
        let saved = snapshot(&conn, "f_a", true).unwrap();
        assert!(saved["meta"]["feed"].get("taggingStatus").is_none());
        assert_eq!(saved["meta"]["informationExtraction"]["status"], "pending");
        assert!(saved["records"].as_array().unwrap().is_empty());
    }
    #[test]
    fn archives_are_verified_before_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let row = json!({"doc_id":"a","records":[],"tags":[]});
        archive(dir.path(), &row).unwrap();
        archive(dir.path(), &row).unwrap();
        let path = std::fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::write(path, b"corrupt").unwrap();
        assert!(archive(dir.path(), &row).is_err());
    }
}
