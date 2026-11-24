//! Bounded 90-day A-share broker report pool; no discovery, LLM or ledger access.
use super::{domain, sources};
use crate::{Runtime, codes};
use anyhow::Result;
use chrono::{NaiveDate, Utc};
use serde_json::Value;

/// Eastmoney is required; Sina supplements it. Unknown publication dates are retained.
pub async fn recent(state: &impl Runtime, code: &str) -> Result<Vec<Value>> {
    recent_with_supplements(state, code, async { Ok(Vec::new()) }, &[]).await
}

/// Optionally include caller-owned news and previously discovered reports in the same
/// deduplication and date window. No additional sources are scheduled by the crate.
pub async fn recent_with_supplements(
    state: &impl Runtime,
    raw_code: &str,
    knowledge: impl std::future::Future<Output = Result<Vec<Value>>> + Send,
    discovered: &[Value],
) -> Result<Vec<Value>> {
    let normalized = codes::normalize(raw_code);
    let code = normalized.as_str();
    if ![".SH", ".SZ", ".BJ"].iter().any(|s| code.ends_with(s)) {
        return Ok(Vec::new());
    }
    let (eastmoney, sina, knowledge) = tokio::join!(
        sources::eastmoney_reports(state, code, 1, 100),
        sources::sina_reports(state, code, 1),
        knowledge
    );
    merge_source_outcomes(
        eastmoney,
        sina,
        knowledge,
        discovered,
        Utc::now().timestamp_millis(),
    )
}
fn merge_source_outcomes(
    eastmoney: Result<Vec<Value>>,
    sina: Result<Vec<Value>>,
    knowledge: Result<Vec<Value>>,
    discovered: &[Value],
    now_ms: i64,
) -> Result<Vec<Value>> {
    let eastmoney = eastmoney?;
    let optional = |result: Result<Vec<Value>>, source: &str| match result {
        Ok(rows) => rows,
        Err(error) => {
            eprintln!("company report optional {source} source unavailable: {error:#}");
            Vec::new()
        }
    };
    let rows = domain::merge_reports(
        &domain::merge_reports(
            &domain::merge_reports(&eastmoney, &optional(sina, "Sina")),
            &optional(knowledge, "knowledge"),
        ),
        discovered,
    );
    let cutoff = now_ms - 90 * 86_400_000;
    Ok(rows
        .into_iter()
        .filter(|item| {
            NaiveDate::parse_from_str(
                item["publishDate"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .get(..10)
                    .unwrap_or(""),
                "%Y-%m-%d",
            )
            .ok()
            .map(|date| {
                date.and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
                    .timestamp_millis()
                    >= cutoff
            })
            .unwrap_or(true)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn source_failures_preserve_mandatory_provider_boundary() {
        let failed = merge_source_outcomes(
            Err(anyhow::anyhow!("Eastmoney upstream HTTP 503")),
            Ok(vec![
                json!({"title":"Supplement","url":"https://example.com/supplement"}),
            ]),
            Ok(vec![]),
            &[],
            1_800_000_000_000,
        )
        .unwrap_err();
        assert!(failed.to_string().contains("Eastmoney upstream HTTP 503"));
        let primary =
            json!({"title":"Current","infoCode":"AP202610290000001","publishDate":"2026-10-29"});
        let rows = merge_source_outcomes(
            Ok(vec![
                primary.clone(),
                json!({"title":"Old","infoCode":"AP202001010000001","publishDate":"2020-01-01"}),
            ]),
            Err(anyhow::anyhow!("Sina unavailable")),
            Err(anyhow::anyhow!("Knowledge unavailable")),
            &[json!({"title":"Unknown date","url":"https://example.com/unknown"})],
            NaiveDate::from_ymd_opt(2026, 10, 29)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .any(|row| row["infoCode"] == primary["infoCode"])
        );
        assert!(!rows.iter().any(|row| row["title"] == "Old"));
        assert!(rows.iter().any(|row| row["title"] == "Unknown date"));
    }
}
