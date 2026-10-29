//! Frozen primary-statement inputs for the taskd financial report. The full
//! snapshot is durable audit evidence; only a bounded projection is sent out.
#[path = "financial_input/facts.rs"]
pub mod facts;
#[path = "financial_input/quality.rs"]
pub mod quality;
#[path = "financial_input/snapshot.rs"]
mod snapshot;

use crate::AppState;
use anyhow::{Result, bail};
use serde_json::{Value, json};
pub use snapshot::{build_snapshot, project_prompt_input, risk_flags};
pub const PROTOCOL_VERSION: &str = "financial-analysis-input.v1";
pub const CODE_VERSION: &str = "financial-analysis-code.v7";
pub const PROMPT_VERSION: &str = "financial-analysis.webqa.v9";

pub async fn prepare(state: &AppState, code: &str) -> Result<Value> {
    let code = crate::codes::normalize(code);
    let (income, balance, cashflow) = tokio::join!(
        crate::finance::read_model(state, &code, "income"),
        crate::finance::read_model(state, &code, "balance"),
        crate::finance::read_model(state, &code, "cashflow")
    );
    let mut loaded = Vec::new();
    let mut normalized = Vec::new();
    let mut source_error = false;
    let mut primary_available = true;
    for (statement_type, result) in [
        ("income", income?),
        ("balance", balance?),
        ("cashflow", cashflow?),
    ] {
        let rows = result["rows"].as_array().cloned().unwrap_or_default();
        normalized.extend(facts::normalize_statement_rows(statement_type, &rows));
        primary_available &= !rows.is_empty();
        source_error |= result["sourceHealth"]["status"] == "failed";
        loaded.push(json!({
            "statementType": statement_type, "rows": rows.len(),
            "source": result["delivery"]["cache"].as_str().unwrap_or("source_error"),
            "originProviders": result["delivery"]["originProviders"].as_array().cloned().unwrap_or_default(),
            "reportingCurrencies": result["reportingCurrencies"],
            "latestReportDate": result["latestReportDate"],
            "sourceHealth": result["sourceHealth"], "error":result["sourceHealth"]["message"]
        }));
    }
    let availability = if source_error {
        "source_error"
    } else if primary_available {
        "available"
    } else {
        "partial"
    };
    let policy = if code.ends_with(".US") {
        "Yahoo 主财报（本地经配置代理；生产统一 HTTP；无自动回退）"
    } else if code.ends_with(".HK") {
        "Eastmoney HK F10 主财报（无自动回退）"
    } else {
        "Eastmoney 主财报（无自动回退）"
    };
    let quality = quality::try_build(&normalized, "unknown")?;
    let snapshot = build_snapshot(
        &code,
        "unknown",
        policy,
        availability,
        &json!({"status":"not_loaded", "verifiedMetrics":[], "reason":"本任务仅冻结主财报接口数据；法定披露核验明细不属于 taskd 财务分析的前置输入。"}),
        &loaded,
        &quality,
    );
    assert_can_run(&snapshot)?;
    let template =
        std::fs::read_to_string(state.root.join("prompts/research/financial-analysis.md"))?;
    let prompt = template.trim().replacen(
        "{{INPUT_DATA}}",
        &serde_json::to_string(&project_prompt_input(&snapshot))?,
        1,
    );
    Ok(json!({"snapshot":snapshot,"prompt":prompt}))
}

pub fn assert_can_run(snapshot: &Value) -> Result<()> {
    if snapshot["dataQuality"]["status"] != "blocked" {
        return Ok(());
    }
    let unavailable: Vec<&str> = snapshot["dataQuality"]["statements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            row.is_object()
                && (row["rows"].as_u64().unwrap_or(0) == 0
                    || row["sourceHealth"]["status"] == "failed")
        })
        .map(|row| row["statementType"].as_str().unwrap_or("unknown"))
        .collect();
    let suffix = if unavailable.is_empty() {
        String::new()
    } else {
        format!(": {}", unavailable.join(", "))
    };
    bail!("financial analysis is blocked until all primary statements are available{suffix}")
}

pub fn validate_markdown(markdown: &str) -> Result<()> {
    if markdown.encode_utf16().count() < 800 {
        bail!("financial analysis result is shorter than 800 characters");
    }
    let headings: std::collections::HashSet<_> = regex::Regex::new(r"(?m)^# ([1-8])\. ")
        .unwrap()
        .captures_iter(markdown)
        .map(|capture| capture[1].to_string())
        .collect();
    if headings.len() != 8 {
        bail!("financial analysis result must contain all eight numbered H1 headings");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn primary_source_failure_blocks_remote_work() {
        assert!(assert_can_run(&json!({"dataQuality":{"status":"blocked","statements":[{"statementType":"income","rows":0}]}})).unwrap_err().to_string().ends_with(": income"));
        assert!(assert_can_run(&json!({"dataQuality":{"status":"partial"}})).is_ok());
    }
    #[test]
    fn markdown_contract_counts_utf16_and_all_headings() {
        let mut text = "财".repeat(800);
        assert!(validate_markdown(&text).is_err());
        for index in 1..=8 {
            text.push_str(&format!("\n# {index}. 标题\n"));
        }
        assert!(validate_markdown(&text).is_ok());
        assert!(validate_markdown("# 1. short").is_err());
    }
}
