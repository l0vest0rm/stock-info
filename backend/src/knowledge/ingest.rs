//! Native local knowledge processing. Source files, sync ledger and review
//! artifacts retain the historical on-disk contract; no JavaScript is executed.
pub mod normalize;
pub mod reports_fetch;
pub mod topic;
pub mod writer;

use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use futures_util::{StreamExt, TryStreamExt, stream};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::UNIX_EPOCH,
};

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn boolean(state: &AppState, name: &str) -> Option<bool> {
    match state.setting(name).trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}
fn integer(v: &Value, fallback: i64) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(fallback)
}
fn directory(state: &AppState, config: &Value, field: &str, fallback: &str) -> PathBuf {
    let value = text(&config[field]);
    state
        .root
        .join(if value.is_empty() { fallback } else { value })
}
fn lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}
/// Scheduler entry: explicit automation opt-out is observed before any work.
pub async fn ingest_tick(state: &AppState) -> Result<Value> {
    let config = state.config("config/knowledge/knowledge-processing.json")?;
    if config["automation"]["enabled"] == false {
        return Ok(json!({"status":"disabled","enabled":false}));
    }
    let Ok(_guard) = lock().try_lock() else {
        return Ok(json!({"status":"skipped_overlap"}));
    };
    run(state, config, true).await
}
/// Manual supported `process-knowledge.sh` replacement, regardless of automation.
pub async fn process_once(state: &AppState) -> Result<Value> {
    process_once_with_config(
        state,
        state.config("config/knowledge/knowledge-processing.json")?,
    )
    .await
}
pub async fn process_once_with_config(state: &AppState, config: Value) -> Result<Value> {
    let _guard = lock().lock().await;
    run(state, config, true).await
}
/// Process existing inboxes without requesting new provider reports.
pub async fn process_inboxes(state: &AppState, config: Value) -> Result<Value> {
    let _guard = lock().lock().await;
    run(state, config, false).await
}
fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}))
}
fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("state path has no parent")?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".knowledge-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(value)?))?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
fn jsonl(path: &Path, rows: &[Value]) -> Result<()> {
    let mut file = fs::File::create(path)?;
    for row in rows {
        writeln!(file, "{}", serde_json::to_string(row)?)?;
    }
    file.sync_all()?;
    Ok(())
}
fn load_sync(path: &Path, database: &str) -> BTreeMap<String, Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .filter(|v| {
            v["target"] == "local" && v["database"] == database && !text(&v["docId"]).is_empty()
        })
        .map(|v| (text(&v["docId"]).to_owned(), v))
        .collect()
}
fn append_sync(path: &Path, entries: &[Value]) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    for entry in entries {
        writeln!(file, "{}", serde_json::to_string(entry)?)?;
    }
    file.sync_all()?;
    Ok(())
}
fn input_dirs(state: &AppState, config: &Value) -> Vec<PathBuf> {
    let configured = config["inputDirs"]
        .as_array()
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            vec![
                json!("/Users/terry/git/data/news"),
                json!("/Users/terry/git/data/reports"),
            ]
        });
    let mut paths: Vec<_> = configured
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| state.root.join(s))
        .filter(|p| p.is_dir())
        .collect();
    let inbox = text(&config["inboxDir"]);
    if paths.is_empty() && !inbox.is_empty() {
        let p = state.root.join(inbox);
        if p.is_dir() {
            paths.push(p);
        }
    }
    paths.sort();
    paths.dedup();
    paths
}
fn relative(path: &Path, dirs: &[PathBuf]) -> String {
    dirs.iter()
        .filter_map(|d| {
            path.strip_prefix(d)
                .ok()
                .map(|p| (d.components().count(), p))
        })
        .max_by_key(|(n, _)| *n)
        .map(|(_, p)| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
}
#[derive(Default)]
struct Scan {
    files: Vec<PathBuf>,
    ages: usize,
    unchanged: usize,
}
fn path_date(path: &Path) -> Option<NaiveDate> {
    static DATE: OnceLock<regex::Regex> = OnceLock::new();
    let re = DATE.get_or_init(|| {
        regex::Regex::new(r"(20\d{2})(?:[-_/年.](\d{1,2})[-_/月.](\d{1,2})日?|([01]\d)([0-3]\d))")
            .unwrap()
    });
    re.captures_iter(&path.to_string_lossy())
        .filter_map(|c| {
            let year = c.get(1)?.as_str().parse().ok()?;
            let month = c.get(2).or_else(|| c.get(4))?.as_str().parse().ok()?;
            let day = c.get(3).or_else(|| c.get(5))?.as_str().parse().ok()?;
            NaiveDate::from_ymd_opt(year, month, day)
        })
        .max()
}
struct ScanPolicy {
    watermark: i64,
    news_days: i64,
    report_days: i64,
    today: NaiveDate,
}
fn scan(
    dir: &Path,
    owner: &Path,
    config: &Value,
    policy: &ScanPolicy,
    out: &mut Scan,
) -> Result<()> {
    let ScanPolicy {
        watermark,
        news_days,
        report_days,
        today,
    } = *policy;
    let mut entries = fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let ty = entry.file_type()?;
        // Do not follow symlinks outside the authorized inbox, or recurse cycles.
        if ty.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ty.is_dir() {
            scan(&path, owner, config, policy, out)?;
            continue;
        }
        if !ty.is_file() {
            continue;
        }
        let ext = format!(
            ".{}",
            path.extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase()
        );
        let supported = config["supportedExtensions"]
            .as_array()
            .filter(|v| !v.is_empty())
            .map(|v| v.iter().any(|s| text(s).eq_ignore_ascii_case(&ext)))
            .unwrap_or_else(|| [".json", ".jsonl", ".md", ".txt", ".pdf"].contains(&ext.as_str()));
        if !supported {
            continue;
        }
        let metadata = entry.metadata()?;
        let modified = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        if watermark > 0 && modified <= watermark {
            out.unchanged += 1;
            continue;
        }
        let label = owner
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        let report = if label.contains("report") {
            true
        } else if label.contains("news") {
            false
        } else {
            ext == ".pdf"
        };
        let days = if report { report_days } else { news_days };
        let date = path_date(&path).unwrap_or_else(|| {
            DateTime::<Utc>::from_timestamp_millis(modified)
                .unwrap_or_default()
                .with_timezone(&chrono_tz::Asia::Shanghai)
                .date_naive()
        });
        if days > 0
            && date
                < today
                    .checked_sub_signed(Duration::try_days(days).unwrap_or(Duration::MAX))
                    .unwrap_or(NaiveDate::MIN)
        {
            out.ages += 1;
            continue;
        }
        out.files.push(path);
    }
    Ok(())
}
fn archive(path: &Path, dest: &Path, dirs: &[PathBuf]) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut target = dest.join(relative(path, dirs));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if target.exists() {
        let name = target.file_name().unwrap_or_default().to_string_lossy();
        target.set_file_name(format!("{}-{name}", uuid::Uuid::new_v4()));
    }
    // rename can cross devices when inboxes and project data differ.
    if fs::rename(path, &target).is_err() {
        fs::copy(path, &target)?;
        fs::remove_file(path)?;
    }
    Ok(())
}
fn failed(path: &Path, dest: &Path, dirs: &[PathBuf], error: &str) -> Result<()> {
    let log = PathBuf::from(format!("{}.error.log", path.to_string_lossy()));
    fs::write(&log, format!("{error}\n"))?;
    archive(path, dest, dirs)?;
    archive(&log, dest, dirs)
}
fn review_row(doc: &Value, file: &Path, dirs: &[PathBuf], decision: &Value) -> Value {
    let content = ["markdown", "content", "summary"]
        .into_iter()
        .map(|k| text(&doc[k]))
        .find(|s| !s.trim().is_empty())
        .unwrap_or("");
    let content = review_content(content);
    let preview_content = if content.is_empty() {
        [text(&doc["summary"]), text(&doc["title"])]
            .into_iter()
            .find(|s| !s.trim().is_empty())
            .unwrap_or("")
    } else {
        &content
    };
    let mut row = decision.as_object().cloned().unwrap_or_default();
    for key in [
        "title",
        "sourceType",
        "reportType",
        "sourceName",
        "targetName",
        "targetCode",
        "publishedAt",
        "docId",
        "url",
        "accessMethod",
        "summary",
    ] {
        row.insert(key.into(), doc[key].clone());
    }
    row.insert("file".into(), json!(relative(file, dirs)));
    row.insert("content".into(), json!(truncate(&content, 4000)));
    row.insert(
        "contentPreview".into(),
        json!(truncate(preview_content, 280)),
    );
    Value::Object(row)
}
fn review_content(value: &str) -> String {
    static HTML: OnceLock<regex::Regex> = OnceLock::new();
    if !HTML
        .get_or_init(|| regex::Regex::new(r"(?is)<[a-z].*>").unwrap())
        .is_match(value)
    {
        return value.trim().into();
    }
    let value = regex::Regex::new(r"(?i)<br\s*/?>")
        .unwrap()
        .replace_all(value, "\n");
    let value = regex::Regex::new(r"(?i)</p>")
        .unwrap()
        .replace_all(&value, "\n\n")
        .into_owned();
    regex::Regex::new(r"<[^>]+>")
        .unwrap()
        .replace_all(&value, "")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .into()
}
fn truncate(value: &str, limit: usize) -> String {
    let mut out: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        out.push_str("...");
    }
    out
}

async fn cleanup(state: &AppState, config: &Value) -> Result<Value> {
    let enabled = config["storageRetention"]["enabled"] == true;
    let days = integer(&config["storageRetention"]["knowledgeDocsMaxAgeDays"], 0);
    let purge = config["filteredReviewImport"]["enabled"] == false
        && config["filteredReviewImport"]["purgeExisting"] == true;
    let cutoff = Utc::now()
        .checked_sub_signed(Duration::try_days(days.max(0)).unwrap_or(Duration::MAX))
        .context("knowledge retention age exceeds supported date range")?
        .to_rfc3339();
    let filter_cutoff = cutoff.clone();
    let counts=state.db.run(move |conn| {
        let tx=conn.transaction()?;
        let has_filtered: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_filtered_docs')", [], |r|r.get(0))?;
        let filtered=if purge && has_filtered {tx.execute("DELETE FROM knowledge_filtered_docs",[])?}else{0};
        let removed=if enabled && days>0 {
            tx.execute("DELETE FROM knowledge_doc_tags WHERE doc_id IN (SELECT doc_id FROM knowledge_docs WHERE coalesce(event_time,published_at,fetched_at,'')!='' AND datetime(coalesce(event_time,published_at,fetched_at))<datetime(?))",[&filter_cutoff])?;
            tx.execute("DELETE FROM knowledge_docs WHERE coalesce(event_time,published_at,fetched_at,'')!='' AND datetime(coalesce(event_time,published_at,fetched_at))<datetime(?)",[&filter_cutoff])?
        }else{0};
        tx.commit()?; Ok(json!({"filteredDeleted":filtered,"docsDeleted":removed}))
    }).await?;
    Ok(
        json!({"enabled":enabled,"knowledgeDocsMaxAgeDays":days,"filteredPurged":purge,"cutoffIso":if enabled&&days>0 {json!(cutoff)}else{Value::Null},"counts":counts}),
    )
}
async fn run(state: &AppState, mut config: Value, fetch_reports: bool) -> Result<Value> {
    if config["remote"] == true || boolean(state, "KNOWLEDGE_PROCESS_REMOTE") == Some(true) {
        bail!("remote knowledge processing is retired; use the local database");
    }
    let started = Utc::now();
    let run_id = started.format("%Y%m%d-%H%M%S-%3f").to_string();
    config["runId"] = json!(run_id);
    let fetch = if fetch_reports {
        reports_fetch::fetch(state, &config).await?
    } else {
        json!({"status":"not_requested"})
    };
    let dirs = input_dirs(state, &config);
    if dirs.is_empty() {
        bail!("missing input dirs: expected configured news/reports directories");
    }
    // Normalization and sync entries must agree on absolute inbox ownership.
    config["inputDirs"] = json!(dirs);
    let processed = directory(
        state,
        &config,
        "processedDir",
        "/Users/terry/git/data/stock-info/knowledge/processed",
    );
    let failed_dir = directory(
        state,
        &config,
        "failedDir",
        "/Users/terry/git/data/stock-info/knowledge/failed",
    );
    let work = directory(
        state,
        &config,
        "workDir",
        "/Users/terry/git/data/stock-info/knowledge/work",
    );
    let reviews = directory(
        state,
        &config,
        "reviewDir",
        "/Users/terry/git/data/stock-info/knowledge/reviews",
    );
    let state_dir = directory(
        state,
        &config,
        "stateDir",
        "/Users/terry/git/data/stock-info/knowledge/state",
    );
    let latest = state.root.join("data/knowledge-review");
    for dir in [
        &processed,
        &failed_dir,
        &work,
        &reviews,
        &state_dir,
        &latest,
        &work.join("remote-pdf"),
        &work.join("markdown-cache"),
        &reviews.join("llm-topic-review"),
    ] {
        fs::create_dir_all(dir)?;
    }
    config["workDir"] = json!(work); // conversion cache uses identical resolved path.
    let filename = |field: &str, default: &str| {
        let s = text(&config[field]);
        state_dir.join(if s.is_empty() { default } else { s })
    };
    let state_file = filename("scanStateFile", "local-scan-state.json");
    let sync_file = filename("importSyncFile", "knowledge-remote-sync.jsonl");
    let old_state = read_json(&state_file);
    let full = config["fullRescan"] == true
        || boolean(state, "KNOWLEDGE_PROCESS_FULL_RESCAN") == Some(true);
    let watermark = if full {
        0
    } else {
        old_state["lastCompletedScanStartedAtMs"]
            .as_i64()
            .filter(|n| *n > 0)
            .or_else(|| {
                DateTime::parse_from_rfc3339(text(&old_state["completedAt"]))
                    .ok()
                    .map(|t| t.timestamp_millis())
            })
            .unwrap_or(0)
    };
    let database = text(&config["database"]).to_string();
    let database = if database.is_empty() {
        "stock_info".into()
    } else {
        database
    };
    let mut sync = if full {
        BTreeMap::new()
    } else {
        load_sync(&sync_file, &database)
    };
    let disable_age = config["disableAgeLimit"] == true
        || boolean(state, "KNOWLEDGE_PROCESS_DISABLE_AGE_LIMIT") == Some(true);
    let age = |env: &str, key: &str, default: i64| {
        if disable_age {
            0
        } else {
            state
                .setting(env)
                .parse::<i64>()
                .unwrap_or_else(|_| integer(&config[key], default))
                .max(0)
        }
    };
    let news_days = age("KNOWLEDGE_PROCESS_MAX_NEWS_DAYS", "maxNewsAgeDays", 14);
    let report_days = age("KNOWLEDGE_PROCESS_MAX_REPORT_DAYS", "maxReportAgeDays", 60);
    let archive_processed = config["archiveProcessed"] == true
        || boolean(state, "KNOWLEDGE_PROCESS_ARCHIVE_PROCESSED") == Some(true);
    let mut scanned = Scan::default();
    for dir in &dirs {
        scan(
            dir,
            dir,
            &config,
            &ScanPolicy {
                watermark,
                news_days,
                report_days,
                today: started
                    .with_timezone(&chrono_tz::Asia::Shanghai)
                    .date_naive(),
            },
            &mut scanned,
        )?;
    }
    scanned.files.sort();
    scanned.files.dedup();
    let mut batches: Vec<(PathBuf, Vec<Value>)> = Vec::new();
    let mut results = Vec::new();
    let mut delegated = 0;
    let mut synced_count = 0;
    for path in &scanned.files {
        match normalize::process_file(state, path, &config, started.timestamp_millis()).await {
            Ok(all) => {
                let fingerprint = normalize::source_fingerprint_for(path, &config)?;
                let original_len = all.len();
                let docs: Vec<_> = all
                    .into_iter()
                    .filter(|d| {
                        !matches!(
                            text(&d["metadata"]["source"]),
                            "tencent_stock_news" | "cls_telegraph"
                        )
                    })
                    .collect();
                let delegated_file = original_len - docs.len();
                delegated += delegated_file;
                let eligible = docs.len();
                let docs: Vec<_> = docs
                    .into_iter()
                    .filter(|d| {
                        !sync.get(text(&d["docId"])).is_some_and(|e| {
                            e["hasD1"] == true
                                && ["sourceFile", "sourceMtimeMs", "sourceSize"]
                                    .iter()
                                    .all(|k| e[k] == fingerprint[k])
                        })
                    })
                    .collect();
                let skipped = eligible - docs.len();
                synced_count += skipped;
                if docs.is_empty() {
                    if eligible > 0 && archive_processed {
                        archive(path, &processed, &dirs)?;
                    }
                    results.push(json!({"file":path.file_name().unwrap_or_default().to_string_lossy(),"status":if delegated_file>0{"delegated_feed"}else{"skipped_synced"},"docs":0,"skippedExisting":skipped}));
                } else {
                    batches.push((path.clone(), docs));
                }
            }
            Err(error) => {
                let message = error.to_string();
                failed(path, &failed_dir, &dirs, &message)?;
                results.push(json!({"file":path.file_name().unwrap_or_default().to_string_lossy(),"status":"failed","error":message}));
            }
        }
    }
    let inputs: Vec<_> = batches.iter().flat_map(|(_, docs)| docs.clone()).collect();
    let (decisions, audits) = topic::evaluate(state, &inputs, &config).await?;
    anyhow::ensure!(
        decisions.len() == inputs.len(),
        "topic filter omitted input decisions"
    );
    let mut index = 0;
    let mut docs = Vec::new();
    let mut filtered = Vec::new();
    let mut rows = Vec::new();
    let mut to_archive = Vec::new();
    let enrich =
        boolean(state, "KNOWLEDGE_PROCESS_LLM").unwrap_or(config["llm"]["enabled"] == true);
    let concurrency = state
        .setting("KNOWLEDGE_PROCESS_DOC_CONCURRENCY")
        .parse::<usize>()
        .unwrap_or_else(|_| integer(&config["docProcessingConcurrency"], 4).max(1) as usize)
        .clamp(1, 64);
    for (path, raw_docs) in &batches {
        let mut kept_inputs = Vec::new();
        let start_filtered = filtered.len();
        for raw in raw_docs {
            let decision = &decisions[index];
            index += 1;
            rows.push(review_row(raw, path, &dirs, decision));
            let mut raw = raw.clone();
            if !raw["metadata"].is_object() {
                raw["metadata"] = json!({});
            }
            raw["metadata"]["topicFilter"] = decision.clone();
            if decision["keep"] != true {
                filtered.push(json!({"doc":raw,"filter":decision,"file":relative(path,&dirs)}));
            } else {
                kept_inputs.push(raw);
            }
        }
        let cfg = &config;
        let processed_docs:Result<Vec<Value>> = stream::iter(kept_inputs).map(|raw|async move {
            let doc=normalize::materialize(state,path,raw,cfg).await?;
            if enrich {bail!("direct CLI knowledge LLM enrichment has been retired; import documents first and use the local knowledge processing job");}
            Ok(normalize::finalize(doc,cfg))
        }).buffered(concurrency).try_collect().await;
        match processed_docs {
            Err(error) => {
                let message = error.to_string();
                failed(path, &failed_dir, &dirs, &message)?;
                results.push(json!({"file":path.file_name().unwrap_or_default().to_string_lossy(),"status":"failed","error":message}));
            }
            Ok(kept) => {
                results.push(json!({"file":path.file_name().unwrap_or_default().to_string_lossy(),"status":"processed","docs":kept.len(),"skipped":filtered.len()-start_filtered}));
                docs.extend(kept);
                to_archive.push(path.clone());
            }
        }
    }
    let review_json = reviews.join(format!("topic-filter-{run_id}.jsonl"));
    let review_md = reviews.join(format!("topic-filter-{run_id}.md"));
    jsonl(&review_json, &rows)?;
    let mut markdown = format!(
        "# Topic Filter Review {run_id}\n\nKept: {}\nFiltered: {}\n",
        docs.len(),
        filtered.len()
    );
    for row in &rows {
        markdown.push_str(&format!(
            "\n- [{}] {} | {}/{} | score={} | {}",
            if row["keep"] == true {
                "kept"
            } else {
                "filtered"
            },
            text(&row["title"]),
            text(&row["sourceType"]),
            text(&row["reportType"]),
            row["score"],
            row["reasons"]
        ));
    }
    fs::write(&review_md, markdown)?;
    fs::copy(&review_json, latest.join("topic-filter-latest.jsonl"))?;
    fs::copy(&review_md, latest.join("topic-filter-latest.md"))?;
    let audit_file = reviews
        .join("llm-topic-review")
        .join(format!("topic-filter-llm-{run_id}.jsonl"));
    jsonl(&audit_file, &audits)?;
    let filter_enabled = boolean(state, "KNOWLEDGE_FILTERED_IMPORT_ENABLED")
        .unwrap_or(config["filteredReviewImport"]["enabled"] == true);
    config["syncEntries"] = json!(sync.values().collect::<Vec<_>>());
    let filtered_result = if filter_enabled && !filtered.is_empty() {
        jsonl(
            &work.join(format!("knowledge-filtered-{run_id}.jsonl")),
            &filtered,
        )?;
        let result = writer::import_filtered(state, &filtered, &config).await?;
        atomic_json(
            &work.join(format!("knowledge-filtered-result-{run_id}.json")),
            &result["entries"],
        )?;
        result
    } else {
        json!({"imported":0,"entries":[]})
    };
    let mut seen = HashSet::new();
    docs.retain(|doc| seen.insert(text(&doc["docId"]).to_string()));
    let result = if docs.is_empty() {
        json!({"imported":0,"entries":[]})
    } else {
        jsonl(
            &work.join(format!("knowledge-import-{run_id}.jsonl")),
            &docs,
        )?;
        let result = writer::import_documents(state, &docs, &config).await?;
        atomic_json(
            &work.join(format!("knowledge-import-result-{run_id}.json")),
            &result["entries"],
        )?;
        result
    };
    for report in [&filtered_result, &result] {
        let entries = report["entries"].as_array().cloned().unwrap_or_default();
        append_sync(&sync_file, &entries)?;
        for entry in entries {
            sync.insert(text(&entry["docId"]).to_string(), entry);
        }
    }
    let storage_cleanup = cleanup(state, &config).await?;
    let storage_report=state.db.query("SELECT (SELECT count(*) FROM knowledge_docs) AS docs, (SELECT count(*) FROM knowledge_doc_content_refs) AS contentRefs",vec![]).await?;
    if archive_processed {
        for path in to_archive {
            archive(&path, &processed, &dirs)?;
        }
    }
    let mut new_state = old_state.as_object().cloned().unwrap_or_default();
    if let Some(last) = scanned.files.last() {
        new_state.insert("lastFile".into(), json!(last));
        new_state.insert("lastRelativeFile".into(), json!(relative(last, &dirs)));
    }
    new_state.insert(
        "lastCompletedScanStartedAtMs".into(),
        json!(started.timestamp_millis()),
    );
    new_state.insert(
        "lastCompletedScanStartedAt".into(),
        json!(started.to_rfc3339()),
    );
    new_state.insert("completedAt".into(), json!(Utc::now().to_rfc3339()));
    atomic_json(&state_file, &Value::Object(new_state))?;
    let preview_limit = integer(&config["filterReviewPreviewLimit"], 50).max(0) as usize;
    let preview: Vec<_> = rows
        .iter()
        .filter(|r| r["keep"] != true)
        .take(preview_limit)
        .map(|r| r["title"].clone())
        .collect();
    Ok(
        json!({"status":"completed","inputDirs":dirs,"database":database,"remote":false,"reportsFetch":fetch,"totalPending":scanned.files.len(),"selectedFiles":scanned.files.len(),"normalizedFiles":scanned.files.len(),"skippedByAge":scanned.ages,"skippedUnchangedFiles":scanned.unchanged,"skippedUnchangedDirs":0,"skippedImportedDocs":synced_count,"delegatedFeedDocs":delegated,"skippedByTopic":filtered.len(),"imported":result["imported"],"filteredImported":filtered_result["imported"],"filteredImportEnabled":filter_enabled,"storageCleanup":storage_cleanup,"storageReport":storage_report,"maxNewsAgeDays":news_days,"maxReportAgeDays":report_days,"changedSince":if watermark>0 {DateTime::<Utc>::from_timestamp_millis(watermark).map(|t|t.to_rfc3339()).unwrap_or_default()}else{String::new()},"changedSinceSource":if full {"fullRescan"}else if watermark>0 {"lastCompletedScanStartedAtMs"}else{"none"},"nextScanWatermark":started.to_rfc3339(),"elapsedSeconds":(Utc::now()-started).num_seconds(),"topicReview":{"jsonlFile":review_json,"mdFile":review_md,"kept":rows.len()-filtered.len(),"filteredOut":filtered.len(),"filteredOutPreview":preview},"llmTopicReview":{"jsonlFile":audit_file,"rows":audits.len()},"filteredOutPreview":preview,"results":results}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates_use_latest_valid_component() {
        assert_eq!(
            path_date(Path::new("/reports/2025-01-01/20260203_report.md")),
            NaiveDate::from_ymd_opt(2026, 2, 3)
        );
        assert_eq!(path_date(Path::new("/2026-02-31/report.md")), None);
    }
    #[test]
    fn scan_descends_unchanged_directories_and_excludes_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("a/b");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("fresh.md"), "body").unwrap();
        fs::write(dir.join(".hidden.md"), "hidden").unwrap();
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("outside.md"), "not authorized").unwrap();
            std::os::unix::fs::symlink(outside.path().join("outside.md"), dir.join("link.md"))
                .unwrap();
            std::os::unix::fs::symlink(temp.path(), dir.join("loop")).unwrap();
            // Keep the external target alive until after traversal below.
            let mut symlink_scan = Scan::default();
            scan(
                temp.path(),
                temp.path(),
                &json!({}),
                &ScanPolicy {
                    watermark: 1,
                    news_days: 0,
                    report_days: 0,
                    today: Utc::now().date_naive(),
                },
                &mut symlink_scan,
            )
            .unwrap();
            assert_eq!(symlink_scan.files.len(), 1);
        }
        let mut result = Scan::default();
        scan(
            temp.path(),
            temp.path(),
            &json!({}),
            &ScanPolicy {
                watermark: 1,
                news_days: 0,
                report_days: 0,
                today: Utc::now().date_naive(),
            },
            &mut result,
        )
        .unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(
            relative(&result.files[0], &[temp.path().into()]),
            "a/b/fresh.md"
        );
    }
}
