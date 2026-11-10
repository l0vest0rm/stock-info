//! SSE (Shanghai) and SZSE (Shenzhen) ETF option analysis.
//!
//! Two concerns are kept apart on purpose:
//! - quotes come from the exchange's own data (SSE YunHQ for Shanghai; SZSE's
//!   contract listing plus Sina quotes for Shenzhen, see [`crate::szse_options`]),
//!   cached through the shared HTTP client and `http_cache` (same TTL policy as
//!   other market data);
//! - all valuation math lives in [`crate::option_math`], a pure module that is
//!   also reachable through the stateless `--analysis-json` bridge. Both
//!   exchanges feed the same [`analyse`] path, so there is one pricing model.
//!
//! Scope: listed SSE ETF options (`510050`, `510300`, `510500`, `588000`,
//! `588080`) and SZSE ETF options (`159915`, `159919`, `159922`). The route
//! refuses anything else instead of silently returning an empty table.
//!
//! A contract is identified by `contractid` such as `588000P2612M01200`:
//! underlying `588000`, side `P`, expiry `2612`, display strike `01200`. The
//! authoritative strike is the separate `exepx` field; both are parsed and
//! cross-checked so a provider format change cannot silently misprice a leg.
//!
//! The underlying spot price is an explicit request input. It is never derived
//! from option quotes, so a caller can always state which price the greeks were
//! computed against.
use crate::option_math::{self, OptionKind};
use crate::{ApiError, ApiResult, AppState, cache_policy, http::number, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    routing::get,
};
use chrono::{Datelike, NaiveDate};
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde_json::{Value, json};
use std::collections::HashMap;

/// SSE ETF option underlyings. Anything else is rejected.
const UNDERLYINGS: [&str; 5] = ["510050", "510300", "510500", "588000", "588080"];
/// Default continuous risk-free rate in CNY. Callers may override it because
/// the right rate depends on horizon; it is an explicit input, never a hidden
/// constant inside the math.
const DEFAULT_RATE: f64 = 0.015;

type Params = HashMap<String, String>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/options/cn/chain", get(chain_route))
        .route("/options/cn/expirations", get(expirations_route))
        .route("/options/cn/contract", get(contract_route))
}

/// Where a board's contracts and quotes come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exchange {
    Sse,
    Szse,
}

impl Exchange {
    pub fn source(self) -> &'static str {
        match self {
            Exchange::Sse => "sse",
            Exchange::Szse => "szse",
        }
    }
}

fn exchange_of(underlying: &str) -> Option<Exchange> {
    if UNDERLYINGS.contains(&underlying) {
        Some(Exchange::Sse)
    } else if crate::szse_options::is_shenzhen_underlying(underlying) {
        Some(Exchange::Szse)
    } else {
        None
    }
}

pub fn supported_underlyings() -> Vec<&'static str> {
    UNDERLYINGS
        .iter()
        .copied()
        .chain(crate::szse_options::underlyings().iter().copied())
        .collect()
}

fn require_underlying(query: &Params) -> Result<(String, Exchange), ApiError> {
    let code = query
        .get("underlying")
        .or_else(|| query.get("code"))
        .map(|s| {
            s.trim()
                .trim_end_matches(".SH")
                .trim_end_matches(".SZ")
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "Missing underlying parameter".into(),
            )
        })?;
    let Some(exchange) = exchange_of(&code) else {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!(
                "Unsupported option underlying {code}; expected one of {}",
                supported_underlyings().join(", ")
            ),
        ));
    };
    Ok((code, exchange))
}

/// Latest close carried by the exchange snapshot, when the provider reports it.
///
/// The spot used for greeks must belong to the same session as the option
/// quotes; mixing a later close with earlier quotes corrupts every volatility.
fn quote_date_of(quotes: &[Quote], exchange: Exchange) -> Option<NaiveDate> {
    match exchange {
        Exchange::Sse => quotes.iter().find_map(|q| q.quote_date),
        Exchange::Szse => quotes.iter().find_map(|q| q.quote_date),
    }
}

fn shanghai_today() -> NaiveDate {
    chrono::Utc::now()
        .with_timezone(&chrono_tz::Asia::Shanghai)
        .date_naive()
}

fn required_spot(query: &Params) -> Result<f64, ApiError> {
    let raw = query
        .get("spot")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "Missing spot parameter (underlying price used for greeks)".into(),
            )
        })?;
    match raw.parse::<f64>() {
        Ok(spot) if spot.is_finite() && spot > 0.0 => Ok(spot),
        _ => Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("spot must be a positive number, got {raw}"),
        )),
    }
}

fn decimal_param(query: &Params, key: &str, fallback: f64) -> Result<f64, ApiError> {
    let Some(raw) = query.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return Ok(fallback);
    };
    match raw.parse::<f64>() {
        Ok(value) if value.is_finite() && (-0.05..=0.30).contains(&value) => Ok(value),
        _ => Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("{key} must be a decimal between -0.05 and 0.30, got {raw}"),
        )),
    }
}

fn explicit_as_of(query: &Params) -> Option<NaiveDate> {
    query
        .get("asOf")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .and_then(|raw| NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok())
}

fn as_of(query: &Params) -> Result<NaiveDate, ApiError> {
    let Some(raw) = query
        .get("asOf")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return Ok(shanghai_today());
    };
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            format!("asOf must be YYYY-MM-DD, got {raw}"),
        )
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub contract_id: String,
    pub kind: OptionKind,
    pub expiry_month: String,
    pub strike: f64,
    /// `true` when the series was adjusted for a corporate action: the contract
    /// code then carries the pre-adjustment strike, `strike` is the live one.
    pub adjusted: bool,
    /// Trading date the quotes belong to, per the provider snapshot. Used as the
    /// valuation date so time-to-expiry follows the data, not the wall clock.
    pub quote_date: Option<NaiveDate>,
    pub last: f64,
    pub previous_settlement: f64,
    pub change_rate: Option<f64>,
}

/// Parse the SSE `contractid` form, e.g. `588000P2612M01200` or
/// `510500C2612A07000`.
///
/// Layout: underlying(6) + side(1) + expiry(YYMM) + adjustment flag(1) +
/// 5-digit strike code.
///
/// - The adjustment flag is `M` for an unadjusted contract and `A`, `B`, ... after
///   each corporate-action adjustment (dividend/split). Adjusted contracts keep
///   their original strike code, so the code is **not** the live strike for them.
/// - The strike code encodes strike x 1000 with leading zeros (`01000` => `1.00`,
///   `01200` => `1.20`, `02650` => `2.65`).
///
/// The returned strike is informational only: callers must use the
/// authoritative `exepx` column.
pub fn parse_contract_id(id: &str) -> Option<(String, OptionKind, String, f64)> {
    let id = id.trim();
    let bytes = id.as_bytes();
    if bytes.len() != 17 {
        return None;
    }
    let underlying = &id[..6];
    if !underlying.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let kind = OptionKind::parse(&id[6..7])?;
    let expiry = &id[7..11];
    if expiry.parse::<u32>().is_err() {
        return None;
    }
    // `M` = never adjusted; `A`..`L` = adjusted 1..12 times; later letters are
    // not part of the published encoding and must fail rather than be guessed.
    if !matches!(bytes[11], b'M' | b'A'..=b'L') {
        return None;
    }
    let tail = &id[12..];
    if tail.len() != 5 || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let display = tail.parse::<f64>().ok()?;
    if !(display.is_finite() && display > 0.0) {
        return None;
    }
    Some((
        underlying.to_string(),
        kind,
        expiry.to_string(),
        display / 1000.0,
    ))
}

/// `true` when the contract code marks the series as adjusted for a corporate
/// action. Adjusted series are priced on the adjusted `exepx`, not the code.
pub fn is_adjusted(id: &str) -> bool {
    id.trim()
        .as_bytes()
        .get(11)
        .is_some_and(|flag| *flag != b'M')
}

/// Convert `YYMM` to the settlement date (the **fourth Wednesday** of the
/// expiry month, per SSE contract specification).
pub fn expiry_date(expiry_month: &str) -> Option<NaiveDate> {
    if expiry_month.len() != 4 {
        return None;
    }
    let year = 2000 + expiry_month[..2].parse::<i32>().ok()?;
    let month = expiry_month[2..].parse::<u32>().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    // 0 = Monday .. 6 = Sunday; Wednesday is 2.
    let offset = (2 - first.weekday().num_days_from_monday() as i64).rem_euclid(7);
    let first_wednesday = first + chrono::Duration::days(offset);
    Some(first_wednesday + chrono::Duration::days(21))
}

pub fn years_between(as_of: NaiveDate, expiry: NaiveDate) -> f64 {
    (expiry - as_of).num_days().max(0) as f64 / 365.0
}

async fn fetch_chain(state: &AppState, underlying: &str) -> Result<Vec<Quote>> {
    let mut url = Url::parse("https://yunhq.sse.com.cn:32042/v1/sho/list/tstyle/")?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalid SSE YunHQ base URL"))?
        .push(underlying);
    url.query_pairs_mut().extend_pairs([
        ("select", "contractid,last,chg_rate,presetpx,exepx"),
        ("order", "contractid,ase"),
    ]);
    let now = chrono::Utc::now().timestamp_millis();
    let body = state
        .http
        .cached_json(
            &state.db,
            url.as_str(),
            sse_headers(),
            cache_policy::market_ttl(&format!("{underlying}.SH"), now),
            false,
        )
        .await?;
    parse_chain(underlying, &body)
}

/// Fetch the board for either exchange. Both produce the same [`Quote`] shape so
/// one analyser prices them.
async fn fetch_board(state: &AppState, underlying: &str, exchange: Exchange) -> Result<Vec<Quote>> {
    match exchange {
        Exchange::Sse => fetch_chain(state, underlying).await,
        Exchange::Szse => crate::szse_options::fetch_chain(state, underlying).await,
    }
}

/// Snapshot date carried by the SSE YunHQ payload (`"date":20261106`).
fn sse_snapshot_date(body: &Value) -> Option<NaiveDate> {
    let raw = number(&body["date"]).filter(|n| *n > 0.0)? as i64;
    NaiveDate::from_ymd_opt(
        (raw / 10_000) as i32,
        (raw / 100 % 100) as u32,
        (raw % 100) as u32,
    )
}

/// Pure mapping from the YunHQ payload to typed quotes, unit-testable offline.
pub fn parse_chain(underlying: &str, body: &Value) -> Result<Vec<Quote>> {
    let rows = body["list"]
        .as_array()
        .context("SSE option chain has no list")?;
    // The snapshot date belongs to the whole board, not to individual rows.
    let quote_date = sse_snapshot_date(body);
    let mut quotes = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(id) = row.get(0).and_then(Value::as_str) else {
            continue;
        };
        let Some((parsed_underlying, kind, expiry_month, display_strike)) = parse_contract_id(id)
        else {
            bail!("unparseable SSE contract id {id}");
        };
        if parsed_underlying != underlying {
            bail!("SSE contract {id} does not belong to {underlying}");
        }
        let Some(strike) = number(&row[4]).filter(|n| n.is_finite() && *n > 0.0) else {
            bail!("SSE contract {id} has no strike (exepx)");
        };
        // Unadjusted series must match their code exactly. Adjusted series keep
        // their pre-adjustment code, so only a bounded ratio is meaningful:
        // a dividend adjustment moves the strike a few percent, never tens.
        let ratio = strike / display_strike;
        let consistent = if is_adjusted(id) {
            (0.5..=2.0).contains(&ratio)
        } else {
            (strike - display_strike).abs() <= 1e-9
        };
        if !consistent {
            bail!(
                "SSE contract {id} strike mismatch: id says {display_strike}, exepx says {strike}"
            );
        }
        quotes.push(Quote {
            contract_id: id.to_string(),
            kind,
            expiry_month,
            strike,
            adjusted: is_adjusted(id),
            quote_date,
            last: positive(&row[1]),
            previous_settlement: positive(&row[3]),
            change_rate: number(&row[2]).filter(|n| n.is_finite()),
        });
    }
    Ok(quotes)
}

fn positive(value: &Value) -> f64 {
    number(value)
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0)
}

fn sse_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(REFERER, HeaderValue::from_static("https://www.sse.com.cn/"));
    headers.insert(
        "user-agent",
        HeaderValue::from_static(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        ),
    );
    headers
}

struct Valuation {
    as_of: NaiveDate,
    spot: f64,
    rate: f64,
    dividend_yield: f64,
    /// Implied forward per expiry month from put-call parity. When present the
    /// contract is priced in forward space, which removes the synthetic skew
    /// that a spot/q=0 model invents for dividend-paying ETFs.
    forwards: HashMap<String, Forward>,
}

#[derive(Clone, Copy, Debug)]
struct Forward {
    forward: f64,
    discount_factor: f64,
}

/// Implied forward and discount factor for one expiry from put-call parity:
/// `C - P = df * (F - K)`. Requiring at least two usable strikes and a tight
/// residual keeps a stale or crossed board from producing a nonsense forward.
fn implied_forward(quotes: &[Quote], expiry_month: &str, discount_factor: f64) -> Option<Forward> {
    let mut samples: Vec<(f64, f64)> = Vec::new();
    for put in quotes
        .iter()
        .filter(|q| q.kind == OptionKind::Put && q.expiry_month == expiry_month && q.last > 0.0)
    {
        let Some(call) = quotes.iter().find(|q| {
            q.kind == OptionKind::Call
                && q.expiry_month == expiry_month
                && (q.strike - put.strike).abs() < 1e-9
                && q.last > 0.0
        }) else {
            continue;
        };
        samples.push((
            put.strike,
            put.strike + (call.last - put.last) / discount_factor,
        ));
    }
    if samples.len() < 2 {
        return None;
    }
    let mean = samples.iter().map(|(_, f)| f).sum::<f64>() / samples.len() as f64;
    let spread = samples
        .iter()
        .map(|(_, f)| (f - mean).abs())
        .fold(0.0_f64, f64::max);
    // 15% of the mean is far tighter than SSE quotes allow for a real board,
    // but wide enough to tolerate rounding in the last digit.
    if !(mean.is_finite() && mean > 0.0) || spread > 0.15 * mean {
        return None;
    }
    Some(Forward {
        forward: mean,
        discount_factor,
    })
}

fn implied_forwards(quotes: &[Quote], valuation: &Valuation) -> HashMap<String, Forward> {
    let mut months: Vec<&str> = quotes.iter().map(|q| q.expiry_month.as_str()).collect();
    months.sort_unstable();
    months.dedup();
    months
        .into_iter()
        .filter_map(|month| {
            let t = years_between(valuation.as_of, expiry_date(month)?);
            let discount = (-valuation.rate * t).exp();
            implied_forward(quotes, month, discount).map(|f| (month.to_string(), f))
        })
        .collect()
}

/// Analyse one leg. `volatility`/`delta`/... are `null` when the quote cannot
/// support an observation (zero or stale price, below intrinsic). A null is
/// evidence of missing data, never a zero volatility.
fn analyse(context: &Valuation, quote: &Quote) -> Value {
    let expiry = expiry_date(&quote.expiry_month);
    let time_to_expiry = expiry
        .map(|e| years_between(context.as_of, e))
        .unwrap_or(0.0);
    let forward = context.forwards.get(&quote.expiry_month).copied();
    // Forward space is preferred: it is what the market actually prices. The
    // spot/q fallback only runs when the board cannot supply parity pairs and
    // is flagged as such in `pricingBasis` so nobody compares the two silently.
    let (pricing_basis, volatility, greeks) = match (expiry, forward) {
        (Some(_), Some(f)) => {
            let vol = option_math::implied_volatility_forward(
                quote.kind,
                f.forward,
                quote.strike,
                time_to_expiry,
                f.discount_factor,
                quote.last,
            );
            let greeks = vol.map(|v| {
                option_math::black_scholes_forward(
                    quote.kind,
                    f.forward,
                    quote.strike,
                    time_to_expiry,
                    v,
                    f.discount_factor,
                )
            });
            ("forward", vol, greeks)
        }
        (Some(_), None) => {
            let vol = option_math::implied_volatility(
                quote.kind,
                context.spot,
                quote.strike,
                time_to_expiry,
                context.rate,
                context.dividend_yield,
                quote.last,
            );
            let greeks = vol.map(|v| {
                option_math::black_scholes(
                    quote.kind,
                    context.spot,
                    quote.strike,
                    time_to_expiry,
                    context.rate,
                    context.dividend_yield,
                    v,
                )
            });
            ("spot", vol, greeks)
        }
        (None, _) => ("spot", None, None),
    };
    let breakeven = if quote.last > 0.0 {
        Some(quote.strike - quote.last)
    } else {
        None
    };
    json!({
        "contractId":quote.contract_id,
        "kind":quote.kind.as_code(),
        "expiry":expiry.map(|d| d.format("%Y-%m-%d").to_string()),
        "expiryMonth":quote.expiry_month,
        "strike":quote.strike,
        "adjusted":quote.adjusted,
        "last":quote.last,
        "previousSettlement":quote.previous_settlement,
        "changeRate":quote.change_rate,
        "timeToExpiry":time_to_expiry,
        "pricingBasis":pricing_basis,
        "forward":forward.map(|f| f.forward),
        "discountFactor":forward.map(|f| f.discount_factor),
        "volatility":volatility,
        "delta":greeks.map(|g| g.delta),
        "gamma":greeks.map(|g| g.gamma),
        "thetaPerDay":greeks.map(|g| g.theta / 365.0),
        "vegaPerPoint":greeks.map(|g| g.vega / 100.0),
        "moneyness":context.spot / quote.strike,
        "premiumShareOfSpot":if quote.last>0.0{Some(quote.last/context.spot)}else{None},
        "breakeven":breakeven,
        "breakevenFromSpot":breakeven.map(|b| b/context.spot - 1.0),
    })
}

/// Valuation inputs that do not depend on the board. The date is provisional
/// until the board arrives: see [`valuation_date`].
struct Inputs {
    as_of: NaiveDate,
    spot: f64,
    rate: f64,
    dividend_yield: f64,
    explicit_as_of: bool,
}

fn inputs(query: &Params) -> Result<Inputs, ApiError> {
    Ok(Inputs {
        as_of: as_of(query)?,
        spot: required_spot(query)?,
        rate: decimal_param(query, "rate", DEFAULT_RATE)?,
        dividend_yield: decimal_param(query, "dividendYield", 0.0)?,
        explicit_as_of: explicit_as_of(query).is_some(),
    })
}

impl Inputs {
    fn into_context(self, quotes: &[Quote], exchange: Exchange) -> Valuation {
        let as_of = if self.explicit_as_of {
            self.as_of
        } else {
            quote_date_of(quotes, exchange).unwrap_or(self.as_of)
        };
        Valuation {
            as_of,
            spot: self.spot,
            rate: self.rate,
            dividend_yield: self.dividend_yield,
            forwards: HashMap::new(),
        }
    }
}

fn number_param(query: &Params, key: &str) -> Result<Option<f64>, ApiError> {
    let Some(raw) = query.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    raw.parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(Some)
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                format!("{key} must be a positive number, got {raw}"),
            )
        })
}

async fn chain_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let (underlying, exchange) = require_underlying(&query)?;
    let inputs = inputs(&query)?;
    let side = query
        .get("side")
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    if let Some(side) = &side
        && !matches!(side.as_str(), "call" | "put" | "c" | "p")
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("side must be call or put, got {side}"),
        ));
    }
    let min_strike = number_param(&query, "minStrike")?;
    let max_strike = number_param(&query, "maxStrike")?;
    let minimum_delta = number_param(&query, "minAbsDelta")?;
    let quotes = fetch_board(&state, &underlying, exchange)
        .await
        .map_err(upstream_error)?;
    if quotes.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            format!("no option contracts returned for {underlying}"),
        ));
    }
    let ctx = inputs.into_context(&quotes, exchange);
    let rate = ctx.rate;
    let dividend_yield = ctx.dividend_yield;
    let as_of = ctx.as_of;
    let forwards = implied_forwards(&quotes, &ctx);
    let ctx = Valuation { forwards, ..ctx };
    let mut rows = Vec::new();
    for quote in &quotes {
        let want_side = match side.as_deref() {
            Some("call") | Some("c") => Some(OptionKind::Call),
            Some("put") | Some("p") => Some(OptionKind::Put),
            _ => None,
        };
        if want_side.is_some_and(|k| k != quote.kind) {
            continue;
        }
        if min_strike.is_some_and(|k| quote.strike < k)
            || max_strike.is_some_and(|k| quote.strike > k)
        {
            continue;
        }
        let row = analyse(&ctx, quote);
        if let Some(floor) = minimum_delta {
            let delta = row["delta"].as_f64().map(f64::abs);
            if !delta.is_some_and(|d| d >= floor) {
                continue;
            }
        }
        rows.push(row);
    }
    rows.sort_by(|a, b| {
        a["expiryMonth"]
            .as_str()
            .cmp(&b["expiryMonth"].as_str())
            .then(
                a["strike"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&b["strike"].as_f64().unwrap_or(0.0)),
            )
            .then(a["kind"].as_str().cmp(&b["kind"].as_str()))
    });
    Ok(ok(json!({
        "underlying":underlying,
        "asOf":as_of.format("%Y-%m-%d").to_string(),
        "spot":ctx.spot,
        "rate":rate,
        "dividendYield":dividend_yield,
        "source":exchange.source(),
        "quoteDate":quote_date_of(&quotes, exchange).map(|d| d.format("%Y-%m-%d").to_string()),
        "contracts":rows
    })))
}

async fn expirations_route(
    State(state): State<AppState>,
    Query(query): Query<Params>,
) -> ApiResult {
    let (underlying, exchange) = require_underlying(&query)?;
    let quotes = fetch_board(&state, &underlying, exchange)
        .await
        .map_err(upstream_error)?;
    let as_of = if explicit_as_of(&query).is_some() {
        as_of(&query)?
    } else {
        quote_date_of(&quotes, exchange).unwrap_or_else(shanghai_today)
    };
    let mut months: Vec<String> = quotes
        .iter()
        .map(|q| q.expiry_month.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    months.sort();
    Ok(ok(json!({
        "underlying":underlying,
        "source":exchange.source(),
        "asOf":as_of.format("%Y-%m-%d").to_string(),
        "expirations":months.iter().map(|month|{
            let expiry = expiry_date(month);
            json!({
                "expiryMonth":month,
                "expiry":expiry.map(|d| d.format("%Y-%m-%d").to_string()),
                "daysToExpiry":expiry.map(|d|(d-as_of).num_days().max(0)),
                "contracts":quotes.iter().filter(|q|&q.expiry_month==month).count()
            })
        }).collect::<Vec<_>>()
    })))
}

async fn contract_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let Some(contract_id) = query
        .get("contractId")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Missing contractId parameter".into(),
        ));
    };
    // SSE ids carry their underlying; Shenzhen ids are opaque numbers, so there
    // the caller must name the board.
    let (underlying, exchange) = if let Some((underlying, _, _, _)) = parse_contract_id(contract_id)
    {
        (underlying, Exchange::Sse)
    } else {
        let (underlying, exchange) = require_underlying(&query)?;
        if exchange != Exchange::Szse {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                format!("Unparseable SSE contract id {contract_id}"),
            ));
        }
        (underlying, exchange)
    };
    let inputs = inputs(&query)?;
    let quotes = fetch_board(&state, &underlying, exchange)
        .await
        .map_err(upstream_error)?;
    let Some(quote) = quotes.iter().find(|q| q.contract_id == contract_id) else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("{contract_id} is not listed for {underlying}"),
        ));
    };
    let ctx = inputs.into_context(&quotes, exchange);
    let rate = ctx.rate;
    let dividend_yield = ctx.dividend_yield;
    let as_of = ctx.as_of;
    let forwards = implied_forwards(&quotes, &ctx);
    let ctx = Valuation { forwards, ..ctx };
    Ok(ok(json!({
        "underlying":underlying,
        "asOf":as_of.format("%Y-%m-%d").to_string(),
        "spot":ctx.spot,
        "rate":rate,
        "dividendYield":dividend_yield,
        "source":exchange.source(),
        "contract":analyse(&ctx, quote)
    })))
}

fn upstream_error(error: anyhow::Error) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_contract_ids() {
        let (underlying, kind, month, strike) = parse_contract_id("588000P2612M01200").unwrap();
        assert_eq!(underlying, "588000");
        assert_eq!(kind, OptionKind::Put);
        assert_eq!(month, "2612");
        assert!((strike - 1.2).abs() < 1e-12);
        let (_, kind, _, strike) = parse_contract_id("510050C2611M02650").unwrap();
        assert_eq!(kind, OptionKind::Call);
        assert!((strike - 2.65).abs() < 1e-12);
        for bad in [
            "",
            "588000X2612M01200",
            "588000P2612",
            "588000P2612M",
            "abc",
        ] {
            assert!(parse_contract_id(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn fourth_wednesday_expiries() {
        for (month, expected) in [
            ("2611", "2026-11-25"),
            ("2612", "2026-12-23"),
            ("2703", "2027-03-24"),
            ("2706", "2027-06-23"),
        ] {
            let date = expiry_date(month).unwrap();
            assert_eq!(date.format("%Y-%m-%d").to_string(), expected, "{month}");
            assert_eq!(date.weekday(), chrono::Weekday::Wed, "{month}");
        }
        assert!(expiry_date("2613").is_none());
        assert!(expiry_date("26").is_none());
    }

    #[test]
    fn chain_parser_cross_checks_strike_and_reports_bad_rows() {
        let body = json!({"list":[
            ["588000P2612M01200",0.0499,-2.5,0.0338,1.2],
            ["588000C2612M01200",0.1710,-3.1,0.1866,1.2]
        ]});
        let quotes = parse_chain("588000", &body).unwrap();
        assert_eq!(quotes.len(), 2);
        assert!((quotes[0].last - 0.0499).abs() < 1e-12);
        assert_eq!(quotes[0].kind, OptionKind::Put);
        // A strike mismatch between the id and exepx must fail loudly.
        let broken = json!({"list":[["588000P2612M01200",0.05,0.0,0.03,1.25]]});
        assert!(parse_chain("588000", &broken).is_err());
        // A contract for another underlying must not leak into this chain.
        let foreign = json!({"list":[["510050P2612M01200",0.05,0.0,0.03,1.2]]});
        assert!(parse_chain("588000", &foreign).is_err());
        // Missing strike is a hard error, not a silent zero.
        let no_strike = json!({"list":[["588000P2612M01200",0.05,0.0,0.03,null]]});
        assert!(parse_chain("588000", &no_strike).is_err());
    }

    #[test]
    fn implied_forward_comes_from_put_call_parity() {
        // Real 588000 2612 board at the 2026-11-06 close.
        let body = json!({"list":[
            ["588000C2612M01250",0.1369,-9.10,0.1506,1.25],
            ["588000P2612M01250",0.0645,-4.86,0.0480,1.25],
            ["588000C2612M01300",0.1091,-8.32,0.1190,1.30],
            ["588000P2612M01300",0.0873,-6.58,0.0670,1.30],
            ["588000C2612M01350",0.0848,-9.40,0.0936,1.35],
            ["588000P2612M01350",0.1123,-8.50,0.0918,1.35]
        ]});
        let quotes = parse_chain("588000", &body).unwrap();
        let t = years_between(
            NaiveDate::from_ymd_opt(2026, 11, 9).unwrap(),
            expiry_date("2612").unwrap(),
        );
        let discount = (-0.015_f64 * t).exp();
        let forward = implied_forward(&quotes, "2612", discount).expect("parity pairs");
        // spot * exp(rT) is 1.3284; the dividend-paying ETF forward sits below it.
        assert!(
            (forward.forward - 1.3223).abs() < 5e-4,
            "forward {}",
            forward.forward
        );
        assert!(forward.forward < 1.326 * (0.015_f64 * t).exp());
        // A one-sided board cannot produce a forward.
        let puts_only: Vec<Quote> = quotes
            .iter()
            .filter(|q| q.kind == OptionKind::Put)
            .cloned()
            .collect();
        assert!(implied_forward(&puts_only, "2612", discount).is_none());
    }

    #[test]
    fn greeks_are_null_when_quotes_cannot_support_a_volatility() {
        // Spot fallback basis: no parity pairs available in this synthetic test.
        let ctx = Valuation {
            as_of: NaiveDate::from_ymd_opt(2026, 11, 9).unwrap(),
            spot: 1.326,
            rate: 0.015,
            dividend_yield: 0.0,
            forwards: HashMap::new(),
        };
        let zero = Quote {
            contract_id: "588000P2612M01200".into(),
            kind: OptionKind::Put,
            expiry_month: "2612".into(),
            strike: 1.2,
            adjusted: false,
            quote_date: None,
            last: 0.0,
            previous_settlement: 0.03,
            change_rate: None,
        };
        let row = analyse(&ctx, &zero);
        assert!(row["volatility"].is_null());
        assert!(row["delta"].is_null());
        assert!(row["breakeven"].is_null());

        let priced = Quote {
            last: 0.0499,
            ..zero
        };
        let row = analyse(&ctx, &priced);
        let vol = row["volatility"].as_f64().unwrap();
        assert!((vol - 0.581_335).abs() < 1e-5, "vol {vol}");
        let delta = row["delta"].as_f64().unwrap();
        assert!(delta < 0.0 && delta > -1.0, "delta {delta}");
        assert!((row["breakeven"].as_f64().unwrap() - 1.1501).abs() < 1e-9);
    }
}
