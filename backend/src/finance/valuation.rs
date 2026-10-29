pub mod bands;
pub mod inputs;

use crate::{AppState, codes};
use anyhow::Result;
use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::LazyLock};

static ANNUAL_DATE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\d{4}-12-31$").unwrap());
static REPORT_DATE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static ANNUAL_PERIOD: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^(12M|FY|ANNUAL|年报)$").unwrap());
static BALANCE_ARCHETYPES: LazyLock<BTreeMap<String, &'static str>> = LazyLock::new(|| {
    let mappings: Value =
        serde_json::from_str(include_str!("../../../shared/finance-mappings.json"))
            .expect("valid finance mapping");
    let mut map = BTreeMap::new();
    for (field, archetype) in [
        ("bankCodes", "bank"),
        ("insuranceCodes", "insurer"),
        ("securityCodes", "broker"),
    ] {
        for value in mappings[field]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            map.entry(codes::normalize(value)).or_insert(archetype);
        }
    }
    map
});

// Preserve JavaScript toFixed's exact binary rounding, including decimal ties.
pub(super) fn fixed(value: f64, precision: u32) -> String {
    ryu_js::Buffer::new()
        .format_to_fixed(value, precision.min(100) as u8)
        .to_string()
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|v| v.is_finite())
}
fn first(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| payload.get(key).and_then(number))
}
fn strict_first(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| payload.get(key).and_then(finite))
}
fn nullish<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| payload.get(key).filter(|v| !v.is_null()))
}
fn coalesced_number(payload: &Value, keys: &[&str]) -> Option<f64> {
    nullish(payload, keys).and_then(finite)
}
fn provisional(row: &Value) -> bool {
    matches!(
        row["payload"]["dataSource"].as_str(),
        Some("performance_report" | "performance_forecast")
    )
}

pub fn balance_sheet_archetype(code: &str) -> &'static str {
    BALANCE_ARCHETYPES
        .get(&codes::normalize(code))
        .copied()
        .unwrap_or("non_financial")
}

pub fn select_period_rows(rows: &[Value]) -> Value {
    let Some(latest) = rows.first() else {
        return json!({"latest":null,"priorYearSamePeriod":null,"priorFiscalYear":null,"currentFiscalYearSamePeriod":null});
    };
    let date = latest["reportDate"].as_str().unwrap_or("");
    let Some(parsed) = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok() else {
        return json!({"latest":latest,"priorYearSamePeriod":null,"priorFiscalYear":null,"currentFiscalYearSamePeriod":null});
    };
    let prior = format!(
        "{}-{:02}-{:02}",
        parsed.year() - 1,
        parsed.month(),
        parsed.day()
    );
    let annual = format!("{}-12-31", parsed.year() - 1);
    let same = rows
        .iter()
        .find(|r| r["reportDate"].as_str() == Some(&prior));
    json!({"latest":latest,"priorYearSamePeriod":same,"priorFiscalYear":rows.iter().find(|r|r["reportDate"].as_str()==Some(&annual)),"currentFiscalYearSamePeriod":if prior.ends_with("12-31"){None}else{same}})
}

pub async fn valuation_inputs(state: &AppState, raw_code: &str) -> Result<Value> {
    let code = codes::normalize(raw_code);
    let (income, balance, cashflow) = tokio::join!(
        super::providers::load(state, &code, "income"),
        super::providers::load(state, &code, "balance"),
        super::providers::load(state, &code, "cashflow")
    );
    let income = select_period_rows(&income.map(|r| r.1).unwrap_or_default());
    let balance = select_period_rows(&balance.map(|r| r.1).unwrap_or_default());
    let cashflow = select_period_rows(&cashflow.map(|r| r.1).unwrap_or_default());
    Ok(inputs::build(
        &json!({"code":code,"income":income,"balance":balance,"cashflow":cashflow,"balanceSheetArchetype":balance_sheet_archetype(&code),"provisional":provisional(&income["latest"])}),
    ))
}

pub async fn mid_cycle_history(state: &AppState, code: &str) -> Result<Value> {
    mid_cycle_history_with_years(state, code, None).await
}
pub async fn mid_cycle_history_with_years(
    state: &AppState,
    raw_code: &str,
    years: Option<f64>,
) -> Result<Value> {
    let code = codes::normalize(raw_code);
    if [".SH", ".SZ", ".BJ"].iter().any(|s| code.ends_with(s)) {
        let dates = (0..11)
            .map(|i| format!("{}-12-31", Utc::now().year() - 1 - i))
            .collect::<Vec<_>>()
            .join("','");
        let parameters = [
            ("type".into(), "RPT_F10_FINANCE_GINCOME".into()),
            ("sty".into(), "APP_F10_GINCOME".into()),
            (
                "filter".into(),
                format!("(SECUCODE=\"{code}\")(REPORT_DATE in ('{dates}'))"),
            ),
            ("p".into(), "1".into()),
            ("ps".into(), "".into()),
            ("sr".into(), "-1".into()),
            ("st".into(), "REPORT_DATE".into()),
            ("source".into(), "HSF10".into()),
            ("client".into(), "PC".into()),
        ];
        if let Ok(rows) = crate::eastmoney::data_rows(
            state,
            "https://datacenter-web.eastmoney.com/securities/api/data/get",
            &parameters,
            86_400_000,
        )
        .await
            && !rows.is_empty()
        {
            let rows = rows
                .iter()
                .map(|row| annual_row(row, false))
                .collect::<Vec<_>>();
            return Ok(
                json!({"code":code,"source":"eastmoney_annual","earnings":build_mid_cycle(&json!({"rows":rows,"years":years}))}),
            );
        }
    }
    let rows = super::providers::load(state, &code, "income")
        .await
        .map(|r| r.1)
        .unwrap_or_default();
    let rows = rows
        .iter()
        .map(|row| annual_row(row, true))
        .collect::<Vec<_>>();
    Ok(
        json!({"code":code,"source":"snapshot","earnings":build_mid_cycle(&json!({"rows":rows,"years":years}))}),
    )
}

fn annual_row(row: &Value, statement: bool) -> Value {
    let payload = if statement { &row["payload"] } else { row };
    let date = if statement {
        row["reportDate"].as_str().unwrap_or("")
    } else {
        payload["REPORT_DATE"]
            .as_str()
            .unwrap_or("")
            .get(..10)
            .unwrap_or("")
    };
    json!({"reportDate":date,"isAnnual":date.ends_with("12-31"),
        "parentNetProfit":coalesced_number(payload,&["PARENT_NETPROFIT","HOLDER_PROFIT","parentNetprofit"]),"netProfit":coalesced_number(payload,&["NETPROFIT","netProfit"]),
        "operatingProfit":coalesced_number(payload,&["OPERATE_PROFIT","operateProfit"]),"investIncome":coalesced_number(payload,&["INVEST_INCOME","investIncome"]),"fairValueChangeIncome":coalesced_number(payload,&["FAIRVALUE_CHANGE_INCOME","fairvalueChangeIncome"])})
}

pub fn build_mid_cycle(input: &Value) -> Value {
    let basis = input["basis"].as_str().unwrap_or("net_income_parent");
    let mut annual: BTreeMap<i32, &Value> = BTreeMap::new();
    for row in input["rows"].as_array().into_iter().flatten() {
        let date = row["reportDate"].as_str().unwrap_or("");
        if row["isAnnual"] == true
            && ANNUAL_DATE.is_match(date)
            && let Ok(year) = date[..4].parse::<i32>()
        {
            annual.entry(year).or_insert(row);
        }
    }
    let latest = finite(&input["latestFiscalYear"]).unwrap_or_else(|| {
        annual
            .keys()
            .next_back()
            .copied()
            .unwrap_or(Utc::now().year() - 1) as f64
    });
    let span = finite(&input["years"]).unwrap_or(10.0).clamp(5.0, 10.0);
    let first_year = latest - span + 1.0;
    let mut years = Vec::new();
    let mut missing = Vec::new();
    let mut year = latest;
    while year >= first_year {
        let row = annual.get(&(year as i32));
        let value = row.and_then(|row| match basis {
            "net_income_parent" => {
                finite(&row["parentNetProfit"]).or_else(|| finite(&row["netProfit"]))
            }
            "net_income_total" => {
                finite(&row["netProfit"]).or_else(|| finite(&row["parentNetProfit"]))
            }
            _ => finite(&row["operatingProfit"]).map(|n| {
                n - finite(&row["investIncome"]).unwrap_or(0.0)
                    - finite(&row["fairValueChangeIncome"]).unwrap_or(0.0)
            }),
        });
        if let Some(value) = value {
            years.push(
                json!({"fiscalYear":year,"value":value,"reportDate":row.unwrap()["reportDate"]}),
            );
        } else {
            missing.push(year);
        }
        year -= 1.0;
    }
    years.reverse();
    let window = format!("{first_year}..{latest}");
    let mut notes = Vec::new();
    if !missing.is_empty() {
        notes.push(format!(
            "窗口内缺 {} 个年度（{}），未插值、未用季度或 TTM 补齐。",
            missing.len(),
            missing
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    if years.len() < 5 {
        notes.push(format!(
            "可用年报仅 {} 个，少于中枢所需的最少 5 个，不给中枢值。",
            years.len()
        ));
        return json!({"status":"insufficient_data","basis":basis,"years":years,"missingYears":missing,"window":window,"mean":null,"median":null,"min":null,"max":null,"coefficientOfVariation":null,"lossYears":[],"peakToCentre":null,"notes":notes});
    }
    let values = years
        .iter()
        .map(|r| r["value"].as_f64().unwrap())
        .collect::<Vec<_>>();
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let mut sorted = values.clone();
    sorted.sort_by(f64::total_cmp);
    let count = sorted.len();
    let median = if count % 2 == 1 {
        sorted[count / 2]
    } else {
        (sorted[count / 2 - 1] + sorted[count / 2]) / 2.0
    };
    let min = sorted[0];
    let max = sorted[count - 1];
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / count as f64;
    let variation = (mean.abs() > 0.0).then(|| variance.sqrt() / mean.abs());
    let losses = years
        .iter()
        .filter(|r| r["value"].as_f64().unwrap() < 0.0)
        .map(|r| r["fiscalYear"].clone())
        .collect::<Vec<_>>();
    let peak = (median > 0.0).then_some(max / median);
    if !losses.is_empty() {
        notes.push(format!(
            "窗口内有 {} 个亏损年度（{}），亏损年已计入中枢，不能剔除。",
            losses.len(),
            losses
                .iter()
                .map(|v| format!("{}", v.as_f64().unwrap()))
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    if mean > 0.0 && (mean - median).abs() / mean > 0.3 {
        notes.push(format!(
            "均值与中位数相差 {}%，说明单一年份主导，优先参考中位数。",
            fixed((mean - median).abs() / mean * 100.0, 0)
        ));
    }
    if let Some(cv) = variation.filter(|v| *v > 0.5) {
        notes.push(format!(
            "年度利润变异系数 {}，周期波动极大，中枢本身的不确定性很高。",
            fixed(cv, 2)
        ));
    }
    if let Some(peak) = peak.filter(|v| *v > 2.5) {
        notes.push(format!(
            "峰值是中枢的 {} 倍，TTM 若处在峰值附近会严重低估倍数。",
            fixed(peak, 1)
        ));
    }
    notes.push("周期中枢用年报口径，仅适用于业务模型被判定为周期型的公司；非周期公司使用中枢会抹掉真实成长。".into());
    json!({"status":"available","basis":basis,"years":years,"missingYears":missing,"window":window,"mean":mean,"median":median,"min":min,"max":max,"coefficientOfVariation":variation,"lossYears":losses,"peakToCentre":peak,"notes":notes})
}

pub async fn valuation_bands(state: &AppState, code: &str) -> Result<Value> {
    let cap = crate::company::eastmoney_overview(state, code)
        .await
        .ok()
        .and_then(|v| finite(&v["marketCapYi"]))
        .map(|v| v * 100_000_000.0);
    valuation_bands_with_market_cap(state, code, cap).await
}

pub async fn valuation_bands_with_market_cap(
    state: &AppState,
    raw_code: &str,
    market_cap: Option<f64>,
) -> Result<Value> {
    let code = codes::normalize(raw_code);
    let archetype = crate::coverage::company_archetype(&code).unwrap_or_else(|| "other".into());
    let (inputs, income, cashflow, balance) = tokio::join!(
        valuation_inputs(state, &code),
        super::read_model(state, &code, "income"),
        super::read_model(state, &code, "cashflow"),
        super::read_model(state, &code, "balance")
    );
    let inputs = inputs?;
    let income = income?;
    let cashflow = cashflow?;
    let balance = balance?;
    let empty = Vec::new();
    let income_rows = income["rows"].as_array().unwrap_or(&empty);
    let cashflow_rows = cashflow["rows"].as_array().unwrap_or(&empty);
    let balance_rows = balance["rows"].as_array().unwrap_or(&empty);
    let latest = derive_latest(
        &json!({"marketCapitalization":market_cap,"incomeRows":income_rows,"cashflowRows":cashflow_rows,"balanceRows":balance_rows}),
    );
    let line = |key: &str| -> Option<f64> {
        inputs["lines"]
            .as_array()?
            .iter()
            .find(|r| r["key"].as_str() == Some(key))
            .and_then(|r| finite(&r["value"]))
    };
    let ebit = line("ebit");
    let ebitda = line("ebitda");
    let capex = super::series::ttm_value(cashflow_rows, |row| {
        finite(&row["payload"]["CONSTRUCT_LONG_ASSET"])
    });
    let cumulative = income_rows
        .iter()
        .filter(|r| super::series::is_cumulative_income(&r["payload"]))
        .cloned()
        .collect::<Vec<_>>();
    let profit = super::series::ttm_value(&cumulative, |r| {
        strict_first(&r["payload"], &["PARENT_NETPROFIT", "NETPROFIT"])
    });
    let revenue = super::series::ttm_value(&cumulative, |r| {
        strict_first(&r["payload"], &["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"])
    });
    let mid = if archetype == "cyclical_commodity" {
        Some(mid_cycle_history(state, &code).await?)
    } else {
        None
    };
    let mid=mid.as_ref().map(|v|{let earnings=&v["earnings"];json!({"status":earnings["status"],"mean":earnings["mean"],"median":earnings["median"],"window":if earnings["status"]=="available"{earnings["window"].clone()}else{Value::Null},"years":earnings["years"],"notes":earnings["notes"]})});
    let debt_keys = [
        "shortLoan",
        "noncurrentLiab1year",
        "longLoan",
        "bondPayable",
        "leaseLiab",
        "shortLeaseLiab",
    ];
    let debt_incomplete = inputs["gaps"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|g| g["key"].as_str().is_some_and(|k| debt_keys.contains(&k)));
    let input = json!({"code":code,"archetype":archetype,"asOf":{"income":latest["basis"]["income"]["reportDate"],"balance":latest["basis"]["balance"]["reportDate"],"cashflow":latest["basis"]["cashflow"]["reportDate"]},
        "ttm":{"netProfit":profit,"revenue":revenue,"operatingCashFlow":line("operatingCashFlow"),"ebit":ebit,"ebitda":ebitda,"freeCashFlow":line("operatingCashFlow").zip(capex).map(|(a,b)|a-b)},
        "balance":{"parentEquity":line("parentEquity"),"commonEquity":line("commonEquity"),"grossDebt":line("grossDebtDisclosed"),"cash":line("cashDisclosed"),"minorityEquity":line("minorityEquity"),"debtIncomplete":debt_incomplete},
            "forward":null,"marketCap":market_cap,"capitalIntensity":ebit.zip(ebitda).filter(|(a,b)|*a>0.0 && *b!=0.0).map(|(a,b)|json!({"depreciationToEbit":(b-a)/a})),"midCycle":mid});
    let mut model = bands::build(&input);
    if income_rows.first().is_some_and(provisional)
        && let Some(warnings) = model["warnings"].as_array_mut()
    {
        warnings.push(json!("最新利润表是业绩快报/预告口径，区间应视为临时值。"));
    }
    Ok(model)
}

fn timestamp(value: &Value) -> Option<i64> {
    if let Some(n) = finite(value) {
        return Some(n as i64);
    }
    let s = value.as_str()?;
    if s.len() == 10 {
        return NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| {
            d.and_hms_milli_opt(23, 59, 59, 999)
                .unwrap()
                .and_utc()
                .timestamp_millis()
        });
    }
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
        .or_else(|| {
            ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"]
                .iter()
                .find_map(|format| {
                    NaiveDateTime::parse_from_str(s, format)
                        .ok()
                        .and_then(|date| Local.from_local_datetime(&date).earliest())
                        .map(|d| d.timestamp_millis())
                })
        })
}
fn date_text(value: &Value) -> Option<String> {
    let text = value.as_str()?.get(..10)?;
    REPORT_DATE.is_match(text).then(|| text.to_string())
}
fn report_date(row: &Value) -> String {
    row.get("reportDate")
        .filter(|v| !v.is_null())
        .or_else(|| row["payload"].get("REPORT_DATE"))
        .and_then(date_text)
        .unwrap_or_default()
}
fn source(row: &Value) -> &'static str {
    match row["payload"]["dataSource"].as_str() {
        Some("performance_report") => "performance_report",
        Some("performance_forecast") => "performance_forecast",
        _ => "financial_report",
    }
}
fn available(row: &Value) -> i64 {
    timestamp(
        nullish(&row["payload"], &["NOTICE_DATE", "noticeDate"])
            .unwrap_or(&json!(report_date(row))),
    )
    .unwrap_or(i64::MAX)
}
fn annual_flow(row: &Value) -> bool {
    if row["statementType"] == "income" && super::series::is_formal_annual_income(row) {
        return true;
    }
    let period = row
        .get("fiscalPeriod")
        .filter(|v| !v.is_null())
        .or_else(|| nullish(&row["payload"], &["FISCAL_PERIOD", "REPORT_TYPE"]))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    ANNUAL_PERIOD.is_match(period)
}
fn rank(row: &Value) -> i32 {
    match source(row) {
        "financial_report" => 3,
        "performance_report" => 2,
        _ => 1,
    }
}
fn compare(left: &Value, right: &Value) -> std::cmp::Ordering {
    rank(right)
        .cmp(&rank(left))
        .then_with(|| available(right).cmp(&available(left)))
        .then_with(|| {
            number(&right["updatedAt"])
                .partial_cmp(&number(&left["updatedAt"]))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| annual_flow(right).cmp(&annual_flow(left)))
}
fn effective(rows: &[Value], at: i64) -> Vec<Value> {
    let mut selected: BTreeMap<String, Value> = BTreeMap::new();
    for row in rows {
        let date = report_date(row);
        if date.is_empty() || available(row) > at {
            continue;
        }
        let key = if row["statementType"] == "income" && annual_flow(row) {
            format!("annual:{date}")
        } else {
            date
        };
        if selected
            .get(&key)
            .is_none_or(|current| compare(row, current).is_lt())
        {
            selected.insert(key, row.clone());
        }
    }
    let mut rows = selected.into_values().collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        report_date(b)
            .cmp(&report_date(a))
            .then_with(|| compare(a, b))
    });
    rows
}

pub fn derive_latest(input: &Value) -> Value {
    let at = timestamp(&input["availableAt"]).unwrap_or_else(|| Utc::now().timestamp_millis());
    let extract =
        |key: &str| effective(input[key].as_array().map(Vec::as_slice).unwrap_or(&[]), at);
    let income = extract("incomeRows");
    let balance = extract("balanceRows");
    let cashflow = extract("cashflowRows");
    let cap = number(&input["marketCapitalization"]).filter(|v| *v > 0.0);
    let ttm = |rows: &[Value], keys: &[&str]| {
        super::series::ttm_value(rows, |row| first(&row["payload"], keys))
    };
    let profit = ttm(
        &income,
        &[
            "cumulativeParentNetprofit",
            "PARENT_NETPROFIT",
            "HOLDER_PROFIT",
            "NETPROFIT",
            "parentNetprofit",
            "netProfit",
        ],
    );
    let revenue = ttm(
        &income,
        &[
            "cumulativeTotalOperateIncome",
            "TOTAL_OPERATE_INCOME",
            "OPERATE_INCOME",
            "totalOperateIncome",
            "operateIncome",
        ],
    );
    let cash = ttm(
        &cashflow,
        &[
            "cumulativeNetcashOperate",
            "NETCASH_OPERATE",
            "netcashOperate",
        ],
    );
    let equity = balance
        .first()
        .and_then(|row| finite(&super::series::common_equity(&row["payload"])["value"]));
    let quotient = |denominator: Option<f64>| {
        cap.zip(denominator.filter(|n| *n > 0.0))
            .map(|(a, b)| a / b)
    };
    let basis = |row: Option<&Value>| {
        row.map(|row| {
            let notice =
                nullish(&row["payload"], &["NOTICE_DATE", "noticeDate"]).and_then(date_text);
            json!({"reportDate":report_date(row),"noticeDate":notice,"source":source(row)})
        })
    };
    json!({"source":"financial-statements","peTtm":quotient(profit),"pb":quotient(equity),"psTtm":quotient(revenue),"pcfTtm":quotient(cash),"basis":{"income":basis(income.first()),"balance":basis(balance.first()),"cashflow":basis(cashflow.first())}})
}

pub async fn load_latest(state: &AppState, code: &str, market_cap: Option<f64>) -> Result<Value> {
    let (income, balance, cashflow) = tokio::join!(
        super::read_model(state, code, "income"),
        super::read_model(state, code, "balance"),
        super::read_model(state, code, "cashflow")
    );
    let rows = |model: Value| {
        if model["sourceHealth"]["status"] == "failed" {
            json!([])
        } else {
            model["rows"].clone()
        }
    };
    Ok(derive_latest(
        &json!({"marketCapitalization":market_cap,"incomeRows":rows(income?),"balanceRows":rows(balance?),"cashflowRows":rows(cashflow?)}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mid_cycle_retains_losses_and_refuses_short_history() {
        let rows=(2021..=2025).map(|year|json!({"reportDate":format!("{year}-12-31"),"isAnnual":true,"parentNetProfit":if year==2021{-10}else{20}})).collect::<Vec<_>>();
        let result = build_mid_cycle(&json!({"rows":rows,"years":5}));
        assert_eq!(result["status"], "available");
        assert_eq!(result["mean"], 14.0);
        assert_eq!(result["median"], 20.0);
        assert_eq!(result["lossYears"], json!([2021.0]));
        assert_eq!(
            build_mid_cycle(&json!({"rows":rows[..4],"years":5}))["status"],
            "insufficient_data"
        );
    }
    #[test]
    fn period_selector_keeps_prior_year_comparable() {
        let rows = vec![
            json!({"reportDate":"2026-09-30"}),
            json!({"reportDate":"2025-12-31"}),
            json!({"reportDate":"2025-09-30"}),
        ];
        let result = select_period_rows(&rows);
        assert_eq!(result["priorYearSamePeriod"]["reportDate"], "2025-09-30");
        assert_eq!(result["priorFiscalYear"]["reportDate"], "2025-12-31");
    }

    #[test]
    fn notes_match_javascript_decimal_tie_rounding() {
        assert_eq!(fixed(7.25, 1), "7.3");
        assert_eq!(fixed(12.25, 1), "12.3");
        assert_eq!(fixed(1.005, 2), "1.00");
    }

    #[test]
    fn latest_multiples_use_annual_base_and_ordinary_equity_not_quote_multiples() {
        let annual = json!({"statementType":"income","reportDate":"2025-12-31","fiscalPeriod":"12M","source":"eastmoney","updatedAt":1,"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_annual_income.v1","FISCAL_PERIOD":"12M","PARENT_NETPROFIT":20,"TOTAL_OPERATE_INCOME":100,"NOTICE_DATE":"2026-03-30 00:00:00"}});
        let quarter = json!({"statementType":"income","reportDate":"2025-12-31","fiscalPeriod":"Q4","source":"eastmoney","updatedAt":2,"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_incomeqc.v1","PARENT_NETPROFIT":5,"TOTAL_OPERATE_INCOME":25,"NOTICE_DATE":"2026-03-31"}});
        let balance = json!({"statementType":"balance","reportDate":"2025-12-31","payload":{"TOTAL_PARENT_EQUITY":200,"OTHER_EQUITY_TOOL":50,"PREFERRED_SHARES":20,"PERPETUAL_BOND":30,"NOTICE_DATE":null}});
        let input = json!({"marketCapitalization":3000,"availableAt":"2027-01-01","incomeRows":[quarter,annual],"balanceRows":[balance],"cashflowRows":[]});
        let result = derive_latest(&input);
        assert_eq!(result["peTtm"], 150.0);
        assert_eq!(result["pb"], 20.0);
        assert_eq!(result["psTtm"], 30.0);
        assert_eq!(result["pcfTtm"], Value::Null);
        let mut invalid = input;
        invalid["balanceRows"][0]["payload"]["OTHER_EQUITY_TOOL"] = Value::Null;
        invalid["balanceRows"][0]["payload"]["PERPETUAL_BOND"] = Value::Null;
        assert_eq!(derive_latest(&invalid)["pb"], Value::Null);
    }
}
