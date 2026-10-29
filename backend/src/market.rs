use crate::{ApiError, ApiResult, AppState, cache_policy, codes, http::number, ok, xueqiu};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    routing::get,
};
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

type Params = HashMap<String, String>;
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/search", get(search))
        .route("/suggest", get(suggest))
        .route("/code/name", get(names))
        .route("/kline", get(kline))
        .route("/companies/report/cnt", get(report_counts))
        .route("/companies/filter", get(companies_filter))
        .route("/companies/change", get(companies_change))
        .route("/sector/flow", get(sector_flow))
        .route("/companies/holding/rank", get(holding_rank))
}

async fn proxy_json(
    state: &AppState,
    query: Params,
    address: &str,
    defaults: &[(&str, String)],
    referer_url: &str,
    ttl: i64,
) -> Result<Value> {
    let mut url = Url::parse(address)?;
    let mut parameters: HashMap<String, String> = defaults
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect();
    parameters.extend(query);
    url.query_pairs_mut().extend_pairs(parameters);
    state
        .http
        .cached_json(&state.db, url.as_str(), referer(referer_url), ttl, false)
        .await
}

async fn companies_filter(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let body = proxy_json(
        &state,
        query,
        "https://data.eastmoney.com/dataapi/xuangu/list",
        &[
            ("source", "SELECT_SECURITIES".into()),
            ("client", "WEB".into()),
        ],
        "https://data.eastmoney.com/xuangu/",
        cache_policy::region_ttl("cn", chrono::Utc::now().timestamp_millis()),
    )
    .await?;
    Ok(ok(body.get("result").cloned().unwrap_or_else(|| json!({}))))
}

async fn companies_change(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    flow(&state, query, false).await
}
async fn sector_flow(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    flow(&state, query, true).await
}
async fn flow(state: &AppState, query: Params, sector: bool) -> ApiResult {
    let now = chrono::Utc::now().timestamp_millis();
    let mut defaults: Vec<(&str, String)> = [
        ("timil", "1"),
        ("po", "1"),
        ("pz", "50"),
        ("pn", "1"),
        ("np", "1"),
        ("fltt", "1"),
        ("invt", "2"),
        ("dect", "1"),
        ("ut", "fa5fd1943c7b386f172d6893dbfba10b"),
        ("wbp2u", "|0|0|0|web"),
    ]
    .into_iter()
    .map(|(k, v)| (k, v.into()))
    .collect();
    defaults.extend([("cb",format!("jQuery3710_{now}")),("_",now.to_string()),("fid",if sector {"f62"} else {"f184"}.into()),
        ("fs",if sector {"m:90+s:4"} else {"m:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:7+f:!2,m:1+t:3+f:!2"}.into()),
        ("fields",if sector {"f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124,f1,f13"} else {"f2,f3,f12,f13,f14,f62,f184,f225,f165,f263,f109,f175,f264,f160,f100,f124,f265,f1"}.into())]);
    let body = proxy_json(
        state,
        query,
        "https://push2.eastmoney.com/webguest/api/qt/clist/get",
        &defaults,
        "https://quote.eastmoney.com/",
        cache_policy::region_ttl("cn", now),
    )
    .await?;
    Ok(ok(body.get("data").cloned().unwrap_or_else(|| json!({}))))
}
async fn holding_rank(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let page = query.get("page").cloned().unwrap_or_else(|| "1".into());
    let defaults = [
        ("date", query.get("date").cloned().unwrap_or_default()),
        (
            "type",
            query.get("type").cloned().unwrap_or_else(|| "1".into()),
        ),
        ("zjc", "0".into()),
        (
            "sortField",
            query
                .get("rank")
                .cloned()
                .unwrap_or_else(|| "HOULD_NUM".into()),
        ),
        ("sortDirec", "1".into()),
        ("pageNum", page.clone()),
        ("pageSize", "50".into()),
        ("p", page.clone()),
        ("pageNo", page.clone()),
        ("pageNumber", page),
    ];
    let body = proxy_json(
        &state,
        query,
        "https://data.eastmoney.com/dataapi/zlsj/list",
        &defaults,
        "https://data.eastmoney.com/zlsj/",
        86_400_000,
    )
    .await?;
    Ok(ok(if body.is_array() {
        body
    } else {
        body.get("data").cloned().unwrap_or_else(|| json!([]))
    }))
}

pub fn required<'a>(query: &'a Params, key: &str) -> Result<&'a str, ApiError> {
    query
        .get(key)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, format!("Missing {key} parameter")))
}

fn referer(value: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(REFERER, HeaderValue::from_str(value).unwrap());
    headers
}

pub async fn search_securities(state: &AppState, query: &str) -> Result<Vec<Value>> {
    let mut url = Url::parse("https://searchadapter.eastmoney.com/api/suggest/get")?;
    url.query_pairs_mut().extend_pairs([
        ("input", query.trim()),
        ("type", "8"),
        ("token", "D43BF722C8E33BDC906FB84D85E326E8"),
        ("count", "10"),
    ]);
    let body = state
        .http
        .cached_json(
            &state.db,
            url.as_str(),
            referer("https://www.eastmoney.com/"),
            7 * 86_400_000,
            false,
        )
        .await?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for item in body["GubaCodeTable"]["Data"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let raw = item["OuterCode"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_uppercase();
        let code = if raw.starts_with("US") && raw.len() > 2 {
            format!("{}.US", &raw[2..])
        } else if raw.starts_with("OF") && raw.len() > 2 {
            format!("{}.OF", &raw[2..])
        } else if ["HK", "SH", "SZ", "BJ"]
            .iter()
            .any(|prefix| raw.starts_with(prefix))
            && raw.len() > 2
        {
            codes::normalize(&raw[2..])
        } else {
            codes::normalize(&raw)
        };
        let name = item["ShortName"].as_str().unwrap_or("").trim();
        if !codes::supported(&code) || name.is_empty() || !seen.insert(code.clone()) {
            continue;
        }
        results.push(json!({"code":code,"market":codes::market(&code),"type":codes::security_type(&code),"name":name,"source":"eastmoney","updatedAt":now}));
        if results.len() == 12 {
            break;
        }
    }
    Ok(results)
}

async fn search(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(json!(
        search_securities(&state, required(&query, "q")?).await?
    )))
}

async fn suggest(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let rows = search_securities(&state, required(&query, "q")?).await?;
    Ok(ok(json!(
        rows.iter()
            .map(|row| json!({"id":row["code"],"name":row["name"]}))
            .collect::<Vec<_>>()
    )))
}

async fn names(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let mut result = serde_json::Map::new();
    for code in required(&query, "code")?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let normalized = codes::normalize(code);
        let records =
            search_securities(&state, normalized.split('.').next().unwrap_or(&normalized)).await?;
        let name = records
            .iter()
            .find(|record| record["code"].as_str() == Some(&normalized))
            .and_then(|r| r["name"].as_str())
            .unwrap_or(code);
        result.insert(code.into(), json!(name));
    }
    Ok(ok(Value::Object(result)))
}

pub async fn fund_nav(state: &AppState, code: &str, from: &str, to: &str) -> Result<Vec<Value>> {
    let code = format!(
        "{}.OF",
        code.split('.').next().context("invalid fund code")?
    );
    let now = chrono::Utc::now().timestamp_millis();
    let mut rows = Vec::new();
    let mut received = 0;
    let mut page: u64 = 1;
    loop {
        let mut url = Url::parse("https://api.fund.eastmoney.com/f10/lsjz")?;
        url.query_pairs_mut().extend_pairs([
            ("callback", "jQuery"),
            ("fundCode", code.split('.').next().unwrap()),
            ("pageIndex", &page.to_string()),
            ("pageSize", "120"),
            ("startDate", from),
            ("endDate", to),
            ("_", &now.to_string()),
        ]);
        let body = state
            .http
            .cached_json(
                &state.db,
                url.as_str(),
                referer("https://fundf10.eastmoney.com/"),
                cache_policy::market_ttl(&code, now),
                false,
            )
            .await?;
        if number(&body["ErrCode"]).is_some_and(|n| n != 0.0) {
            bail!("eastmoney fund nav error");
        }
        let items = body["Data"]["LSJZList"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        received += items.len() as u64;
        for item in &items {
            if item["FSRQ"].as_str().unwrap_or("").is_empty() {
                continue;
            }
            rows.push(json!({"code":code,"date":item["FSRQ"],"nav":number(&item["DWJZ"]),"accumNav":number(&item["LJJZ"]),"dailyReturn":number(&item["JZZZL"]),"subscriptionStatus":item["SGZT"],"redemptionStatus":item["SHZT"],"updatedAt":now}));
        }
        let total = body["TotalCount"].as_u64();
        let page_size = body["PageSize"].as_u64().filter(|n| *n > 0).unwrap_or(120);
        if items.is_empty()
            || total.is_some_and(|total| received >= total)
            || (total.is_none() && (items.len() as u64) < page_size)
        {
            break;
        }
        page += 1;
    }
    rows.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));
    Ok(rows)
}

pub async fn load_kline(
    state: &AppState,
    raw_code: &str,
    fq: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Value>> {
    let mut code = codes::normalize(raw_code);
    if !codes::supported(&code) {
        bail!("unsupported security code");
    }
    let fund = [".OF", ".SF", ".ZF"]
        .iter()
        .any(|suffix| code.ends_with(suffix));
    if fund {
        code = format!("{}.OF", code.split('.').next().unwrap());
    }
    let key = if fund {
        format!("fund-nav/{code}.json")
    } else {
        format!("kline/{fq}/{code}.json")
    };
    let store = state.market_store()?;
    let now = chrono::Utc::now().timestamp_millis();
    let slice = |rows: Vec<Value>| {
        rows.into_iter()
            .filter(|row| {
                row["date"]
                    .as_str()
                    .is_some_and(|date| date >= from && date <= to)
            })
            .collect::<Vec<_>>()
    };
    if let Some(snapshot) = store.get_json(&key).await? {
        let starts = snapshot["startDate"]
            .as_str()
            .is_some_and(|date| date <= from || from == "1990-01-01");
        let ends = snapshot["endDate"].as_str().is_some_and(|date| date >= to);
        let fresh = snapshot["updatedAt"]
            .as_i64()
            .is_some_and(|at| at > 0 && now < at + cache_policy::market_ttl(&code, at));
        let source_valid = fund
            || (snapshot["schemaVersion"] == 2
                && snapshot["source"] == "xueqiu"
                && snapshot["rawResponseText"].is_string());
        if starts
            && ends
            && fresh
            && source_valid
            && let Some(rows) = snapshot["rows"].as_array()
        {
            return Ok(slice(rows.clone()));
        }
    }
    if fund {
        return Ok(slice(fund_nav(state, &code, from, to).await?));
    }
    let (rows, raw) = xueqiu::stock_kline(state, &code, fq, to).await?;
    if !rows.is_empty() {
        store.put_json(&key,&json!({"schemaVersion":2,"code":code,"fq":fq,"source":"xueqiu","updatedAt":now,"startDate":rows.first().map(|r|&r["date"]),"endDate":rows.last().map(|r|&r["date"]),"rows":rows,"rawResponseText":raw})).await?;
    }
    Ok(slice(rows))
}

async fn kline(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = required(&query, "code")?;
    let period = query.get("period").map(String::as_str).unwrap_or("day");
    let fq = match query.get("fq").map(String::as_str).unwrap_or("normal") {
        "" | "qfq" | "before" => "qfq",
        "hfq" | "after" => "hfq",
        "normal" => "normal",
        _ => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "invalid period or fq parameter".into(),
            ));
        }
    };
    if period != "day" {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid period or fq parameter".into(),
        ));
    }
    let format = query.get("format").map(String::as_str).unwrap_or("legacy");
    if !["legacy", "structured"].contains(&format) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid format parameter".into(),
        ));
    }
    let today = chrono::Utc::now().date_naive().to_string();
    let date = |key: &str, default: &str| {
        query
            .get(key)
            .filter(|s| {
                regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$")
                    .unwrap()
                    .is_match(s)
            })
            .map(String::as_str)
            .unwrap_or(default)
            .to_string()
    };
    let rows = load_kline(
        &state,
        code,
        fq,
        &date("from", "1990-01-01"),
        &date("to", &today),
    )
    .await
    .map_err(|error| ApiError(StatusCode::BAD_GATEWAY, error.to_string()))?;
    if format == "structured" {
        return Ok(ok(json!(rows)));
    }
    Ok(ok(json!(rows.iter().map(legacy_row).collect::<Vec<_>>())))
}

fn legacy_row(row: &Value) -> Value {
    let timestamp = row["date"]
        .as_str()
        .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
        .unwrap_or(0);
    if row.get("nav").is_some() {
        return json!([
            timestamp,
            number(&row["nav"])
                .or_else(|| number(&row["accumNav"]))
                .unwrap_or(0.0)
        ]);
    }
    json!([
        timestamp,
        number(&row["close"]).unwrap_or(0.0),
        number(&row["open"]).unwrap_or(0.0),
        number(&row["high"]).unwrap_or(0.0),
        number(&row["low"]).unwrap_or(0.0),
        number(&row["volume"]).unwrap_or(0.0),
        row["turnover"],
        row["amount"],
        row["amplitude"],
        row["pctChange"],
        row["changeAmount"],
        null
    ])
}

async fn report_counts(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let days = query
        .get("days")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| (1..=3650).contains(n))
        .unwrap_or(90);
    let rows = state.db.query("SELECT target_code_normalized AS code,COUNT(*) AS count FROM knowledge_docs WHERE source_type='research_report' AND report_type='company_report' AND target_code_normalized!='' AND sort_time>=date('now',?) GROUP BY target_code_normalized",vec![format!("-{days} days").into()]).await?;
    let mut counts = serde_json::Map::new();
    for row in rows {
        if let Some(code) = row["code"].as_str() {
            counts.insert(code.into(), row["count"].clone());
        }
    }
    Ok(ok(Value::Object(counts)))
}
