//! Optional cross-host public datasets. No host API envelopes, credentials or K-line fallback.
use super::{Metric, identity};
use crate::{Runtime, data_cache::Cache, finance::dividends};
use anyhow::{Result, anyhow, bail, ensure};
use chrono::{NaiveDate, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

const RECHECK_MS: i64 = 15 * 60_000;

// The shared result persists across host upgrades, including independently built
// binaries. A formula/parser change must not hit the other binary's old values.
static YIELD_REVISION: LazyLock<String> = LazyLock::new(|| {
    let mut hash = Sha256::new();
    for source in [
        include_bytes!("../dividends.rs").as_slice(),
        include_bytes!("../../http.rs").as_slice(),
        include_bytes!("cached.rs").as_slice(),
    ] {
        hash.update((source.len() as u64).to_le_bytes());
        hash.update(source);
    }
    format!("{:x}", hash.finalize())
});

pub struct Observation {
    pub points: Vec<Value>,
    pub retrieved_at: String,
}

/// A complete, validated field across a date range. The acquisition time is
/// source metadata, never refreshed by a hit. No independently cached pages.
pub async fn history(
    cache: &Cache,
    runtime: &impl Runtime,
    code: &str,
    metric: Metric,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Observation> {
    identity(code)?;
    let mut record = cache
        .fetch(
            "public.eastmoney.daily-valuation.v1",
            &(code, metric.field(), from.to_string(), to.to_string()),
            RECHECK_MS,
            || async {
                let points = super::history(runtime, code, metric, from, to).await?;
                Ok(json!({"points":points,"retrieved_at":Utc::now().to_rfc3339()}))
            },
        )
        .await?;
    let Value::Array(points) = record["points"].take() else {
        bail!("invalid valuation series");
    };
    Ok(Observation {
        points,
        retrieved_at: record["retrieved_at"]
            .as_str()
            .ok_or_else(|| anyhow!("missing retrieval time"))?
            .to_owned(),
    })
}

/// Shares only unadjusted closing-price inputs from the valuation provider,
/// never intraday quotes or another service's K-line history.
pub async fn closing_prices(
    cache: &Cache,
    runtime: &impl Runtime,
    code: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<Value>> {
    identity(code)?;
    let value = cache
        .fetch(
            "public.eastmoney.valuation-closing-prices.v1",
            &(code, from.to_string(), to.to_string()),
            RECHECK_MS,
            || async {
                Ok(Value::Array(
                    super::closing_prices(runtime, code, from, to).await?,
                ))
            },
        )
        .await?;
    let Value::Array(points) = value else {
        bail!("invalid valuation closing prices");
    };
    Ok(points)
}

fn validate_points(points: Vec<Value>, from: NaiveDate, to: NaiveDate) -> Result<Vec<Value>> {
    for point in &points {
        let date = point["date"]
            .as_str()
            .and_then(|s| s.parse::<NaiveDate>().ok())
            .ok_or_else(|| anyhow!("invalid dividend yield date"))?;
        ensure!(date >= from && date <= to, "dividend yield outside request");
        match point["status"].as_str() {
            Some("available")
                if point["value"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n >= 0.0) => {}
            Some("incomplete_cycle") if point["value"].is_null() => (),
            _ => bail!("invalid dividend yield point"),
        }
    }
    Ok(points)
}

/// Return only derived observations: sources are validated independently on each
/// read, so this calculation has no separate TTL or single acquisition timestamp.
/// This method does not implement the other, legacy dividend_yield_from_rows formula.
pub async fn periodic_dividend_yield(
    cache: &Cache,
    runtime: &impl Runtime,
    code: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<Value>> {
    identity(code)?;
    let raw = dividends::fetch_history(runtime, code).await?;
    ensure!(
        raw.iter().all(|row| row["SECUCODE"].as_str() == Some(code)),
        "dividend identity mismatch"
    );
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let prices = closing_prices(cache, runtime, code, from, to).await?;
    let value = cache.compute(
        "public.eastmoney.periodic-dividend-yield.v1",
        &(code, from.to_string(), to.to_string(), &*YIELD_REVISION),
        &(&raw, &prices),
        || {
            Ok(Value::Array(validate_points(
                dividends::periodic_dividend_yield_from_rows(&raw, &prices),
                from,
                to,
            )?))
        },
    )?;
    let Value::Array(points) = value else {
        bail!("invalid cached yield series")
    };
    Ok(points)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dividend_series_uses_shared_period_arithmetic_and_never_empty_summary_zero() {
        let rows = [
            json!({"REPORT_DATE":"2025-12-31","NOTICE_DATE":"2026-03-01","IMPL_PLAN_PROFILE":"10派20元"}),
        ];
        let bars = [
            json!({"date":"2026-02-27","close":100}),
            json!({"date":"2026-03-02","close":100}),
        ];
        let from = "2026-01-01".parse().unwrap();
        let to = "2026-11-20".parse().unwrap();
        let points = validate_points(
            dividends::periodic_dividend_yield_from_rows(&rows, &bars),
            from,
            to,
        )
        .unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0]["date"], "2026-03-02");
        assert_eq!(points[0]["value"], 2.0);
        assert_eq!(points[0]["reportDate"], "2025-12-31");
        assert_eq!(points[0]["cashPerShare"], 2.0);
        let incomplete =
            vec![json!({"date":"2026-06-17","value":null,"status":"incomplete_cycle"})];
        assert_eq!(
            validate_points(incomplete.clone(), from, to).unwrap(),
            incomplete
        );
        assert!(
            validate_points(
                dividends::periodic_dividend_yield_from_rows(&[], &bars),
                from,
                to
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            validate_points(
                vec![json!({"date":"1970-01-01","value":2.0,"status":"available"})],
                from,
                to
            )
            .is_err()
        );
    }
}
