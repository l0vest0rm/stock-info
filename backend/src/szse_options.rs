//! Shenzhen (SZSE) ETF option quotes.
//!
//! Shenzhen lists its own ETF option boards (`159915` 创业板ETF, `159919`,
//! `159922`), and its contract codes are **six-digit numbers** (`90007411`)
//! rather than the SSE `510300C2612M01200` form, so the SSE parser in
//! [`crate::options_cn`] cannot read them. This module supplies the missing
//! pieces only: the contract list (strike/type/expiry, from SZSE) and the last
//! quote (from Sina). The valuation math, implied forward and null-on-missing
//! policy are shared with SSE — there is exactly one pricing path.
//!
//! Deliberately **not** used here: Eastmoney, Tencent, Yahoo. Option quotes are
//! market data like any other; adding a new provider is a deliberate choice and
//! this module documents the two it uses.
use crate::cache_policy;
use crate::http::number;
use crate::option_math::OptionKind;
use crate::options_cn::{Quote, expiry_date, years_between};
use crate::{AppState, codes::normalize};
use anyhow::{Context, Result, bail};
use chrono::NaiveDate;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

/// Shenzhen ETF option underlyings. Anything else is rejected rather than
/// silently returning an empty board.
const UNDERLYINGS: [&str; 3] = ["159915", "159919", "159922"];

/// Sina quote batches are small; keeping the batch tight bounds one failure.
const QUOTE_BATCH: usize = 40;

pub fn is_shenzhen_underlying(code: &str) -> bool {
    UNDERLYINGS.contains(&code)
}

pub fn underlyings() -> &'static [&'static str] {
    &UNDERLYINGS
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractRow {
    /// Contract code, e.g. `90007411`.
    hydm: String,
    /// Board (underlying) name as SZSE labels it, e.g. `创业板ETF`.
    bdmc: String,
    /// Type: `认购` (call) or `认沽` (put).
    hylx: String,
    /// Strike as displayed text, e.g. `3.400`.
    xqj: String,
    /// Last trading day, `YYYY-MM-DD`.
    xqrq: String,
}

/// Contract identity from SZSE's listing page. Quotes are separate.
#[derive(Clone, Debug, PartialEq)]
pub struct Contract {
    pub code: String,
    pub kind: OptionKind,
    pub expiry_month: String,
    pub expiry: NaiveDate,
    pub strike: f64,
}

fn contract_kind(raw: &str) -> Option<OptionKind> {
    match raw.trim() {
        "认购" => Some(OptionKind::Call),
        "认沽" => Some(OptionKind::Put),
        _ => None,
    }
}

/// Convert a last trading date to the `YYMM` month key used by the shared
/// valuation code, and cross-check it against the fourth-Wednesday rule so a
/// provider change cannot silently move an expiry.
fn expiry_month(date: NaiveDate) -> Result<String> {
    let month = format!("{:02}{:02}", date.format("%y"), date.format("%m"));
    let expected = expiry_date(&month)
        .with_context(|| format!("Shenzhen expiry {date} is not a fourth Wednesday"))?;
    if expected != date {
        bail!("Shenzhen expiry {date} does not match fourth Wednesday {expected}");
    }
    Ok(month)
}

/// Parse SZSE's `ysplbrb` option listing into typed contracts.
///
/// Any row whose type, strike or expiry cannot be read is a hard error: a
/// silently dropped row would remove a real strike from the board.
pub fn parse_contracts(rows: &Value, board: &str) -> Result<Vec<Contract>> {
    let rows: Vec<ContractRow> = serde_json::from_value(rows.clone())
        .context("Shenzhen option listing rows are unreadable")?;
    let mut contracts = Vec::with_capacity(rows.len());
    for row in rows {
        // The listing filter is a text search, so a renamed board or a changed
        // filter would otherwise mix two underlyings into one chain.
        if row.bdmc.trim() != board {
            bail!(
                "Shenzhen contract {} belongs to board {} not {board}",
                row.hydm,
                row.bdmc
            );
        }
        let code = row.hydm.trim();
        if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
            bail!("unexpected Shenzhen contract code {code}");
        }
        let kind = contract_kind(&row.hylx)
            .with_context(|| format!("Shenzhen contract {code} has unknown type {}", row.hylx))?;
        let strike: f64 = row.xqj.trim().parse().with_context(|| {
            format!("Shenzhen contract {code} has unreadable strike {}", row.xqj)
        })?;
        if !(strike.is_finite() && strike > 0.0) {
            bail!("Shenzhen contract {code} has non-positive strike {strike}");
        }
        let expiry = NaiveDate::parse_from_str(row.xqrq.trim(), "%Y-%m-%d").with_context(|| {
            format!(
                "Shenzhen contract {code} has unreadable expiry {}",
                row.xqrq
            )
        })?;
        contracts.push(Contract {
            code: code.to_string(),
            kind,
            expiry_month: expiry_month(expiry)?,
            expiry,
            strike,
        });
    }
    // A duplicated code would double-count a strike in parity and skew.
    let mut seen = std::collections::HashSet::new();
    for contract in &contracts {
        if !seen.insert(contract.code.as_str()) {
            bail!("duplicate Shenzhen contract {}", contract.code);
        }
    }
    Ok(contracts)
}

/// One parsed Sina quote line.
#[derive(Clone, Debug, PartialEq)]
pub struct SinaQuote {
    pub last: f64,
    pub previous_close: f64,
}

/// Parse Sina's `hq_str_sz<code>="name,open,prevClose,last,..."` payload.
///
/// Missing or suspended contracts come back as an empty string; those are
/// returned as `None` rather than a fake zero price. Numeric fields that are
/// present but unreadable are a hard error.
pub fn parse_sina_quotes(text: &str) -> Result<HashMap<String, Option<SinaQuote>>> {
    let mut quotes = HashMap::new();
    for line in text.lines() {
        let Some((_, rest)) = line.split_once("hq_str_sz") else {
            continue;
        };
        let Some((code, payload)) = rest.split_once('=') else {
            bail!("malformed Sina option quote line");
        };
        let code = code.trim();
        let payload = payload.trim().trim_end_matches(';').trim();
        let payload = payload
            .strip_prefix('"')
            .and_then(|p| p.strip_suffix('"'))
            .with_context(|| format!("Sina option quote {code} is not quoted"))?;
        if payload.is_empty() {
            quotes.insert(code.to_string(), None);
            continue;
        }
        let fields: Vec<&str> = payload.split(',').collect();
        // name, open, previous close, last, ...
        if fields.len() < 4 {
            bail!("Sina option quote {code} has {} fields", fields.len());
        }
        let parse = |index: usize, label: &str| -> Result<f64> {
            fields[index]
                .trim()
                .parse::<f64>()
                .with_context(|| format!("Sina option quote {code} has unreadable {label}"))
        };
        let previous_close = parse(2, "previous close")?;
        let last = parse(3, "last")?;
        if !(previous_close.is_finite() && previous_close >= 0.0) || !last.is_finite() {
            bail!("Sina option quote {code} has non-finite prices");
        }
        quotes.insert(
            code.to_string(),
            Some(SinaQuote {
                last,
                previous_close,
            }),
        );
    }
    if quotes.is_empty() {
        bail!("Sina returned no option quotes");
    }
    Ok(quotes)
}

fn shenzhen_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(REFERER, HeaderValue::from_static("https://www.szse.cn/"));
    headers.insert(
        "user-agent",
        HeaderValue::from_static(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        ),
    );
    headers
}

fn sina_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://finance.sina.com.cn/"),
    );
    headers.insert(
        "user-agent",
        HeaderValue::from_static(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        ),
    );
    headers
}

/// Board name as SZSE labels it, which is what the listing filter matches.
fn board_name(underlying: &str) -> Result<&'static str> {
    match underlying {
        "159915" => Ok("创业板ETF"),
        "159919" => Ok("沪深300ETF"),
        "159922" => Ok("中证500ETF"),
        other => bail!("unsupported Shenzhen option underlying {other}"),
    }
}

async fn fetch_contracts(state: &AppState, underlying: &str) -> Result<Vec<Contract>> {
    let board = board_name(underlying)?;
    let mut rows = Vec::new();
    let mut page = 1_u32;
    loop {
        let mut url = Url::parse("https://www.szse.cn/api/report/ShowReport/data")?;
        url.query_pairs_mut().extend_pairs([
            ("SHOWTYPE", "JSON"),
            ("CATALOGID", "ysplbrb"),
            ("loading", "first"),
            ("TABKEY", "tab1"),
            ("PAGENO", &page.to_string()),
            ("txtQueryKeyAndJC", board),
        ]);
        let now = chrono::Utc::now().timestamp_millis();
        let ttl = cache_policy::market_ttl(&format!("{underlying}.SZ"), now);
        let body = state
            .http
            .cached_json(&state.db, url.as_str(), shenzhen_headers(), ttl, false)
            .await?;
        let Some(report) = body.get(0) else {
            bail!("Shenzhen option listing returned no report");
        };
        if let Some(message) = report.get("error").and_then(Value::as_str) {
            bail!("Shenzhen option listing failed: {message}");
        }
        let Some(page_rows) = report["data"].as_array() else {
            bail!("Shenzhen option listing page {page} has no data");
        };
        let total = number(&report["metadata"]["recordcount"])
            .filter(|n| *n >= 0.0)
            .with_context(|| format!("Shenzhen option listing page {page} has no record count"))?;
        rows.extend(page_rows.iter().cloned());
        // Stop on the reported total rather than on a short page: SZSE caps the
        // page size at 20 regardless of what is requested.
        if rows.len() as f64 >= total || page_rows.is_empty() {
            if rows.len() as f64 != total {
                bail!(
                    "Shenzhen option listing returned {} rows but reported {total}",
                    rows.len()
                );
            }
            break;
        }
        page += 1;
        if page > 200 {
            bail!("Shenzhen option listing pagination did not terminate");
        }
    }
    parse_contracts(&Value::Array(rows), board)
}

async fn fetch_sina_quotes(
    state: &AppState,
    underlying: &str,
    codes_in: &[String],
) -> Result<(HashMap<String, Option<SinaQuote>>, Option<NaiveDate>)> {
    let mut all = HashMap::new();
    let mut quote_day = None;
    let now = chrono::Utc::now().timestamp_millis();
    let ttl = cache_policy::market_ttl(&format!("{underlying}.SZ"), now);
    for batch in codes_in.chunks(QUOTE_BATCH) {
        let list = batch
            .iter()
            .map(|code| format!("sz{code}"))
            .collect::<Vec<_>>()
            .join(",");
        // Built directly: parsing `.../list=` first and then setting a query
        // produces a malformed `list=?sz...` URL that Sina answers with an empty
        // payload, which would look like every contract being suspended.
        let url = Url::parse(&format!("https://hq.sinajs.cn/list={list}"))?;
        // Cached like every other market read, so a burst of page loads does not
        // hammer the provider and one board is priced from one snapshot.
        let fetched = state
            .http
            .cached_bytes(
                &state.db,
                url.as_str(),
                sina_headers(),
                ttl,
                false,
                &format!("sina:options:v1:{list}"),
            )
            .await
            .context("Sina option quote request failed")?;
        // Sina serves GBK; only prices are used, but decoding keeps the payload
        // readable in diagnostics.
        let (text, _, _) = encoding_rs::GBK.decode(&fetched);
        if quote_day.is_none() {
            quote_day = quote_date(&text);
        }
        all.extend(parse_sina_quotes(&text)?);
    }
    Ok((all, quote_day))
}

/// Quote date carried by a Sina payload (`2026-11-06`), when present.
pub fn quote_date(text: &str) -> Option<NaiveDate> {
    for line in text.lines() {
        let Some((_, payload)) = line.split_once('"') else {
            continue;
        };
        let fields: Vec<&str> = payload.trim_end_matches('"').split(',').collect();
        for field in fields.iter().rev() {
            if let Ok(date) = NaiveDate::parse_from_str(field.trim(), "%Y-%m-%d") {
                return Some(date);
            }
        }
    }
    None
}

/// Fetch a Shenzhen board as the same [`Quote`] type the SSE route analyses.
pub async fn fetch_chain(state: &AppState, underlying: &str) -> Result<Vec<Quote>> {
    if !is_shenzhen_underlying(underlying) {
        bail!("unsupported Shenzhen option underlying {underlying}");
    }
    let contracts = fetch_contracts(state, underlying).await?;
    if contracts.is_empty() {
        bail!("Shenzhen reported no listed contracts for {underlying}");
    }
    let codes: Vec<String> = contracts.iter().map(|c| c.code.clone()).collect();
    let (quotes, quote_date) = fetch_sina_quotes(state, underlying, &codes).await?;
    let mut out = Vec::with_capacity(contracts.len());
    for contract in &contracts {
        let quote = quotes
            .get(&contract.code)
            .with_context(|| format!("Sina did not return {}", contract.code))?;
        // A suspended contract has no usable quote: keep the strike visible with
        // null pricing rather than dropping it from the board.
        let (last, previous) = match quote {
            Some(q) => (q.last.max(0.0), q.previous_close.max(0.0)),
            None => (0.0, 0.0),
        };
        out.push(Quote {
            contract_id: contract.code.clone(),
            kind: contract.kind,
            expiry_month: contract.expiry_month.clone(),
            strike: contract.strike,
            adjusted: false,
            quote_date,
            last,
            previous_settlement: previous,
            change_rate: if previous > 0.0 && last > 0.0 {
                Some(last / previous - 1.0)
            } else {
                None
            },
        });
    }
    Ok(out)
}

/// Calendar years to expiry, exposed for callers that only have a month key.
pub fn years_to(as_of: NaiveDate, month: &str) -> Option<f64> {
    expiry_date(month).map(|expiry| years_between(as_of, expiry))
}

/// Normalised exchange-qualified symbol for a Shenzhen underlying.
pub fn symbol(underlying: &str) -> String {
    normalize(&format!("{underlying}.SZ"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contract_listing_is_typed_and_kept_strict() {
        let rows = json!([
            {"hydm":"90007411","hymc":"创业板ETF购12月3400","bdmc":"创业板ETF","hylx":"认购","xqj":"3.400","hydw":"10000","xqrq":"2026-12-23","jsrq":"2026-12-24"},
            {"hydm":"90007511","hymc":"创业板ETF沽12月3400","bdmc":"创业板ETF","hylx":"认沽","xqj":"3.400","hydw":"10000","xqrq":"2026-12-23","jsrq":"2026-12-24"}
        ]);
        let contracts = parse_contracts(&rows, "创业板ETF").unwrap();
        assert_eq!(contracts.len(), 2);
        assert_eq!(contracts[0].kind, OptionKind::Call);
        assert_eq!(contracts[1].kind, OptionKind::Put);
        assert!((contracts[0].strike - 3.4).abs() < 1e-12);
        assert_eq!(contracts[0].expiry_month, "2612");
        assert_eq!(
            contracts[0].expiry.format("%Y-%m-%d").to_string(),
            "2026-12-23"
        );
        // A row from another board must fail rather than join this chain.
        let foreign = json!([
            {"hydm":"90007411","hymc":"x","bdmc":"深证100ETF","hylx":"认购","xqj":"3.4","hydw":"1","xqrq":"2026-12-23","jsrq":"2026-12-24"}
        ]);
        assert!(parse_contracts(&foreign, "创业板ETF").is_err());
        // An expiry that is not a fourth Wednesday must not be silently moved.
        let moved = json!([
            {"hydm":"90007411","hymc":"x","bdmc":"创业板ETF","hylx":"认购","xqj":"3.400","hydw":"10000","xqrq":"2026-12-24","jsrq":"2026-12-25"}
        ]);
        assert!(parse_contracts(&moved, "创业板ETF").is_err());
        // Unknown type, unreadable strike and duplicate codes are hard errors.
        for broken in [
            json!([{"hydm":"90007411","hymc":"x","bdmc":"创业板ETF","hylx":"蝶式","xqj":"3.4","hydw":"1","xqrq":"2026-12-23","jsrq":"2026-12-24"}]),
            json!([{"hydm":"90007411","hymc":"x","bdmc":"创业板ETF","hylx":"认购","xqj":"abc","hydw":"1","xqrq":"2026-12-23","jsrq":"2026-12-24"}]),
            json!([
                {"hydm":"90007411","hymc":"x","bdmc":"创业板ETF","hylx":"认购","xqj":"3.4","hydw":"1","xqrq":"2026-12-23","jsrq":"2026-12-24"},
                {"hydm":"90007411","hymc":"x","bdmc":"创业板ETF","hylx":"认沽","xqj":"3.4","hydw":"1","xqrq":"2026-12-23","jsrq":"2026-12-24"}
            ]),
        ] {
            assert!(parse_contracts(&broken, "创业板ETF").is_err());
        }
    }

    #[test]
    fn sina_quotes_keep_suspension_null() {
        // Real payload shape for 90007411 at the 2026-11-06 close.
        let text = "var hq_str_sz90007411=\"创业板ETF购12月3400,0.009,0.010,0.008,0.013,0.007,0.008,0.008,3316,264310.000,9,0.008,10,0.007,1,0.007,2,0.007,6,0.007,2,0.008,5,0.008,2,0.008,1,0.009,2,0.009,2026-11-06,15:00:00,00\";\nvar hq_str_sz90008000=\"\";";
        let quotes = parse_sina_quotes(text).unwrap();
        let q = quotes["90007411"].clone().expect("quoted");
        assert!((q.last - 0.008).abs() < 1e-12);
        assert!((q.previous_close - 0.010).abs() < 1e-12);
        // An empty payload is a suspension, not a zero price.
        assert!(quotes["90008000"].is_none());
        assert_eq!(
            quote_date(text).unwrap().format("%Y-%m-%d").to_string(),
            "2026-11-06"
        );
        // Unreadable numbers must fail rather than become zero.
        assert!(parse_sina_quotes("var hq_str_sz90007411=\"x,1,y,0.008\";").is_err());
    }
}
