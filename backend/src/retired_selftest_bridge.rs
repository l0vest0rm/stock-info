//! Stateless adapters for the retained assertion scripts. Every computation
//! delegates to the native production domain, not a retired TypeScript oracle.
use crate::{
    coverage,
    dashboard::{comparability, domain, point_in_time},
    finance::{self, series, valuation},
    research::evidence,
};
use anyhow::{Result, bail};
use chrono::{Duration, NaiveDate};
use serde_json::{Value, json};
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}
fn strings(v: &Value) -> Vec<String> {
    list(v).iter().map(|v| text(v).to_owned()).collect()
}
pub fn evaluate(name: &str, args: &[Value]) -> Result<Value> {
    let a = arg(args, 0);
    let b = arg(args, 1);
    let c = arg(args, 2);
    Ok(match name {
        "constants" => {
            json!({"MID_CYCLE_MIN_YEARS":5,"SCREEN_MARGIN_OF_SAFETY":0.2,"SHRINKING_EARNINGS_THRESHOLD":-0.15,"WEAK_GROWTH_THRESHOLD":-0.05,"IMPLAUSIBLE_GROWTH_THRESHOLD":1.0,"KNOWN_WITHOUT_NOTICE_DAYS":120})
        }
        "buildValuationInputs" => valuation::inputs::build(a),
        "buildValuationBands" => valuation::bands::build(a),
        "buildMidCycleEarnings" => valuation::build_mid_cycle(a),
        "commonEquity" => series::common_equity(a),
        "deriveLatestFinancialValuation" => valuation::derive_latest(a),
        "buildValuationCoverage" => coverage::read(),
        "companyValuationCoverage" => json!(coverage::company_coverage(text(a))),
        "companyValuationArchetype" => json!(coverage::company_archetype(text(a))),
        "resolveValuationArchetype" => coverage::resolve_archetype(text(a), b.as_str()),
        "sameSecurity" => {
            let left = crate::codes::normalize(text(a));
            let right = crate::codes::normalize(text(b));
            json!(
                !left.is_empty()
                    && !right.is_empty()
                    && (left == right
                        || left == format!("{right}.US")
                        || right == format!("{left}.US"))
            )
        }
        "isFiscalYearRow" => json!(series::is_fiscal_year(a)),
        "annualBaseFor" => json!(series::annual_base_for(list(a), text(b))),
        "priorSamePeriodFor" => json!(series::prior_same_period_for(list(a), b, c)),
        "shiftMonths" => json!(series::shift_months(
            text(a),
            b.as_i64().unwrap_or(0) as i32
        )),
        "trailingTwelveMonths" => {
            let rows = list(a);
            let values = list(&b["__callbackValues"]);
            json!(series::ttm_value(rows, |row| rows
                .iter()
                .position(|r| r == row)
                .and_then(|i| values.get(i))
                .and_then(Value::as_f64)))
        }
        "ttmNetProfit" => json!(series::ttm_value(list(a), |r| {
            r["payload"]["PARENT_NETPROFIT"].as_f64()
        })),
        "annualIncomeStatements" => json!(series::annual_income_statements(list(a))),
        "incomeFamilyOf" => json!(series::income_family(a)),
        "previousQuarterEnd" => json!(series::previous_quarter_end(text(a))),
        "buildQuarterlySeries" => {
            series::quarterly_series(text(a), list(b), c["limit"].as_u64().unwrap_or(40) as usize)
        }
        "isCumulativeIncomeRow" => json!(series::is_cumulative_income(a)),
        "buildFinancialStatementReadModel" => finance::build_read_model(
            text(&a["code"]),
            text(&a["statementType"]),
            text(&a["source"]),
            list(&a["rows"]),
            a["fresh"] == true,
        ),
        "capitalIntensityClass" => json!(comparability::capital_intensity_class(a.as_f64())),
        "comparisonRulesFor" => comparability::comparison_rules(text(a)),
        "buildComparabilityMatrix" => comparability::build(a),
        "normalizeCurrency" => json!(domain::normalize_currency(a)),
        "screenValuationCandidate" => domain::screen(a),
        "assessGrowthAgainstBand" => {
            let v = domain::growth(a);
            json!({"verdict":v["verdict"],"reading":if v["verdict"]=="unknown"{Value::Null}else{a.clone()},"threshold":-0.15,"note":v["note"]})
        }
        "growthVetoesNomination" => json!(a["verdict"] == "vetoes"),
        "noticeDateOf" => json!(point_in_time::notice_date(a)),
        "addDays" => json!(
            NaiveDate::parse_from_str(text(a), "%Y-%m-%d")
                .ok()
                .and_then(|d| d.checked_add_signed(Duration::days(b.as_i64().unwrap_or(0))))
                .map(|d| d.to_string())
        ),
        "isKnowableAt" => json!(point_in_time::knowable(a, text(b))),
        "validateEvidenceRecord" => evidence::validate_record(a),
        "canVerifyIdentity" => evidence::can_verify_identity(text(a), list(b)),
        "latestEvidenceDate" => json!(evidence::latest_evidence_date(list(a))),
        "identityReport" => json!(evidence::identity_report(&strings(a), list(b))),
        "evidenceCoverage" => evidence::evidence_coverage(&strings(a), list(b)),
        "eastmoneyPriceDivisor" => {
            let v = crate::company::map_eastmoney_overview(
                "TEST.SH",
                &json!({"f59":a,"f43":1.0}),
                Value::Null,
                0,
            );
            json!(1.0 / v["latestPrice"].as_f64().unwrap_or(0.01))
        }
        "eastmoneyMarketCapYi" => crate::company::map_eastmoney_overview(
            "TEST.SH",
            &json!({"f116":a}),
            Value::Null,
            0,
        )["marketCapYi"]
            .clone(),
        "genReportDates" => json!(finance::report_dates(a.as_i64().unwrap_or(5) as i32)),
        _ => bail!("unknown retained self-test function: {name}"),
    })
}
