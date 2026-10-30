//! Explicit local maintenance commands. Dry-runs never delete data, and remote
//! switches are rejected before either SQLite or object-store mutations.
mod pdf_metadata;

use crate::{AppState, knowledge::ingest::writer};
use anyhow::{Context, Result, bail};
use chrono::{Duration, Utc};
use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("").trim()
}
fn integer(v: &Value, key: &str, fallback: i64) -> i64 {
    v[key]
        .as_i64()
        .or_else(|| string(v, key).parse().ok())
        .unwrap_or(fallback)
}
fn apply(options: &Value) -> bool {
    options["apply"] == true && options["dryRun"] != true
}
fn local(options: &Value) -> Result<()> {
    if options["remote"] == true
        || options["uploadContentRemote"] == true
        || options["writeWranglerVars"] == true
    {
        bail!("remote maintenance is retired; local data only")
    }
    Ok(())
}
fn path(state: &AppState, options: &Value, key: &str, fallback: &str) -> PathBuf {
    let input = string(options, key);
    state
        .root
        .join(if input.is_empty() { fallback } else { input })
}
fn config(state: &AppState, options: &Value) -> Result<Value> {
    let file = path(
        state,
        options,
        "config",
        "config/knowledge/knowledge-processing.json",
    );
    match fs::read(file) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound && string(options, "config").is_empty() =>
        {
            Ok(json!({}))
        }
        Err(e) => Err(e.into()),
    }
}
fn rows(file: &Path) -> Result<Vec<Value>> {
    let body = fs::read_to_string(file)?;
    let body = body.trim();
    if body.is_empty() {
        return Ok(vec![]);
    }
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return Ok(match value {
            Value::Array(a) => a,
            value => vec![value],
        });
    }
    body.lines()
        .filter(|s| !s.trim().is_empty())
        .map(|s| serde_json::from_str(s).map_err(Into::into))
        .collect()
}
fn atomic(file: &Path, bytes: &[u8], private: bool) -> Result<()> {
    let parent = file.parent().context("output has no parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = private;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(file).map_err(|e| e.error)?;
    Ok(())
}
fn jsonl(file: &Path, values: &[Value]) -> Result<()> {
    let mut bytes = Vec::new();
    for value in values {
        serde_json::to_writer(&mut bytes, value)?;
        bytes.push(b'\n');
    }
    atomic(file, &bytes, false)
}
fn merge_review_rows(state: &AppState, incoming: Vec<Value>) -> Result<Vec<Value>> {
    let mut by_id = crate::knowledge::review::load_rows(state)?
        .into_iter()
        .map(|row| (string(&row, "docId").to_string(), row))
        .collect::<BTreeMap<_, _>>();
    for row in incoming {
        by_id.insert(string(&row, "docId").to_string(), row);
    }
    Ok(by_id.into_values().collect())
}
fn review_dir(state: &AppState, options: &Value, config: &Value) -> PathBuf {
    if !string(options, "reviewDir").is_empty() {
        path(state, options, "reviewDir", "")
    } else if !string(config, "reviewDir").is_empty() {
        state.root.join(string(config, "reviewDir"))
    } else {
        state.root.join("data/knowledge-review")
    }
}
/// Stable native CLI dispatch; options use the historical camelCase names.
pub async fn run(state: &AppState, operation: &str, options: &Value) -> Result<Value> {
    local(options)?;
    match operation {
        "import-docs" => import(state, options, false).await,
        "import-filtered" => import(state, options, true).await,
        "migrate-localfs" => migrate(state, options).await,
        "cleanup-docs" => cleanup_docs(state, options).await,
        "pdf-metadata" => pdf_metadata::run(state, options).await,
        "cleanup-content" => cleanup_content(state, options).await,
        "filter-existing" => filter_existing(state, options).await,
        "storage-stats" => storage_stats(state, options).await,
        "refresh-eastmoney-cookie" => refresh_eastmoney(state, options).await,
        _ => bail!("unknown local maintenance operation: {operation}"),
    }
}
async fn import(state: &AppState, options: &Value, filtered: bool) -> Result<Value> {
    if string(options, "file").is_empty() {
        bail!("--file is required")
    }
    let docs = rows(&path(state, options, "file", ""))?;
    let mut cfg = config(state, options)?;
    cfg["remote"] = false.into();
    if filtered {
        // Migration 0115 deliberately removed rejected-review SQL tables. Preserve
        // the supported review/keep workflow in the existing file-backed ledger.
        let dir = review_dir(state, options, &cfg);
        fs::create_dir_all(&dir)?;
        let file = dir.join(format!(
            "topic-filter-import-{}.jsonl",
            Utc::now().format("%Y%m%dT%H%M%S%9fZ")
        ));
        let output = docs
            .iter()
            .map(|raw| {
                let mut doc = raw.get("doc").unwrap_or(raw).clone();
                if doc.is_object() {
                    for (camel, snake) in [
                        ("docId", "doc_id"),
                        ("sourceType", "source_type"),
                        ("reportType", "report_type"),
                        ("sourceName", "source_name"),
                        ("targetName", "target_name"),
                        ("targetCode", "target_code"),
                        ("publishedAt", "published_at"),
                    ] {
                        if doc.get(camel).is_none() {
                            doc[camel] = doc[snake].clone();
                        }
                    }
                    if string(&doc, "content").is_empty() {
                        doc["content"] = ["markdown", "mdText", "md_text"]
                            .iter()
                            .find_map(|key| doc.get(*key).filter(|v| !v.is_null()).cloned())
                            .unwrap_or(Value::Null);
                    }
                    for key in ["keep", "method", "score", "reasons", "confidence"] {
                        if let Some(v) = raw
                            .get("filter")
                            .or_else(|| raw.get("topic"))
                            .and_then(|filter| filter.get(key))
                            .or_else(|| raw.get(key))
                        {
                            doc[key] = v.clone();
                        }
                    }
                    doc["keep"] = false.into();
                }
                doc
            })
            .collect::<Vec<_>>();
        for doc in &output {
            if string(doc, "docId").is_empty() || string(doc, "title").is_empty() {
                bail!("filtered import requires docId and title")
            }
        }
        let merged = merge_review_rows(state, output.clone())?;
        jsonl(&file, &merged)?;
        return Ok(
            json!({"imported":output.len(),"storage":"local-review-jsonl","file":file,"remote":false}),
        );
    }
    let sync = string(options, "syncFile");
    if !sync.is_empty() {
        let f = state.root.join(sync);
        if f.exists() {
            cfg["syncEntries"] = rows(&f)?.into();
        }
    }
    let result = writer::import_documents(state, &docs, &cfg).await?;
    for key in ["syncFile", "resultFile"] {
        let file = string(options, key);
        if !file.is_empty() {
            let file = state.root.join(file);
            let mut old = if file.exists() { rows(&file)? } else { vec![] };
            old.extend(result["entries"].as_array().cloned().unwrap_or_default());
            jsonl(&file, &old)?;
        }
    }
    Ok(result)
}
async fn cleanup_docs(state: &AppState, options: &Value) -> Result<Value> {
    let cfg = config(state, options)?;
    let days = integer(
        options,
        "maxAgeDays",
        integer(&cfg["storageRetention"], "knowledgeDocsMaxAgeDays", 90),
    );
    let enabled = options["disableRetention"] != true && days > 0;
    if !enabled {
        return Ok(
            json!({"dryRun":!apply(options),"remote":false,"retentionEnabled":false,"maxAgeDays":days,"skipped":true,"reason":"knowledge docs retention disabled"}),
        );
    }
    let cutoff = (Utc::now() - Duration::try_days(days).context("maxAgeDays out of range")?)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let cutoff_copy = cutoff.clone();
    let destructive = apply(options);
    let result=state.db.run(move|conn|{let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let predicate="source_type != 'information_feed' AND coalesce(event_time,published_at,fetched_at,'') != '' AND datetime(coalesce(event_time,published_at,fetched_at)) < datetime(?)";
        let count:i64=tx.query_row(&format!("SELECT count(*) FROM knowledge_docs WHERE {predicate}"),[&cutoff_copy],|r|r.get(0))?;
        let refs:i64=tx.query_row(&format!("SELECT count(*) FROM knowledge_doc_content_refs WHERE doc_id IN (SELECT doc_id FROM knowledge_docs WHERE {predicate})"),[&cutoff_copy],|r|r.get(0))?;
        let deleted=if destructive{tx.execute(&format!("DELETE FROM knowledge_docs WHERE {predicate}"),[&cutoff_copy])?}else{0};tx.commit()?;
        Ok(json!({"dryRun":!destructive,"remote":false,"retentionEnabled":true,"maxAgeDays":days,"cutoffIso":cutoff_copy,"expiredDocs":count,"expiredContentRefs":refs,"deletedDocs":deleted}))}).await?;
    maintenance_state(state, options, "knowledge_docs_cleanup", &result).await?;
    Ok(result)
}
async fn maintenance_state(
    state: &AppState,
    options: &Value,
    name: &str,
    result: &Value,
) -> Result<()> {
    if options["skipRunRecord"] != true {
        let now = Utc::now().timestamp_millis();
        state.db.put_kv("knowledge_maintenance",name,&json!({"status":"success","source":name,"startedAt":now,"finishedAt":now,"stats":result,"error":""}),None).await?;
    }
    Ok(())
}
fn content_dir(state: &AppState, options: &Value) -> PathBuf {
    let configured = state.setting("KNOWLEDGE_CONTENT_LOCAL_DIR");
    if !string(options, "contentDir").is_empty() {
        path(state, options, "contentDir", "")
    } else if !configured.is_empty() {
        state.root.join(configured)
    } else {
        state.data_dir().join("knowledge-content")
    }
}
#[derive(Clone)]
struct Object {
    key: String,
    file: PathBuf,
    size: u64,
    modified: i64,
}
fn list_objects(root: &Path) -> Result<Vec<Object>> {
    fn visit(root: &Path, dir: &Path, out: &mut Vec<Object>) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                bail!("content maintenance rejects symlinks")
            }
            if meta.is_dir() {
                visit(root, &entry.path(), out)?;
            } else if meta.is_file() {
                let file = entry.path();
                let relative = file
                    .strip_prefix(root)?
                    .to_str()
                    .context("non-UTF8 content key")?
                    .replace('\\', "/");
                let key = if relative.starts_with("knowledge-content/") {
                    relative
                } else {
                    format!("knowledge-content/{relative}")
                };
                out.push(Object {
                    key,
                    file,
                    size: meta.len(),
                    modified: meta.modified()?.duration_since(UNIX_EPOCH)?.as_millis() as i64,
                });
            }
        }
        Ok(())
    }
    if !root.exists() {
        return Ok(vec![]);
    }
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        bail!("content root must not be symlink")
    }
    let mut out = vec![];
    visit(root, root, &mut out)?;
    out.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(out)
}
async fn reference_keys(state: &AppState) -> Result<BTreeSet<String>> {
    let mut keys = state
        .db
        .query(
            "SELECT content_key FROM knowledge_doc_content_refs WHERE content_key IS NOT NULL",
            vec![],
        )
        .await?
        .into_iter()
        .filter_map(|row| row["content_key"].as_str().map(str::to_string))
        .collect::<BTreeSet<_>>();
    if !state.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_filtered_doc_content_refs'",vec![]).await?.is_empty(){keys.extend(state.db.query("SELECT content_key FROM knowledge_filtered_doc_content_refs WHERE content_key IS NOT NULL",vec![]).await?.into_iter().filter_map(|row|row["content_key"].as_str().map(str::to_string)));}
    Ok(keys)
}
async fn cleanup_content(state: &AppState, options: &Value) -> Result<Value> {
    let prefix = if string(options, "prefix").is_empty() {
        "knowledge-content/"
    } else {
        string(options, "prefix")
    };
    if !prefix.starts_with("knowledge-content/")
        || Path::new(prefix)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        bail!("cleanup is restricted to knowledge-content/ keys")
    }
    let refs = reference_keys(state).await?;
    let objects = list_objects(&content_dir(state, options))?
        .into_iter()
        .filter(|o| o.key.starts_with(prefix))
        .collect::<Vec<_>>();
    let existing = objects
        .iter()
        .map(|o| o.key.clone())
        .collect::<BTreeSet<_>>();
    let minimum = integer(options, "minAgeDays", 7);
    if minimum < 0 {
        bail!("minAgeDays must be nonnegative")
    }
    let cutoff = Utc::now()
        .timestamp_millis()
        .checked_sub(
            minimum
                .checked_mul(86_400_000)
                .context("minAgeDays out of range")?,
        )
        .context("minAgeDays out of range")?;
    let orphans = objects
        .iter()
        .filter(|o| !refs.contains(&o.key) && o.modified <= cutoff)
        .collect::<Vec<_>>();
    let missing = refs
        .iter()
        .filter(|key| key.starts_with(prefix) && !existing.contains(*key))
        .cloned()
        .collect::<Vec<_>>();
    if apply(options) {
        for object in &orphans {
            let meta = fs::symlink_metadata(&object.file)?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                bail!("content object changed during cleanup")
            };
            fs::remove_file(&object.file)?;
        }
    }
    let result = json!({"dryRun":!apply(options),"remote":false,"prefix":prefix,"minAgeDays":minimum,"referencedKeys":refs.iter().filter(|s|s.starts_with(prefix)).count(),"bucketObjects":objects.len(),"orphanObjects":orphans.len(),"orphanBytes":orphans.iter().map(|o|o.size).sum::<u64>(),"deletedObjects":if apply(options){orphans.len()}else{0},"missingRefs":missing.len(),"missingRefSample":missing.iter().take(20).collect::<Vec<_>>(),"orphanSample":orphans.iter().take(20).map(|o|json!({"key":o.key,"size":o.size,"lastModifiedMs":o.modified})).collect::<Vec<_>>()});
    maintenance_state(state, options, "knowledge_content_cleanup", &result).await?;
    Ok(result)
}
async fn migrate(state: &AppState, options: &Value) -> Result<Value> {
    let mut updates = vec![];
    let mut scopes = vec![("knowledge_docs", "knowledge_doc_content_refs")];
    if !state.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_filtered_doc_content_refs'",vec![]).await?.is_empty(){scopes.push(("knowledge_filtered_docs","knowledge_filtered_doc_content_refs"));}
    for (scope, table) in scopes {
        for row in state.db.query(format!("SELECT doc_id,content_key FROM {table} WHERE content_key LIKE 'localfs:%' ORDER BY doc_id"),vec![]).await?{
        let input=string(&row,"content_key").strip_prefix("localfs:").context("invalid localfs key")?;let markdown=fs::read_to_string(input)?.trim().to_string();let sha=format!("{:x}",Sha256::digest(markdown.as_bytes()));let id=string(&row,"doc_id");let idhash=format!("{:x}",Sha256::digest(id.as_bytes()));
        let mut payload=markdown.as_bytes().to_vec();let mut encoding="identity";if payload.len()>=4096{let mut compressed=vec![];{let mut writer=brotli::CompressorWriter::new(&mut compressed,4096,5,22);writer.write_all(&payload)?;}if compressed.len()<payload.len(){payload=compressed;encoding="br";}}
        let extension=if encoding=="br"{"md.br"}else{"md"};let key=format!("knowledge-content/{}/{}-{}.{}",&idhash[..2],idhash,&sha[..12],extension);
        if apply(options) {crate::storage::ObjectStore::new(content_dir(state,options))?.put(crate::knowledge::object_key(&key),payload.clone()).await?;}
        updates.push(json!({"scope":scope,"refTable":table,"docId":id,"oldKey":row["content_key"],"contentKey":key,"contentUrl":crate::knowledge::local_content_url(state,&key),"contentType":"text/markdown; charset=utf-8","contentEncoding":encoding,"contentBytes":payload.len(),"contentSha256":sha}));
    }
    }
    if apply(options) {
        let copy = updates.clone();
        state.db.run(move|conn|{let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;for update in copy{let table=string(&update,"refTable");let sql=format!("UPDATE {table} SET content_key=?,content_url=?,content_type=?,content_encoding=?,content_bytes=?,content_sha256=?,updated_at=? WHERE doc_id=? AND content_key=?");let changed=tx.execute(&sql,params![update["contentKey"].as_str(),update["contentUrl"].as_str(),update["contentType"].as_str(),update["contentEncoding"].as_str(),update["contentBytes"].as_i64(),update["contentSha256"].as_str(),Utc::now().timestamp_millis(),update["docId"].as_str(),update["oldKey"].as_str()])?;if changed!=1{bail!("localfs reference changed concurrently; rerun migration")}}tx.commit()?;Ok(())}).await?;
    }
    Ok(
        json!({"dryRun":!apply(options),"remote":false,"updated":updates.len(),"scopeCounts":{"knowledge_docs":updates.iter().filter(|u|u["scope"]=="knowledge_docs").count(),"knowledge_filtered_docs":updates.iter().filter(|u|u["scope"]=="knowledge_filtered_docs").count()},"sample":updates.into_iter().take(5).collect::<Vec<_>>()}),
    )
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_lowercase)
        .collect()
}
fn blacklist(doc: &Value, filter: &Value) -> Vec<String> {
    if strings(&filter["bypassSourceTypes"]).contains(&string(doc, "sourceType").to_lowercase())
        || strings(&filter["bypassReportTypes"]).contains(&string(doc, "reportType").to_lowercase())
    {
        return vec![];
    }
    let linked = [
        &doc["stockLinks"],
        &doc["metadata"]["stockList"],
        &doc["metadata"]["stockNames"],
        &doc["metadata"]["stockCodes"],
    ]
    .iter()
    .any(|v| v.as_array().is_some_and(|a| !a.is_empty()));
    let title = string(doc, "title").to_lowercase();
    let mut labels = strings(&doc["tags"]);
    labels.extend(
        doc["metadata"]["subjects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                s["subject_name"]
                    .as_str()
                    .or(s["subjectName"].as_str())
                    .or(s["name"].as_str())
            })
            .map(str::to_lowercase),
    );
    let labels = labels.join(" ");
    let haystack = format!(
        "{} {} {} {}",
        title,
        string(doc, "summary").to_lowercase(),
        labels,
        doc["metadata"].to_string().to_lowercase()
    );
    if linked
        || strings(&filter["marketOverrideKeywords"])
            .iter()
            .any(|s| haystack.contains(s))
    {
        return vec![];
    }
    filter["blacklistRules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|rule| {
            let id = string(rule, "id");
            let all_title = strings(&rule["titleAll"]);
            let any_title = strings(&rule["titleAny"]);
            let all_labels = strings(&rule["labelAll"]);
            let any_labels = strings(&rule["labelAny"]);
            let matches = !id.is_empty()
                && all_title.len() + any_title.len() + all_labels.len() + any_labels.len() > 0
                && all_title.iter().all(|s| title.contains(s))
                && (any_title.is_empty() || any_title.iter().any(|s| title.contains(s)))
                && all_labels.iter().all(|s| labels.contains(s))
                && (any_labels.is_empty() || any_labels.iter().any(|s| labels.contains(s)));
            matches.then(|| format!("黑名单:{id}"))
        })
        .collect()
}
async fn filter_existing(state: &AppState, options: &Value) -> Result<Value> {
    let cfg = config(state, options)?;
    let filter = &cfg["topicFilter"];
    if filter["enabled"] != true || filter["mode"] != "blacklist" {
        bail!("topicFilter must be enabled with mode=blacklist")
    }
    let documents=state.db.query("SELECT d.*,coalesce((SELECT json_group_array(tag) FROM knowledge_doc_tags t WHERE t.doc_id=d.doc_id),'[]') AS tags_json FROM knowledge_docs d WHERE d.source_type!='information_feed' ORDER BY d.doc_id",vec![]).await?;
    let mut filtered = vec![];
    for row in &documents {
        let mut doc = json!({"metadata":serde_json::from_str::<Value>(string(row,"metadata_json")).unwrap_or(json!({})),"tags":serde_json::from_str::<Value>(string(row,"tags_json")).unwrap_or(json!([]))});
        for (camel, snake) in [
            ("docId", "doc_id"),
            ("sourceType", "source_type"),
            ("reportType", "report_type"),
            ("sourceName", "source_name"),
            ("title", "title"),
            ("url", "url"),
            ("summary", "summary"),
            ("publishedAt", "published_at"),
            ("eventTime", "event_time"),
            ("targetName", "target_name"),
            ("targetCode", "target_code"),
        ] {
            doc[camel] = row[snake].clone();
        }
        let reasons = blacklist(&doc, filter);
        if !reasons.is_empty() {
            doc["keep"] = false.into();
            doc["method"] = "blacklist".into();
            doc["score"] = (-2 * reasons.len() as i64).into();
            doc["reasons"] = reasons.into();
            if let Some(content) = state
                .db
                .query(
                    "SELECT content_key FROM knowledge_doc_content_refs WHERE doc_id=?",
                    vec![doc["docId"].clone()],
                )
                .await?
                .first()
            {
                doc["content"] =
                    crate::knowledge::read_content_text(state, string(content, "content_key"))
                        .await?
                        .unwrap_or_default()
                        .into();
            }
            filtered.push(doc)
        }
    }
    let dir = review_dir(state, options, &cfg);
    let file = dir.join(format!(
        "topic-filter-historical-{}.jsonl",
        Utc::now().format("%Y%m%dT%H%M%S%9fZ")
    ));
    let merged = merge_review_rows(state, filtered.clone())?;
    jsonl(&file, &merged)?;
    if apply(options) {
        let ids = filtered
            .iter()
            .map(|d| string(d, "docId").to_owned())
            .collect::<Vec<_>>();
        state.db.run(move|conn|{let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;for id in ids{tx.execute("DELETE FROM knowledge_docs WHERE doc_id=? AND source_type!='information_feed'",[id])?;}tx.commit()?;Ok(())}).await?;
    }
    let mut by_rule = BTreeMap::<String, usize>::new();
    let mut by_source = BTreeMap::<String, usize>::new();
    for doc in &filtered {
        for reason in strings(&doc["reasons"]) {
            *by_rule.entry(reason).or_default() += 1;
        }
        *by_source
            .entry(string(doc, "sourceType").into())
            .or_default() += 1;
    }
    Ok(
        json!({"mode":"blacklist","ruleVersion":filter["ruleVersion"],"applied":apply(options),"scanned":documents.len(),"filtered":filtered.len(),"byRule":by_rule,"bySource":by_source,"logFile":file,"samples":filtered.iter().take(20).map(|d|json!({"docId":d["docId"],"title":d["title"],"reasons":d["reasons"]})).collect::<Vec<_>>()}),
    )
}
async fn storage_stats(state: &AppState, options: &Value) -> Result<Value> {
    let result=state.db.run(|conn|{let page_size:i64=conn.pragma_query_value(None,"page_size",|r|r.get(0))?;let pages:i64=conn.pragma_query_value(None,"page_count",|r|r.get(0))?;let free:i64=conn.pragma_query_value(None,"freelist_count",|r|r.get(0))?;
        let mut stmt=conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'knowledge_%' OR name IN ('stock','stock_alias')) ORDER BY name")?;let tables=stmt.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;let mut stats=vec![];for table in tables{let safe=table.replace('"',"\"\"");let count:i64=conn.query_row(&format!("SELECT count(*) FROM \"{safe}\""),[],|r|r.get(0))?;let mut cols=conn.prepare(&format!("PRAGMA table_info(\"{safe}\")"))?;let names=cols.query_map([],|r|r.get::<_,String>(1))?.collect::<Result<Vec<_>,_>>()?;let expression=names.iter().map(|c|format!("length(cast(coalesce(\"{}\",'') AS blob))",c.replace('"',"\"\""))).collect::<Vec<_>>().join("+");let bytes:i64=conn.query_row(&format!("SELECT coalesce(sum({expression}),0) FROM \"{safe}\""),[],|r|r.get(0))?;stats.push(json!({"scope":table,"rowCount":count,"approxBytes":bytes}));}
        Ok(json!({"totalBytes":page_size*pages,"usedBytes":page_size*(pages-free),"freeBytes":page_size*free,"pageCount":pages,"pageSize":page_size,"freelistCount":free,"exactSizeAvailable":true,"tables":stats}))}).await?;
    let objects = list_objects(&content_dir(state, options))?;
    let categories=state.db.query("SELECT source_type AS category,count(*) AS rowCount FROM knowledge_docs GROUP BY source_type ORDER BY source_type",vec![]).await?;
    Ok(
        json!({"remote":false,"sqlite":result,"categories":categories,"localContent":{"objects":objects.len(),"bytes":objects.iter().map(|o|o.size).sum::<u64>(),"directory":content_dir(state,options)},"filteredReviews":crate::knowledge::review::load_rows(state)?.len()}),
    )
}
fn merge_cookies(
    existing: &str,
    replacements: impl IntoIterator<Item = String>,
) -> (String, Vec<String>) {
    let mut values = BTreeMap::new();
    let mut order = vec![];
    let mut changed = vec![];
    for (index, cookie) in std::iter::once(existing.to_owned())
        .chain(replacements)
        .enumerate()
    {
        for pair in cookie
            .split(';')
            .take(if index == 0 { usize::MAX } else { 1 })
        {
            if let Some((name, value)) = pair.trim().split_once('=') {
                let name = name.trim();
                if name.is_empty() {
                    continue;
                }
                if !values.contains_key(name) {
                    order.push(name.to_string());
                }
                values.insert(name.to_string(), value.trim().to_string());
                if index > 0 {
                    changed.push(name.to_string());
                }
            }
        }
    }
    (
        order
            .iter()
            .map(|name| format!("{name}={}", values[name]))
            .collect::<Vec<_>>()
            .join("; "),
        changed,
    )
}
async fn refresh_eastmoney(state: &AppState, options: &Value) -> Result<Value> {
    use reqwest::header::{COOKIE, HeaderMap, HeaderValue, REFERER, SET_COOKIE, USER_AGENT};
    let cookie = state.setting("EASTMONEY_COOKIE");
    if cookie.trim().is_empty() {
        bail!("EASTMONEY_COOKIE is required before refreshing the browser session")
    }
    let mut headers = HeaderMap::new();
    headers.insert(COOKIE, HeaderValue::from_str(&cookie)?);
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://quote.eastmoney.com/"),
    );
    headers.insert(USER_AGENT,HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"));
    let (_, headers) = state
        .http
        .bytes("https://quote.eastmoney.com/sz300308.html", headers)
        .await?;
    let replacements = headers
        .get_all(SET_COOKIE)
        .iter()
        .map(|v| v.to_str().map(str::to_string))
        .collect::<Result<Vec<_>, _>>()?;
    if replacements.is_empty() {
        bail!("Eastmoney returned no Set-Cookie; existing session retained")
    }
    let (cookie, names) = merge_cookies(&cookie, replacements);
    let file = state.root.join(".dev.vars");
    let old = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let line = format!("EASTMONEY_COOKIE={}", serde_json::to_string(&cookie)?);
    let mut found = false;
    let mut output = old
        .lines()
        .map(|s| {
            if s.starts_with("EASTMONEY_COOKIE=") {
                found = true;
                line.clone()
            } else {
                s.to_string()
            }
        })
        .collect::<Vec<_>>();
    if !found {
        output.push(line)
    };
    atomic(&file, format!("{}\n", output.join("\n")).as_bytes(), true)?;
    let _ = options;
    Ok(
        json!({"names":names,"issuedBy":"https://quote.eastmoney.com/sz300308.html","writtenToDevVars":true,"remote":false}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookie_rotation_preserves_order_and_values() {
        let (cookie, names) = merge_cookies(
            "a=1; b=token=x",
            ["b=2; Path=/; HttpOnly".into(), "c=3; Secure".into()],
        );
        assert_eq!(cookie, "a=1; b=2; c=3");
        assert_eq!(names, vec!["b", "c"]);
    }
    #[test]
    fn deterministic_blacklist_keeps_market_or_report_evidence() {
        let filter = json!({"bypassSourceTypes":["research_report"],"marketOverrideKeywords":["股票"],"blacklistRules":[{"id":"military","titleAll":["联合训练","空军"]}]});
        assert_eq!(
            blacklist(&json!({"title":"空军联合训练"}), &filter),
            vec!["黑名单:military"]
        );
        for doc in [
            json!({"title":"股票 空军联合训练"}),
            json!({"title":"空军联合训练","sourceType":"research_report"}),
            json!({"title":"空军联合训练","metadata":{"stockCodes":["600036.SH"]}}),
        ] {
            assert!(blacklist(&doc, &filter).is_empty());
        }
    }
}
