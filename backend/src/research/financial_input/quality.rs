//! Deterministic research-financial quality, preserving source/basis lineage.
#[path = "quality/observations.rs"]
mod observations;
#[path = "quality/series.rs"]
mod series;

use anyhow::{Result, bail};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

pub const RULE_VERSION: &str = "research-financial-quality.v2";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Period {
    kind: String,
    start_date: String,
    end_date: String,
    fiscal_year: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fiscal_quarter: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Basis {
    id: String,
    currency: String,
    accounting_standard: String,
    scope: String,
    revision: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputRef {
    fact_id: String,
    provenance: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fact {
    id: String,
    metric: String,
    period: Period,
    value: Option<f64>,
    basis: Basis,
    provenance: Value,
    #[serde(default)]
    derivation_formula: Option<String>,
    #[serde(default)]
    derivation_status: Option<String>,
    #[serde(default)]
    derivation_reason_codes: Option<Vec<String>>,
    #[serde(default)]
    input_references: Option<Vec<InputRef>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    period: Period,
    status: String,
    value: Option<f64>,
    formula: String,
    reason_codes: Vec<String>,
    inputs: Vec<InputRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Series {
    metric: String,
    frequency: String,
    basis: Basis,
    unit: String,
    points: Vec<Point>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    id: String,
    kind: String,
    metric: String,
    frequency: String,
    basis: Basis,
    period: Period,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comparison_period: Option<Period>,
    status: String,
    value: Option<f64>,
    unit: String,
    formula: String,
    reason_codes: Vec<String>,
    inputs: Vec<InputRef>,
}

/// Compatibility helper for already-validated normalized source facts.
/// Runtime call sites use `try_build` so validation failures remain Results.
pub fn build(facts: &[Value], entity_type: &str) -> Value {
    try_build(facts, entity_type)
        .expect("financial facts must be validated before deterministic quality calculation")
}

pub fn try_build(facts: &[Value], entity_type: &str) -> Result<Value> {
    for fact in facts {
        if !fact
            .get("value")
            .is_some_and(|value| value.is_null() || value.as_f64().is_some_and(f64::is_finite))
        {
            bail!(
                "financial fact value must be finite or null: {}",
                fact["id"].as_str().unwrap_or("")
            );
        }
    }
    let facts = facts
        .iter()
        .cloned()
        .map(serde_json::from_value::<Fact>)
        .collect::<serde_json::Result<Vec<_>>>()?;
    validate_facts(&facts)?;
    let mut normalized = series::normalized(&facts);
    let ttm = series::ttm(&normalized);
    normalized.extend(ttm);
    normalized.sort_by(|left, right| {
        basis_key(&left.basis)
            .cmp(&basis_key(&right.basis))
            .then_with(|| left.metric.cmp(&right.metric))
            .then_with(|| left.frequency.cmp(&right.frequency))
    });
    let trends = normalized
        .iter()
        .flat_map(series::trends)
        .collect::<Vec<_>>();
    let observations = observations::build(
        &normalized,
        &facts,
        if entity_type.is_empty() {
            "non_financial"
        } else {
            entity_type
        },
    );
    let gaps = trends.iter().chain(&observations).filter(|item|item.status!="available")
        .map(|item|json!({"observationId":item.id,"status":item.status,"reasonCodes":item.reason_codes})).collect::<Vec<_>>();
    Ok(
        json!({"ruleVersion":RULE_VERSION,"series":normalized,"trends":trends,"observations":observations,"gaps":gaps}),
    )
}

fn validate_facts(facts: &[Fact]) -> Result<()> {
    let mut ids = HashSet::new();
    let date = regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap();
    for fact in facts {
        if fact.id.trim().is_empty() || !ids.insert(fact.id.clone()) {
            bail!(
                "financial fact id must be non-empty and unique: {}",
                fact.id
            );
        }
        if fact.value.is_some_and(|value| !value.is_finite()) {
            bail!("financial fact value must be finite or null: {}", fact.id);
        }
        if [
            &fact.basis.id,
            &fact.basis.currency,
            &fact.basis.accounting_standard,
            &fact.basis.scope,
            &fact.basis.revision,
        ]
        .iter()
        .any(|value| value.trim().is_empty())
        {
            bail!("financial fact basis is incomplete: {}", fact.id);
        }
        if ["sourceId", "sourceType"].iter().any(|key| {
            fact.provenance[key]
                .as_str()
                .unwrap_or("")
                .trim()
                .is_empty()
        }) {
            bail!("financial fact provenance is incomplete: {}", fact.id);
        }
        if !date.is_match(&fact.period.start_date)
            || !date.is_match(&fact.period.end_date)
            || fact.period.start_date > fact.period.end_date
        {
            bail!("financial fact period is invalid: {}", fact.id);
        }
        if fact.period.kind == "quarter"
            && !fact
                .period
                .fiscal_quarter
                .is_some_and(|quarter| (1..=4).contains(&quarter))
        {
            bail!(
                "quarterly financial fact requires fiscalQuarter: {}",
                fact.id
            );
        }
        if fact.period.kind == "annual" && fact.period.fiscal_quarter.is_some() {
            bail!(
                "annual financial fact cannot have fiscalQuarter: {}",
                fact.id
            );
        }
    }
    Ok(())
}

fn aggregation(metric: &str) -> &'static str {
    match metric {
        "cash"
        | "total_debt"
        | "total_equity"
        | "total_assets"
        | "current_assets"
        | "current_liabilities"
        | "trade_receivables"
        | "contract_assets"
        | "inventory"
        | "trade_payables"
        | "short_term_debt"
        | "long_term_debt"
        | "lease_liabilities"
        | "diluted_shares" => "ending",
        "diluted_weighted_average_shares" => "average",
        _ => "sum",
    }
}
fn metric_unit(metric: &str, basis: &Basis) -> String {
    if matches!(metric, "diluted_weighted_average_shares" | "diluted_shares") {
        "shares".into()
    } else {
        basis.currency.clone()
    }
}
fn basis_key(basis: &Basis) -> String {
    [
        &basis.id,
        &basis.currency,
        &basis.accounting_standard,
        &basis.scope,
        &basis.revision,
    ]
    .iter()
    .map(|s| s.as_str())
    .collect::<Vec<_>>()
    .join("~")
}
fn period_key(period: &Period) -> String {
    if period.kind == "annual" {
        format!("FY{}:{}", period.fiscal_year, period.end_date)
    } else {
        format!(
            "FY{}Q{}:{}",
            period.fiscal_year,
            period.fiscal_quarter.unwrap_or(0),
            period.end_date
        )
    }
}
fn quarter_index(period: &Period) -> i32 {
    period.fiscal_year * 4 + i32::from(period.fiscal_quarter.unwrap_or(4)) - 1
}
fn period_index(period: &Period) -> i32 {
    if period.kind == "annual" {
        period.fiscal_year
    } else {
        quarter_index(period)
    }
}
fn compare_period(left: &Period, right: &Period) -> Ordering {
    left.end_date
        .cmp(&right.end_date)
        .then_with(|| period_key(left).cmp(&period_key(right)))
}
fn dedupe_refs(inputs: Vec<InputRef>) -> Vec<InputRef> {
    let mut result: Vec<InputRef> = Vec::new();
    let mut indices = HashMap::new();
    for input in inputs {
        if let Some(index) = indices.get(&input.fact_id) {
            result[*index] = input;
        } else {
            indices.insert(input.fact_id.clone(), result.len());
            result.push(input);
        }
    }
    result
}
fn dedupe_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
fn base(kind: &str, metric: &str, basis: &Basis, frequency: &str, period: &Period) -> Observation {
    Observation {
        id: format!(
            "{kind}:{metric}:{frequency}:{}:{}",
            period_key(period),
            basis_key(basis)
        ),
        kind: kind.into(),
        metric: metric.into(),
        frequency: frequency.into(),
        basis: basis.clone(),
        period: period.clone(),
        comparison_period: None,
        status: "missing".into(),
        value: None,
        unit: String::new(),
        formula: String::new(),
        reason_codes: vec![],
        inputs: vec![],
    }
}
fn prior_comparable_period(period: &Period, frequency: &str, steps: i32) -> Period {
    if frequency == "annual" {
        let year = period.fiscal_year - steps;
        return Period {
            kind: "annual".into(),
            fiscal_year: year,
            start_date: format!("{year}-01-01"),
            end_date: format!("{year}{}", period.end_date.get(4..).unwrap_or("-12-31")),
            fiscal_quarter: None,
        };
    }
    let index = quarter_index(period) - steps;
    let year = index.div_euclid(4);
    let quarter = index.rem_euclid(4) as u8 + 1;
    let month = quarter * 3;
    Period {
        kind: "quarter".into(),
        fiscal_year: year,
        fiscal_quarter: Some(quarter),
        start_date: format!("{year}-{:02}-01", month - 2),
        end_date: format!(
            "{year}-{month:02}-{}",
            if quarter == 1 || quarter == 4 {
                "31"
            } else {
                "30"
            }
        ),
    }
}
fn period_days(period: &Period) -> i64 {
    // Date.parse's ISO-date contract normalizes day 29..31 across short
    // months, but rejects zero/out-of-range components. Preserve that existing
    // source behavior rather than changing turnover metrics during the port.
    fn utc_date(value: &str) -> Option<NaiveDate> {
        let mut parts = value.split('-');
        let year = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let day: u32 = parts.next()?.parse().ok()?;
        if parts.next().is_some() || !(1..=31).contains(&day) {
            return None;
        }
        NaiveDate::from_ymd_opt(year, month, 1)?
            .checked_add_signed(chrono::Duration::days(i64::from(day - 1)))
    }
    match (utc_date(&period.start_date), utc_date(&period.end_date)) {
        (Some(start), Some(end)) => (end - start).num_days() + 1,
        _ => 0,
    }
}
fn as_point(item: &Observation) -> Point {
    Point {
        period: item.period.clone(),
        status: item.status.clone(),
        value: item.value,
        formula: item.formula.clone(),
        reason_codes: item.reason_codes.clone(),
        inputs: item.inputs.clone(),
    }
}
fn find_point<'a>(series: &'a [Series], metric: &str, period: &Period) -> Option<&'a Point> {
    series
        .iter()
        .find(|item| item.metric == metric)?
        .points
        .iter()
        .find(|point| period_key(&point.period) == period_key(period))
}
fn unique_bases(series: &[Series]) -> Vec<Basis> {
    let mut result: Vec<Basis> = vec![];
    let mut indices = HashMap::new();
    for series in series {
        let key = basis_key(&series.basis);
        if let Some(index) = indices.get(&key) {
            result[*index] = series.basis.clone()
        } else {
            indices.insert(key, result.len());
            result.push(series.basis.clone())
        }
    }
    result
}
fn unique_periods(periods: Vec<Period>) -> Vec<Period> {
    let mut result: Vec<Period> = vec![];
    let mut indices = HashMap::new();
    for period in periods {
        let key = period_key(&period);
        if let Some(index) = indices.get(&key) {
            result[*index] = period
        } else {
            indices.insert(key, result.len());
            result.push(period)
        }
    }
    result.sort_by(compare_period);
    result
}

pub fn assert_profile_record(record: &Value) -> Result<()> {
    for key in [
        "financialProfileId",
        "companyId",
        "sourceSecurityCode",
        "sourceUrl",
        "sourceTitle",
        "sourceNote",
        "recordedBy",
    ] {
        if record[key].as_str().unwrap_or("").trim().is_empty() {
            bail!("{key} is required")
        }
    }
    if ![
        "non_financial",
        "bank",
        "insurer",
        "broker",
        "financial_other",
    ]
    .contains(&record["entityType"].as_str().unwrap_or(""))
    {
        bail!("entityType is invalid")
    }
    if !regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
        .unwrap()
        .is_match(record["asOf"].as_str().unwrap_or(""))
    {
        bail!("asOf must be YYYY-MM-DD")
    }
    if ![
        "issuer_disclosure",
        "exchange_filing",
        "regulator_or_court",
        "audit_report",
    ]
    .contains(&record["sourceAuthority"].as_str().unwrap_or(""))
    {
        bail!("sourceAuthority is invalid")
    }
    if !record["sourceUrl"]
        .as_str()
        .unwrap()
        .trim()
        .to_lowercase()
        .starts_with("https://")
    {
        bail!("sourceUrl must use https")
    }
    if ["recordedAt", "createdAt"]
        .iter()
        .any(|key| !record[key].as_f64().is_some_and(f64::is_finite))
    {
        bail!("profile timestamps must be finite")
    }
    Ok(())
}

pub fn resolve_profile_records(records: &[Value]) -> Value {
    if records.is_empty() {
        return json!({"availability":"empty","status":"unknown","entityType":null,"qualityEntityType":"unknown","asOf":null,"reason":"尚无带来源的经营实体类型；不会按证券代码或名称猜测并套用非金融指标。","records":[]});
    }
    let latest = records
        .iter()
        .filter_map(|r| r["asOf"].as_str())
        .max()
        .unwrap_or("");
    let types = dedupe_strings(
        records
            .iter()
            .filter(|r| r["asOf"].as_str() == Some(latest))
            .filter_map(|r| r["entityType"].as_str().map(str::to_string))
            .collect(),
    );
    if types.len() != 1 {
        return json!({"availability":"available","status":"conflicting","entityType":null,"qualityEntityType":"unknown","asOf":latest,"reason":format!("截至 {latest} 存在互相冲突的实体类型：{}；通用非金融指标已阻断。",types.join("、")),"records":records});
    }
    let entity = &types[0];
    let non_financial = entity == "non_financial";
    json!({"availability":"available","status":"confirmed","entityType":entity,"qualityEntityType":if non_financial{"non_financial"}else{"financial"},"asOf":latest,"reason":if non_financial{"已由来源绑定记录确认非金融实体；通用指标仍需各自输入可比。"}else{"已由来源绑定记录确认金融实体；通用 FCF、营运资本、现金转换和 ROIC 指标明确不适用，专业监管指标仍待单独接入。"},"records":records})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fact() -> Value {
        json!({"id":"a","metric":"revenue","period":{"kind":"annual","startDate":"2025-01-01","endDate":"2025-12-31","fiscalYear":2025},"value":100,"basis":{"id":"cas","currency":"CNY","accountingStandard":"CAS","scope":"consolidated","revision":"reported"},"provenance":{"sourceId":"source","sourceType":"eastmoney"}})
    }
    #[test]
    fn malformed_inputs_are_rejected_without_synthetic_facts() {
        let f = fact();
        assert!(try_build(&[f.clone(), f.clone()], "unknown").is_err());
        let mut invalid = f;
        invalid["basis"]["currency"] = json!("");
        assert!(try_build(&[invalid], "unknown").is_err());
        let mut missing = fact();
        missing.as_object_mut().unwrap().remove("value");
        assert!(try_build(&[missing], "unknown").is_err());
        let mut unicode_date = fact();
        unicode_date["period"]["startDate"] = json!("２０２５-01-01");
        assert!(try_build(&[unicode_date], "unknown").is_err());
    }
    #[test]
    fn profile_conflicts_never_guess_entity_type() {
        let records = vec![
            json!({"asOf":"2026-10-29","entityType":"bank"}),
            json!({"asOf":"2026-10-29","entityType":"non_financial"}),
        ];
        let result = resolve_profile_records(&records);
        assert_eq!(result["status"], "conflicting");
        assert_eq!(result["qualityEntityType"], "unknown");
    }

    #[test]
    fn profile_validation_keeps_source_authority_and_https_contract() {
        let mut record = json!({"financialProfileId":"profile","companyId":"company","sourceSecurityCode":"600036.SH","entityType":"bank","asOf":"2026-10-29","sourceAuthority":"issuer_disclosure","sourceUrl":" HTTPS://example.com/report ","sourceTitle":"title","sourceNote":"note","recordedBy":"human","recordedAt":1,"createdAt":1});
        assert!(assert_profile_record(&record).is_ok());
        record["sourceAuthority"] = json!("provider_guess");
        assert!(assert_profile_record(&record).is_err());
        record["sourceAuthority"] = json!("issuer_disclosure");
        record["sourceUrl"] = json!("http://example.com");
        assert!(assert_profile_record(&record).is_err());
    }

    #[test]
    fn period_days_preserves_existing_iso_date_normalization() {
        let mut period: Period = serde_json::from_value(json!({"kind":"quarter","startDate":"2025-02-28","endDate":"2025-02-30","fiscalYear":2025,"fiscalQuarter":1})).unwrap();
        assert_eq!(period_days(&period), 3);
        period.end_date = "2025-13-01".into();
        assert_eq!(period_days(&period), 0);
    }
}
