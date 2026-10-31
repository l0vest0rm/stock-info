pub mod analysis;
pub mod providers;
pub mod repository;

use crate::{ApiError, ApiResult, AppState, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use std::collections::HashMap;

type Params = HashMap<String, String>;
const MAX_IDS: usize = 20;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/macro/catalog", get(catalog_route))
        .route("/macro/overview", get(overview_route))
        .route("/macro/series", get(series_route))
        .route("/macro/sync", post(sync_route))
        .route("/macro/analysis", get(analysis_route))
        .route("/macro/analysis/refresh", post(analysis_refresh_route))
        .route("/macro/analysis/resume", post(analysis_resume_route))
        .route("/macro/analysis/sync", post(analysis_sync_route))
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn i(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or(0)
}
fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

async fn catalog_route(State(state): State<AppState>) -> ApiResult {
    let catalog = repository::catalog(&state.db).await?;
    Ok(ok(
        json!({"generatedAt":now_iso(),"regions":catalog["regions"],"categories":catalog["categories"],"metrics":catalog["metrics"],
        "series":catalog["series"].as_array().into_iter().flatten().map(definition).collect::<Vec<_>>(),"capabilities":catalog["capabilities"]}),
    ))
}

async fn overview_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let regions =
        csv(query.get("regions")).ok_or_else(|| bad("filters may contain at most 100 values"))?;
    let categories = csv(query.get("categories"))
        .ok_or_else(|| bad("filters may contain at most 100 values"))?;
    let as_of = as_of(&query)?;
    let catalog = repository::catalog(&state.db).await?;
    let selected: Vec<Value> = catalog["series"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|indicator| {
            (regions.is_empty() || regions.iter().any(|r| r == s(indicator, "regionCode")))
                && (categories.is_empty()
                    || categories.iter().any(|c| {
                        c == s(indicator, "categoryCode")
                            || c == &i(indicator, "categoryId").to_string()
                    }))
        })
        .cloned()
        .collect();
    let ids = selected
        .iter()
        .map(|indicator| i(indicator, "id"))
        .collect::<Vec<_>>();
    let mut latest = HashMap::new();
    for batch in ids.chunks(200) {
        for point in repository::latest(&state.db, batch, Some(as_of)).await? {
            latest.insert(i(&point, "indicatorId"), point);
        }
    }
    let mut series = Vec::new();
    for indicator in &selected {
        series
            .push(overview_entry(&state, indicator, latest.get(&i(indicator, "id")), as_of).await?);
    }
    Ok(ok(
        json!({"generatedAt":now_iso(),"asOf":timestamp_iso(as_of),"regions":regions,"categories":categories,"series":series}),
    ))
}

async fn series_route(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let ids = parse_ids(query.get("ids"))
        .ok_or_else(|| bad("ids must be positive integer indicator IDs"))?;
    if ids.is_empty() {
        return Err(bad("Missing ids parameter"));
    }
    if ids.len() > MAX_IDS {
        return Err(bad("Too many indicators; maximum is 20"));
    }
    let from = query
        .get("from")
        .and_then(|value| parse_period(value))
        .ok_or_else(|| bad("from and to dates are required"))?;
    let to = query
        .get("to")
        .and_then(|value| parse_period(value))
        .ok_or_else(|| bad("from and to dates are required"))?;
    if from > to {
        return Err(bad("from must not be after to"));
    }
    let as_of = as_of(&query)?;
    let measure = query
        .get("measure")
        .or_else(|| query.get("transform"))
        .map(|s| s.trim())
        .unwrap_or("level");
    if !["level", "yoy", "mom"].contains(&measure) {
        return Err(bad("measure must be level, yoy, or mom"));
    }
    let indicators = repository::list_indicators(&state.db, true).await?;
    let by_id: HashMap<i64, Value> = indicators
        .into_iter()
        .map(|indicator| (i(&indicator, "id"), indicator))
        .collect();
    let unknown = ids
        .iter()
        .filter(|id| !by_id.contains_key(id))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(bad(format!(
            "Unknown macro indicator IDs: {}",
            unknown.join(", ")
        )));
    }
    let mut series = Vec::new();
    let mut compared = Vec::new();
    for id in ids {
        let indicator = &by_id[&id];
        let mut lookup_from = from;
        for derived in ["yoy", "mom"] {
            let periods = base_periods(indicator, derived);
            if periods > 0 {
                lookup_from =
                    lookup_from.min(shift_period(from, s(indicator, "frequency"), -periods)?);
            }
        }
        let raw = repository::series(
            &state.db,
            id,
            Some(lookup_from),
            Some(to),
            Some(as_of),
            false,
        )
        .await?;
        let by_period = points_by_period(&raw);
        let points = raw
            .iter()
            .filter(|point| i(point, "periodDay") >= from)
            .map(|point| series_point(point, indicator, measure, &by_period))
            .collect::<Vec<_>>();
        series.push(json!({"definition":definition(indicator),"measure":measure,"points":points}));
        compared.push(indicator.clone());
    }
    Ok(ok(
        json!({"generatedAt":now_iso(),"asOf":timestamp_iso(as_of),"series":series,"comparison":comparison(&compared)}),
    ))
}

async fn sync_route(State(state): State<AppState>) -> ApiResult {
    Ok(ok(sync(&state, Utc::now().timestamp_millis()).await?))
}
async fn analysis_route(State(state): State<AppState>) -> ApiResult {
    analysis::load(&state)
        .await
        .map(ok)
        .map_err(|e| bad(e.to_string()))
}
async fn analysis_refresh_route(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    analysis::enqueue(&state, body["reasoningEffort"].as_str())
        .await
        .map(ok)
        .map_err(|e| bad(e.to_string()))
}
async fn analysis_resume_route(State(state): State<AppState>) -> ApiResult {
    analysis::resume(&state)
        .await
        .map(ok)
        .map_err(|e| bad(e.to_string()))
}
async fn analysis_sync_route(State(state): State<AppState>) -> ApiResult {
    analysis::sync(&state).await.map(ok).map_err(|error| {
        if crate::web_workflow::is_read_unavailable(&error) {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "暂时无法连接 web_workflow；本地任务状态未改变，请稍后再同步。".into(),
            )
        } else {
            bad(error.to_string())
        }
    })
}

fn points_by_period(points: &[Value]) -> HashMap<i64, Value> {
    points
        .iter()
        .map(|point| (i(point, "periodDay"), point.clone()))
        .collect()
}

async fn overview_entry(
    state: &AppState,
    indicator: &Value,
    latest: Option<&Value>,
    as_of: i64,
) -> Result<Value> {
    let availability = availability(indicator, latest);
    let Some(latest) = latest else {
        let unavailable = |method: &str| json!({"value":null,"basePeriod":null,"basePublishedAt":null,"method":method,"status":"unavailable","reason":availability["reason"]});
        return Ok(
            json!({"definition":definition(indicator),"current":null,"yoy":unavailable(s(indicator,"yoyMethod")),"mom":unavailable(s(indicator,"momMethod")),
            "freshness":{"status":"missing","ageSeconds":null,"staleAfterSeconds":indicator["staleAfterSeconds"]},"availability":availability,
            "trend":{"status":"unavailable","reason":availability["reason"],"defaultPeriods":indicator["defaultTrendPeriods"],"points":[]}}),
        );
    };
    let trend_periods = i(indicator, "defaultTrendPeriods").clamp(2, 240);
    let period = i(latest, "periodDay");
    let frequency = s(indicator, "frequency");
    let trend_start = shift_period(period, frequency, -(trend_periods - 1))?;
    let mut start = trend_start;
    for measure in ["yoy", "mom"] {
        let count = base_periods(indicator, measure);
        if count > 0 {
            start = start.min(shift_period(period, frequency, -count)?);
        }
    }
    let raw = repository::series(
        &state.db,
        i(indicator, "id"),
        Some(start),
        Some(period),
        Some(as_of),
        false,
    )
    .await?;
    let mut by_period = points_by_period(&raw);
    by_period.insert(period, latest.clone());
    let trend = raw
        .iter()
        .filter(|point| i(point, "periodDay") >= trend_start && i(point, "periodDay") <= period)
        .map(raw_point)
        .collect::<Vec<_>>();
    let age = (as_of - i(latest, "publishedAt")).max(0);
    Ok(
        json!({"definition":definition(indicator),"current":raw_point(latest),"yoy":derive(latest,indicator,"yoy",&by_period),"mom":derive(latest,indicator,"mom",&by_period),
        "freshness":{"status":if age>i(indicator,"staleAfterSeconds") {"stale"} else {"fresh"},"ageSeconds":age,"staleAfterSeconds":indicator["staleAfterSeconds"]},"availability":availability,
        "trend":{"status":if trend.len()>=2 {"available"} else {"unavailable"},"reason":if trend.len()>=2 {Value::Null} else {json!("insufficient_history")},"defaultPeriods":trend_periods,"points":trend}}),
    )
}

fn availability(indicator: &Value, latest: Option<&Value>) -> Value {
    let (status, reason) = if latest.is_some() {
        ("available", Value::Null)
    } else if s(indicator, "sourceId").is_empty() {
        ("unmapped", json!("unmapped"))
    } else if indicator["lastSuccessAt"].is_null() {
        ("awaiting_first_release", json!("awaiting_first_release"))
    } else {
        ("awaiting_data", json!("awaiting_data"))
    };
    json!({"status":status,"reason":reason})
}

pub fn definition(indicator: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "id",
        "metricId",
        "categoryId",
        "regionCode",
        "definitionId",
        "name",
        "statisticalDefinition",
        "frequency",
        "unit",
        "unitFormat",
        "measurementKind",
        "seasonalAdjustment",
        "leadLag",
        "defaultTrendPeriods",
    ] {
        result[key] = indicator[key].clone();
    }
    result["region"] = json!({"code":indicator["regionCode"],"name":indicator["regionName"],"sort":indicator["regionSort"]});
    result["category"] = json!({"id":indicator["categoryId"],"code":indicator["categoryCode"],"name":indicator["categoryName"],"sort":indicator["categorySort"]});
    result["metric"] = json!({"id":indicator["metricId"],"code":indicator["metricCode"],"name":indicator["metricName"],"description":indicator["metricDescription"],"sort":indicator["metricSort"]});
    result["measures"] = json!({"yoy":{"method":indicator["yoyMethod"],"basePeriods":indicator["yoyBasePeriods"],"displayFormat":indicator["yoyDisplayFormat"]},"mom":{"method":indicator["momMethod"],"basePeriods":indicator["momBasePeriods"],"displayFormat":indicator["momDisplayFormat"]}});
    result["source"] = if s(indicator, "sourceId").is_empty() {
        Value::Null
    } else {
        json!({"id":indicator["sourceId"],"seriesId":indicator["sourceSeriesId"],"url":indicator["sourceUrl"],"publisher":indicator["publisher"]})
    };
    result
}

fn raw_point(point: &Value) -> Value {
    json!({"value":point["value"],"period":period_iso(i(point,"periodDay")),"publishedAt":timestamp_iso(i(point,"publishedAt"))})
}
fn base_periods(indicator: &Value, measure: &str) -> i64 {
    i(
        indicator,
        if measure == "yoy" {
            "yoyBasePeriods"
        } else {
            "momBasePeriods"
        },
    )
}
fn series_point(
    point: &Value,
    indicator: &Value,
    measure: &str,
    by_period: &HashMap<i64, Value>,
) -> Value {
    let mut result = raw_point(point);
    let displayed = if measure == "level" {
        json!({"value":point["value"],"method":"level","status":"available","reason":null})
    } else {
        derive(point, indicator, measure, by_period)
    };
    if let Some(fields) = displayed.as_object() {
        for (key, value) in fields {
            result[key] = value.clone();
        }
    }
    result["derived"] = json!({"yoy":derive(point,indicator,"yoy",by_period),"mom":derive(point,indicator,"mom",by_period)});
    result
}

pub fn derive(
    point: &Value,
    indicator: &Value,
    measure: &str,
    by_period: &HashMap<i64, Value>,
) -> Value {
    let method = s(
        indicator,
        if measure == "yoy" {
            "yoyMethod"
        } else {
            "momMethod"
        },
    );
    let unavailable = |reason: &str, period: Value, published: Value| json!({"value":null,"basePeriod":period,"basePublishedAt":published,"method":method,"status":"unavailable","reason":reason});
    let available = |value: f64, period: Value, published: Value| json!({"value":value,"basePeriod":period,"basePublishedAt":published,"method":method,"status":"available","reason":null});
    let value = point["value"].as_f64().unwrap_or(f64::NAN);
    if method == "native" {
        return available(value, Value::Null, Value::Null);
    }
    if ![
        "percent_change",
        "annualized_percent_change",
        "percentage_point_change",
    ]
    .contains(&method)
    {
        return unavailable(
            if method == "not_applicable" {
                "not_applicable"
            } else {
                "not_configured"
            },
            Value::Null,
            Value::Null,
        );
    }
    let periods = base_periods(indicator, measure);
    if periods < 1 {
        return unavailable("not_configured", Value::Null, Value::Null);
    }
    let Ok(base_day) = shift_period(i(point, "periodDay"), s(indicator, "frequency"), -periods)
    else {
        return unavailable("base_period_missing", Value::Null, Value::Null);
    };
    let Some(base) = by_period.get(&base_day) else {
        return unavailable(
            "base_period_missing",
            json!(period_iso(base_day)),
            Value::Null,
        );
    };
    let base_value = base["value"].as_f64().unwrap_or(f64::NAN);
    let period = json!(period_iso(i(base, "periodDay")));
    let published = json!(timestamp_iso(i(base, "publishedAt")));
    if ((method == "percent_change" || method == "annualized_percent_change") && base_value == 0.0)
        || (method == "annualized_percent_change" && value / base_value < 0.0)
    {
        return unavailable("base_zero", period, published);
    }
    let value = match method {
        "percent_change" => (value / base_value - 1.0) * 100.0,
        "annualized_percent_change" => {
            ((value / base_value).powf(
                match s(indicator, "frequency") {
                    "daily" => 365.0,
                    "weekly" => 52.0,
                    "monthly" => 12.0,
                    "quarterly" => 4.0,
                    _ => 1.0,
                } / periods as f64,
            ) - 1.0)
                * 100.0
        }
        _ => value - base_value,
    };
    available(value, period, published)
}

pub fn comparison(series: &[Value]) -> Value {
    let ids = series
        .iter()
        .map(|indicator| indicator["id"].clone())
        .collect::<Vec<_>>();
    if series.len() < 2 {
        return json!({"status":if series.is_empty() {"not_requested"} else {"single_series"},"comparedIndicatorIds":ids,"reasons":[]});
    }
    let first = &series[0];
    let mut reasons = Vec::new();
    for candidate in &series[1..] {
        for (key, reason) in [
            ("metricId", "metric_mismatch"),
            ("definitionId", "definition_mismatch"),
            ("statisticalDefinition", "statistical_definition_mismatch"),
            ("frequency", "frequency_mismatch"),
        ] {
            if candidate[key] != first[key] && !reasons.contains(&reason) {
                reasons.push(reason);
            }
        }
        if (candidate["unit"] != first["unit"] || candidate["unitFormat"] != first["unitFormat"])
            && !reasons.contains(&"unit_mismatch")
        {
            reasons.push("unit_mismatch");
        }
    }
    json!({"status":if reasons.is_empty() {"comparable"} else {"not_comparable"},"comparedIndicatorIds":ids,"reasons":reasons})
}

pub fn period_iso(day: i64) -> Option<String> {
    let text = day.to_string();
    if text.len() != 8 {
        return None;
    }
    NaiveDate::parse_from_str(&text, "%Y%m%d")
        .ok()
        .map(|date| date.to_string())
}
pub fn shift_period(day: i64, frequency: &str, periods: i64) -> Result<i64> {
    let date = NaiveDate::parse_from_str(
        &period_iso(day).context("invalid macro period day")?,
        "%Y-%m-%d",
    )?;
    let shifted = if frequency == "daily" || frequency == "weekly" {
        date.checked_add_signed(Duration::days(
            periods * if frequency == "weekly" { 7 } else { 1 },
        ))
        .context("macro period overflow")?
    } else {
        let delta = periods
            * match frequency {
                "monthly" => 1,
                "quarterly" => 3,
                "annual" => 12,
                _ => bail!("invalid macro frequency"),
            };
        let total = i64::from(date.year()) * 12 + i64::from(date.month0()) + delta;
        NaiveDate::from_ymd_opt(
            total.div_euclid(12).try_into()?,
            (total.rem_euclid(12) + 1).try_into()?,
            1,
        )
        .context("macro period overflow")?
    };
    Ok(i64::from(shifted.year()) * 10_000
        + i64::from(shifted.month()) * 100
        + i64::from(shifted.day()))
}
pub fn timestamp_iso(seconds: i64) -> Option<String> {
    DateTime::from_timestamp(seconds, 0)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn parse_period(value: &str) -> Option<i64> {
    if value.len() != 10
        || !value.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return None;
    }
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    Some(i64::from(date.year()) * 10_000 + i64::from(date.month()) * 100 + i64::from(date.day()))
}
fn parse_timestamp(value: &str) -> Option<i64> {
    if let Ok(n) = value.trim().parse::<f64>()
        && n.is_finite()
        && n >= 0.0
    {
        return Some(if n >= 10_000_000_000.0 {
            (n / 1000.0).floor() as i64
        } else {
            n.floor() as i64
        });
    }
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp())
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .map(|date| date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp())
        })
}
fn as_of(query: &Params) -> Result<i64, ApiError> {
    match query.get("asOf").filter(|s| !s.is_empty()) {
        Some(value) => parse_timestamp(value).ok_or_else(|| bad("invalid asOf timestamp")),
        None => Ok(Utc::now().timestamp()),
    }
}
fn parse_ids(value: Option<&String>) -> Option<Vec<i64>> {
    let Some(value) = value.filter(|s| !s.trim().is_empty()) else {
        return Some(Vec::new());
    };
    let mut ids = Vec::new();
    for value in value.split(',') {
        let n = value.trim().parse::<f64>().ok()?;
        if !n.is_finite() || n.fract() != 0.0 || n < 1.0 || n > 9_007_199_254_740_991.0 {
            return None;
        }
        let id = n as i64;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Some(ids)
}
fn csv(value: Option<&String>) -> Option<Vec<String>> {
    let mut values = Vec::new();
    for value in value
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !values.iter().any(|v| v == value) {
            values.push(value.to_string());
        }
    }
    (values.len() <= 100).then_some(values)
}

pub async fn sync(state: &AppState, scheduled_ms: i64) -> Result<Value> {
    let now = if scheduled_ms >= 100_000_000_000 {
        scheduled_ms / 1000
    } else {
        scheduled_ms
    };
    let due = repository::due(&state.db, now, 100).await?;
    let mut stats = json!({"indicatorsDue":due.len(),"indicatorsClaimed":0,"indicatorsRejectedSourceMapping":0,"sourceBatchesAttempted":0,"sourceBatchesSucceeded":0,"observationsWritten":0,"observationsRejectedWithoutPublishedAt":0});
    // Keep first-due source-batch order rather than lexically reordering it.
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for mut indicator in due {
        let lease = now + 300;
        if !repository::claim(&state.db, i(&indicator, "id"), now, lease).await? {
            continue;
        }
        match providers::resolve_mapping(&indicator) {
            Ok(mapping) => {
                let key = format!(
                    "{}:{}",
                    s(&mapping, "sourceId"),
                    s(&mapping, "sourceBatchKey")
                );
                indicator["leaseUntil"] = json!(lease);
                indicator["mapping"] = mapping;
                indicator["observationStart"] =
                    json!(observation_start(state, &indicator, now).await?);
                if let Some((_, indicators)) = groups.iter_mut().find(|(batch, _)| *batch == key) {
                    indicators.push(indicator);
                } else {
                    groups.push((key, vec![indicator]));
                }
                increment(&mut stats, "indicatorsClaimed", 1);
            }
            Err(error) => {
                increment(&mut stats, "indicatorsRejectedSourceMapping", 1);
                repository::schedule(
                    &state.db,
                    i(&indicator, "id"),
                    lease,
                    Some(now + backoff(i(&indicator, "consecutiveFailures"))),
                    now,
                    false,
                    Some(&error.to_string()),
                )
                .await?;
            }
        }
    }
    for (_, indicators) in &groups {
        increment(&mut stats, "sourceBatchesAttempted", 1);
        // Persistence belongs to the leased attempt too: a failed write must
        // record failure/backoff rather than strand the fetch lease until it
        // expires and falsely report a successful provider batch.
        let outcome = async {
            let outcome = providers::fetch_batch(state, indicators, scheduled_ms).await?;
            repository::put_data(&state.db, &outcome.points).await?;
            Ok::<_, anyhow::Error>(outcome)
        }
        .await;
        match outcome {
            Ok(outcome) => {
                increment(&mut stats, "sourceBatchesSucceeded", 1);
                increment(
                    &mut stats,
                    "observationsWritten",
                    outcome.points.len() as i64,
                );
                increment(
                    &mut stats,
                    "observationsRejectedWithoutPublishedAt",
                    outcome.rejected_without_published_at as i64,
                );
                for indicator in indicators {
                    repository::schedule(
                        &state.db,
                        i(indicator, "id"),
                        i(indicator, "leaseUntil"),
                        Some(now + i(indicator, "refreshIntervalSeconds")),
                        now,
                        true,
                        None,
                    )
                    .await?;
                }
            }
            Err(error) => {
                let message = error.to_string().chars().take(1000).collect::<String>();
                for indicator in indicators {
                    repository::schedule(
                        &state.db,
                        i(indicator, "id"),
                        i(indicator, "leaseUntil"),
                        Some(now + backoff(i(indicator, "consecutiveFailures"))),
                        now,
                        false,
                        Some(&message),
                    )
                    .await?;
                }
            }
        }
    }
    Ok(stats)
}
fn increment(value: &mut Value, key: &str, amount: i64) {
    value[key] = json!(i(value, key) + amount);
}
fn backoff(failures: i64) -> i64 {
    (3600 * 2_i64.pow(failures.clamp(0, 5) as u32)).min(86_400)
}
async fn observation_start(state: &AppState, indicator: &Value, now: i64) -> Result<String> {
    if let Some(latest) = repository::latest(&state.db, &[i(indicator, "id")], None)
        .await?
        .first()
    {
        let day = shift_period(
            i(latest, "periodDay"),
            s(indicator, "frequency"),
            -i(indicator, "revisionLookbackPeriods"),
        )?;
        return period_iso(day).context("invalid macro observation period");
    }
    let date = DateTime::from_timestamp(now, 0)
        .context("invalid macro scheduled timestamp")?
        .date_naive();
    // Match Date.setUTCFullYear: Feb 29 in a non-leap target year rolls
    // forward to March 1, rather than clamping to February 28.
    let shifted = NaiveDate::from_ymd_opt(date.year() - 10, date.month(), 1)
        .and_then(|first| first.checked_add_signed(Duration::days(i64::from(date.day()) - 1)))
        .context("invalid macro observation range")?;
    Ok(shifted.to_string())
}
pub async fn reconcile(state: &AppState) -> Result<Value> {
    Ok(json!({"inspected":usize::from(analysis::reconcile(state).await?)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_calendar_bases_and_comparability() {
        assert_eq!(shift_period(20260101, "monthly", -1).unwrap(), 20251201);
        assert_eq!(shift_period(20260301, "daily", -1).unwrap(), 20260228);
        assert_eq!(shift_period(20260101, "quarterly", -1).unwrap(), 20251001);
        assert_eq!(period_iso(20260230), None);
        let indicator = json!({"id":1,"metricId":1,"definitionId":0,"statisticalDefinition":"level","frequency":"monthly","unit":"%","unitFormat":"percent","yoyMethod":"percent_change","yoyBasePeriods":12,"momMethod":"percentage_point_change","momBasePeriods":1});
        let point = json!({"periodDay":20261001,"publishedAt":100,"value":110.0});
        let bases = HashMap::from([
            (
                20251001,
                json!({"periodDay":20251001,"publishedAt":50,"value":100.0}),
            ),
            (
                20260901,
                json!({"periodDay":20260901,"publishedAt":90,"value":108.0}),
            ),
        ]);
        assert!(
            (derive(&point, &indicator, "yoy", &bases)["value"]
                .as_f64()
                .unwrap()
                - 10.0)
                .abs()
                < 1e-9
        );
        assert_eq!(derive(&point, &indicator, "mom", &bases)["value"], 2.0);
        assert_eq!(
            derive(&point, &indicator, "yoy", &HashMap::new())["reason"],
            "base_period_missing"
        );
        let mut other = indicator.clone();
        other["definitionId"] = json!(2);
        assert_eq!(
            comparison(&[indicator, other])["reasons"],
            json!(["definition_mismatch"])
        );
    }
    #[test]
    fn query_bounds_and_unavailable_measures() {
        assert_eq!(parse_period("2026-02-30"), None);
        assert_eq!(parse_timestamp("1793232000000"), Some(1793232000));
        assert_eq!(parse_ids(Some(&"1,1,2".into())), Some(vec![1, 2]));
        assert_eq!(parse_ids(Some(&"1,0".into())), None);
        assert_eq!(parse_ids(Some(&"1,".into())), None);
        let point = json!({"periodDay":20260101,"publishedAt":100,"value":-1.0});
        let indicator = json!({"frequency":"quarterly","yoyMethod":"annualized_percent_change","yoyBasePeriods":1});
        let base = HashMap::from([(
            20251001,
            json!({"periodDay":20251001,"publishedAt":50,"value":2.0}),
        )]);
        assert_eq!(
            derive(&point, &indicator, "yoy", &base)["reason"],
            "base_zero"
        );
        assert_eq!(backoff(100), 86400);
    }
}
