pub mod domain;
pub mod sources;

use crate::{AppState, codes, http::number};
use anyhow::{Result, bail};
use chrono::{NaiveDate, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, mpsc::UnboundedSender};

const SOURCE_TTL: i64 = 12 * 60 * 60 * 1000;
const FORECAST_TTL: i64 = 30 * 86_400_000;
const DISCOVERY_NAMESPACE: &str = "company_report_discovery";
type Events = Option<UnboundedSender<Value>>;

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}
fn first(values: &[&Value]) -> String {
    values
        .iter()
        .map(|v| text(v))
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}
fn is_cn(code: &str) -> bool {
    [".SH", ".SZ", ".BJ"]
        .iter()
        .any(|suffix| code.ends_with(suffix))
}
fn report_key(code: &str) -> String {
    format!("company-reports-source:v5:{code}")
}
fn forecast_key(item: &Value) -> String {
    format!("report-forecast:v6:{}", domain::report_id(item))
}
fn info_code(item: &Value) -> String {
    let regex = regex::Regex::new(r"AP\d{12,}").unwrap();
    for key in ["infoCode", "url", "detailUrl"] {
        if let Some(found) = regex.find(&text(&item[key]).to_uppercase()) {
            return found.as_str().to_string();
        }
    }
    String::new()
}
fn shared_key(item: &Value) -> String {
    let code = info_code(item);
    if code.is_empty() {
        String::new()
    } else {
        format!("shared-report-analysis:v8:eastmoney:{code}")
    }
}
fn news_key(item: &Value) -> String {
    let id = text(&item["knowledgeDocId"]);
    if id.is_empty() {
        String::new()
    } else {
        format!("company-news-report-analysis:v3:{id}")
    }
}
fn news(item: &Value) -> bool {
    item["knowledgeNewsReport"] == true && !text(&item["knowledgeDocId"]).is_empty()
}
fn positive(value: &Value) -> Option<f64> {
    number(value).filter(|n| *n > 0.0)
}
fn emit(events: &Events, event: Value) {
    if let Some(events) = events {
        let _ = events.send(event);
    }
}
pub fn report_analysis_lock(key: &str) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key.into(), Arc::downgrade(&lock));
    lock
}

pub async fn list(
    state: &AppState,
    raw_code: &str,
    page: usize,
    read_only: bool,
    events: Events,
) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    let (source, quote, annual) = tokio::join!(
        source_pool(state, &code),
        report_quote(state, &code),
        annual_profit(state, &code)
    );
    let source = source?;
    let offset = page.saturating_sub(1).saturating_mul(10);
    let items = source.into_iter().skip(offset).take(10).collect::<Vec<_>>();
    if !read_only && page == 1 {
        let candidates = items
            .iter()
            .filter(|v| news(v))
            .take(5)
            .chain(
                items
                    .iter()
                    .filter(|v| {
                        codes::normalize(text(&v["code"])) == code
                            && !news(v)
                            && needs_extraction(v)
                    })
                    .take(10usize.saturating_sub(items.iter().filter(|v| news(v)).take(5).count())),
            )
            .cloned()
            .collect::<Vec<_>>();
        emit(
            &events,
            json!({"type":"progress","completed":0,"total":candidates.len(),"title":""}),
        );
        emit(
            &events,
            json!({"type":"partial","data":domain::apply_current_pe(&items,quote.as_ref(),&annual)}),
        );
        let mut failures = Vec::new();
        for (index, item) in candidates.iter().enumerate() {
            if let Err(error) = ensure_forecast(state, &code, item, events.clone()).await {
                failures.push(json!({"title":item["title"],"message":error.to_string()}));
                eprintln!("company report extraction failed: {error:#}");
            }
            emit(
                &events,
                json!({"type":"progress","completed":index+1,"total":candidates.len(),"title":item["title"]}),
            );
            let annotated = annotate(state, &items).await?;
            emit(
                &events,
                json!({"type":"partial","data":domain::apply_current_pe(&annotated,quote.as_ref(),&annual)}),
            );
        }
        if !failures.is_empty() {
            emit(
                &events,
                json!({"type":"forecast_failures","failures":failures}),
            );
        }
    } else {
        emit(
            &events,
            json!({"type":"progress","completed":0,"total":0,"title":""}),
        );
    }
    let mut items = annotate(state, &items).await?;
    if read_only {
        items = items.iter().map(domain::normalize_forward).collect();
    }
    Ok(domain::apply_current_pe(&items, quote.as_ref(), &annual))
}

async fn report_quote(state: &AppState, code: &str) -> Option<Value> {
    if !is_cn(code) {
        return None;
    }
    match crate::company::eastmoney_quote(state, code).await {
        Ok(value) => Some(value),
        Err(error) => {
            eprintln!("company report PE overview unavailable: {error:#}");
            None
        }
    }
}
async fn annual_profit(state: &AppState, code: &str) -> BTreeMap<i64, f64> {
    match crate::finance::read_model(state, code, "income").await {
        Ok(model) if model["sourceHealth"]["status"] != "failed" => annual_profit_rows(
            model["rows"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default(),
        ),
        Ok(_) => BTreeMap::new(),
        Err(error) => {
            eprintln!("company report annual financials unavailable: {error:#}");
            BTreeMap::new()
        }
    }
}
fn annual_profit_rows(rows: &[Value]) -> BTreeMap<i64, f64> {
    crate::finance::annual_income(rows)
        .iter()
        .filter_map(|row| {
            let year = row["fiscalYear"].as_i64()?;
            let profit = number(&row["netProfit"])?;
            Some((year, (profit / 100_000_000.0 * 100.0 + 0.5).floor() / 100.0))
        })
        .collect()
}

async fn source_pool(state: &AppState, code: &str) -> Result<Vec<Value>> {
    if !is_cn(code) {
        return Ok(Vec::new());
    }
    let key = report_key(code);
    if let Some(value) = sources::read_app(state, &key).await?
        && let Some(rows) = value.as_array()
    {
        return Ok(rows.iter().map(domain::normalize_provenance).collect());
    }
    let lock = report_analysis_lock(&key);
    let _guard = lock.lock().await;
    if let Some(value) = sources::read_app(state, &key).await?
        && let Some(rows) = value.as_array()
    {
        return Ok(rows.iter().map(domain::normalize_provenance).collect());
    }
    let rows = load_sources(state, code, &[]).await?;
    sources::write_app(state, &key, &json!(rows), SOURCE_TTL).await?;
    Ok(rows)
}
async fn load_sources(state: &AppState, code: &str, discovered: &[Value]) -> Result<Vec<Value>> {
    let (eastmoney, sina, knowledge) = tokio::join!(
        sources::eastmoney_reports(state, code, 1, 100),
        sources::sina_reports(state, code, 1),
        news_candidates(state, code)
    );
    merge_source_outcomes(
        eastmoney,
        sina,
        knowledge,
        discovered,
        Utc::now().timestamp_millis(),
    )
}
fn merge_source_outcomes(
    eastmoney: Result<Vec<Value>>,
    sina: Result<Vec<Value>>,
    knowledge: Result<Vec<Value>>,
    discovered: &[Value],
    now_ms: i64,
) -> Result<Vec<Value>> {
    let eastmoney = eastmoney?;
    let optional = |result: Result<Vec<Value>>, source: &str| match result {
        Ok(rows) => rows,
        Err(error) => {
            eprintln!("company report optional {source} source unavailable: {error:#}");
            Vec::new()
        }
    };
    let rows = domain::merge_reports(
        &domain::merge_reports(
            &domain::merge_reports(&eastmoney, &optional(sina, "Sina")),
            &optional(knowledge, "knowledge"),
        ),
        discovered,
    );
    let cutoff = now_ms - 90 * 86_400_000;
    Ok(rows
        .into_iter()
        .filter(|item| {
            NaiveDate::parse_from_str(
                text(&item["publishDate"]).get(..10).unwrap_or(""),
                "%Y-%m-%d",
            )
            .ok()
            .map(|date| {
                date.and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
                    .timestamp_millis()
                    >= cutoff
            })
            .unwrap_or(true)
        })
        .collect())
}
async fn news_candidates(state: &AppState, code: &str) -> Result<Vec<Value>> {
    let rows=state.db.query("SELECT d.doc_id,d.source_name,d.title,d.url,d.published_at,d.fetched_at,d.event_time,d.summary,d.content_preview,r.content_key,r.content_url FROM knowledge_docs d LEFT JOIN knowledge_doc_content_refs r ON r.doc_id=d.doc_id WHERE d.target_code_normalized=? AND d.report_type='news' AND d.source_type IN ('local_news','web_news') AND (d.title LIKE '%研报%' OR d.title LIKE '%首次覆盖%' OR d.title LIKE '%买入评级%' OR d.title LIKE '%维持%评级%' OR d.title LIKE '%上调%评级%' OR d.title LIKE '%下调%评级%' OR d.title LIKE '%目标价%' OR d.title LIKE '%目标价格%' OR d.content_preview LIKE '%首次覆盖%' OR d.content_preview LIKE '%目标价%') ORDER BY d.sort_time DESC,d.doc_id DESC LIMIT 40",vec![code.into()]).await?;
    Ok(rows.iter().map(|row|json!({"code":code,"title":row["title"],"url":text(&row["url"]),"publishDate":first(&[&row["event_time"],&row["published_at"],&row["fetched_at"]]),"orgName":first(&[&row["source_name"],&json!("资讯")]),"orgSName":first(&[&row["source_name"],&json!("资讯")]),"knowledgeNewsReport":true,"knowledgeDocId":row["doc_id"],"contentPreview":text(&row["content_preview"]),"summary":text(&row["summary"]),"contentKey":text(&row["content_key"]),"contentUrl":text(&row["content_url"])})).collect())
}
fn needs_extraction(item: &Value) -> bool {
    !info_code(item).is_empty()
        || text(&item["detailUrl"]).contains("sina.com.cn")
        || text(&item["url"]).contains("sina.com.cn")
}
fn reusable_shared(value: &Value) -> bool {
    value["analysisCalled"] == true
        && value["forecasts"].is_array()
        && (value["forecasts"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
            || value["analysisSucceeded"] == true)
}
fn reusable_news(value: &Value) -> bool {
    value["analysisCalled"] == true
        && value["analysisSucceeded"] == true
        && value["isCompanyReport"].is_boolean()
        && value["forecasts"].is_array()
        && value.get("targetPrice").is_some()
}

async fn ensure_forecast(state: &AppState, code: &str, item: &Value, events: Events) -> Result<()> {
    if news(item) {
        return ensure_news(state, item, events).await;
    }
    let id = domain::report_id(item);
    if id.is_empty() {
        return Ok(());
    }
    let cache_key = forecast_key(item);
    let shared = shared_key(item);
    if sources::read_app(state, &cache_key)
        .await?
        .as_ref()
        .is_some_and(domain::analysis_success)
    {
        return Ok(());
    }
    if !shared.is_empty()
        && sources::read_app(state, &shared)
            .await?
            .as_ref()
            .is_some_and(reusable_shared)
    {
        return Ok(());
    }
    let lock = report_analysis_lock(if shared.is_empty() {
        &cache_key
    } else {
        &shared
    });
    let _guard = lock.lock().await;
    if sources::read_app(state, &cache_key)
        .await?
        .as_ref()
        .is_some_and(domain::analysis_success)
    {
        return Ok(());
    }
    if !shared.is_empty()
        && sources::read_app(state, &shared)
            .await?
            .as_ref()
            .is_some_and(reusable_shared)
    {
        return Ok(());
    }
    let Some((content, source)) = report_content(state, item).await? else {
        return Ok(());
    };
    let analysis = analyze(state, text(&item["title"]), &content, events).await?;
    let now = Utc::now().timestamp_millis();
    let extraction = json!({"reportId":id,"code":code,"title":item["title"],"source":source,"updatedAt":now,"forecasts":analysis["forecasts"],"targetPrice":analysis["targetPrice"],"analysisSucceeded":true,"rawResponseText":analysis["rawResponseText"]});
    sources::write_app(state, &cache_key, &extraction, FORECAST_TTL).await?;
    if !shared.is_empty() {
        let mut value = json!({"analysisCalled":true,"analysisSucceeded":true,"forecasts":analysis["forecasts"],"updatedAt":now,"rawResponseText":analysis["rawResponseText"]});
        if let Some(target) = positive(&analysis["targetPrice"]) {
            value["targetPrice"] = json!(target);
        }
        sources::write_app(state, &shared, &value, FORECAST_TTL).await?;
    }
    Ok(())
}
async fn ensure_news(state: &AppState, item: &Value, events: Events) -> Result<()> {
    let key = news_key(item);
    if key.is_empty() {
        return Ok(());
    }
    if sources::read_app(state, &key)
        .await?
        .as_ref()
        .is_some_and(reusable_news)
    {
        return Ok(());
    }
    let lock = report_analysis_lock(&key);
    let _guard = lock.lock().await;
    if sources::read_app(state, &key)
        .await?
        .as_ref()
        .is_some_and(reusable_news)
    {
        return Ok(());
    }
    let content = news_content(state, item).await?;
    if content.is_empty() {
        return Ok(());
    }
    let formatted = domain::format_for_llm(&content)
        .chars()
        .take(12000)
        .collect::<String>();
    let mut result = if domain::likely_news(text(&item["title"]), &formatted) {
        let mut result = analyze(state, text(&item["title"]), &formatted, events).await?;
        result["isCompanyReport"] = json!(true);
        result
    } else {
        json!({"isCompanyReport":false,"forecasts":[],"targetPrice":null})
    };
    result["analysisCalled"] = json!(true);
    result["analysisSucceeded"] = json!(true);
    result["updatedAt"] = json!(Utc::now().timestamp_millis());
    sources::write_app(state, &key, &result, FORECAST_TTL).await
}
async fn report_content(state: &AppState, item: &Value) -> Result<Option<(String, String)>> {
    let info = info_code(item);
    if !info.is_empty() {
        let content = sources::eastmoney_pdf_text(state, &info).await?;
        return Ok((!content.is_empty()).then_some((content, "eastmoney_pdf".into())));
    }
    let url = first(&[&item["detailUrl"], &item["url"]]);
    if url.is_empty() {
        return Ok(None);
    }
    let html = sources::decoded_page(state, &url, &format!("sina-report-detail:{url}")).await?;
    let content = sources::extract_sina_content(&html);
    Ok((!content.is_empty()).then_some((content, "sina_html".into())))
}
async fn news_content(state: &AppState, item: &Value) -> Result<String> {
    let key = text(&item["contentKey"]);
    if !key.is_empty()
        && let Some(content) = crate::knowledge::read_content_text(state, key).await?
        && !content.trim().is_empty()
    {
        return Ok(content.trim().chars().take(12000).collect());
    }
    let url = text(&item["contentUrl"]);
    if !url.is_empty() {
        let content = state
            .http
            .text(
                url,
                reqwest::Method::GET,
                reqwest::header::HeaderMap::new(),
                None,
            )
            .await?;
        if !content.trim().is_empty() {
            return Ok(content.trim().chars().take(12000).collect());
        }
    }
    Ok(first(&[&item["contentPreview"], &item["summary"]])
        .chars()
        .take(12000)
        .collect())
}
async fn raw_discovery(state: &AppState, item: &Value) -> Result<Option<Value>> {
    let code = codes::normalize(text(&item["code"]));
    Ok(read_discovery(state, &code)
        .await?
        .and_then(|stored| domain::raw_report(&stored["report"], item)))
}
fn normalized_raw(value: &Value) -> Value {
    let raw = text(value);
    if raw.is_empty() {
        return Value::Null;
    }
    if let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}'))
        && end > start
        && let Ok(parsed) = serde_json::from_str::<Value>(&raw[start..=end])
        && parsed.is_object()
    {
        return parsed;
    }
    json!(raw)
}
fn merge_forecasts(preferred: &[Value], fallback: &[Value]) -> Vec<Value> {
    let mut result = BTreeMap::<i64, Value>::new();
    for row in fallback.iter().chain(preferred) {
        if let Some(year) = number(&row["year"]).map(|n| n as i64) {
            let entry = result.entry(year).or_insert_with(|| json!({"year":year}));
            if let (Some(target), Some(source)) = (entry.as_object_mut(), row.as_object()) {
                target.extend(source.clone());
            }
        }
    }
    result.into_values().collect()
}
async fn annotate(state: &AppState, items: &[Value]) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for item in items {
        if news(item) {
            let analysis = sources::read_app(state, &news_key(item)).await?;
            if let Some(analysis) =
                analysis.filter(|v| reusable_news(v) && v["isCompanyReport"] == true)
            {
                let mut row = item.clone();
                row["forecastSource"] = json!("llm_news_report");
                row["forecasts"] = analysis["forecasts"].clone();
                row["targetPrice"] = analysis["targetPrice"].clone();
                row["llmRawResponse"] = raw_discovery(state, item)
                    .await?
                    .unwrap_or_else(|| normalized_raw(&analysis["rawResponseText"]));
                result.push(row);
            }
            continue;
        }
        if domain::report_id(item).is_empty() {
            result.push(item.clone());
            continue;
        }
        let shared = shared_key(item);
        let shared = if shared.is_empty() {
            None
        } else {
            sources::read_app(state, &shared)
                .await?
                .filter(reusable_shared)
        };
        let report = sources::read_app(state, &forecast_key(item)).await?;
        let cached = if shared
            .as_ref()
            .is_some_and(|v| domain::analysis_has_values(v) || domain::analysis_success(v))
        {
            shared
        } else {
            report
        };
        let raw = raw_discovery(state, item).await?.unwrap_or_else(|| {
            cached
                .as_ref()
                .map(|v| normalized_raw(&v["rawResponseText"]))
                .unwrap_or(Value::Null)
        });
        let mut row = item.clone();
        row["llmRawResponse"] = raw;
        if let Some(cached) =
            cached.filter(|v| domain::analysis_has_values(v) || domain::analysis_success(v))
        {
            row["forecastSource"] = json!("llm_report_source");
            if let Some(preferred) = cached["forecasts"].as_array().filter(|v| !v.is_empty()) {
                row["forecasts"] = json!(merge_forecasts(
                    preferred,
                    item["forecasts"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or_default()
                ));
            }
            if let Some(target) =
                positive(&cached["targetPrice"]).or_else(|| positive(&item["targetPrice"]))
            {
                row["targetPrice"] = json!(target);
            }
        }
        result.push(row);
    }
    Ok(result)
}

pub async fn analyze_report(
    state: &AppState,
    title: &str,
    content: &str,
    _target_id: &str,
    _idempotency_key: &str,
) -> Result<Value> {
    analyze(state, title, content, None).await
}
async fn analyze(state: &AppState, title: &str, content: &str, events: Events) -> Result<Value> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("company report LLM extraction is only available in local runtime");
    }
    let content = domain::format_for_llm(content)
        .trim()
        .chars()
        .take(12000)
        .collect::<String>();
    if content.is_empty() {
        return Ok(
            json!({"forecasts":[],"targetPrice":null,"rawResponseText":"{\"forecasts\":[],\"targetPrice\":null}"}),
        );
    }
    let instructions = include_str!("../../../prompts/company/report-analyze-system.md").trim();
    let user = include_str!("../../../prompts/company/report-analyze-user.md")
        .trim()
        .replacen("{{TITLE}}", title, 1)
        .replacen("{{CONTENT}}", &content, 1);
    let options = json!({"model":crate::llm::config(state)?.model,"instructions":instructions,"input":[{"role":"user","content":[{"type":"input_text","text":user}]}],"maxTokens":4096});
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    let forward = tokio::spawn(async move {
        while let Some(delta) = receiver.recv().await {
            emit(&events, json!({"type":"delta","text":delta}));
        }
    });
    let result = crate::research::taskd::direct_text_events(state, &options, Some(sender)).await;
    let _ = forward.await;
    let response = result?;
    let mut analysis = domain::parse_analysis(&response)?;
    analysis["rawResponseText"] = json!(response);
    Ok(analysis)
}

pub fn aggregate(code: &str, items: &[Value]) -> Value {
    domain::aggregate(code, items)
}

fn stored_task(task: &Value) -> Value {
    let status = match text(&task["status"]) {
        "queued" | "leased" => "queued",
        "running" => "running",
        "succeeded" => "completed",
        "failed" => "failed",
        _ => "blocked",
    };
    json!({"name":task["name"],"status":status,"errorMessage":task["errorMessage"],"createdAt":task["createdAt"],"updatedAt":task["updatedAt"],"completedAt":task["completedAt"]})
}
fn parse_stored_discovery(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let raw_report = &value["report"];
    let report = if raw_report.is_object()
        && !text(&raw_report["response"]["text"]).is_empty()
        && !text(&raw_report["projection"]["securityCode"]).is_empty()
        && ["reportsFound", "reportsRejected", "sourceRows", "cachedAt"]
            .iter()
            .all(|key| number(&raw_report["projection"][key]).is_some())
    {
        json!({"response":{"text":raw_report["response"]["text"]},"projection":{
            "securityCode":raw_report["projection"]["securityCode"],"reportsFound":number(&raw_report["projection"]["reportsFound"]),
            "reportsRejected":number(&raw_report["projection"]["reportsRejected"]),"sourceRows":number(&raw_report["projection"]["sourceRows"]),"cachedAt":number(&raw_report["projection"]["cachedAt"])}})
    } else {
        Value::Null
    };
    let raw_task = &value["task"];
    let task = if raw_task.is_object()
        && !text(&raw_task["name"]).is_empty()
        && ["queued", "running", "completed", "failed", "blocked"]
            .contains(&text(&raw_task["status"]))
        && number(&raw_task["createdAt"]).is_some()
        && number(&raw_task["updatedAt"]).is_some()
    {
        json!({"name":raw_task["name"],"status":raw_task["status"],"errorMessage":if text(&raw_task["errorMessage"]).is_empty(){Value::Null}else{raw_task["errorMessage"].clone()},
            "createdAt":raw_task["createdAt"],"updatedAt":raw_task["updatedAt"],"completedAt":number(&raw_task["completedAt"])})
    } else {
        Value::Null
    };
    if report.is_null() && task.is_null() {
        return None;
    }
    Some(
        json!({"report":report,"task":task,"lastSuccessfulCompletedAt":number(&value["lastSuccessfulCompletedAt"])}),
    )
}
async fn read_discovery(state: &AppState, code: &str) -> Result<Option<Value>> {
    let rows=state.db.query("SELECT value_json FROM kv_cache WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)",vec![DISCOVERY_NAMESPACE.into(),code.into(),Utc::now().timestamp_millis().into()]).await?;
    Ok(rows
        .first()
        .and_then(|row| row["value_json"].as_str())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .as_ref()
        .and_then(parse_stored_discovery))
}
async fn write_discovery(state: &AppState, code: &str, value: &Value) -> Result<()> {
    let updated = number(&value["report"]["projection"]["cachedAt"])
        .or_else(|| number(&value["task"]["updatedAt"]))
        .or_else(|| number(&value["lastSuccessfulCompletedAt"]))
        .unwrap_or(Utc::now().timestamp_millis() as f64);
    state.db.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,expires_at=NULL,updated_at=excluded.updated_at",vec![DISCOVERY_NAMESPACE.into(),code.into(),serde_json::to_string(value)?.into(),json!(updated)]).await?;
    Ok(())
}
fn capability_value(code: &str, stored: Option<&Value>) -> Value {
    json!({"enabled":is_cn(code),"code":code,"task":stored.map(|v|&v["task"]),"lastSuccessfulCompletedAt":stored.map(|v|&v["lastSuccessfulCompletedAt"])})
}
pub async fn capability(state: &AppState, raw_code: &str) -> Result<Value> {
    let code = codes::normalize(raw_code);
    let stored = if is_cn(&code) {
        read_discovery(state, &code).await?
    } else {
        None
    };
    Ok(capability_value(&code, stored.as_ref()))
}
fn reasoning_effort(requested: Option<Value>) -> Result<String> {
    match requested {
        None => Ok("xhigh".into()),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value.trim().into()),
        _ => bail!("company report discovery reasoningEffort must be a non-empty string"),
    }
}
pub async fn discover(state: &AppState, raw_code: &str, requested: Option<Value>) -> Result<Value> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("company report discovery is only available in local LLM runtime");
    }
    let code = codes::normalize(raw_code);
    if !is_cn(&code) {
        bail!("company report discovery only supports mainland company codes");
    }
    let reasoning = reasoning_effort(requested)?;
    let source = source_pool(state, &code).await?;
    let known=source.iter().map(|row|json!({"title":text(&row["title"]),"institution":first(&[&row["orgSName"],&row["orgName"],&row["org"],&row["institution"]]),"publishedAt":first(&[&row["publishDate"],&row["publishedAt"]]),"url":first(&[&row["url"],&row["detailUrl"]])})).filter(|row|!text(&row["title"]).is_empty() || !text(&row["url"]).is_empty()).collect::<Vec<_>>();
    let since = (Utc::now() - chrono::Duration::days(90))
        .date_naive()
        .to_string();
    let prompt = include_str!("../../../prompts/company/report-discovery.md")
        .trim()
        .replace("{{SECURITY_CODE}}", &code)
        .replace("{{COMPANY_NAME}}", &code)
        .replace("{{RECENT_SINCE}}", &since)
        .replace("{{KNOWN_REPORTS_JSON}}", &serde_json::to_string(&known)?);
    let name = format!("company:report-discovery:{code}");
    let task=crate::research::taskd::submit_report(state,&json!({"name":name,"taskType":"webqa.chatgpt.v1","model":"gpt-5.6-luna","reasoningEffort":reasoning,"waitTimeoutMs":3_600_000,"prompt":prompt})).await?;
    let current = read_discovery(state, &code).await?;
    let stored = persist_task(state, &code, current.as_ref(), Some(&task)).await?;
    Ok(json!({"accepted":true,"task":stored["task"]}))
}
async fn persist_task(
    state: &AppState,
    code: &str,
    current: Option<&Value>,
    task: Option<&Value>,
) -> Result<Value> {
    let report = current.map(|v| v["report"].clone()).unwrap_or(Value::Null);
    let last_success = if task.is_some_and(|v| v["status"] == "succeeded") {
        task.and_then(|v| number(&v["completedAt"]))
            .or_else(|| current.and_then(|v| number(&v["lastSuccessfulCompletedAt"])))
    } else {
        current.and_then(|v| number(&v["lastSuccessfulCompletedAt"]))
    };
    let stored = json!({"report":report,"task":task.map(stored_task),"lastSuccessfulCompletedAt":last_success});
    write_discovery(state, code, &stored).await?;
    Ok(stored)
}
async fn project_discovery(state: &AppState, code: &str, task: &Value) -> Result<()> {
    let result = crate::research::taskd::extract_result(&task["result"])?;
    let evidence = &result["terminalEvidence"];
    if evidence["schemaVersion"] != "webqa.completion-evidence.v1"
        || evidence["outcome"] != "succeeded"
    {
        bail!("company report discovery taskd result lacks terminal WebQA completion evidence");
    }
    let response = text(&result["content"]["markdown"]);
    let citations = result["citations"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(result["sources"].as_array().into_iter().flatten())
        .cloned()
        .collect::<Vec<_>>();
    let (discovered, rejected) = domain::parse_discovery(response, code, &citations)?;
    let rows = load_sources(state, code, &discovered).await?;
    sources::write_app(state, &report_key(code), &json!(rows), SOURCE_TTL).await?;
    let now = Utc::now().timestamp_millis();
    let report = json!({"response":{"text":response},"projection":{"securityCode":code,"reportsFound":discovered.len(),"reportsRejected":rejected,"sourceRows":rows.len(),"cachedAt":now}});
    let stored = json!({"report":report,"task":stored_task(task),"lastSuccessfulCompletedAt":number(&task["completedAt"]).unwrap_or(now as f64)});
    write_discovery(state, code, &stored).await
}
async fn sync_raw(state: &AppState, code: &str) -> Result<Option<Value>> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("company report discovery synchronization is only available in local LLM runtime");
    }
    let lock = report_analysis_lock(&format!("discovery:{code}"));
    let _guard = lock.lock().await;
    let stored = read_discovery(state, code).await?;
    let Some(current) = stored
        .as_ref()
        .filter(|value| ["queued", "running"].contains(&text(&value["task"]["status"])))
    else {
        return Ok(stored);
    };
    let expected = json!({"name":current["task"]["name"],"createdAt":current["task"]["createdAt"],"taskId":null});
    let observed = crate::research::taskd::observe(state, &expected).await?;
    match observed {
        Some(task) if task["status"] == "succeeded" => {
            project_discovery(state, code, &task).await?;
            read_discovery(state, code).await
        }
        Some(task) => Ok(Some(
            persist_task(state, code, Some(current), Some(&task)).await?,
        )),
        None => Ok(Some(persist_task(state, code, Some(current), None).await?)),
    }
}
pub async fn sync(state: &AppState, raw_code: &str) -> Result<Value> {
    let code = codes::normalize(raw_code);
    let stored = sync_raw(state, &code).await?;
    Ok(capability_value(&code, stored.as_ref()))
}
pub async fn reconcile(state: &AppState) -> Result<Value> {
    if state.setting("LLM_RUNTIME") != "local" {
        return Ok(json!({"inspected":0,"failed":0}));
    }
    let rows=state.db.query("SELECT key FROM kv_cache WHERE namespace=? AND json_valid(value_json) AND json_extract(value_json,'$.task.status') IN ('queued','running') ORDER BY updated_at ASC",vec![DISCOVERY_NAMESPACE.into()]).await?;
    let mut failed = 0;
    for row in &rows {
        let code = codes::normalize(text(&row["key"]));
        if let Err(error) = sync_raw(state, &code).await {
            failed += 1;
            eprintln!("company report discovery reconciliation failed for {code}: {error:#}");
        }
    }
    Ok(json!({"inspected":rows.len(),"failed":failed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("stock.sqlite")).unwrap();
        db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
        (dir, state)
    }
    #[tokio::test]
    async fn cached_source_pool_is_read_only_and_preserves_provenance() {
        let (_dir, state) = setup();
        let source = json!([{"code":"600036.SH","title":"existing","url":"https://example.com/report","forecasts":[]},{"code":"600036.SH","title":"found","provenance":"web_search"}]);
        sources::write_app(&state, &report_key("600036.SH"), &source, SOURCE_TTL)
            .await
            .unwrap();
        let before=state.db.query("SELECT namespace,key,value_json,updated_at,expires_at FROM kv_cache ORDER BY namespace,key",vec![]).await.unwrap();
        let rows = source_pool(&state, "600036.SH").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["provenance"], "existing");
        assert_eq!(rows[1]["provenance"], "web_search");
        assert_eq!(before,state.db.query("SELECT namespace,key,value_json,updated_at,expires_at FROM kv_cache ORDER BY namespace,key",vec![]).await.unwrap());
    }
    #[tokio::test]
    async fn successful_empty_forecast_cache_does_not_reextract_or_erase_provider_values() {
        let (_dir, state) = setup();
        let item = json!({"code":"600036.SH","infoCode":"AP202610290000001","title":"forecast","forecasts":[{"year":2027,"netProfit":10}],"targetPrice":20});
        let cached = json!({"analysisSucceeded":true,"forecasts":[],"targetPrice":null,"rawResponseText":"{\"forecasts\":[],\"targetPrice\":null}"});
        sources::write_app(&state, &forecast_key(&item), &cached, FORECAST_TTL)
            .await
            .unwrap();
        ensure_forecast(&state, "600036.SH", &item, None)
            .await
            .unwrap();
        let result = annotate(&state, std::slice::from_ref(&item)).await.unwrap();
        assert_eq!(result[0]["forecasts"], item["forecasts"]);
        assert_eq!(result[0]["targetPrice"], 20.0);
        assert_eq!(result[0]["forecastSource"], "llm_report_source");
        assert!(result[0]["llmRawResponse"].is_object());
    }
    #[tokio::test]
    async fn shared_analysis_wins_per_report_and_news_requires_successful_classification() {
        let (_dir, state) = setup();
        let item = json!({"code":"600036.SH","infoCode":"AP202610290000002","forecasts":[{"year":2027,"netProfit":9,"eps":1}]});
        sources::write_app(
            &state,
            &forecast_key(&item),
            &json!({"forecasts":[{"year":2027,"netProfit":11}],"analysisSucceeded":true}),
            FORECAST_TTL,
        )
        .await
        .unwrap();
        sources::write_app(&state,&shared_key(&item),&json!({"analysisCalled":true,"analysisSucceeded":true,"forecasts":[{"year":2027,"netProfit":12}],"targetPrice":25}),FORECAST_TTL).await.unwrap();
        let news = json!({"code":"600036.SH","knowledgeNewsReport":true,"knowledgeDocId":"fixture-news","title":"公司研报"});
        let result = annotate(&state, &[item.clone(), news.clone()])
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["forecasts"][0]["netProfit"], 12);
        assert_eq!(result[0]["forecasts"][0]["eps"], 1);
        let analysis = json!({"analysisCalled":true,"analysisSucceeded":true,"isCompanyReport":true,"forecasts":[],"targetPrice":null});
        sources::write_app(&state, &news_key(&news), &analysis, FORECAST_TTL)
            .await
            .unwrap();
        let result = annotate(&state, &[item, news]).await.unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[1]["forecastSource"], "llm_news_report");
    }
    #[tokio::test]
    async fn discovery_state_is_durable_and_capability_does_not_query_taskd() {
        let (_dir, state) = setup();
        assert_eq!(
            capability(&state, "600036").await.unwrap(),
            json!({"enabled":true,"code":"600036.SH","task":null,"lastSuccessfulCompletedAt":null})
        );
        assert_eq!(
            capability(&state, "AAPL.US").await.unwrap()["enabled"],
            false
        );
        let current = json!({"report":{"response":{"text":"[]"},"projection":{"securityCode":"600036.SH","reportsFound":0,"reportsRejected":0,"sourceRows":0,"cachedAt":100}},"task":null,"lastSuccessfulCompletedAt":100});
        write_discovery(&state, "600036.SH", &current)
            .await
            .unwrap();
        let task = json!({"name":"company:report-discovery:600036.SH","status":"leased","errorMessage":null,"createdAt":200,"updatedAt":201,"completedAt":null});
        let stored = persist_task(&state, "600036.SH", Some(&current), Some(&task))
            .await
            .unwrap();
        assert_eq!(stored["report"], current["report"]);
        assert_eq!(stored["task"]["status"], "queued");
        let capability = capability(&state, "600036.SH").await.unwrap();
        assert_eq!(capability["task"]["name"], task["name"]);
        assert_eq!(
            capability["lastSuccessfulCompletedAt"].as_f64(),
            Some(100.0)
        );
        let rows = state
            .db
            .query(
                "SELECT expires_at FROM kv_cache WHERE namespace=? AND key=?",
                vec![DISCOVERY_NAMESPACE.into(), "600036.SH".into()],
            )
            .await
            .unwrap();
        assert_eq!(rows[0]["expires_at"], Value::Null);
        assert!(
            parse_stored_discovery(
                &json!({"task":{"name":"bad","status":"running","createdAt":"nan","updatedAt":1}})
            )
            .is_none()
        );
    }
    #[test]
    fn reasoning_is_provider_forwarded_and_analysis_lock_is_shared() {
        assert_eq!(reasoning_effort(None).unwrap(), "xhigh");
        assert_eq!(reasoning_effort(Some(json!(" none "))).unwrap(), "none");
        for invalid in [Value::Null, json!(" "), json!(false), json!(2)] {
            assert!(reasoning_effort(Some(invalid)).is_err());
        }
        let one = report_analysis_lock("shared-report-analysis:v8:eastmoney:AP202610290000003");
        let two = report_analysis_lock("shared-report-analysis:v8:eastmoney:AP202610290000003");
        assert!(Arc::ptr_eq(&one, &two));
    }
    #[test]
    fn annual_profit_does_not_treat_q4_as_full_year() {
        let rows = json!([
            {"statementType":"income","reportDate":"2025-12-31","source":"eastmoney","fiscalPeriod":"Q4","payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_quarterly_income.v1","PARENT_NETPROFIT":900000000}},
            {"statementType":"income","reportDate":"2025-12-31","source":"eastmoney","fiscalPeriod":"FY","payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_annual_income.v1","FISCAL_PERIOD":"FY","PARENT_NETPROFIT":1000000000}}
        ]);
        assert_eq!(
            annual_profit_rows(rows.as_array().unwrap()).get(&2025),
            Some(&10.0)
        );
    }
    #[test]
    fn source_failures_preserve_mandatory_provider_boundary() {
        let failed = merge_source_outcomes(
            Err(anyhow::anyhow!("Eastmoney upstream HTTP 503")),
            Ok(vec![
                json!({"title":"Supplement","url":"https://example.com/supplement"}),
            ]),
            Ok(vec![]),
            &[],
            1_800_000_000_000,
        )
        .unwrap_err();
        assert!(failed.to_string().contains("Eastmoney upstream HTTP 503"));
        let primary =
            json!({"title":"Current","infoCode":"AP202610290000001","publishDate":"2026-10-29"});
        let rows = merge_source_outcomes(
            Ok(vec![
                primary.clone(),
                json!({"title":"Old","infoCode":"AP202001010000001","publishDate":"2020-01-01"}),
            ]),
            Err(anyhow::anyhow!("Sina unavailable")),
            Err(anyhow::anyhow!("Knowledge unavailable")),
            &[json!({"title":"Unknown date","url":"https://example.com/unknown"})],
            NaiveDate::from_ymd_opt(2026, 10, 29)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .any(|row| row["infoCode"] == primary["infoCode"])
        );
        assert!(!rows.iter().any(|row| row["title"] == "Old"));
        assert!(rows.iter().any(|row| row["title"] == "Unknown date"));
    }
}
