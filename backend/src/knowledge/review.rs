use crate::{ApiError, ApiResult, AppState, codes, ok};
use anyhow::{Result, bail};
use axum::{
    Router,
    body::to_bytes,
    extract::{Query, Request, State},
    http::StatusCode,
    routing::get,
};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};

type Params = HashMap<String, String>;
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/knowledge/filtered", get(list))
        .route("/knowledge/filtered/doc", get(detail))
        .route("/knowledge/filtered/keep", axum::routing::post(keep))
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn first<'a>(values: &[&'a str]) -> &'a str {
    values
        .iter()
        .copied()
        .find(|value| !value.trim().is_empty())
        .unwrap_or("")
}
fn preview(value: &str, max: usize) -> String {
    if value.chars().count() > max {
        format!(
            "{}...",
            value.chars().take(max).collect::<String>().trim_end()
        )
    } else {
        value.to_string()
    }
}
fn config(state: &AppState) -> Value {
    state
        .config("config/knowledge/knowledge-processing.json")
        .unwrap_or_else(|_| json!({}))
}
fn review_dir(state: &AppState) -> PathBuf {
    let config = config(state);
    let mut candidates = vec![state.root.join("data/knowledge-review")];
    if let Some(path) = config["reviewDir"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        candidates.push(state.root.join(path));
    }
    candidates.push(state.root.join("../data/stock-info/knowledge/reviews"));
    candidates.push(PathBuf::from(
        "/Users/terry/git/data/stock-info/knowledge/reviews",
    ));
    candidates
        .iter()
        .find(|path| path.is_dir())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

pub fn load_rows(state: &AppState) -> Result<Vec<Value>> {
    let root = review_dir(state);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let pattern = Regex::new(r"(?i)^topic-filter-.*\.jsonl$").unwrap();
    let mut files = fs::read_dir(root)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().is_ok_and(|t| t.is_file())
                && pattern.is_match(&entry.file_name().to_string_lossy())
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    let Some(file) = files.first() else {
        return Ok(Vec::new());
    };
    let body = fs::read_to_string(file)?;
    let mut rows = Vec::new();
    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let row: Value = serde_json::from_str(line)?;
        let keep = match &row["keep"] {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
            Value::String(value) => !value.is_empty(),
            _ => true,
        };
        let reasons = row["reasons"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let mut output = json!({
            "keep": keep, "title": text(&row["title"]),
            "score": crate::http::number(&row["score"]).unwrap_or(0.0),
            "method": text(&row["method"]), "confidence": row["confidence"].as_f64(),
            "url": text(&row["url"]), "file": text(&row["file"]),
            "summary": text(&row["summary"]), "content": text(&row["content"]), "reasons": reasons,
        });
        for (camel, snake) in [
            ("docId", "doc_id"),
            ("sourceType", "source_type"),
            ("reportType", "report_type"),
            ("sourceName", "source_name"),
            ("targetName", "target_name"),
            ("targetCode", "target_code"),
            ("publishedAt", "published_at"),
            ("accessMethod", "access_method"),
            ("contentPreview", "content_preview"),
        ] {
            output[camel] = json!(first(&[text(&row[camel]), text(&row[snake])]));
        }
        if text(&output["reportType"]).is_empty() {
            output["reportType"] = output["sourceType"].clone();
        }
        output["targetCode"] = json!(codes::normalize_company(text(&output["targetCode"])));
        if !text(&output["docId"]).is_empty() {
            rows.push(output);
        }
    }
    Ok(rows)
}
async fn eligible_rows(state: &AppState) -> Result<Vec<Value>> {
    let local_state = state.clone();
    let rows = tokio::task::spawn_blocking(move || load_rows(&local_state)).await??;
    let ids: Vec<_> = rows.iter().map(|row| row["docId"].clone()).collect();
    let mut existing = HashSet::new();
    for batch in ids.chunks(200) {
        let placeholders = vec!["?"; batch.len()].join(",");
        for row in state
            .db
            .query(
                format!("SELECT doc_id FROM knowledge_docs WHERE doc_id IN ({placeholders})"),
                batch.to_vec(),
            )
            .await?
        {
            if let Some(id) = row["doc_id"].as_str() {
                existing.insert(id.to_string());
            }
        }
    }
    Ok(rows
        .into_iter()
        .filter(|row| row["keep"] != true && !existing.contains(text(&row["docId"])))
        .collect())
}
fn limit(query: &Params, key: &str, default: usize, max: usize) -> usize {
    query
        .get(key)
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
        .clamp(1, max)
}
fn aliases(name: &str, code: &str) -> Vec<String> {
    let base = Regex::new(r"(?i)\.(SH|SZ|US|HK|BJ|PT)$")
        .unwrap()
        .replace(name.trim(), "");
    let base = Regex::new(r"(?i)-(SW|W|B|S|R)$")
        .unwrap()
        .replace(&base, "");
    let short =
        Regex::new(r"(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$")
            .unwrap()
            .replace(&base, "");
    let mut seen = HashSet::new();
    [
        name,
        code,
        code.split('.').next().unwrap_or(""),
        &base,
        &short,
    ]
    .into_iter()
    .map(str::trim)
    .filter(|s| !s.is_empty() && seen.insert(s.to_string()))
    .map(str::to_string)
    .collect()
}
fn stock_links(row: &Value) -> Value {
    let code = text(&row["targetCode"]);
    let name = text(&row["targetName"]);
    if code.is_empty() {
        json!([])
    } else {
        json!([{"name":name,"code":code,"aliases":aliases(name,code)}])
    }
}
fn map_row(row: &Value) -> Value {
    let reasons = row["reasons"].as_array().cloned().unwrap_or_default();
    let reason_text = reasons
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("；");
    let fallback = first(&[&reason_text, text(&row["title"])]);
    let joined = [reason_text.as_str(), text(&row["title"])]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let content_preview = if text(&row["contentPreview"]).is_empty() {
        preview(if joined.is_empty() { fallback } else { &joined }, 280)
    } else {
        text(&row["contentPreview"]).to_string()
    };
    let source_name = text(&row["sourceName"]);
    let source_name =
        if ["本地导入", "local import"].contains(&source_name.trim().to_lowercase().as_str()) {
            ""
        } else {
            source_name
        };
    json!({"doc_id":row["docId"],"source_type":"filtered_review","report_type":first(&[text(&row["reportType"]),text(&row["sourceType"]),"news"]),"source_name":source_name,"title":row["title"],"url":row["url"],"published_at":row["publishedAt"],"fetched_at":"","event_time":row["publishedAt"],"target_name":row["targetName"],"target_code":row["targetCode"],"discovery_method":"filtered_review","access_method":first(&[text(&row["accessMethod"]),"markdown"]),"summary":row["summary"],"content_preview":content_preview,"metadata":{"sourceFile":row["file"],"reviewMethod":row["method"]},"stock_links":stock_links(row),"tags":["filtered"],"recommendation":{"level":"","score":row["score"],"tags":["filtered"],"reasons":reasons},"rankScore":row["score"],"rankReasons":row["reasons"],"filter":{"method":row["method"],"score":row["score"],"confidence":row["confidence"],"reasons":row["reasons"],"status":"pending","sourceFile":row["file"]},"favorited":false})
}
async fn list(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let mut rows = eligible_rows(&state).await?;
    let needle = query
        .get("q")
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    rows.retain(|row| {
        needle.is_empty()
            || [
                "title",
                "sourceName",
                "targetName",
                "targetCode",
                "docId",
                "file",
                "method",
            ]
            .into_iter()
            .any(|key| text(&row[key]).to_lowercase().contains(&needle))
            || row["reasons"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|r| text(r).to_lowercase().contains(&needle))
    });
    rows.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["score"].as_f64().unwrap_or(0.0))
            .then_with(|| text(&b["publishedAt"]).cmp(text(&a["publishedAt"])))
    });
    let page = limit(&query, "page", 1, 10000);
    let size = limit(&query, "pageSize", 50, 100);
    let offset = (page - 1) * size;
    let list: Vec<_> = rows.iter().skip(offset).take(size).map(map_row).collect();
    Ok(ok(
        json!({"page":page,"page_size":size,"total":rows.len(),"has_next":offset+size<rows.len(),"list":list}),
    ))
}
pub(crate) async fn selected(state: &AppState, id: &str) -> Result<Option<Value>> {
    Ok(eligible_rows(state)
        .await?
        .into_iter()
        .find(|row| text(&row["docId"]) == id))
}
async fn detail(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let id = query.get("id").map(|s| s.trim()).unwrap_or("");
    if id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "missing doc id".into()));
    }
    let row = selected(&state, id).await?.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            format!("filtered document not found: {id}"),
        )
    })?;
    Ok(ok(full_detail(&state, &row)?))
}

fn safe_source_path(root: &Path, file: &str) -> Result<PathBuf> {
    let relative = Path::new(file);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        bail!("invalid review source path");
    }
    let root = root.canonicalize()?;
    let path = root.join(relative).canonicalize()?;
    if !path.starts_with(&root) {
        bail!("review source escapes configured input directory");
    }
    Ok(path)
}
fn source_data(state: &AppState, file: &str) -> Result<Value> {
    if file.is_empty() {
        return Ok(json!({}));
    }
    let config = config(state);
    let mut roots: Vec<PathBuf> = config["inputDirs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|dir| state.root.join(dir))
        .collect();
    roots.extend([
        PathBuf::from("/Users/terry/git/data/news"),
        PathBuf::from("/Users/terry/git/data/reports"),
    ]);
    for root in roots {
        let Ok(path) = safe_source_path(&root, file) else {
            continue;
        };
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !["json", "jsonl", "md", "txt"].contains(&extension.as_str()) {
            return Ok(json!({}));
        }
        let body = fs::read_to_string(path)?;
        if ["md", "txt"].contains(&extension.as_str()) {
            return Ok(json!({"markdown":body}));
        }
        let line = if extension == "jsonl" {
            body.lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("{}")
        } else {
            body.trim()
        };
        return Ok(serde_json::from_str(line).unwrap_or_else(|_| json!({})));
    }
    Ok(json!({}))
}
fn extract_content(source: &Value) -> String {
    let html = Regex::new(r"(?is)<[a-z][\s\S]*>").unwrap();
    let breaks = Regex::new(r"(?i)<br\s*/?>").unwrap();
    let paragraphs = Regex::new(r"(?i)</p>").unwrap();
    let tags = Regex::new(r"<[^>]+>").unwrap();
    for value in [
        &source["markdown"],
        &source["md_text"],
        &source["summary"],
        &source["content"]["text"],
        &source["content"],
    ] {
        let value = text(value).trim();
        if value.is_empty() {
            continue;
        }
        if html.is_match(value) {
            let mut content = breaks.replace_all(value, "\n").into_owned();
            content = paragraphs.replace_all(&content, "\n\n").into_owned();
            content = tags.replace_all(&content, "").into_owned();
            for (from, to) in [
                ("&nbsp;", " "),
                ("&amp;", "&"),
                ("&lt;", "<"),
                ("&gt;", ">"),
            ] {
                content = content.replace(from, to);
            }
            return content.trim().to_string();
        }
        return value.to_string();
    }
    String::new()
}
fn access(source: &Value, file: &str, content: &str) -> String {
    let explicit = first(&[
        text(&source["accessMethod"]),
        text(&source["access_method"]),
    ]);
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    let url = first(&[text(&source["url"]), text(&source["origin_url"])]).to_lowercase();
    if url.contains(".pdf") || file.to_lowercase().ends_with(".pdf") {
        if url.is_empty() {
            "local_pdf_pending"
        } else {
            "remote_pdf"
        }
    } else if !content.is_empty() {
        "markdown"
    } else {
        "remote_url"
    }
    .into()
}
fn full_detail(state: &AppState, row: &Value) -> Result<Value> {
    let source = source_data(state, text(&row["file"]))?;
    let content = if text(&row["content"]).is_empty() {
        extract_content(&source)
    } else {
        text(&row["content"]).to_string()
    };
    let mut item = map_row(row);
    item["url"] = json!(first(&[
        text(&row["url"]),
        text(&source["url"]),
        text(&source["origin_url"])
    ]));
    item["access_method"] = json!(if text(&row["accessMethod"]).is_empty() {
        access(&source, text(&row["file"]), &content)
    } else {
        text(&row["accessMethod"]).to_string()
    });
    item["summary"] = json!(first(&[
        text(&row["summary"]),
        text(&source["summary"]),
        &preview(&content, 180)
    ]));
    item["content_preview"] = json!(if text(&row["contentPreview"]).is_empty() {
        preview(first(&[&content, text(&row["title"])]), 280)
    } else {
        text(&row["contentPreview"]).into()
    });
    item["content"] = json!(content);
    item["metadata"]["source"] = json!(first(&[
        text(&source["source"]),
        text(&source["source_name"]),
        text(&row["sourceName"])
    ]));
    Ok(item)
}

async fn keep(
    State(state): State<AppState>,
    Query(query): Query<Params>,
    request: Request,
) -> ApiResult {
    let bytes = to_bytes(request.into_body(), 150_000).await.map_err(|_| {
        ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "review request too large".into(),
        )
    })?;
    let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    let id = first(&[
        text(&body["id"]),
        query.get("id").map(String::as_str).unwrap_or(""),
    ])
    .trim();
    if id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "missing doc id".into()));
    }
    let row = selected(&state, id).await?.ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            format!("filtered document not found: {id}"),
        )
    })?;
    let detail = full_detail(&state, &row)?;
    let content = text(&detail["content"]);
    let content_key = if content.is_empty() {
        String::new()
    } else {
        format!("knowledge-content/local-review/{id}.md")
    };
    if !content.is_empty() {
        state
            .knowledge_store()?
            .put(
                content_key.strip_prefix("knowledge-content/").unwrap(),
                content.as_bytes().to_vec(),
            )
            .await?;
    }
    let mut metadata = detail["metadata"].clone();
    metadata["inputRelativeFile"] = row["file"].clone();
    metadata["topicFilter"] = json!({"keep":true,"score":row["score"],"method":row["method"],"reasons":row["reasons"],"confidence":row["confidence"]});
    let links = stock_links(&row);
    metadata["stockLinks"] = links.clone();
    metadata["stockCodes"] = json!(
        links
            .as_array()
            .into_iter()
            .flatten()
            .map(|link| link["code"].clone())
            .collect::<Vec<_>>()
    );
    metadata["stockNames"] = json!(
        links
            .as_array()
            .into_iter()
            .flatten()
            .map(|link| link["name"].clone())
            .collect::<Vec<_>>()
    );
    let id = id.to_string();
    let id_return = id.clone();
    let now = chrono::Utc::now().timestamp_millis();
    let content_bytes = content.len();
    let content_hash = if content.is_empty() {
        String::new()
    } else {
        format!("{:x}", Sha256::digest(content.as_bytes()))
    };
    state.db.run(move|connection|{let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;let source_type=first(&[text(&row["sourceType"]),"local_news"]);let report_type=first(&[text(&row["reportType"]),text(&row["sourceType"]),"news"]);let source_name=text(&row["sourceName"]);let target_code=text(&row["targetCode"]);tx.execute("INSERT INTO knowledge_docs(doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,event_time,target_name,target_code,discovery_method,access_method,summary,content_preview,metadata_json,recommendation_score,recommendation_level,recommendation_tags_json,recommendation_reasons_json,rank_score,source_weight,sort_time,source_name_normalized,target_code_normalized,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'',?7,?8,?9,'filtered_review_keep',?10,?11,?12,?13,1,'D','[\"review_kept\"]',?14,1,0,?7,?15,?16,?17) ON CONFLICT(doc_id) DO NOTHING",rusqlite::params![id,source_type,report_type,source_name,text(&row["title"]),text(&detail["url"]),text(&row["publishedAt"]),text(&row["targetName"]),target_code,text(&detail["access_method"]),text(&detail["summary"]),text(&detail["content_preview"]),serde_json::to_string(&metadata)?,serde_json::to_string(&row["reasons"])?,source_name.trim().to_lowercase(),target_code.trim().to_uppercase(),now])?;
    if !content_key.is_empty(){tx.execute("INSERT INTO knowledge_doc_content_refs(doc_id,content_key,content_url,content_type,content_encoding,content_bytes,content_sha256,updated_at) VALUES(?1,?2,'','text/markdown; charset=utf-8','identity',?3,?4,?5) ON CONFLICT(doc_id) DO UPDATE SET content_key=excluded.content_key,content_url='',content_type=excluded.content_type,content_encoding='identity',content_bytes=excluded.content_bytes,content_sha256=excluded.content_sha256,updated_at=excluded.updated_at",rusqlite::params![id,content_key,content_bytes,content_hash,now])?;}
    tx.execute("DELETE FROM knowledge_doc_security_links WHERE doc_id=?1",[&id])?;for link in links.as_array().into_iter().flatten(){tx.execute("INSERT INTO knowledge_doc_security_links(doc_id,code) VALUES(?1,?2) ON CONFLICT DO NOTHING",rusqlite::params![id,text(&link["code"])])?;}tx.execute("INSERT INTO knowledge_doc_tags(doc_id,tag) VALUES(?1,'review_kept') ON CONFLICT DO NOTHING",[&id])?;tx.commit()?;Ok(())}).await?;
    Ok(ok(json!({"kept":true,"doc_id":id_return})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_path_blocks_traversal_and_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("source.json"), "{}").unwrap();
        assert!(safe_source_path(root.path(), "source.json").is_ok());
        for path in ["../secret", "/absolute", "nested/../../secret"] {
            assert!(safe_source_path(root.path(), path).is_err());
        }
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("secret.json"), "{}").unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
            assert!(safe_source_path(root.path(), "escape/secret.json").is_err());
        }
    }
    #[test]
    fn extracted_review_content_and_security_aliases() {
        assert_eq!(
            extract_content(&json!({"markdown":"<p>Revenue<br>10 &amp; 20</p>"})),
            "Revenue\n10 & 20"
        );
        assert_eq!(codes::normalize_company("USNVDA.OQ"), "NVDA.US");
        assert!(aliases("招商银行股份", "600036.SH").contains(&"招商银行".to_string()));
    }
}
