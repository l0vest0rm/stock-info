//! Source registration and provider adapters for macro observations.
//!
//! A fetch timestamp is never a publication timestamp. FRED uses its own
//! realtime_start; BLS needs an already-published official release calendar;
//! DBnomics is restricted to the explicitly verified IMF WEO release batches.

use crate::AppState;
use anyhow::{Result, anyhow};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use regex::Regex;
use reqwest::{
    Method, Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::{collections::HashMap, fmt, time::Duration};

const FRED_ENDPOINT: &str = "https://api.stlouisfed.org/fred/series/observations";
const BLS_ENDPOINT: &str = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const BLS_RELEASE_CALENDAR: &str = "https://www.bls.gov/schedule/news_release/";
const DBNOMICS_ENDPOINT: &str = "https://api.db.nomics.world/v22/series";
const OFFICIAL_HOSTS: &[&str] = &[
    "api.bls.gov",
    "www.bls.gov",
    "api.stlouisfed.org",
    "fred.stlouisfed.org",
    "api.db.nomics.world",
];

static ISO_DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static BLS_MONTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^M(0[1-9]|1[0-2])$").unwrap());
static BLS_QUARTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Q0?([1-4])$").unwrap());
static PERIOD_QUARTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})[- ]?[Qq]([1-4])$").unwrap());
static PERIOD_CALENDAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$").unwrap());

#[derive(Debug, Clone)]
pub struct ProviderError {
    pub code: String,
    pub transient: bool,
    pub message: String,
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ProviderError {}

fn error(code: &str, message: impl Into<String>, transient: bool) -> anyhow::Error {
    ProviderError {
        code: code.to_string(),
        message: message.into(),
        transient,
    }
    .into()
}

#[derive(Debug, Default)]
pub struct FetchResult {
    pub points: Vec<Value>,
    pub rejected_without_published_at: usize,
}

#[derive(Debug)]
struct Observation {
    series_id: String,
    value: f64,
    period: String,
    released_at: Option<String>,
    vintage: Option<String>,
    source_url: String,
    raw: Value,
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|v| !v.is_empty())
}
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    text(&value[key]).unwrap_or("")
}
fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| {
            let value = value.as_str()?.trim();
            if value.is_empty() || value == "." {
                None
            } else {
                value.replace(',', "").parse().ok()
            }
        })
        .filter(|n| n.is_finite())
}
fn seconds(value: i64) -> i64 {
    if value >= 100_000_000_000 {
        value / 1000
    } else {
        value
    }
}

/// Validates a concrete catalog row. Similar provider prefixes are not proof
/// of a release contract; only the four verified BLS IDs and two WEO editions
/// below may use the respective publication strategies.
pub fn resolve_mapping(indicator: &Value) -> Result<Value> {
    let id = &indicator["id"];
    let source = field(indicator, "sourceId");
    let series = field(indicator, "sourceSeriesId");
    let strategy = field(indicator, "publicationTimestampStrategy");
    let batch = field(indicator, "sourceBatchKey");
    if [source, series, strategy, batch]
        .iter()
        .any(|s| s.is_empty())
    {
        return Err(error(
            "unmapped_source",
            format!("macro indicator {id} has no complete source mapping"),
            false,
        ));
    }
    let mut mapping = json!({"sourceId": source, "sourceSeriesId": series, "publicationTimestampStrategy": strategy, "sourceBatchKey": batch});
    match source {
        "fred" => {
            if !Regex::new(r"^[A-Za-z0-9._-]+$").unwrap().is_match(series) {
                return Err(error(
                    "invalid_source_series",
                    format!("macro indicator {id} has an invalid FRED source series id"),
                    false,
                ));
            }
            if strategy != "fred_realtime_start" {
                return Err(error(
                    "unsupported_release_calendar",
                    format!(
                        "macro indicator {id} has an unsupported FRED publication timestamp strategy"
                    ),
                    false,
                ));
            }
        }
        "bls" => {
            if !Regex::new(r"^[A-Z0-9]+$").unwrap().is_match(series) {
                return Err(error(
                    "invalid_source_series",
                    format!("macro indicator {id} has an invalid BLS source series id"),
                    false,
                ));
            }
            let Some(family) = bls_family_for_series(series) else {
                return Err(error(
                    "unsupported_release_calendar",
                    format!(
                        "macro indicator {id} uses BLS series {series} without a verified release-calendar family"
                    ),
                    false,
                ));
            };
            if strategy != "bls_release_calendar" {
                return Err(error(
                    "unsupported_release_calendar",
                    format!(
                        "macro indicator {id} has an unsupported BLS publication timestamp strategy"
                    ),
                    false,
                ));
            }
            mapping["blsReleaseFamily"] = json!(family);
        }
        "dbnomics" => {
            let pattern = Regex::new(r"^IMF/(WEO:\d{4}-\d{2})/([A-Za-z0-9._:-]+)$").unwrap();
            let Some(captures) = pattern.captures(series) else {
                return Err(error(
                    "invalid_source_series",
                    format!(
                        "macro indicator {id} must use an explicitly released IMF WEO DBnomics dataset"
                    ),
                    false,
                ));
            };
            if strategy != "dbnomics_dataset_release" {
                return Err(error(
                    "unsupported_release_calendar",
                    format!(
                        "macro indicator {id} must use a verified DBnomics dataset release timestamp"
                    ),
                    false,
                ));
            }
            let release = match &captures[1] {
                "WEO:2024-10" if batch == "imf-weo-2024-10:1729598400" => {
                    Some((1_729_598_400_i64, "2023-12-31"))
                }
                "WEO:2025-04" if batch == "imf-weo-2025-04:1745323200" => {
                    Some((1_745_323_200_i64, "2024-12-31"))
                }
                _ => None,
            };
            let Some((released, through)) = release else {
                return Err(error(
                    "unsupported_release_calendar",
                    format!(
                        "macro indicator {id} has no verified DBnomics dataset release timestamp"
                    ),
                    false,
                ));
            };
            mapping["datasetReleasedAt"] = json!(released);
            mapping["observedThrough"] = json!(through);
        }
        _ => {
            return Err(error(
                "unsupported_source",
                format!("macro indicator {id} uses unsupported scheduled source: {source}"),
                false,
            ));
        }
    }
    Ok(mapping)
}

fn bls_family_for_series(series: &str) -> Option<&'static str> {
    match series {
        "LNS14000000" | "LNS11300000" => Some("employment"),
        "JTS000000000000000JOL" => Some("jolts"),
        "WPUFD4" => Some("ppi"),
        _ => None,
    }
}

fn check_url(source: &str, address: &str) -> Result<Url> {
    let url = Url::parse(address).map_err(|_| {
        error(
            "invalid_request",
            format!("{source} source URL is invalid"),
            false,
        )
    })?;
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|host| OFFICIAL_HOSTS.contains(&host))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err(error(
            "invalid_request",
            format!("{source} source is not allowlisted"),
            false,
        ));
    }
    Ok(url)
}

async fn request(
    state: &AppState,
    source: &str,
    address: &str,
    timeout_ms: u64,
    method: Method,
    headers: HeaderMap,
    body: Option<String>,
) -> Result<String> {
    check_url(source, address)?;
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        state
            .http
            .text_once(address, method, headers, body, timeout_ms),
    )
    .await
    {
        Err(_) => Err(error(
            "timeout",
            format!("{source} request timed out"),
            true,
        )),
        Ok(Err(cause)) => {
            let message = format!("{cause:#}");
            let lower = message.to_lowercase();
            if lower.contains("timed out") || lower.contains("timeout") {
                return Err(error(
                    "timeout",
                    format!("{source} request timed out"),
                    true,
                ));
            }
            let status = Regex::new(r"status=(\d{3})")
                .unwrap()
                .captures(&message)
                .and_then(|c| c[1].parse::<u16>().ok());
            Err(error(
                "http_error",
                match status {
                    Some(status) => format!("{source} request failed: status={status}"),
                    None => format!("{source} request failed"),
                },
                status.is_none_or(|status| status >= 500 || status == 429),
            ))
        }
        Ok(Ok(text)) => Ok(text),
    }
}

async fn request_json(
    state: &AppState,
    source: &str,
    address: &str,
    timeout_ms: u64,
    method: Method,
    mut headers: HeaderMap,
    body: Option<String>,
) -> Result<Value> {
    headers
        .entry("accept")
        .or_insert(HeaderValue::from_static("application/json"));
    let text = request(state, source, address, timeout_ms, method, headers, body).await?;
    serde_json::from_str(&text).map_err(|_| {
        error(
            "invalid_response",
            format!("{source} returned invalid JSON"),
            false,
        )
    })
}

fn record_array<'a>(value: &'a Value, source: &str, message: &str) -> Result<&'a Vec<Value>> {
    value
        .as_array()
        .filter(|items| items.iter().all(Value::is_object))
        .ok_or_else(|| error("invalid_response", format!("{source} {message}"), false))
}

fn parse_fred(payload: &Value, source_series: &str, source_url: &str) -> Result<Vec<Observation>> {
    let rows = record_array(
        &payload["observations"],
        "FRED",
        "response is missing observations",
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let period = text(&row["date"])?;
            let value = number(&row["value"])?;
            let start = text(&row["realtime_start"]);
            let end = text(&row["realtime_end"]);
            let vintage = match (start, end) {
                (Some(start), Some(end)) => Some(format!("{start}/{end}")),
                (Some(value), None) | (None, Some(value)) => Some(value.to_string()),
                _ => None,
            };
            Some(Observation {
                series_id: source_series.to_string(),
                value,
                period: period.to_string(),
                released_at: start.map(str::to_string),
                vintage,
                source_url: source_url.to_string(),
                raw: row.clone(),
            })
        })
        .collect())
}

fn bls_period(year: &Value, period: &Value) -> Option<String> {
    let year = text(year)?;
    let period = text(period)?;
    if let Some(captures) = BLS_MONTH.captures(period) {
        return Some(format!("{year}-{}", &captures[1]));
    }
    BLS_QUARTER
        .captures(period)
        .map(|captures| format!("{year}-Q{}", &captures[1]))
}

fn parse_bls(payload: &Value) -> Result<Vec<Observation>> {
    if payload["status"] != "REQUEST_SUCCEEDED" {
        let messages = payload["message"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "unknown response".to_string());
        return Err(error(
            "invalid_response",
            format!("BLS request failed: {messages}"),
            false,
        ));
    }
    let series = record_array(
        &payload["Results"]["series"],
        "BLS",
        "response is missing Results.series",
    )?;
    let mut observations = Vec::new();
    for series in series {
        let Some(series_id) = text(&series["seriesID"]) else {
            continue;
        };
        let Some(rows) = series["data"]
            .as_array()
            .filter(|rows| rows.iter().all(Value::is_object))
        else {
            continue;
        };
        for row in rows {
            let (Some(period), Some(value)) = (
                bls_period(&row["year"], &row["period"]),
                number(&row["value"]),
            ) else {
                continue;
            };
            observations.push(Observation {
                series_id: series_id.to_string(),
                value,
                period,
                released_at: None,
                vintage: (row["latest"] == "true").then(|| "latest".to_string()),
                source_url: BLS_ENDPOINT.to_string(),
                raw: row.clone(),
            });
        }
    }
    observations.sort_by(|a, b| a.period.cmp(&b.period));
    Ok(observations)
}

fn parse_dbnomics(
    payload: &Value,
    source_series: &str,
    source_url: &str,
    observed_through: &str,
) -> Result<Vec<Observation>> {
    let docs = record_array(
        &payload["series"]["docs"],
        "DBnomics",
        "response is missing aligned period_start_day/value observations",
    )?;
    let doc = docs.first().ok_or_else(|| {
        error(
            "invalid_response",
            "DBnomics response is missing aligned period_start_day/value observations",
            false,
        )
    })?;
    let periods = doc["period_start_day"]
        .as_array()
        .filter(|items| items.iter().all(Value::is_string));
    let values = doc["value"].as_array();
    let (Some(periods), Some(values)) = (periods, values) else {
        return Err(error(
            "invalid_response",
            "DBnomics response is missing aligned period_start_day/value observations",
            false,
        ));
    };
    if periods.len() != values.len() {
        return Err(error(
            "invalid_response",
            "DBnomics response is missing aligned period_start_day/value observations",
            false,
        ));
    }
    Ok(periods
        .iter()
        .zip(values)
        .filter_map(|(period, value)| {
            let period = period.as_str()?;
            if !ISO_DAY.is_match(period) || period > observed_through {
                return None;
            }
            Some(Observation {
                series_id: source_series.to_string(),
                value: number(value)?,
                period: period.to_string(),
                released_at: None,
                vintage: None,
                source_url: source_url.to_string(),
                raw: json!({"period":period,"value":value}),
            })
        })
        .collect())
}

fn noon_timestamp(date: &str) -> Option<i64> {
    if !ISO_DAY.is_match(date) {
        return None;
    }
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(12, 0, 0)
        .map(|date| date.and_utc().timestamp())
}

fn html_text(html: &str) -> String {
    let without_script = Regex::new(r"(?is)<script\b[^>]*>.*?</script>")
        .unwrap()
        .replace_all(html, " ");
    let without_style = Regex::new(r"(?is)<style\b[^>]*>.*?</style>")
        .unwrap()
        .replace_all(&without_script, " ");
    let without_tags = Regex::new(r"<[^>]+>")
        .unwrap()
        .replace_all(&without_style, " ");
    let entities = Regex::new("(?i)&nbsp;")
        .unwrap()
        .replace_all(&without_tags, " ")
        .into_owned();
    let entities = Regex::new("(?i)&amp;").unwrap().replace_all(&entities, "&");
    Regex::new(r"\s+")
        .unwrap()
        .replace_all(&entities, " ")
        .trim()
        .to_string()
}

fn release_family(text: &str) -> Option<&'static str> {
    let text = text.to_lowercase();
    if text.contains("employment situation") {
        Some("employment")
    } else if text.contains("job openings and labor turnover") || text.contains("jolts") {
        Some("jolts")
    } else if text.contains("producer price index") {
        Some("ppi")
    } else {
        None
    }
}

fn calendar_timestamp(text: &str) -> Option<i64> {
    if let Some(caps) = Regex::new(r"\b(\d{1,2})/(\d{1,2})/(20\d{2})\b")
        .unwrap()
        .captures(text)
    {
        return NaiveDate::from_ymd_opt(
            caps[3].parse().ok()?,
            caps[1].parse().ok()?,
            caps[2].parse().ok()?,
        )?
        .and_hms_opt(12, 0, 0)
        .map(|date| date.and_utc().timestamp());
    }
    let caps = Regex::new(r"(?i)\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b").unwrap().captures(text)?;
    let month = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ]
    .iter()
    .position(|name| *name == caps[1].to_lowercase())? as u32
        + 1;
    NaiveDate::from_ymd_opt(caps[3].parse().ok()?, month, caps[2].parse().ok()?)?
        .and_hms_opt(12, 0, 0)
        .map(|date| date.and_utc().timestamp())
}

fn parse_calendar(html: &str, now: i64) -> HashMap<String, i64> {
    let mut result = HashMap::new();
    for row in Regex::new(r"(?i)<tr\b").unwrap().split(html) {
        let text = html_text(row);
        let (Some(family), Some(published)) = (release_family(&text), calendar_timestamp(&text))
        else {
            continue;
        };
        if published > now {
            continue;
        }
        result
            .entry(family.to_string())
            .and_modify(|previous: &mut i64| *previous = (*previous).max(published))
            .or_insert(published);
    }
    result
}

fn period_day(period: &str, frequency: &str) -> Result<i64> {
    let (year, mut month, mut day) = if let Some(caps) = PERIOD_QUARTER.captures(period) {
        (
            caps[1].parse::<i32>()?,
            (caps[2].parse::<u32>()? - 1) * 3 + 1,
            1,
        )
    } else if let Some(caps) = PERIOD_CALENDAR.captures(period) {
        (
            caps[1].parse::<i32>()?,
            caps.get(2).map_or(Ok(1), |v| v.as_str().parse::<u32>())?,
            caps.get(3).map_or(Ok(1), |v| v.as_str().parse::<u32>())?,
        )
    } else {
        return Err(error(
            "invalid_response",
            format!("invalid macro period: {period}"),
            false,
        ));
    };
    match frequency {
        "annual" => {
            month = 1;
            day = 1
        }
        "quarterly" => {
            if month == 0 {
                return Err(error(
                    "invalid_response",
                    "invalid macro period calendar date",
                    false,
                ));
            }
            month = ((month - 1) / 3) * 3 + 1;
            day = 1
        }
        "monthly" => day = 1,
        _ => {}
    }
    if !(1000..=9999).contains(&year) || NaiveDate::from_ymd_opt(year, month, day).is_none() {
        return Err(error(
            "invalid_response",
            "invalid macro period calendar date",
            false,
        ));
    }
    Ok(i64::from(year) * 10_000 + i64::from(month) * 100 + i64::from(day))
}

fn observation_start(indicator: &Value, now: i64) -> Result<String> {
    if let Some(start) = text(&indicator["observationStart"]) {
        NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|_| error("invalid_request", "invalid macro observationStart", false))?;
        return Ok(start.to_string());
    }
    let date = DateTime::<Utc>::from_timestamp(now, 0)
        .ok_or_else(|| {
            error(
                "invalid_request",
                "invalid macro scheduled timestamp",
                false,
            )
        })?
        .date_naive();
    // Match Date.setUTCFullYear: a leap-day overflow rolls into March instead
    // of silently clamping the backfill boundary to February 28.
    let initial = NaiveDate::from_ymd_opt(date.year() - 10, date.month(), 1)
        .and_then(|start| {
            start.checked_add_signed(chrono::Duration::days(i64::from(date.day()) - 1))
        })
        .ok_or_else(|| error("invalid_request", "invalid macro backfill range", false))?;
    Ok(initial.to_string())
}

fn persistable(
    indicators: &[Value],
    observations: Vec<Observation>,
    calendar: &HashMap<String, i64>,
) -> Result<FetchResult> {
    let mut result = FetchResult::default();
    let by_series: HashMap<&str, &Value> = indicators
        .iter()
        .map(|indicator| (field(&indicator["mapping"], "sourceSeriesId"), indicator))
        .collect();
    for observation in observations {
        let Some(indicator) = by_series.get(observation.series_id.as_str()).copied() else {
            continue;
        };
        let mapping = &indicator["mapping"];
        let published = match field(mapping, "publicationTimestampStrategy") {
            "fred_realtime_start" => observation.released_at.as_deref().and_then(noon_timestamp),
            "bls_release_calendar" => calendar.get(field(mapping, "blsReleaseFamily")).copied(),
            "dbnomics_dataset_release" => mapping["datasetReleasedAt"].as_i64(),
            _ => None,
        };
        let Some(published) = published else {
            result.rejected_without_published_at += 1;
            continue;
        };
        let frequency = field(indicator, "frequency");
        let day = period_day(&observation.period, frequency)?;
        result.points.push(json!({"indicatorId":indicator["id"],"period":observation.period,"frequency":frequency,"periodDay":day,"publishedAt":published,"value":observation.value,"sourceRecordedAt":published,"ingestedAt":Utc::now().timestamp(),"sourceUrl":observation.source_url,"vintage":observation.vintage,"rawPayloadJson":serde_json::to_string(&observation.raw)?}));
    }
    Ok(result)
}

/// One source/batch per call, matching the scheduler's concrete catalog grouping.
pub async fn fetch_batch(
    state: &AppState,
    indicators: &[Value],
    scheduled_ms: i64,
) -> Result<FetchResult> {
    if indicators.is_empty() {
        return Ok(FetchResult::default());
    }
    let now = seconds(scheduled_ms);
    let mut registered = Vec::new();
    for indicator in indicators {
        let mut indicator = indicator.clone();
        indicator["mapping"] = resolve_mapping(&indicator)?;
        registered.push(indicator);
    }
    let source = field(&registered[0]["mapping"], "sourceId");
    let batch = field(&registered[0]["mapping"], "sourceBatchKey");
    if registered.iter().any(|indicator| {
        field(&indicator["mapping"], "sourceId") != source
            || field(&indicator["mapping"], "sourceBatchKey") != batch
    }) {
        return Err(error(
            "invalid_request",
            "macro provider fetch requires a single registered source batch",
            false,
        ));
    }
    let mut observations = Vec::new();
    let mut calendar = HashMap::new();
    match source {
        "fred" => {
            let api_key = state.setting("FRED_API_KEY");
            if api_key.trim().is_empty() {
                return Err(error(
                    "missing_credential",
                    "FRED_API_KEY is required for trustworthy realtime_start timestamps",
                    false,
                ));
            }
            for indicator in &registered {
                let source_series = field(&indicator["mapping"], "sourceSeriesId");
                let mut url = Url::parse(FRED_ENDPOINT)?;
                url.query_pairs_mut().extend_pairs([
                    ("series_id", source_series),
                    ("api_key", api_key.trim()),
                    ("file_type", "json"),
                    ("observation_start", &observation_start(indicator, now)?),
                    (
                        "observation_end",
                        &DateTime::<Utc>::from_timestamp(now, 0)
                            .ok_or_else(|| anyhow!("invalid scheduled timestamp"))?
                            .date_naive()
                            .to_string(),
                    ),
                ]);
                let payload = request_json(
                    state,
                    "fred",
                    url.as_str(),
                    20_000,
                    Method::GET,
                    HeaderMap::new(),
                    None,
                )
                .await?;
                let pairs: Vec<(String, String)> = url
                    .query_pairs()
                    .filter(|(key, _)| key != "api_key")
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect();
                url.set_query(None);
                url.query_pairs_mut().extend_pairs(pairs);
                observations.extend(parse_fred(&payload, source_series, url.as_str())?);
            }
        }
        "bls" => {
            let key = state.setting("BLS_API_KEY");
            let max_series = if key.trim().is_empty() { 25 } else { 50 };
            if registered.len() > max_series {
                return Err(error(
                    "invalid_request",
                    format!("BLS requires 1-{max_series} series and a valid year range"),
                    false,
                ));
            }
            let mut headers = HeaderMap::new();
            headers.insert(
                "user-agent",
                HeaderValue::from_static("Mozilla/5.0 stock-info-macro/0.1"),
            );
            headers.insert(
                "accept-language",
                HeaderValue::from_static("en-US,en;q=0.8"),
            );
            headers.insert(
                "accept",
                HeaderValue::from_static("text/plain,text/csv,text/html"),
            );
            calendar = parse_calendar(
                &request(
                    state,
                    "bls",
                    BLS_RELEASE_CALENDAR,
                    7_000,
                    Method::GET,
                    headers,
                    None,
                )
                .await?,
                now,
            );
            let start_year = registered
                .iter()
                .map(|indicator| {
                    observation_start(indicator, now)
                        .and_then(|start| start[..4].parse::<i32>().map_err(Into::into))
                })
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .min()
                .unwrap();
            let end_year = DateTime::<Utc>::from_timestamp(now, 0)
                .ok_or_else(|| anyhow!("invalid scheduled timestamp"))?
                .year();
            if start_year > end_year {
                return Err(error(
                    "invalid_request",
                    format!("BLS requires 1-{max_series} series and a valid year range"),
                    false,
                ));
            }
            let mut body = json!({"seriesid":registered.iter().map(|indicator|field(&indicator["mapping"],"sourceSeriesId")).collect::<Vec<_>>(),"startyear":start_year.to_string(),"endyear":end_year.to_string()});
            if !key.trim().is_empty() {
                body["registrationkey"] = json!(key.trim());
            }
            let mut headers = HeaderMap::new();
            headers.insert("content-type", HeaderValue::from_static("application/json"));
            let payload = request_json(
                state,
                "bls",
                BLS_ENDPOINT,
                7_000,
                Method::POST,
                headers,
                Some(body.to_string()),
            )
            .await?;
            observations = parse_bls(&payload)?;
        }
        "dbnomics" => {
            if let Some(indicator) = registered.iter().find(|indicator| {
                indicator["mapping"]["datasetReleasedAt"]
                    .as_i64()
                    .is_none_or(|released| released > now)
            }) {
                return Err(error(
                    "invalid_request",
                    format!(
                        "DBnomics WEO batch {} was not released at the scheduled time",
                        field(&indicator["mapping"], "sourceBatchKey")
                    ),
                    false,
                ));
            }
            for indicator in &registered {
                let mapping = &indicator["mapping"];
                let source_series = field(mapping, "sourceSeriesId");
                let mut url = Url::parse(DBNOMICS_ENDPOINT)?;
                {
                    let mut segments = url
                        .path_segments_mut()
                        .map_err(|_| anyhow!("invalid DBnomics endpoint"))?;
                    for segment in source_series.split('/') {
                        segments.push(segment);
                    }
                }
                url.query_pairs_mut().append_pair("observations", "1");
                let payload = request_json(
                    state,
                    "dbnomics",
                    url.as_str(),
                    20_000,
                    Method::GET,
                    HeaderMap::new(),
                    None,
                )
                .await?;
                observations.extend(parse_dbnomics(
                    &payload,
                    source_series,
                    url.as_str(),
                    field(mapping, "observedThrough"),
                )?);
            }
        }
        _ => {
            return Err(error(
                "unsupported_source",
                format!("unsupported scheduled macro source: {source}"),
                false,
            ));
        }
    }
    persistable(&registered, observations, &calendar)
}

pub async fn fetch(state: &AppState, indicator: &Value, scheduled_ms: i64) -> Result<Vec<Value>> {
    Ok(
        fetch_batch(state, std::slice::from_ref(indicator), scheduled_ms)
            .await?
            .points,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn indicator(source: &str, series: &str, strategy: &str, batch: &str) -> Value {
        json!({"id":7,"sourceId":source,"sourceSeriesId":series,"publicationTimestampStrategy":strategy,"sourceBatchKey":batch,"frequency":"monthly"})
    }

    #[test]
    fn mappings_require_exact_publisher_and_publication_contracts() {
        let fred = indicator("fred", "CPIAUCSL", "fred_realtime_start", "fred-us");
        assert_eq!(
            resolve_mapping(&fred).unwrap()["sourceSeriesId"],
            "CPIAUCSL"
        );
        assert!(
            resolve_mapping(&indicator(
                "fred",
                "https://evil.example",
                "fred_realtime_start",
                "x"
            ))
            .is_err()
        );
        assert!(resolve_mapping(&indicator("fred", "CPIAUCSL", "fetch_time", "x")).is_err());
        assert_eq!(
            resolve_mapping(&indicator(
                "bls",
                "LNS14000000",
                "bls_release_calendar",
                "x"
            ))
            .unwrap()["blsReleaseFamily"],
            "employment"
        );
        assert!(
            resolve_mapping(&indicator(
                "bls",
                "LNS14000001",
                "bls_release_calendar",
                "x"
            ))
            .is_err()
        );
        assert!(
            resolve_mapping(&indicator(
                "dbnomics",
                "WB/WDI/US.GDP",
                "dbnomics_dataset_release",
                "x"
            ))
            .is_err()
        );
        assert!(
            resolve_mapping(&indicator(
                "dbnomics",
                "IMF/WEO:2025-04/USA.NGDP_RPCH",
                "dbnomics_dataset_release",
                "imf-weo-2025-04:1745323201"
            ))
            .is_err()
        );
        let weo = resolve_mapping(&indicator(
            "dbnomics",
            "IMF/WEO:2025-04/USA.NGDP_RPCH",
            "dbnomics_dataset_release",
            "imf-weo-2025-04:1745323200",
        ))
        .unwrap();
        assert_eq!(weo["datasetReleasedAt"], 1_745_323_200_i64);
        assert_eq!(weo["observedThrough"], "2024-12-31");
        assert!(resolve_mapping(&json!({"id":1})).is_err());
        assert!(resolve_mapping(&indicator("arbitrary", "x", "fetch_time", "x")).is_err());
    }

    #[test]
    fn macro_fetch_rejects_non_official_urls_and_credentials_in_url() {
        for address in [
            "http://api.bls.gov/publicAPI/",
            "https://evil.example/data",
            "https://api.bls.gov.evil.example/data",
            "https://user:secret@api.bls.gov/data",
            "https://127.0.0.1/data",
            "https://api.bls.gov:444/data",
        ] {
            assert!(check_url("bls", address).is_err(), "{address}");
        }
        assert!(check_url("bls", BLS_ENDPOINT).is_ok());
        assert!(check_url("fred", FRED_ENDPOINT).is_ok());
    }

    #[test]
    fn fred_uses_provider_series_identifier_and_rejects_missing_publication() {
        let payload = json!({"observations":[{"date":"2025-01-01","value":"1,234.5","realtime_start":"2025-02-12","realtime_end":"9999-12-31"},{"date":"2025-02-01","value":"."},{"date":"2025-03-01","value":"5"}]});
        let rows = parse_fred(
            &payload,
            "CPIAUCSL",
            "https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL",
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].series_id, "CPIAUCSL");
        assert_eq!(rows[0].value, 1234.5);
        let mut configured = indicator("fred", "CPIAUCSL", "fred_realtime_start", "fred-us");
        configured["mapping"] = resolve_mapping(&configured).unwrap();
        let result = persistable(&[configured], rows, &HashMap::new()).unwrap();
        assert_eq!(result.points.len(), 1);
        assert_eq!(result.rejected_without_published_at, 1);
        assert_eq!(result.points[0]["periodDay"], 20250101);
        assert_eq!(
            result.points[0]["publishedAt"],
            noon_timestamp("2025-02-12").unwrap()
        );
        assert!(
            !result.points[0]["sourceUrl"]
                .as_str()
                .unwrap()
                .contains("api_key")
        );
        assert!(parse_fred(&json!({"observations":[null]}), "x", "x").is_err());
    }

    #[test]
    fn bls_months_quarters_annual_summary_and_rejected_responses() {
        let payload = json!({"status":"REQUEST_SUCCEEDED","Results":{"series":[{"seriesID":"LNS14000000","data":[{"year":"2025","period":"M02","value":"4.1","latest":"true"},{"year":"2025","period":"M13","value":"4.0"},{"year":"2024","period":"Q04","value":"4.2"}]}]}});
        let rows = parse_bls(&payload).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].period, "2024-Q4");
        assert_eq!(rows[1].period, "2025-02");
        assert_eq!(rows[1].vintage.as_deref(), Some("latest"));
        assert!(
            parse_bls(&json!({"status":"REQUEST_FAILED","message":["limit reached"]}))
                .unwrap_err()
                .to_string()
                .contains("limit reached")
        );
        assert!(parse_bls(&json!({"status":"REQUEST_SUCCEEDED"})).is_err());
    }

    #[test]
    fn bls_calendar_uses_only_latest_already_published_family_date() {
        let html = "<table><tr><td>January 10, 2025</td><td>Employment Situation</td></tr><tr><td>02/07/2025</td><td>Employment Situation</td></tr><tr><td>March 7, 2025</td><td>Employment Situation</td></tr><tr><td>February 4, 2025</td><td>Job Openings and Labor Turnover</td></tr><tr><td>February 13, 2025</td><td>Producer Price Index</td></tr></table>";
        let calendar = parse_calendar(html, noon_timestamp("2025-02-14").unwrap());
        assert_eq!(
            calendar["employment"],
            noon_timestamp("2025-02-07").unwrap()
        );
        assert_eq!(calendar["jolts"], noon_timestamp("2025-02-04").unwrap());
        assert_eq!(calendar["ppi"], noon_timestamp("2025-02-13").unwrap());
        let rows = parse_bls(&json!({"status":"REQUEST_SUCCEEDED","Results":{"series":[{"seriesID":"LNS14000000","data":[{"year":"2025","period":"M01","value":"4.1"}]}]}})).unwrap();
        let mut configured = indicator("bls", "LNS14000000", "bls_release_calendar", "employment");
        configured["mapping"] = resolve_mapping(&configured).unwrap();
        let result = persistable(&[configured.clone()], rows, &calendar).unwrap();
        assert_eq!(
            result.points[0]["publishedAt"],
            noon_timestamp("2025-02-07").unwrap()
        );
        let rows = parse_bls(&json!({"status":"REQUEST_SUCCEEDED","Results":{"series":[{"seriesID":"LNS14000000","data":[{"year":"2025","period":"M01","value":"4.1"}]}]}})).unwrap();
        let result = persistable(&[configured], rows, &HashMap::new()).unwrap();
        assert_eq!(result.rejected_without_published_at, 1);
        assert!(result.points.is_empty());
    }

    #[test]
    fn dbnomics_keeps_completed_actual_years_and_validates_alignment() {
        let payload = json!({"series":{"docs":[{"period_start_day":["2023-01-01","2024-01-01","2025-01-01","2026-01-01"],"value":["1.5",2.0,3.0,4.0]}]}});
        let rows = parse_dbnomics(
            &payload,
            "IMF/WEO:2025-04/USA.NGDP_RPCH",
            "https://api.db.nomics.world/v22/series/IMF/WEO:2025-04/USA.NGDP_RPCH?observations=1",
            "2024-12-31",
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].period, "2024-01-01");
        let mut configured = indicator(
            "dbnomics",
            "IMF/WEO:2025-04/USA.NGDP_RPCH",
            "dbnomics_dataset_release",
            "imf-weo-2025-04:1745323200",
        );
        configured["frequency"] = json!("annual");
        configured["mapping"] = resolve_mapping(&configured).unwrap();
        let result = persistable(&[configured], rows, &HashMap::new()).unwrap();
        assert_eq!(result.points[0]["publishedAt"], 1_745_323_200_i64);
        assert_eq!(result.points[1]["periodDay"], 20240101);
        assert!(
            parse_dbnomics(
                &json!({"series":{"docs":[{"period_start_day":["2025-01-01"],"value":[]}]}}),
                "x",
                "x",
                "2024-12-31"
            )
            .is_err()
        );
    }

    #[test]
    fn period_start_normalization_and_dates() {
        assert_eq!(period_day("2025-Q3", "quarterly").unwrap(), 20250701);
        assert_eq!(period_day("2025-10-15", "monthly").unwrap(), 20251001);
        assert_eq!(period_day("2025-12-31", "annual").unwrap(), 20250101);
        assert_eq!(period_day("2025-10-15", "daily").unwrap(), 20251015);
        assert!(period_day("2025-02-30", "daily").is_err());
        assert!(period_day("2025-00-01", "quarterly").is_err());
        assert!(noon_timestamp("2025-02-30").is_none());
        let now = noon_timestamp("2025-04-22").unwrap();
        assert_eq!(observation_start(&json!({}), now).unwrap(), "2015-04-22");
        assert_eq!(
            observation_start(&json!({"observationStart":"2024-01-01"}), now).unwrap(),
            "2024-01-01"
        );
        assert_eq!(
            observation_start(&json!({}), noon_timestamp("2024-02-29").unwrap()).unwrap(),
            "2014-03-01"
        );
    }
}
