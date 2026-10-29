//! Local runtime adapters that previously lived outside the application router.
//! Sub2Me delivers source records to the existing JSONL import boundary; it does
//! not silently promote a delivery to a processed/verified knowledge document.
use crate::{AppState, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Query, Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

const INPUT_DIR: &str = "/Users/terry/git/data/news";
const CALLBACK_LIMIT: usize = 2 * 1024 * 1024;
type FileSeen = (u64, HashSet<String>);

struct CallbackState {
    token: String,
    seen: Mutex<HashMap<PathBuf, FileSeen>>,
}

fn callback_state(root: &Path) -> Arc<CallbackState> {
    static STATES: OnceLock<Mutex<HashMap<PathBuf, Arc<CallbackState>>>> = OnceLock::new();
    let mut states = STATES.get_or_init(Default::default).lock().unwrap();
    states
        .entry(root.to_path_buf())
        .or_insert_with(|| {
            Arc::new(CallbackState {
                // Three independently generated v4 UUIDs provide > 360 bits of
                // entropy. The subscription token is opaque and never logged.
                token: format!(
                    "{}{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                ),
                seen: Default::default(),
            })
        })
        .clone()
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/local/sub2me/callback", any(callback))
        .route("/local/information-feed/rejected", any(rejected))
}

fn reply(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

fn same_token(expected: &str, supplied: &str) -> bool {
    if expected.len() != supplied.len() {
        return false;
    }
    expected
        .bytes()
        .zip(supplied.bytes())
        .fold(0_u8, |diff, (left, right)| diff | (left ^ right))
        == 0
}

async fn callback(State(state): State<AppState>, request: Request) -> Response {
    if request.method() != Method::POST {
        return reply(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error":"method not allowed"}),
        );
    }
    let callback = callback_state(&state.root);
    let authorization = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let supplied = if authorization
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
    {
        &authorization[7..]
    } else {
        authorization
    };
    if !same_token(&callback.token, supplied) {
        return reply(StatusCode::UNAUTHORIZED, json!({"error":"unauthorized"}));
    }
    let body = match to_bytes(request.into_body(), CALLBACK_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return reply(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error":"payload too large"}),
            );
        }
    };
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => return reply(StatusCode::BAD_REQUEST, json!({"error":"invalid JSON"})),
    };
    let task = nonempty_setting(&state, "SUB2ME_TASK", "cls-telegraph");
    if payload["task"].as_str() != Some(task.as_str())
        || !(payload["record"].is_object() || payload["record"].is_array())
    {
        return reply(
            StatusCode::BAD_REQUEST,
            json!({"error":"invalid task or record"}),
        );
    }
    let directory = input_dir(&state);
    let record = payload["record"].clone();
    let result = tokio::task::spawn_blocking(move || {
        store_record_with_cache(&directory, &record, &callback.seen)
    })
    .await;
    match result {
        Ok(Ok(result)) => reply(StatusCode::OK, result),
        Ok(Err(_)) | Err(_) => reply(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error":"invalid CLS telegraph record or local delivery file"}),
        ),
    }
}

fn nonempty_setting(state: &AppState, key: &str, fallback: &str) -> String {
    let value = state.setting(key);
    if value.trim().is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn input_dir(state: &AppState) -> PathBuf {
    state.root.join(nonempty_setting(
        state,
        "INFORMATION_FEED_INPUT_DIR",
        INPUT_DIR,
    ))
}

/// Registration/backfill is called by the runtime's serialized subscription
/// timer. Retries reuse this process's token, and JSONL IDs remain deduplicated
/// across restarts, including another writer using the same import directory.
pub async fn subscribe(state: &AppState) -> Result<Value> {
    let base = state
        .setting("SUB2ME_BASE_URL")
        .trim()
        .trim_end_matches('/')
        .to_string();
    if base.is_empty() {
        return Ok(json!({"disabled":true,"stored":0}));
    }
    let task = nonempty_setting(state, "SUB2ME_TASK", "cls-telegraph");
    let callback_url = nonempty_setting(
        state,
        "SUB2ME_CALLBACK_URL",
        &format!("http://{}/api/local/sub2me/callback", state.authority),
    );
    let callback = callback_state(&state.root);
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    let response = state
        .http
        .text(
            &format!("{base}/subscriptions"),
            reqwest::Method::POST,
            headers,
            Some(
                json!({
                    "name":format!("stock-info-{task}"),"target_type":"task",
                    "target_value":task,"channel":"callback",
                    "config":{"url":callback_url,"headers":{"Authorization":format!("Bearer {}",callback.token)},"params":{"consumer":"stock-info"}}
                })
                .to_string(),
            ),
        )
        .await
        .context("Sub2Me subscription failed")?;
    let subscription: Value = serde_json::from_str(&response)?;
    let mut before = None;
    let mut stored = 0_u64;
    loop {
        let mut url = reqwest::Url::parse(&format!("{base}/records"))?;
        url.query_pairs_mut()
            .append_pair("task", &task)
            .append_pair("limit", "1000");
        if let Some(before) = before {
            url.query_pairs_mut()
                .append_pair("before", &format!("{before}"));
        }
        let page = state
            .http
            .json(url.as_str(), HeaderMap::new())
            .await
            .context("Sub2Me backfill failed")?;
        let rows = page
            .as_array()
            .context("Sub2Me backfill returned invalid records")?;
        let records = rows
            .iter()
            .map(|row| row["data"].clone())
            .collect::<Vec<_>>();
        let directory = input_dir(state);
        let callback = callback.clone();
        stored += tokio::task::spawn_blocking(move || -> Result<u64> {
            let mut stored = 0;
            for record in records {
                if store_record_with_cache(&directory, &record, &callback.seen)?["status"]
                    == "stored"
                {
                    stored += 1;
                }
            }
            Ok(stored)
        })
        .await??;
        if rows.len() < 1000 {
            break;
        }
        let next = rows
            .last()
            .and_then(|row| crate::http::number(&row["id"]))
            .filter(|value| value.fract() == 0.0 && *value > 0.0)
            .map(|value| value as u64);
        let next = next
            .filter(|next| *next > 0)
            .context("Sub2Me backfill cursor did not advance")?;
        if before.is_some_and(|before| next >= before) {
            bail!("Sub2Me backfill cursor did not advance");
        }
        before = Some(next);
    }
    let mut result = subscription.as_object().cloned().unwrap_or_default();
    result.insert("stored".into(), stored.into());
    Ok(Value::Object(result))
}

fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.trim().to_string(),
        value => value.to_string(),
    }
}

fn first(values: &[&Value]) -> String {
    values
        .iter()
        .map(|value| text(value))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

pub fn map_cls_record(item: &Value, fetched_at: &str) -> Result<Value> {
    let cls_id = text(&item["id"]);
    let ctime = crate::http::number(&item["ctime"]).filter(|time| *time > 0.0);
    let content = first(&[&item["content"], &item["brief"]]);
    let title_content = if content.starts_with('【') {
        content
            .find('】')
            .map(|end| content['【'.len_utf8()..end].to_string())
            .unwrap_or_else(|| content.clone())
    } else {
        content.clone()
    };
    let fallback: String = regex::Regex::new(r"^财联社[^，。]*[，。]?")
        .unwrap()
        .replace(&title_content, "")
        .trim()
        .chars()
        .take(120)
        .collect();
    let title = first(&[&item["title"], &json!(fallback)]);
    let timestamp =
        ctime.and_then(|time| DateTime::<Utc>::from_timestamp_millis((time * 1000.0) as i64));
    if cls_id.is_empty() || timestamp.is_none() || title.is_empty() {
        bail!("invalid CLS telegraph item");
    }
    let published = timestamp
        .unwrap()
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let subjects = item["subjects"].as_array().cloned().unwrap_or_default();
    let stocks = item["stock_list"].as_array().cloned().unwrap_or_default();
    let stock_names = strings(stocks.iter().map(|stock| {
        first(&[
            &stock["name"],
            &stock["stock_name"],
            &stock["stockName"],
            &stock["secu_name"],
        ])
    }));
    let stock_codes = strings(stocks.iter().map(|stock| {
        first(&[
            &stock["code"],
            &stock["stock_code"],
            &stock["stockCode"],
            &stock["StockCode"],
            &stock["StockID"],
            &stock["secu_code"],
            &stock["SecuCode"],
            &stock["symbol"],
            &stock["Symbol"],
        ])
    }));
    let subject_names = subjects
        .iter()
        .map(|subject| first(&[&subject["subject_name"], &subject["name"]]));
    let tags = strings(std::iter::once("财联社电报".to_string()).chain(subject_names));
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("cls_telegraph|{cls_id}").as_bytes())
    );
    let mut encoded = reqwest::Url::parse("https://www.cls.cn/detail/")?;
    encoded
        .path_segments_mut()
        .unwrap()
        .pop_if_empty()
        .push(&cls_id);
    Ok(
        json!({"docId":format!("k_{}",&digest[..24]),"sourceType":"web_news","reportType":"news","sourceName":"财联社",
        "title":title,"url":encoded.as_str(),"publishedAt":published,"fetchedAt":fetched_at,"eventTime":published,
        "discoveryMethod":"cls_backend_api","accessMethod":"markdown","summary":first(&[&item["brief"],&json!(content)]).chars().take(600).collect::<String>(),
        "markdown":content,"tags":tags,"metadata":{"source":"cls_telegraph","clsId":cls_id,"author":text(&item["author"]),"level":text(&item["level"]),"category":text(&item["category"]),"subjects":subjects,"stockList":stocks,"stockNames":stock_names,"stockCodes":stock_codes}}),
    )
}

pub fn store_cls_record(directory: &Path, record: &Value) -> Result<Value> {
    store_record_with_cache(directory, record, &Mutex::new(HashMap::new()))
}

fn store_record_with_cache(
    directory: &Path,
    record: &Value,
    cache: &Mutex<HashMap<PathBuf, FileSeen>>,
) -> Result<Value> {
    let doc = map_cls_record(
        record,
        &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    )?;
    let published = doc["publishedAt"].as_str().unwrap();
    let doc_id = doc["docId"].as_str().unwrap();
    fs::create_dir_all(directory)?;
    let path = directory.join(format!("cls-telegraph-{}.jsonl", &published[..10]));
    let mut cached = cache
        .lock()
        .map_err(|_| anyhow::anyhow!("Sub2Me delivery cache poisoned"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(&path)?;
    file.lock()?;
    let length = file.metadata()?.len();
    let seen = cached
        .entry(path)
        .or_insert_with(|| (u64::MAX, HashSet::new()));
    if seen.0 != length {
        file.seek(SeekFrom::Start(0))?;
        let mut content = String::new();
        file.read_to_string(&mut content)?;
        seen.1.clear();
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            let record: Value =
                serde_json::from_str(line).context("invalid existing CLS delivery JSONL")?;
            if let Some(id) = record["docId"].as_str() {
                seen.1.insert(id.to_string());
            }
        }
        seen.0 = length;
    }
    if seen.1.contains(doc_id) {
        return Ok(json!({"status":"duplicate","doc_id":doc_id}));
    }
    let mut bytes = serde_json::to_vec(&doc)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_data()?;
    seen.1.insert(doc_id.to_string());
    seen.0 = file.metadata()?.len();
    Ok(json!({"status":"stored","doc_id":doc_id}))
}

async fn rejected(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    request: Request,
) -> Response {
    if request.method() != Method::GET {
        return reply(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"code":405,"msg":"method not allowed","data":null}),
        );
    }
    let version = state
        .config("config/knowledge/information-feed-policy.json")
        .map(|value| value["relevance"]["version"].clone());
    let version = match version {
        Ok(version) => version,
        Err(_) => {
            return reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"code":500,"msg":"failed to load information feed policy","data":null}),
            );
        }
    };
    let configured = nonempty_setting(
        &state,
        "INFORMATION_FEED_RELEVANCE_AUDIT_FILE",
        "data/local/information-feed-relevance-rejected.jsonl",
    );
    let path = state.root.join(configured);
    match tokio::task::spawn_blocking(move || read_rejected_feed(&params, &path, &version)).await {
        Ok(Ok(data)) => ok(data).into_response(),
        _ => reply(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"code":500,"msg":"failed to read local feed audit","data":null}),
        ),
    }
}

pub fn read_rejected_feed(
    params: &HashMap<String, String>,
    file: &Path,
    current_version: &Value,
) -> Result<Value> {
    let get = |key: &str, limit| {
        params
            .get(key)
            .map(|v| v.trim().chars().take(limit).collect::<String>())
            .unwrap_or_default()
    };
    let q = get("q", 100).to_lowercase();
    let source = get("source", 60);
    let reason = get("reason", 80);
    let numeric = |key: &str, fallback| {
        params
            .get(key)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v != 0.0)
            .unwrap_or(fallback)
    };
    let limit = numeric("limit", 30.0).clamp(1.0, 100.0) as usize;
    let offset = numeric("offset", 0.0).max(0.0) as usize;
    let content = match fs::read_to_string(file) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let mut seen = HashSet::new();
    let mut list = Vec::new();
    let mut sources = Vec::<(String, u64)>::new();
    let mut reasons = Vec::<(String, u64)>::new();
    let increment = |items: &mut Vec<(String, u64)>, key: String| {
        if let Some((_, count)) = items.iter_mut().find(|(id, _)| *id == key) {
            *count += 1;
        } else {
            items.push((key, 1));
        }
    };
    for line in content.lines().rev().filter(|line| !line.trim().is_empty()) {
        let row: Value = match serde_json::from_str(line) {
            Ok(row) => row,
            Err(_) => continue,
        };
        if &row["policyVersion"] != current_version {
            continue;
        }
        let source_key = row["sourceKey"].as_str().unwrap_or("");
        let source_id = row["sourceItemId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .or_else(|| row["url"].as_str())
            .unwrap_or("");
        let key = format!(
            "{source_key}|{source_id}|{}",
            row["bodySha256"].as_str().unwrap_or("")
        );
        if !seen.insert(key) {
            continue;
        }
        increment(&mut sources, source_key.to_string());
        let codes = row["reasonCodes"].as_array().cloned().unwrap_or_default();
        for code in &codes {
            increment(&mut reasons, text(code));
        }
        if !q.is_empty()
            && !row["title"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&q)
        {
            continue;
        }
        if !source.is_empty() && source_key != source {
            continue;
        }
        if !reason.is_empty()
            && !codes
                .iter()
                .any(|code| code.as_str() == Some(reason.as_str()))
        {
            continue;
        }
        list.push(row);
    }
    let total = list.len();
    let has_next = offset.saturating_add(limit) < total;
    let list = list
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    Ok(
        json!({"list":list,"total":total,"has_next":has_next,"next_offset":if has_next {Some(offset+limit)} else {None},
        "sources":sources.into_iter().map(|(id,count)|json!({"id":id,"count":count})).collect::<Vec<_>>(),
        "reasons":reasons.into_iter().map(|(id,count)|json!({"id":id,"count":count})).collect::<Vec<_>>() }),
    )
}

/// Appends the existing audit shape without treating rejected source content
/// as a verified knowledge record. Facets/read filtering remain policy-bound.
pub fn append_rejected_feed(entry: &Value, file: &Path) -> Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut row = json!({"sourceKey":"","sourceItemId":"","url":"","title":"","publishedAt":"",
        "checkedAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),"policyVersion":entry["policyVersion"],
        "reasonCodes":entry.get("reasonCodes").cloned().unwrap_or_else(||json!([])),
        "evidence":entry.get("evidence").cloned().unwrap_or_else(||json!([])),"bodySha256":""});
    let truthy = |value: &Value| {
        !value.is_null()
            && value != false
            && value.as_str() != Some("")
            && value.as_f64() != Some(0.0)
    };
    for key in [
        "sourceKey",
        "sourceItemId",
        "url",
        "title",
        "publishedAt",
        "bodySha256",
    ] {
        row[key] = entry
            .get(key)
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or_else(|| json!(""));
    }
    for key in ["reasonCodes", "evidence"] {
        row[key] = entry
            .get(key)
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or_else(|| json!([]));
    }
    if entry.get("policyVersion").is_none() {
        row.as_object_mut().unwrap().remove("policyVersion");
    }
    let mut file = OpenOptions::new().create(true).append(true).open(file)?;
    file.lock()?;
    let mut bytes = serde_json::to_vec(&row)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_data()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[test]
    fn cls_mapping_is_stable_and_delivery_deduplicates_across_restarts() {
        let record = json!({"id":123,"ctime":1793260800,"content":"【公司发布业绩】详细原文","stock_list":[{"name":"示例","code":"600000"}],"subjects":[{"subject_name":"财报"}]});
        let doc = map_cls_record(&record, "2026-10-29T00:00:00.000Z").unwrap();
        assert_eq!(
            doc["docId"],
            format!(
                "k_{}",
                &format!("{:x}", Sha256::digest(b"cls_telegraph|123"))[..24]
            )
        );
        assert_eq!(doc["title"], "公司发布业绩");
        assert_eq!(doc["tags"], json!(["财联社电报", "财报"]));
        assert_eq!(doc["metadata"]["stockCodes"], json!(["600000"]));
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            store_cls_record(dir.path(), &record).unwrap()["status"],
            "stored"
        );
        assert_eq!(
            store_cls_record(dir.path(), &record).unwrap()["status"],
            "duplicate"
        );
        assert!(map_cls_record(&json!({"id":1,"ctime":0,"title":"bad"}), "").is_err());
    }

    #[test]
    fn rejection_audit_uses_current_policy_latest_duplicate_and_unfiltered_facets() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rejected.jsonl");
        let rows = [
            json!({"sourceKey":"a","sourceItemId":"1","bodySha256":"x","title":"old","policyVersion":"v1","reasonCodes":["out"]}),
            json!({"sourceKey":"a","sourceItemId":"1","bodySha256":"x","title":"latest","policyVersion":"v1","reasonCodes":["low"]}),
            json!({"sourceKey":"b","sourceItemId":"2","title":"other","policyVersion":"v1","reasonCodes":["out"]}),
            json!({"sourceKey":"c","title":"obsolete","policyVersion":"old","reasonCodes":["out"]}),
        ];
        fs::write(
            &file,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\nmalformed\n",
        )
        .unwrap();
        let params = HashMap::from([("q".into(), "LATEST".into())]);
        let result = read_rejected_feed(&params, &file, &json!("v1")).unwrap();
        assert_eq!(result["total"], 1);
        assert_eq!(result["list"][0]["title"], "latest");
        assert_eq!(result["sources"].as_array().unwrap().len(), 2);
        assert_eq!(
            result["reasons"],
            json!([{"id":"out","count":1},{"id":"low","count":1}])
        );
    }

    #[test]
    fn concurrent_callbacks_do_not_append_duplicate_source_records() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().to_path_buf();
        let second = first.clone();
        let record = json!({"id":"same","ctime":1793260800,"title":"same record"});
        let duplicate = record.clone();
        let a = std::thread::spawn(move || store_cls_record(&first, &record).unwrap());
        let b = std::thread::spawn(move || store_cls_record(&second, &duplicate).unwrap());
        let mut statuses = [
            a.join().unwrap()["status"].as_str().unwrap().to_string(),
            b.join().unwrap()["status"].as_str().unwrap().to_string(),
        ];
        statuses.sort();
        assert_eq!(statuses, ["duplicate", "stored"]);
    }

    #[tokio::test]
    async fn callback_enforces_method_token_size_and_payload_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("db.sqlite")).unwrap();
        let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
        let token = callback_state(dir.path()).token.clone();
        let app = routes().with_state(state);
        for (method, authorization, payload, status) in [
            (
                "GET",
                token.clone(),
                "{}".to_string(),
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                "POST",
                "bad".to_string(),
                "{}".to_string(),
                StatusCode::UNAUTHORIZED,
            ),
            (
                "POST",
                token.clone(),
                "{".to_string(),
                StatusCode::BAD_REQUEST,
            ),
            (
                "POST",
                token.clone(),
                json!({"task":"wrong","record":{}}).to_string(),
                StatusCode::BAD_REQUEST,
            ),
            (
                "POST",
                token,
                "x".repeat(CALLBACK_LIMIT + 1),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/local/sub2me/callback")
                        .header("authorization", format!("Bearer {authorization}"))
                        .body(Body::from(payload))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
    }
}
