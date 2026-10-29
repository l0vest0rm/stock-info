use super::{local_content_url, parse_json, text};
use crate::{ApiError, ApiResult, AppState, ok};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(crate) const BASE: &str = "SELECT d.doc_id,d.source_type,d.report_type,d.source_name,d.title,d.url,d.published_at,d.fetched_at,d.event_time,d.target_name,d.target_code,d.access_method,d.summary,c.content_key,c.content_url,d.content_preview,d.metadata_json,d.recommendation_tags_json,c.content_type,c.content_encoding,c.content_bytes,c.content_sha256,d.inline_content FROM knowledge_docs d LEFT JOIN knowledge_doc_content_refs c ON c.doc_id=d.doc_id";
type QueryMap = HashMap<String, String>;
fn param<'a>(query: &'a QueryMap, key: &str) -> &'a str {
    query.get(key).map(|s| s.trim()).unwrap_or("")
}
fn clamp(query: &QueryMap, key: &str, default: usize, max: usize) -> usize {
    query
        .get(key)
        .and_then(|s| {
            if s.trim().is_empty() {
                Some(0.0)
            } else {
                s.trim().parse::<f64>().ok()
            }
        })
        .filter(|n| n.is_finite() && n.fract() == 0.0)
        .map(|n| n.clamp(1.0, max as f64) as usize)
        .unwrap_or(default)
}
fn filter(query: &QueryMap, key: &str) -> String {
    let value = param(query, key).to_lowercase();
    if value == "all" { String::new() } else { value }
}
pub(crate) fn bad(code: StatusCode, message: impl Into<String>) -> ApiError {
    ApiError(code, message.into())
}

pub async fn list(State(state): State<AppState>, Query(query): Query<QueryMap>) -> ApiResult {
    let q = param(&query, "q");
    if !q.is_empty()
        && !matches!(
            state
                .setting("KNOWLEDGE_ALLOW_TEXT_SEARCH")
                .trim()
                .to_lowercase()
                .as_str(),
            "1" | "true" | "yes" | "on"
        )
    {
        return Err(bad(
            StatusCode::BAD_REQUEST,
            "keyword search is only enabled for local development",
        ));
    }
    let page = clamp(&query, "page", 1, 10000);
    let page_size = clamp(&query, "pageSize", 50, 100);
    let mut conditions = Vec::new();
    let mut binds = Vec::new();
    source_filter(
        &filter(&query, "sourceType"),
        "d.",
        &mut conditions,
        &mut binds,
    );
    let source = filter(&query, "source");
    if !source.is_empty() {
        conditions.push("d.source_name_normalized=?".into());
        binds.push(json!(source));
    }
    let industry = param(&query, "industry");
    if !industry.is_empty() {
        conditions.push("lower(d.target_name)=lower(?)".into());
        binds.push(json!(industry));
    }
    let code = param(&query, "code").to_uppercase();
    if !code.is_empty() {
        conditions.push(
            "d.doc_id IN (SELECT l.doc_id FROM knowledge_doc_security_links l WHERE l.code=?)"
                .into(),
        );
        binds.push(json!(code));
    }
    if !q.is_empty() {
        conditions.push("(lower(d.title) LIKE ? OR lower(coalesce(d.source_name,'')) LIKE ? OR lower(coalesce(d.target_name,'')) LIKE ? OR lower(coalesce(d.target_code,'')) LIKE ? OR lower(coalesce(d.content_preview,'')) LIKE ? OR lower(coalesce(d.url,'')) LIKE ?)".into());
        for _ in 0..6 {
            binds.push(json!(format!("%{}%", q.to_lowercase())));
        }
    }
    let tags = if query.contains_key("tags") {
        param(&query, "tags")
    } else {
        param(&query, "tag")
    };
    for tag in tags
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    {
        if let Some(level) = tag.strip_prefix("recommendation:") {
            conditions.push("upper(coalesce(d.recommendation_level,''))=?".into());
            binds.push(json!(level.to_uppercase()));
        } else {
            conditions.push("EXISTS(SELECT 1 FROM knowledge_doc_tags t WHERE t.doc_id=d.doc_id AND lower(t.tag)=?)".into());
            binds.push(json!(tag));
        }
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let start = (page - 1) * page_size;
    let end = start + page_size + 1;
    let batch_size = (page_size * 4).clamp(100, 400);
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    let mut offset = 0;
    let mut exhausted = false;
    while unique.len() < end && !exhausted {
        let mut params = binds.clone();
        params.extend([json!(batch_size), json!(offset)]);
        let rows=state.db.query(format!("{BASE} {where_sql} ORDER BY d.sort_time DESC,d.rank_score DESC,d.doc_id DESC LIMIT ? OFFSET ?"),params).await?;
        if rows.is_empty() {
            exhausted = true;
            break;
        }
        for row in &rows {
            let key = dedupe_key(row);
            if seen.insert(key) {
                unique.push(map_doc(&state, row));
            }
        }
        offset += rows.len();
        if rows.len() < batch_size {
            exhausted = true;
        }
    }
    let has_next = unique.len() > start + page_size || !exhausted;
    let total = if exhausted {
        unique.len().max(start)
    } else {
        start + unique.len()
    };
    let list = unique
        .into_iter()
        .skip(start)
        .take(page_size)
        .collect::<Vec<_>>();
    Ok(ok(
        json!({"page":page,"page_size":page_size,"total":total,"has_next":has_next,"list":list}),
    ))
}

fn source_filter(source: &str, prefix: &str, conditions: &mut Vec<String>, binds: &mut Vec<Value>) {
    if source.is_empty() {
        return;
    }
    if matches!(source, "company_report" | "industry_report") {
        conditions.push(format!("{prefix}source_type='research_report'"));
        conditions.push(format!("{prefix}report_type=?"));
        binds.push(json!(source));
    } else {
        conditions.push(format!("{prefix}source_type=?"));
        binds.push(json!(source));
    }
}

pub async fn detail(State(state): State<AppState>, Query(query): Query<QueryMap>) -> ApiResult {
    let id = param(&query, "id");
    if id.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "missing doc id"));
    }
    let rows = state
        .db
        .query(format!("{BASE} WHERE d.doc_id=?"), vec![json!(id)])
        .await?;
    let row = rows.first().ok_or_else(|| {
        bad(
            StatusCode::NOT_FOUND,
            format!("knowledge document not found: {id}"),
        )
    })?;
    let mut item = map_doc(&state, row);
    item["content"] = if text(&row["inline_content"]).is_empty() {
        Value::Null
    } else {
        row["inline_content"].clone()
    };
    Ok(ok(item))
}

pub async fn sources(State(state): State<AppState>, Query(query): Query<QueryMap>) -> ApiResult {
    let mut conditions = vec!["coalesce(source_name,'')!=''".into()];
    let mut binds = Vec::new();
    source_filter(
        &filter(&query, "sourceType"),
        "",
        &mut conditions,
        &mut binds,
    );
    let rows=state.db.query(format!("SELECT source_name AS name,COUNT(*) AS count FROM knowledge_docs WHERE {} GROUP BY source_name ORDER BY count(*) DESC,source_name ASC LIMIT 200",conditions.join(" AND ")),binds).await?;
    Ok(ok(
        json!({"list":rows.into_iter().filter_map(|row|{let name=display_source(text(&row["name"]));(!name.is_empty()).then(||json!({"key":row["name"],"name":name,"count":row["count"]}))}).collect::<Vec<_>>()}),
    ))
}
pub async fn industries(State(state): State<AppState>) -> ApiResult {
    let rows=state.db.query("SELECT target_name AS name,COUNT(*) AS count FROM knowledge_docs WHERE source_type='research_report' AND report_type='industry_report' AND coalesce(target_name,'')!='' GROUP BY target_name ORDER BY count(*) DESC,target_name ASC LIMIT 500",vec![]).await?;
    Ok(ok(json!({"list":rows})))
}
pub async fn file(
    State(state): State<AppState>,
    Query(query): Query<QueryMap>,
) -> Result<Response, ApiError> {
    let id = param(&query, "id");
    if id.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "missing doc id"));
    }
    let row = if param(&query, "filtered") == "1" {
        super::review::selected(&state, id).await?
    } else {
        state
            .db
            .query(
                "SELECT url FROM knowledge_docs WHERE doc_id=?",
                vec![json!(id)],
            )
            .await?
            .into_iter()
            .next()
    };
    let url = row.as_ref().map(|row| text(&row["url"])).unwrap_or("");
    if url.is_empty() {
        return Err(bad(
            StatusCode::NOT_FOUND,
            "document file is not stored; original url is unavailable",
        ));
    }
    if !super::importer::valid_url(url) {
        return Err(bad(StatusCode::BAD_REQUEST, "invalid document URL"));
    }
    let mut response = Redirect::temporary(url).into_response();
    *response.status_mut() = StatusCode::FOUND;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    Ok(response)
}
pub async fn content(
    State(state): State<AppState>,
    Query(query): Query<QueryMap>,
) -> Result<Response, ApiError> {
    let key = param(&query, "key");
    if key.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "missing content key"));
    }
    if key.starts_with("localfs:") {
        return Err(bad(
            StatusCode::GONE,
            "localfs knowledge content is no longer supported; re-import or migrate content_key to knowledge-content/*",
        ));
    }
    if std::path::Path::new(key)
        .components()
        .any(|p| !matches!(p, std::path::Component::Normal(_)))
    {
        return Err(bad(StatusCode::BAD_REQUEST, "invalid content key"));
    }
    let mut response = Redirect::temporary(&local_content_url(&state, key)).into_response();
    *response.status_mut() = StatusCode::FOUND;
    Ok(response)
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}
fn regex_replace(pattern: &str, value: &str, replacement: &str) -> String {
    regex::Regex::new(pattern)
        .unwrap()
        .replace_all(value, replacement)
        .to_string()
}
fn security_base(name: &str) -> String {
    regex_replace(r"(?i)\.(SH|SZ|US|HK|BJ|PT)$", name.trim(), "")
        .trim()
        .to_string()
        .pipe(|s| {
            regex_replace(r"(?i)-(SW|W|B|S|R)$", &s, "")
                .trim()
                .to_string()
        })
}
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}
fn security_tag(tag: &str) -> bool {
    [
        r"(?i)\b(?:ETF|LOF|QDII)\b",
        r"(?i)(?:概念|指数|板块|主题)\.PT$",
        r"(?i)^[036]\d{5}\.(?:SH|SZ)$",
    ]
    .iter()
    .any(|p| regex::Regex::new(p).unwrap().is_match(tag.trim()))
        || regex::Regex::new(r"(?i)^[a-z]{2,4}[\w.:-]*$")
            .unwrap()
            .is_match(tag.trim())
            && regex::Regex::new(r"(?i)(?:\.(?:SH|SZ|HK|US|PT)|^[a-z]{2}\d{5,})$")
                .unwrap()
                .is_match(tag.trim())
}
fn display_source(name: &str) -> String {
    let name = name.trim();
    if matches!(name.to_lowercase().as_str(), "本地导入" | "local import") {
        String::new()
    } else {
        name.to_string()
    }
}

pub(crate) fn map_doc(state: &AppState, row: &Value) -> Value {
    let mut metadata = parse_json(&row["metadata_json"]);
    if !metadata.is_object() {
        metadata = json!({});
    }
    let mut target_name = text(&row["target_name"]).to_string();
    let mut target_code = crate::codes::normalize_company(text(&row["target_code"]));
    if metadata["source"] == "tencent_stock_news"
        && metadata["stockNames"]
            .as_array()
            .is_some_and(|v| v.len() > 1)
    {
        let base = security_base(&target_name);
        if base.is_empty() || !text(&row["title"]).contains(&base) || security_tag(&target_name) {
            target_name.clear();
            target_code.clear();
        }
    }
    let fallback = if !target_name.is_empty() || !target_code.is_empty() {
        vec![json!({"name":target_name,"code":target_code,"aliases":[target_name,target_code]})]
    } else {
        vec![]
    };
    let links = metadata["stockLinks"]
        .as_array()
        .filter(|v| !v.is_empty())
        .unwrap_or(&fallback)
        .iter()
        .filter(|item| item.is_object())
        .filter_map(|item| {
            let code = crate::codes::normalize_company(text(&item["code"]));
            if code.is_empty() {
                return None;
            }
            let name = text(&item["name"]);
            let base = security_base(name);
            let short = regex_replace(
                r"(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$",
                &base,
                "",
            );
            let mut aliases = vec![
                name.to_string(),
                code.clone(),
                code.split('.').next().unwrap_or("").to_string(),
                base,
                short,
            ];
            aliases.extend(
                item["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|s| text(s).to_string()),
            );
            Some(json!({"name":name,"code":code,"aliases":unique(aliases)}))
        })
        .collect::<Vec<_>>();
    let mut aliases = HashSet::new();
    for link in &links {
        for v in [text(&link["name"]), text(&link["code"])]
            .into_iter()
            .chain(link["aliases"].as_array().into_iter().flatten().map(text))
        {
            aliases.insert(v.trim().to_lowercase());
        }
    }
    let tags_json = parse_json(&row["recommendation_tags_json"]);
    let mut tags = tags_json
        .as_array()
        .into_iter()
        .flatten()
        .map(text)
        .filter(|s| {
            !s.trim().is_empty() && !aliases.contains(&s.trim().to_lowercase()) && !security_tag(s)
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    let pdf = ["url", "access_method", "metadata_json"]
        .iter()
        .any(|field| text(&row[*field]).to_lowercase().contains(".pdf"));
    if pdf {
        tags.push("pdf".into());
    }
    let key = text(&row["content_key"]);
    let content_url = if !key.is_empty() {
        local_content_url(state, key)
    } else {
        text(&row["content_url"]).to_string()
    };
    let access = if !key.is_empty() {
        "markdown"
    } else if !text(&row["access_method"]).is_empty() {
        text(&row["access_method"])
    } else if pdf {
        "remote_pdf"
    } else {
        "markdown"
    };
    let preview = if !text(&row["content_preview"]).trim().is_empty() {
        text(&row["content_preview"]).trim()
    } else {
        text(&row["title"]).trim()
    };
    let preview = if preview.chars().count() > 280 {
        format!(
            "{}...",
            preview.chars().take(280).collect::<String>().trim_end()
        )
    } else {
        preview.into()
    };
    let pages = [
        &metadata["raw"]["attachPages"],
        &metadata["attachPages"],
        &metadata["pageCount"],
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .and_then(crate::http::number)
    .filter(|n| *n > 0.0 && n.fract() == 0.0);
    let event = ["event_time", "published_at", "fetched_at"]
        .into_iter()
        .map(|k| text(&row[k]))
        .find(|s| !s.is_empty())
        .unwrap_or("");
    json!({"doc_id":row["doc_id"],"source_type":row["source_type"],"report_type":if text(&row["report_type"]).is_empty(){&row["source_type"]}else{&row["report_type"]},"source_name":display_source(text(&row["source_name"])),"title":row["title"],"url":text(&row["url"]),"published_at":text(&row["published_at"]),"fetched_at":text(&row["fetched_at"]),"event_time":event,"target_name":target_name,"target_code":target_code,"access_method":access,"summary":text(&row["summary"]),"content_preview":preview,"content_url":content_url,"stock_links":links,"tags":unique(tags),"report_pages":pages})
}

fn dedupe_key(row: &Value) -> String {
    let metadata = parse_json(&row["metadata_json"]);
    if metadata["source"] != "tencent_stock_news" {
        return text(&row["doc_id"]).to_string();
    }
    let source = text(&row["source_name"]).trim().to_lowercase();
    let title = text(&row["title"]).trim().to_lowercase();
    let preview = if text(&row["content_preview"]).is_empty() {
        text(&row["title"])
    } else {
        text(&row["content_preview"])
    }
    .chars()
    .take(320)
    .collect::<String>();
    let mut cleaned = preview.trim().to_string();
    for pattern in [
        r"^作者[丨|｜:：\s]*[^\s，。,；;:：]{1,40}\s*",
        r"^(公众号|点击上方)[^。！？!?]{0,80}[。！？!?]?\s*",
        r"^来源[：:]\s*[^\s]+\s*",
        r"^原标题[：:]\s*",
    ] {
        cleaned = regex_replace(pattern, &cleaned, "");
    }
    let ignorable = |line: &str| {
        regex::Regex::new(r"^(作者[丨|｜:：\s]|公众号|点击上方|来源|原标题)|加星标")
            .unwrap()
            .is_match(line)
    };
    if ignorable(&cleaned) {
        cleaned = cleaned
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .skip_while(|line| ignorable(line))
            .collect::<Vec<_>>()
            .join(" ");
    }
    let normalized = regex_replace(r"[^\p{L}\p{N}]+", &cleaned, "")
        .to_lowercase()
        .chars()
        .take(180)
        .collect::<String>();
    format!("tencent|{source}|{title}|{normalized}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_and_security_tags() {
        assert!(security_tag("600036.SH"));
        assert!(security_tag("芯片概念.PT"));
        assert!(!security_tag("成长"));
        assert_eq!(security_base("腾讯控股-SW"), "腾讯控股");
        assert_eq!(display_source(" Local Import "), "");
    }
    fn semantic_equal(left: &Value, right: &Value) -> bool {
        match (left, right) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| semantic_equal(a, b))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter().all(|(key, value)| {
                        b.get(key).is_some_and(|other| semantic_equal(value, other))
                    })
            }
            _ => left == right,
        }
    }
    #[test]
    fn original_typescript_document_mapping_golden() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("tests/docs-golden.json")).unwrap();
        let root = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(root.path().join("db.sqlite")).unwrap();
        let state = AppState::new(db, root.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
        for fixture in fixtures {
            let actual = map_doc(&state, &fixture["row"]);
            assert!(
                semantic_equal(&actual, &fixture["expected"]),
                "{}\nactual={}\nexpected={}",
                fixture["row"]["doc_id"],
                actual,
                fixture["expected"]
            );
        }
    }
}
