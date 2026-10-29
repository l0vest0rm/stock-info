//! Measured peer comparability. No inferred peer universe or target multiples.
use crate::{AppState, coverage};
use anyhow::Result;
use serde_json::{Value, json};

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn code(value: &Value) -> &str {
    value["code"].as_str().unwrap_or("")
}
fn archetype(value: &Value) -> String {
    coverage::company_archetype(code(value)).unwrap_or_else(|| "other".into())
}

pub fn capital_intensity_class(ratio: Option<f64>) -> &'static str {
    match ratio.filter(|n| n.is_finite()) {
        None => "unknown",
        Some(n) if n < 0.5 => "light",
        Some(n) if n <= 1.0 => "medium",
        Some(_) => "heavy",
    }
}

pub fn comparison_rules(archetype: &str) -> Value {
    let (allowed, forbidden): (&[&str], &[&str]) = match archetype {
        "bank" => (
            &["pb", "pe_ttm", "dividend_yield"],
            &["ev_ebit", "ev_ebitda", "ev_revenue", "fcf_yield"],
        ),
        "insurer" => (
            &["pe_ttm", "dividend_yield"],
            &["pb", "ev_ebit", "ev_ebitda", "ev_revenue", "fcf_yield"],
        ),
        "exchange" => (&["pe_ttm", "ev_ebit", "pb"], &["ev_ebitda"]),
        "payment" => (&["pe_ttm", "ev_ebit", "ev_ebitda", "fcf_yield"], &[]),
        "property_operator" => (&["pb", "dividend_yield", "ev_ebitda"], &["pe_ttm"]),
        "cyclical_commodity" => (
            &["pe_mid_cycle", "ev_ebit", "ev_ebitda", "pe_ttm"],
            &["fcf_yield"],
        ),
        "stable_cash_dividend" => (
            &["fcf_yield", "dividend_yield", "pe_ttm", "ev_ebit"],
            &["ev_revenue"],
        ),
        "growth_manufacturing" => (&["pe_ttm", "ev_ebit", "ev_ebitda", "fcf_yield", "pb"], &[]),
        "software_platform" => (&["pe_ttm", "ev_ebit", "ev_revenue", "fcf_yield"], &["pb"]),
        "pre_profit_milestone" => (
            &["ev_revenue"],
            &[
                "pe_ttm",
                "pe_mid_cycle",
                "ev_ebit",
                "ev_ebitda",
                "pb",
                "fcf_yield",
                "dividend_yield",
            ],
        ),
        "healthcare_services" => (&["pe_ttm", "ev_ebit", "ev_ebitda", "pb"], &["ev_revenue"]),
        _ => (&["pe_ttm"], &[]),
    };
    json!({"allowed":allowed,"forbidden":forbidden})
}

pub fn build(input: &Value) -> Value {
    let company = &input["company"];
    let archetype = archetype(company);
    let rules = comparison_rules(&archetype);
    let intensity = capital_intensity_class(company["depreciationToEbit"].as_f64());
    let mut peers = Vec::new();
    let supported = |item: &Value, metric: &Value| {
        item.get("availableMetrics")
            .and_then(Value::as_array)
            .is_none_or(|list| list.contains(metric))
    };
    for peer in array(&input["peers"]) {
        let peer_archetype = archetype_for(peer);
        let peer_intensity = capital_intensity_class(peer["depreciationToEbit"].as_f64());
        let peer_rules = comparison_rules(&peer_archetype);
        let mut comparable = Vec::new();
        let mut blocked = Vec::new();
        for metric in array(&rules["allowed"]) {
            let metric_text = metric.as_str().unwrap_or("");
            let reason = if peer_archetype != archetype {
                Some(format!(
                    "业务模型不同（{archetype} vs {peer_archetype}），倍数口径不可互换。"
                ))
            } else if !array(&peer_rules["allowed"]).contains(metric) {
                Some(format!("对方原型禁用 {metric_text}。"))
            } else if ["ev_ebitda", "ev_revenue", "pb", "fcf_yield"].contains(&metric_text)
                && intensity != "unknown"
                && peer_intensity != "unknown"
                && intensity != peer_intensity
            {
                Some(format!(
                    "资本密度不同（{intensity} vs {peer_intensity}），{metric_text} 会系统性偏移。"
                ))
            } else if ["pe_ttm", "pe_mid_cycle"].contains(&metric_text)
                && archetype == "cyclical_commodity"
                && (company["midCycleAvailable"] != true || peer["midCycleAvailable"] != true)
            {
                Some("周期股缺少一方或双方的中枢利润，利润类倍数不可比。".to_string())
            } else if !supported(company, metric) || !supported(peer, metric) {
                Some("一方缺少该口径的分母。".to_string())
            } else {
                None
            };
            if let Some(reason) = reason {
                blocked.push(json!({"metric":metric,"reason":reason}));
            } else {
                comparable.push(metric.clone());
            }
        }
        peers.push(json!({"peer":peer["code"],"comparableMetrics":comparable,"blocked":blocked}));
    }
    let mut notes = Vec::new();
    if intensity == "unknown" {
        notes.push(json!(
            "本公司缺少折旧摊销，无法判定资本密度；带资本密度门槛的倍数对比默认不可用。"
        ));
    }
    if archetype == "cyclical_commodity" {
        notes.push(json!("周期股只能与同为周期型、且双方中枢利润都成立的公司比较利润倍数；TTM 倍数在周期两端都失真。"));
    }
    if peers.is_empty() {
        notes.push(json!("未提供可比公司；矩阵为空不表示可自由套用任何倍数。"));
    }
    let profile = coverage::valuation_profile(&archetype);
    let labels: Vec<&str> = array(&profile["methods"])
        .iter()
        .filter(|m| m["role"] == "primary")
        .filter_map(|m| m["label"].as_str())
        .collect();
    notes.push(json!(format!(
        "原型 {archetype} 的主方法：{}",
        if labels.is_empty() {
            "无".into()
        } else {
            labels.join("、")
        }
    )));
    json!({"code":company["code"],"archetype":archetype,"capitalIntensity":{"ratio":company.get("depreciationToEbit").unwrap_or(&Value::Null),"class":intensity},"archetypeMetrics":rules["allowed"],"forbiddenMetrics":rules["forbidden"],"peers":peers,"notes":notes})
}

fn archetype_for(value: &Value) -> String {
    archetype(value)
}

pub async fn load(state: &AppState, raw_code: &str, peer_codes: &[String]) -> Result<Value> {
    let code = crate::codes::normalize(raw_code);
    let mut codes = vec![code.clone()];
    for peer in peer_codes {
        let peer = crate::codes::normalize(peer);
        if !peer.is_empty() && peer != code {
            codes.push(peer);
        }
    }
    // Mirror the existing Promise.all: independent issuer measurements share
    // the unified HTTP domain limits, while the response keeps caller order.
    let mut readings = vec![Value::Null; codes.len()];
    let mut jobs = tokio::task::JoinSet::new();
    for (index, code) in codes.into_iter().enumerate() {
        let state = state.clone();
        jobs.spawn(async move { (index, measure(&state, &code).await) });
    }
    while let Some(reading) = jobs.join_next().await {
        let (index, reading) = reading?;
        readings[index] = reading;
    }
    Ok(build(
        &json!({"company":readings[0],"peers":&readings[1..]}),
    ))
}

async fn measure(state: &AppState, code: &str) -> Value {
    let archetype = coverage::company_archetype(code);
    let (inputs, mid_cycle) = tokio::join!(crate::finance::valuation_inputs(state, code), async {
        if archetype.as_deref() == Some("cyclical_commodity") {
            crate::finance::mid_cycle_history(state, code).await.ok()
        } else {
            None
        }
    });
    let inputs = inputs.ok();
    let value = |key: &str| {
        inputs
            .as_ref()
            .and_then(|inputs| {
                array(&inputs["lines"])
                    .iter()
                    .find(|line| line["key"] == key)
            })
            .and_then(|line| line.get("value"))
            .filter(|value| !value.is_null())
            .cloned()
    };
    let ebit = value("ebit").and_then(|v| v.as_f64());
    let ebitda = value("ebitda").and_then(|v| v.as_f64());
    let mut available = Vec::new();
    if value("netProfit").is_some() {
        available.push("pe_ttm");
    }
    if ebit.is_some() {
        available.push("ev_ebit");
    }
    if ebitda.is_some() {
        available.push("ev_ebitda");
    }
    if value("parentEquity").is_some() {
        available.push("pb");
    }
    if mid_cycle.as_ref().is_some_and(|m| {
        m["earnings"]["status"] == "available" && !m["earnings"]["median"].is_null()
    }) {
        available.push("pe_mid_cycle");
    }
    let ratio = ebit
        .filter(|n| *n > 0.0)
        .zip(ebitda)
        .map(|(ebit, ebitda)| (ebitda - ebit) / ebit);
    json!({"code":code,"depreciationToEbit":ratio,"midCycleAvailable":mid_cycle.as_ref().map(|m|m["earnings"]["status"]=="available"),"availableMetrics":available})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capital_classes_and_pair_gates_match_source_rules() {
        for (ratio, expected) in [
            (Some(0.07), "light"),
            (Some(0.5), "medium"),
            (Some(1.0), "medium"),
            (Some(1.44), "heavy"),
            (None, "unknown"),
        ] {
            assert_eq!(capital_intensity_class(ratio), expected);
        }
        let matrix = build(
            &json!({"company":{"code":"300308.SZ","depreciationToEbit":0.07},"peers":[{"code":"300394.SZ","depreciationToEbit":0.2},{"code":"002594.SZ","depreciationToEbit":5.6},{"code":"600519.SH","depreciationToEbit":0.04}]}),
        );
        assert!(array(&matrix["peers"][0]["comparableMetrics"]).contains(&json!("ev_ebitda")));
        assert!(array(&matrix["peers"][1]["comparableMetrics"]).contains(&json!("ev_ebit")));
        assert!(!array(&matrix["peers"][1]["comparableMetrics"]).contains(&json!("ev_ebitda")));
        assert!(array(&matrix["peers"][2]["comparableMetrics"]).is_empty());
        let cycle = build(
            &json!({"company":{"code":"601919.SH","depreciationToEbit":0.6,"midCycleAvailable":true},"peers":[{"code":"601899.SH","depreciationToEbit":0.5,"midCycleAvailable":false}]}),
        );
        assert!(!array(&cycle["peers"][0]["comparableMetrics"]).contains(&json!("pe_mid_cycle")));
        let missing = build(
            &json!({"company":{"code":"300308.SZ","depreciationToEbit":0.07,"availableMetrics":["pe_ttm"]},"peers":[{"code":"300394.SZ","depreciationToEbit":0.2,"availableMetrics":["pe_ttm"]}]}),
        );
        assert_eq!(missing["peers"][0]["comparableMetrics"], json!(["pe_ttm"]));
    }
}
