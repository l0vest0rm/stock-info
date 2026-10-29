//! Provider facts admitted to the financial-analysis quality model. Keep raw
//! source metadata and accounting bases separate from delivery/cache metadata.
use chrono::NaiveDate;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn row_text<'a>(row: &'a Value, name: &str) -> &'a str {
    row[name].as_str().unwrap_or("")
}

// `Number(undefined)` is NaN, but `Number(null)` is zero. Using Value indexing
// alone would collapse those two provider states and invent zero-valued facts.
fn number_of(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Null => 0.0,
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(value) => value.as_f64()?,
        Value::String(value) => js_number(value)?,
        Value::Array(values) => js_number(
            &values
                .iter()
                .map(array_string)
                .collect::<Vec<_>>()
                .join(","),
        )?,
        Value::Object(_) => return None,
    };
    number.is_finite().then_some(number)
}

fn array_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(array_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}

fn js_number(value: &str) -> Option<f64> {
    let value =
        value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            if digits.is_empty() {
                return None;
            }
            return digits
                .chars()
                .try_fold(0.0, |number, digit| {
                    Some(number * f64::from(radix) + f64::from(digit.to_digit(radix)?))
                })
                .filter(|number| number.is_finite());
        }
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

fn first_number(payload: &Value, fields: &[&str], nonnegative: bool) -> Option<f64> {
    fields.iter().find_map(|field| {
        number_of(payload.get(*field)).filter(|number| !nonnegative || *number >= 0.0)
    })
}

fn statement_values(statement_type: &str, payload: &Value) -> Vec<(&'static str, Option<f64>)> {
    let fields: &[(&str, &[&str])] = match statement_type {
        "income" => &[
            (
                "revenue",
                &[
                    "TOTAL_OPERATE_INCOME",
                    "OPERATE_INCOME",
                    "totalOperateIncome",
                ],
            ),
            (
                "cost_of_revenue",
                &["OPERATE_COST", "TOTAL_OPERATE_COST", "operateCost"],
            ),
            ("gross_profit", &["GROSS_PROFIT", "grossProfit"]),
            ("operating_profit", &["OPERATE_PROFIT", "operateProfit"]),
            (
                "net_profit",
                &[
                    "PARENT_NETPROFIT",
                    "HOLDER_PROFIT",
                    "NETPROFIT",
                    "parentNetprofit",
                    "netProfit",
                ],
            ),
            (
                "pre_tax_profit",
                &["TOTAL_PROFIT", "PROFIT_BEFORE_TAX", "pretaxIncome"],
            ),
            (
                "income_tax_expense",
                &["INCOME_TAX", "INCOME_TAX_EXPENSE", "taxProvision"],
            ),
            ("interest_expense", &["INTEREST_EXPENSE", "interestExpense"]),
            (
                "diluted_weighted_average_shares",
                &["DILUTED_AVERAGE_SHARES"],
            ),
        ],
        "balance" => &[
            ("cash", &["MONETARYFUNDS", "END_CASH", "endCce"]),
            ("total_debt", &["TOTAL_DEBT", "totalDebt"]),
            (
                "total_equity",
                &["TOTAL_EQUITY", "TOTAL_PARENT_EQUITY", "totalEquity"],
            ),
            (
                "total_assets",
                &["TOTAL_ASSETS", "TOTAL_ASSET", "totalAssets", "totaAssets"],
            ),
            (
                "current_assets",
                &["TOTAL_CURRENT_ASSETS", "CURRENT_ASSETS", "currentAssets"],
            ),
            (
                "current_liabilities",
                &[
                    "TOTAL_CURRENT_LIAB",
                    "TOTAL_CURRENT_LIABILITIES",
                    "currentLiabilities",
                ],
            ),
            (
                "trade_receivables",
                &["ACCOUNT_RECE", "ACCOUNTS_RECEIVABLE", "accountsReceivable"],
            ),
            ("contract_assets", &["CONTRACT_ASSET", "contractAssets"]),
            ("inventory", &["INVENTORY", "inventories"]),
            (
                "trade_payables",
                &["ACCOUNT_PAYABLE", "ACCOUNTS_PAYABLE", "accountsPayable"],
            ),
            (
                "short_term_debt",
                &["SHORTTERM_LOAN", "SHORT_TERM_DEBT", "shortTermDebt"],
            ),
            (
                "long_term_debt",
                &["LONGTERM_LOAN", "LONG_TERM_DEBT", "longTermDebt"],
            ),
            (
                "lease_liabilities",
                &["LEASE_LIABILITY", "leaseLiabilities"],
            ),
        ],
        _ => &[
            (
                "operating_cash_flow",
                &["NETCASH_OPERATE", "netcashOperate"],
            ),
            ("capital_expenditure", &["CONSTRUCT_LONG_ASSET"]),
            ("dividends_paid", &["DIVIDEND_PAID", "dividendsPaid"]),
            (
                "share_repurchases",
                &["SHARE_REPURCHASES", "shareRepurchases"],
            ),
            ("share_issuance", &["SHARE_ISSUANCE", "shareIssuance"]),
            (
                "acquisition_spend",
                &["ACQUISITION_SPEND", "acquisitionSpend"],
            ),
            ("debt_repayment", &["DEBT_REPAYMENT", "debtRepayment"]),
        ],
    };
    fields
        .iter()
        .map(|(metric, fields)| {
            (
                *metric,
                first_number(
                    payload,
                    fields,
                    statement_type != "income"
                        && statement_type != "balance"
                        && !["operating_cash_flow", "capital_expenditure"].contains(metric),
                ),
            )
        })
        .collect()
}

#[derive(Serialize)]
struct ComparisonKey<'a> {
    v: u8,
    source: &'a str,
    #[serde(rename = "securityCode")]
    security_code: String,
    #[serde(rename = "statementType")]
    statement_type: &'a str,
    metric: &'a str,
    period: ComparisonPeriod<'a>,
    #[serde(rename = "accountingBasis")]
    accounting_basis: ComparisonBasis<'a>,
}

#[derive(Serialize)]
struct ComparisonPeriod<'a> {
    kind: &'a str,
    #[serde(rename = "startDate")]
    start_date: &'a str,
    #[serde(rename = "endDate")]
    end_date: &'a str,
}

#[derive(Serialize)]
struct ComparisonBasis<'a> {
    id: &'a str,
    currency: &'a str,
    #[serde(rename = "accountingStandard")]
    accounting_standard: &'a str,
    scope: &'a str,
    revision: &'a str,
}

/// Canonical comparison JSON intentionally uses the JavaScript contract's field
/// order rather than serde_json::Map order: existing statutory ledger keys must
/// remain byte-identical across the migration.
fn comparison_key(
    source: &str,
    code: &str,
    statement_type: &str,
    metric: &str,
    period: &Value,
    basis: &Value,
) -> String {
    serde_json::to_string(&ComparisonKey {
        v: 1,
        source: source.trim(),
        security_code: code.trim().to_uppercase(),
        statement_type: statement_type.trim(),
        metric: metric.trim(),
        period: ComparisonPeriod {
            kind: row_text(period, "kind"),
            start_date: row_text(period, "startDate"),
            end_date: row_text(period, "endDate"),
        },
        accounting_basis: ComparisonBasis {
            id: row_text(basis, "id").trim(),
            currency: row_text(basis, "currency").trim(),
            accounting_standard: row_text(basis, "accountingStandard").trim(),
            scope: row_text(basis, "scope").trim(),
            revision: row_text(basis, "revision").trim(),
        },
    })
    .expect("financial comparison identity contains only serializable strings")
}

fn date_parts(date: &str) -> Option<(i32, u32, u32)> {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return None;
    }
    Some((
        date[..4].parse().ok()?,
        date[5..7].parse().ok()?,
        date[8..].parse().ok()?,
    ))
}

fn reported_date<'a>(payload: &'a Value, fallback: &'a str) -> &'a str {
    let date = text(&payload["REPORT_DATE"]).unwrap_or(fallback);
    date.get(..10).unwrap_or(date)
}

fn annual_period(year: i32, date: &str) -> Value {
    json!({"kind":"annual","startDate":format!("{year:04}-01-01"),"endDate":date,"fiscalYear":year})
}

fn quarter_period(year: i32, quarter: u32, date: &str) -> Value {
    json!({"kind":"quarter","startDate":format!("{year:04}-{:02}-01",(quarter-1)*3+1),"endDate":date,"fiscalYear":year,"fiscalQuarter":quarter})
}

fn quarter_end(year: i32, quarter: u32) -> String {
    format!(
        "{year:04}-{:02}-{}",
        quarter * 3,
        if quarter == 1 || quarter == 4 {
            "31"
        } else {
            "30"
        }
    )
}

fn parse_period(payload: &Value, fallback: &str, source: &str) -> Option<Value> {
    let date = reported_date(payload, fallback);
    let (year, month, day) = date_parts(date)?;
    if text(&payload["FINANCIAL_SOURCE_CONTRACT"]) == Some("eastmoney_hk_f10_main_indicator.v1") {
        return (payload["DATE_TYPE_CODE"].as_str() == Some("001"))
            .then(|| annual_period(year, date));
    }
    NaiveDate::from_ymd_opt(year, month, day)?;
    let fiscal_period = payload
        .get("FISCAL_PERIOD")
        .filter(|value| !value.is_null())
        .or_else(|| payload.get("fiscalPeriod"))
        .unwrap_or(&Value::Null);
    let fiscal_period = fiscal_period.as_str().unwrap_or("");
    let explicit_annual = ["12M", "FY", "ANNUAL"]
        .iter()
        .any(|value| fiscal_period.eq_ignore_ascii_case(value));
    let eastmoney_annual = source == "eastmoney"
        && month == 12
        && day == 31
        && (text(&payload["FINANCIAL_SOURCE_CONTRACT"]) == Some("eastmoney_f10_annual_income.v1")
            || ["年报", "年度报告", "年度"].contains(&row_text(payload, "REPORT_TYPE").trim()));
    Some(if explicit_annual || eastmoney_annual {
        annual_period(year, date)
    } else {
        quarter_period(year, month.div_ceil(3), date)
    })
}

fn parse_hong_kong_period(payload: &Value, fallback: &str) -> Option<Value> {
    let date = reported_date(payload, fallback);
    let (year, month, day) = date_parts(date)?;
    // Match the source contract exactly. Its calendar-validity review belongs
    // to the quality layer; this loader does not silently repair source dates.
    if ![3, 6, 9, 12].contains(&month) || ![30, 31].contains(&day) {
        return None;
    }
    Some(quarter_period(year, month / 3, date))
}

fn basis(row: &Value, hk_cumulative: bool) -> Value {
    let payload = &row["payload"];
    let code = row_text(row, "code");
    let currency = text(&payload["REPORTING_CURRENCY"])
        .or_else(|| text(&payload["CURRENCY"]))
        .unwrap_or(if hk_cumulative || code.ends_with(".HK") {
            "HKD"
        } else {
            "CNY"
        });
    let standard = if hk_cumulative || code.ends_with(".HK") {
        text(&payload["REPORTING_ACCOUNT_STANDARD"])
            .or_else(|| text(&payload["ACCOUNT_STANDARD"]))
            .unwrap_or("IFRS")
    } else if code.ends_with(".US") {
        "US_GAAP"
    } else {
        "CAS"
    };
    json!({"id":format!("{currency}:{standard}:consolidated:reported"),"currency":currency,"accountingStandard":standard,"scope":"consolidated","revision":"reported"})
}

fn make_facts(
    statement_type: &str,
    row: &Value,
    period: &Value,
    basis: &Value,
    source_id: &str,
) -> Vec<Value> {
    let payload = &row["payload"];
    let published_at = text(&payload["NOTICE_DATE"]).unwrap_or(row_text(row, "reportDate"));
    statement_values(statement_type,payload).into_iter().map(|(metric,value)| json!({
        "id":format!("{source_id}:{metric}"),"canonicalComparisonKey":comparison_key(row_text(row,"source"),row_text(row,"code"),statement_type,metric,period,basis),
        "metric":metric,"period":period,"value":value,"basis":basis,
        "provenance":{"sourceId":source_id,"sourceType":row["source"],"publishedAt":published_at,"locator":metric}
    })).collect()
}

fn truthy_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::Bool(false) => None,
        Value::Number(number) if number.as_f64() == Some(0.0) => None,
        Value::String(value) if value.is_empty() => None,
        Value::String(value) => Some(value.clone()),
        value => Some(value.to_string()),
    }
}

/// Normalize primary-source rows only; never infer reporting currency from an
/// ADS trading currency or convert cumulative HK flows without their adjacent
/// same-basis predecessor.
pub fn normalize_statement_rows(statement_type: &str, rows: &[Value]) -> Vec<Value> {
    if rows.iter().any(|row| {
        text(&row["payload"]["FINANCIAL_SOURCE_CONTRACT"])
            == Some("eastmoney_hk_f10_main_indicator.v1")
    }) {
        return normalize_hong_kong_rows(statement_type, rows);
    }
    let mut output = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let payload = &row["payload"];
        if row["source"] == "yahoo"
            && ((!matches!(
                payload["FINANCIAL_SOURCE_CONTRACT"].as_str(),
                Some("yahoo_finance_timeseries.v2" | "yahoo_finance_timeseries.v3")
            )) || text(&payload["REPORTING_CURRENCY"]).is_none()
                || text(&payload["FISCAL_PERIOD"]).is_none()
                || payload["YAHOO_CURRENCY_CONFLICT"] == true)
        {
            continue;
        }
        let Some(period) = parse_period(
            payload,
            row_text(row, "reportDate"),
            row_text(row, "source"),
        ) else {
            continue;
        };
        let accounting_basis = basis(row, false);
        let fiscal = truthy_string(row.get("fiscalPeriod"))
            .or_else(|| truthy_string(payload.get("FISCAL_PERIOD")))
            .unwrap_or_else(|| "unknown".into());
        let source_id = format!(
            "{}:{}:{statement_type}:{}:{fiscal}:{index}",
            row_text(row, "source"),
            row_text(row, "code"),
            row_text(row, "reportDate")
        );
        let mut facts = make_facts(statement_type, row, &period, &accounting_basis, &source_id);
        if statement_type == "income" {
            let revenue = facts
                .iter()
                .find(|fact| fact["metric"] == "revenue")
                .and_then(|fact| fact["value"].as_f64())
                .zip(facts.iter().find(|fact| fact["metric"] == "revenue"));
            let cost = facts
                .iter()
                .find(|fact| fact["metric"] == "cost_of_revenue")
                .and_then(|fact| fact["value"].as_f64())
                .zip(
                    facts
                        .iter()
                        .find(|fact| fact["metric"] == "cost_of_revenue"),
                );
            if let (Some((revenue, revenue_fact)), Some((cost, cost_fact))) = (revenue, cost) {
                let references = json!([{"factId":revenue_fact["id"],"provenance":revenue_fact["provenance"]},{"factId":cost_fact["id"],"provenance":cost_fact["provenance"]}]);
                if let Some(gross) = facts
                    .iter_mut()
                    .find(|fact| fact["metric"] == "gross_profit" && fact["value"].is_null())
                {
                    gross["id"] = json!(format!("{source_id}:gross_profit:derived"));
                    gross["value"] = json!(revenue - cost);
                    gross["derivationFormula"] = json!("revenue - cost_of_revenue");
                    gross["inputReferences"] = references;
                }
            }
        }
        output.extend(facts);
    }
    output
}

#[derive(Clone)]
struct HongKongSource {
    security_code: String,
    statement_type: String,
    date_type: Option<String>,
    period: Value,
    facts: Vec<Value>,
}

fn normalize_hong_kong_rows(statement_type: &str, rows: &[Value]) -> Vec<Value> {
    let sources: Vec<_> = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let period = parse_hong_kong_period(&row["payload"], row_text(row, "reportDate"))?;
            let accounting_basis = basis(row, true);
            let source_id = format!(
                "{}:{}:{statement_type}:{}:{index}",
                row_text(row, "source"),
                row_text(row, "code"),
                row_text(row, "reportDate")
            );
            Some(HongKongSource {
                security_code: row_text(row, "code").into(),
                statement_type: statement_type.into(),
                date_type: text(&row["payload"]["DATE_TYPE_CODE"]).map(str::to_string),
                facts: make_facts(statement_type, row, &period, &accounting_basis, &source_id),
                period,
            })
        })
        .collect();
    if statement_type != "income" && statement_type != "cashflow" {
        return sources
            .into_iter()
            .flat_map(|source| source.facts)
            .collect();
    }
    let mut output = Vec::new();
    for source in sources
        .iter()
        .filter(|source| source.date_type.as_deref() == Some("001"))
    {
        for fact in &source.facts {
            let mut fact = fact.clone();
            let year = source.period["fiscalYear"].as_i64().unwrap_or_default() as i32;
            let period = annual_period(year, row_text(&source.period, "endDate"));
            fact["period"] = period.clone();
            fact["canonicalComparisonKey"] = json!(comparison_key(
                row_text(&fact["provenance"], "sourceType"),
                &source.security_code,
                &source.statement_type,
                row_text(&fact, "metric"),
                &period,
                &fact["basis"]
            ));
            output.push(fact);
        }
    }
    // Vec of groups preserves JavaScript Map's insertion order. Using a sorted
    // map here changes the input snapshot's deterministic fact ordering.
    let mut groups: Vec<(String, Vec<(HongKongSource, Value)>)> = Vec::new();
    for source in sources
        .iter()
        .filter(|source| source.date_type.is_some() && source.date_type.as_deref() != Some("001"))
        .chain(
            sources
                .iter()
                .filter(|source| source.date_type.as_deref() == Some("001")),
        )
    {
        for fact in &source.facts {
            let key = format!(
                "{}|{}",
                source.period["fiscalYear"],
                row_text(fact, "metric")
            );
            if let Some((_, values)) = groups.iter_mut().find(|(existing, _)| existing == &key) {
                values.push((source.clone(), fact.clone()));
            } else {
                groups.push((key, vec![(source.clone(), fact.clone())]));
            }
        }
    }
    for (_, values) in groups {
        // Repeated source DATE_TYPE_CODE entries intentionally use the last
        // input, as the original Map constructor does.
        let by_type: BTreeMap<_, _> = values
            .iter()
            .filter_map(|value| value.0.date_type.as_deref().map(|key| (key, value)))
            .collect();
        for (first_type, second_type, quarter, formula) in [
            ("003", None, 1, "Q1 reported cumulative value"),
            (
                "002",
                Some("003"),
                2,
                "H1 cumulative value - Q1 cumulative value",
            ),
            (
                "004",
                Some("002"),
                3,
                "9M cumulative value - H1 cumulative value",
            ),
            (
                "001",
                Some("004"),
                4,
                "FY cumulative value - 9M cumulative value",
            ),
        ] {
            let Some(first) = by_type.get(first_type) else {
                continue;
            };
            let second = if let Some(second_type) = second_type {
                match by_type.get(second_type) {
                    Some(second) => Some(*second),
                    None => continue,
                }
            } else {
                None
            };
            output.push(derived_hong_kong_quarter(first, second, quarter, formula));
        }
    }
    output
}

fn derived_hong_kong_quarter(
    first: &(HongKongSource, Value),
    second: Option<&(HongKongSource, Value)>,
    quarter: u32,
    formula: &str,
) -> Value {
    let (source, fact) = first;
    let year = source.period["fiscalYear"].as_i64().unwrap_or_default() as i32;
    let metric = row_text(fact, "metric");
    let mixed = second.is_some_and(|(_, other)| other["basis"]["id"] != fact["basis"]["id"]);
    let missing =
        fact["value"].is_null() || second.is_some_and(|(_, other)| other["value"].is_null());
    let value = if mixed || missing {
        None
    } else {
        fact["value"].as_f64().map(|first| {
            first
                - second
                    .and_then(|(_, other)| other["value"].as_f64())
                    .unwrap_or(0.0)
        })
    };
    let period = quarter_period(year, quarter, &quarter_end(year, quarter));
    let mut references = vec![json!({"factId":fact["id"],"provenance":fact["provenance"]})];
    if let Some((_, other)) = second {
        references.push(json!({"factId":other["id"],"provenance":other["provenance"]}));
    }
    let mut output = json!({
        "id":format!("hk-cumulative-bridge:{}:{}:{metric}:{year}:Q{quarter}:{}",source.security_code,source.statement_type,row_text(&fact["basis"],"id")),
        "canonicalComparisonKey":comparison_key("derived_from_eastmoney_hk_f10",&source.security_code,&source.statement_type,metric,&period,&fact["basis"]),
        "metric":metric,"period":period,"value":value,"basis":fact["basis"],
        "provenance":{"sourceId":format!("hk-cumulative-bridge:{}",row_text(&fact["provenance"],"sourceId")),"sourceType":"derived_from_eastmoney_hk_f10","publishedAt":fact["provenance"]["publishedAt"],"locator":formula},
        "inputReferences":references,"derivationFormula":formula,
    });
    if mixed {
        output["derivationStatus"] = json!("incomparable");
        output["derivationReasonCodes"] = json!(["cumulative_bridge_mixed_accounting_basis"]);
    } else if missing {
        output["derivationStatus"] = json!("missing");
        output["derivationReasonCodes"] = json!(["cumulative_bridge_input_missing"]);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(code: &str, date: &str, source: &str, payload: Value) -> Value {
        json!({"code":code,"reportDate":date,"source":source,"fiscalPeriod":null,"payload":payload})
    }

    fn metric<'a>(facts: &'a [Value], name: &str) -> &'a Value {
        facts.iter().find(|fact| fact["metric"] == name).unwrap()
    }

    #[test]
    fn source_metadata_and_annual_gross_profit_lineage_are_preserved() {
        let facts = normalize_statement_rows(
            "income",
            &[row(
                "600036.SH",
                "2025-12-31",
                "eastmoney",
                json!({"REPORT_TYPE":"年报","TOTAL_OPERATE_INCOME":100,"OPERATE_COST":60,"PARENT_NETPROFIT":20}),
            )],
        );
        let gross = metric(&facts, "gross_profit");
        assert_eq!(gross["value"], 40.0);
        assert_eq!(gross["period"]["kind"], "annual");
        assert_eq!(gross["derivationFormula"], "revenue - cost_of_revenue");
        assert_eq!(gross["inputReferences"].as_array().unwrap().len(), 2);
        assert_eq!(metric(&facts, "interest_expense")["value"], Value::Null);
        assert_eq!(gross["basis"]["id"], "CNY:CAS:consolidated:reported");
        let expected = r#"{"v":1,"source":"eastmoney","securityCode":"600036.SH","statementType":"income","metric":"gross_profit","period":{"kind":"annual","startDate":"2025-01-01","endDate":"2025-12-31"},"accountingBasis":{"id":"CNY:CAS:consolidated:reported","currency":"CNY","accountingStandard":"CAS","scope":"consolidated","revision":"reported"}}"#;
        assert_eq!(gross["canonicalComparisonKey"], expected);
    }

    #[test]
    fn missing_and_null_numeric_fields_follow_original_source_coercion() {
        let facts = normalize_statement_rows(
            "income",
            &[row(
                "600036.SH",
                "2026-06-30",
                "eastmoney",
                json!({"TOTAL_OPERATE_INCOME":null,"OPERATE_INCOME":100,"GROSS_PROFIT":null}),
            )],
        );
        assert_eq!(metric(&facts, "revenue")["value"], 0.0);
        assert_eq!(metric(&facts, "gross_profit")["value"], 0.0);
        assert!(
            metric(&facts, "gross_profit")
                .get("derivationFormula")
                .is_none()
        );
        assert_eq!(metric(&facts, "cost_of_revenue")["value"], Value::Null);
        assert_eq!(number_of(Some(&json!("0x10"))), Some(16.0));
        assert_eq!(number_of(Some(&json!("1,000"))), None);
    }

    #[test]
    fn yahoo_reporting_metadata_is_required_and_ads_currency_is_not_inferred() {
        assert!(
            normalize_statement_rows(
                "income",
                &[row(
                    "BABA.US",
                    "2026-03-31",
                    "yahoo",
                    json!({"TOTAL_OPERATE_INCOME":100})
                )]
            )
            .is_empty()
        );
        let payload = json!({"FINANCIAL_SOURCE_CONTRACT":"yahoo_finance_timeseries.v3","REPORTING_CURRENCY":"CNY","FISCAL_PERIOD":"3M","TOTAL_OPERATE_INCOME":100});
        let facts = normalize_statement_rows(
            "income",
            &[row("BABA.US", "2026-10-25", "yahoo", payload.clone())],
        );
        assert_eq!(metric(&facts, "revenue")["basis"]["currency"], "CNY");
        assert_eq!(
            metric(&facts, "revenue")["basis"]["accountingStandard"],
            "US_GAAP"
        );
        assert_eq!(metric(&facts, "revenue")["period"]["endDate"], "2026-10-25");
        assert_eq!(metric(&facts, "revenue")["period"]["fiscalQuarter"], 4);
        let mut conflicted = payload;
        conflicted["YAHOO_CURRENCY_CONFLICT"] = json!(true);
        assert!(
            normalize_statement_rows(
                "income",
                &[row("BABA.US", "2026-03-31", "yahoo", conflicted)]
            )
            .is_empty()
        );
    }

    fn hk(date: &str, date_type: &str, currency: &str, revenue: f64) -> Value {
        row(
            "00700.HK",
            date,
            "eastmoney_hk_f10",
            json!({"FINANCIAL_SOURCE_CONTRACT":"eastmoney_hk_f10_main_indicator.v1","DATE_TYPE_CODE":date_type,"REPORTING_CURRENCY":currency,"TOTAL_OPERATE_INCOME":revenue}),
        )
    }

    #[test]
    fn hong_kong_bridges_only_adjacent_cumulative_periods_and_retains_annual() {
        let facts = normalize_statement_rows(
            "income",
            &[
                hk("2025-03-31", "003", "HKD", 20.0),
                hk("2025-06-30", "002", "HKD", 50.0),
                hk("2025-09-30", "004", "HKD", 80.0),
                hk("2025-12-31", "001", "HKD", 110.0),
            ],
        );
        let revenues: Vec<_> = facts
            .iter()
            .filter(|fact| fact["metric"] == "revenue")
            .collect();
        assert_eq!(revenues.len(), 5);
        assert_eq!(revenues[0]["period"]["kind"], "annual");
        assert_eq!(revenues[0]["value"], 110.0);
        assert_eq!(revenues[1]["value"], 20.0);
        for revenue in &revenues[2..] {
            assert_eq!(revenue["value"], 30.0);
        }
        assert!(
            normalize_statement_rows("income", &[hk("2025-06-30", "002", "HKD", 50.0)]).is_empty()
        );
    }

    #[test]
    fn hong_kong_mixed_bases_produce_explicit_incomparability_and_no_fabricated_value() {
        let facts = normalize_statement_rows(
            "income",
            &[
                hk("2025-03-31", "003", "CNY", 20.0),
                hk("2025-06-30", "002", "HKD", 50.0),
            ],
        );
        let q2 = facts
            .iter()
            .find(|fact| fact["metric"] == "revenue" && fact["period"]["fiscalQuarter"] == 2)
            .unwrap();
        assert_eq!(q2["value"], Value::Null);
        assert_eq!(q2["derivationStatus"], "incomparable");
        assert_eq!(
            q2["derivationReasonCodes"],
            json!(["cumulative_bridge_mixed_accounting_basis"])
        );
        assert_eq!(q2["inputReferences"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn total_liabilities_and_basic_shares_are_not_mislabelled_as_debt_or_dilution() {
        let balance = normalize_statement_rows(
            "balance",
            &[row(
                "600036.SH",
                "2026-06-30",
                "eastmoney",
                json!({"TOTAL_LIABILITIES":50,"TOTAL_SHARES":10}),
            )],
        );
        assert_eq!(metric(&balance, "total_debt")["value"], Value::Null);
        assert!(
            balance
                .iter()
                .all(|fact| fact["metric"] != "diluted_shares")
        );
        let cash = normalize_statement_rows(
            "cashflow",
            &[row(
                "600036.SH",
                "2026-06-30",
                "eastmoney",
                json!({"DIVIDEND_PAID":-10,"shareRepurchases":-20,"SHARE_ISSUANCE":5,"NETCASH_OPERATE":-8}),
            )],
        );
        assert_eq!(metric(&cash, "dividends_paid")["value"], Value::Null);
        assert_eq!(metric(&cash, "share_repurchases")["value"], Value::Null);
        assert_eq!(metric(&cash, "share_issuance")["value"], 5.0);
        assert_eq!(metric(&cash, "operating_cash_flow")["value"], -8.0);
    }
}
