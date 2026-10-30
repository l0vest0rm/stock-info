pub mod notices;
pub mod reports;

use crate::{ApiError, ApiResult, AppState, cache_policy, codes, http::number, ok};
use anyhow::{Context, Result};
use axum::{
    Router,
    body::Body,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
};
use tokio_stream::{StreamExt, wrappers::UnboundedReceiverStream};

type Params = HashMap<String, String>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/company/overview", get(overview_route))
        .route("/company/info", get(info_route))
        .route("/company/notices", get(notices_route))
        .route("/company/reports", get(reports_route))
        .route(
            "/company/reports/discovery-capability",
            get(capability_route),
        )
        .route("/company/reports/stream", get(stream_route))
        .route("/company/reports/discover", post(discover_route))
        .route("/company/reports/discover/sync", post(sync_route))
        .route("/report/forecast", get(forecast_route))
        .route("/report/url", get(|| async { ok(Value::Null) }))
}

fn headers(referer: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "referer",
        HeaderValue::from_str(referer).expect("fixed referer"),
    );
    headers.insert("user-agent",HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"));
    headers
}

pub async fn eastmoney_overview(state: &AppState, code: &str) -> Result<Value> {
    fetch_eastmoney_overview(state, code, false).await
}

pub async fn eastmoney_quote(state: &AppState, code: &str) -> Result<Value> {
    fetch_eastmoney_overview(state, code, true).await
}

async fn fetch_eastmoney_overview(
    state: &AppState,
    raw_code: &str,
    quote_only: bool,
) -> Result<Value> {
    let code = codes::normalize(raw_code);
    let secid = codes::eastmoney_secid(&code)
        .with_context(|| format!("unsupported company code: {raw_code}"))?;
    let mut url = Url::parse("https://push2delay.eastmoney.com/api/qt/stock/get")?;
    url.query_pairs_mut().extend_pairs([
        ("ut", "fa5fd1943c7b386f172d6893dbfba10b"),
        ("invt", "2"),
        ("fltt", "1"),
        ("secid", &secid),
        (
            "fields",
            "f43,f57,f58,f59,f116,f124,f162,f167,f168,f169,f170",
        ),
    ]);
    let body_future = state.http.cached_json(
        &state.db,
        url.as_str(),
        headers("https://quote.eastmoney.com/"),
        cache_policy::market_ttl(&code, chrono::Utc::now().timestamp_millis()),
        false,
    );
    let profile_future = async {
        if quote_only {
            Ok(Value::Null)
        } else {
            company_profile(state, &code).await
        }
    };
    let (body, profile) = tokio::try_join!(body_future, profile_future)?;
    Ok(map_eastmoney_overview(
        &code,
        &body["data"],
        profile,
        chrono::Utc::now().timestamp_millis(),
    ))
}

pub fn map_eastmoney_overview(code: &str, data: &Value, profile: Value, now: i64) -> Value {
    let decimals = number(&data["f59"])
        .filter(|n| (0.0..=6.0).contains(n))
        .unwrap_or(2.0)
        .trunc() as i32;
    let divisor = 10_f64.powi(decimals);
    let zone = if code.ends_with(".US") {
        chrono_tz::America::New_York
    } else {
        chrono_tz::Asia::Shanghai
    };
    let date = number(&data["f124"])
        .filter(|n| *n > 0.0)
        .and_then(|n| chrono::DateTime::from_timestamp(n as i64, 0))
        .map(|d| d.with_timezone(&zone).format("%Y-%m-%d").to_string());
    let name = data["f58"].as_str().unwrap_or("").trim();
    json!({"code":code,"name":if name.is_empty(){code}else{name},"market":codes::market(code),"type":codes::security_type(code),
        "marketDate":date,"latestPrice":number(&data["f43"]).map(|n|n/divisor),"pctChange":number(&data["f170"]).map(|n|n/100.0),
        "changeAmount":number(&data["f169"]).map(|n|n/divisor),"turnover":number(&data["f168"]).map(|n|n/100.0),
        "marketCapYi":number(&data["f116"]).map(|n|n/100_000_000.0),"peTtm":number(&data["f162"]).map(|n|n/100.0),
        "pb":number(&data["f167"]).map(|n|n/100.0),"psTtm":null,"pcfTtm":null,"companyProfile":profile,"source":"eastmoney","updatedAt":now})
}

async fn company_profile(state: &AppState, code: &str) -> Result<Value> {
    if ![".SH", ".SZ", ".BJ"]
        .iter()
        .any(|suffix| code.ends_with(suffix))
    {
        return Ok(Value::Null);
    }
    let mut url = Url::parse("https://datacenter.eastmoney.com/securities/api/data/v1/get")?;
    let filter = format!("(SECUCODE=\"{code}\")");
    url.query_pairs_mut().extend_pairs([
        ("reportName", "RPT_F10_ORG_BASICINFO"),
        (
            "columns",
            "SECUCODE,EM2016,MAIN_BUSINESS,MAXPROFIT_PRODUCT,PRODUCT_NAME",
        ),
        ("quoteColumns", ""),
        ("filter", &filter),
        ("pageNumber", "1"),
        ("pageSize", "1"),
        ("sortTypes", ""),
        ("sortColumns", ""),
        ("source", "HSF10"),
        ("client", "PC"),
    ]);
    let source = url.to_string();
    let result = state
        .http
        .cached_json(
            &state.db,
            url.as_str(),
            headers("https://emweb.securities.eastmoney.com/"),
            86_400_000,
            false,
        )
        .await;
    let now = chrono::Utc::now().timestamp_millis();
    let body = match result {
        Ok(body) => body,
        Err(error) => {
            eprintln!("Eastmoney company profile unavailable: {code}: {error}");
            return Ok(
                json!({"taxonomy":"eastmoney-em2016.v1","availability":"unavailable","industry":null,"industryLevels":[],"mainBusiness":null,"products":[],"sourceUrl":source,"updatedAt":now}),
            );
        }
    };
    let rows = body["result"]["data"].as_array();
    let row = rows.and_then(|rows| {
        rows.iter()
            .find(|row| codes::normalize(row["SECUCODE"].as_str().unwrap_or("")) == code)
            .or_else(|| rows.first())
    });
    let empty = Value::Null;
    let row = row.unwrap_or(&empty);
    let industry = row["EM2016"].as_str().unwrap_or("").trim();
    let business = row["MAIN_BUSINESS"].as_str().unwrap_or("").trim();
    let mut seen = HashSet::new();
    let products = ["MAXPROFIT_PRODUCT", "PRODUCT_NAME"]
        .iter()
        .filter_map(|key| row[*key].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.to_string()))
        .collect::<Vec<_>>();
    Ok(
        json!({"taxonomy":"eastmoney-em2016.v1","availability":if industry.is_empty(){"unavailable"}else{"available"},"industry":if industry.is_empty(){None}else{Some(industry)},
        "industryLevels":industry.split('-').map(str::trim).filter(|s|!s.is_empty()).collect::<Vec<_>>(),"mainBusiness":if business.is_empty(){None}else{Some(business)},"products":products,"sourceUrl":source,"updatedAt":now}),
    )
}

pub async fn overview(state: &AppState, raw_code: &str) -> Result<Value> {
    let code = codes::normalize(raw_code);
    let today = chrono::Utc::now().date_naive().to_string();
    anyhow::ensure!(
        codes::supported(&code),
        "unsupported company overview code: {code}"
    );
    // Overview has one price source: Xueqiu. Identity and industry facts do not
    // require Eastmoney's separate quote service (whose prices are not used).
    let (name, rows, profile) = tokio::try_join!(
        company_name(state, &code),
        crate::market::load_kline(state, &code, "normal", "1990-01-01", &today),
        company_profile(state, &code)
    )?;
    let latest = rows
        .iter()
        .rfind(|row| number(&row["close"]).is_some_and(|price| price > 0.0))
        .with_context(|| {
            format!("Xueqiu K-line has no valid price for company overview: {code}")
        })?;
    let mut overview = global_overview(&code, &name, &rows, chrono::Utc::now().timestamp_millis());
    apply_xueqiu(&mut overview, latest);
    overview["companyProfile"] = profile;
    if number(&latest["marketCapital"]).is_none_or(|cap| cap <= 0.0) {
        // HK K-lines do not carry market capital. Fill only this field through
        // the validated same-source quote contract, never another K-line source.
        let quote = crate::xueqiu::stock_quote(state, &code, false)
            .await
            .with_context(|| {
                format!("Xueqiu market capital unavailable for company overview: {code}")
            })?;
        overview["marketCapYi"] = json!(
            number(&quote["marketCap"])
                .filter(|cap| *cap > 0.0)
                .context("Xueqiu company overview market capital is invalid")?
                / 100_000_000.0
        );
    }
    let cap = number(&overview["marketCapYi"]).map(|n| n * 100_000_000.0);
    match crate::finance::load_latest(state, &code, cap).await {
        Ok(valuation) => {
            for field in ["peTtm", "pb", "psTtm", "pcfTtm"] {
                overview[field] = valuation[field].clone();
            }
        }
        Err(error) => {
            eprintln!("latest financial valuation unavailable: {code}: {error}");
            for field in ["peTtm", "pb", "psTtm", "pcfTtm"] {
                overview[field] = Value::Null;
            }
        }
    }
    Ok(overview)
}

async fn company_name(state: &AppState, code: &str) -> Result<String> {
    let rows = state
        .db
        .query(
            "SELECT short_name FROM stock WHERE code=?",
            vec![code.into()],
        )
        .await?;
    if let Some(name) = rows
        .first()
        .and_then(|row| row["short_name"].as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return Ok(name.to_string());
    }
    crate::market::search_securities(state, code.split('.').next().unwrap_or(code))
        .await?
        .iter()
        .find(|row| row["code"].as_str() == Some(code))
        .and_then(|row| row["name"].as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .with_context(|| format!("company identity unavailable for exact code: {code}"))
}

pub fn apply_xueqiu(overview: &mut Value, latest: &Value) {
    for (target, source) in [
        ("marketDate", "date"),
        ("latestPrice", "close"),
        ("pctChange", "pctChange"),
        ("changeAmount", "changeAmount"),
        ("turnover", "turnover"),
        ("updatedAt", "updatedAt"),
    ] {
        overview[target] = latest[source].clone();
    }
    if let Some(cap) = number(&latest["marketCapital"]) {
        overview["marketCapYi"] = json!(cap / 100_000_000.0);
    }
    for field in ["peTtm", "pb", "psTtm", "pcfTtm"] {
        overview[field] = Value::Null;
    }
    overview["source"] = json!("xueqiu");
}

fn global_overview(code: &str, name: &str, rows: &[Value], now: i64) -> Value {
    let latest = rows.last().cloned().unwrap_or(Value::Null);
    let previous = rows
        .get(rows.len().saturating_sub(2))
        .filter(|_| rows.len() > 1);
    let price = number(&latest["close"]);
    let previous_price = previous.and_then(|row| number(&row["close"]));
    let change = price
        .zip(previous_price)
        .map(|(price, previous)| price - previous);
    json!({"code":code,"name":name,"market":codes::market(code),"type":codes::security_type(code),"marketDate":latest["date"],"latestPrice":price,
        "pctChange":change.zip(previous_price).filter(|(_,previous)|*previous!=0.0).map(|(change,previous)|change*100.0/previous),"changeAmount":change,
        "turnover":latest["turnover"],"marketCapYi":number(&latest["marketCapital"]).map(|cap|cap/100_000_000.0),"peTtm":null,"pb":null,"psTtm":null,"pcfTtm":null,"companyProfile":null,
        "source":latest["source"].as_str().unwrap_or("local"),"updatedAt":now})
}

async fn overview_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(overview(
        &state,
        crate::market::required(&query, "code")?,
    )
    .await?))
}
async fn info_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let overview = overview(&state, crate::market::required(&query, "code")?).await?;
    let mut info = json!({"secCode":overview["code"].as_str().unwrap_or("").split('.').next().unwrap_or(""),"shortName":overview["name"]});
    for field in [
        "code",
        "name",
        "market",
        "type",
        "latestPrice",
        "marketCapYi",
        "peTtm",
        "pb",
    ] {
        info[field] = overview[field].clone();
    }
    Ok(ok(info))
}
async fn notices_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = query
        .get("code")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            query
                .get("stock")
                .filter(|s| !s.trim().is_empty())
                .map(
                    |stock| match query.get("type").filter(|s| !s.trim().is_empty()) {
                        Some(kind) => format!("{}.{}", stock.trim(), kind.trim().to_uppercase()),
                        None => stock.trim().to_string(),
                    },
                )
        })
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "Missing code parameter".into()))?;
    let kind = query
        .get("contentKind")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("notice");
    if !["notice", "research"].contains(&kind) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "contentKind must be notice or research".into(),
        ));
    }
    let page = query
        .get("page")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| *n != 0.0 && !n.is_nan())
        .unwrap_or(1.0);
    let size = query
        .get("pageSize")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| *n != 0.0 && !n.is_nan())
        .unwrap_or(20.0);
    let rows = notices::company_notices(
        &state,
        &code,
        page,
        size,
        query.get("category").map(|s| s.trim()).unwrap_or(""),
        kind == "research",
    )
    .await?;
    Ok(ok(json!(rows.iter().map(|row|json!({"art_code":row["artCode"],"title":row["title"],"notice_date":row["noticeDate"],"columns":[{"column_name":row["noticeType"]}],"pdf_url":row["pdfUrl"],"content_kind":kind})).collect::<Vec<_>>())))
}
fn page(query: &Params) -> usize {
    query
        .get("page")
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1)
}
async fn reports_route(
    State(state): State<AppState>,
    Query(query): Query<Params>,
) -> Result<Response, ApiError> {
    let items = reports::list(
        &state,
        crate::market::required(&query, "code")?,
        page(&query),
        query.get("readOnly").is_some_and(|v| v == "1"),
        None,
    )
    .await?;
    let mut response = ok(json!(project_report_items(&items))).into_response();
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Cookie"));
    Ok(response)
}
async fn capability_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(reports::capability(
        &state,
        crate::market::required(&query, "code")?,
    )
    .await?))
}
async fn stream_route(
    State(state): State<AppState>,
    Query(query): Query<Params>,
) -> Result<Response, ApiError> {
    let code = crate::market::required(&query, "code")?.to_string();
    let page = page(&query);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let task_state = state.clone();
    state.spawn(async move {
        match reports::list(&task_state, &code, page, false, Some(tx.clone())).await {
            Ok(items) => {
                let _ = tx.send(json!({"type":"result","data":project_report_items(&items)}));
            }
            Err(error) => {
                let _ = tx.send(json!({"type":"error","error":error.to_string()}));
            }
        }
    });
    let stream = UnboundedReceiverStream::new(rx).map(|mut event| {
        if event["type"] == "partial"
            && let Some(items) = event["data"].as_array()
        {
            event["data"] = json!(project_report_items(items));
        }
        Ok::<_, Infallible>(format!("data: {event}\n\n"))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::CONNECTION, "keep-alive"),
            (header::VARY, "Cookie"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
async fn discover_route(
    State(state): State<AppState>,
    Query(query): Query<Params>,
    request: axum::extract::Request,
) -> ApiResult {
    let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap_or_default();
    let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}));
    let result = reports::discover(
        &state,
        crate::market::required(&query, "code")?,
        body.get("reasoningEffort").cloned(),
    )
    .await
    .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?;
    Ok(ok(result))
}
async fn sync_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = codes::normalize(crate::market::required(&query, "code")?);
    Ok(ok(reports::sync(&state, &code).await.map_err(|error| {
        ApiError(StatusCode::SERVICE_UNAVAILABLE, error.to_string())
    })?))
}
async fn forecast_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = crate::market::required(&query, "code")?;
    let items = reports::list(&state, code, 1, false, None).await?;
    Ok(ok(reports::aggregate(code, &items)))
}
pub async fn analyze_report(
    state: &AppState,
    title: &str,
    content: &str,
    target_id: &str,
    idempotency_key: &str,
) -> Result<Value> {
    reports::analyze_report(state, title, content, target_id, idempotency_key).await
}
pub fn report_analysis_lock(key: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    reports::report_analysis_lock(key)
}
pub async fn reconcile_discoveries(state: &AppState) -> Result<Value> {
    reports::reconcile(state).await
}
pub async fn periodic_reports(
    state: &AppState,
    code: &str,
    page_size: usize,
) -> Result<Vec<Value>> {
    notices::periodic_reports(state, code, page_size).await
}

pub(crate) fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

pub fn project_report_items(items: &[Value]) -> Vec<Value> {
    const HIDDEN: &[&str] = &[
        "url",
        "detailUrl",
        "localUrl",
        "reportUrl",
        "sourceUrl",
        "pdfUrl",
        "infoCode",
        "encodeUrl",
        "reportId",
        "rptid",
        "rptId",
        "contentUrl",
        "contentKey",
        "llmRawResponse",
    ];
    items
        .iter()
        .map(|item| {
            let mut item = item.clone();
            let mut target = ["localUrl", "url", "detailUrl"]
                .iter()
                .filter_map(|key| item[*key].as_str())
                .map(str::trim)
                .find(|s| !s.is_empty())
                .unwrap_or("")
                .to_string();
            let info = item["infoCode"].as_str().unwrap_or("").trim();
            let code = item["code"].as_str().unwrap_or("");
            if target.is_empty()
                && !info.is_empty()
                && !code.ends_with(".HK")
                && !code.ends_with(".US")
            {
                target = format!(
                    "https://pdf.dfcfw.com/pdf/H3_{}_1.pdf",
                    encode_component(info)
                );
            }
            let carrier = item["detailUrl"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| item["url"].as_str())
                .unwrap_or("");
            let sina = Url::parse(carrier)
                .ok()
                .and_then(|url| {
                    url.host_str()
                        .map(|host| host == "sina.com.cn" || host.ends_with(".sina.com.cn"))
                })
                .unwrap_or(false);
            let carrier = if sina {
                if info.is_empty() {
                    "新浪"
                } else {
                    "东方财富 / 新浪"
                }
            } else if !info.is_empty() {
                "东方财富"
            } else {
                "其他来源"
            };
            if let Some(object) = item.as_object_mut() {
                for key in HIDDEN {
                    object.remove(*key);
                }
                object.insert("reportCarrier".into(), json!(carrier));
                if !target.is_empty() {
                    object.insert("reportUrl".into(), json!(target));
                }
            }
            item
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn per_market_decimal_scaling_and_hk_cap_retention() {
        let mut hk = map_eastmoney_overview(
            "00700.HK",
            &json!({"f43":386400,"f59":3,"f116":100_000_000,"f169":100,"f170":42}),
            Value::Null,
            1,
        );
        assert_eq!(hk["latestPrice"], 386.4);
        assert_eq!(hk["changeAmount"], 0.1);
        apply_xueqiu(
            &mut hk,
            &json!({"date":"2026-10-29","close":400,"marketCapital":null,"updatedAt":2}),
        );
        assert_eq!(hk["marketCapYi"], 1.0);
        assert_eq!(hk["latestPrice"], 400);
        assert_eq!(hk["peTtm"], Value::Null);
    }
    #[test]
    fn report_projection_preserves_only_authenticated_carrier_link() {
        let output = project_report_items(&[
            json!({"code":"600036.SH","infoCode":"AP123","url":"https://finance.sina.com.cn/report/1","detailUrl":"https://finance.sina.com.cn/report/1","llmRawResponse":"secret","title":"report"}),
        ]);
        assert_eq!(output[0]["reportCarrier"], "东方财富 / 新浪");
        assert_eq!(
            output[0]["reportUrl"],
            "https://finance.sina.com.cn/report/1"
        );
        assert!(output[0].get("infoCode").is_none());
        assert!(output[0].get("llmRawResponse").is_none());
    }
}
