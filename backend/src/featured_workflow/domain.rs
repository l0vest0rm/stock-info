use anyhow::{Context, Result, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub fn sections(source: &Value) -> Result<&Vec<Value>> {
    source["sections"]
        .as_array()
        .context("source sections missing")
}
fn heading(text: &str) -> bool {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Regex::new(r"(?i)^(?:(?:important|general|legal|regulatory)\s+)?(?:disclosure appendi(?:x|ces)|general disclosures?|disclaimers?|legal notices?|legal disclosures?|regulatory disclosures?|important disclosures?|analyst certifications?|analyst disclosures?|conflicts? of interest|distribution restrictions?|copyright(?: notice)?|免责声明|法律声明|重要声明|重要披露|分析师声明|分析师承诺|分析师认证|利益冲突披露|分发限制|版权声明)(?:\s*(?:and|&)\s*(?:disclaimers?|disclosures?|analyst certifications?))*[\s:：.。]*$").unwrap().is_match(&text)
}
fn paragraph(text: &str) -> bool {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let matches = |expression| Regex::new(expression).unwrap().is_match(&text);
    (matches(r"(?i)\bconflict of interest\b")
        && matches(r"(?i)\bobjectivity of this (?:report|research)\b")
        && matches(r"(?i)\bdoes and seeks to do business\b"))
        || (matches(
            r"(?i)(?:\bthis (?:report|material|document|publication)\b|本(?:报告|材料|文件))",
        ) && matches(
            r"(?i)(?:does not constitute (?:investment advice|an offer|a solicitation)|not (?:intended for|for) distribution|may not be (?:reproduced|redistributed)|for informational purposes only|不构成.{0,12}(?:投资建议|要约)|未经.{0,30}(?:不得|禁止).{0,12}(?:复制|转载|传播))",
        ))
}
pub fn select(source: &Value) -> Result<(Value, Vec<Value>)> {
    let mut selected = source.clone();
    let mut kept = Vec::new();
    let mut skipped = Vec::new();
    for section in sections(source)? {
        let mut new = section.clone();
        let mut blocks = Vec::new();
        for block in section["blocks"]
            .as_array()
            .context("source blocks missing")?
        {
            let original = block["original"]
                .as_str()
                .context("source original missing")?;
            let reason = if heading(section["title"].as_str().unwrap_or("")) {
                Some("法律、声明等固定章节")
            } else if heading(original.lines().next().unwrap_or("")) || paragraph(original) {
                Some("法律、声明等固定段落")
            } else {
                None
            };
            if let Some(reason) = reason {
                skipped.push(json!({"id":block["id"],"sectionId":section["id"],"reason":reason,"sourceLocations":block["sourceLocations"]}));
            } else {
                blocks.push(block.clone());
            }
        }
        if !blocks.is_empty() {
            new["blocks"] = json!(blocks);
            kept.push(new);
        }
    }
    selected["sections"] = json!(kept);
    Ok((selected, skipped))
}
pub fn check_coverage(content: &Value, source: &Value) -> Result<()> {
    let (_, skipped) = select(source)?;
    let optional: HashSet<_> = skipped
        .iter()
        .map(|b| b["id"].clone().to_string())
        .collect();
    let mut before = HashMap::new();
    for section in sections(source)? {
        for block in section["blocks"]
            .as_array()
            .context("source blocks missing")?
        {
            let id = block["id"].as_str().context("source block id missing")?;
            if before.insert(id, block).is_some() {
                bail!("duplicate source block id");
            }
        }
    }
    let mut seen = HashSet::new();
    for section in sections(content)? {
        for block in section["blocks"]
            .as_array()
            .context("content blocks missing")?
        {
            let id = block["id"].as_str().context("content block id missing")?;
            if !seen.insert(id) || !before.contains_key(id) {
                bail!("译文段落 ID 重复或不属于原文");
            }
            if block["translation"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
                || block["sourceLocations"] != before[id]["sourceLocations"]
            {
                bail!("段落缺失或原文位置被修改: {id}");
            }
        }
    }
    for id in before.keys() {
        if !seen.contains(id) && !optional.contains(&json!(id).to_string()) {
            bail!("段落缺失: {id}");
        }
    }
    Ok(())
}
fn omission_label(block: &Value, section: &Value) -> &'static str {
    let text = block["original"].as_str().unwrap_or("");
    for (pattern, label) in [
        (
            r"(?i)copyright|©|版权|You are permitted to store",
            "版权及使用限制",
        ),
        (r"(?i)conflict[s]? of interest|利益冲突", "利益冲突披露"),
        (
            r"(?i)Reg AC|hereby certify|analyst certification|分析师声明|分析师认证",
            "分析师声明",
        ),
        (
            r"(?i)regulatory disclosures|laws and regulations|法律声明|法律条文",
            "法律及监管披露",
        ),
        (
            r"(?i)disclaimer|免责声明|does not constitute|not an offer to sell",
            "免责声明",
        ),
    ] {
        if Regex::new(pattern).unwrap().is_match(text) {
            return label;
        }
    }
    if Regex::new(r"(?i)disclosure appendi(?:x|ces)")
        .unwrap()
        .is_match(section["title"].as_str().unwrap_or(""))
    {
        "披露附录（含评级说明等附属信息）"
    } else {
        "法律声明及固定披露信息"
    }
}
pub fn placeholders(source: &Value, translated: &[Value]) -> Result<Vec<Value>> {
    let (_, skipped) = select(source)?;
    let ids: HashSet<_> = skipped.iter().map(|b| b["id"].to_string()).collect();
    let mut map = HashMap::new();
    let mut titles = HashMap::new();
    for section in translated {
        titles.insert(section["id"].to_string(), section["title"].clone());
        for block in section["blocks"]
            .as_array()
            .context("translated blocks missing")?
        {
            map.insert(block["id"].to_string(), block);
        }
    }
    let mut result = Vec::new();
    for section in sections(source)? {
        let mut blocks = Vec::new();
        for block in section["blocks"]
            .as_array()
            .context("source blocks missing")?
        {
            let key = block["id"].to_string();
            if ids.contains(&key) {
                blocks.push(json!({"id":block["id"],"translation":format!("> 【未翻译：{}】此处为非研究正文的附属信息，无需逐段翻译；请参阅对应位置的原文。",omission_label(block,section)),"sourceLocations":block["sourceLocations"]}));
            } else {
                blocks.push((*map.get(&key).context("研究正文译文缺失")?).clone());
            }
        }
        result.push(json!({"id":section["id"],"title":titles.get(&section["id"].to_string()).unwrap_or(&section["title"]),"blocks":blocks}));
    }
    Ok(result)
}
pub fn estimate_tokens(text: &str) -> usize {
    let non_ascii = text.chars().filter(|c| !c.is_ascii()).count();
    (((text.encode_utf16().count() - non_ascii) as f64 * 0.65) + non_ascii as f64 * 1.5).ceil()
        as usize
}
pub fn batches(source: &Value) -> Result<Vec<Vec<Value>>> {
    let mut result = Vec::new();
    let mut batch = Vec::new();
    let mut output = 0;
    let mut input = 0;
    for section in sections(source)? {
        for block in section["blocks"]
            .as_array()
            .context("source blocks missing")?
        {
            let mut item = block.clone();
            item["sectionId"] = section["id"].clone();
            item["sectionTitle"] = section["title"].clone();
            let outgoing = estimate_tokens(
                block["original"]
                    .as_str()
                    .context("source original missing")?,
            ) + 100
                + estimate_tokens(section["title"].as_str().unwrap_or(""));
            let incoming = serde_json::to_vec(&item)?.len();
            if outgoing > 12000 || incoming > 24000 {
                bail!(
                    "{} 超过单批预算，请拆分 source.json 中该段并保留来源位置",
                    block["id"]
                );
            }
            if !batch.is_empty() && (output + outgoing > 12000 || input + incoming > 24000) {
                result.push(batch);
                batch = Vec::new();
                output = 0;
                input = 0;
            }
            batch.push(item);
            output += outgoing;
            input += incoming;
        }
    }
    if !batch.is_empty() {
        result.push(batch);
    }
    Ok(result)
}
pub fn model_blocks(blocks: &[Value]) -> Value {
    json!(
        blocks
            .iter()
            .map(
                |b| json!({"id":b["id"],"original":b["original"],"sectionTitle":b["sectionTitle"]})
            )
            .collect::<Vec<_>>()
    )
}
pub fn validate_translation(value: &Value, blocks: &[Value], digest: bool) -> Result<()> {
    let items = value["items"]
        .as_array()
        .context("Translation coverage mismatch")?;
    if items.len() != blocks.len()
        || (digest && value["digest"].as_str().is_none_or(|s| s.trim().is_empty()))
        || items.iter().zip(blocks).any(|(b, s)| {
            b["id"] != s["id"]
                || b["translation"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty())
        })
    {
        bail!("Translation coverage mismatch");
    }
    Ok(())
}
pub fn validate_summary(value: &Value) -> Result<()> {
    if value["summary"]
        .as_str()
        .is_none_or(|s| s.trim().is_empty())
    {
        bail!("Summary is empty");
    }
    Ok(())
}

// JSON.stringify preserves construction order. Keep the legacy input ordering
// explicitly rather than changing serde_json's map semantics for the whole app.
fn ordered_object(value: &Value, fields: &[&str]) -> Result<String> {
    let map = value
        .as_object()
        .context("translation input must be an object")?;
    let mut entries = Vec::new();
    for key in fields {
        if let Some(value) = map.get(*key) {
            entries.push(format!(
                "{}:{}",
                serde_json::to_string(key)?,
                serde_json::to_string(value)?
            ));
        }
    }
    for (key, value) in map {
        if !fields.contains(&key.as_str()) {
            entries.push(format!(
                "{}:{}",
                serde_json::to_string(key)?,
                serde_json::to_string(value)?
            ));
        }
    }
    Ok(format!("{{{}}}", entries.join(",")))
}
fn block_input(value: &Value) -> Result<String> {
    Ok(format!(
        "[{}]",
        value
            .as_array()
            .context("blocks array missing")?
            .iter()
            .map(|b| ordered_object(b, &["id", "original", "sectionTitle"]))
            .collect::<Result<Vec<_>>>()?
            .join(",")
    ))
}
fn legacy_glossary(value: &Value) -> Result<String> {
    // The prompt's original object is {terms:[{source,target}]}. Preserve any
    // additional provider fields, but an unknown historical shape is guarded
    // by the cache-miss checkpoint check in the calling workflow.
    let terms = value["terms"].as_array().context("Invalid glossary")?;
    let terms = format!(
        "[{}]",
        terms
            .iter()
            .map(|term| {
                if term.is_object() {
                    ordered_object(term, &["source", "target"])
                } else {
                    Ok(serde_json::to_string(term)?)
                }
            })
            .collect::<Result<Vec<_>>>()?
            .join(",")
    );
    let mut entries = vec![format!("\"terms\":{terms}")];
    for (key, value) in value.as_object().context("Invalid glossary")? {
        if key != "terms" {
            entries.push(format!(
                "{}:{}",
                serde_json::to_string(key)?,
                serde_json::to_string(value)?
            ));
        }
    }
    Ok(format!("{{{}}}", entries.join(",")))
}
pub fn cache_key(kind: &str, prompt: &str, input: &Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    let input = match kind {
        "whole" => format!("{{\"blocks\":{}}}", block_input(&input["blocks"])?),
        "translate" => format!(
            "{{\"glossary\":{},\"context\":{},\"blocks\":{}}}",
            legacy_glossary(&input["glossary"])?,
            ordered_object(&input["context"], &["previous", "next"])?,
            block_input(&input["blocks"])?
        ),
        "glossary" | "summary" => format!(
            "[{}]",
            input
                .as_array()
                .context("translation summary/glossary input must be an array")?
                .iter()
                .map(|v| ordered_object(
                    v,
                    &[
                        "title",
                        if kind == "glossary" {
                            "sample"
                        } else {
                            "digest"
                        }
                    ]
                ))
                .collect::<Result<Vec<_>>>()?
                .join(",")
        ),
        _ => bail!("unknown translation cache kind"),
    };
    let text = format!(
        "{{\"model\":\"gpt-5.6-luna\",\"prompt\":{},\"input\":{input}}}",
        serde_json::to_string(prompt)?
    );
    Ok(format!("{:x}", Sha256::digest(text.as_bytes())))
}
