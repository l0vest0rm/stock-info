//! Native local report preparation. Python is retained only for the existing
//! PDF cleaning/OCR extraction boundary; no JavaScript runtime is invoked.
pub mod domain;
use crate::{AppState, featured_reports, llm::direct};
use anyhow::{Context, Result, bail};
use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn write(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("missing artifact parent")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temp, value)?;
    temp.write_all(b"\n")?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
fn option<'a>(options: &'a Value, key: &str) -> &'a str {
    options[key].as_str().unwrap_or("")
}
fn absolute(root: &Path, input: &str) -> PathBuf {
    let p = Path::new(input);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}
fn registry_root(state: &AppState) -> PathBuf {
    let configured = state.setting("FEATURED_PROJECT_ROOT");
    if configured.is_empty() {
        state.root.join("data/local/featured-reports")
    } else {
        PathBuf::from(configured).join("data/local/featured-reports")
    }
}
struct PreparationLock(PathBuf);
impl Drop for PreparationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn lock(dir: &Path) -> Result<PreparationLock> {
    let path = dir.join(".prepare.lock");
    if path.exists() {
        let owner = fs::read_to_string(&path)?
            .trim()
            .parse::<u32>()
            .context("Invalid preparation lock")?;
        if owner == 0 {
            bail!("Invalid preparation lock");
        }
        // kill -0 is a read-only process existence probe on both macOS/Linux.
        let output = std::process::Command::new("kill")
            .args(["-0", &owner.to_string()])
            .output()?;
        if output.status.success()
            || !String::from_utf8_lossy(&output.stderr)
                .to_lowercase()
                .contains("no such process")
        {
            bail!("Preparation is already running (PID {owner})");
        }
        fs::remove_file(&path)?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    write!(file, "{}", std::process::id())?;
    file.sync_all()?;
    Ok(PreparationLock(path))
}
async fn python(script: &Path, args: &[&Path]) -> Result<Vec<u8>> {
    let mut command = tokio::process::Command::new(
        std::env::var("PYTHON_BIN").unwrap_or_else(|_| "python3".into()),
    );
    command.arg(script).args(args).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(600), command.output())
        .await
        .context("PDF processing timed out")??;
    if !output.status.success() {
        bail!(
            "PDF processing failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2000)
                .collect::<String>()
        );
    }
    if output.stdout.len() > 64 * 1024 * 1024 {
        bail!("PDF extraction exceeds 64 MiB");
    }
    Ok(output.stdout)
}
/// Resolve a separately installed, reviewed PDF-cleaning skill. Explicit
/// configuration is authoritative: never silently substitute a missing override.
fn resolve_cleaner(root: &Path, configured: &str, home: Option<&Path>) -> Result<PathBuf> {
    let candidates = if configured.is_empty() {
        let mut candidates = Vec::new();
        if let Some(parent) = root.parent() {
            candidates.push(parent.join("skills/attachments-to-markdown/scripts/clean-pdf.py"));
        }
        if let Some(home) = home {
            for path in [
                ".codex/skills/attachments-to-markdown/scripts/clean-pdf.py",
                ".agents/skills/attachments-to-markdown/scripts/clean-pdf.py",
                "git/skills/attachments-to-markdown/scripts/clean-pdf.py",
            ] {
                candidates.push(home.join(path));
            }
        }
        candidates
    } else {
        vec![absolute(root, configured)]
    };
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.canonicalize()?);
        }
    }
    bail!(
        "Required reviewed PDF cleaner is unavailable; set FEATURED_PDF_CLEANER to clean-pdf.py. Checked: {}. Raw PDF cleaning is not skipped.",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
}
async fn clean(state: &AppState, dir: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let output = dir.join("original.pdf");
    let audit = dir.join("original.pdf.json");
    if output.exists() {
        let record =
            read(&audit).context("已有目录未经 PDF 清理，请使用新的 --out 目录重新生成")?;
        if record["source_sha256"] != hash(bytes) {
            bail!("Output directory belongs to a different PDF");
        }
        if record["output_sha256"] != hash(&fs::read(&output)?) {
            bail!("Cleaned PDF checksum mismatch");
        }
        return Ok(output);
    }
    let staging = tempfile::Builder::new().prefix(".clean-").tempdir_in(dir)?;
    let input = staging.path().join("input.pdf");
    let cleaned = staging.path().join("cleaned.pdf");
    fs::write(&input, bytes)?;
    let configured = state.setting("FEATURED_PDF_CLEANER");
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let cleaner = resolve_cleaner(&state.root, &configured, home.as_deref())?;
    let cleaner_hash = hash(&fs::read(&cleaner)?);
    python(&cleaner, &[&input, Path::new("--output"), &cleaned]).await?;
    if hash(&fs::read(&cleaner)?) != cleaner_hash {
        bail!("PDF cleaner changed during processing; output was not published");
    }
    let mut record = read(&cleaned.with_extension("pdf.json"))?;
    if record["source_sha256"] != hash(bytes) {
        bail!("PDF cleaner source checksum mismatch");
    }
    record["output_sha256"] = json!(hash(&fs::read(&cleaned)?));
    record["processor"] =
        json!({"kind":"local-pdf-cleaner","script":cleaner,"sha256":cleaner_hash});
    record
        .as_object_mut()
        .context("invalid PDF audit")?
        .remove("source");
    write(&audit, &record)?;
    fs::rename(cleaned, &output)?;
    Ok(output)
}
fn ensure_cache_replay_allowed(directory: &Path, allow: bool) -> Result<()> {
    if !allow {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let candidate = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name
                .strip_suffix(".json")
                .is_some_and(|stem| stem.len() == 64 && stem.bytes().all(|c| c.is_ascii_hexdigit()))
                && !candidate.with_extension("accepted").exists()
            {
                bail!(
                    "Unrecognized completed translation cache checkpoint; automatic model replay refused. Review and preserve existing cache before explicitly setting FEATURED_ALLOW_CACHE_REEXECUTION=1 or choosing a new --out directory."
                );
            }
        }
    }
    Ok(())
}

async fn llm(
    state: &AppState,
    dir: &Path,
    kind: &str,
    input: Value,
    blocks: Option<&[Value]>,
) -> Result<Value> {
    let prompt = fs::read_to_string(
        state
            .root
            .join(format!("prompts/featured-report-{kind}.md")),
    )?;
    let legacy_key = domain::cache_key(kind, &prompt, &input)?;
    let routing = crate::llm::config(state)?;
    let basis = format!(
        "{legacy_key}:{}:{}:{:?}",
        routing.model, routing.base_url, routing.protocol
    );
    let key = format!("{:x}", sha2::Sha256::digest(basis.as_bytes()));
    // Completed old-model checkpoints are not rewritten or automatically replayed.
    let legacy_path = dir.join("cache").join(format!("{legacy_key}.json"));
    let path = dir.join("cache").join(format!("{key}.json"));
    let validate = |value: &Value| -> Result<()> {
        match kind {
            "whole" => {
                domain::validate_translation(
                    value,
                    blocks.context("missing translation batch")?,
                    false,
                )?;
                domain::validate_summary(value)
            }
            "translate" => domain::validate_translation(
                value,
                blocks.context("missing translation batch")?,
                true,
            ),
            "summary" => domain::validate_summary(value),
            "glossary" => {
                if value["terms"].is_array() {
                    Ok(())
                } else {
                    bail!("Invalid glossary")
                }
            }
            _ => bail!("unknown translation step"),
        }
    };
    let completed_path = if path.exists() { &path } else { &legacy_path };
    if completed_path.exists() {
        let value = read(completed_path)?;
        validate(&value)?;
        // A sidecar records that this exact checkpoint was recognized, without
        // rewriting the original completed model output.
        fs::write(
            completed_path.with_extension("accepted"),
            b"legacy-key-compatible\n",
        )?;
        return Ok(value);
    }
    ensure_cache_replay_allowed(
        &dir.join("cache"),
        state.setting("FEATURED_ALLOW_CACHE_REEXECUTION") == "1",
    )?;
    // Never automatically replay an ambiguous model execution or malformed
    // result. Valid completed steps persist and a later human retry reuses them.
    let options = json!({"model":crate::llm::config(state)?.model,"instructions":prompt,"input":[{"role":"user","content":[{"type":"input_text","text":serde_json::to_string(&input)?}]}],"maxTokens":if matches!(kind,"whole"|"translate") {16000} else {10000},"timeoutMs":240000});
    let text = tokio::time::timeout(
        Duration::from_secs(240),
        direct::direct_text(state, &options),
    )
    .await
    .context(
        "report translation timed out; execution status unknown, do not automatically retry",
    )??;
    let mut text = text.trim();
    if let Some(rest) = text.strip_prefix("```") {
        text = rest.strip_prefix("json").unwrap_or(rest).trim_start();
        text = text
            .strip_suffix("```")
            .context("unterminated JSON response")?
            .trim_end();
    }
    let value: Value = serde_json::from_str(text)?;
    validate(&value)?;
    write(&path, &value)?;
    fs::write(path.with_extension("accepted"), b"native-key-compatible\n")?;
    Ok(value)
}
fn skip_issue(block: &Value) -> String {
    let pages = block["sourceLocations"]
        .as_array()
        .map(|locations| {
            locations
                .iter()
                .map(|l| l["page"].to_string())
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    format!(
        "{}（原文第 {} 页）：已跳过{}，请核对",
        block["id"].as_str().unwrap_or(""),
        pages,
        block["reason"].as_str().unwrap_or("")
    )
}
pub async fn prepare(state: &AppState, options: &Value) -> Result<Value> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("Use the supported local launcher (LLM_RUNTIME=local)");
    }
    let input = option(options, "input");
    if input.is_empty() {
        bail!("PDF input required");
    }
    let bytes = if input.starts_with("http://") || input.starts_with("https://") {
        state
            .http
            .bytes_limited(input, HeaderMap::new(), 120000, 200 * 1024 * 1024)
            .await?
            .0
    } else {
        let input_path = absolute(&state.root, input);
        if fs::metadata(&input_path)?.len() > 200 * 1024 * 1024 {
            bail!("PDF exceeds 200 MiB");
        }
        fs::read(input_path)?
    };
    if bytes.len() > 200 * 1024 * 1024 {
        bail!("PDF exceeds 200 MiB");
    }
    if !bytes
        .iter()
        .take(1024)
        .copied()
        .collect::<Vec<_>>()
        .windows(5)
        .any(|w| w == b"%PDF-")
    {
        bail!("Not a PDF file");
    }
    let dir = if option(options, "out").is_empty() {
        state.root.join("data/featured-reports").join(hash(&bytes))
    } else {
        absolute(&state.root, option(options, "out"))
    };
    fs::create_dir_all(&dir)?;
    let dir = dir.canonicalize()?;
    let _lock = lock(&dir)?;
    let original = clean(state, &dir, &bytes).await?;
    let report_id = hash(&fs::read(&original)?);
    let source_path = dir.join("source.json");
    if !source_path.exists() {
        let source: Value = serde_json::from_slice(
            &python(
                &state.root.join("scripts/extract-featured-report.py"),
                &[&original],
            )
            .await?,
        )?;
        write(&source_path, &source)?;
    }
    let source = read(&source_path)?;
    if !dir.join("manifest.json").exists() {
        write(
            &dir.join("manifest.json"),
            &json!({"reportId":report_id,"source":input,"model":crate::llm::config(state)?.model,"pageCount":source["pageCount"]}),
        )?;
    }
    if options["extractOnly"] == true {
        return Ok(json!({"directory":dir,"source":source_path,"extracted":true}));
    }
    let content_path = dir.join("content.json");
    if !content_path.exists() || options["refilter"] == true {
        fs::create_dir_all(dir.join("cache"))?;
        let (selected, skipped) = domain::select(&source)?;
        if domain::sections(&selected)?.is_empty() {
            bail!("排除固定声明后没有可翻译的研究正文");
        }
        let mut issues = source["issues"].as_array().cloned().unwrap_or_default();
        let content = if content_path.exists() {
            let previous = read(&content_path)?;
            domain::check_coverage(&previous, &source)?;
            let excluded = skipped.iter().map(|b| b["id"].clone()).collect::<Vec<_>>();
            let translated = domain::sections(&previous)?
                .iter()
                .filter_map(|s| {
                    let mut s = s.clone();
                    let blocks = s["blocks"]
                        .as_array()?
                        .iter()
                        .filter(|b| !excluded.contains(&b["id"]))
                        .cloned()
                        .collect::<Vec<_>>();
                    if blocks.is_empty() {
                        None
                    } else {
                        s["blocks"] = json!(blocks);
                        Some(s)
                    }
                })
                .collect::<Vec<_>>();
            let input=json!(domain::sections(&selected)?.iter().map(|s|json!({"title":s["title"],"digest":s["blocks"].as_array().unwrap().iter().map(|b|b["original"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n\n")})).collect::<Vec<_>>());
            let summary = llm(state, &dir, "summary", input, None).await?;
            let backup = dir.join(format!(
                "before-refilter-{}",
                &hash(&fs::read(&content_path)?)[..12]
            ));
            fs::create_dir_all(&backup)?;
            for name in ["content.json", "checks.json"] {
                if dir.join(name).exists() && !backup.join(name).exists() {
                    fs::copy(dir.join(name), backup.join(name))?;
                }
            }
            if dir.join("checks.json").exists() {
                issues = read(&dir.join("checks.json"))?["issues"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                issues.retain(|issue| {
                    !skipped.iter().any(|b| {
                        let id = b["id"].as_str().unwrap_or("");
                        let issue = issue.as_str().unwrap_or("");
                        issue.starts_with(&format!("{id}："))
                            || issue.starts_with(&format!("{id}（"))
                    })
                });
            }
            let mut content = previous;
            content["sections"] = json!(domain::placeholders(&source, &translated)?);
            content["summary"] = summary["summary"].clone();
            content
        } else {
            translate(
                state,
                &dir,
                options,
                &source,
                &selected,
                &report_id,
                &mut issues,
            )
            .await?
        };
        issues.extend(skipped.iter().map(|b| json!(skip_issue(b))));
        featured_reports::validate_content(&content)?;
        domain::check_coverage(&content, &source)?;
        write(&content_path, &content)?;
        write(
            &dir.join("checks.json"),
            &json!({"issues":issues,"skippedBlocks":skipped}),
        )?;
    }
    let registered = featured_reports::register_local_report(&dir, &registry_root(state))?;
    Ok(
        json!({"directory":dir,"code":registered["code"],"url":format!("http://{}/featured-report.html?code={}",state.authority,registered["code"].as_str().unwrap_or(""))}),
    )
}
async fn translate(
    state: &AppState,
    dir: &Path,
    options: &Value,
    source: &Value,
    selected: &Value,
    report_id: &str,
    issues: &mut Vec<Value>,
) -> Result<Value> {
    let groups = domain::batches(selected)?;
    if groups.is_empty() {
        bail!("no translation blocks");
    }
    let mut results = Vec::new();
    let summary;
    if groups.len() == 1 {
        let result = llm(
            state,
            dir,
            "whole",
            json!({"blocks":domain::model_blocks(&groups[0])}),
            Some(&groups[0]),
        )
        .await?;
        summary = result.clone();
        results.push(result);
    } else {
        let input=json!(domain::sections(selected)?.iter().map(|s|json!({"title":s["title"],"sample":s["blocks"][0]["original"].as_str().unwrap_or("").chars().take(500).collect::<String>()})).collect::<Vec<_>>());
        let glossary = llm(state, dir, "glossary", input, None).await?;
        for (i, blocks) in groups.iter().enumerate() {
            let previous = i
                .checked_sub(1)
                .and_then(|j| groups[j].last())
                .map(|b| b["original"].clone())
                .unwrap_or(json!(""));
            let next = groups
                .get(i + 1)
                .and_then(|g| g.first())
                .map(|b| b["original"].clone())
                .unwrap_or(json!(""));
            results.push(llm(state,dir,"translate",json!({"glossary":glossary,"context":{"previous":previous,"next":next},"blocks":domain::model_blocks(blocks)}),Some(blocks)).await?);
        }
        summary = llm(
            state,
            dir,
            "summary",
            json!(
                results
                    .iter()
                    .map(|r| json!({"digest":r["digest"]}))
                    .collect::<Vec<_>>()
            ),
            None,
        )
        .await?;
    }
    let mut translated = domain::sections(selected)?
        .iter()
        .map(|s| json!({"id":s["id"],"title":s["title"],"blocks":[]}))
        .collect::<Vec<_>>();
    let numbers = regex::Regex::new(r"\d+(?:[,.]\d+)*(?:%|％)?").unwrap();
    for (blocks, result) in groups.iter().zip(results) {
        for (original, item) in blocks.iter().zip(
            result["items"]
                .as_array()
                .context("translation items missing")?,
        ) {
            let translation = item["translation"]
                .as_str()
                .context("translation missing")?;
            let mut missing = Vec::new();
            for number in numbers.find_iter(original["original"].as_str().unwrap_or("")) {
                if !translation
                    .replace(',', "")
                    .contains(&number.as_str().replace(',', ""))
                    && !missing.contains(&number.as_str())
                {
                    missing.push(number.as_str());
                }
            }
            if !missing.is_empty() {
                issues.push(json!(format!(
                    "{}：请核对数字 {}",
                    item["id"].as_str().unwrap_or(""),
                    missing.join("、")
                )));
            }
            if translation.contains("[原文不清]") {
                issues.push(json!(format!(
                    "{}：原文不清，需要人工核对",
                    item["id"].as_str().unwrap_or("")
                )));
            }
            let section = translated
                .iter_mut()
                .find(|s| s["id"] == original["sectionId"])
                .context("source section missing")?;
            section["blocks"].as_array_mut().unwrap().push(json!({"id":item["id"],"translation":translation,"sourceLocations":original["sourceLocations"]}));
        }
    }
    let title = if option(options, "title").is_empty() {
        source["title"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                Path::new(option(options, "input"))
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
    } else {
        option(options, "title").into()
    };
    Ok(
        json!({"schemaVersion":1,"reportId":report_id,"title":title,"institution":option(options,"institution"),"reportDate":option(options,"date"),"pageCount":source["pageCount"],"summary":summary["summary"],"sections":domain::placeholders(source,&translated)?}),
    )
}

/// Publish to existing local SQLite + object storage. Never uploads remotely.
pub async fn publish(state: &AppState, options: &Value) -> Result<Value> {
    let directory = option(options, "directory");
    if directory.is_empty() {
        bail!("report directory required");
    }
    let base = format!("http://{}", state.authority);
    let requested = option(options, "baseUrl").trim_end_matches('/');
    if !requested.is_empty() && requested != base {
        bail!("only publication to this local runtime is supported");
    }
    let dir = absolute(&state.root, directory).canonicalize()?;
    let bytes = fs::read(dir.join("content.json"))?;
    if bytes.len() > featured_reports::MAX_CONTENT_BYTES {
        bail!("Content JSON exceeds 12 MiB");
    }
    let content: Value = serde_json::from_slice(&bytes)?;
    featured_reports::validate_content(&content)?;
    domain::check_coverage(&content, &read(&dir.join("source.json"))?)?;
    let pdf = fs::read(dir.join("original.pdf"))?;
    let report_id = content["reportId"].as_str().context("missing report id")?;
    if hash(&pdf) != report_id {
        bail!("PDF checksum mismatch");
    }
    let receipt_path = dir.join("published.json");
    let previous = if receipt_path.exists() {
        read(&receipt_path)?
    } else {
        Value::Null
    };
    if !previous.is_null() && previous["base"] != base {
        bail!("Publication receipt belongs to another environment");
    }
    let content_hash = hash(&bytes);
    let prefix = format!("featured-reports/{report_id}");
    let pdf_key = format!("{prefix}/original.pdf");
    let content_key = format!("{prefix}/{content_hash}/content.json");
    let store = state.knowledge_store()?;
    store.put(&pdf_key, pdf).await?;
    store.put(&content_key, bytes).await?;
    let result=featured_reports::publish_local_artifacts(state,&json!({"reportId":report_id,"contentHash":content_hash,"expectedHash":previous.get("contentHash").cloned().unwrap_or(Value::Null)})).await.map_err(|e|anyhow::anyhow!("local publication failed: {}",e.1))?;
    let data = result.0["data"].clone();
    let receipt = json!({"base":base,"code":data["code"],"contentHash":content_hash});
    write(&receipt_path, &receipt)?;
    let rows=state.db.query("SELECT code,content_hash,content_key,pdf_key,status FROM featured_reports WHERE report_id=?",vec![json!(report_id)]).await?;
    let row = rows.first().context("published index missing")?;
    if row["code"] != data["code"]
        || row["content_hash"] != content_hash
        || row["content_key"] != content_key
        || row["pdf_key"] != pdf_key
        || row["status"] != "published"
    {
        bail!("Published index verification failed");
    }
    if store
        .get(&content_key)
        .await?
        .is_none_or(|b| hash(&b) != content_hash)
        || store
            .get(&pdf_key)
            .await?
            .is_none_or(|b| hash(&b) != report_id)
    {
        bail!("Published local objects failed checksum verification");
    }
    Ok(
        json!({"code":data["code"],"contentHash":content_hash,"url":format!("{base}/featured-report.html?code={}",data["code"].as_str().unwrap_or("")),"directory":dir}),
    )
}

pub async fn review(mut state: AppState, directory: &Path, port: u16) -> Result<()> {
    if port == 0 {
        bail!("review port must be nonzero");
    }
    // Bind before mutating preview registry and never stop any current service.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let dir = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        state.root.join(directory)
    };
    let registered = featured_reports::register_local_report(&dir, &registry_root(&state))?;
    state.authority = format!("127.0.0.1:{port}");
    println!(
        "{}",
        json!({"url":format!("http://{}/featured-report.html?code={}",state.authority,registered["code"].as_str().unwrap_or(""))})
    );
    let assets = state.root.join("web/dist");
    // Serve only read-only report routes/assets, never the rest of the private API.
    let authority = state.authority.clone();
    let app = axum::Router::new()
        .nest("/api", featured_reports::routes())
        .merge(featured_reports::page_routes())
        .fallback_service(tower_http::services::ServeDir::new(assets))
        .layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let authority = authority.clone();
                async move {
                    use axum::response::IntoResponse;
                    if request.headers().get("host").and_then(|v| v.to_str().ok())
                        != Some(authority.as_str())
                    {
                        return axum::http::StatusCode::FORBIDDEN.into_response();
                    }
                    if request.method() != axum::http::Method::GET
                        && request.method() != axum::http::Method::HEAD
                    {
                        return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response();
                    }
                    let mut response = next.run(request).await;
                    response.headers_mut().insert(
                        axum::http::header::CACHE_CONTROL,
                        axum::http::HeaderValue::from_static("no-store"),
                    );
                    response
                }
            },
        ))
        .with_state(state);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("install review SIGTERM handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(root: &Path) -> AppState {
        fs::create_dir_all(root.join("config/app")).unwrap();
        fs::write(
            root.join("config/app/llm.json"),
            include_str!("../../config/app/llm.json"),
        )
        .unwrap();
        AppState::new(
            crate::db::Database::open(root.join("test.sqlite")).unwrap(),
            root.into(),
            "127.0.0.1:18000".into(),
        )
        .unwrap()
    }
    fn cached(root: &Path, kind: &str, input: &Value, value: &Value) {
        let prompt = "fixture instructions";
        fs::create_dir_all(root.join("prompts")).unwrap();
        fs::write(
            root.join(format!("prompts/featured-report-{kind}.md")),
            prompt,
        )
        .unwrap();
        fs::create_dir_all(root.join("cache")).unwrap();
        let key = domain::cache_key(kind, prompt, input).unwrap();
        write(&root.join("cache").join(format!("{key}.json")), value).unwrap();
    }
    #[tokio::test]
    async fn completed_cache_reuses_valid_translation_and_rejects_corrupt_coverage_without_provider()
     {
        let root = tempfile::tempdir().unwrap();
        let state = state(root.path());
        let blocks = vec![json!({"id":"b1","original":"Research","sectionTitle":"Title"})];
        let input = json!({"blocks":domain::model_blocks(&blocks)});
        let valid = json!({"items":[{"id":"b1","translation":"研究"}],"summary":"摘要"});
        cached(root.path(), "whole", &input, &valid);
        assert_eq!(
            llm(&state, root.path(), "whole", input.clone(), Some(&blocks))
                .await
                .unwrap(),
            valid
        );
        cached(
            root.path(),
            "whole",
            &input,
            &json!({"items":[],"summary":"摘要"}),
        );
        assert!(
            llm(&state, root.path(), "whole", input, Some(&blocks))
                .await
                .unwrap_err()
                .to_string()
                .contains("coverage")
        );
    }
    #[test]
    fn cleaner_resolution_prefers_explicit_and_supports_adjacent_skill_checkout() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("stock-info");
        fs::create_dir(&project).unwrap();
        let sibling = root
            .path()
            .join("skills/attachments-to-markdown/scripts/clean-pdf.py");
        fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        fs::write(&sibling, b"# reviewed fixture").unwrap();
        assert_eq!(
            resolve_cleaner(&project, "", None).unwrap(),
            sibling.canonicalize().unwrap()
        );
        let configured = project.join("custom.py");
        fs::write(&configured, b"# explicit fixture").unwrap();
        assert_eq!(
            resolve_cleaner(&project, "custom.py", None).unwrap(),
            configured.canonicalize().unwrap()
        );
        assert!(resolve_cleaner(&project, "missing-explicit.py", None).is_err());
        fs::remove_file(&sibling).unwrap();
        assert!(resolve_cleaner(&project, "", None).is_err());
    }
    #[test]
    fn unknown_completed_checkpoint_blocks_replay_without_explicit_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let checkpoint = root.path().join(format!("{}.json", "a".repeat(64)));
        fs::write(&checkpoint, b"{\"items\":[]}").unwrap();
        assert!(ensure_cache_replay_allowed(root.path(), false).is_err());
        assert!(ensure_cache_replay_allowed(root.path(), true).is_ok());
        fs::write(checkpoint.with_extension("accepted"), b"recognized").unwrap();
        assert!(ensure_cache_replay_allowed(root.path(), false).is_ok());
    }
    #[test]
    fn preparation_lock_rejects_active_owner_and_drop_cleans_own_lock() {
        let root = tempfile::tempdir().unwrap();
        let owner = lock(root.path()).unwrap();
        assert!(lock(root.path()).is_err());
        assert!(root.path().join(".prepare.lock").is_file());
        drop(owner);
        assert!(!root.path().join(".prepare.lock").exists());
    }
    #[tokio::test]
    async fn cleaned_pdf_reuse_is_checksum_guarded_before_extraction() {
        let root = tempfile::tempdir().unwrap();
        let state = state(root.path());
        let bytes = b"%PDF-1.7\nfixture";
        fs::write(root.path().join("original.pdf"), bytes).unwrap();
        assert!(clean(&state, root.path(), bytes).await.is_err());
        write(
            &root.path().join("original.pdf.json"),
            &json!({"source_sha256":hash(bytes),"output_sha256":hash(bytes)}),
        )
        .unwrap();
        assert!(clean(&state, root.path(), bytes).await.is_ok());
        assert!(clean(&state, root.path(), b"%PDF-different").await.is_err());
        fs::write(root.path().join("original.pdf"), b"tampered").unwrap();
        assert!(clean(&state, root.path(), bytes).await.is_err());
    }
}
