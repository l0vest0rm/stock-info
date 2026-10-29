//! Local featured report metadata, publication and reviewed-artifact access.
//! The report ledger remains the existing `featured_reports` table; content
//! objects and preview registries are local files, never remote R2 fallbacks.
use crate::{ApiError, ApiResult, AppState, db::Database, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use regex::Regex;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const MAX_CONTENT_BYTES: usize = 12 * 1024 * 1024;

fn hex_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn report_code(value: &str) -> bool {
    value.len() == 6
        && value.as_bytes()[0].is_ascii_digit()
        && value.as_bytes()[0] != b'0'
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max)
}

/// Validate the existing schema exactly, including global section/block IDs and
/// normalized PDF coordinates. Validation does not invent missing translations.
pub fn validate_content(value: &Value) -> Result<()> {
    let valid_date = value["reportDate"].as_str().is_some_and(|date| {
        date.is_empty()
            || Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
                .unwrap()
                .is_match(date)
    });
    let page_count = value["pageCount"]
        .as_f64()
        .filter(|count| count.is_finite() && count.fract() == 0.0 && *count >= 1.0);
    if value["schemaVersion"].as_f64() != Some(1.0)
        || !value["reportId"].as_str().is_some_and(hex_id)
        || !text(&value["title"], 500)
        || !value["institution"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 500)
        || !valid_date
        || page_count.is_none()
        || !text(&value["summary"], 100_000)
        || !value["sections"].as_array().is_some_and(|s| !s.is_empty())
    {
        bail!("Invalid report content");
    }
    let page_count = page_count.unwrap();
    let mut ids = HashSet::new();
    for section in value["sections"].as_array().unwrap() {
        if !text(&section["id"], 100)
            || !ids.insert(section["id"].as_str().unwrap().to_owned())
            || !text(&section["title"], 500)
            || !section["blocks"].as_array().is_some_and(|v| !v.is_empty())
        {
            bail!("Invalid section");
        }
        for block in section["blocks"].as_array().unwrap() {
            if !text(&block["id"], 100)
                || !ids.insert(block["id"].as_str().unwrap().to_owned())
                || !text(&block["translation"], 100_000)
                || !block["sourceLocations"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty())
            {
                bail!("Missing or duplicate translation block");
            }
            for location in block["sourceLocations"].as_array().unwrap() {
                let page = location["page"].as_f64();
                let bbox = location["bbox"].as_array();
                if !page.is_some_and(|page| {
                    page.is_finite() && page.fract() == 0.0 && page >= 1.0 && page <= page_count
                }) || !bbox.is_some_and(|coordinates| {
                    coordinates.len() == 4
                        && coordinates.iter().all(|coordinate| {
                            coordinate
                                .as_f64()
                                .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                        })
                }) {
                    bail!("Invalid PDF source location");
                }
                let coordinates = bbox.unwrap();
                if coordinates[0].as_f64().unwrap() >= coordinates[2].as_f64().unwrap()
                    || coordinates[1].as_f64().unwrap() >= coordinates[3].as_f64().unwrap()
                {
                    bail!("Invalid PDF source location");
                }
            }
        }
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn random_code() -> String {
    // The first four UUID v4 bytes remain 32 uniformly random bits. Rejection
    // sampling preserves the original unbiased six-digit allocation contract.
    loop {
        let random = uuid::Uuid::new_v4();
        let value = u32::from_be_bytes(random.as_bytes()[..4].try_into().unwrap());
        if value < (u32::MAX as u64 + 1).div_euclid(900_000) as u32 * 900_000 {
            return (100_000 + value % 900_000).to_string();
        }
    }
}

fn read_content(directory: &Path) -> Result<(Value, Vec<u8>)> {
    let path = directory.join("content.json");
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("review content must be a regular local file");
    }
    let bytes = fs::read(path)?;
    let content: Value = serde_json::from_slice(&bytes)?;
    validate_content(&content)?;
    Ok((content, bytes))
}

/// Native equivalent of the former Node preview registration helper. The
/// calling CLI owns selection of this directory; HTTP accepts only registry
/// codes and can never submit arbitrary filesystem paths.
pub fn register_local_report(directory: &Path, registry: &Path) -> Result<Value> {
    let directory = directory.canonicalize()?;
    read_content(&directory)?;
    fs::create_dir_all(registry)?;
    for file in fs::read_dir(registry)? {
        let file = file?;
        let name = file.file_name().to_string_lossy().into_owned();
        let Some(code) = name.strip_suffix(".json").filter(|code| report_code(code)) else {
            continue;
        };
        let record: Value = serde_json::from_slice(&fs::read(file.path())?)?;
        if record["dir"]
            .as_str()
            .is_some_and(|path| Path::new(path) == directory)
        {
            return Ok(json!({"code":code,"dir":directory}));
        }
    }
    for _ in 0..100 {
        let code = random_code();
        let path = registry.join(format!("{code}.json"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => {
                file.write_all(&serde_json::to_vec(&json!({"dir":directory}))?)?;
                file.sync_all()?;
                return Ok(json!({"code":code,"dir":directory}));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    bail!("本地研报码分配失败")
}

fn registry_root(state: &AppState) -> PathBuf {
    let configured = state.setting("FEATURED_PROJECT_ROOT");
    if configured.is_empty() {
        state.root.join("data/local/featured-reports")
    } else {
        PathBuf::from(configured).join("data/local/featured-reports")
    }
}

fn registry_directory(registry: &Path, code: &str) -> Result<Option<PathBuf>> {
    if !report_code(code) {
        bail!("invalid featured report code");
    }
    let path = registry.join(format!("{code}.json"));
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let record: Value = serde_json::from_slice(&bytes)?;
    let directory = PathBuf::from(record["dir"].as_str().context("invalid preview registry")?);
    if !directory.is_absolute() {
        bail!("preview registry directory must be absolute");
    }
    Ok(Some(directory.canonicalize()?))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/featured-reports/{code}", get(metadata))
        .route("/internal/featured-reports", axum::routing::post(publish))
}

/// Merge outside `/api`; these same-origin URLs replace remote object domains.
pub fn page_routes() -> Router<AppState> {
    Router::new()
        .route("/__review/{code}/original.pdf", get(preview_pdf))
        .route("/__review/{code}/content.json", get(preview_content))
        .route("/__review/{code}/save", any(read_only))
        .route("/__featured/{report_id}/original.pdf", get(published_pdf))
        .route(
            "/__featured/{report_id}/{content_hash}/content.json",
            get(published_content),
        )
}

async fn read_only(method: Method) -> ApiError {
    if method == Method::GET || method == Method::HEAD {
        ApiError(StatusCode::NOT_FOUND, "review artifact not found".into())
    } else {
        ApiError(
            StatusCode::METHOD_NOT_ALLOWED,
            "review artifacts are read-only".into(),
        )
    }
}

async fn metadata(State(state): State<AppState>, AxumPath(code): AxumPath<String>) -> ApiResult {
    if !report_code(&code) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "请输入 6 位研报码".into(),
        ));
    }
    let registry = registry_root(&state);
    let preview_code = code.clone();
    let preview = tokio::task::spawn_blocking(move || -> Result<Option<Value>> {
        let Some(directory) = registry_directory(&registry, &preview_code)? else { return Ok(None) };
        let (content, bytes) = read_content(&directory)?;
        Ok(Some(json!({"code":preview_code,"title":content["title"],"institution":content["institution"],"reportDate":content["reportDate"],
            "pdfUrl":format!("/__review/{preview_code}/original.pdf"),"contentUrl":format!("/__review/{preview_code}/content.json"),"contentHash":digest(&bytes)})))
    }).await.map_err(anyhow::Error::from)??;
    if let Some(metadata) = preview {
        return Ok(ok(metadata));
    }
    let rows = state
        .db
        .query(
            "SELECT * FROM featured_reports WHERE code=? AND status='published'",
            vec![code.clone().into()],
        )
        .await?;
    let Some(row) = rows.first() else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "研报码不存在或报告已下架".into(),
        ));
    };
    let report_id = row["report_id"]
        .as_str()
        .context("missing report identity")?;
    let content_hash = row["content_hash"]
        .as_str()
        .context("missing report content hash")?;
    if !hex_id(report_id) || !hex_id(content_hash) {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid report object identity".into(),
        ));
    }
    Ok(ok(
        json!({"code":code,"title":row["title"],"institution":row["institution"],"reportDate":row["report_date"],
        "pdfUrl":format!("/__featured/{report_id}/original.pdf"),"contentUrl":format!("/__featured/{report_id}/{content_hash}/content.json"),"contentHash":content_hash}),
    ))
}

async fn preview_pdf(
    State(state): State<AppState>,
    AxumPath(code): AxumPath<String>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    preview_file(
        &state,
        &code,
        "original.pdf",
        "application/pdf",
        method,
        &headers,
    )
    .await
}
async fn preview_content(
    State(state): State<AppState>,
    AxumPath(code): AxumPath<String>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    preview_file(
        &state,
        &code,
        "content.json",
        "application/json",
        method,
        &headers,
    )
    .await
}

async fn preview_file(
    state: &AppState,
    code: &str,
    name: &str,
    mime: &str,
    method: Method,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    if !report_code(code) {
        return Err(ApiError(StatusCode::NOT_FOUND, "preview not found".into()));
    }
    let registry = registry_root(state);
    let code = code.to_string();
    let name = name.to_string();
    let bytes = tokio::task::spawn_blocking(move || -> Result<Option<Vec<u8>>> {
        let Some(directory) = registry_directory(&registry, &code)? else {
            return Ok(None);
        };
        let (_, content) = read_content(&directory)?;
        if name == "content.json" {
            return Ok(Some(content));
        }
        let path = directory.join(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            bail!("preview artifact must be a regular local file");
        }
        Ok(Some(fs::read(path)?))
    })
    .await
    .map_err(anyhow::Error::from)??;
    let Some(bytes) = bytes else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "preview artifact not found".into(),
        ));
    };
    Ok(file_response(bytes, mime, &method, headers))
}

async fn published_pdf(
    State(state): State<AppState>,
    AxumPath(report_id): AxumPath<String>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    published_file(&state, &report_id, None, method, &headers).await
}
async fn published_content(
    State(state): State<AppState>,
    AxumPath((report_id, content_hash)): AxumPath<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    published_file(&state, &report_id, Some(&content_hash), method, &headers).await
}
async fn published_file(
    state: &AppState,
    report_id: &str,
    hash: Option<&str>,
    method: Method,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    if !hex_id(report_id) || hash.is_some_and(|hash| !hex_id(hash)) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "report artifact not found".into(),
        ));
    }
    let rows=state.db.query("SELECT pdf_key,content_key,content_hash FROM featured_reports WHERE report_id=? AND status='published'",vec![report_id.into()]).await?;
    let Some(row) = rows.first() else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "report artifact not found".into(),
        ));
    };
    if hash.is_some_and(|hash| row["content_hash"].as_str() != Some(hash)) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "report content version not published".into(),
        ));
    }
    let (key, mime) = if hash.is_some() {
        ("content_key", "application/json")
    } else {
        ("pdf_key", "application/pdf")
    };
    let key = row[key].as_str().context("missing report object key")?;
    let bytes = state.knowledge_store()?.get(key).await?;
    let Some(bytes) = bytes else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "report artifact not found".into(),
        ));
    };
    Ok(file_response(bytes, mime, &method, headers))
}

fn file_response(bytes: Vec<u8>, mime: &str, method: &Method, headers: &HeaderMap) -> Response {
    let mut start = 0usize;
    let mut end = bytes.len();
    let mut partial = false;
    if let Some(range) = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| {
            Regex::new(r"^bytes=([0-9]+)-([0-9]*)$")
                .unwrap()
                .captures(value)
        })
    {
        let requested = range[1].parse::<usize>().unwrap_or(usize::MAX);
        let last = if range[2].is_empty() {
            bytes.len().checked_sub(1)
        } else {
            Some(
                range[2]
                    .parse::<usize>()
                    .unwrap_or(usize::MAX)
                    .min(bytes.len().saturating_sub(1)),
            )
        };
        if requested >= bytes.len() || last.is_none_or(|last| requested > last) {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{}", bytes.len())).unwrap(),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return response;
        }
        start = requested;
        end = last.unwrap() + 1;
        partial = true;
    }
    let total = bytes.len();
    let payload = if method == Method::HEAD {
        Vec::new()
    } else {
        bytes[start..end].to_vec()
    };
    let mut response = Response::new(Body::from(payload));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let output = response.headers_mut();
    output.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap());
    output.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    output.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    output.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&(end - start).to_string()).unwrap(),
    );
    if partial {
        output.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{}/{total}", end - 1)).unwrap(),
        );
    }
    response
}

fn token_matches(expected: &str, supplied: &str) -> bool {
    if expected.is_empty() || supplied.is_empty() || expected.len() != supplied.len() {
        return false;
    }
    expected
        .bytes()
        .zip(supplied.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

async fn publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Regex::new(r"(?i)^Bearer\s+(.+)$").unwrap().captures(v))
        .map(|captures| captures[1].to_owned())
        .unwrap_or_default();
    if !token_matches(&state.setting("REPORT_SYNC_TOKEN"), &bearer) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "unauthorized".into()));
    }
    let body = body
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid publication".into()))?
        .0;
    publish_local_artifacts(&state, &body).await
}

/// Publish already-reviewed local artifacts using the same checksum and CAS
/// gates as HTTP. Native local CLI callers need not make an HTTP self-request.
pub async fn publish_local_artifacts(state: &AppState, body: &Value) -> ApiResult {
    let report_id = body["reportId"].as_str().filter(|s| hex_id(s));
    let content_hash = body["contentHash"].as_str().filter(|s| hex_id(s));
    let expected = body.get("expectedHash");
    if report_id.is_none()
        || content_hash.is_none()
        || !expected.is_some_and(|value| value.is_null() || value.as_str().is_some_and(hex_id))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid publication".into(),
        ));
    }
    let report_id = report_id.unwrap();
    let content_hash = content_hash.unwrap();
    let expected = body["expectedHash"].as_str().map(str::to_owned);
    let pdf_key = format!("featured-reports/{report_id}/original.pdf");
    let content_key = format!("featured-reports/{report_id}/{content_hash}/content.json");
    let store = state.knowledge_store()?;
    let (pdf, bytes) = tokio::try_join!(store.get(&pdf_key), store.get(&content_key))?;
    let Some(bytes) = bytes.filter(|bytes| bytes.len() <= MAX_CONTENT_BYTES) else {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "publication objects missing or oversized".into(),
        ));
    };
    if pdf.is_none() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "publication objects missing or oversized".into(),
        ));
    }
    if digest(&bytes) != content_hash {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "content checksum mismatch".into(),
        ));
    }
    let content: Value = serde_json::from_slice(&bytes)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?;
    validate_content(&content)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?;
    if content["reportId"].as_str() != Some(report_id) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "report identity mismatch".into(),
        ));
    }
    publish_validated(
        &state.db,
        report_id,
        content_hash,
        expected,
        &content,
        &pdf_key,
        &content_key,
    )
    .await
}

async fn publish_validated(
    db: &Database,
    report_id: &str,
    content_hash: &str,
    expected: Option<String>,
    content: &Value,
    pdf_key: &str,
    content_key: &str,
) -> ApiResult {
    let report_id = report_id.to_owned();
    let hash = content_hash.to_owned();
    let content = content.clone();
    let pdf_key = pdf_key.to_owned();
    let content_key = content_key.to_owned();
    let result=db.run(move |conn| {
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing:Option<(String,String)>=tx.query_row("SELECT code,content_hash FROM featured_reports WHERE report_id=?",params![report_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        let now=chrono::Utc::now().timestamp_millis();
        if let Some((code,old_hash))=existing {
            if old_hash==hash {return Ok((200,json!({"code":code,"contentHash":hash})));}
            if expected.as_deref()!=Some(&old_hash) {return Ok((409,json!("报告已有其他发布版本；请重新核对后发布")));}
            let changes=tx.execute("UPDATE featured_reports SET title=?,institution=?,report_date=?,content_key=?,content_hash=?,updated_at=? WHERE report_id=? AND content_hash=?",params![content["title"].as_str(),content["institution"].as_str(),content["reportDate"].as_str(),content_key,hash,now,report_id,old_hash])?;
            if changes==0 {return Ok((409,json!("concurrent publication")));}
            tx.commit()?;
            return Ok((200,json!({"code":code,"contentHash":hash})));
        }
        for _ in 0..32 {
            let code=random_code();
            let changes=tx.execute("INSERT INTO featured_reports(code,report_id,title,institution,report_date,pdf_key,content_key,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",params![code,report_id,content["title"].as_str(),content["institution"].as_str(),content["reportDate"].as_str(),pdf_key,content_key,hash,now,now])?;
            if changes!=0 {tx.commit()?;return Ok((200,json!({"code":code,"contentHash":hash})));}
        }
        Ok((503,json!("code allocation exhausted; retry publication")))
    }).await?;
    if result.0 == 200 {
        Ok(ok(result.1))
    } else {
        Err(ApiError(
            StatusCode::from_u16(result.0).unwrap(),
            result
                .1
                .as_str()
                .unwrap_or("publication failed")
                .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    fn content() -> Value {
        json!({"schemaVersion":1,"reportId":"a".repeat(64),"title":"研究报告","institution":"机构","reportDate":"2026-10-29","pageCount":2,"summary":"摘要",
            "sections":[{"id":"section-1","title":"章节","blocks":[{"id":"block-1","translation":"翻译内容","sourceLocations":[{"page":1,"bbox":[0.1,0.2,0.8,0.9]}]}]}]})
    }

    fn setup() -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("stock-info.sqlite")).unwrap();
        db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let state =
            AppState::new(db, directory.path().to_path_buf(), "127.0.0.1:18000".into()).unwrap();
        (directory, state)
    }

    async fn json_body(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }

    fn test_app(state: AppState) -> Router {
        Router::new()
            .nest("/api", routes())
            .merge(page_routes())
            .with_state(state)
    }

    #[test]
    fn validates_content_identity_coordinates_and_global_ids() {
        validate_content(&content()).unwrap();
        let mut numeric_json = content();
        numeric_json["schemaVersion"] = json!(1.0);
        numeric_json["pageCount"] = json!(2.0);
        numeric_json["sections"][0]["blocks"][0]["sourceLocations"][0]["page"] = json!(1.0);
        validate_content(&numeric_json).unwrap();
        let mut unicode_date = content();
        unicode_date["reportDate"] = json!("２０２６-１０-２９");
        assert!(validate_content(&unicode_date).is_err());
        for field in [
            "title",
            "summary",
            "institution",
            "reportDate",
            "sections",
            "pageCount",
        ] {
            let mut value = content();
            value.as_object_mut().unwrap().remove(field);
            assert!(validate_content(&value).is_err(), "missing {field}");
        }
        let mut duplicate = content();
        duplicate["sections"][0]["blocks"][0]["id"] = json!("section-1");
        assert!(validate_content(&duplicate).is_err());
        for bbox in [
            json!([0.8, 0.2, 0.1, 0.9]),
            json!([0.1, 0.2, 1.1, 0.9]),
            json!([0.1, 0.2, 0.8]),
            json!([0.1, "bad", 0.8, 0.9]),
        ] {
            let mut invalid = content();
            invalid["sections"][0]["blocks"][0]["sourceLocations"][0]["bbox"] = bbox;
            assert!(validate_content(&invalid).is_err());
        }
        let mut invalid = content();
        invalid["sections"][0]["blocks"][0]["sourceLocations"][0]["page"] = json!(3);
        assert!(validate_content(&invalid).is_err());
        let mut emoji = content();
        emoji["title"] = json!("😀".repeat(251));
        assert!(
            validate_content(&emoji).is_err(),
            "JS UTF-16 length boundary must be preserved"
        );
    }

    #[test]
    fn bearer_matching_and_codes_keep_validation_boundaries() {
        assert!(token_matches("secret", "secret"));
        assert!(!token_matches("", ""));
        assert!(!token_matches("secret", "Secret"));
        assert!(!token_matches("secret", "secret "));
        for code in ["100000", "999999"] {
            assert!(report_code(code));
        }
        for code in ["012345", "12345", "1234567", "../123", "１23456"] {
            assert!(!report_code(code));
        }
        for _ in 0..100 {
            assert!(report_code(&random_code()));
        }
    }

    #[tokio::test]
    async fn local_registry_metadata_range_head_and_readonly_contract() {
        let (directory, state) = setup();
        let review = directory.path().join("review");
        fs::create_dir(&review).unwrap();
        let bytes = serde_json::to_vec(&content()).unwrap();
        fs::write(review.join("content.json"), &bytes).unwrap();
        fs::write(review.join("original.pdf"), b"%PDF-test-document").unwrap();
        let registry = registry_root(&state);
        let registered = register_local_report(&review, &registry).unwrap();
        assert_eq!(
            register_local_report(&review, &registry).unwrap(),
            registered
        );
        let code = registered["code"].as_str().unwrap();
        let app = test_app(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/featured-reports/{code}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let metadata = json_body(response).await;
        assert_eq!(metadata["data"]["contentHash"], digest(&bytes));
        assert_eq!(
            metadata["data"]["contentUrl"],
            format!("/__review/{code}/content.json")
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/__review/{code}/original.pdf"))
                    .header(header::RANGE, "bytes=5-8")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 5-8/18");
        assert_eq!(
            &to_bytes(response.into_body(), 1024).await.unwrap()[..],
            b"test"
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::HEAD)
                    .uri(format!("/__review/{code}/original.pdf"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "18");
        assert!(
            to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty()
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/__review/{code}/original.pdf"))
                    .header(header::RANGE, "bytes=999-1000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/__review/{code}/save"))
                    .body(Body::from("changed"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(fs::read(review.join("content.json")).unwrap(), bytes);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/featured-reports/000000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn publication_is_idempotent_compare_and_swap_and_local_artifacts_only() {
        let (_directory, state) = setup();
        let original = content();
        let report_id = original["reportId"].as_str().unwrap();
        let bytes = serde_json::to_vec(&original).unwrap();
        let content_hash = digest(&bytes);
        let pdf_key = format!("featured-reports/{report_id}/original.pdf");
        let content_key = format!("featured-reports/{report_id}/{content_hash}/content.json");
        state
            .knowledge_store()
            .unwrap()
            .put(&pdf_key, b"%PDF-proof".to_vec())
            .await
            .unwrap();
        state
            .knowledge_store()
            .unwrap()
            .put(&content_key, bytes)
            .await
            .unwrap();
        let first = publish_validated(
            &state.db,
            report_id,
            &content_hash,
            None,
            &original,
            &pdf_key,
            &content_key,
        )
        .await
        .unwrap()
        .0;
        let retry = publish_validated(
            &state.db,
            report_id,
            &content_hash,
            None,
            &original,
            &pdf_key,
            &content_key,
        )
        .await
        .unwrap()
        .0;
        assert_eq!(first, retry);
        let code = first["data"]["code"].as_str().unwrap();
        let app = test_app(state.clone());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/featured-reports/{code}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let data = json_body(response).await["data"].clone();
        assert_eq!(
            data["pdfUrl"],
            format!("/__featured/{report_id}/original.pdf")
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(data["pdfUrl"].as_str().unwrap())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            &to_bytes(response.into_body(), 1024).await.unwrap()[..],
            b"%PDF-proof"
        );
        let mut changed = original.clone();
        changed["title"] = json!("新标题");
        let changed_bytes = serde_json::to_vec(&changed).unwrap();
        let changed_hash = digest(&changed_bytes);
        let changed_key = format!("featured-reports/{report_id}/{changed_hash}/content.json");
        assert_eq!(
            publish_validated(
                &state.db,
                report_id,
                &changed_hash,
                None,
                &changed,
                &pdf_key,
                &changed_key
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::CONFLICT
        );
        state
            .knowledge_store()
            .unwrap()
            .put(&changed_key, changed_bytes)
            .await
            .unwrap();
        let updated = publish_validated(
            &state.db,
            report_id,
            &changed_hash,
            Some(content_hash.clone()),
            &changed,
            &pdf_key,
            &changed_key,
        )
        .await
        .unwrap()
        .0;
        assert_eq!(updated["data"]["code"], code);
        let stale = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/__featured/{report_id}/{content_hash}/content.json"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::NOT_FOUND);
        state
            .db
            .execute(
                "UPDATE featured_reports SET status='withdrawn' WHERE code=?",
                vec![code.into()],
            )
            .await
            .unwrap();
        let withdrawn = app
            .oneshot(
                Request::builder()
                    .uri(format!("/__featured/{report_id}/original.pdf"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(withdrawn.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn publication_route_does_not_accept_missing_bearer_or_bad_local_paths() {
        let (_directory, state) = setup();
        let app = test_app(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/internal/featured-reports")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/__featured/not-a-hash/original.pdf")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn local_publication_rejects_missing_oversized_mismatched_and_unverified_objects() {
        let (_directory, state) = setup();
        let report_id = "a".repeat(64);
        let fake_hash = "b".repeat(64);
        let manifest = json!({"reportId":report_id,"contentHash":fake_hash,"expectedHash":null});
        for invalid in [
            json!(null),
            json!({"reportId":report_id,"contentHash":fake_hash}),
            json!({"reportId":"../private","contentHash":fake_hash,"expectedHash":null}),
        ] {
            assert_eq!(
                publish_local_artifacts(&state, &invalid)
                    .await
                    .err()
                    .unwrap()
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            publish_local_artifacts(&state, &manifest)
                .await
                .err()
                .unwrap()
                .0,
            StatusCode::BAD_REQUEST
        );
        let store = state.knowledge_store().unwrap();
        store
            .put(
                &format!("featured-reports/{report_id}/original.pdf"),
                b"%PDF-test".to_vec(),
            )
            .await
            .unwrap();
        let content_key = format!("featured-reports/{report_id}/{fake_hash}/content.json");
        store
            .put(&content_key, vec![b' '; MAX_CONTENT_BYTES + 1])
            .await
            .unwrap();
        let error = publish_local_artifacts(&state, &manifest)
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(error.1.contains("oversized"));
        store.put(&content_key, b"{}".to_vec()).await.unwrap();
        let error = publish_local_artifacts(&state, &manifest)
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(error.1, "content checksum mismatch");
        let mut mismatch = content();
        mismatch["reportId"] = json!("c".repeat(64));
        let bytes = serde_json::to_vec(&mismatch).unwrap();
        let hash = digest(&bytes);
        store
            .put(
                &format!("featured-reports/{report_id}/{hash}/content.json"),
                bytes,
            )
            .await
            .unwrap();
        let error = publish_local_artifacts(
            &state,
            &json!({"reportId":report_id,"contentHash":hash,"expectedHash":null}),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(error.1, "report identity mismatch");
        assert_eq!(
            state
                .db
                .query("SELECT count(*) AS count FROM featured_reports", vec![])
                .await
                .unwrap()[0]["count"],
            0
        );
        let bytes = serde_json::to_vec(&content()).unwrap();
        let hash = digest(&bytes);
        store
            .put(
                &format!("featured-reports/{report_id}/{hash}/content.json"),
                bytes,
            )
            .await
            .unwrap();
        assert!(
            publish_local_artifacts(
                &state,
                &json!({"reportId":report_id,"contentHash":hash,"expectedHash":null})
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn publication_concurrent_updates_do_not_overwrite_a_newer_reviewed_version() {
        let (_directory, state) = setup();
        let content = content();
        let report_id = content["reportId"].as_str().unwrap();
        let base_hash = digest(&serde_json::to_vec(&content).unwrap());
        let pdf_key = format!("featured-reports/{report_id}/original.pdf");
        let base_key = format!("featured-reports/{report_id}/{base_hash}/content.json");
        let _ = publish_validated(
            &state.db, report_id, &base_hash, None, &content, &pdf_key, &base_key,
        )
        .await
        .unwrap();
        let mut a = content.clone();
        a["title"] = json!("A");
        let a_hash = digest(&serde_json::to_vec(&a).unwrap());
        let mut b = content.clone();
        b["title"] = json!("B");
        let b_hash = digest(&serde_json::to_vec(&b).unwrap());
        let a_key = format!("featured-reports/{report_id}/{a_hash}/content.json");
        let b_key = format!("featured-reports/{report_id}/{b_hash}/content.json");
        let (a_result, b_result) = tokio::join!(
            publish_validated(
                &state.db,
                report_id,
                &a_hash,
                Some(base_hash.clone()),
                &a,
                &pdf_key,
                &a_key
            ),
            publish_validated(
                &state.db,
                report_id,
                &b_hash,
                Some(base_hash),
                &b,
                &pdf_key,
                &b_key
            )
        );
        assert_ne!(a_result.is_ok(), b_result.is_ok());
        let winner = if a_result.is_ok() { &a_hash } else { &b_hash };
        let loser = if let Err(error) = a_result {
            error
        } else {
            b_result.err().unwrap()
        };
        assert_eq!(loser.0, StatusCode::CONFLICT);
        let rows = state
            .db
            .query(
                "SELECT content_hash FROM featured_reports WHERE report_id=?",
                vec![report_id.into()],
            )
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["content_hash"].as_str(), Some(winner.as_str()));
    }
}
