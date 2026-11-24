pub use securities_data::finance::providers::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppState, cache_policy};
    use chrono::Utc;
    use serde_json::json;
    const INCOME_CUMULATIVE: &str = "eastmoney_f10_income.v1";
    const INCOME_ANNUAL: &str = "eastmoney_f10_annual_income.v1";
    fn fixture_state(root: &std::path::Path) -> AppState {
        AppState::new(
            crate::db::Database::open(root.join("fixture.sqlite")).unwrap(),
            root.to_path_buf(),
            "127.0.0.1:18000".into(),
        )
        .unwrap()
    }

    #[test]
    fn cn_provider_families_use_existing_classification_and_real_cashflow_endpoints() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("shared")).unwrap();
        std::fs::write(
            root.path().join("shared/finance-mappings.json"),
            r#"{"bankCodes":["600036.SH"],"securityCodes":["600030.SH"],"insuranceCodes":["601318.SH"]}"#,
        )
        .unwrap();
        let state = fixture_state(root.path());
        for (code, kind, expected) in [
            ("600036.SH", "income", "BINCOMEQC"),
            ("600030.SH", "balance", "SBALANCE"),
            ("601318.SH", "cashflow", "ICASHFLOWQC"),
            ("300308.SZ", "cashflow", "GCASHFLOW"),
            ("600036.SH", "cashflow", "BCASHFLOW"),
        ] {
            assert_eq!(report_type(&state, code, kind).unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn fresh_income_snapshot_is_read_only_and_preserves_both_source_families() {
        let root = tempfile::tempdir().unwrap();
        let state = fixture_state(root.path());
        // Fail before any filesystem operation if the caller intentionally
        // overrides the storage root. Never seed the user's real object store.
        assert!(state.data_dir().starts_with(root.path()));
        let now = Utc::now().timestamp_millis();
        let latest = cache_policy::latest_completed_quarter(now);
        let year = latest[..4].parse::<i32>().unwrap();
        let rows = json!([
            {"code":"600036.SH","statementType":"income","reportDate":latest,"fiscalPeriod":"9M","source":"eastmoney","updatedAt":now,"payload":{"FINANCIAL_SOURCE_CONTRACT":INCOME_CUMULATIVE,"TOTAL_OPERATE_INCOME":100,"dataSource":"financial_report","dataSourceLabel":"正式财报"}},
            {"code":"600036.SH","statementType":"income","reportDate":format!("{}-12-31",year-1),"fiscalPeriod":"12M","source":"eastmoney","updatedAt":now,"payload":{"FINANCIAL_SOURCE_CONTRACT":INCOME_ANNUAL,"TOTAL_OPERATE_INCOME":120,"dataSource":"financial_report","dataSourceLabel":"正式财报"}}
        ]);
        let snapshot = json!({"code":"600036.SH","statementType":"income","updatedAt":now,"source":"eastmoney","rows":rows});
        let key = "financial-statements/income/600036.SH.json";
        let store = state.market_store().unwrap();
        store.put_json(key, &snapshot).await.unwrap();
        let before = store.get(key).await.unwrap().unwrap();
        let (source, actual) = load(&state, "600036.SH", "income").await.unwrap();
        assert_eq!(source, "r2");
        assert_eq!(actual, rows.as_array().unwrap().clone());
        assert_eq!(store.get(key).await.unwrap().unwrap(), before);
        // load did not access a provider or invent a database cache table.
        assert!(
            state
                .db
                .query("SELECT name FROM sqlite_master WHERE type='table'", vec![])
                .await
                .unwrap()
                .is_empty()
        );
    }
}
