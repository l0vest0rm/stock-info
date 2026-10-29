//! Local U.S. option-chain API. Nasdaq remains the active provider, matching
//! the existing Node implementation; the unused Yahoo helper is not a fallback.
use crate::{ApiError, ApiResult, AppState, cache_policy, codes, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    routing::get,
};
use chrono::NaiveDate;
use regex::Regex;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

const NAMESPACE: &str = "us_option_chain";
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-?\d+(?:\.\d+)?").unwrap());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptionContract {
    pub symbol: String,
    pub r#type: String,
    pub expiration: String,
    pub strike: f64,
    pub last: f64,
    pub bid: f64,
    pub ask: f64,
    pub price: f64,
    pub volume: i64,
    pub open_interest: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Expiration {
    pub date: String,
    pub calls: Vec<OptionContract>,
    pub puts: Vec<OptionContract>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpirationSummary {
    pub date: String,
    pub strike_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub code: String,
    pub symbol: String,
    pub current_price: f64,
    pub updated_at: i64,
    pub expirations: Vec<ExpirationSummary>,
    pub strikes: Vec<f64>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/options/us/summary", get(summary_route))
        .route("/options/us/contracts", get(contracts_route))
}

fn require_code(query: &HashMap<String, String>) -> Result<&str, ApiError> {
    let code = query
        .get("code")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "Missing code parameter".into()))?;
    if !code.to_uppercase().ends_with(".US") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "US options only supports .US code".into(),
        ));
    }
    Ok(code)
}

async fn summary_route(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let code = require_code(&query)?;
    let summary = fetch_summary(&state, code).await.map_err(upstream_error)?;
    Ok(ok(
        serde_json::to_value(summary).map_err(anyhow::Error::from)?
    ))
}

async fn contracts_route(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let code = require_code(&query)?;
    let selected_expirations: HashSet<&str> = query
        .get("expirations")
        .map(String::as_str)
        .unwrap_or("")
        .split('|')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let selected_strikes: Vec<f64> = query
        .get("strikes")
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .filter_map(query_number)
        .filter(|n| n.is_finite() && *n > 0.0)
        .collect();
    let summary = fetch_summary(&state, code).await.map_err(upstream_error)?;
    let mut expirations = Vec::new();
    for item in &summary.expirations {
        if !selected_expirations.is_empty() && !selected_expirations.contains(item.date.as_str()) {
            continue;
        }
        let mut expiration = fetch_expiration(&state, code, &item.date)
            .await
            .map_err(upstream_error)?;
        if !selected_strikes.is_empty() {
            expiration
                .calls
                .retain(|contract| selected_strikes.contains(&contract.strike));
            expiration
                .puts
                .retain(|contract| selected_strikes.contains(&contract.strike));
        }
        expirations.push(expiration);
    }
    Ok(ok(
        json!({"code":summary.code,"symbol":summary.symbol,"currentPrice":summary.current_price,"updatedAt":summary.updated_at,"expirations":expirations}),
    ))
}

fn upstream_error(error: anyhow::Error) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, error.to_string())
}

fn query_number(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            if digits.is_empty() {
                return None;
            }
            return digits.chars().try_fold(0.0, |number, digit| {
                Some(number * f64::from(radix) + f64::from(digit.to_digit(radix)?))
            });
        }
    }
    value.parse().ok()
}

pub async fn fetch_summary(state: &AppState, raw_code: &str) -> Result<Summary> {
    let code = codes::normalize(raw_code);
    let symbol = code.strip_suffix(".US").unwrap_or(&code).to_string();
    if !code.ends_with(".US") || symbol.is_empty() {
        return Ok(Summary {
            code,
            symbol,
            current_price: 0.0,
            updated_at: chrono::Utc::now().timestamp_millis(),
            expirations: Vec::new(),
            strikes: Vec::new(),
        });
    }
    let prefix = format!("us.options.chain.v2.{code}");
    if let Some(cached) = state
        .db
        .get_kv(NAMESPACE, &format!("{prefix}.summary"))
        .await?
    {
        return Ok(serde_json::from_value(cached)?);
    }
    let mut last_error = None;
    for asset in ["stocks", "etf"] {
        match summary_for_asset(state, &code, &symbol, &prefix, asset).await {
            Ok(summary) => return Ok(summary),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("nasdaq option summary empty for {code}")))
}

async fn summary_for_asset(
    state: &AppState,
    code: &str,
    symbol: &str,
    prefix: &str,
    asset: &str,
) -> Result<Summary> {
    let first = fetch_range(state, code, symbol, asset, "", "").await?;
    let mut ranges = date_ranges(&first);
    if ranges.is_empty() {
        ranges.push((String::new(), String::new()));
    }
    let updated_at = chrono::Utc::now().timestamp_millis();
    let mut expirations: Vec<Expiration> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut strikes = Vec::new();
    for (from, to) in ranges {
        let page = if !from.is_empty() && !to.is_empty() {
            fetch_range(state, code, symbol, asset, &from, &to).await?
        } else {
            first.clone()
        };
        for expiration in normalize_chain(code, symbol, &page)? {
            state
                .db
                .put_kv(
                    NAMESPACE,
                    &format!("{prefix}.expiration.{}", expiration.date),
                    &serde_json::to_value(&expiration)?,
                    Some(updated_at + cache_policy::market_ttl(code, updated_at)),
                )
                .await?;
            for contract in expiration.calls.iter().chain(&expiration.puts) {
                strikes.push(contract.strike);
            }
            if let Some(index) = positions.get(&expiration.date) {
                expirations[*index] = expiration;
            } else {
                positions.insert(expiration.date.clone(), expirations.len());
                expirations.push(expiration);
            }
        }
    }
    expirations.sort_by(
        |a, b| match (expiration_date(&a.date), expiration_date(&b.date)) {
            (Some(a), Some(b)) => a.cmp(&b),
            _ => std::cmp::Ordering::Equal,
        },
    );
    strikes.sort_by(f64::total_cmp);
    strikes.dedup();
    let summary = Summary {
        code: code.into(),
        symbol: symbol.into(),
        current_price: parse_number(&first["data"]["lastTrade"]),
        updated_at,
        expirations: expirations
            .iter()
            .map(|expiration| {
                let mut strikes = expiration
                    .calls
                    .iter()
                    .chain(&expiration.puts)
                    .map(|contract| contract.strike)
                    .collect::<Vec<_>>();
                strikes.sort_by(f64::total_cmp);
                strikes.dedup();
                ExpirationSummary {
                    date: expiration.date.clone(),
                    strike_count: strikes.len(),
                }
            })
            .collect(),
        strikes,
    };
    state
        .db
        .put_kv(
            NAMESPACE,
            &format!("{prefix}.summary"),
            &serde_json::to_value(&summary)?,
            Some(updated_at + cache_policy::market_ttl(code, updated_at)),
        )
        .await?;
    Ok(summary)
}

pub async fn fetch_expiration(state: &AppState, raw_code: &str, date: &str) -> Result<Expiration> {
    let code = codes::normalize(raw_code);
    let key = format!("us.options.chain.v2.{code}.expiration.{date}");
    if let Some(cached) = state.db.get_kv(NAMESPACE, &key).await? {
        return Ok(serde_json::from_value(cached)?);
    }
    let summary = fetch_summary(state, &code).await?;
    if let Some(cached) = state.db.get_kv(NAMESPACE, &key).await? {
        return Ok(serde_json::from_value(cached)?);
    }
    bail!(
        "option expiration not found for {code}: {date} ({} expirations cached)",
        summary.expirations.len()
    )
}

async fn fetch_range(
    state: &AppState,
    code: &str,
    symbol: &str,
    asset: &str,
    from: &str,
    to: &str,
) -> Result<Value> {
    let mut merged = Value::Null;
    let limit = 10_000_usize;
    let mut offset = 0;
    loop {
        let mut url = Url::parse("https://api.nasdaq.com")?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid Nasdaq base URL"))?
            .extend(["api", "quote", symbol, "option-chain"]);
        url.query_pairs_mut().extend_pairs([
            ("assetclass", asset),
            ("limit", &limit.to_string()),
            ("offset", &offset.to_string()),
            ("money", "all"),
        ]);
        if !from.is_empty() && !to.is_empty() {
            url.query_pairs_mut()
                .extend_pairs([("fromdate", from), ("todate", to)]);
        }
        let page = state
            .http
            .cached_json(
                &state.db,
                url.as_str(),
                nasdaq_headers(asset, symbol)?,
                cache_policy::market_ttl(code, chrono::Utc::now().timestamp_millis()),
                false,
            )
            .await?;
        let data = page
            .get("data")
            .filter(|data| !data.is_null())
            .with_context(|| format!("nasdaq option chain empty for {code} assetClass={asset}"))?;
        let rows = data["table"]["rows"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if merged.is_null() {
            merged = json!({"totalRecord":data.get("totalRecord").cloned().unwrap_or_else(||json!(rows.len())),"lastTrade":data.get("lastTrade").cloned().unwrap_or_else(||json!("")),"filterlist":data["filterlist"],"table":{"rows":[]}});
        }
        let merged_rows = merged["table"]["rows"]
            .as_array_mut()
            .context("invalid merged Nasdaq rows")?;
        merged_rows.extend(rows.iter().cloned());
        let total = data["totalRecord"]
            .as_u64()
            .unwrap_or(merged_rows.len() as u64);
        if rows.is_empty() || merged_rows.len() as u64 >= total || rows.len() < limit {
            break;
        }
        offset += limit;
    }
    Ok(json!({"data":merged}))
}

fn nasdaq_headers(asset: &str, symbol: &str) -> Result<HeaderMap> {
    let mut result = HeaderMap::new();
    let referer = format!(
        "https://www.nasdaq.com/market-activity/{asset}/{}/option-chain",
        symbol.to_lowercase()
    );
    for (name, value) in [
        ("accept", "application/json, text/plain, */*"),
        ("accept-language", "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"),
        ("origin", "https://www.nasdaq.com"),
        ("referer", referer.as_str()),
        (
            "sec-ch-ua",
            "\"Google Chrome\";v=\"144\", \"Chromium\";v=\"144\", \"Not:A-Brand\";v=\"24\"",
        ),
        ("sec-ch-ua-mobile", "?0"),
        ("sec-ch-ua-platform", "\"macOS\""),
        ("sec-fetch-dest", "empty"),
        ("sec-fetch-mode", "cors"),
        ("sec-fetch-site", "same-site"),
        (
            "user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        ),
    ] {
        result.insert(
            HeaderName::from_bytes(name.as_bytes())?,
            HeaderValue::from_str(value)?,
        );
    }
    Ok(result)
}

fn date_ranges(parsed: &Value) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for item in parsed["data"]["filterlist"]["fromdate"]["filter"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let value = item["value"].as_str().unwrap_or("").trim();
        if value.is_empty() || value.eq_ignore_ascii_case("all") {
            continue;
        }
        let mut parts = value.split('|').map(str::trim);
        let from = parts.next().unwrap_or("");
        let to = parts.next().unwrap_or("");
        if !from.is_empty() && !to.is_empty() && seen.insert(format!("{from}|{to}")) {
            result.push((from.into(), to.into()));
        }
    }
    result
}

fn expiration_date(date: &str) -> Option<NaiveDate> {
    ["%B %e, %Y", "%b %e, %Y", "%Y-%m-%d"]
        .iter()
        .find_map(|format| NaiveDate::parse_from_str(date, format).ok())
}

fn parse_number(value: &Value) -> f64 {
    let raw = match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => value.to_string(),
    }
    .replace(',', "");
    NUMBER
        .find(raw.trim())
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

fn option_symbol(symbol: &str, kind: &str, url: &Value) -> String {
    let raw = url
        .as_str()
        .unwrap_or("")
        .trim()
        .split('/')
        .rfind(|p| !p.is_empty())
        .unwrap_or("");
    if raw.is_empty() {
        return format!("{}-{kind}", symbol.to_lowercase());
    }
    if kind == "put"
        && let Some(index) = raw.rfind('c')
    {
        return format!("{}p{}", &raw[..index], &raw[index + 1..]);
    }
    raw.to_string()
}

fn contract(
    symbol: &str,
    expiration: &str,
    kind: &str,
    strike: f64,
    row: &Value,
) -> OptionContract {
    let prefix = if kind == "call" { "c" } else { "p" };
    let last = parse_number(&row[format!("{prefix}_Last")]);
    let bid = parse_number(&row[format!("{prefix}_Bid")]);
    let ask = parse_number(&row[format!("{prefix}_Ask")]);
    OptionContract {
        symbol: option_symbol(symbol, kind, &row["drillDownURL"]),
        r#type: kind.into(),
        expiration: expiration.into(),
        strike,
        last,
        bid,
        ask,
        price: if bid > 0.0 && ask > 0.0 {
            (bid + ask) / 2.0
        } else if bid != 0.0 {
            bid
        } else if ask != 0.0 {
            ask
        } else {
            last
        },
        volume: parse_number(&row[format!("{prefix}_Volume")]).trunc() as i64,
        open_interest: parse_number(&row[format!("{prefix}_Openinterest")]).trunc() as i64,
    }
}

fn normalize_chain(code: &str, symbol: &str, parsed: &Value) -> Result<Vec<Expiration>> {
    let data = parsed
        .get("data")
        .filter(|v| !v.is_null())
        .with_context(|| format!("nasdaq option chain empty for {code}"))?;
    let mut expirations: Vec<Expiration> = Vec::new();
    let mut positions = HashMap::new();
    let mut current = String::new();
    for row in data["table"]["rows"].as_array().into_iter().flatten() {
        let group = row["expirygroup"].as_str().unwrap_or("").trim();
        if !group.is_empty() {
            current = group.into();
            if !positions.contains_key(&current) {
                positions.insert(current.clone(), expirations.len());
                expirations.push(Expiration {
                    date: current.clone(),
                    calls: Vec::new(),
                    puts: Vec::new(),
                });
            }
            continue;
        }
        let strike = parse_number(&row["strike"]);
        if current.is_empty() || strike <= 0.0 {
            continue;
        }
        let index = *positions
            .get(&current)
            .context("missing current Nasdaq expiration")?;
        let call = contract(symbol, &current, "call", strike, row);
        let put = contract(symbol, &current, "put", strike, row);
        if call.price > 0.0 || call.last > 0.0 || call.bid > 0.0 || call.ask > 0.0 {
            expirations[index].calls.push(call);
        }
        if put.price > 0.0 || put.last > 0.0 || put.bid > 0.0 || put.ask > 0.0 {
            expirations[index].puts.push(put);
        }
    }
    Ok(expirations)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_matches_owning_typescript_golden_fixture() {
        // Generated by running only the owning TypeScript parser functions in
        // an isolated VM. No provider, credential or runtime fallback involved.
        let golden: Value =
            serde_json::from_str(include_str!("../tests/options_fixtures/nasdaq-golden.json"))
                .unwrap();
        let parsed = normalize_chain("AAPL.US", "AAPL", &golden["fixture"]).unwrap();
        let expected: Vec<Expiration> =
            serde_json::from_value(golden["expected"]["expirations"].clone()).unwrap();
        assert_eq!(parsed, expected);
        assert_eq!(
            parse_number(&golden["fixture"]["data"]["lastTrade"]),
            golden["expected"]["currentPrice"].as_f64().unwrap()
        );
        let ranges: Vec<Value> = date_ranges(&golden["fixture"])
            .into_iter()
            .map(|(from, to)| json!({"fromDate":from,"toDate":to}))
            .collect();
        assert_eq!(json!(ranges), golden["ranges"]);
    }
    #[test]
    fn nasdaq_normalization_preserves_contracts_groups_and_price_basis() {
        let parsed = json!({"data":{"table":{"rows":[{"strike":"9","c_Last":"100"},{"expirygroup":"November 20, 2026"},{"strike":"$100.00","c_Last":"2.00","c_Bid":"1.00","c_Ask":"3.00","c_Volume":"1,200","c_Openinterest":"50","p_Last":"--","p_Bid":"0","p_Ask":"1","drillDownURL":"/quotes/aapl-c100"},{"strike":"0","c_Last":"10"},{"expirygroup":"December 18, 2026"},{"strike":"110","c_Last":"--","c_Bid":"--","c_Ask":"--","p_Last":"--"}]}}});
        let rows = normalize_chain("AAPL.US", "AAPL", &parsed).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].calls.len(), 1);
        assert_eq!(rows[0].puts.len(), 1);
        assert_eq!(rows[0].calls[0].price, 2.0);
        assert_eq!(rows[0].calls[0].volume, 1200);
        assert_eq!(rows[0].puts[0].symbol, "aapl-p100");
        assert_eq!(rows[0].puts[0].price, 1.0);
        assert!(rows[1].calls.is_empty());
        assert!(normalize_chain("AAPL.US", "AAPL", &json!({"data":null})).is_err());
    }
    #[test]
    fn range_dedup_numeric_and_date_contracts() {
        let parsed = json!({"data":{"filterlist":{"fromdate":{"filter":[{"value":"all"},{"value":" 2026-11-01 | 2026-11-30 "},{"value":"2026-11-01|2026-11-30"},{"value":"invalid"}]}}}});
        assert_eq!(
            date_ranges(&parsed),
            vec![("2026-11-01".into(), "2026-11-30".into())]
        );
        assert_eq!(parse_number(&json!("$1,234.56 at 10am")), 1234.56);
        assert_eq!(parse_number(&json!("--")), 0.0);
        assert_eq!(query_number("0x64"), Some(100.0));
        assert_eq!(query_number("0b1100100"), Some(100.0));
        assert_eq!(query_number("1e2"), Some(100.0));
        assert!(query_number("-0x64").is_none());
        assert_eq!(
            expiration_date("November 20, 2026"),
            NaiveDate::from_ymd_opt(2026, 11, 20)
        );
        let query = HashMap::from([("code".into(), "aapl.us".into())]);
        assert_eq!(require_code(&query).unwrap(), "aapl.us");
        assert!(require_code(&HashMap::from([("code".into(), "600036.SH".into())])).is_err());
    }
}
