//! Source-preserving financial metrics and fiscal-calendar arithmetic.
//! Missing source evidence is unavailable, never a zero or an inferred FY.
use chrono::{Datelike, NaiveDate};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn strict_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

fn first_number(payload: &Value, fields: &[&str]) -> Option<f64> {
    fields
        .iter()
        .find_map(|field| strict_number(&payload[*field]))
}

fn nullish<'a>(values: &[&'a Value]) -> &'a Value {
    values
        .iter()
        .copied()
        .find(|v| !v.is_null())
        .unwrap_or(&Value::Null)
}

fn annual_period(value: &Value) -> bool {
    matches!(
        text(value).trim().to_uppercase().as_str(),
        "12M" | "FY" | "ANNUAL" | "年报"
    )
}

fn provisional(row: &Value) -> bool {
    matches!(
        text(&row["payload"]["dataSource"]),
        "performance_report" | "performance_forecast"
    )
}

pub fn is_cumulative_income(payload: &Value) -> bool {
    matches!(
        text(&payload["FINANCIAL_SOURCE_CONTRACT"]),
        "eastmoney_f10_income.v1"
            | "eastmoney_f10_annual_income.v1"
            | "eastmoney_hk_f10_main_indicator.v1"
            | "eastmoney_hk_f10_main_indicator.v2"
    )
}

pub fn is_formal_annual_income(row: &Value) -> bool {
    if row["statementType"] != "income"
        || provisional(row)
        || matches!(
            text(&row["source"]),
            "eastmoney_performance" | "eastmoney_forecast"
        )
    {
        return false;
    }
    let payload = &row["payload"];
    match text(&payload["FINANCIAL_SOURCE_CONTRACT"]).trim() {
        "eastmoney_f10_annual_income.v1"
        | "yahoo_finance_timeseries.v2"
        | "yahoo_finance_timeseries.v3" => {
            annual_period(nullish(&[&payload["FISCAL_PERIOD"], &row["fiscalPeriod"]]))
        }
        "eastmoney_hk_f10_main_indicator.v1" | "eastmoney_hk_f10_main_indicator.v2" => {
            text(&payload["DATE_TYPE_CODE"]).trim() == "001"
        }
        _ => annual_period(nullish(&[
            &payload["FISCAL_PERIOD"],
            &row["fiscalPeriod"],
            &payload["REPORT_TYPE"],
        ])),
    }
}

pub fn is_fiscal_year(row: &Value) -> bool {
    if row["statementType"] == "income" {
        return is_formal_annual_income(row);
    }
    let payload = &row["payload"];
    if text(&payload["FINANCIAL_SOURCE_CONTRACT"]).starts_with("eastmoney_hk_f10_main_indicator.") {
        return text(&payload["DATE_TYPE_CODE"]) == "001";
    }
    let period = text(nullish(&[&payload["FISCAL_PERIOD"], &row["fiscalPeriod"]]))
        .trim()
        .to_uppercase();
    if matches!(period.as_str(), "12M" | "FY" | "ANNUAL" | "年报" | "年度") {
        return true;
    }
    let report_type = text(&payload["REPORT_TYPE"]).trim();
    report_type.contains("年报")
        || report_type.contains("年度")
        || regex::Regex::new(r"(?i)^FY\b")
            .unwrap()
            .is_match(report_type)
}

pub fn annual_base_for<'a>(rows: &'a [Value], before_date: &str) -> Option<&'a Value> {
    let mut best: Option<&Value> = None;
    for row in rows {
        let date = text(&row["reportDate"]);
        if date < before_date
            && is_fiscal_year(row)
            && best.is_none_or(|previous| date > text(&previous["reportDate"]))
        {
            best = Some(row);
        }
    }
    best
}

pub fn shift_months(date: &str, delta: i32) -> Option<String> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let months = i64::from(date.year()) * 12 + i64::from(date.month0()) + i64::from(delta);
    let year = i32::try_from(months.div_euclid(12)).ok()?;
    let month = u32::try_from(months.rem_euclid(12) + 1).ok()?;
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year.checked_add(1)?, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)?
    };
    let last_day = next.pred_opt()?.day();
    Some(NaiveDate::from_ymd_opt(year, month, date.day().min(last_day))?.to_string())
}

pub fn prior_same_period_for<'a>(
    rows: &'a [Value],
    latest: &Value,
    annual: &Value,
) -> Option<&'a Value> {
    let latest_date = NaiveDate::parse_from_str(text(&latest["reportDate"]), "%Y-%m-%d").ok()?;
    let annual_date = NaiveDate::parse_from_str(text(&annual["reportDate"]), "%Y-%m-%d").ok()?;
    let months = (latest_date.year() - annual_date.year()) * 12 + latest_date.month() as i32
        - annual_date.month() as i32;
    let target = shift_months(text(&annual["reportDate"]), months - 12)?;
    rows.iter()
        .find(|row| text(&row["reportDate"]) == target && !is_fiscal_year(row))
        .or_else(|| rows.iter().find(|row| text(&row["reportDate"]) == target))
}

pub fn ttm_value<F>(rows: &[Value], value_of: F) -> Option<f64>
where
    F: Fn(&Value) -> Option<f64>,
{
    let mut rows = rows.to_vec();
    rows.sort_by(|left, right| {
        text(&right["reportDate"])
            .cmp(text(&left["reportDate"]))
            .then_with(|| is_fiscal_year(right).cmp(&is_fiscal_year(left)))
    });
    let latest = rows.first()?;
    if is_fiscal_year(latest) {
        return value_of(latest);
    }
    let annual = annual_base_for(&rows, text(&latest["reportDate"]))?;
    let prior = prior_same_period_for(&rows, latest, annual)?;
    let result = value_of(annual)? + value_of(latest)? - value_of(prior)?;
    result.is_finite().then_some(result)
}

pub fn trailing_twelve_months(rows: &[Value], field: &str) -> Value {
    json!(ttm_value(rows, |row| strict_number(&row["payload"][field])))
}

pub fn annual_income_statements(rows: &[Value]) -> Vec<Value> {
    let mut rows = rows.to_vec();
    let report_date = |row: &Value| -> String {
        let date = text(&row["reportDate"]).trim();
        if date.is_empty() {
            text(&row["payload"]["REPORT_DATE"]).trim().into()
        } else {
            date.into()
        }
    };
    rows.sort_by(|left, right| {
        report_date(right)
            .cmp(&report_date(left))
            .then_with(|| {
                right["updatedAt"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&left["updatedAt"].as_f64().unwrap_or(0.0))
            })
            .then_with(|| text(&right["source"]).cmp(text(&left["source"])))
    });
    let mut selected = HashSet::new();
    rows.into_iter().filter_map(|row| {
        if !is_formal_annual_income(&row) {return None;}
        let date = report_date(&row);
        let year = date.get(..4)?.parse::<i32>().ok()?;
        if !selected.insert(year) {return None;}
        let payload = &row["payload"];
        let flexible = |fields: &[&str]| fields.iter().find_map(|field|crate::http::number(&payload[*field]));
        Some(json!({"fiscalYear":year,"reportDate":date,
            "revenue":flexible(&["TOTAL_OPERATE_INCOME","OPERATE_INCOME","totalOperateIncome","operateIncome"]),
            "netProfit":flexible(&["PARENT_NETPROFIT","HOLDER_PROFIT","NETPROFIT","parentNetprofit","netProfit"]),
            "source":row["source"],"row":row}))
    }).collect()
}

pub fn income_family(row: &Value) -> Option<&'static str> {
    let payload = &row["payload"];
    if payload["FINANCIAL_SOURCE_CONTRACT"] == "eastmoney_f10_incomeqc.v1" {
        return Some("quarterized");
    }
    if is_cumulative_income(payload) {
        return Some("cumulative");
    }
    if row["source"] != "eastmoney" {
        let label = nullish(&[
            &row["fiscalPeriod"],
            &payload["FISCAL_PERIOD"],
            &payload["REPORT_TYPE"],
        ]);
        let cumulative = matches!(
            text(label).trim().to_uppercase().as_str(),
            "中报" | "三季报" | "一季报" | "半年报" | "H1" | "9M" | "Q1" | "Q3"
        );
        return (annual_period(label) || cumulative).then_some("cumulative");
    }
    Some("quarterized")
}

pub fn previous_quarter_end(date: &str) -> Option<String> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let year = date.year();
    match (date.month(), date.day()) {
        (3, 31) => Some(format!("{}-12-31", year - 1)),
        (6, 30) => Some(format!("{year}-03-31")),
        (9, 30) => Some(format!("{year}-06-30")),
        (12, 31) => Some(format!("{year}-09-30")),
        _ => None,
    }
}

fn revenue(payload: &Value) -> Option<f64> {
    first_number(payload, &["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"])
}
fn profit(payload: &Value) -> Option<f64> {
    first_number(payload, &["PARENT_NETPROFIT", "NETPROFIT"])
}

fn ttm_at(
    cumulative: &BTreeMap<String, Value>,
    date: &str,
) -> (Option<f64>, Option<f64>, Option<&'static str>) {
    let Some(current) = cumulative.get(date) else {
        return (None, None, None);
    };
    let rows: Vec<Value> = cumulative
        .iter()
        .filter(|(key, _)| key.as_str() <= date)
        .map(|(_, row)| row.clone())
        .collect();
    let revenue = ttm_value(&rows, |row| revenue(&row["payload"]));
    let profit = ttm_value(&rows, |row| profit(&row["payload"]));
    let basis = if revenue.is_none() && profit.is_none() {
        None
    } else if is_fiscal_year(current) {
        Some("annual")
    } else {
        Some("cumulative_roll")
    };
    (revenue, profit, basis)
}

pub fn quarterly_series(code: &str, rows: &[Value], limit: usize) -> Value {
    let mut cumulative = BTreeMap::<String, Value>::new();
    let mut quarterized = BTreeMap::<String, Value>::new();
    for row in rows.iter().filter(|row| row["statementType"] == "income") {
        let Some(family) = income_family(row) else {
            continue;
        };
        let target = if family == "cumulative" {
            &mut cumulative
        } else {
            &mut quarterized
        };
        let date = text(&row["reportDate"]).to_string();
        if target
            .get(&date)
            .is_none_or(|existing| provisional(existing) && !provisional(row))
        {
            target.insert(date, row.clone());
        }
    }
    let mut dates: Vec<_> = cumulative
        .keys()
        .chain(quarterized.keys())
        .cloned()
        .collect();
    dates.sort();
    dates.dedup();
    dates.reverse();
    dates.retain(|date| previous_quarter_end(date).is_some());
    let fields = [
        "cumulativeRevenue",
        "cumulativeNetProfit",
        "quarterRevenue",
        "quarterNetProfit",
        "ttmRevenue",
        "ttmNetProfit",
    ];
    let mut points = Vec::new();
    for date in dates {
        let current = cumulative.get(&date);
        let quarter = quarterized.get(&date);
        let read = |row: Option<&Value>, value_of: fn(&Value) -> Option<f64>| {
            row.and_then(|row| value_of(&row["payload"]))
        };
        let (ttm_revenue, ttm_profit, basis) = ttm_at(&cumulative, &date);
        let values = [
            read(current, revenue),
            read(current, profit),
            read(quarter, revenue),
            read(quarter, profit),
            ttm_revenue,
            ttm_profit,
        ];
        let gaps: Vec<_> = fields
            .iter()
            .zip(values)
            .filter_map(|(field, value)| value.is_none().then_some(*field))
            .collect();
        let mut point = json!({"reportDate":date,"fiscalPeriod":current.or(quarter).map(|row|&row["fiscalPeriod"]),
            "ttmBasis":basis,"revenueYoY":null,"netProfitYoY":null,
            "provisional":current.is_some_and(provisional)||quarter.is_some_and(provisional),"gaps":gaps});
        for (field, value) in fields.iter().zip(values) {
            point[*field] = json!(value);
        }
        points.push(point);
    }
    let by_date: BTreeMap<String, Value> = points
        .iter()
        .map(|point| (text(&point["reportDate"]).into(), point.clone()))
        .collect();
    for point in &mut points {
        let date = text(&point["reportDate"]);
        let prior = date
            .get(..4)
            .and_then(|year| year.parse::<i32>().ok())
            .map(|year| format!("{}{}", year - 1, &date[4..]))
            .and_then(|date| by_date.get(&date));
        for (output, input) in [
            ("revenueYoY", "quarterRevenue"),
            ("netProfitYoY", "quarterNetProfit"),
        ] {
            let current = strict_number(&point[input]);
            let previous = prior.and_then(|prior| strict_number(&prior[input]));
            let ratio = current
                .zip(previous)
                .and_then(|(current, prior)| (prior != 0.0).then_some(current / prior - 1.0))
                .filter(|v| v.is_finite());
            point[output] = json!(ratio);
            if ratio.is_none() {
                point["gaps"].as_array_mut().unwrap().push(json!(output));
            }
        }
    }
    points.truncate(limit.clamp(1, 40));
    let mut gaps = Vec::<String>::new();
    for gap in points
        .iter()
        .flat_map(|point| point["gaps"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
    {
        if !gaps.iter().any(|existing| existing == gap) {
            gaps.push(gap.into());
        }
    }
    let mut limitations = vec![
        "单季度直接取东财 *INCOMEQC 家族（一季度/二季度/三季度/四季度），当年累计取 *INCOME 家族（一季报/中报/三季报/年报），不做累计相减推算。".to_string(),
        "TTM 只在累计口径上有定义：上年报 + 本期累计 − 上年同期累计；年报缺失的时点返回 null，不用四季度冒充全年。".to_string(),
        "同比基于单季口径；上年同季缺失时返回 null，不做内插。".to_string(),
    ];
    if cumulative.is_empty() {
        limitations.push("本次没有取到累计家族行（*INCOME），该股票无法给出 TTM。".into());
    }
    if quarterized.is_empty() {
        limitations.push("本次没有取到单季度家族行（*INCOMEQC），该股票无法给出单季值、同比与反推 DCF 所需的季度形状。".into());
    }
    let label = |gap: &str| match gap {
        "cumulativeRevenue" => "累计营收",
        "cumulativeNetProfit" => "累计净利",
        "quarterRevenue" => "单季营收",
        "quarterNetProfit" => "单季净利",
        "ttmRevenue" => "TTM 营收",
        "ttmNetProfit" => "TTM 净利",
        "revenueYoY" => "营收同比",
        "netProfitYoY" => "净利同比",
        _ => "未知字段",
    };
    limitations.push(if gaps.is_empty() {
        "返回区间内无缺失字段。".into()
    } else {
        format!(
            "返回区间内缺失字段：{}",
            gaps.iter()
                .map(|gap| label(gap))
                .collect::<Vec<_>>()
                .join("、")
        )
    });
    let complete = points.len() >= 4
        && points
            .iter()
            .all(|point| !point["ttmRevenue"].is_null() && !point["ttmNetProfit"].is_null());
    json!({"code":code,"basis":"eastmoney_income_cumulative_plus_quarterized","source":"financial_statements",
        "families":{"cumulative":!cumulative.is_empty(),"quarterized":!quarterized.is_empty()},
        "latestReportDate":points.first().map(|point|&point["reportDate"]),"points":points,"complete":complete,"limitations":limitations})
}

pub fn normalized_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter().map(|row| {
        let income:&[(&str,&[&str])] = &[
            ("revenue",&["TOTAL_OPERATE_INCOME","OPERATE_INCOME","totalOperateIncome","operateIncome"]),
            ("costOfRevenue",&["OPERATE_COST","TOTAL_OPERATE_COST","operateCost","totalOperateCost"]),
            ("grossProfit",&["GROSS_PROFIT","grossProfit"]),("operatingIncome",&["OPERATE_PROFIT","operateProfit"]),
            ("netIncome",&["NETPROFIT","netProfit"]),("parentNetIncome",&["PARENT_NETPROFIT","HOLDER_PROFIT"]),
            ("basicEps",&["BASIC_EPS","basicEps"]),("dilutedEps",&["DILUTED_EPS","dilutedEps"]),
        ];
        let balance:&[(&str,&[&str])] = &[("totalAssets",&["TOTAL_ASSETS","totalAssets","totaAssets"]),
            ("totalLiabilities",&["TOTAL_LIABILITIES","totalLiabilities"]),("totalEquity",&["TOTAL_EQUITY","totalEquity"]),
            ("cashAndCashEquivalents",&["MONETARYFUNDS","END_CCE","END_CASH","endCce"])];
        let cashflow:&[(&str,&[&str])] = &[("operatingCashFlow",&["NETCASH_OPERATE","netcashOperate"]),
            ("freeCashFlow",&["FREE_CASH_FLOW","freeCashFlow"]),("capitalExpenditure",&["CONSTRUCT_LONG_ASSET","capitalExpenditure"]),
            ("cashAndCashEquivalents",&["END_CCE","END_CASH","endCce"])];
        let metrics=match text(&row["statementType"]) {"income"=>income,"balance"=>balance,"cashflow"=>cashflow,_=>&[]};
        let payload=&row["payload"];
        let values:Vec<_>=metrics.iter().filter_map(|(metric,fields)|fields.iter().find_map(|field|strict_number(&payload[*field]).map(|value|json!({"metric":metric,"value":value,"sourceField":field})))).collect();
        let notice = text(nullish(&[&payload["NOTICE_DATE"],&payload["noticeDate"]]));
        let notice = (!notice.is_empty()).then(||notice.chars().take(10).collect::<String>());
        let currency = text(nullish(&[&payload["CURRENCY"],&payload["CURRENCY_TYPE"],&payload["currency"]])).trim();
        json!({"code":row["code"],"statementType":row["statementType"],"reportDate":row["reportDate"],"fiscalPeriod":row["fiscalPeriod"],
            "noticeDate":notice,"source":row["source"],"updatedAt":row["updatedAt"],"currency":(!currency.is_empty()).then_some(currency),"values":values})
    }).collect()
}

pub fn common_equity(payload: &Value) -> Value {
    let read = |fields: &[&str]| {
        fields.iter().find_map(|field| {
            strict_number(&payload[*field]).map(|value| (value, vec![field.to_string()]))
        })
    };
    let Some((parent, mut fields)) = read(&["TOTAL_PARENT_EQUITY", "totalParentEquity"]) else {
        return Value::Null;
    };
    let adjustment = if let Some(adjustment) = read(&["OTHER_EQUITY_TOOL", "otherEquityTool"]) {
        Some(adjustment)
    } else {
        let preferred = read(&["PREFERRED_SHARES"]);
        let perpetual = read(&["PERPETUAL_BOND"]);
        let other = read(&["OTHER_EQUITY_OTHER"]);
        match (preferred, perpetual) {
            (Some((preferred, mut component_fields)), Some((perpetual, perpetual_fields)))
                if payload.get("OTHER_EQUITY_OTHER").is_none() || other.is_some() =>
            {
                if preferred < 0.0
                    || perpetual < 0.0
                    || other.as_ref().is_some_and(|(value, _)| *value < 0.0)
                {
                    return Value::Null;
                }
                component_fields.extend(perpetual_fields);
                let (other_value, other_fields) = other.unwrap_or((0.0, vec![]));
                component_fields.extend(other_fields);
                Some((preferred + perpetual + other_value, component_fields))
            }
            _ if [
                "OTHER_EQUITY_TOOL",
                "otherEquityTool",
                "PREFERRED_SHARES",
                "PERPETUAL_BOND",
                "OTHER_EQUITY_OTHER",
            ]
            .iter()
            .any(|field| payload.get(*field).is_some()) =>
            {
                None
            }
            _ => Some((0.0, vec![])),
        }
    };
    let Some((adjustment, adjustment_fields)) = adjustment else {
        return Value::Null;
    };
    let value = parent - adjustment;
    if adjustment < 0.0 || !value.is_finite() || value <= 0.0 {
        return Value::Null;
    }
    fields.extend(adjustment_fields);
    json!({"value":value,"sourceFields":fields})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn income(date: &str, revenue: f64, profit: f64, contract: &str, label: &str) -> Value {
        json!({"code":"TEST","statementType":"income","reportDate":date,"fiscalPeriod":label,"source":"eastmoney","updatedAt":1,
            "payload":{"FINANCIAL_SOURCE_CONTRACT":contract,"FISCAL_PERIOD":label,"REPORT_TYPE":label,"TOTAL_OPERATE_INCOME":revenue,"PARENT_NETPROFIT":profit,"dataSource":"financial_report"}})
    }
    fn hk(date: &str, profit: f64, kind: &str) -> Value {
        let mut row = income(
            date,
            profit * 3.0,
            profit,
            "eastmoney_hk_f10_main_indicator.v2",
            "",
        );
        row["payload"]["DATE_TYPE_CODE"] = json!(kind);
        row
    }
    #[test]
    fn fiscal_calendar_and_missing_annual_evidence() {
        let rows = vec![
            hk("2026-06-30", 106.14, "003"),
            hk("2026-03-31", 1035.92, "001"),
            hk("2025-12-31", 780.51, "004"),
            hk("2025-06-30", 406.49, "003"),
        ];
        assert!(
            (trailing_twelve_months(&rows, "PARENT_NETPROFIT")
                .as_f64()
                .unwrap()
                - 735.57)
                .abs()
                < 1e-9
        );
        assert_eq!(
            annual_base_for(&rows, "2026-06-30").unwrap()["reportDate"],
            "2026-03-31"
        );
        assert_eq!(
            prior_same_period_for(&rows, &rows[0], &rows[1]).unwrap()["reportDate"],
            "2025-06-30"
        );
        let no_annual: Vec<_> = rows
            .iter()
            .filter(|row| !is_fiscal_year(row))
            .cloned()
            .collect();
        assert!(trailing_twelve_months(&no_annual, "PARENT_NETPROFIT").is_null());
        assert_eq!(
            shift_months("2024-02-29", -12).as_deref(),
            Some("2023-02-28")
        );
        assert_eq!(shift_months("2026-03-31", 3).as_deref(), Some("2026-06-30"));
        assert_eq!(shift_months("2026-01-31", 1).as_deref(), Some("2026-02-28"));
        let series = quarterly_series("TEST", &rows, 40);
        assert_eq!(
            series["families"],
            json!({"cumulative":true,"quarterized":false})
        );
        assert!((series["points"][0]["ttmNetProfit"].as_f64().unwrap() - 735.57).abs() < 1e-9);
        assert!(series["points"][0]["quarterNetProfit"].is_null());
    }
    #[test]
    fn annual_and_q4_keep_distinct_readings_with_full_history_yoy() {
        let cumulative = "eastmoney_f10_income.v1";
        let quarter = "eastmoney_f10_incomeqc.v1";
        let annual = "eastmoney_f10_annual_income.v1";
        let rows = vec![
            income("2026-06-30", 40.0, 12.0, cumulative, "中报"),
            income("2026-06-30", 25.0, 7.0, quarter, "二季度"),
            income("2025-12-31", 21.0, 7.0, quarter, "四季度"),
            income("2025-12-31", 60.0, 20.0, annual, "12M"),
            income("2025-06-30", 24.0, 8.0, cumulative, "中报"),
            income("2025-06-30", 14.0, 4.0, quarter, "二季度"),
        ];
        let series = quarterly_series("TEST", &rows, 1);
        let first = &series["points"][0];
        assert_eq!(first["cumulativeRevenue"].as_f64(), Some(40.0));
        assert_eq!(first["quarterRevenue"].as_f64(), Some(25.0));
        assert_eq!(first["ttmRevenue"].as_f64(), Some(76.0));
        assert_eq!(first["ttmNetProfit"].as_f64(), Some(24.0));
        assert!((first["revenueYoY"].as_f64().unwrap() - (25.0 / 14.0 - 1.0)).abs() < 1e-9);
        assert_eq!(first["ttmBasis"], "cumulative_roll");
        let no_annual: Vec<_> = rows
            .iter()
            .filter(|row| !is_formal_annual_income(row))
            .cloned()
            .collect();
        assert!(quarterly_series("TEST", &no_annual, 8)["points"][0]["ttmRevenue"].is_null());
        let yearly = annual_income_statements(&rows);
        assert_eq!(yearly.len(), 1);
        assert_eq!(yearly[0]["netProfit"].as_f64(), Some(20.0));
    }
    #[test]
    fn formal_report_outranks_flash_and_non_quarter_dates_are_ignored() {
        let formal = income("2026-06-30", 40.0, 12.0, "eastmoney_f10_income.v1", "中报");
        let mut flash = formal.clone();
        flash["payload"]["TOTAL_OPERATE_INCOME"] = json!(41);
        flash["payload"]["dataSource"] = json!("performance_report");
        let noise = income("2026-05-31", 99.0, 99.0, "eastmoney_f10_income.v1", "五月");
        let result = quarterly_series("TEST", &[flash, noise, formal], 40);
        assert_eq!(result["points"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["points"][0]["cumulativeRevenue"].as_f64(),
            Some(40.0)
        );
        assert!(!result["points"][0]["provisional"].as_bool().unwrap());
    }
    #[test]
    fn normalization_never_synthesizes_values_or_accepts_numeric_strings() {
        let row = json!({"code":"TEST","statementType":"income","reportDate":"2026-06-30","fiscalPeriod":"6M","updatedAt":1,"source":"eastmoney",
            "payload":{"TOTAL_OPERATE_INCOME":"100","OPERATE_INCOME":90,"PARENT_NETPROFIT":0,"NOTICE_DATE":"2026-08-01 00:00:00","CURRENCY":" CNY "}});
        let normalized = normalized_rows(&[row]);
        let values = normalized[0]["values"].as_array().unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["sourceField"], "OPERATE_INCOME");
        assert_eq!(values[0]["value"].as_f64(), Some(90.0));
        assert_eq!(normalized[0]["currency"], "CNY");
        assert_eq!(normalized[0]["noticeDate"], "2026-08-01");
    }
    #[test]
    fn common_share_equity_excludes_other_instruments_once_and_fails_closed() {
        let result = common_equity(
            &json!({"TOTAL_PARENT_EQUITY":100,"OTHER_EQUITY_TOOL":20,"PREFERRED_SHARES":8,"PERPETUAL_BOND":12}),
        );
        assert_eq!(result["value"].as_f64(), Some(80.0));
        assert_eq!(
            result["sourceFields"],
            json!(["TOTAL_PARENT_EQUITY", "OTHER_EQUITY_TOOL"])
        );
        assert_eq!(
            common_equity(
                &json!({"TOTAL_PARENT_EQUITY":100,"PREFERRED_SHARES":8,"PERPETUAL_BOND":12})
            )["value"]
                .as_f64(),
            Some(80.0)
        );
        for payload in [
            json!({"TOTAL_EQUITY":100}),
            json!({"TOTAL_PARENT_EQUITY":100,"OTHER_EQUITY_TOOL":null}),
            json!({"TOTAL_PARENT_EQUITY":100,"PREFERRED_SHARES":8}),
            json!({"TOTAL_PARENT_EQUITY":100,"OTHER_EQUITY_TOOL":-1}),
        ] {
            assert!(common_equity(&payload).is_null());
        }
        assert_eq!(
            common_equity(&json!({"TOTAL_PARENT_EQUITY":100}))["value"].as_f64(),
            Some(100.0)
        );
    }
    #[test]
    fn contract_family_accepts_hk_but_never_yahoo_or_unknown_as_cumulative() {
        for contract in [
            "eastmoney_f10_income.v1",
            "eastmoney_f10_annual_income.v1",
            "eastmoney_hk_f10_main_indicator.v1",
            "eastmoney_hk_f10_main_indicator.v2",
        ] {
            assert!(is_cumulative_income(
                &json!({"FINANCIAL_SOURCE_CONTRACT":contract})
            ));
        }
        for contract in [
            "eastmoney_f10_incomeqc.v1",
            "yahoo_finance_timeseries.v3",
            "unknown",
            "",
        ] {
            assert!(!is_cumulative_income(
                &json!({"FINANCIAL_SOURCE_CONTRACT":contract})
            ));
        }
        let cashflow = json!({"statementType":"cashflow","payload":{"REPORT_TYPE":"年报"}});
        assert!(is_fiscal_year(&cashflow));
        assert_eq!(
            previous_quarter_end("2026-03-31").as_deref(),
            Some("2025-12-31")
        );
        assert!(previous_quarter_end("2026-05-31").is_none());
    }
    #[test]
    fn annual_base_ties_retain_first_row_and_annual_wins_over_q4() {
        let first = income(
            "2025-12-31",
            60.0,
            20.0,
            "eastmoney_f10_annual_income.v1",
            "12M",
        );
        let revised = income(
            "2025-12-31",
            61.0,
            21.0,
            "eastmoney_f10_annual_income.v1",
            "12M",
        );
        assert_eq!(annual_base_for(&[first.clone(), revised.clone()], "2026-06-30").unwrap()["payload"]["PARENT_NETPROFIT"].as_f64(), Some(20.0));
        let quarter = income(
            "2025-12-31",
            21.0,
            7.0,
            "eastmoney_f10_incomeqc.v1",
            "四季度",
        );
        assert_eq!(
            trailing_twelve_months(&[quarter, first, revised], "PARENT_NETPROFIT").as_f64(),
            Some(20.0)
        );
    }
    #[test]
    fn cashflow_ttm_uses_reported_fiscal_year_and_all_three_required_values() {
        let cashflow = |date: &str, value: Value, label: &str| json!({"statementType":"cashflow","reportDate":date,"payload":{"REPORT_TYPE":label,"CONSTRUCT_LONG_ASSET":value}});
        let mut rows = vec![
            cashflow("2026-06-30", json!(227.44), "中报"),
            cashflow("2025-12-31", json!(281.41), "年报"),
            cashflow("2025-06-30", json!(72.01), "中报"),
        ];
        assert!(
            (trailing_twelve_months(&rows, "CONSTRUCT_LONG_ASSET")
                .as_f64()
                .unwrap()
                - 436.84)
                .abs()
                < 1e-9
        );
        rows[2]["payload"]["CONSTRUCT_LONG_ASSET"] = Value::Null;
        assert!(trailing_twelve_months(&rows, "CONSTRUCT_LONG_ASSET").is_null());
    }
}
