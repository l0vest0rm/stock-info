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
    let mut rows = rows.iter().collect::<Vec<_>>();
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
fn knowable(row: &Value, as_of: &str) -> bool {
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
fn basis(rows: &[Value]) -> (Vec<String>, Vec<String>) {
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
                .and_then(notice_date)
        })
        .collect();
    (reports, notices)
}
pub fn build(statements: &[Value], market_caps: &[Value], ceiling: f64) -> Vec<Value> {
    let mut income = statements
        .iter()
        .filter(|row| text(&row["statementType"]) == "income")
        .cloned()
        .collect::<Vec<_>>();
    income.sort_by(|a, b| text(&a["reportDate"]).cmp(text(&b["reportDate"])));
    let mut bars = market_caps.iter().collect::<Vec<_>>();
    bars.sort_by(|a, b| text(&a["date"]).cmp(text(&b["date"])));
    bars.into_iter().map(|bar|{
        let knowable=income.iter().filter(|row|knowable(row,text(&bar["date"]))).cloned().collect::<Vec<_>>();
        let profit=trailing_twelve_months(&knowable,net_profit).filter(|n|n.is_finite()&&*n>0.0);
        let pe=profit.and_then(|profit|number(&bar["marketCap"]).map(|cap|cap/profit)).filter(|n|*n>0.0&&*n<=ceiling);
        let (reports,notices)=basis(&knowable);
        json!({"date":bar["date"],"marketCap":bar["marketCap"],"ttmNetProfit":profit,"peTtm":pe,"basisReportDates":reports,"basisNoticeDates":notices})
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(report: &str, notice: &str, value: f64, period: &str) -> Value {
        json!({"reportDate":report,"statementType":"income","fiscalPeriod":period,"payload":{"PARENT_NETPROFIT":value,"NOTICE_DATE":notice,"FISCAL_PERIOD":period,"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_annual_income.v1"}})
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
