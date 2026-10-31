//! Deterministic topic policy and explicit local-only, title-only LLM review.
use crate::AppState;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::HashSet;

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("").trim()
}
fn values(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let s = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            };
            (!s.trim().is_empty()).then(|| s.trim().to_string())
        })
        .collect()
}
fn rows(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten()
}
fn first(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|k| text(&v[*k]))
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .into()
}
fn subjects(doc: &Value) -> Vec<String> {
    rows(&doc["metadata"]["subjects"])
        .map(|v| first(v, &["subject_name", "subjectName", "name"]))
        .collect()
}
fn labels(doc: &Value) -> String {
    let mut all = values(&doc["tags"]);
    all.extend(subjects(doc));
    all.join(" ").to_lowercase()
}
fn haystack(doc: &Value) -> String {
    let mut all = vec![text(&doc["title"]).into(), text(&doc["summary"]).into()];
    for v in [
        &doc["tags"],
        &doc["metadata"]["stockNames"],
        &doc["metadata"]["stockCodes"],
    ] {
        all.extend(values(v));
    }
    all.extend(subjects(doc));
    all.extend(rows(&doc["metadata"]["stockList"]).map(|v| {
        first(
            v,
            &[
                "StockName",
                "stockName",
                "name",
                "StockID",
                "stockId",
                "code",
            ],
        )
    }));
    all.join(" ").to_lowercase()
}
fn matches(haystack: &str, v: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    values(v)
        .into_iter()
        .filter(|s| haystack.contains(&s.to_lowercase()) && seen.insert(s.clone()))
        .collect()
}
fn linked(doc: &Value) -> bool {
    [
        &doc["stockLinks"],
        &doc["metadata"]["stockList"],
        &doc["metadata"]["stockNames"],
        &doc["metadata"]["stockCodes"],
    ]
    .iter()
    .any(|v| v.as_array().is_some_and(|a| !a.is_empty()))
}
fn integer(v: &Value, default: i64) -> i64 {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(default)
}
fn boolean(s: &str) -> Option<bool> {
    match s.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}
fn decision(keep: bool, method: &str, score: i64, reasons: Vec<String>) -> Value {
    json!({"keep":keep,"method":method,"score":score,"reasons":reasons})
}
fn keyword(doc: &Value, filter: &Value) -> Value {
    let stock = linked(doc);
    let haystack = haystack(doc);
    let mut reasons = if stock {
        vec!["股票关联".into()]
    } else {
        vec![]
    };
    if filter["mode"] == "blacklist" {
        let market = matches(&haystack, &filter["marketOverrideKeywords"]);
        if stock || !market.is_empty() {
            reasons.extend(market.into_iter().map(|s| format!("市场信号:{s}")));
            return json!({"score":0,"blocked":false,"reasons":reasons});
        }
        let title = text(&doc["title"]).to_lowercase();
        let labels = labels(doc);
        for rule in rows(&filter["blacklistRules"]) {
            let id = text(&rule["id"]);
            if id.is_empty() {
                continue;
            }
            let ta = values(&rule["titleAll"]);
            let ty = values(&rule["titleAny"]);
            let la = values(&rule["labelAll"]);
            let ly = values(&rule["labelAny"]);
            if ta.len() + ty.len() + la.len() + ly.len() > 0
                && ta.iter().all(|s| title.contains(&s.to_lowercase()))
                && (ty.is_empty() || ty.iter().any(|s| title.contains(&s.to_lowercase())))
                && la.iter().all(|s| labels.contains(&s.to_lowercase()))
                && (ly.is_empty() || ly.iter().any(|s| labels.contains(&s.to_lowercase())))
            {
                reasons.push(format!("黑名单:{id}"));
            }
        }
        return json!({"score":-2*(reasons.len() as i64),"blocked":!reasons.is_empty(),"reasons":reasons});
    }
    let core = matches(&haystack, &filter["coreKeywords"]);
    let support = matches(&haystack, &filter["supportKeywords"]);
    let bypass = matches(&haystack, &filter["denyBypassKeywords"]);
    let deny = if bypass.is_empty() {
        matches(&haystack, &filter["denyKeywords"])
    } else {
        vec![]
    };
    let score = core.len() as i64 * 2 + support.len() as i64 + if stock { 2 } else { 0 }
        - deny.len() as i64 * 2;
    for (prefix, items) in [
        ("核心", core),
        ("相关", support),
        ("优先", bypass),
        ("排除", deny),
    ] {
        reasons.extend(items.into_iter().map(|s| format!("{prefix}:{s}")));
    }
    json!({"score":score,"reasons":reasons})
}
fn local_decision(doc: &Value, filter: &Value) -> (Value, bool) {
    if !filter["enabled"].as_bool().unwrap_or(false) {
        return (decision(true, "disabled", 0, vec![]), false);
    }
    if values(&filter["bypassSourceTypes"])
        .iter()
        .any(|s| s == text(&doc["sourceType"]))
        || values(&filter["bypassReportTypes"])
            .iter()
            .any(|s| s == text(&doc["reportType"]))
    {
        return (
            decision(true, "report_bypass", 0, vec!["研报不执行主题过滤".into()]),
            false,
        );
    }
    let mut local = keyword(doc, filter);
    let score = integer(&local["score"], 0);
    if filter["mode"] == "blacklist" {
        local["keep"] = json!(!local["blocked"].as_bool().unwrap_or(false));
        local["method"] = json!("blacklist");
        return (local, false);
    }
    let keep = score >= integer(&filter["minScore"], 2);
    let uncertain = !keep
        && score >= integer(&filter["uncertainMinScore"], 1)
        && score <= integer(&filter["uncertainMaxScore"], 1);
    local["keep"] = json!(keep);
    local["method"] = json!("local");
    (local, uncertain)
}

pub async fn evaluate(
    state: &AppState,
    docs: &[Value],
    config: &Value,
) -> Result<(Vec<Value>, Vec<Value>)> {
    let filter = &config["topicFilter"];
    let mut decisions = Vec::with_capacity(docs.len());
    let mut uncertain = Vec::new();
    for (index, doc) in docs.iter().enumerate() {
        let (local, pending) = local_decision(doc, filter);
        decisions.push(local);
        if pending {
            uncertain.push(index);
        }
    }
    if uncertain.is_empty()
        || !boolean(&state.setting("KNOWLEDGE_PROCESS_TOPIC_LLM"))
            .unwrap_or(filter["llmReview"].as_bool().unwrap_or(false))
    {
        return Ok((decisions, vec![]));
    }
    let routing = crate::llm::config(state)?;
    let model = routing.model;
    let key = state.setting(&routing.api_key_env);
    if key.is_empty() {
        for i in uncertain {
            decisions[i]["method"] = json!("local_missing_llm_key");
        }
        return Ok((decisions, vec![]));
    }
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("knowledge topic LLM requires local runtime");
    }
    let system =
        std::fs::read_to_string(state.root.join("prompts/knowledge/topic-batch-system.md"))?
            .trim()
            .to_string();
    let user_template =
        std::fs::read_to_string(state.root.join("prompts/knowledge/topic-batch-user.md"))?
            .trim()
            .to_string();
    let batch_size = integer(&filter["llmBatchSize"], 50).clamp(1, 10000) as usize;
    let total = uncertain.len().div_ceil(batch_size);
    let mut audits = Vec::new();
    for (batch_index, batch) in uncertain.chunks(batch_size).enumerate() {
        let items = batch
            .iter()
            .enumerate()
            .map(|(i, index)| json!({"index":i,"title":docs[*index]["title"]}))
            .collect::<Vec<_>>();
        let user = user_template.replace("{{ITEMS_JSON}}", &serde_json::to_string(&items)?);
        let prompt = json!({"system":system,"user":user});
        // Invalid/truncated responses fail without automatically replaying model work.
        let response = request(state, &system, &user).await?;
        let parsed = parse_json(&response).context("knowledge topic LLM returned invalid JSON")?;
        for (index, doc_index) in batch.iter().enumerate() {
            let result = rows(&parsed["items"])
                .filter(|r| r["index"].as_u64() == Some(index as u64))
                .last()
                .cloned()
                .unwrap_or(Value::Null);
            let confidence = result["confidence"]
                .as_f64()
                .or_else(|| result["confidence"].as_str().and_then(|s| s.parse().ok()))
                .filter(|n| n.is_finite())
                .unwrap_or(0.0);
            let is_ai = result["isAi"].as_bool().unwrap_or(false);
            let keep = is_ai && confidence >= filter["llmMinConfidence"].as_f64().unwrap_or(0.65);
            let local = decisions[*doc_index].clone();
            let mut reasons = values(&local["reasons"]);
            let reason = text(&result["reason"]);
            if !reason.is_empty() {
                reasons.push(reason.into());
            }
            decisions[*doc_index] = json!({"keep":keep,"method":"llm_batch","score":local["score"],"reasons":reasons,"confidence":confidence,"model":model});
            let doc = &docs[*doc_index];
            audits.push(json!({"runId":config.get("runId").cloned().unwrap_or(Value::Null),"batchIndex":batch_index,"totalBatches":total,"promptVersion":"ai-topic-batch-v2","source":"topic_filter_uncertain","docId":doc["docId"],"title":doc["title"],"sourceType":doc["sourceType"],"reportType":doc["reportType"],"localScore":local["score"],"localReasons":local["reasons"],"llmModel":model,"llmCached":false,"llmConfidence":confidence,"llmIsAi":is_ai,"llmReason":reason,"finalKeep":keep,"finalMethod":"llm_batch","finalReasons":reasons,"input":items[index],"prompt":prompt,"rawResult":result}));
        }
    }
    Ok((decisions, audits))
}
fn parse_json(raw: &str) -> Option<Value> {
    let first = raw.find('{')?;
    let last = raw.rfind('}')?;
    let value: Value = serde_json::from_str(raw.get(first..=last)?).ok()?;
    value.is_object().then_some(value)
}
async fn request(state: &AppState, system: &str, user: &str) -> Result<String> {
    crate::research::taskd::direct_text(state, &json!({
        "instructions":system,"input":[{"role":"user","content":[{"type":"input_text","text":user}]}]
    })).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blacklist_preserves_market_override_and_checks_labels() {
        let f = json!({"enabled":true,"mode":"blacklist","marketOverrideKeywords":["半导体"],"blacklistRules":[{"id":"discipline","labelAny":["纪委动态"],"titleAny":["市政府"]}]});
        let (d, _) = local_decision(&json!({"title":"市政府消息","tags":["纪委动态"]}), &f);
        assert_eq!(d["keep"], false);
        assert_eq!(d["score"], -2);
        let (d, _) = local_decision(&json!({"title":"半导体市政府消息","tags":["纪委动态"]}), &f);
        assert_eq!(d["keep"], true);
    }
    #[test]
    fn body_is_not_topic_evidence() {
        let f = json!({"enabled":true,"coreKeywords":["AI"]});
        let (d, u) = local_decision(&json!({"title":"天气预报","markdown":"AI"}), &f);
        assert_eq!(d["keep"], false);
        assert!(!u);
    }
    #[test]
    fn report_bypass_precedes_blacklist() {
        let (d, _) = local_decision(
            &json!({"sourceType":"research_report"}),
            &json!({"enabled":true,"bypassSourceTypes":["research_report"],"mode":"blacklist"}),
        );
        assert_eq!(d["method"], "report_bypass");
    }
    #[test]
    fn uncertain_stock_and_deny_bypass() {
        let f = json!({"enabled":true,"supportKeywords":["科技"],"denyKeywords":["天气"],"denyBypassKeywords":["半导体"]});
        let (d, u) = local_decision(&json!({"title":"科技"}), &f);
        assert!(u);
        assert_eq!(d["keep"], false);
        let (d, _) = local_decision(&json!({"title":"天气半导体","stockLinks":[{}]}), &f);
        assert_eq!(d["keep"], true);
    }
}
