use crate::{ApiError, AppState};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path as FsPath, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

const REQUIRED_HOSTS: [&str; 3] = ["pdf.dfcfw.com", "static.cninfo.com.cn", "www1.hkexnews.hk"];
const MAX_PDF_BYTES: usize = 128 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/__health", get(health))
        .route("/__convert-report", post(convert_report_route))
        .route("/__convert-sec-filing", post(convert_sec))
        .route("/knowledge-content/{*key}", get(object).head(object))
        .route(
            "/featured-reports/{*key}",
            get(featured_object).head(featured_object),
        )
}

struct Queue {
    slots: Arc<Semaphore>,
    pending: AtomicUsize,
    concurrency: usize,
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}
static QUEUES: OnceLock<Mutex<HashMap<PathBuf, Arc<Queue>>>> = OnceLock::new();
fn work_dir(state: &AppState) -> PathBuf {
    let configured = state.setting("KNOWLEDGE_REPORT_CONVERSION_WORK_DIR");
    if configured.is_empty() {
        if let Ok(config) = state.config("config/knowledge/knowledge-processing.json")
            && let Some(directory) = config["workDir"].as_str().filter(|s| !s.trim().is_empty())
        {
            return state.root.join(directory);
        }
        state.data_dir().join("knowledge-work")
    } else {
        state.root.join(configured)
    }
}
fn positive(state: &AppState, key: &str, default: usize) -> usize {
    state
        .setting(key)
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
        .unwrap_or(default)
}
fn queue(state: &AppState) -> Arc<Queue> {
    let root = work_dir(state);
    let mut map = QUEUES.get_or_init(Default::default).lock().unwrap();
    map.entry(root)
        .or_insert_with(|| {
            let n = positive(state, "KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY", 2);
            Arc::new(Queue {
                slots: Arc::new(Semaphore::new(n)),
                pending: AtomicUsize::new(0),
                concurrency: n,
                locks: Default::default(),
            })
        })
        .clone()
}
async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let queue = queue(&state);
    axum::Json(
        json!({"ok":true,"reportConversion":{"active":queue.concurrency-queue.slots.available_permits(),"pending":queue.pending.load(Ordering::Relaxed),"concurrency":queue.concurrency}}),
    )
}

fn configured_hosts(state: &AppState) -> Result<HashSet<String>> {
    let configured = state.setting("KNOWLEDGE_REPORT_CONVERTER_HOSTS");
    let hosts: HashSet<String> = if configured.is_empty() {
        REQUIRED_HOSTS.iter().map(|s| s.to_string()).collect()
    } else {
        configured
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    };
    if REQUIRED_HOSTS.iter().any(|host| !hosts.contains(*host)) {
        bail!("KNOWLEDGE_REPORT_CONVERTER_HOSTS must include required official hosts");
    }
    Ok(hosts)
}
fn doc_id(value: &Value) -> Result<&str> {
    let id = value.as_str().unwrap_or("").trim();
    if !Regex::new(r"^[A-Za-z0-9_-]{8,120}$").unwrap().is_match(id) {
        bail!("invalid report doc id");
    }
    Ok(id)
}
fn allowed_url(url: &reqwest::Url, hosts: &HashSet<String>, sec: bool) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if sec {
        host.eq_ignore_ascii_case("www.sec.gov")
            && Regex::new(r"(?i)^/Archives/edgar/data/\d+/.+\.html?$")
                .unwrap()
                .is_match(url.path())
    } else {
        hosts.contains(&host.to_ascii_lowercase())
            && url.path().to_ascii_lowercase().ends_with(".pdf")
    }
}

async fn convert_report_route(State(state): State<AppState>, request: Request) -> Response {
    convert_request(state, request, false).await
}

pub async fn convert_report(state: &AppState, doc_id: &str, url: &str) -> Result<String> {
    convert_cached(state, doc_id, url, false).await
}

/// An absent or corrupt local object never falls back to a remote content URL.
pub async fn read_content_text(state: &AppState, key: &str) -> Result<Option<String>> {
    use std::io::Read;
    if key.starts_with("localfs:") {
        bail!("localfs knowledge content is retired; re-import the document");
    }
    let key = key.strip_prefix("knowledge-content/").unwrap_or(key);
    let Some(bytes) = state.knowledge_store()?.get(key).await? else {
        return Ok(None);
    };
    const MAX_TEXT_BYTES: u64 = 32 * 1024 * 1024;
    let mut decoded = Vec::new();
    if bytes.starts_with(&[0x1f, 0x8b]) || key.ends_with(".gz") {
        flate2::read::GzDecoder::new(bytes.as_slice())
            .take(MAX_TEXT_BYTES + 1)
            .read_to_end(&mut decoded)
            .context("invalid gzip knowledge content")?;
    } else if key.ends_with(".br") {
        brotli::Decompressor::new(bytes.as_slice(), 4096)
            .take(MAX_TEXT_BYTES + 1)
            .read_to_end(&mut decoded)
            .context("invalid Brotli knowledge content")?;
    } else {
        decoded = bytes;
    }
    if decoded.len() as u64 > MAX_TEXT_BYTES {
        bail!("decoded knowledge content exceeds 32 MiB");
    }
    Ok(Some(
        String::from_utf8(decoded).context("knowledge content is not UTF-8")?,
    ))
}
async fn convert_sec(State(state): State<AppState>, request: Request) -> Response {
    convert_request(state, request, true).await
}
async fn convert_request(state: AppState, request: Request, sec: bool) -> Response {
    let bytes = match to_bytes(request.into_body(), 32 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return ApiError(StatusCode::BAD_REQUEST, "request body is too large".into())
                .into_response();
        }
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => {
            return ApiError(StatusCode::BAD_REQUEST, "invalid JSON request body".into())
                .into_response();
        }
    };
    let id = match doc_id(&body["docId"]) {
        Ok(id) => id,
        Err(error) => return ApiError(StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    match convert_cached(&state, id, body["url"].as_str().unwrap_or(""), sec).await {
        Ok(markdown) => (
            [
                (header::CONTENT_TYPE, "text/markdown; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            markdown,
        )
            .into_response(),
        Err(error) => ApiError(StatusCode::BAD_GATEWAY, error.to_string()).into_response(),
    }
}

struct Pending<'a>(&'a AtomicUsize);
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}
/// Uses Rust for request policy, caching, concurrency and lifecycle. Python is
/// only the existing dedicated PDF renderer adapter, never a business backend.
pub async fn convert_cached(state: &AppState, id: &str, url: &str, sec: bool) -> Result<String> {
    doc_id(&json!(id))?;
    let hosts = configured_hosts(state)?;
    let url = reqwest::Url::parse(url)?;
    if !allowed_url(&url, &hosts, sec) {
        bail!(
            "{} URL is not allowed by the converter",
            if sec { "SEC filing" } else { "report" }
        );
    }
    let root = work_dir(state);
    let markdown_dir = root.join("markdown-cache");
    let pdf_dir = root.join("remote-pdf");
    fs::create_dir_all(&markdown_dir)?;
    fs::create_dir_all(&pdf_dir)?;
    let key = if sec {
        format!("sec-{id}")
    } else {
        id.to_string()
    };
    let output = markdown_dir.join(format!("{key}.md"));
    if let Ok(text) = fs::read_to_string(&output)
        && !text.trim().is_empty()
    {
        return Ok(text);
    }
    let queue = queue(state);
    let lock = {
        let mut locks = queue.locks.lock().unwrap();
        if locks.len() > 4096 {
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    let _single = lock.lock_owned().await;
    if let Ok(text) = fs::read_to_string(&output)
        && !text.trim().is_empty()
    {
        return Ok(text);
    }
    queue.pending.fetch_add(1, Ordering::Relaxed);
    let pending = Pending(&queue.pending);
    let _permit = queue.slots.clone().acquire_owned().await?;
    drop(pending);
    let timeout =
        Duration::from_millis(
            positive(state, "KNOWLEDGE_REPORT_CONVERSION_TIMEOUT_MS", 120000) as u64,
        );
    let redirects = hosts.clone();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many report redirects")
            } else if allowed_url(attempt.url(), &redirects, sec) {
                attempt.follow()
            } else {
                attempt.error("report redirect is outside official allowlist")
            }
        }))
        .build()?;
    if sec {
        let response = client
            .get(url)
            .header("accept", "text/html,application/xhtml+xml")
            .header(
                "user-agent",
                "stock-info research contact research@localhost",
            )
            .send()
            .await?
            .error_for_status()?;
        let html = response.text().await?;
        let markdown = sec_html_to_markdown(&html);
        if markdown.trim().is_empty() {
            bail!("SEC filing conversion returned empty content");
        }
        atomic_write(&output, markdown.as_bytes())?;
        return Ok(markdown);
    }
    let pdf = pdf_dir.join(format!("{id}.pdf"));
    let valid = fs::read(&pdf)
        .ok()
        .is_some_and(|bytes| bytes.len() >= 1000 && bytes.starts_with(b"%PDF-"));
    if !valid {
        let mut response = client
            .get(url)
            .header("referer", "https://data.eastmoney.com/report/")
            .header("user-agent", "Mozilla/5.0 stock-info-local")
            .header("accept", "application/pdf,*/*")
            .send()
            .await?
            .error_for_status()?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_PDF_BYTES as u64)
        {
            bail!("report PDF exceeds 128 MiB");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > MAX_PDF_BYTES {
                bail!("report PDF exceeds 128 MiB");
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() < 1000 || !bytes.starts_with(b"%PDF-") {
            bail!("remote report returned invalid or too small PDF");
        }
        atomic_write(&pdf, &bytes)?;
    }
    let python = state.setting("PYTHON_BIN");
    let python = if python.is_empty() {
        "python3".to_string()
    } else {
        python
    };
    let output_clone = output.clone();
    tokio::task::spawn_blocking(move || {
        // Retain both guards until the renderer exits even if its HTTP waiter
        // disconnects. A cancelled request must not release a live process's
        // concurrency slot or let another renderer overwrite the same cache.
        let _permit = _permit;
        let _single = _single;
        convert_pdf(&python, &pdf, &output_clone, timeout)
    })
    .await??;
    let markdown = fs::read_to_string(output)?;
    if markdown.trim().is_empty() {
        bail!("pdf to markdown produced empty content");
    }
    Ok(markdown)
}

fn atomic_write(path: &FsPath, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn convert_pdf(python: &str, pdf: &FsPath, output: &FsPath, timeout: Duration) -> Result<()> {
    let temp = output.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let errors = output.with_extension(format!("err-{}", uuid::Uuid::new_v4()));
    let stderr = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&errors)?;
    let script = "import pathlib,sys\npdf=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2])\ntry:\n import pymupdf4llm\n text=pymupdf4llm.to_markdown(str(pdf))\nexcept Exception:\n import fitz\n with fitz.open(str(pdf)) as doc: text='\\n\\n'.join(page.get_text('text') for page in doc)\nout.write_text(text,encoding='utf-8')\n";
    let result = (|| -> Result<()> {
        let mut child = Command::new(python)
            .args(["-c", script])
            .arg(pdf)
            .arg(&temp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .context("cannot launch PDF renderer; install Python pymupdf4llm or pymupdf")?;
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    let detail = fs::read_to_string(&errors).unwrap_or_default();
                    bail!(
                        "PDF renderer failed: {}",
                        detail.chars().take(2000).collect::<String>()
                    );
                }
                break;
            }
            if start.elapsed() >= timeout {
                let _ = child.kill();
                let _ = child.wait();
                bail!("PDF conversion timed out");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if fs::metadata(&temp)?.len() == 0 {
            bail!("PDF renderer produced empty content");
        }
        fs::rename(&temp, output)?;
        Ok(())
    })();
    let _ = fs::remove_file(errors);
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn sec_html_to_markdown(html: &str) -> String {
    let mut text = Regex::new(r"(?s)<!--[\s\S]*?-->")
        .unwrap()
        .replace_all(html, " ")
        .into_owned();
    for tag in ["script", "style", "noscript", "svg", "head"] {
        text = Regex::new(&format!(r"(?is)<{tag}[^>]*>[\s\S]*?</{tag}>"))
            .unwrap()
            .replace_all(&text, " ")
            .into_owned();
    }
    for (pattern, replacement) in [
        (r"(?i)<br\s*/?>", "\n"),
        (r"(?i)</(?:p|div|section|article|tr|li|h[1-6]|table)>", "\n"),
        (r"(?i)<t[dh][^>]*>", " | "),
        (r"<[^>]+>", " "),
    ] {
        text = Regex::new(pattern)
            .unwrap()
            .replace_all(&text, replacement)
            .into_owned();
    }
    for (from, to) in [
        ("&nbsp;", " "),
        ("&#160;", " "),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
    ] {
        text = text.replace(from, to);
    }
    text = Regex::new(r"&#(?:x([0-9a-fA-F]+)|(\d+));")
        .unwrap()
        .replace_all(&text, |caps: &regex::Captures<'_>| {
            let code = if let Some(hex) = caps.get(1) {
                u32::from_str_radix(hex.as_str(), 16).ok()
            } else {
                caps[2].parse().ok()
            };
            code.and_then(char::from_u32)
                .map(|ch| ch.to_string())
                .unwrap_or_default()
        })
        .into_owned();
    for (pattern, replacement) in [
        (r"[ \t]+\n", "\n"),
        (r"\n{3,}", "\n\n"),
        (r"[ \t]{2,}", " "),
    ] {
        text = Regex::new(pattern)
            .unwrap()
            .replace_all(&text, replacement)
            .into_owned();
    }
    text.trim().chars().take(2 * 1024 * 1024).collect()
}
async fn object(
    State(state): State<AppState>,
    Path(key): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    serve_object(&state, &key, &method, &headers).await
}
async fn featured_object(
    State(state): State<AppState>,
    Path(key): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    serve_object(
        &state,
        &format!("featured-reports/{key}"),
        &method,
        &headers,
    )
    .await
}
async fn serve_object(
    state: &AppState,
    key: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Response {
    let bytes = match state.knowledge_store() {
        Ok(store) => match store.get(key).await {
            Ok(Some(bytes)) => bytes,
            _ => return StatusCode::NOT_FOUND.into_response(),
        },
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let size = bytes.len();
    let mut status = StatusCode::OK;
    let mut start = 0;
    let mut end = size;
    let mut output = HeaderMap::new();
    output.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(if key.ends_with(".pdf") {
            "application/pdf"
        } else if key.ends_with(".json") {
            "application/json; charset=utf-8"
        } else {
            "text/markdown; charset=utf-8"
        }),
    );
    output.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    output.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    output.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("Accept-Ranges, Content-Length, Content-Range"),
    );
    if key.ends_with(".md.br") {
        output.insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
    } else if key.ends_with(".md.gz") {
        output.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    if key.ends_with(".pdf")
        && let Some(caps) = headers
            .get(header::RANGE)
            .and_then(|h| h.to_str().ok())
            .and_then(|range| Regex::new(r"^bytes=(\d+)-(\d*)$").unwrap().captures(range))
    {
        let range_start = caps[1].parse::<usize>().unwrap_or(usize::MAX);
        let range_end = if caps[2].is_empty() {
            size.saturating_sub(1)
        } else {
            caps[2]
                .parse::<usize>()
                .unwrap_or(usize::MAX)
                .min(size.saturating_sub(1))
        };
        if range_start > range_end || range_start >= size {
            output.insert(
                header::CONTENT_RANGE,
                format!("bytes */{size}").parse().unwrap(),
            );
            output.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
            return (StatusCode::RANGE_NOT_SATISFIABLE, output, Body::empty()).into_response();
        }
        start = range_start;
        end = range_end + 1;
        status = StatusCode::PARTIAL_CONTENT;
        output.insert(
            header::CONTENT_RANGE,
            format!("bytes {range_start}-{range_end}/{size}")
                .parse()
                .unwrap(),
        );
    }
    output.insert(
        header::CONTENT_LENGTH,
        (end - start).to_string().parse().unwrap(),
    );
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes[start..end].to_vec())
    };
    (status, output, body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_converter_policy_blocks_credentials_ports_and_foreign_hosts() {
        let hosts = REQUIRED_HOSTS.iter().map(|h| h.to_string()).collect();
        for url in [
            "http://pdf.dfcfw.com/a.pdf",
            "https://user:secret@pdf.dfcfw.com/a.pdf",
            "https://pdf.dfcfw.com:444/a.pdf",
            "https://evil.example/a.pdf",
            "https://pdf.dfcfw.com/a.txt",
        ] {
            assert!(!allowed_url(
                &reqwest::Url::parse(url).unwrap(),
                &hosts,
                false
            ));
        }
        assert!(allowed_url(
            &reqwest::Url::parse("https://pdf.dfcfw.com/a.pdf").unwrap(),
            &hosts,
            false
        ));
        assert!(allowed_url(
            &reqwest::Url::parse("https://www.sec.gov/Archives/edgar/data/123/abc/report.htm")
                .unwrap(),
            &hosts,
            true
        ));
        assert!(!allowed_url(
            &reqwest::Url::parse("https://www.sec.gov/other.htm").unwrap(),
            &hosts,
            true
        ));
    }
    #[test]
    fn sec_conversion_keeps_table_values_and_removes_active_content() {
        let text = sec_html_to_markdown(
            "<head>secret</head><h1>Report</h1><script>bad()</script><table><tr><td>Revenue</td><td>&#x31;00 &amp; more</td></tr></table>",
        );
        assert!(text.contains("Revenue"));
        assert!(text.contains("100 & more"));
        assert!(!text.contains("bad()"));
        assert!(!text.contains("secret"));
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_renderer_is_reaped_and_temporary_files_removed() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let renderer = directory.path().join("renderer");
        // No descendant subprocess: killing this fixture reaps all its work.
        fs::write(&renderer, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
        fs::set_permissions(&renderer, fs::Permissions::from_mode(0o700)).unwrap();
        let output = directory.path().join("report.md");
        let started = Instant::now();
        let error = convert_pdf(
            renderer.to_str().unwrap(),
            &directory.path().join("input.pdf"),
            &output,
            Duration::from_millis(75),
        )
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(!output.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
