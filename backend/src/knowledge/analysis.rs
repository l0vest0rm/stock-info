use super::{
    documents::{BASE, bad},
    parse_json, text,
};
use crate::{ApiResult, AppState, http::number, ok};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::StatusCode,
};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;

fn namespace(key: &str) -> &'static str {
    if key.starts_with("shared-report-analysis:") {
        "shared_report_analysis"
    } else {
        "knowledge_report_analysis"
    }
}
fn reusable(value: &Value) -> bool {
    value["analysisCalled"] == true
        && value["forecasts"].is_array()
        && (value["forecasts"].as_array().is_some_and(|a| !a.is_empty())
            || value["analysisSucceeded"] == true)
}
async fn cached(state: &AppState, key: &str) -> anyhow::Result<Option<Value>> {
    if key.is_empty() {
        return Ok(None);
    }
    Ok(state.db.get_kv(namespace(key), key).await?.filter(reusable))
}
async fn persist(state: &AppState, key: &str, value: &Value) -> anyhow::Result<()> {
    if !key.is_empty() {
        state
            .db
            .put_kv(
                namespace(key),
                key,
                value,
                Some(chrono::Utc::now().timestamp_millis() + 30 * 86_400_000),
            )
            .await?;
    }
    Ok(())
}
fn shared_key(row: &Value, metadata: &Value) -> String {
    let expression = regex::Regex::new(r"AP\d{12,}").unwrap();
    for value in [
        &metadata["infoCode"],
        &metadata["raw"]["infoCode"],
        &row["url"],
    ] {
        if let Some(found) = expression.find(&text(value).to_uppercase()) {
            return format!("shared-report-analysis:v8:eastmoney:{}", found.as_str());
        }
    }
    String::new()
}
fn slots(state: &AppState) -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| {
            Arc::new(Semaphore::new(
                state
                    .setting("KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY")
                    .parse::<usize>()
                    .ok()
                    .filter(|v| *v > 0)
                    .unwrap_or(2),
            ))
        })
        .clone()
}

pub async fn report(
    State(state): State<AppState>,
    body: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    let body = body.map(|v| v.0).unwrap_or_else(|_| json!({}));
    let id = text(&body["id"]).trim();
    if id.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "missing doc id"));
    }
    let rows = state
        .db
        .query(format!("{BASE} WHERE d.doc_id=?"), vec![json!(id)])
        .await?;
    let row = rows.first().ok_or_else(|| {
        bad(
            StatusCode::NOT_FOUND,
            format!("knowledge document not found: {id}"),
        )
    })?;
    if row["source_type"] != "research_report" || row["report_type"] != "company_report" {
        return Err(bad(
            StatusCode::BAD_REQUEST,
            "document is not a company report",
        ));
    }
    let metadata = parse_json(&row["metadata_json"]);
    let key = format!("knowledge-report-analysis:{id}");
    let shared = shared_key(row, &metadata);
    let legacy = cached(&state, &key).await?;
    let shared_cached = cached(&state, &shared).await?;
    if let Some(legacy) = &legacy
        && !shared.is_empty()
        && shared_cached.is_none()
    {
        persist(&state, &shared, legacy).await?;
    }
    let mut analysis = legacy.or(shared_cached);
    if analysis.is_none() {
        let lock =
            crate::company::report_analysis_lock(if shared.is_empty() { &key } else { &shared });
        let _single = lock.lock().await;
        analysis = cached(&state, &shared)
            .await?
            .or(cached(&state, &key).await?);
        if analysis.is_none() {
            let _slot = slots(&state)
                .acquire_owned()
                .await
                .map_err(anyhow::Error::from)?;
            let content = load_markdown(&state, row).await?;
            if content.trim().is_empty() {
                return Err(bad(
                    StatusCode::BAD_GATEWAY,
                    "knowledge report has no converted content and the converter is unavailable",
                ));
            }
            let extracted = crate::company::analyze_report(
                &state,
                text(&row["title"]),
                &content,
                id,
                &format!("knowledge-report-forecast:{id}"),
            )
            .await?;
            let completed = json!({"analysisCalled":true,"analysisSucceeded":true,"forecasts":extracted["forecasts"],"targetPrice":extracted["targetPrice"],"updatedAt":chrono::Utc::now().timestamp_millis()});
            persist(&state, &key, &completed).await?;
            persist(&state, &shared, &completed).await?;
            analysis = Some(completed);
        }
    }
    let analysis = analysis.ok_or_else(|| {
        bad(
            StatusCode::INTERNAL_SERVER_ERROR,
            "knowledge report analysis completed without a cached result",
        )
    })?;
    let code = crate::codes::normalize_company(text(&row["target_code"]));
    let (overview, annual) = if !code.is_empty() {
        let (overview, model) = tokio::join!(
            crate::company::eastmoney_overview(&state, &code),
            crate::finance::read_model(&state, &code, "income")
        );
        let annual = model
            .ok()
            .filter(|m| m["sourceHealth"]["status"] != "failed")
            .and_then(|m| {
                crate::finance::annual_income(
                    m["rows"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                )
                .into_iter()
                .find(|a| a["fiscalYear"] == 2025)
            });
        (overview.ok(), annual)
    } else {
        (None, None)
    };
    let price = overview.as_ref().and_then(|v| number(&v["latestPrice"]));
    let cap = overview.as_ref().and_then(|v| number(&v["marketCapYi"]));
    let mut forecasts = forecast_metrics(
        analysis["forecasts"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        price,
        cap,
        annual.as_ref(),
    );
    let p2026 = peg(&forecasts, 2026);
    let p2027 = peg(&forecasts, 2027);
    let p2028 = peg(&forecasts, 2028);
    let pe2028 = forecasts
        .iter()
        .find(|f| f["year"] == 2028)
        .and_then(|f| number(&f["current_pe"]));
    let pegs = forecasts
        .iter()
        .map(|f| peg(&forecasts, f["year"].as_i64().unwrap_or_default()))
        .collect::<Vec<_>>();
    for (forecast, peg) in forecasts.iter_mut().zip(pegs) {
        forecast["peg"] = json!(peg);
    }
    let pages = [
        &metadata["raw"]["attachPages"],
        &metadata["attachPages"],
        &metadata["pageCount"],
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .and_then(number)
    .filter(|n| *n > 0.0 && n.fract() == 0.0);
    Ok(ok(
        json!({"doc_id":id,"report_pages":pages,"analysis_called":analysis["analysisCalled"],"analysis_updated_at":analysis["updatedAt"],"latest_price":price,"market_cap_yi":cap,"forecasts":forecasts,"target_price":analysis["targetPrice"],"peg_2026":p2026,"peg_2027":p2027,"peg_2028":p2028,"recommended":p2028.is_some_and(|v|v<1.0)&&pe2028.is_some_and(|v|v<100.0)}),
    ))
}

async fn load_markdown(state: &AppState, row: &Value) -> anyhow::Result<String> {
    let key = text(&row["content_key"]);
    if !key.is_empty()
        && let Some(content) = super::read_content_text(state, key).await?
    {
        return Ok(content.trim().chars().take(12000).collect());
    }
    if !text(&row["inline_content"]).is_empty() {
        return Ok(text(&row["inline_content"])
            .trim()
            .chars()
            .take(12000)
            .collect());
    }
    let url = text(&row["url"]);
    if url.to_lowercase().contains(".pdf") {
        return Ok(
            super::content::convert_cached(state, text(&row["doc_id"]), url, false)
                .await?
                .trim()
                .chars()
                .take(12000)
                .collect(),
        );
    }
    // A legacy remote content reference has no local object key; preserve the
    // explicit stored content URL without introducing a Cloudflare fallback.
    let url = text(&row["content_url"]);
    if !url.is_empty() && super::importer::valid_url(url) {
        return Ok(state
            .http
            .text(
                url,
                reqwest::Method::GET,
                reqwest::header::HeaderMap::new(),
                None,
            )
            .await?
            .trim()
            .chars()
            .take(12000)
            .collect());
    }
    Ok(String::new())
}
fn rounded(value: Option<f64>) -> Option<f64> {
    value
        .filter(|n| n.is_finite())
        .map(|n| (n * 100.0 + 0.5).floor() / 100.0)
}
fn growth(current: Option<f64>, previous: Option<f64>) -> Option<f64> {
    rounded(
        current
            .zip(previous)
            .filter(|(_, p)| *p != 0.0)
            .map(|(c, p)| (c / p - 1.0) * 100.0),
    )
}
fn year(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| {
                n.is_finite() && n.fract() == 0.0 && *n >= i64::MIN as f64 && *n < i64::MAX as f64
            })
            .map(|n| n as i64)
    })
}
fn forecast_metrics(
    raw: &[Value],
    price: Option<f64>,
    cap: Option<f64>,
    annual: Option<&Value>,
) -> Vec<Value> {
    let mut sorted = raw
        .iter()
        .filter(|r| year(&r["year"]).is_some())
        .collect::<Vec<_>>();
    sorted.sort_by_key(|r| year(&r["year"]));
    sorted.iter().enumerate().map(|(index,row)|{
        let previous=index.checked_sub(1).map(|i|sorted[i]);let year=year(&row["year"]).unwrap();
        let annual=annual.filter(|a|a["fiscalYear"].as_i64()==Some(year-1));
        let annual_revenue=annual.and_then(|a|number(&a["revenue"])).map(|n|rounded(Some(n/100_000_000.0)).unwrap());
        let annual_profit=annual.and_then(|a|number(&a["netProfit"])).map(|n|rounded(Some(n/100_000_000.0)).unwrap());
        let previous_revenue=previous.and_then(|p|number(&p["revenue"])).or(annual_revenue);let previous_profit=previous.and_then(|p|number(&p["netProfit"])).or(annual_profit);
        let profit=number(&row["netProfit"]);let eps=number(&row["eps"]);
        let pe=cap.filter(|c|*c>0.0).zip(profit.filter(|p|*p>0.0)).map(|(c,p)|c/p).or_else(||price.filter(|p|*p>0.0).zip(eps.filter(|e|*e>0.0)).map(|(p,e)|p/e));
        json!({"year":year,"revenue":rounded(number(&row["revenue"])),"revenue_growth":rounded(number(&row["revenueGrowth"])).or_else(||growth(number(&row["revenue"]),previous_revenue)),"net_profit":rounded(profit),"profit_growth":rounded(number(&row["profitGrowth"])).or_else(||growth(profit,previous_profit)),"current_pe":rounded(pe)})
    }).collect()
}
fn peg(forecasts: &[Value], year: i64) -> Option<f64> {
    let row = forecasts
        .iter()
        .find(|r| r["year"].as_i64() == Some(year))?;
    rounded(
        number(&row["current_pe"])
            .zip(number(&row["profit_growth"]))
            .filter(|(pe, g)| *pe >= 0.0 && *g > 0.0)
            .map(|(pe, g)| pe / g),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn growth_pe_and_peg_preserve_missing_values() {
        let rows = forecast_metrics(
            &[
                json!({"year":2026,"revenue":120,"netProfit":12}),
                json!({"year":2027,"revenue":150,"netProfit":15}),
                json!({"year":2028,"eps":2}),
            ],
            Some(10.0),
            Some(120.0),
            Some(&json!({"fiscalYear":2025,"revenue":10000000000_f64,"netProfit":1000000000_f64})),
        );
        assert_eq!(rows[0]["revenue_growth"], 20.0);
        assert_eq!(rows[0]["profit_growth"], 20.0);
        assert_eq!(rows[0]["current_pe"], 10.0);
        assert_eq!(peg(&rows, 2026), Some(0.5));
        assert_eq!(rows[2]["current_pe"], 5.0);
        assert!(peg(&rows, 2028).is_none());
    }
    #[test]
    fn javascript_integral_years_and_negative_rounding_are_preserved() {
        let rows = forecast_metrics(
            &[json!({"year":2026.0,"revenue":-1.125,"netProfit":10})],
            None,
            None,
            None,
        );
        assert_eq!(rows[0]["year"], 2026);
        assert_eq!(rows[0]["revenue"], -1.12);
        assert!(forecast_metrics(&[json!({"year":2026.5})], None, None, None).is_empty());
        assert!(forecast_metrics(&[json!({"year":"2026"})], None, None, None).is_empty());
    }
    #[test]
    fn failed_analysis_cache_is_not_reused() {
        assert!(!reusable(&json!({"analysisCalled":true,"forecasts":[]})));
        assert!(reusable(
            &json!({"analysisCalled":true,"analysisSucceeded":true,"forecasts":[]})
        ));
    }
}
