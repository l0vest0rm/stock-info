use super::{CODE_VERSION, PROTOCOL_VERSION};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
const METRICS: &[&str] = &[
    "revenue",
    "gross_profit",
    "cost_of_revenue",
    "operating_profit",
    "net_profit",
    "operating_cash_flow",
    "capital_expenditure",
    "cash",
    "total_debt",
    "total_equity",
    "total_assets",
    "current_assets",
    "current_liabilities",
    "trade_receivables",
    "contract_assets",
    "inventory",
    "trade_payables",
    "short_term_debt",
    "long_term_debt",
    "lease_liabilities",
    "interest_expense",
    "dividends_paid",
    "share_repurchases",
    "share_issuance",
    "acquisition_spend",
    "diluted_weighted_average_shares",
    "diluted_shares",
];
const KINDS: &[&str] = &[
    "yoy",
    "qoq",
    "cagr",
    "gross_margin",
    "operating_margin",
    "net_margin",
    "free_cash_flow",
    "free_cash_flow_margin",
    "cash_conversion",
    "net_debt",
    "working_capital",
    "working_capital_to_revenue",
    "receivables_to_revenue",
    "inventory_to_revenue",
    "payables_to_revenue",
    "days_sales_outstanding",
    "days_inventory_outstanding",
    "days_payables_outstanding",
    "cash_conversion_cycle",
    "current_ratio",
    "quick_ratio",
    "debt_to_equity",
    "interest_coverage",
    "nopat",
    "invested_capital",
    "return_on_equity",
    "return_on_invested_capital",
    "incremental_roic",
    "net_dilution_rate",
    "net_profit_per_share",
    "free_cash_flow_per_share",
    "capital_expenditure_to_revenue",
    "net_equity_distribution",
];

pub fn period_label(period: &Value) -> String {
    match text(&period["kind"]) {
        "quarter" => format!("{}Q{}", period["fiscalYear"], period["fiscalQuarter"]),
        "annual" => format!("FY{}", period["fiscalYear"]),
        _ => text(&period["endDate"]).to_string(),
    }
}
fn period_key(period: &Value) -> (String, i64, i64) {
    (
        text(&period["endDate"]).into(),
        period["fiscalYear"].as_i64().unwrap_or(0),
        period["fiscalQuarter"].as_i64().unwrap_or(0),
    )
}
fn observation_key(value: &Value) -> ((String, i64, i64), String) {
    (period_key(&value["period"]), text(&value["id"]).into())
}
fn projected_key(value: &Value) -> (String, String) {
    (text(&value["period"]).into(), text(&value["id"]).into())
}
fn periods(series: &[&Value], frequency: &str, limit: usize) -> Vec<String> {
    let mut values = strings(
        series
            .iter()
            .filter(|s| s["frequency"] == frequency)
            .flat_map(|s| {
                array(&s["points"])
                    .iter()
                    .map(|p| period_label(&p["period"]))
            }),
    );
    let start = values.len().saturating_sub(limit);
    values.drain(..start);
    values
}
fn latest_end(series: &[&Value], frequency: &str) -> Option<String> {
    series
        .iter()
        .filter(|s| s["frequency"] == frequency)
        .flat_map(|s| array(&s["points"]))
        .filter_map(|p| p["period"]["endDate"].as_str())
        .max()
        .map(str::to_string)
}
fn sources(inputs: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    array(inputs)
        .iter()
        .filter_map(|input| {
            let source = &input["provenance"];
            let key = format!("{}:{}", text(&source["sourceId"]), text(&source["locator"]));
            seen.insert(key).then(|| source.clone())
        })
        .collect()
}
fn fact_ids(inputs: &Value) -> Vec<Value> {
    array(inputs)
        .iter()
        .map(|input| input["factId"].clone())
        .collect()
}
fn project_point(point: &Value) -> Value {
    json!({"period":period_label(&point["period"]),"status":point["status"],"value":point["value"],"formula":point["formula"],"reasonCodes":point["reasonCodes"],"factIds":fact_ids(&point["inputs"]),"sources":sources(&point["inputs"])})
}
fn project_observation(item: &Value) -> Value {
    json!({"id":item["id"],"kind":item["kind"],"metric":item["metric"],"frequency":item["frequency"],"period":period_label(&item["period"]),"comparisonPeriod":item.get("comparisonPeriod").filter(|v|!v.is_null()).map(period_label),"status":item["status"],"value":item["value"],"unit":item["unit"],"formula":item["formula"],"reasonCodes":item["reasonCodes"],"factIds":fact_ids(&item["inputs"]),"sources":sources(&item["inputs"])})
}

pub fn build_snapshot(
    code: &str,
    entity_type: &str,
    policy: &str,
    availability: &str,
    gate: &Value,
    statements: &[Value],
    quality: &Value,
) -> Value {
    let series: Vec<&Value> = array(&quality["series"])
        .iter()
        .filter(|s| METRICS.contains(&text(&s["metric"])))
        .collect();
    let all_observations: Vec<Value> = array(&quality["trends"])
        .iter()
        .chain(array(&quality["observations"]))
        .cloned()
        .collect();
    let annual = periods(&series, "annual", 5);
    let quarterly = periods(&series, "quarterly", 8);
    let ttm = latest_end(&series, "ttm");
    let reported:Vec<Value>=series.iter().filter(|s|matches!(text(&s["frequency"]),"annual"|"quarterly")).map(|s| {
        let mut points=array(&s["points"]).to_vec(); points.sort_by_key(|p|period_key(&p["period"])); let limit=if s["frequency"]=="annual"{5}else{8}; let start=points.len().saturating_sub(limit);
        json!({"metric":s["metric"],"frequency":s["frequency"],"basisId":s["basis"]["id"],"unit":s["unit"],"points":points[start..].iter().map(project_point).collect::<Vec<_>>()})
    }).collect();
    let observations: Vec<Value> = all_observations
        .iter()
        .filter(|item| KINDS.contains(&text(&item["kind"])))
        .filter(|item| match text(&item["frequency"]) {
            "annual" => annual.contains(&period_label(&item["period"])),
            "quarterly" => quarterly.contains(&period_label(&item["period"])),
            "ttm" => item["period"]["endDate"].as_str() == ttm.as_deref(),
            _ => false,
        })
        .map(project_observation)
        .collect();
    let fact_ids = strings(
        reported
            .iter()
            .flat_map(|item| array(&item["points"]))
            .chain(observations.iter())
            .flat_map(|item| array(&item["factIds"]))
            .filter_map(Value::as_str)
            .map(str::to_string),
    );
    let source_ids = strings(
        array(&quality["series"])
            .iter()
            .flat_map(|s| array(&s["points"]))
            .flat_map(|p| array(&p["inputs"]))
            .filter_map(|reference| reference["provenance"]["sourceId"].as_str())
            .map(str::to_string),
    );
    let mut result = json!({"schemaVersion":PROTOCOL_VERSION,"codeVersion":CODE_VERSION,"securityCode":code,"asOf":latest_end(&series,"quarterly").or_else(||latest_end(&series,"annual")).unwrap_or_else(||"unknown".into()),"entityType":entity_type,
        "dataQuality":{"status":if availability=="source_error"||reported.is_empty(){"blocked"}else{availability},"sourcePolicy":policy,"statutoryVerification":{"status":gate["status"],"verifiedMetrics":gate["verifiedMetrics"],"reason":gate["reason"]},"statements":statements,"gaps":array(&quality["gaps"]).iter().take(120).cloned().collect::<Vec<_>>()},
        "periodCoverage":{"annual":annual,"quarterly":quarterly,"ttmEndDate":ttm},"reportedFacts":reported,"derivedObservations":observations,"deterministicFlags":risk_flags(&all_observations),"lineage":{"factIds":fact_ids,"sourceIds":source_ids}});
    // Preserve the historical JS fingerprint preimage: the temporary
    // inputFingerprint property is explicitly undefined, not absent or null.
    let serialized = stable_stringify(&result, false);
    let mut hash: u32 = 2166136261;
    for unit in serialized.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16777619);
    }
    result["lineage"]["inputFingerprint"] = json!(format!("fnv1a:{hash:x}"));
    result
}

pub fn risk_flags(observations: &[Value]) -> Vec<Value> {
    let config: Value = serde_json::from_str(include_str!(
        "../../../../config/research/research-financial-analysis-risk-rules.json"
    ))
    .expect("versioned risk rule config");
    let mut flags = Vec::new();
    for rule in array(&config["rules"]) {
        let mut candidates: Vec<&Value> = observations
            .iter()
            .filter(|item| {
                item["kind"] == rule["observationKind"]
                    && item["frequency"] == rule["frequency"]
                    && (rule.get("metric").is_none() || item["metric"] == rule["metric"])
                    && item["status"] == "available"
                    && item["value"].is_number()
            })
            .collect();
        candidates.sort_by_key(|item| observation_key(item));
        let Some(latest) = candidates.last() else {
            continue;
        };
        let operator = text(&rule["operator"]);
        let prior = if operator.starts_with("delta_") {
            candidates
                .iter()
                .rfind(|item| observation_key(item) < observation_key(latest))
                .copied()
        } else {
            None
        };
        let measured = latest["value"].as_f64().unwrap()
            - prior.and_then(|p| p["value"].as_f64()).unwrap_or(0.0);
        let threshold = rule["threshold"].as_f64().unwrap_or(0.0);
        let triggered = match operator {
            "lt" => measured < threshold,
            "gt" => measured > threshold,
            "delta_lt" => prior.is_some() && measured < threshold,
            _ => prior.is_some() && measured > threshold,
        };
        if !triggered {
            continue;
        }
        let mut flag = json!({"ruleId":rule["id"],"severity":rule["severity"],"title":rule["title"],"observationId":latest["id"],"period":period_label(&latest["period"]),"value":measured,"unit":latest["unit"],"threshold":rule["threshold"],"operator":operator});
        if let Some(prior) = prior {
            flag["comparisonObservationId"] = prior["id"].clone();
        }
        flags.push(flag);
    }
    flags.sort_by(|left, right| {
        let a = text(&left["severity"]);
        let b = text(&right["severity"]);
        if a == b {
            text(&left["ruleId"]).cmp(text(&right["ruleId"]))
        } else if a == "high" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    flags
}

const ANNUAL_METRICS: &[&str] = &[
    "revenue",
    "gross_profit",
    "operating_profit",
    "net_profit",
    "operating_cash_flow",
    "capital_expenditure",
    "diluted_weighted_average_shares",
];
const QUARTER_FLOW: &[&str] = &[
    "revenue",
    "gross_profit",
    "operating_profit",
    "net_profit",
    "operating_cash_flow",
    "capital_expenditure",
];
const QUARTER_BALANCE: &[&str] = &[
    "cash",
    "total_debt",
    "total_equity",
    "current_assets",
    "current_liabilities",
    "trade_receivables",
    "inventory",
    "trade_payables",
    "diluted_shares",
];
fn compact_unit(unit: &str) -> &str {
    match unit {
        "CNY" => "亿元",
        "shares" => "亿股",
        _ => unit,
    }
}
fn compact_value(value: &Value, unit: &str) -> Value {
    let Some(n) = value.as_f64() else {
        return Value::Null;
    };
    let divisor = if matches!(unit, "CNY" | "shares") {
        100_000_000.0
    } else {
        1.0
    };
    let decimals = if matches!(unit, "CNY" | "shares" | "percent") {
        2
    } else {
        4
    };
    json!(to_fixed_number(n / divisor, decimals))
}
/// Round the exact binary input like ECMAScript toFixed. Multiplying by the
/// decimal scale first or using half-even formatting changes boundary values.
fn to_fixed_number(number: f64, decimals: usize) -> f64 {
    if number.abs() >= 1e21 || !number.is_finite() {
        return number;
    }
    let bits = number.abs().to_bits();
    let encoded_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (mantissa, exponent) = if encoded_exponent == 0 {
        (fraction as u128, -1074)
    } else {
        (
            (fraction | (1_u64 << 52)) as u128,
            encoded_exponent - 1023 - 52,
        )
    };
    let scale = 10_u128.pow(decimals as u32);
    let numerator = mantissa * scale;
    let rounded = if exponent >= 0 {
        numerator << exponent as u32
    } else if -exponent >= 128 {
        0
    } else {
        let shift = (-exponent) as u32;
        let quotient = numerator >> shift;
        let remainder = numerator & ((1_u128 << shift) - 1);
        quotient + u128::from(remainder >= (1_u128 << (shift - 1)))
    };
    let decimal = if decimals == 0 {
        rounded.to_string()
    } else {
        format!(
            "{}.{:0width$}",
            rounded / scale,
            rounded % scale,
            width = decimals
        )
    };
    let value = decimal.parse::<f64>().unwrap_or(0.0);
    if number.is_sign_negative() && value != 0.0 {
        -value
    } else {
        value
    }
}
fn compact_statement(item: &Value) -> Value {
    json!({"statementType":item["statementType"],"rows":item.get("rows").cloned().unwrap_or(json!(0)),"originProviders":item.get("originProviders").cloned().unwrap_or(json!([])),"reportingCurrencies":item.get("reportingCurrencies").cloned().unwrap_or(json!([])),"latestReportDate":item["latestReportDate"],"sourceHealth":item["sourceHealth"]["status"].as_str().unwrap_or("unknown")})
}
fn fact_tables(facts: &Value) -> Value {
    let mut tables = Map::new();
    for frequency in ["annual", "quarterly"] {
        let mut rows = Vec::<(String, String, BTreeMap<String, Value>)>::new();
        let mut periods = BTreeSet::new();
        for series in array(facts).iter().filter(|s| s["frequency"] == frequency) {
            let metric = text(&series["metric"]);
            let allowed = if frequency == "annual" {
                ANNUAL_METRICS.contains(&metric)
            } else {
                QUARTER_FLOW.contains(&metric) || QUARTER_BALANCE.contains(&metric)
            };
            if !allowed {
                continue;
            }
            let points = array(&series["points"]);
            let limit = if frequency == "quarterly" && QUARTER_BALANCE.contains(&metric) {
                2
            } else {
                8
            };
            let points = &points[points.len().saturating_sub(limit)..];
            let unit = text(&series["unit"]);
            let values: BTreeMap<_, _> = points
                .iter()
                .map(|p| {
                    (
                        text(&p["period"]).to_string(),
                        compact_value(&p["value"], unit),
                    )
                })
                .collect();
            if !values.is_empty() {
                periods.extend(values.keys().cloned());
                rows.push((metric.into(), compact_unit(unit).into(), values));
            }
        }
        if rows.is_empty() {
            continue;
        }
        rows.sort_by(|left, right| left.0.cmp(&right.0));
        let periods: Vec<_> = periods.into_iter().collect();
        let rows:Vec<_>=rows.into_iter().map(|(metric,unit,values)|json!({"metric":metric,"unit":unit,"values":periods.iter().map(|p|values.get(p).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()})).filter(|r|array(&r["values"]).iter().any(|v|!v.is_null())).collect();
        if !rows.is_empty() {
            tables.insert(frequency.into(), json!({"periods":periods,"rows":rows}));
        }
    }
    Value::Object(tables)
}
type ObservationGroup = (
    String,
    String,
    String,
    BTreeMap<String, Value>,
    BTreeMap<String, Value>,
);

fn observation_tables(observations: &[Value]) -> Value {
    let mut tables = Map::new();
    for frequency in ["annual", "quarterly", "ttm"] {
        let selected: Vec<&Value> = observations
            .iter()
            .filter(|o| o["frequency"] == frequency)
            .collect();
        if selected.is_empty() {
            continue;
        }
        let periods = strings(selected.iter().map(|o| text(&o["period"]).to_string()));
        let mut groups: BTreeMap<String, ObservationGroup> = BTreeMap::new();
        for item in selected {
            let metric = text(&item["metric"]);
            let kind = text(&item["kind"]);
            let unit = text(&item["unit"]);
            let key = format!("{kind}:{metric}:{unit}");
            let group = groups.entry(key).or_insert_with(|| {
                (
                    kind.into(),
                    metric.into(),
                    compact_unit(unit).into(),
                    BTreeMap::new(),
                    BTreeMap::new(),
                )
            });
            group.3.insert(
                text(&item["period"]).into(),
                compact_value(&item["value"], unit),
            );
            group.4.insert(
                text(&item["period"]).into(),
                item["comparisonPeriod"].clone(),
            );
        }
        let mut rows: Vec<_> = groups.into_values().collect();
        rows.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
        let rows:Vec<Value>=rows.into_iter().map(|(kind,metric,unit,values,comparisons)|{let mut row=json!({"kind":kind,"metric":metric,"unit":unit,"values":periods.iter().map(|p|values.get(p).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()});let comparisons:Vec<Value>=periods.iter().map(|p|comparisons.get(p).cloned().unwrap_or(Value::Null)).collect();if comparisons.iter().any(|v|!v.is_null()){row["comparisonPeriods"]=json!(comparisons);}row}).filter(|r|array(&r["values"]).iter().any(|v|!v.is_null())).collect();
        if !rows.is_empty() {
            tables.insert(frequency.into(), json!({"periods":periods,"rows":rows}));
        }
    }
    Value::Object(tables)
}

pub fn project_prompt_input(snapshot: &Value) -> Value {
    let flag_ids: HashSet<String> = array(&snapshot["deterministicFlags"])
        .iter()
        .flat_map(|f| {
            [
                f["observationId"].as_str(),
                f["comparisonObservationId"].as_str(),
            ]
        })
        .flatten()
        .map(str::to_string)
        .collect();
    let mut observations = array(&snapshot["derivedObservations"]).to_vec();
    observations.sort_by_key(projected_key);
    let mut ranks: HashMapKey = BTreeMap::new();
    for o in &observations {
        *ranks
            .entry(format!(
                "{}:{}:{}",
                text(&o["kind"]),
                text(&o["metric"]),
                text(&o["frequency"])
            ))
            .or_insert(0) += 1;
    }
    let observations: Vec<Value> = observations
        .into_iter()
        .filter(|o| o["status"] == "available")
        .filter(|o| {
            let key = format!(
                "{}:{}:{}",
                text(&o["kind"]),
                text(&o["metric"]),
                text(&o["frequency"])
            );
            let rank = ranks.entry(key).or_insert(0);
            let keep = *rank <= 2 || flag_ids.contains(text(&o["id"]));
            *rank = rank.saturating_sub(1);
            keep
        })
        .collect();
    let facts = fact_tables(&snapshot["reportedFacts"]);
    let observations = observation_tables(&observations);
    let flags:Vec<Value>=array(&snapshot["deterministicFlags"]).iter().map(|f|{let unit=text(&f["unit"]);json!({"ruleId":f["ruleId"],"severity":f["severity"],"title":f["title"],"period":f["period"],"value":compact_value(&f["value"],unit),"threshold":compact_value(&f["threshold"],unit),"unit":compact_unit(unit),"operator":f["operator"]})}).collect();
    json!({"securityCode":snapshot["securityCode"],"asOf":snapshot["asOf"],"dataQuality":{"status":snapshot["dataQuality"]["status"],"statements":array(&snapshot["dataQuality"]["statements"]).iter().map(compact_statement).collect::<Vec<_>>(),"gapSummary":summarize_gaps(&snapshot["dataQuality"]["gaps"])},"periodCoverage":snapshot["periodCoverage"],"analysisBrief":analysis_brief(&facts,&observations),"reportedFactTables":facts,"observationTables":observations,"deterministicFlags":flags,"numericDisplay":{"amountUnit":"亿元","shareUnit":"亿股","percentageDecimals":2}})
}
type HashMapKey = BTreeMap<String, usize>;
fn summarize_gaps(gaps: &Value) -> Vec<Value> {
    let mut counts = BTreeMap::new();
    for gap in array(gaps) {
        let status = gap["status"].as_str().unwrap_or("unknown");
        let reason = if let Some(values) = gap["reasonCodes"].as_array() {
            let mut values: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
            values.sort();
            values.join(",")
        } else {
            "unspecified".into()
        };
        *counts
            .entry(format!(
                "{status}:{}",
                if reason.is_empty() {
                    "unspecified"
                } else {
                    &reason
                }
            ))
            .or_insert(0usize) += 1;
    }
    counts
        .into_iter()
        .map(|(key, count)| json!({"key":key,"count":count}))
        .collect()
}
const METRIC_BRIEFS: &[(&str, &str)] = &[
    ("growth_profitability", "revenue"),
    ("growth_profitability", "gross_profit"),
    ("growth_profitability", "operating_profit"),
    ("growth_profitability", "net_profit"),
    ("cash_working_capital", "operating_cash_flow"),
    ("cash_working_capital", "inventory"),
    ("cash_working_capital", "trade_receivables"),
    ("cash_working_capital", "trade_payables"),
    ("capital_efficiency", "capital_expenditure"),
    ("balance_sheet", "cash"),
    ("balance_sheet", "total_debt"),
    ("balance_sheet", "total_equity"),
    ("per_share", "diluted_weighted_average_shares"),
    ("per_share", "diluted_shares"),
];
const OBSERVATION_BRIEFS: &[(&str, &str, &str)] = &[
    ("growth_profitability", "gross_margin", "gross_profit"),
    (
        "growth_profitability",
        "operating_margin",
        "operating_profit",
    ),
    ("growth_profitability", "net_margin", "net_profit"),
    ("cash_working_capital", "free_cash_flow", "free_cash_flow"),
    (
        "cash_working_capital",
        "cash_conversion",
        "operating_cash_flow",
    ),
    (
        "cash_working_capital",
        "receivables_to_revenue",
        "trade_receivables",
    ),
    ("cash_working_capital", "inventory_to_revenue", "inventory"),
    (
        "cash_working_capital",
        "payables_to_revenue",
        "trade_payables",
    ),
    (
        "capital_efficiency",
        "capital_expenditure_to_revenue",
        "capital_expenditure",
    ),
    ("capital_efficiency", "return_on_equity", "total_equity"),
    (
        "capital_efficiency",
        "return_on_invested_capital",
        "invested_capital",
    ),
    ("balance_sheet", "current_ratio", "current_assets"),
    ("balance_sheet", "quick_ratio", "current_assets"),
    ("balance_sheet", "debt_to_equity", "total_debt"),
    ("per_share", "net_profit_per_share", "net_profit"),
    ("per_share", "free_cash_flow_per_share", "free_cash_flow"),
    ("per_share", "book_value_per_share", "total_equity"),
    ("per_share", "net_dilution_rate", "diluted_shares"),
];
fn analysis_brief(facts: &Value, observations: &Value) -> Value {
    let mut metric_briefs = Vec::new();
    for (section, metric) in METRIC_BRIEFS {
        let mut brief = json!({"section":section,"metric":metric});
        let mut found = false;
        for (frequency, key) in [("annual", "latestAnnual"), ("quarterly", "latestQuarter")] {
            if let Some(row) = array(&facts[frequency]["rows"])
                .iter()
                .find(|row| row["metric"] == *metric)
            {
                brief[key] = summarize_metric(
                    metric,
                    frequency,
                    &facts[frequency]["periods"],
                    row,
                    observations,
                );
                found = true;
            }
        }
        if found {
            metric_briefs.push(brief);
        }
    }
    let mut observation_briefs = Vec::new();
    for (section, kind, metric) in OBSERVATION_BRIEFS {
        let mut brief = json!({"section":section,"kind":kind,"metric":metric});
        let mut found = false;
        for (frequency, key) in [
            ("annual", "latestAnnual"),
            ("quarterly", "latestQuarter"),
            ("ttm", "latestTtm"),
        ] {
            if let Some(latest) = latest_observation(observations, kind, metric, frequency) {
                brief[key] = latest;
                found = true;
            }
        }
        if found {
            observation_briefs.push(brief);
        }
    }
    json!({"writingPolicy":{"focus":"优先引用本摘要中的最新年度、最新季度、同比/环比和关键观察，再给出解释、反证、限制和验证项。","avoid":"不要按表格顺序把所有期间和指标逐项重抄成正文；只保留支撑判断所需的关键数字。"},"metricBriefs":metric_briefs,"observationBriefs":observation_briefs})
}
fn latest_index(values: &Value) -> Option<usize> {
    array(values).iter().rposition(|value| !value.is_null())
}
fn summarize_metric(
    metric: &str,
    frequency: &str,
    periods: &Value,
    row: &Value,
    observations: &Value,
) -> Value {
    let Some(index) = latest_index(&row["values"]) else {
        return Value::Null;
    };
    let latest_period = &periods[index];
    let yoy = find_observation(observations, "yoy", metric, frequency, latest_period);
    let qoq = find_observation(observations, "qoq", metric, frequency, latest_period);
    let cagr = find_observation(observations, "cagr", metric, frequency, latest_period);
    let previous_period = if frequency == "quarterly" {
        qoq.as_ref()
    } else {
        yoy.as_ref()
    }
    .map(|v| &v["comparisonPeriod"]);
    let previous = previous_period.and_then(|p| value_by_period(periods, &row["values"], p));
    let previous_year = if frequency == "quarterly" {
        yoy.as_ref()
            .and_then(|v| value_by_period(periods, &row["values"], &v["comparisonPeriod"]))
    } else {
        None
    };
    let mut result = json!({"period":latest_period,"value":row["values"][index]});
    for (key, value_key, previous) in [
        ("previousPeriod", "previousValue", previous),
        ("previousYearPeriod", "previousYearValue", previous_year),
    ] {
        if let Some(previous) = previous {
            result[key] = previous["period"].clone();
            result[value_key] = previous["value"].clone();
        }
    }
    for (key, observation) in [("yoy", yoy), ("qoq", qoq), ("cagr", cagr)] {
        if let Some(observation) = observation {
            result[key] = observation["value"].clone();
        }
    }
    result
}
fn latest_observation(tables: &Value, kind: &str, metric: &str, frequency: &str) -> Option<Value> {
    let table = &tables[frequency];
    let row = array(&table["rows"])
        .iter()
        .find(|row| row["kind"] == kind && row["metric"] == metric)?;
    let index = latest_index(&row["values"])?;
    let mut result =
        json!({"period":table["periods"][index],"value":row["values"][index],"unit":row["unit"]});
    if row.get("comparisonPeriods").is_some() {
        result["comparisonPeriod"] = row["comparisonPeriods"][index].clone();
    }
    Some(result)
}
fn find_observation(
    tables: &Value,
    kind: &str,
    metric: &str,
    frequency: &str,
    period: &Value,
) -> Option<Value> {
    let table = &tables[frequency];
    let row = array(&table["rows"])
        .iter()
        .find(|row| row["kind"] == kind && row["metric"] == metric)?;
    let index = array(&table["periods"]).iter().position(|p| p == period)?;
    let value = row["values"].get(index).filter(|v| !v.is_null())?;
    Some(
        json!({"period":period,"comparisonPeriod":row["comparisonPeriods"].get(index).cloned().unwrap_or(Value::Null),"value":value}),
    )
}
fn value_by_period(periods: &Value, values: &Value, period: &Value) -> Option<Value> {
    if period.is_null() {
        return None;
    }
    let index = array(periods).iter().position(|p| p == period)?;
    let value = values.get(index).filter(|v| !v.is_null())?;
    Some(json!({"period":period,"value":value}))
}

// Canonical JS-like JSON serialization used solely for the existing FNV audit
// identity. Object keys are sorted; hashing is over UTF-16 code units.
fn stable_stringify(value: &Value, lineage: bool) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(|v| stable_stringify(v, false))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            if lineage && !keys.contains(&"inputFingerprint") {
                keys.push("inputFingerprint");
            }
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        if lineage && key == "inputFingerprint" {
                            "undefined".into()
                        } else {
                            stable_stringify(&map[key], key == "lineage")
                        }
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}
fn js_number(number: f64) -> String {
    if number == 0.0 {
        return "0".into();
    }
    let magnitude = number.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let raw = format!("{number:e}");
        if let Some((base, exponent)) = raw.split_once('e') {
            let exponent: i32 = exponent.parse().unwrap();
            return format!("{base}e{}{exponent}", if exponent >= 0 { "+" } else { "" });
        }
    }
    number.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observation(
        id: &str,
        kind: &str,
        metric: &str,
        frequency: &str,
        year: i32,
        quarter: i32,
        value: f64,
    ) -> Value {
        json!({"id":id,"kind":kind,"metric":metric,"frequency":frequency,"period":{"kind":"quarter","fiscalYear":year,"fiscalQuarter":quarter,"endDate":format!("{year}-0{}-30",quarter*3)},"comparisonPeriod":null,"status":"available","value":value,"unit":"percent","formula":"fixture","reasonCodes":[],"inputs":[]})
    }
    #[test]
    fn delta_risk_flags_need_prior_and_use_latest_only() {
        let first = observation(
            "a",
            "receivables_to_revenue",
            "trade_receivables",
            "quarterly",
            2025,
            1,
            10.0,
        );
        assert!(risk_flags(std::slice::from_ref(&first)).is_empty());
        let later = observation(
            "b",
            "receivables_to_revenue",
            "trade_receivables",
            "quarterly",
            2025,
            2,
            14.0,
        );
        let flags = risk_flags(&[first, later]);
        assert_eq!(flags.len(), 1);
        assert_eq!(flags[0]["ruleId"], "receivables_buildup");
        assert_eq!(flags[0]["value"], 4.0);
        assert_eq!(flags[0]["comparisonObservationId"], "a");
    }
    #[test]
    fn snapshot_restricts_series_and_projected_input_omits_provenance() {
        let quality = json!({"series":[{"metric":"revenue","frequency":"annual","basis":{"id":"CNY:CAS"},"unit":"CNY","points":[{"period":{"kind":"annual","fiscalYear":2025,"endDate":"2025-12-31"},"status":"available","value":1234567890.0,"formula":"reported","reasonCodes":[],"inputs":[{"factId":"fact-1","provenance":{"sourceId":"source-1","sourceType":"eastmoney","locator":"revenue"}}]}]}],"trends":[],"observations":[],"gaps":[]});
        let snapshot = build_snapshot(
            "600036.SH",
            "unknown",
            "fixture",
            "available",
            &json!({"status":"not_loaded","verifiedMetrics":[],"reason":"fixture"}),
            &[],
            &quality,
        );
        assert_eq!(snapshot["asOf"], "2025-12-31");
        assert_eq!(snapshot["periodCoverage"]["annual"], json!(["FY2025"]));
        assert!(
            snapshot["lineage"]["inputFingerprint"]
                .as_str()
                .unwrap()
                .starts_with("fnv1a:")
        );
        let prompt = project_prompt_input(&snapshot);
        assert_eq!(
            prompt["reportedFactTables"]["annual"]["rows"][0]["values"],
            json!([12.35])
        );
        assert_eq!(
            prompt["reportedFactTables"]["annual"]["rows"][0]["unit"],
            "亿元"
        );
        assert!(prompt.get("lineage").is_none());
        assert!(
            serde_json::to_string(&prompt)
                .unwrap()
                .find("source-1")
                .is_none()
        );
    }
    #[test]
    fn canonical_string_keeps_undefined_lineage_property_and_utf16() {
        assert_eq!(
            stable_stringify(&json!({"lineage":{"sourceIds":["源"]},"n":1.0}), false),
            "{\"lineage\":{\"inputFingerprint\":undefined,\"sourceIds\":[\"源\"]},\"n\":1}"
        );
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(1e21), "1e+21");
    }

    #[test]
    fn original_typescript_snapshot_and_prompt_golden_parity() {
        // Frozen from financial-analysis.ts, not from this Rust implementation.
        let cases: Value =
            serde_json::from_str(include_str!("fixtures/snapshot-golden.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let input = &case["input"];
            let snapshot = build_snapshot(
                text(&input["securityCode"]),
                text(&input["entityType"]),
                text(&input["sourcePolicy"]),
                text(&input["availability"]),
                &input["statutoryGate"],
                array(&input["statements"]),
                &input["quality"],
            );
            assert_semantic_json(&snapshot, &case["expected"]["snapshot"], "snapshot");
            assert_semantic_json(
                &project_prompt_input(&snapshot),
                &case["expected"]["promptInput"],
                "promptInput",
            );
        }
    }

    fn assert_semantic_json(actual: &Value, expected: &Value, path: &str) {
        match (actual, expected) {
            // JSON has one numeric category; Serde internally distinguishes
            // 60 and 60.0, unlike the JavaScript contract being preserved.
            (Value::Number(actual), Value::Number(expected)) => {
                assert_eq!(actual.as_f64(), expected.as_f64(), "{path}")
            }
            (Value::Array(actual), Value::Array(expected)) => {
                assert_eq!(actual.len(), expected.len(), "{path}.length");
                for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                    assert_semantic_json(actual, expected, &format!("{path}[{index}]"));
                }
            }
            (Value::Object(actual), Value::Object(expected)) => {
                assert_eq!(
                    actual.keys().collect::<Vec<_>>(),
                    expected.keys().collect::<Vec<_>>(),
                    "{path}.keys"
                );
                for (key, actual) in actual {
                    assert_semantic_json(actual, &expected[key], &format!("{path}.{key}"));
                }
            }
            _ => assert_eq!(actual, expected, "{path}"),
        }
    }

    #[test]
    fn fixed_decimal_rounding_matches_ecmascript_binary_boundaries() {
        for (input, expected) in [
            (1.125, 1.13),
            (2.675, 2.67),
            (-1.125, -1.13),
            (-2.675, -2.67),
            (1.005, 1.0),
            (0.0, 0.0),
        ] {
            assert_eq!(to_fixed_number(input, 2), expected);
        }
    }
}
