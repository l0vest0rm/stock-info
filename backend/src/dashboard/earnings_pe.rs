//! Read-only earnings multiples, separate from archetype-specific valuation verdicts.
use crate::finance::series;
use serde_json::{Value, json};

fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}
fn formal(row: &Value) -> bool {
    row["statementType"] == "income"
        && !matches!(
            row["source"].as_str(),
            Some("eastmoney_performance" | "eastmoney_forecast")
        )
        && !matches!(
            row["payload"]["dataSource"].as_str(),
            Some("performance_report" | "performance_forecast")
        )
}
fn profit(row: &Value) -> Option<f64> {
    ["PARENT_NETPROFIT", "HOLDER_PROFIT", "parentNetprofit"]
        .iter()
        .find_map(|key| number(&row["payload"][*key]))
}
fn months(row: &Value) -> Option<u32> {
    if series::is_formal_annual_income(row) {
        return Some(12);
    }
    if series::income_family(row) != Some("cumulative") {
        return None;
    }
    // Use reported duration, never infer a fiscal year from the calendar month.
    match row["fiscalPeriod"].as_str()?.trim().to_uppercase().as_str() {
        "3M" | "Q1" | "一季报" => Some(3),
        "6M" | "H1" | "中报" | "半年报" => Some(6),
        "9M" | "Q3" | "三季报" => Some(9),
        _ => None,
    }
}
pub(super) fn calculate(rows: &[Value], quote: &Value, usable: bool) -> Value {
    let mut rows: Vec<Value> = rows.iter().filter(|row| formal(row)).cloned().collect();
    rows.sort_by(|a, b| {
        b["reportDate"]
            .as_str()
            .cmp(&a["reportDate"].as_str())
            .then_with(|| {
                series::is_formal_annual_income(b).cmp(&series::is_formal_annual_income(a))
            })
            .then_with(|| {
                (series::income_family(b) == Some("cumulative"))
                    .cmp(&(series::income_family(a) == Some("cumulative")))
            })
    });
    let latest = rows.first().unwrap_or(&Value::Null);
    let latest_date = &latest["reportDate"];
    // Quarter-only data must not be mistaken for cumulative YTD earnings.
    let cumulative: Vec<Value> = rows
        .iter()
        .filter(|row| {
            series::income_family(row) == Some("cumulative") || series::is_formal_annual_income(row)
        })
        .cloned()
        .collect();
    let ttm = if cumulative
        .first()
        .is_some_and(|row| row["reportDate"] == *latest_date)
    {
        series::ttm_value(&cumulative, profit)
    } else {
        None
    };
    let duration = months(latest);
    let annualized = profit(latest)
        .zip(duration)
        .map(|(profit, months)| profit * 12.0 / f64::from(months))
        .filter(|n| n.is_finite());
    let cap = number(&quote["marketCap"]).filter(|cap| *cap > 0.0);
    let pe = |profit: Option<f64>| {
        usable
            .then_some(cap)
            .flatten()
            .zip(profit.filter(|profit| *profit > 0.0))
            .map(|(cap, profit)| cap / profit)
            .filter(|n| n.is_finite())
    };
    let pe_ttm = pe(ttm);
    let pe_dynamic = pe(annualized);
    let reason = if !usable {
        Some("行情或财报不可用、行情过期或币种不可比，未计算PE")
    } else if pe_ttm.is_none() || pe_dynamic.is_none() {
        Some("缺少正式累计财报/期间/TTM基期或归母净利润非正；对应PE不可用")
    } else {
        None
    };
    json!({"peTtm":pe_ttm,"peDynamic":pe_dynamic,"ttmNetProfit":ttm,
        "annualizedNetProfit":annualized,"annualizationMonths":duration,"reportDate":latest_date,
        "priceAsOf":quote["priceAsOf"],"marketCap":cap,"currency":quote["currency"],"unavailableReason":reason})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(date: &str, months: &str, profit: Value) -> Value {
        json!({"statementType":"income","reportDate":date,"fiscalPeriod":months,"source":"eastmoney","payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_income.v1","PARENT_NETPROFIT":profit}})
    }
    #[test]
    fn rolling_and_annualized_are_distinct_and_order_independent() {
        let rows = vec![
            row("2025-06-30", "6M", json!(30)),
            row("2025-12-31", "12M", json!(100)),
            row("2026-06-30", "6M", json!(60)),
        ];
        let result = calculate(&rows, &json!({"marketCap":1300}), true);
        assert_eq!(result["ttmNetProfit"], 130.0);
        assert_eq!(result["peTtm"], 10.0);
        assert_eq!(result["peDynamic"], json!(1300.0 / 120.0));
        assert_eq!(result["annualizationMonths"], 6);
        assert_eq!(result["reportDate"], "2026-06-30");
    }
    #[test]
    fn missing_loss_quarter_only_and_unusable_inputs_never_fabricate_pe() {
        for profit in [Value::Null, json!(0), json!(-10)] {
            let r = calculate(
                &[row("2026-06-30", "6M", profit)],
                &json!({"marketCap":1000}),
                true,
            );
            assert!(r["peTtm"].is_null());
            assert!(r["peDynamic"].is_null());
        }
        let rows = vec![row("2026-06-30", "6M", json!(60))];
        assert!(calculate(&rows, &json!({"marketCap":1000}), false)["peDynamic"].is_null());
        assert!(calculate(&rows, &json!({"marketCap":-1}), true)["peDynamic"].is_null());
        let mut quarter = rows[0].clone();
        quarter["payload"]["FINANCIAL_SOURCE_CONTRACT"] = json!("eastmoney_f10_incomeqc.v1");
        assert!(calculate(&[quarter], &json!({"marketCap":1000}), true)["peDynamic"].is_null());
    }
    #[test]
    fn cumulative_wins_same_date_but_never_falls_back_past_newer_quarter() {
        let cumulative = row("2026-06-30", "6M", json!(60));
        let mut quarter = row("2026-06-30", "6M", json!(20));
        quarter["payload"]["FINANCIAL_SOURCE_CONTRACT"] = json!("eastmoney_f10_incomeqc.v1");
        let quote = json!({"marketCap":1200});
        assert_eq!(
            calculate(&[quarter.clone(), cumulative.clone()], &quote, true)["peDynamic"],
            10.0
        );
        quarter["reportDate"] = json!("2026-09-30");
        assert!(calculate(&[cumulative, quarter], &quote, true)["peDynamic"].is_null());
    }
    #[test]
    fn dedicated_annual_contract_is_a_valid_ttm_base() {
        let mut annual = row("2025-12-31", "12M", json!(100));
        annual["payload"]["FINANCIAL_SOURCE_CONTRACT"] = json!("eastmoney_f10_annual_income.v1");
        let r = calculate(
            &[
                annual,
                row("2025-09-30", "9M", json!(70)),
                row("2026-09-30", "9M", json!(90)),
            ],
            &json!({"marketCap":1200}),
            true,
        );
        assert_eq!(r["peTtm"], 10.0);
        assert_eq!(r["peDynamic"], 10.0);
        let r = calculate(
            &[row("2026-09-30", "unknown", json!(90))],
            &json!({"marketCap":1200}),
            true,
        );
        assert!(r["peDynamic"].is_null());
    }
    #[test]
    fn formal_annual_and_provisional_exclusion() {
        let annual = row("2025-03-31", "12M", json!(100));
        let mut provisional = row("2026-06-30", "6M", json!(1000));
        provisional["payload"]["dataSource"] = json!("performance_forecast");
        let r = calculate(&[annual, provisional], &json!({"marketCap":1000}), true);
        assert_eq!(r["peTtm"], 10.0);
        assert_eq!(r["peDynamic"], 10.0);
        assert_eq!(r["annualizationMonths"], 12);
    }

    #[tokio::test]
    async fn calculated_multiples_round_trip_through_dashboard_api_without_get_writes() {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("config/generated")).unwrap();
        std::fs::write(root.join("config/investment-universe.json"), json!({"companies":[{"id":"test","displayName":"测试","classificationStatus":"verified","preferredMarket":"CN","preferredTicker":"600036.SH","securities":[{"ticker":"600036.SH","market":"CN"}]}]}).to_string()).unwrap();
        std::fs::write(
            root.join("config/generated/valuation-revision.json"),
            json!({"revision":"a".repeat(64)}).to_string(),
        )
        .unwrap();
        std::fs::write(
            root.join("config/investment-opportunity-policy.json"),
            json!({"version":"test"}).to_string(),
        )
        .unwrap();
        let db = crate::db::Database::open(root.join("test.sqlite")).unwrap();
        db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let state = crate::AppState::new(db, root.into(), "127.0.0.1:8000".into()).unwrap();
        crate::dashboard::refresh_with(&state, "600036.SH", |_, _| async {
            let pe = calculate(&[row("2025-06-30","6M",json!(30)), row("2025-12-31","12M",json!(100)), row("2026-06-30","6M",json!(60))], &json!({"marketCap":1300,"currency":"CNY","priceAsOf":"2026-11-02"}), true);
            Ok(json!({"code":"600036.SH","executable":false,"verdict":"watch","researchVersion":0,"opportunity":{"policyVersion":"test"},"earningsPe":pe}))
        }).await.unwrap();
        let before = state
            .db
            .query("SELECT * FROM kv_cache ORDER BY namespace,key", vec![])
            .await
            .unwrap();
        let response = crate::dashboard::routes()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/research/valuation-screen")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        let pe = &payload["data"]["rows"][0]["earningsPe"];
        assert_eq!(pe["peTtm"], 10.0);
        assert_eq!(pe["peDynamic"], json!(1300.0 / 120.0));
        assert_eq!(pe["reportDate"], "2026-06-30");
        assert_eq!(pe["priceAsOf"], "2026-11-02");
        assert_eq!(
            before,
            state
                .db
                .query("SELECT * FROM kv_cache ORDER BY namespace,key", vec![])
                .await
                .unwrap()
        );
    }
}
