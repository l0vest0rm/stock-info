use chrono::{Datelike, Duration, NaiveDate};
use serde_json::{Value, json};
use std::sync::LazyLock;

static NOTICE_DATE_SHAPE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap());

static FISCAL_YEAR_PREFIX: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^FY\b").unwrap());

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}
pub fn date(value: &str) -> Option<NaiveDate> {
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}
pub fn notice_date(row: &Value) -> Option<String> {
    let payload = &row["payload"];
    let raw = ["NOTICE_DATE", "noticeDate", "UPDATE_DATE", "updateDate"]
        .iter()
        .find_map(|key| payload.get(key).filter(|v| !v.is_null()));
    let value = raw.and_then(Value::as_str)?.get(..10)?;
    // This mirrors the source's shape check; impossible dates remain unable to
    // enter day arithmetic or historical percentile observations.
    NOTICE_DATE_SHAPE.is_match(value).then(|| value.to_string())
}
pub fn is_cumulative(payload: &Value) -> bool {
    matches!(
        text(&payload["FINANCIAL_SOURCE_CONTRACT"]),
        "eastmoney_f10_income.v1"
            | "eastmoney_f10_annual_income.v1"
            | "eastmoney_hk_f10_main_indicator.v1"
            | "eastmoney_hk_f10_main_indicator.v2"
    )
}
fn annual_period(value: &Value) -> bool {
    matches!(
        text(value).trim().to_uppercase().as_str(),
        "12M" | "FY" | "ANNUAL" | "年报"
    )
}
fn coalesce<'a>(values: &[&'a Value]) -> &'a Value {
    values
        .iter()
        .find(|v| !v.is_null())
        .copied()
        .unwrap_or(&Value::Null)
}
pub fn fiscal_year(row: &Value) -> bool {
    let payload = &row["payload"];
    let contract = text(&payload["FINANCIAL_SOURCE_CONTRACT"]);
    if text(&row["statementType"]) == "income" {
        if matches!(
            text(&payload["dataSource"]),
            "performance_report" | "performance_forecast"
        ) || matches!(
            text(&row["source"]),
            "eastmoney_performance" | "eastmoney_forecast"
        ) {
            return false;
        }
        return match contract {
            "eastmoney_f10_annual_income.v1"
            | "yahoo_finance_timeseries.v2"
            | "yahoo_finance_timeseries.v3" => {
                annual_period(coalesce(&[&payload["FISCAL_PERIOD"], &row["fiscalPeriod"]]))
            }
            "eastmoney_hk_f10_main_indicator.v1" | "eastmoney_hk_f10_main_indicator.v2" => {
                text(&payload["DATE_TYPE_CODE"]) == "001"
            }
            _ => annual_period(coalesce(&[
                &payload["FISCAL_PERIOD"],
                &row["fiscalPeriod"],
                &payload["REPORT_TYPE"],
            ])),
        };
    }
    if contract.starts_with("eastmoney_hk_f10_main_indicator.") {
        return text(&payload["DATE_TYPE_CODE"]) == "001";
    }
    let period = text(coalesce(&[&payload["FISCAL_PERIOD"], &row["fiscalPeriod"]]))
        .trim()
        .to_uppercase();
    if matches!(period.as_str(), "12M" | "FY" | "ANNUAL" | "年报" | "年度") {
        return true;
    }
    let report_type = text(&payload["REPORT_TYPE"]).trim();
    report_type.contains("年报")
        || report_type.contains("年度")
        || FISCAL_YEAR_PREFIX.is_match(report_type)
}
fn annual_like(row: &Value) -> bool {
    let report = text(&row["payload"]["REPORT_TYPE"]).trim();
    report.contains("年报")
        || report == "年度"
        || matches!(
            text(coalesce(&[
                &row["payload"]["FISCAL_PERIOD"],
                &row["fiscalPeriod"]
            ]))
            .trim()
            .to_uppercase()
            .as_str(),
            "12M" | "FY" | "ANNUAL"
        )
}
pub fn shift_months(value: &str, delta: i32) -> Option<String> {
    let value = date(value)?;
    let total = value.year() * 12 + value.month0() as i32 + delta;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) as u32 + 1;
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let last = NaiveDate::from_ymd_opt(next_year, next_month, 1)?
        .pred_opt()?
        .day();
    Some(NaiveDate::from_ymd_opt(year, month, value.day().min(last))?.to_string())
}
fn months_between(from: &str, to: &str) -> Option<i32> {
    let from = date(from)?;
    let to = date(to)?;
    Some((to.year() - from.year()) * 12 + to.month() as i32 - from.month() as i32)
}
pub fn trailing_twelve_months<F: Fn(&Value) -> Option<f64>>(
    rows: &[Value],
    value_of: F,
) -> Option<f64> {
    trailing_twelve_months_refs(&rows.iter().collect::<Vec<_>>(), value_of)
}
fn trailing_twelve_months_refs<F: Fn(&Value) -> Option<f64>>(
    rows: &[&Value],
    value_of: F,
) -> Option<f64> {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| {
        text(&b["reportDate"])
            .cmp(text(&a["reportDate"]))
            .then_with(|| fiscal_year(b).cmp(&fiscal_year(a)))
    });
    let latest = *rows.first()?;
    if fiscal_year(latest) {
        return value_of(latest);
    }
    let annual = *rows
        .iter()
        .find(|row| text(&row["reportDate"]) < text(&latest["reportDate"]) && fiscal_year(row))?;
    let offset = months_between(text(&annual["reportDate"]), text(&latest["reportDate"]))?;
    let target = shift_months(text(&annual["reportDate"]), offset - 12)?;
    let candidates = rows
        .iter()
        .filter(|row| text(&row["reportDate"]) == target)
        .copied()
        .collect::<Vec<_>>();
    let twin = candidates
        .iter()
        .find(|row| !fiscal_year(row))
        .copied()
        .or_else(|| candidates.first().copied())?;
    Some(value_of(annual)? + value_of(latest)? - value_of(twin)?)
}
fn net_profit(row: &Value) -> Option<f64> {
    [
        "PARENT_NETPROFIT",
        "parentNetprofit",
        "NETPROFIT",
        "netProfit",
        "HOLDER_PROFIT",
    ]
    .iter()
    .find_map(|key| number(&row["payload"][key]))
}
pub(crate) fn knowable(row: &Value, as_of: &str) -> bool {
    let report = text(&row["reportDate"]);
    if report > as_of {
        return false;
    }
    if let Some(notice) = notice_date(row) {
        return notice.as_str() <= as_of;
    }
    let deadline = date(report)
        .and_then(|d| d.checked_add_signed(Duration::days(120)))
        .map(|d| d.to_string())
        .unwrap_or_else(|| report.to_string());
    deadline.as_str() <= as_of
}
fn basis(rows: &[&Value]) -> (Vec<String>, Vec<String>) {
    let Some(latest) = rows.last() else {
        return (vec![], vec![]);
    };
    let mut reports = vec![text(&latest["reportDate"]).to_string()];
    if !annual_like(latest)
        && let Some(annual) = rows
            .iter()
            .rev()
            .find(|row| text(&row["reportDate"]) < text(&latest["reportDate"]) && annual_like(row))
    {
        reports.push(text(&annual["reportDate"]).to_string());
        if let Some(twin) = months_between(text(&annual["reportDate"]), text(&latest["reportDate"]))
            .and_then(|offset| shift_months(text(&annual["reportDate"]), offset - 12))
            && rows.iter().any(|row| text(&row["reportDate"]) == twin)
        {
            reports.push(twin);
        }
    }
    let notices = reports
        .iter()
        .filter_map(|report| {
            rows.iter()
                .find(|row| text(&row["reportDate"]) == report)
                .and_then(|row| notice_date(row))
        })
        .collect();
    (reports, notices)
}
pub fn build(statements: &[Value], market_caps: &[Value], ceiling: f64) -> Vec<Value> {
    let mut income = statements
        .iter()
        .filter(|row| text(&row["statementType"]) == "income")
        .collect::<Vec<_>>();
    income.sort_by(|a, b| text(&a["reportDate"]).cmp(text(&b["reportDate"])));
    // Eligibility changes only at report/publication boundaries, not every bar.
    // Keep borrowed rows and precompute dates; never deep-copy financial JSON.
    let available_from = income
        .iter()
        .map(|row| {
            let report = text(&row["reportDate"]);
            let notice = notice_date(row).unwrap_or_else(|| {
                date(report)
                    .and_then(|d| d.checked_add_signed(Duration::days(120)))
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| report.to_string())
            });
            report.max(&notice).to_string()
        })
        .collect::<Vec<_>>();
    let mut bars = market_caps.iter().collect::<Vec<_>>();
    bars.sort_by(|a, b| text(&a["date"]).cmp(text(&b["date"])));
    let mut previous = Vec::new();
    let mut profit = None;
    let mut reports = Vec::new();
    let mut notices = Vec::new();
    bars.into_iter().map(|bar| {
        let eligible = available_from.iter().enumerate()
            .filter_map(|(index, from)| (from.as_str() <= text(&bar["date"])).then_some(index))
            .collect::<Vec<_>>();
        if eligible != previous {
            let knowable = eligible.iter().map(|&index| income[index]).collect::<Vec<_>>();
            profit = trailing_twelve_months_refs(&knowable, net_profit)
                .filter(|n| n.is_finite() && *n > 0.0);
            (reports, notices) = basis(&knowable);
            previous = eligible;
        }
        let pe = profit.and_then(|profit| number(&bar["marketCap"]).map(|cap| cap / profit))
            .filter(|n| *n > 0.0 && *n <= ceiling);
        json!({"date":bar["date"],"marketCap":bar["marketCap"],"ttmNetProfit":profit,"peTtm":pe,"basisReportDates":reports,"basisNoticeDates":notices})
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(report: &str, notice: &str, value: f64, period: &str) -> Value {
        json!({"reportDate":report,"statementType":"income","fiscalPeriod":period,"payload":{"PARENT_NETPROFIT":value,"NOTICE_DATE":notice,"FISCAL_PERIOD":period,"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_annual_income.v1"}})
    }
    // Frozen pre-optimization algorithm, independent of the boundary cache.
    fn legacy_build(statements: &[Value], bars: &[Value], ceiling: f64) -> Vec<Value> {
        let mut income = statements
            .iter()
            .filter(|r| text(&r["statementType"]) == "income")
            .cloned()
            .collect::<Vec<_>>();
        income.sort_by(|a, b| text(&a["reportDate"]).cmp(text(&b["reportDate"])));
        let mut bars = bars.iter().collect::<Vec<_>>();
        bars.sort_by(|a, b| text(&a["date"]).cmp(text(&b["date"])));
        bars.into_iter().map(|bar| {
            let known = income.iter().filter(|r| knowable(r, text(&bar["date"]))).cloned().collect::<Vec<_>>();
            let profit = trailing_twelve_months(&known, net_profit).filter(|n| n.is_finite() && *n > 0.0);
            let pe = profit.and_then(|p| number(&bar["marketCap"]).map(|c| c/p)).filter(|n| *n > 0.0 && *n <= ceiling);
            let (reports, notices) = basis(&known.iter().collect::<Vec<_>>());
            json!({"date":bar["date"],"marketCap":bar["marketCap"],"ttmNetProfit":profit,"peTtm":pe,"basisReportDates":reports,"basisNoticeDates":notices})
        }).collect()
    }
    #[test]
    fn boundary_cache_matches_daily_rebuild_with_restatements_and_missing_dates() {
        let mut rows = Vec::new();
        for year in 2015..2026 {
            for (month, day, period) in
                [(3, 31, "3M"), (6, 30, "6M"), (9, 30, "9M"), (12, 31, "FY")]
            {
                let report = format!("{year}-{month:02}-{day:02}");
                let notice = date(&report)
                    .unwrap()
                    .checked_add_signed(Duration::days(60))
                    .unwrap()
                    .to_string();
                let mut r = row(
                    &report,
                    &notice,
                    (year - 2010) as f64 * month as f64,
                    period,
                );
                r["payload"]["unusedProviderFields"] = json!("x".repeat(4096));
                if year % 3 == 0 {
                    r["payload"]["NOTICE_DATE"] = Value::Null;
                }
                rows.push(r);
            }
        }
        rows.push(row("2020-12-31", "2022-01-01", 900.0, "FY"));
        rows.push(row("2022-12-31", "2022-01-01", 1000.0, "FY"));
        rows.push(row("2023-12-31", "2024-99-01", -10.0, "FY"));
        rows.reverse();
        let start = date("2015-01-01").unwrap();
        let bars = (0..4000).rev().map(|i| json!({"date":(start+Duration::days(i)).to_string(),"marketCap":if i%11==0 {Value::Null} else {json!(10000)}})).collect::<Vec<_>>();
        let started = std::time::Instant::now();
        let expected = legacy_build(&rows, &bars, 500.0);
        let baseline = started.elapsed();
        let started = std::time::Instant::now();
        let actual = build(&rows, &bars, 500.0);
        eprintln!(
            "point-in-time 4000 bars: baseline={baseline:?}, optimized={:?}",
            started.elapsed()
        );
        assert_eq!(actual, expected);
        assert!(build(&[], &[], f64::INFINITY).is_empty());
        assert_eq!(
            build(&[], &bars[..1], 500.0),
            legacy_build(&[], &bars[..1], 500.0)
        );
    }
    #[test]
    fn public_knowledge_date_and_fiscal_calendar_are_respected() {
        let rows = vec![
            row("2024-03-31", "2024-06-01", 100.0, "FY"),
            row("2024-06-30", "2024-08-01", 30.0, "3M"),
            row("2025-03-31", "2025-06-01", 120.0, "FY"),
            row("2025-06-30", "2025-08-01", 40.0, "3M"),
        ];
        assert_eq!(trailing_twelve_months(&rows, net_profit), Some(130.0));
        let points = build(
            &rows,
            &[
                json!({"date":"2025-07-01","marketCap":1200}),
                json!({"date":"2025-08-01","marketCap":1300}),
            ],
            f64::INFINITY,
        );
        assert_eq!(points[0]["ttmNetProfit"], 120.0);
        assert_eq!(points[1]["ttmNetProfit"], 130.0);
        assert_eq!(
            points[1]["basisReportDates"],
            json!(["2025-06-30", "2025-03-31", "2024-06-30"])
        );
        assert_eq!(shift_months("2024-02-29", 12), Some("2025-02-28".into()));
    }
    #[test]
    fn missing_annual_identity_is_not_invented_from_december() {
        let rows = vec![row("2025-12-31", "2026-01-01", 10.0, "3M")];
        assert_eq!(trailing_twelve_months(&rows, net_profit), None);
        assert!(!is_cumulative(
            &json!({"FINANCIAL_SOURCE_CONTRACT":"yahoo_finance_timeseries.v3"})
        ));
    }
}
