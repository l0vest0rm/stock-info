//! Native, explicit local information-feed processing. No background watcher or publication.
mod extraction;
mod maintenance;
mod records_backfill;
pub mod rules;
use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::Utc;
pub use maintenance::{backfill_relevance, reconcile};
use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub(super) fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(super) fn metadata(row: &Value) -> Result<Value> {
    {
        let v: Value = serde_json::from_str(text(&row["metadata_json"]))?;
        if !v.is_object() {
            bail!("feed metadata must be an object")
        }
        Ok(v)
    }
}
pub(super) async fn rows(state: &AppState) -> Result<Vec<Value>> {
    state.db.query("select d.*,c.content_key,c.content_sha256,(select count(*) from knowledge_information_records r where r.doc_id=d.doc_id) record_count from knowledge_docs d left join knowledge_doc_content_refs c on c.doc_id=d.doc_id where d.source_type='information_feed' order by d.sort_time desc,d.doc_id desc",vec![]).await
}
pub(super) async fn read_body(state: &AppState, key: &str) -> Result<Option<String>> {
    let Some(key) = key.strip_prefix("knowledge-content/") else {
        return Ok(None);
    };
    let Some(bytes) = state.knowledge_store()?.get(key).await? else {
        return Ok(None);
    };
    let decoded = if key.ends_with(".br") {
        let mut out = Vec::new();
        brotli::Decompressor::new(bytes.as_slice(), 4096).read_to_end(&mut out)?;
        out
    } else {
        bytes
    };
    Ok(Some(String::from_utf8(decoded)?))
}
pub(super) fn local_path(state: &AppState, name: &str, default: &str) -> PathBuf {
    let s = state.setting(name);
    state.root.join(if s.is_empty() { default } else { &s })
}
pub(super) fn save_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        serde_json::to_writer(&mut f, value)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn load_json(path: &Path, default: Value) -> Result<Value> {
    match fs::read(path) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(e) => Err(e.into()),
    }
}
pub(super) struct FeedLock(PathBuf);
impl Drop for FeedLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub(super) async fn lock(state: &AppState) -> Result<FeedLock> {
    let path = local_path(
        state,
        "INFORMATION_FEED_LOCK_FILE",
        "data/local/information-feed.lock",
    );
    fs::create_dir_all(path.parent().context("lock parent")?)?;
    let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&path).context("feed processing lock exists; another runner may be active (verify stale owner before removing)")?;
    if let Err(e) = writeln!(f, "{}", std::process::id()) {
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(FeedLock(path))
}
fn millis(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc().timestamp_millis())
        })
}
fn recent(s: &str, hours: i64) -> bool {
    millis(s).is_some_and(|t| {
        t <= Utc::now().timestamp_millis() && t >= Utc::now().timestamp_millis() - hours * 3600000
    })
}
fn count(c: &mut Value, key: &str) {
    c[key] = json!(c[key].as_u64().unwrap_or(0) + 1)
}
fn source_ref(source: &Value) -> Value {
    json!({"sourceKey":source["sourceKey"],"sourceItemId":source["sourceItemId"],"url":source["url"],"publishedAt":source["publishedAt"],"contentHash":rules::body_hash(text(&source["body"]))})
}
fn merge_refs(old: &Value, new: &[Value]) -> Value {
    let mut refs = old.as_array().cloned().unwrap_or_default();
    for r in new {
        let same = |x: &Value| {
            ["sourceKey", "sourceItemId", "url"]
                .iter()
                .all(|k| x[*k] == r[*k])
        };
        if let Some(i) = refs.iter().position(same) {
            refs[i] = r.clone()
        } else {
            refs.push(r.clone())
        }
    }
    json!(refs)
}
async fn audit(state: &AppState, source: &Value, gate: &Value) -> Result<()> {
    let mut row = gate.clone();
    for key in ["sourceKey", "sourceItemId", "url", "title", "publishedAt"] {
        row[key] = source[key].clone()
    }
    crate::runtime_jobs::append_rejected_feed(
        &row,
        &local_path(
            state,
            "INFORMATION_FEED_RELEVANCE_AUDIT_FILE",
            "data/local/information-feed-relevance-rejected.jsonl",
        ),
    )
}
async fn stock_entries(state: &AppState) -> Result<Value> {
    Ok(rules::stock_entries(&state.db.query("select s.code,s.short_name,a.alias from stock s left join stock_alias a on a.code=s.code where s.information_feed_focus=1",vec![]).await?))
}
fn scan_files(dir: &Path, cutoff: i64, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let date_pattern = regex::Regex::new(r"\d{4}-\d{2}-\d{2}")?;
    for e in fs::read_dir(dir)? {
        let e = e?;
        let ty = e.file_type()?;
        if ty.is_symlink() {
            continue;
        }
        if ty.is_dir() {
            scan_files(&e.path(), cutoff, out)?
        } else if ty.is_file()
            && matches!(
                e.path().extension().and_then(|s| s.to_str()),
                Some("json" | "jsonl")
            )
        {
            let p = e.path();
            let date = date_pattern
                .find(&p.to_string_lossy())
                .and_then(|m| millis(m.as_str()));
            if date.is_none_or(|d| d >= cutoff) {
                out.push(p)
            }
        }
    }
    Ok(())
}
fn parse_file(path: &Path) -> Result<Vec<Value>> {
    let raw = fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }
    if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
        let mut rows = raw
            .lines()
            .filter(|s| !s.trim().is_empty())
            .map(serde_json::from_str)
            .collect::<std::result::Result<Vec<Value>, _>>()?;
        if path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("cls-telegraph-"))
        {
            rows.reverse()
        }
        Ok(rows)
    } else {
        let v: Value = serde_json::from_str(&raw)?;
        Ok(v.as_array().cloned().unwrap_or_else(|| vec![v]))
    }
}

/// Options mirror the former process:feed flags, in camelCase.
pub async fn process(state: &AppState, options: Value) -> Result<Value> {
    let mode = options["mode"].as_str().unwrap_or("run");
    let max_docs = options["maxDocuments"].as_i64().unwrap_or(200);
    let max_tags = options["maxTags"].as_i64().unwrap_or(20);
    let days = options["lookbackDays"].as_i64().unwrap_or(3);
    let hours = options["maxAgeHours"].as_i64().unwrap_or(48);
    let doc = text(&options["docId"]);
    let retry = options["retryFailed"] == true;
    if !["ingest", "tag", "run"].contains(&mode)
        || max_docs < 1
        || max_tags < 1
        || days < 1
        || !(1..=48).contains(&hours)
        || (retry && (mode != "tag" || doc.is_empty()))
        || (!doc.is_empty()
            && (mode != "tag" || !regex::Regex::new(r"^f_[a-f0-9]{24}$")?.is_match(doc)))
    {
        bail!("invalid information feed arguments")
    }
    if mode != "ingest" && state.setting("LLM_RUNTIME") != "local" {
        bail!("information feed tagging requires LLM_RUNTIME=local")
    }
    let _guard = lock(state).await?;
    let mut counters = json!({"scanned":0,"accepted":0,"repeat":0,"update":0,"new":0,"relevanceRejected":0,"relevanceUncertain":0,"rejected":{},"tagged":0,"tagFailed":0,"quotaExhausted":false});
    if mode != "tag" {
        ingest(state, &options, max_docs, days, hours, &mut counters).await?;
    }
    if mode != "ingest" {
        refresh_gates(state).await?;
        let tagged = extraction::tag_pending(state, &options).await?;
        for key in ["tagged", "tagFailed", "quotaExhausted"] {
            counters[key] = tagged[key].clone();
        }
    }
    Ok(counters)
}
async fn ingest(
    state: &AppState,
    options: &Value,
    max_docs: i64,
    days: i64,
    hours: i64,
    counters: &mut Value,
) -> Result<()> {
    let entries = stock_entries(state).await?;
    let policy = state.config("config/knowledge/information-feed-policy.json")?;
    let state_path = local_path(
        state,
        "INFORMATION_FEED_STATE_FILE",
        "data/local/information-feed-ingest-state.json",
    );
    let mut cursor = load_json(&state_path, json!({"files":{}}))?;
    let gate_version = format!(
        "{}:{}",
        text(&policy["relevance"]["version"]),
        sha(&serde_json::to_string(&entries)?)
    );
    if cursor["investmentGateVersion"] != gate_version {
        cursor["files"] = json!({});
        cursor["investmentGateVersion"] = json!(gate_version);
    }
    let explicit = text(&options["file"]);
    let mut files = vec![];
    if !explicit.is_empty() {
        files.push(state.root.join(explicit));
    } else {
        let input = state.setting("INFORMATION_FEED_INPUT_DIR");
        scan_files(
            Path::new(if input.is_empty() {
                "/Users/terry/git/data/news"
            } else {
                &input
            }),
            Utc::now().timestamp_millis() - days * 86400000,
            &mut files,
        )?;
        files.sort();
        files.reverse();
    }
    let mut candidates = vec![];
    for mut row in rows(state).await? {
        let Some(body) = read_body(state, text(&row["content_key"])).await? else {
            continue;
        };
        let meta = metadata(&row)?;
        if rules::evaluate_relevance(text(&row["title"]), &body, &entries, &policy)?["effectiveDisposition"]
            != "pass"
        {
            continue;
        }
        if sha(&body) != text(&row["content_sha256"]) {
            continue;
        }
        row["body"] = json!(body);
        row["feed"] = meta["feed"].clone();
        for field in ["sourceKey", "sourceItemId", "entityCodes"] {
            row[field] = meta["feed"][field].clone();
        }
        candidates.push(row);
    }
    for file in files {
        if counters["scanned"].as_i64().unwrap_or(0) >= max_docs {
            break;
        }
        let cls = file
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("cls-telegraph-"));
        let signature = sha(&format!(
            "{}{}",
            if cls { "cls-newest-first-v2|" } else { "" },
            fs::read_to_string(&file)?
        ));
        let key = file.to_string_lossy().to_string();
        if explicit.is_empty() && cursor["files"][&key] == signature {
            continue;
        }
        let items = parse_file(&file)?;
        let start =
            if explicit.is_empty() && !cls && cursor["files"][&key]["signature"] == signature {
                cursor["files"][&key]["nextIndex"].as_u64().unwrap_or(0) as usize
            } else {
                0
            };
        for (index, raw) in items.iter().enumerate().skip(start) {
            if counters["scanned"].as_i64().unwrap_or(0) >= max_docs {
                break;
            }
            let source = rules::normalize_source(raw)?;
            if source["accepted"] == true
                && !recent(
                    if text(&source["publishedAt"]).is_empty() {
                        text(&source["fetchedAt"])
                    } else {
                        text(&source["publishedAt"])
                    },
                    hours,
                )
            {
                count(&mut counters["rejected"], "outside_48_hour_window");
            } else {
                let known = cls
                    && candidates.iter().any(|c| {
                        c["feed"]["sources"].as_array().is_some_and(|refs| {
                            refs.iter().any(|r| {
                                r["sourceKey"] == source["sourceKey"]
                                    && if text(&source["sourceItemId"]).is_empty() {
                                        r["url"] == source["url"]
                                    } else {
                                        r["sourceItemId"] == source["sourceItemId"]
                                    }
                                    && r["contentHash"] == rules::body_hash(text(&source["body"]))
                            })
                        })
                    });
                if !known {
                    count(counters, "scanned");
                    if source["accepted"] != true {
                        count(&mut counters["rejected"], text(&source["reason"]));
                    } else {
                        ingest_one(state, &source, &entries, &policy, &mut candidates, counters)
                            .await?;
                    }
                }
            }
            if explicit.is_empty() {
                cursor["files"][&key] = if index + 1 == items.len() {
                    json!(signature)
                } else {
                    json!({"signature":signature,"nextIndex":index+1})
                };
                save_json(&state_path, &cursor)?;
            }
        }
    }
    Ok(())
}
async fn ingest_one(
    state: &AppState,
    source: &Value,
    entries: &Value,
    policy: &Value,
    candidates: &mut Vec<Value>,
    counters: &mut Value,
) -> Result<()> {
    count(counters, "accepted");
    let gate = rules::evaluate_relevance(
        text(&source["title"]),
        text(&source["body"]),
        entries,
        policy,
    )?;
    if gate["effectiveDisposition"] == "reject" {
        count(counters, "relevanceRejected");
        audit(state, source, &gate).await?;
        return Ok(());
    }
    let exact_hash = rules::body_hash(text(&source["body"]));
    let choice = if let Some(c) = candidates
        .iter()
        .find(|c| c["feed"]["fullBodyHash"] == exact_hash)
    {
        json!({"kind":"repeat","candidate":c})
    } else {
        {
            let nearby: Vec<_> = candidates
                .iter()
                .filter(|c| {
                    let identity = c["feed"]["sources"].as_array().is_some_and(|refs| {
                        refs.iter().any(|r| {
                            r["sourceKey"] == source["sourceKey"]
                                && if !text(&source["sourceItemId"]).is_empty()
                                    && !text(&r["sourceItemId"]).is_empty()
                                {
                                    r["sourceItemId"] == source["sourceItemId"]
                                } else {
                                    !text(&source["url"]).is_empty() && r["url"] == source["url"]
                                }
                        })
                    });
                    let time = |v: &Value| {
                        millis(if text(&v["publishedAt"]).is_empty() {
                            text(&v["fetchedAt"])
                        } else {
                            text(&v["publishedAt"])
                        })
                    };
                    let ct = millis(if text(&c["published_at"]).is_empty() {
                        text(&c["fetched_at"])
                    } else {
                        text(&c["published_at"])
                    });
                    identity
                        || ct
                            .zip(time(source))
                            .is_some_and(|(a, b)| (a - b).abs() < 7 * 86400000)
                            && rules::sketches_overlap(
                                &rules::sketch(text(&source["body"])),
                                &c["feed"]["sketch"],
                            )
                })
                .cloned()
                .collect();
            rules::classify(source, &nearby)
        }
    };
    let kind = text(&choice["kind"]);
    let candidate = if choice["candidate"].is_object() {
        choice["candidate"].clone()
    } else {
        candidates
            .iter()
            .find(|c| c["doc_id"] == choice["candidate"])
            .cloned()
            .unwrap_or(Value::Null)
    };
    if kind == "repeat" {
        count(counters, "repeat");
        let story = candidate["feed"]["storyKey"].clone();
        let new_ref = source_ref(source);
        let updates=state.db.run(move|db|{let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let snapshots={let mut stmt=tx.prepare("select doc_id,metadata_json from knowledge_docs where source_type='information_feed' and json_extract(metadata_json,'$.feed.storyKey')=?")?;stmt.query_map(params![text(&story)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?};
            let mut updates=Vec::new();for (id,raw) in snapshots{let mut meta:Value=serde_json::from_str(&raw)?;let refs=merge_refs(&meta["feed"]["sources"],std::slice::from_ref(&new_ref));meta["feed"]["sources"]=refs.clone();tx.execute("update knowledge_docs set metadata_json=?,updated_at=? where doc_id=?",params![meta.to_string(),Utc::now().timestamp_millis(),id])?;updates.push((id,refs));}tx.commit()?;Ok(updates)
        }).await?;
        for (id, refs) in updates {
            if let Some(c) = candidates.iter_mut().find(|c| c["doc_id"] == id) {
                c["feed"]["sources"] = refs;
            }
        }
        return Ok(());
    }
    let body = if kind == "update" {
        text(&choice["delta"])
    } else {
        text(&source["body"])
    };
    if body.is_empty() {
        bail!("dedupe returned empty document")
    }
    let gate = rules::evaluate_relevance(text(&source["title"]), body, entries, policy)?;
    if gate["effectiveDisposition"] == "reject" {
        count(counters, "relevanceRejected");
        audit(state, source, &gate).await?;
        return Ok(());
    }
    let id = format!(
        "f_{}",
        &sha(&format!("{}|{}", text(&source["identityKey"]), exact_hash))[..24]
    );
    if candidates.iter().any(|c| c["doc_id"] == id) {
        return Ok(());
    }
    let content_hash = sha(body);
    let id_hash = sha(&id);
    let relative = format!("{}/{}-{}.md", &id_hash[..2], id_hash, &content_hash[..12]);
    let key = format!("knowledge-content/{relative}");
    state
        .knowledge_store()?
        .put(&relative, body.as_bytes().to_vec())
        .await?;
    let refs = if kind == "update" {
        merge_refs(&candidate["feed"]["sources"], &[source_ref(source)])
    } else {
        json!([source_ref(source)])
    };
    let story = if kind == "update" {
        candidate["feed"]["storyKey"].clone()
    } else {
        json!(id)
    };
    let feed = json!({"version":"v1","dedupeVersion":"feed-dedupe-v3","kind":kind,"storyKey":story,"previousItemId":if kind=="update"{candidate["doc_id"].clone()}else{Value::Null},"fullBodyHash":exact_hash,"sketch":rules::sketch(text(&source["body"])),"entityCodes":source["entityCodes"],"originalFormat":"text","contentType":source["contentType"],"investmentGate":gate,"sourceKey":source["sourceKey"],"sourceItemId":source["sourceItemId"],"sources":refs});
    let meta = json!({"feed":feed,"informationExtraction":{"storageVersion":"information-records-v1","status":"pending","current":null,"categoryCandidates":null}});
    let sort = if kind == "update" || text(&source["publishedAt"]).is_empty() {
        source["fetchedAt"].clone()
    } else {
        source["publishedAt"].clone()
    };
    let source = source.clone();
    let body = body.to_owned();
    let id_for_db = id.clone();
    let meta_for_db = meta.to_string();
    let key_for_db = key.clone();
    let sort_db = sort.clone();
    state.db.run(move|db|{let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;let now=Utc::now().timestamp_millis();
        tx.execute("insert into knowledge_docs(doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,event_time,access_method,summary,content_preview,metadata_json,sort_time,source_name_normalized,updated_at) values (?,'information_feed',?,?,?,?,?,?,?,'markdown',?,?,?,?,?,?)",params![id_for_db,text(&source["contentType"]),text(&source["sourceName"]),text(&source["title"]),text(&source["url"]),text(&source["publishedAt"]),text(&source["fetchedAt"]),text(&sort_db),body.chars().take(600).collect::<String>(),body.chars().take(280).collect::<String>(),meta_for_db,text(&sort_db),text(&source["sourceName"]).to_lowercase(),now])?;
        tx.execute("insert into knowledge_doc_content_refs(doc_id,content_key,content_url,content_type,content_encoding,content_bytes,content_sha256,updated_at) values (?,?,'','text/markdown; charset=utf-8','identity',?,?,?)",params![id_for_db,key_for_db,body.len(),content_hash,now])?;tx.commit()?;Ok(())}).await?;
    // Re-read the committed row; classification of following items sees exactly stored metadata.
    if let Some(mut row) = rows(state).await?.into_iter().find(|r| r["doc_id"] == id) {
        row["body"] = read_body(state, &key).await?.unwrap_or_default().into();
        row["feed"] = meta["feed"].clone();
        for field in ["sourceKey", "sourceItemId", "entityCodes"] {
            row[field] = meta["feed"][field].clone();
        }
        candidates.push(row)
    }
    count(counters, kind);
    Ok(())
}

async fn refresh_gates(state: &AppState) -> Result<()> {
    let entries = stock_entries(state).await?;
    let policy = state.config("config/knowledge/information-feed-policy.json")?;
    for row in rows(state).await? {
        let Some(body) = read_body(state, text(&row["content_key"])).await? else {
            continue;
        };
        if sha(&body) != text(&row["content_sha256"]) {
            continue;
        }
        let mut meta = metadata(&row)?;
        let gate = rules::evaluate_relevance(text(&row["title"]), &body, &entries, &policy)?;
        if meta["feed"]["investmentGate"] == gate {
            continue;
        }
        meta["feed"]["investmentGate"] = gate.clone();
        let changed=state.db.execute("update knowledge_docs set metadata_json=?,updated_at=? where doc_id=? and metadata_json=? and exists(select 1 from knowledge_doc_content_refs c where c.doc_id=knowledge_docs.doc_id and c.content_sha256=?)",vec![meta.to_string().into(),Utc::now().timestamp_millis().into(),row["doc_id"].clone(),row["metadata_json"].clone(),row["content_sha256"].clone()]).await?;
        if changed != 1 {
            bail!("feed relevance input changed concurrently")
        }
        if gate["effectiveDisposition"] == "reject" {
            let mut source = row.clone();
            for field in ["sourceKey", "sourceItemId"] {
                source[field] = meta["feed"][field].clone();
            }
            source["publishedAt"] = row["published_at"].clone();
            audit(state, &source, &gate).await?;
        }
    }
    Ok(())
}

/// Offline legacy information-record migration; errors remain in the detailed report.
pub async fn backfill_records(state: &AppState, options: Value) -> Result<Value> {
    records_backfill::backfill_records(state, &options).await
}
