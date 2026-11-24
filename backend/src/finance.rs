pub mod providers;
pub mod series;
pub mod sync;
pub mod valuation;

pub use series::annual_income_statements as annual_income;
pub use series::quarterly_series;
pub use sync::sync_provisional;
pub use valuation::{
    derive_latest, load_latest, mid_cycle_history, valuation_bands,
    valuation_bands_with_market_cap, valuation_inputs,
};

pub async fn latest_valuation(
    state: &crate::AppState,
    code: &str,
    market_cap: Option<f64>,
) -> anyhow::Result<serde_json::Value> {
    valuation::load_latest(state, code, market_cap).await
}
pub fn trailing_twelve_months(rows: &[serde_json::Value], keys: &[&str]) -> Option<f64> {
    series::ttm_value(rows, |row| {
        keys.iter()
            .find_map(|key| crate::http::number(&row["payload"][*key]))
    })
}

use crate::{ApiError, ApiResult, AppState, codes, http::number, ok};
use anyhow::Result;
use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::get,
};
use chrono::{Datelike, Utc};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

type Params = HashMap<String, String>;
const DATA_ENDPOINT: &str = "https://datacenter-web.eastmoney.com/securities/api/data/v1/get";
use securities_data::finance::dividends::share_additional;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/finance/sharechange", get(sharechange))
        .route("/finance/sharebonus", get(sharebonus))
        .route("/finance/shareadditional", get(shareadditional))
        .route("/finance/dividendyield", get(dividendyield))
        .route("/finance/freeholders", get(freeholders))
        .route("/finance/orgholders", get(orgholders))
        .route("/company/restriction", get(restriction))
        .route("/finance/income/quarterly-series", get(quarterly))
        .route("/finance/valuation-inputs", get(inputs))
        .route("/finance/valuation-bands", get(bands))
        .route("/finance/mid-cycle-earnings", get(midcycle))
        .route("/finance/{statement_type}", get(statement))
}

fn query_required<'a>(query: &'a Params, key: &str) -> std::result::Result<&'a str, ApiError> {
    query
        .get(key)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, format!("Missing {key} parameter")))
}

pub fn source_policy(code: &str) -> Value {
    let (market, provider, verifier, transport) = if is_cn(code) {
        ("a_share", Some("eastmoney"), Some("cninfo"), None)
    } else if regex::Regex::new(r"^\d{5}\.HK$").unwrap().is_match(code) {
        ("h_share", Some("eastmoney"), Some("hkex"), None)
    } else if code.ends_with(".US") {
        (
            "us_share",
            Some("yahoo"),
            Some("sec"),
            Some("local_proxy_or_production_direct"),
        )
    } else {
        ("unsupported", None, None, None)
    };
    json!({"market":market,"primaryProvider":provider,"statutoryVerifier":verifier,"automaticFallback":false,"usTransport":transport})
}

pub async fn read_model(state: &AppState, raw_code: &str, statement_type: &str) -> Result<Value> {
    let code = codes::normalize(raw_code);
    match providers::load(state, &code, statement_type).await {
        Ok((source, rows)) => {
            let fresh = source != "r2"
                || crate::cache_policy::financial_fresh(&rows, Utc::now().timestamp_millis());
            Ok(build_read_model(
                &code,
                statement_type,
                &source,
                &rows,
                fresh,
            ))
        }
        Err(error) => Ok(failed_read_model(&code, statement_type, &error.to_string())),
    }
}

fn unique_strings<'a>(values: impl Iterator<Item = &'a Value>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.to_string()))
        .map(str::to_string)
        .collect()
}
fn coalesce<'a>(left: &'a Value, right: &'a Value) -> &'a Value {
    if left.is_null() { right } else { left }
}
pub fn build_read_model(
    code: &str,
    statement_type: &str,
    source: &str,
    rows: &[Value],
    fresh: bool,
) -> Value {
    let mut dates = rows
        .iter()
        .filter_map(|row| row["reportDate"].as_str())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    dates.sort_unstable_by(|a, b| b.cmp(a));
    dates.dedup();
    let latest = dates.first().copied();
    let currencies = unique_strings(rows.iter().map(|r| {
        coalesce(
            &r["payload"]["REPORTING_CURRENCY"],
            &r["payload"]["CURRENCY"],
        )
    }));
    let standards = unique_strings(rows.iter().map(|r| {
        coalesce(
            &r["payload"]["REPORTING_ACCOUNT_STANDARD"],
            &r["payload"]["ACCOUNT_STANDARD"],
        )
    }));
    let revisions = unique_strings(
        rows.iter()
            .map(|r| coalesce(&r["payload"]["REVISION"], &r["payload"]["REVISION_STATUS"])),
    )
    .into_iter()
    .map(|s| s.to_lowercase())
    .collect::<Vec<_>>();
    let origins = unique_strings(rows.iter().map(|r| &r["source"]));
    let updated = rows
        .iter()
        .filter_map(|r| number(&r["updatedAt"]))
        .reduce(f64::max);
    let delivery = if rows.is_empty() {
        Value::Null
    } else {
        json!({"cache":if source=="r2"{"r2"}else{"provider"},"originProviders":origins,"updatedAt":updated,"freshness":if fresh{"fresh"}else{"stale"}})
    };
    let periods = rows.iter().map(|r|json!({"reportDate":r["reportDate"],"fiscalPeriod":if r["fiscalPeriod"].is_null(){r["payload"]["FISCAL_PERIOD"].as_str().map(str::trim).filter(|s|!s.is_empty()).map(|s|json!(s)).unwrap_or(Value::Null)}else{r["fiscalPeriod"].clone()}})).collect::<Vec<_>>();
    let health = if rows.is_empty() {
        json!({"status":"degraded","reason":"no_primary_data","message":"primary financial provider returned no statement rows"})
    } else {
        json!({"status":"healthy","reason":null,"message":null})
    };
    let warnings = if statement_type == "income" && is_cn(code) {
        income_warnings(rows)
    } else {
        vec![]
    };
    json!({"code":code,"statementType":statement_type,"sourcePolicy":source_policy(code),"delivery":delivery,
        "reportingCurrencies":currencies,"accountingStandards":standards,"periods":periods,"latestReportDate":latest,"dataAsOf":latest,
        "revisionStatuses":if revisions.is_empty(){vec!["not_supplied".to_string()]}else{revisions},
        "fieldAvailability":{"rows":rows.len(),"nonEmptyPayloadRows":rows.iter().filter(|r|r["payload"].as_object().is_some_and(|v|!v.is_empty())).count(),"status":if rows.is_empty(){"unavailable"}else{"available"}},
        "sourceHealth":health,"warnings":warnings,"rows":rows,"normalizedRows":series::normalized_rows(rows)})
}

fn income_warnings(rows: &[Value]) -> Vec<Value> {
    let has = |contract: &str| {
        rows.iter()
            .any(|r| r["payload"]["FINANCIAL_SOURCE_CONTRACT"].as_str() == Some(contract))
    };
    let cumulative = has("eastmoney_f10_income.v1");
    let annual = has("eastmoney_f10_annual_income.v1");
    let families = json!({"cumulative":cumulative,"annual":annual,"quarterized":has("eastmoney_f10_incomeqc.v1")});
    let mut warnings = vec![];
    if !rows.is_empty() && !cumulative && !annual {
        warnings.push(json!({"code":"missing_cumulative_income_family","message":"A股利润表只有单季度家族（*INCOMEQC），缺少累计家族（*INCOME）；TTM 与 PE(TTM) 不可用，需刷新快照。","families":families}));
    }
    if !rows.is_empty() && !annual {
        warnings.push(json!({"code":"missing_annual_income_statement","message":"A股利润表没有年报（12M）行；TTM 基期缺失，不得用四季度冒充全年。","families":families}));
    }
    warnings
}

pub fn failed_read_model(code: &str, statement_type: &str, message: &str) -> Value {
    let lower = message.to_lowercase();
    let reason = if ["only supports", "requires an .hk", "unsupported"]
        .iter()
        .any(|s| lower.contains(s))
    {
        "unsupported_security"
    } else if lower.contains("http_proxy_url is required") {
        "missing_proxy_configuration"
    } else if ["status=429", "rate limit", "too many requests"]
        .iter()
        .any(|s| lower.contains(s))
    {
        "provider_rate_limited"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "provider_timeout"
    } else if ["invalid json", "jsonp", "unexpected token"]
        .iter()
        .any(|s| lower.contains(s))
    {
        "invalid_provider_response"
    } else if [
        "request failed: status=",
        "yahoo finance error",
        "provider rejected request",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        "provider_response_error"
    } else {
        "unexpected_error"
    };
    json!({"code":code,"statementType":statement_type,"sourcePolicy":source_policy(code),"delivery":null,"reportingCurrencies":[],"accountingStandards":[],"periods":[],"latestReportDate":null,"dataAsOf":null,"revisionStatuses":[],"fieldAvailability":{"rows":0,"nonEmptyPayloadRows":0,"status":"unavailable"},"sourceHealth":{"status":"failed","reason":reason,"message":message},"warnings":[],"rows":[],"normalizedRows":[]})
}

async fn statement(
    State(state): State<AppState>,
    Path(kind): Path<String>,
    Query(query): Query<Params>,
) -> ApiResult {
    if !["income", "balance", "cashflow"].contains(&kind.as_str()) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "unsupported finance statement type".into(),
        ));
    }
    let model = read_model(&state, query_required(&query, "code")?, &kind).await?;
    if query.get("format").map(String::as_str) == Some("read-model") {
        return Ok(ok(model));
    }
    let mappings = state.config("shared/finance-mappings.json")?;
    Ok(ok(json!(
        model["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| legacy_payload(&row["payload"], &kind, &mappings))
            .collect::<Vec<_>>()
    )))
}
async fn quarterly(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = codes::normalize(query_required(&query, "code")?);
    let limit = query
        .get("limit")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(1.0, 40.0) as usize)
        .unwrap_or(8);
    let model = read_model(&state, &code, "income").await?;
    Ok(ok(series::quarterly_series(
        &code,
        model["rows"].as_array().map(Vec::as_slice).unwrap_or(&[]),
        limit,
    )))
}
async fn inputs(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(valuation_inputs(
        &state,
        query_required(&query, "code")?,
    )
    .await?))
}
async fn bands(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(valuation_bands_with_market_cap(
        &state,
        query_required(&query, "code")?,
        query
            .get("marketCap")
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite()),
    )
    .await?))
}
async fn midcycle(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(valuation::mid_cycle_history_with_years(
        &state,
        query_required(&query, "code")?,
        query
            .get("years")
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite()),
    )
    .await?))
}
async fn sharechange(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(json!(
        share_changes(&state, query_required(&query, "code")?).await?
    )))
}
async fn sharebonus(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(json!(
        share_bonuses(&state, query_required(&query, "code")?).await?
    )))
}
async fn shareadditional(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(json!(
        share_additional(&state, query_required(&query, "code")?).await?
    )))
}
async fn freeholders(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(json!(
        free_holders(&state, query_required(&query, "code")?).await?
    )))
}
async fn orgholders(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = query_required(&query, "code")?;
    let date = query_required(&query, "reportDate")?;
    if !regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$")
        .unwrap()
        .is_match(date)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid reportDate parameter".into(),
        ));
    }
    Ok(ok(json!(org_holders(&state, code, date).await?)))
}
async fn restriction(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = codes::normalize(query_required(&query, "code")?);
    let rows = data_rows(&state, DATA_ENDPOINT, "RPTA_APP_LIFTFUTURE", "SECUCODE,SECURITY_CODE,LIFT_DATE,LIFT_NUM,TOTAL_SHARES_RATIO,UNLIMITED_A_SHARES_RATIO,LIFT_TYPE", &format!("(SECUCODE=\"{code}\")"), ["200", "1", "LIFT_DATE"]).await?;
    Ok(ok(json!({"result":{"data":rows}})))
}
async fn dividendyield(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(
        dividend_yield(&state, query_required(&query, "code")?).await?
    ))
}

pub fn legacy_payload(payload: &Value, kind: &str, mappings: &Value) -> Value {
    let Some(raw) = payload.as_object() else {
        return payload.clone();
    };
    let mut mapped = raw.clone();
    mapped.insert(
        "reportDate".into(),
        json!(trim_date(&payload["REPORT_DATE"])),
    );
    mapped.insert(
        "noticeDate".into(),
        json!(trim_date(&payload["NOTICE_DATE"])),
    );
    let keys = match kind {
        "income" => "incomeKeys",
        "balance" => "balanceKeys",
        _ => "cashflowKeys",
    };
    let ignored = mappings["ignoreKeys"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for (key, value) in raw {
        if ignored.iter().any(|v| v.as_str() == Some(key))
            || key.ends_with("_YOY")
            || key.ends_with("_QOQ")
            || !value.is_number()
        {
            continue;
        }
        let name = mappings[keys]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row.as_array().is_some_and(|a| a.len() > 2) && row[2].as_str() == Some(key))
            .and_then(|r| r[0].as_str())
            .unwrap_or(key);
        mapped.insert(name.into(), value.clone());
    }
    if kind == "income"
        && let (Some(income), Some(cost)) = (
            mapped.get("operateIncome").and_then(Value::as_f64),
            mapped.get("operateCost").and_then(Value::as_f64),
        )
    {
        mapped.insert("grossProfit".into(), json!(income - cost));
    }
    Value::Object(mapped)
}

async fn data_rows(
    state: &AppState,
    endpoint: &str,
    report: &str,
    columns: &str,
    filter: &str,
    paging_and_sort: [&str; 3],
) -> Result<Vec<Value>> {
    let [page_size, sort_types, sort_columns] = paging_and_sort;
    let parameters = [
        ("reportName", report),
        ("columns", columns),
        ("quoteColumns", ""),
        ("filter", filter),
        ("pageNumber", "1"),
        ("pageSize", page_size),
        ("sortTypes", sort_types),
        ("sortColumns", sort_columns),
        ("source", "HSF10"),
        ("client", "PC"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.to_string()))
    .collect::<Vec<_>>();
    crate::eastmoney::data_rows(state, endpoint, &parameters, 86_400_000).await
}

pub async fn share_changes(state: &AppState, raw_code: &str) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    let rows = securities_data::finance::dividends::share_changes(state, &code).await?;
    if rows.is_empty() {
        let overview = crate::company::eastmoney_overview(state, &code).await?;
        let shares = number(&overview["marketCapYi"])
            .zip(number(&overview["latestPrice"]))
            .filter(|(cap, price)| *cap != 0.0 && *price > 0.0)
            .map(|(cap, price)| cap * 100_000_000.0 / price);
        return Ok(shares
            .map(|total| {
                vec![json!({"changeDate":Utc::now().date_naive().to_string(),"totalShares":total})]
            })
            .unwrap_or_default());
    }
    Ok(rows)
}

pub use securities_data::finance::dividends::dividend_yield_from_rows;

pub async fn share_bonuses(state: &AppState, raw_code: &str) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    let (raw, changes) = tokio::try_join!(
        securities_data::finance::dividends::fetch_share_bonus_rows(state, &code),
        share_changes(state, &code)
    )?;
    Ok(securities_data::finance::dividends::share_bonuses_from_rows(&raw, &changes))
}

// Historical price-series acquisition remains an application concern, not a
// dependency of the reusable dividend/history library.
pub async fn dividend_yield(state: &AppState, raw_code: &str) -> Result<Value> {
    let code = codes::normalize(raw_code);
    if !is_cn(&code) {
        return securities_data::finance::dividends::dividend_yield(state, &code, &[]).await;
    }
    let today = Utc::now().date_naive().to_string();
    let (raw, bars) = tokio::try_join!(
        securities_data::finance::dividends::fetch_history(state, &code),
        crate::market::load_kline(state, &code, "normal", "1990-01-01", &today)
    )?;
    Ok(dividend_yield_from_rows(&raw, &bars))
}

async fn free_holders(state: &AppState, code: &str) -> Result<Vec<Value>> {
    data_rows(state, DATA_ENDPOINT, "RPT_F10_EH_FREEHOLDERS", "SECUCODE,SECURITY_CODE,END_DATE,HOLDER_RANK,HOLDER_NAME,HOLDER_TYPE,SHARES_TYPE,HOLD_NUM,FREE_HOLDNUM_RATIO,HOLD_NUM_CHANGE,CHANGE_RATIO", &format!("(SECUCODE=\"{}\")(END_DATE in ('{}'))",codes::normalize(code),report_dates(2).join("','")), ["", "-1,1", "END_DATE,HOLDER_RANK"]).await
}
async fn org_holders(state: &AppState, code: &str, report_date: &str) -> Result<Vec<Value>> {
    data_rows(state, DATA_ENDPOINT, "RPT_MAIN_ORGHOLDDETAIL", "ORG_TYPE,SECUCODE,REPORT_DATE,HOLDER_CODE,HOLDER_NAME,TOTAL_SHARES,HOLD_VALUE,TOTALSHARES_RATIO,FREESHARES_RATIO,FREE_MARKET_CAP,FREE_SHARES,SECURITY_CODE,FUND_CODE,FUND_DERIVECODE,NETVALUE_RATIO", &format!("(SECUCODE=\"{}\")(ORG_TYPE=\"01\")(REPORT_DATE='{report_date}')",codes::normalize(code)), ["500", "-1", "TOTAL_SHARES"]).await
}

pub(crate) fn report_dates(years: i32) -> Vec<String> {
    let now = Utc::now().with_timezone(&chrono_tz::Asia::Shanghai);
    let mut dates = vec![];
    for offset in 0..years {
        let year = now.year() - offset;
        if offset > 0 {
            dates.push(format!("{year}-12-31"));
        }
        for (month, date) in [(9, "09-30"), (6, "06-30"), (3, "03-31")] {
            if offset != 0 || now.month() > month {
                dates.push(format!("{year}-{date}"));
            }
        }
    }
    dates
}
fn trim_date(value: &Value) -> String {
    value.as_str().unwrap_or("").chars().take(10).collect()
}
fn is_cn(code: &str) -> bool {
    [".SH", ".SZ", ".BJ"]
        .iter()
        .any(|suffix| code.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_model_preserves_source_metadata_and_exposes_missing_families() {
        let rows = vec![
            json!({"code":"600036.SH","statementType":"income","reportDate":"2026-09-30","fiscalPeriod":"3M","source":"eastmoney","updatedAt":123,"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_incomeqc.v1","REPORTING_CURRENCY":"CNY","REPORTING_ACCOUNT_STANDARD":"CAS","TOTAL_OPERATE_INCOME":100}}),
        ];
        let model = build_read_model("600036.SH", "income", "r2", &rows, true);
        assert_eq!(model["sourcePolicy"]["primaryProvider"], "eastmoney");
        assert_eq!(model["sourcePolicy"]["automaticFallback"], false);
        assert_eq!(model["warnings"].as_array().unwrap().len(), 2);
        assert_eq!(model["delivery"]["cache"], "r2");
        assert_eq!(model["latestReportDate"], "2026-09-30");
        assert_eq!(
            model["normalizedRows"][0]["values"][0]["value"].as_f64(),
            Some(100.0)
        );
        assert_eq!(
            failed_read_model("NVDA.US", "income", "HTTP_PROXY_URL is required")["sourceHealth"]["reason"],
            "missing_proxy_configuration"
        );
    }
    #[test]
    fn legacy_keys_and_gross_profit_are_source_preserving() {
        let mappings = json!({"ignoreKeys":["IGNORE"],"incomeKeys":[["operateIncome","","OPERATE_INCOME"],["operateCost","","OPERATE_COST"]]});
        let row = legacy_payload(
            &json!({"OPERATE_INCOME":100,"OPERATE_COST":60,"REPORT_DATE":"2026-09-30 00:00:00","NOTICE_DATE":"2026-10-25","IGNORE":4,"OTHER":"10"}),
            "income",
            &mappings,
        );
        assert_eq!(row["grossProfit"], 40.0);
        assert_eq!(row["OPERATE_INCOME"], 100);
        assert_eq!(row["reportDate"], "2026-09-30");
        assert!(row.get("OTHER").is_some());
    }
    #[test]
    fn dividend_series_uses_announcement_date_and_latest_four_reporting_quarters() {
        let raw = vec![
            json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-03-01","EX_DIVIDEND_DATE":"2026-04-01","IMPL_PLAN_PROFILE":"10派2元"}),
            json!({"REPORT_TIME":"2026-03-31","NOTICE_DATE":"2026-05-01","IMPL_PLAN_PROFILE":"10派1元"}),
        ];
        let bars = vec![
            json!({"date":"2026-02-28","close":10}),
            json!({"date":"2026-03-01","close":10}),
            json!({"date":"2026-05-01","close":10}),
        ];
        let data = dividend_yield_from_rows(&raw, &bars);
        assert_eq!(data["series"].as_array().unwrap().len(), 2);
        assert!((data["annualizedCashPerShare"].as_f64().unwrap() - 0.3).abs() < 1e-12);
        assert!((data["currentYield"].as_f64().unwrap() - 3.0).abs() < 1e-12);
    }
}
