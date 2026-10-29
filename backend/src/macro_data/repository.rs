//! SQLite persistence for the existing two-table macro directory/read model.
//! Publication time is a source fact; it is never replaced with fetch time.

use crate::db::{Database, sql_value};
use anyhow::{Context, Result, bail};
use chrono::NaiveDate;
use rusqlite::{OptionalExtension, params_from_iter};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

const FIELDS: [(&str, &str); 45] = [
    ("id", "id"),
    ("metric_id", "metricId"),
    ("category_id", "categoryId"),
    ("region_code", "regionCode"),
    ("definition_id", "definitionId"),
    ("region_name", "regionName"),
    ("region_sort", "regionSort"),
    ("category_code", "categoryCode"),
    ("category_name", "categoryName"),
    ("category_sort", "categorySort"),
    ("metric_code", "metricCode"),
    ("metric_name", "metricName"),
    ("metric_description", "metricDescription"),
    ("metric_sort", "metricSort"),
    ("statistical_definition", "statisticalDefinition"),
    ("name", "name"),
    ("frequency", "frequency"),
    ("unit", "unit"),
    ("unit_format", "unitFormat"),
    ("measurement_kind", "measurementKind"),
    ("yoy_method", "yoyMethod"),
    ("yoy_base_periods", "yoyBasePeriods"),
    ("yoy_display_format", "yoyDisplayFormat"),
    ("mom_method", "momMethod"),
    ("mom_base_periods", "momBasePeriods"),
    ("mom_display_format", "momDisplayFormat"),
    ("default_trend_periods", "defaultTrendPeriods"),
    ("enabled", "enabled"),
    ("source_id", "sourceId"),
    ("source_series_id", "sourceSeriesId"),
    ("source_url", "sourceUrl"),
    ("publisher", "publisher"),
    (
        "publication_timestamp_strategy",
        "publicationTimestampStrategy",
    ),
    ("source_batch_key", "sourceBatchKey"),
    ("seasonal_adjustment", "seasonalAdjustment"),
    ("lead_lag", "leadLag"),
    ("transform_method", "transformMethod"),
    ("stale_after_seconds", "staleAfterSeconds"),
    ("refresh_interval_seconds", "refreshIntervalSeconds"),
    ("revision_lookback_periods", "revisionLookbackPeriods"),
    ("next_fetch_at", "nextFetchAt"),
    ("last_success_at", "lastSuccessAt"),
    ("fetch_lease_until", "fetchLeaseUntil"),
    ("consecutive_failures", "consecutiveFailures"),
    ("last_error", "lastError"),
];

fn columns() -> String {
    FIELDS
        .iter()
        .map(|(column, field)| format!("{column} AS {field}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn normalize_rows(mut rows: Vec<Value>) -> Vec<Value> {
    for row in &mut rows {
        row["enabled"] = json!(row["enabled"].as_i64().unwrap_or(0) != 0);
    }
    rows
}

/// Replaces only directory/source metadata. Existing scheduler state survives.
/// Directory validation and the upsert share a write transaction so concurrent
/// catalog edits cannot create contradictory dimensions between two checks.
pub async fn upsert_indicator(db: &Database, indicator: &Value) -> Result<()> {
    validate_indicator(indicator)?;
    let indicator = indicator.clone();
    db.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let id = &indicator["id"];
        for (condition, parameters, message) in [
            (
                "region_code=? AND id<>? AND region_name<>'' AND (region_name<>? OR region_sort<>?)",
                vec![indicator["regionCode"].clone(), id.clone(), indicator["regionName"].clone(), indicator["regionSort"].clone()],
                format!("conflicting directory metadata for region {}", indicator["regionCode"].as_str().unwrap_or("")),
            ),
            (
                "category_id=? AND id<>? AND category_code<>'' AND (category_code<>? OR category_name<>? OR category_sort<>?)",
                vec![indicator["categoryId"].clone(), id.clone(), indicator["categoryCode"].clone(), indicator["categoryName"].clone(), indicator["categorySort"].clone()],
                format!("conflicting directory metadata for category {}", indicator["categoryId"]),
            ),
            (
                "metric_id=? AND id<>? AND metric_code<>'' AND (category_id<>? OR metric_code<>? OR metric_name<>? OR metric_description<>? OR metric_sort<>?)",
                vec![indicator["metricId"].clone(), id.clone(), indicator["categoryId"].clone(), indicator["metricCode"].clone(), indicator["metricName"].clone(), indicator["metricDescription"].clone(), indicator["metricSort"].clone()],
                format!("conflicting directory metadata for metric {}", indicator["metricId"]),
            ),
        ] {
            let found = tx.query_row(&format!("SELECT id FROM macro_indicators WHERE {condition} LIMIT 1"), params_from_iter(parameters.iter().map(sql_value)), |row| row.get::<_, i64>(0)).optional()?;
            if found.is_some() { bail!("{message}"); }
        }
        let columns = FIELDS.iter().map(|(column, _)| *column).collect::<Vec<_>>().join(",");
        let placeholders = vec!["?"; FIELDS.len()].join(",");
        let update = FIELDS.iter().filter(|(column, _)| !matches!(*column, "id"|"next_fetch_at"|"last_success_at"|"fetch_lease_until"|"consecutive_failures"|"last_error"))
            .map(|(column, _)| format!("{column}=excluded.{column}")).collect::<Vec<_>>().join(",");
        let parameters: Vec<Value> = FIELDS.iter().map(|(_, field)| {
            if *field == "enabled" { json!(i64::from(indicator[*field].as_bool().unwrap_or(false))) } else { indicator[*field].clone() }
        }).collect();
        tx.execute(&format!("INSERT INTO macro_indicators ({columns}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {update}"), params_from_iter(parameters.iter().map(sql_value)))?;
        tx.commit()?;
        Ok(())
    }).await
}

pub async fn list_indicators(db: &Database, enabled_only: bool) -> Result<Vec<Value>> {
    list_indicators_filtered(db, enabled_only, &[]).await
}

pub async fn list_indicators_filtered(
    db: &Database,
    enabled_only: bool,
    regions: &[String],
) -> Result<Vec<Value>> {
    let mut clauses = Vec::new();
    let mut parameters = Vec::new();
    if enabled_only {
        clauses.push("enabled=1".to_string());
    }
    if !regions.is_empty() {
        clauses.push(format!(
            "region_code IN ({})",
            vec!["?"; regions.len()].join(",")
        ));
        parameters.extend(regions.iter().map(|value| json!(value)));
    }
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    Ok(normalize_rows(db.query(format!("SELECT {} FROM macro_indicators {where_clause} ORDER BY region_sort,region_name,category_sort,category_name,metric_sort,metric_name,definition_id",columns()),parameters).await?))
}

pub async fn catalog(db: &Database) -> Result<Value> {
    catalog_with_disabled(db, false).await
}

pub async fn catalog_with_disabled(db: &Database, include_disabled: bool) -> Result<Value> {
    let series = list_indicators(db, !include_disabled).await?;
    let mut regions = HashMap::new();
    let mut categories = HashMap::new();
    let mut metrics = HashMap::new();
    for indicator in &series {
        regions.insert(indicator["regionCode"].to_string(),json!({"code":indicator["regionCode"],"name":indicator["regionName"],"sort":indicator["regionSort"]}));
        categories.insert(indicator["categoryId"].to_string(),json!({"id":indicator["categoryId"],"code":indicator["categoryCode"],"name":indicator["categoryName"],"sort":indicator["categorySort"]}));
        metrics.insert(indicator["metricId"].to_string(),json!({"id":indicator["metricId"],"categoryId":indicator["categoryId"],"code":indicator["metricCode"],"name":indicator["metricName"],"description":indicator["metricDescription"],"sort":indicator["metricSort"]}));
    }
    let directory = |entries: HashMap<String, Value>, metric: bool| {
        let mut values = entries.into_values().collect::<Vec<_>>();
        values.sort_by(|left, right| {
            let category = if metric {
                left["categoryId"]
                    .as_i64()
                    .cmp(&right["categoryId"].as_i64())
            } else {
                std::cmp::Ordering::Equal
            };
            category
                .then_with(|| left["sort"].as_i64().cmp(&right["sort"].as_i64()))
                .then_with(|| left["name"].as_str().cmp(&right["name"].as_str()))
        });
        values
    };
    let unique = |field: &str| {
        series
            .iter()
            .filter_map(|indicator| indicator[field].as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    Ok(
        json!({"regions":directory(regions,false),"categories":directory(categories,false),"metrics":directory(metrics,true),"series":series,"capabilities":{"frequencies":unique("frequency"),"measurementKinds":unique("measurementKind"),"yoyMethods":unique("yoyMethod"),"momMethods":unique("momMethod")}}),
    )
}

pub async fn due(db: &Database, now: i64, limit: usize) -> Result<Vec<Value>> {
    let limit = if limit == 0 { 100 } else { limit.min(500) };
    Ok(normalize_rows(db.query(format!("SELECT {} FROM macro_indicators WHERE enabled=1 AND source_id IS NOT NULL AND refresh_interval_seconds>0 AND next_fetch_at IS NOT NULL AND next_fetch_at<=? AND (fetch_lease_until IS NULL OR fetch_lease_until<=?) ORDER BY next_fetch_at,id LIMIT ?",columns()),vec![json!(now),json!(now),json!(limit)]).await?))
}

pub async fn claim(db: &Database, id: i64, now: i64, lease: i64) -> Result<bool> {
    if lease <= now {
        return Ok(false);
    }
    Ok(db.execute("UPDATE macro_indicators SET fetch_lease_until=? WHERE id=? AND enabled=1 AND source_id IS NOT NULL AND refresh_interval_seconds>0 AND next_fetch_at IS NOT NULL AND next_fetch_at<=? AND (fetch_lease_until IS NULL OR fetch_lease_until<=?)",vec![json!(lease),json!(id),json!(now),json!(now)]).await?==1)
}

#[allow(clippy::too_many_arguments)]
pub async fn schedule(
    db: &Database,
    id: i64,
    lease: i64,
    next_fetch: Option<i64>,
    completed: i64,
    success: bool,
    error: Option<&str>,
) -> Result<bool> {
    let success = i64::from(success);
    Ok(db.execute("UPDATE macro_indicators SET next_fetch_at=?,last_success_at=CASE WHEN ?=1 THEN ? ELSE last_success_at END,fetch_lease_until=NULL,consecutive_failures=CASE WHEN ?=1 THEN 0 ELSE consecutive_failures+1 END,last_error=CASE WHEN ?=1 THEN NULL ELSE ? END WHERE id=? AND fetch_lease_until=?",vec![json!(next_fetch),json!(success),json!(completed),json!(success),json!(success),json!(error),json!(id),json!(lease)]).await?==1)
}

pub async fn put_data(db: &Database, points: &[Value]) -> Result<()> {
    let mut parameters = Vec::with_capacity(points.len());
    for point in points {
        let id = integer(&point["indicatorId"])
            .context("macro data requires an integer indicatorId/publishedAt and finite value")?;
        let published = integer(&point["publishedAt"])
            .context("macro data requires an integer indicatorId/publishedAt and finite value")?;
        let value = point["value"]
            .as_f64()
            .filter(|number| number.is_finite())
            .context("macro data requires an integer indicatorId/publishedAt and finite value")?;
        let period = if let Some(day) = integer(&point["periodDay"]) {
            valid_day(day)?;
            day
        } else {
            period_day(
                &point["period"],
                point["frequency"]
                    .as_str()
                    .context("macro data requires frequency")?,
            )?
        };
        parameters.push((id, period, published, value));
    }
    db.run(move |conn| {
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        {
            let mut statement=tx.prepare("INSERT INTO macro_data(indicator_id,period_day,published_at,value) VALUES(?,?,?,?) ON CONFLICT(indicator_id,period_day,published_at) DO UPDATE SET value=excluded.value")?;
            for (id,period,published,value) in parameters {statement.execute(rusqlite::params![id,period,published,value])?;}
        }
        tx.commit()?;
        Ok(())
    }).await
}

pub async fn series(
    db: &Database,
    id: i64,
    from: Option<i64>,
    to: Option<i64>,
    as_of: Option<i64>,
    all_versions: bool,
) -> Result<Vec<Value>> {
    let mut conditions = vec!["indicator_id=?"];
    let mut parameters = vec![json!(id)];
    for (condition, value) in [
        ("period_day>=?", from),
        ("period_day<=?", to),
        ("published_at<=?", as_of),
    ] {
        if let Some(value) = value {
            conditions.push(condition);
            parameters.push(json!(value));
        }
    }
    let condition = conditions.join(" AND ");
    let sql = if all_versions {
        format!(
            "SELECT indicator_id AS indicatorId,period_day AS periodDay,published_at AS publishedAt,value FROM macro_data WHERE {condition} ORDER BY period_day,published_at"
        )
    } else {
        format!(
            "SELECT indicator_id AS indicatorId,period_day AS periodDay,published_at AS publishedAt,value FROM (SELECT indicator_id,period_day,published_at,value,ROW_NUMBER() OVER (PARTITION BY period_day ORDER BY published_at DESC) AS version_rank FROM macro_data WHERE {condition}) WHERE version_rank=1 ORDER BY period_day"
        )
    };
    db.query(sql, parameters).await
}

pub async fn latest(db: &Database, ids: &[i64], as_of: Option<i64>) -> Result<Vec<Value>> {
    let mut seen = HashSet::new();
    let ids = ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect::<Vec<_>>();
    if ids.len() > 200 {
        bail!("macro latest snapshot query accepts at most 200 indicators");
    }
    if ids.iter().any(|id| *id <= 0) {
        bail!("macro latest snapshot query requires positive integer indicator IDs");
    }
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let mut parameters = ids.iter().map(|id| json!(id)).collect::<Vec<_>>();
    let as_of_clause = if let Some(as_of) = as_of {
        parameters.push(json!(as_of));
        " AND published_at<=?"
    } else {
        ""
    };
    db.query(format!("SELECT indicator_id AS indicatorId,period_day AS periodDay,published_at AS publishedAt,value FROM (SELECT indicator_id,period_day,published_at,value,ROW_NUMBER() OVER (PARTITION BY indicator_id ORDER BY period_day DESC,published_at DESC) AS snapshot_rank FROM macro_data WHERE indicator_id IN ({placeholders}){as_of_clause}) WHERE snapshot_rank=1 ORDER BY indicator_id"),parameters).await
}

pub async fn latest_one(db: &Database, id: i64, as_of: Option<i64>) -> Result<Option<Value>> {
    Ok(latest(db, &[id], as_of).await?.into_iter().next())
}

pub fn period_day(period: &Value, frequency: &str) -> Result<i64> {
    let text = match period {
        Value::String(text) => text.trim().to_string(),
        Value::Number(_) if integer(period).is_some() => integer(period).unwrap().to_string(),
        Value::Number(number) => number.to_string(),
        _ => bail!("invalid macro period"),
    };
    let quarter = regex::Regex::new(r"^(\d{4})[- ]?[Qq]([1-4])$").unwrap();
    let (year, mut month, mut day) = if let Some(captures) = quarter.captures(&text) {
        (
            captures[1].parse::<i32>()?,
            (captures[2].parse::<u32>()? - 1) * 3 + 1,
            1,
        )
    } else {
        let date = regex::Regex::new(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$").unwrap();
        let captures = date
            .captures(&text)
            .with_context(|| format!("invalid macro period: {text}"))?;
        (
            captures[1].parse::<i32>()?,
            captures
                .get(2)
                .map(|v| v.as_str().parse())
                .transpose()?
                .unwrap_or(1),
            captures
                .get(3)
                .map(|v| v.as_str().parse())
                .transpose()?
                .unwrap_or(1),
        )
    };
    match frequency {
        "annual" => {
            month = 1;
            day = 1;
        }
        "quarterly" => {
            month = ((month
                .checked_sub(1)
                .context("invalid macro period calendar date")?)
                / 3)
                * 3
                + 1;
            day = 1;
        }
        "monthly" => {
            day = 1;
        }
        "weekly" | "daily" => {}
        _ => bail!("invalid macro frequency"),
    }
    if !(1000..=9999).contains(&year) {
        bail!("invalid macro period calendar value");
    }
    NaiveDate::from_ymd_opt(year, month, day).context("invalid macro period calendar date")?;
    Ok(i64::from(year) * 10_000 + i64::from(month) * 100 + i64::from(day))
}

fn valid_day(day: i64) -> Result<NaiveDate> {
    if !(10_000_000..=99_999_999).contains(&day) {
        bail!("invalid macro period day");
    }
    let year = (day / 10_000) as i32;
    let month = ((day / 100) % 100) as u32;
    let day = (day % 100) as u32;
    NaiveDate::from_ymd_opt(year, month, day).context("invalid macro period calendar date")
}

// JSON 1 and 1.0 are the same integer in the existing JavaScript contract.
// Keep that behavior without accepting strings or truncating fractional data.
fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        let number = value.as_f64()?;
        (number.is_finite()
            && number.fract() == 0.0
            && number >= i64::MIN as f64
            && number < -(i64::MIN as f64))
            .then_some(number as i64)
    })
}

fn validate_indicator(indicator: &Value) -> Result<()> {
    if !indicator.is_object() {
        bail!("macro indicator must be an object");
    }
    for field in [
        "id",
        "metricId",
        "categoryId",
        "definitionId",
        "yoyBasePeriods",
        "momBasePeriods",
        "defaultTrendPeriods",
    ] {
        let permits_zero = matches!(field, "definitionId" | "yoyBasePeriods" | "momBasePeriods");
        if !integer(&indicator[field]).is_some_and(|value| value >= i64::from(!permits_zero)) {
            bail!("macro indicator requires a valid {field}");
        }
    }
    for field in [
        "regionCode",
        "regionName",
        "categoryCode",
        "categoryName",
        "metricCode",
        "metricName",
        "name",
        "frequency",
        "unit",
        "unitFormat",
        "measurementKind",
        "yoyMethod",
        "yoyDisplayFormat",
        "momMethod",
        "momDisplayFormat",
    ] {
        if !indicator[field]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
        {
            bail!("macro indicator requires a non-empty {field}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("macro.sqlite")).unwrap();
        db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        (directory, db)
    }
    #[test]
    fn calendar_periods_keep_exact_starts() {
        for (period, frequency, expected) in [
            (json!("2026-Q3"), "quarterly", 20260701),
            (json!("2026 q2"), "quarterly", 20260401),
            (json!("2026-10-29"), "annual", 20260101),
            (json!("2026-10-29"), "monthly", 20261001),
            (json!("2024-02-29"), "daily", 20240229),
            (json!(2026), "annual", 20260101),
            (json!(2026.0), "annual", 20260101),
        ] {
            assert_eq!(period_day(&period, frequency).unwrap(), expected);
        }
        for period in [
            json!("2026-02-29"),
            json!("2026-13-01"),
            json!("2026-Q5"),
            json!("bad"),
            json!(20261029),
        ] {
            assert!(period_day(&period, "daily").is_err());
        }
    }
    #[tokio::test]
    async fn as_of_revisions_are_selected_before_latest_ranking() {
        let (_directory, db) = database();
        let id = list_indicators(&db, true).await.unwrap()[0]["id"]
            .as_i64()
            .unwrap();
        put_data(&db,&[json!({"indicatorId":id,"period":"2026-01","frequency":"monthly","publishedAt":100,"value":10}),json!({"indicatorId":id,"period":"2026-01","frequency":"monthly","publishedAt":200,"value":11}),json!({"indicatorId":id,"period":"2026-02","frequency":"monthly","publishedAt":300,"value":12})]).await.unwrap();
        let visible = series(&db, id, None, None, Some(150), false).await.unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0]["value"], 10.0);
        assert_eq!(
            latest(&db, &[id, id], Some(250)).await.unwrap()[0]["value"],
            11.0
        );
        assert_eq!(
            series(&db, id, None, None, None, true).await.unwrap().len(),
            3
        );
        assert!(latest(&db, &[-1], None).await.is_err());
        assert!(
            latest(&db, &(1..=201).collect::<Vec<_>>(), None)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn catalog_and_upsert_preserve_scheduler_and_directory_contracts() {
        let (_directory, db) = database();
        let mut indicator = list_indicators(&db, true).await.unwrap()[0].clone();
        let id = indicator["id"].as_i64().unwrap();
        db.execute("UPDATE macro_indicators SET next_fetch_at=17,last_success_at=13,fetch_lease_until=99,consecutive_failures=2,last_error='fixture' WHERE id=?",vec![json!(id)]).await.unwrap();
        indicator["nextFetchAt"] = json!(10000);
        indicator["lastSuccessAt"] = Value::Null;
        indicator["fetchLeaseUntil"] = Value::Null;
        indicator["consecutiveFailures"] = json!(0);
        indicator["lastError"] = Value::Null;
        upsert_indicator(&db, &indicator).await.unwrap();
        let reloaded = list_indicators(&db, true)
            .await
            .unwrap()
            .into_iter()
            .find(|row| row["id"] == id)
            .unwrap();
        assert_eq!(reloaded["nextFetchAt"], 17);
        assert_eq!(reloaded["lastSuccessAt"], 13);
        assert_eq!(reloaded["fetchLeaseUntil"], 99);
        assert_eq!(reloaded["lastError"], "fixture");
        let data = catalog(&db).await.unwrap();
        assert!(!data["regions"].as_array().unwrap().is_empty());
        assert!(
            !data["capabilities"]["frequencies"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        indicator["id"] = json!(999999);
        indicator["regionName"] = json!("conflicting");
        assert!(upsert_indicator(&db, &indicator).await.is_err());
        assert!(
            db.query("SELECT id FROM macro_indicators WHERE id=999999", vec![])
                .await
                .unwrap()
                .is_empty()
        );
    }
    #[tokio::test]
    async fn leases_are_atomic_and_stale_completion_cannot_release_a_new_owner() {
        let (_directory, db) = database();
        let id = list_indicators(&db, true).await.unwrap()[0]["id"]
            .as_i64()
            .unwrap();
        db.execute("UPDATE macro_indicators SET source_id='fred',refresh_interval_seconds=10,next_fetch_at=1,fetch_lease_until=NULL WHERE id=?",vec![json!(id)]).await.unwrap();
        let (first, second) = tokio::join!(claim(&db, id, 100, 200), claim(&db, id, 100, 201));
        let first = first.unwrap();
        let second = second.unwrap();
        assert_ne!(first, second);
        assert!(!claim(&db, id, 100, 100).await.unwrap());
        assert!(claim(&db, id, 202, 300).await.unwrap());
        assert!(
            !schedule(
                &db,
                id,
                if first { 200 } else { 201 },
                Some(400),
                202,
                true,
                None
            )
            .await
            .unwrap()
        );
        assert!(
            schedule(&db, id, 300, Some(500), 203, false, Some("fixture"))
                .await
                .unwrap()
        );
        let row = list_indicators(&db, true)
            .await
            .unwrap()
            .into_iter()
            .find(|row| row["id"] == id)
            .unwrap();
        assert_eq!(row["nextFetchAt"], 500);
        assert_eq!(row["lastError"], "fixture");
        assert!(row["fetchLeaseUntil"].is_null());
        assert!(
            due(&db, 500, 100)
                .await
                .unwrap()
                .iter()
                .any(|row| row["id"] == id)
        );
    }
}
