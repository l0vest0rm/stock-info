use anyhow::{Result, bail};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use unicode_normalization::UnicodeNormalization;

pub const DEDUPE_VERSION: &str = "feed-dedupe-v3";
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn first<'a>(values: &[&'a Value]) -> &'a str {
    values
        .iter()
        .map(|v| s(v).trim())
        .find(|v| !v.is_empty())
        .unwrap_or("")
}
fn re(p: &str) -> Regex {
    Regex::new(p).expect("static feed rule")
}
fn replace(text: &str, p: &str, to: &str) -> String {
    re(p).replace_all(text, to).into_owned()
}
fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
fn prefix(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(n).collect::<Vec<_>>())
}
pub fn normalized_body(text: &str) -> String {
    let text: String = text.nfkc().collect();
    let text = replace(&text, "\\r\\n?", "\n");
    let text = replace(&text, "[\u{200b}-\u{200d}\u{feff}]", "");
    let text = replace(&text, "[ \\t]+", " ");
    replace(&text, "\\n{3,}", "\n\n").trim().to_owned()
}
fn comparison(text: &str) -> String {
    let mut text = normalized_body(text);
    text = replace(&text, r"^来源[:：][^\n]{1,40}\n+", "");
    // Rust regex has no lookahead: remove the publisher only when immediately followed by date.
    if let Some(m) = re(r"^[\p{L}]{2,20}(?:新闻)?(\d{1,2}月\d{1,2}日(?:电|消息))").captures(&text)
    {
        let start = m.get(1).unwrap().start();
        text = text[start..].to_owned();
    }
    text = replace(&text, r"^\d{1,2}月\d{1,2}日电[,，]?\s*", "");
    text = replace(&text, r"(?:\n\s*)?【来源[:：][^】]{1,40}】\s*$", "");
    replace(
        &text,
        r"(?:\n\s*)?(?:美股频道更多[^\n]*|责任编辑[:：][^\n]{1,40})\s*$",
        "",
    )
    .trim()
    .to_owned()
}
pub fn body_hash(text: &str) -> String {
    sha(&comparison(text))
}
fn compact(text: &str) -> String {
    replace(&comparison(text), r"[^\p{L}\p{N}%]+", "").to_lowercase()
}
fn shingles(text: &str) -> HashSet<String> {
    let units: Vec<_> = compact(text).encode_utf16().collect();
    let width = units.len().min(5);
    (0..=units.len() - width)
        .map(|i| String::from_utf16_lossy(&units[i..i + width]))
        .collect()
}
pub fn sketch(text: &str) -> Value {
    let mut result = [u32::MAX; 8];
    for token in shingles(text) {
        let digest = Sha256::digest(token.as_bytes());
        for (i, out) in result.iter_mut().enumerate() {
            *out = (*out).min(u32::from_be_bytes(
                digest[i * 4..i * 4 + 4].try_into().unwrap(),
            ));
        }
    }
    json!(result)
}
pub fn sketches_overlap(a: &Value, b: &Value) -> bool {
    match (a.as_array(), b.as_array()) {
        (Some(a), Some(b)) if a.len() == 8 && b.len() == 8 => a.iter().zip(b).any(|(a, b)| a == b),
        _ => true,
    }
}
pub fn canonical_url(text: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(text) else {
        return String::new();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return String::new();
    }
    if !re(r"(?:^|[?&])id=").is_match(&format!("#{}", url.fragment().unwrap_or(""))) {
        url.set_fragment(None)
    }
    let mut pairs: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| !re(r"(?i)^(utm_.+|from|source|spm|ref|fbclid)$").is_match(key))
        .map(|(a, b)| (a.into_owned(), b.into_owned()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    url.set_query(None);
    if !pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(pairs);
    }
    url.to_string().trim_end_matches('/').to_owned()
}
fn protected(text: &str) -> String {
    let text = comparison(text);
    [r"(?i)(?:\d{4}[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?|\d+(?:\.\d+)?\s*(?:亿元|万元|万股|亿股|%|％|元|美元|港元|吨|GW|MW|GWh|年|月|日|季度))",r"(?:预计|预期|预测|计划|拟|已|实现|完成|未|不|否认|撤回|取消|下调|上调|获批|开工|投产|停产|终止)",r"(?i)\b(?:sh|sz|bj|hk|us)?\d{5,6}\b"].iter().map(|p|re(p).find_iter(&text).map(|m|m.as_str().to_owned()).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>().join("|")).collect::<Vec<_>>().join("\n")
}
fn paragraphs(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    for paragraph in re(r"\n\s*\n").split(&normalized_body(text)) {
        let mut start = 0;
        for (i, ch) in paragraph.char_indices() {
            let end = i + ch.len_utf8();
            if "。！？!?".contains(ch)
                && paragraph[end..]
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_whitespace())
            {
                let p = paragraph[start..end].trim();
                if !compact(p).is_empty() {
                    result.push(p.to_owned())
                }
                start = end;
            }
        }
        let p = paragraph[start..].trim();
        if !compact(p).is_empty() {
            result.push(p.to_owned())
        }
    }
    result
}
pub fn classify_candidate(incoming: &Value, candidate: &Value) -> Value {
    let body = normalized_body(s(&incoming["body"]));
    let previous = normalized_body(s(&candidate["body"]));
    let result =
        |kind: &str, score: f64, delta: &str| json!({"kind":kind,"similarity":score,"delta":delta});
    if body.is_empty() || previous.is_empty() {
        return result("new", 0., "");
    }
    let a = compact(&body);
    let b = compact(&previous);
    if body_hash(&body) == body_hash(&previous) || (!a.is_empty() && a == b) {
        return result("repeat", 1., "");
    }
    let same_identity = incoming["sourceKey"] == candidate["sourceKey"]
        && if !s(&incoming["sourceItemId"]).is_empty() && !s(&candidate["sourceItemId"]).is_empty()
        {
            incoming["sourceItemId"] == candidate["sourceItemId"]
        } else {
            let url = canonical_url(s(&incoming["url"]));
            !url.is_empty() && url == canonical_url(s(&candidate["url"]))
        };
    let codes = |v: &Value| v["entityCodes"].as_array().cloned().unwrap_or_default();
    let ic = codes(incoming);
    let cc = codes(candidate);
    if !ic.is_empty() && !cc.is_empty() && !ic.iter().any(|c| cc.contains(c)) {
        return result("new", 0., "");
    }
    let sa = shingles(&body);
    let sb = shingles(&previous);
    let score = if sa.is_empty() || sb.is_empty() {
        0.
    } else {
        sa.intersection(&sb).count() as f64 / sa.len().max(sb.len()) as f64
    };
    let short = utf16_len(&a).min(utf16_len(&b)) < 120;
    let same_protected = protected(&body) == protected(&previous);
    let old: HashSet<_> = paragraphs(&previous).iter().map(|p| compact(p)).collect();
    let parts = paragraphs(&body);
    let delta = parts
        .iter()
        .filter(|p| !old.contains(&compact(p)))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n");
    let ratio = utf16_len(&compact(&delta)) as f64 / utf16_len(&a).max(1) as f64;
    if same_identity && !delta.is_empty() && a.contains(&b) {
        return result("update", score, &delta);
    }
    if !short
        && same_protected
        && score >= 0.94
        && (ratio <= 0.08
            || (score >= 0.985
                && parts.len() == paragraphs(&previous).len()
                && (utf16_len(&a).abs_diff(utf16_len(&b)) as f64 / utf16_len(&a).max(1) as f64)
                    <= 0.02))
    {
        return result("repeat", score, "");
    }
    if !same_identity && !same_protected {
        return result("new", score, "");
    }
    if !delta.is_empty()
        && !short
        && score >= if same_identity { 0.72 } else { 0.88 }
        && ratio <= 0.35
    {
        return result("update", score, &delta);
    }
    if same_identity
        && !delta.is_empty()
        && short
        && (score >= 0.6
            || (!compact(s(&incoming["title"])).is_empty()
                && compact(s(&incoming["title"])) == compact(s(&candidate["title"]))
                && utf16_len(&a).min(utf16_len(&b)) >= 8))
    {
        return result("update", score, &delta);
    }
    result("new", score, "")
}
pub fn classify(source: &Value, candidates: &[Value]) -> Value {
    let mut best = json!({"kind":"new","similarity":0,"delta":"","candidate":null});
    for candidate in candidates {
        let mut result = classify_candidate(source, candidate);
        result["candidate"] = candidate.clone();
        if result["kind"] == "repeat" {
            return result;
        }
        if result["kind"] == "update"
            && (best["kind"] != "update"
                || result["similarity"].as_f64() > best["similarity"].as_f64())
        {
            best = result
        }
    }
    best
}
fn iso(value: &Value) -> String {
    let raw = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    if raw.is_empty() || value.is_null() {
        return String::new();
    }
    let date = if let Ok(n) = raw.parse::<f64>() {
        chrono::DateTime::from_timestamp_millis((if n < 1e11 { n * 1000. } else { n }) as i64)
    } else {
        chrono::DateTime::parse_from_rfc3339(&raw)
            .ok()
            .map(|d| d.to_utc())
            .or_else(|| {
                chrono::NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S")
                    .ok()
                    .map(|d| d.and_utc())
            })
            .or_else(|| {
                chrono::NaiveDate::parse_from_str(&raw, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .map(|d| d.and_utc())
            })
    };
    date.map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
fn python_text(value: &str) -> String {
    let Some(m) = re(r#"["']text["']\s*:\s*(["'])"#).captures(value) else {
        return String::new();
    };
    let quote = m[1].chars().next().unwrap();
    let mut chars = value[m.get(0).unwrap().end()..].chars();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c == quote {
            return out;
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(next) = chars.next() else { break };
        match next {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            'r' => out.push('\r'),
            'u' | 'U' => {
                let hex: String = chars
                    .by_ref()
                    .take(if next == 'u' { 4 } else { 8 })
                    .collect();
                if let Some(c) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    out.push(c)
                }
            }
            _ => out.push(next),
        }
    }
    String::new()
}
fn html_text(value: &str) -> String {
    let value = replace(value, r"(?i)<\s*br\s*/?>", "\n");
    let value = replace(&value, r"(?i)</\s*(?:p|div|li|h[1-6])\s*>", "\n\n");
    let value = replace(&value, r"<[^>]*>", "");
    let value = replace(&value, r"(?i)&(?:nbsp|#160);", " ");
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}
pub fn normalize_source(raw: &Value) -> Result<Value> {
    let reject = |reason: &str| Ok(json!({"accepted":false,"reason":reason}));
    if !raw.is_object() {
        return reject("invalid_source");
    }
    let access = first(&[&raw["accessMethod"], &raw["access_method"]]).to_lowercase();
    let mime = first(&[
        &raw["originalMime"],
        &raw["original_mime"],
        &raw["mimeType"],
        &raw["mime_type"],
    ])
    .to_lowercase();
    let format = first(&[
        &raw["originalFormat"],
        &raw["original_format"],
        &raw["metadata"]["originalFormat"],
    ])
    .to_lowercase();
    let url = canonical_url(s(&raw["url"]));
    if access.contains("pdf")
        || mime.contains("application/pdf")
        || re(r"(?i)\.pdf(?:$|\?)").is_match(s(&raw["url"]))
        || format == "pdf"
    {
        return reject("pdf_origin");
    }
    let explicit = first(&[
        &raw["sourceKey"],
        &raw["source_key"],
        &raw["metadata"]["source"],
    ]);
    let source_key = if !explicit.is_empty() {
        explicit
    } else if s(&raw["url"]).contains("cls.cn") {
        "cls_telegraph"
    } else if !raw["dedupe_title"].is_null()
        || !raw["stockInfo"].is_null()
        || s(&raw["url"]).contains("gu.qq.com")
    {
        "tencent_stock_news"
    } else {
        ""
    };
    if !matches!(source_key, "cls_telegraph" | "tencent_stock_news")
        && !matches!(format.as_str(), "text" | "html" | "markdown")
        && !re(r"^text/(?:plain|html|markdown)").is_match(&mime)
    {
        return reject("unknown_origin_format");
    }
    if source_key.is_empty() {
        return reject("missing_source");
    }
    let content = &raw["content"];
    let python = python_text(s(content));
    let html = if content.is_object() {
        s(&content["text"])
    } else if !python.is_empty() {
        &python
    } else if s(content).trim_start().starts_with('<') {
        s(content)
    } else {
        ""
    };
    let direct = first(&[
        &raw["markdown"],
        &raw["mdText"],
        &raw["md_text"],
        &raw["body"],
        &raw["text"],
    ]);
    let direct = if !direct.is_empty() {
        direct
    } else if re(r"^text/(?:plain|markdown)").is_match(&mime) {
        s(content)
    } else {
        ""
    };
    let html_body = html_text(html);
    let body = normalized_body(if direct.is_empty() {
        &html_body
    } else {
        direct
    });
    if body.is_empty() {
        return reject("missing_text_body");
    }
    if re(r"^\(?以下内容从.{0,100}研报附件原文摘录\)?").is_match(&body) {
        return reject("pdf_derived_excerpt");
    }
    let heading = first(&[&raw["title"], &raw["dedupe_title"]]);
    let title = if heading.is_empty() {
        prefix(&body, 80)
    } else {
        heading.to_owned()
    };
    let item = first(&[
        &raw["metadata"]["clsId"],
        &raw["metadata"]["newsId"],
        &raw["id"],
        &raw["sourceItemId"],
        &raw["source_item_id"],
    ]);
    if item.is_empty() && url.is_empty() {
        return reject("missing_identity");
    }
    let published = [
        "publishedAt",
        "published_at",
        "publish_time",
        "eventTime",
        "event_time",
    ]
    .iter()
    .map(|k| &raw[*k])
    .find(|v| !v.is_null() && v.as_str() != Some(""))
    .map(iso)
    .unwrap_or_default();
    let fetched = ["fetchedAt", "fetched_at"]
        .iter()
        .map(|k| &raw[*k])
        .find(|v| !v.is_null() && v.as_str() != Some(""))
        .map(iso)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let source_name = first(&[&raw["sourceName"], &raw["source_name"], &raw["source"]]);
    let source_name = if source_name.is_empty() {
        if source_key == "cls_telegraph" {
            "财联社"
        } else {
            "腾讯自选股"
        }
    } else {
        source_name
    };
    let mut codes: Vec<String> = raw["metadata"]["stockCodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| s(v).trim().to_uppercase())
        .filter(|v| !v.is_empty())
        .collect();
    let code_text = first(&[&raw["stock_codes"], &raw["stockInfo"]]);
    for m in re(r"(?i)(?:sh|sz|bj)\d{6}|hk\d{5}|\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK").find_iter(code_text)
    {
        codes.push(m.as_str().to_uppercase())
    }
    let mut seen = HashSet::new();
    codes.retain(|c| seen.insert(c.clone()));
    let raw_type = first(&[
        &raw["reportType"],
        &raw["report_type"],
        &raw["contentType"],
        &raw["content_type"],
    ])
    .to_lowercase();
    let content_type = if source_key == "cls_telegraph" {
        "flash"
    } else {
        match raw_type.as_str() {
            "flash" | "fast_news" | "telegraph" => "flash",
            "announcement" => "announcement",
            "text_report" => "text_report",
            _ => "news",
        }
    };
    Ok(
        json!({"accepted":true,"sourceKey":source_key,"sourceItemId":item,"sourceName":source_name,"url":url,"title":title,"body":body,"contentType":content_type,"publishedAt":published,"fetchedAt":fetched,"entityCodes":codes,"identityKey":sha(&format!("{source_key}|{}",if item.is_empty(){&url}else{item}))}),
    )
}
fn fold(text: &str) -> String {
    text.nfkc().collect::<String>().to_uppercase()
}
fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric()
}
fn bounded_contains(text: &str, term: &str, dot: bool) -> bool {
    text.match_indices(term).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + term.len()..].chars().next();
        !before.is_some_and(|c| ascii_word(c) || (dot && c == '.'))
            && !after.is_some_and(|c| ascii_word(c) || (dot && c == '.'))
    })
}
fn contains_alias(text: &str, alias: &str) -> bool {
    let term = fold(alias);
    if term.is_empty() {
        return false;
    }
    if re(r"^[A-Z0-9 .-]+$").is_match(&term) {
        bounded_contains(text, &term, false)
    } else {
        text.contains(&term)
    }
}
pub fn stock_entries(rows: &[Value]) -> Value {
    let mut entries: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in rows {
        let code = fold(s(&row["code"])).trim().to_owned();
        if code.is_empty() {
            continue;
        }
        let names = entries.entry(code.clone()).or_default();
        for value in [&row["short_name"], &row["alias"]] {
            let name = fold(s(value)).trim().to_owned();
            if name.is_empty() || name == code || re(r"^\d+$").is_match(&name) {
                continue;
            }
            let len = utf16_len(&name);
            if if re(r"^[A-Z0-9 .-]+$").is_match(&name) {
                len >= 3 || (len == 2 && name.chars().any(|c| c.is_ascii_digit()))
            } else {
                len >= 2
            } {
                names.insert(name);
            }
        }
    }
    json!(
        entries
            .into_iter()
            .map(|(code, names)| json!({"code":code,"names":names}))
            .collect::<Vec<_>>()
    )
}
pub fn evaluate_relevance(
    title: &str,
    body: &str,
    entries: &Value,
    policy: &Value,
) -> Result<Value> {
    let config = &policy["relevance"];
    let whitelist = &policy["whitelist"];
    if config["enabled"] != true {
        bail!("information feed whitelist must remain enabled")
    }
    let text = format!("{}\n{}", title, prefix(body, 600))
        .nfkc()
        .collect::<String>();
    let nt = fold(title);
    let stock_hash = sha(&serde_json::to_string(entries)?);
    let result = |decision: &str, reason: &str, evidence: Vec<String>, keywords: Vec<String>| {
        let mut v = json!({"decision":decision,"effectiveDisposition":decision,"reasonCodes":[reason],"evidence":evidence,"policyVersion":config["version"],"title":title,"bodySha256":sha(body),"stockWhitelistHash":stock_hash});
        if decision == "pass" {
            v["matchedKeywords"] = json!(keywords)
        }
        v
    };
    let no = |reason: &str| result("reject", reason, vec![], vec![]);
    let find = |pattern: &str, input: &str| -> Result<Option<String>> {
        Ok(Regex::new(&format!("(?i){pattern}"))?
            .find(input)
            .map(|m| m.as_str().to_owned()))
    };
    if title.is_empty() || body.is_empty() {
        return Ok(no("missing_input"));
    }
    if find(r"^(?:美股|港股|A股|欧股|亚太股市|周[一二三四五六日]你需要知道的隔夜全球要闻).*(?:收涨|收跌|高开|低开|上涨|下跌|要闻)",title)?.is_some()||(find(r"(?:期货|指数|股价|股票|现货).*(?:涨|跌|收盘|盘前|盘中)",title)?.is_some()&&find(r"(?:财报|业绩|订单|签署|收购|融资|IPO|关税|降息|加息|减产|增产|停产|投产|供应中断|运输中断|获批|召回|诉讼|罚款|产品发布|推出|升级)",&prefix(body,600))?.is_none()){return Ok(no("price_only"))}
    let quote = &config["quoteOnly"];
    if utf16_len(body) <= quote["maxBodyLength"].as_u64().unwrap_or(350) as usize
        && find(s(&quote["title"]), title)?.is_some()
        && find(s(&quote["body"]), body)?.is_some()
        && find(s(&quote["factCue"]), &text)?.is_none()
    {
        return Ok(no("quote_only"));
    }
    for entry in entries.as_array().into_iter().flatten() {
        let code = s(&entry["code"]);
        let mut matched = entry["names"]
            .as_array()
            .into_iter()
            .flatten()
            .map(s)
            .find(|name| contains_alias(&nt, name))
            .map(str::to_owned);
        if matched.is_none()
            && let Some(c) = re(r"^([A-Z0-9.]+)\.(SH|SZ|BJ|HK|US|KS|KQ|T)$").captures(code)
        {
            if contains_alias(&nt, code) || contains_alias(&nt, &format!("{}{}", &c[2], &c[1])) {
                matched = Some(code.to_owned())
            } else if re(r"^[A-Z]{3,}$").is_match(&c[1]) && bounded_contains(title, &c[1], false) {
                matched = Some(c[1].to_owned())
            }
        }
        if let Some(name) = matched
            && let Some(event) = find(s(&whitelist["companyEvent"]), &text)?
        {
            return Ok(result(
                "pass",
                "stock",
                vec![code.to_owned(), name.clone()],
                vec![name, event],
            ));
        }
    }
    for industry in whitelist["industries"].as_array().into_iter().flatten() {
        if let Some(alias) = industry
            .as_array()
            .into_iter()
            .flatten()
            .map(s)
            .find(|alias| contains_alias(&nt, alias))
            && let Some(event) = find(s(&whitelist["industryEvent"]), &text)?
        {
            return Ok(result(
                "pass",
                "industry",
                vec![s(&industry[0]).to_owned()],
                vec![alias.to_owned(), event],
            ));
        }
    }
    for rule in whitelist["macro"].as_array().into_iter().flatten() {
        if let Some(subject) = find(s(&rule["subject"]), title)?
            && let Some(event) = find(s(&rule["event"]), &text)?
        {
            return Ok(result(
                "pass",
                &format!("macro_{}", s(&rule["name"])),
                vec![],
                vec![subject, event],
            ));
        }
    }
    Ok(no("whitelist_miss"))
}
pub fn company_candidates(aliases: &[Value], title: &str, body: &str, config: &Value) -> Value {
    let content = format!("{title}\n{body}").to_lowercase();
    let limit = config["limit"].as_u64().unwrap_or(60) as usize;
    let excluded: HashSet<_> = config["excludedMappings"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| format!("{}|{}", s(&v["code"]), s(&v["name"])).to_lowercase())
        .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut add = |item: &Value, matched: &str, fallback: &str| {
        let code = s(&item["code"]).trim();
        if !code.is_empty()
            && !seen.contains(code)
            && !excluded.contains(&format!("{code}|{}", s(&item["name"])).to_lowercase())
        {
            seen.insert(code.to_owned());
            out.push(json!({"tagId":format!("company:{code}"),"name":if s(&item["name"]).is_empty(){fallback}else{s(&item["name"])},"matchedAlias":matched}));
        }
        out.len() >= limit
    };
    let by_code: BTreeMap<_, _> = aliases
        .iter()
        .map(|v| (s(&v["code"]).to_lowercase(), v))
        .collect();
    for mention in re(r"[a-z0-9]+(?:\.[a-z0-9]+)*\.(?:sh|sz|bj|hk|us|ks|kq|t)").find_iter(&content)
    {
        if !bounded_contains(&content, mention.as_str(), true) {
            continue;
        }
        if let Some(item) = by_code.get(mention.as_str())
            && add(item, mention.as_str(), s(&item["code"]))
        {
            return json!(out);
        }
    }
    let mut sorted = aliases.to_vec();
    sorted.sort_by(|a, b| {
        utf16_len(s(&b["alias"]))
            .cmp(&utf16_len(s(&a["alias"])))
            .then_with(|| s(&a["alias"]).cmp(s(&b["alias"])))
    });
    for item in sorted {
        let alias = s(&item["alias"]).trim();
        let code = s(&item["code"]).trim();
        let lower = alias.to_lowercase();
        let identity = code.to_lowercase();
        let derived = lower == identity
            || identity.find('.').is_some_and(|i| lower == identity[..i])
            || identity.rfind('.').is_some_and(|i| lower == identity[..i]);
        if utf16_len(alias) < 2 || derived || !content.contains(&lower) {
            continue;
        }
        if add(&item, alias, alias) {
            break;
        }
    }
    json!(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_and_normalization() {
        assert_eq!(
            canonical_url("https://GU.qq.com/a?utm_x=a&z=2&a=1#page?id=8"),
            "https://gu.qq.com/a?a=1&z=2#page?id=8"
        );
        assert_eq!(normalized_body("Ａ\r\n  x\u{200b}\n\n\n"), "A\n x");
        assert_eq!(body_hash("来源：财联社\n正文"), body_hash("正文"));
    }
    #[test]
    fn pdf_never_promotes() {
        assert_eq!(
            normalize_source(
                &json!({"sourceKey":"cls_telegraph","url":"https://a/b.pdf","body":"hi"})
            )
            .unwrap()["reason"],
            "pdf_origin"
        );
    }
    #[test]
    fn identity_updates_and_conflicts() {
        let a = json!({"body":"公司完成投资并正式投产。新增订单已完成签署。","sourceKey":"x","sourceItemId":"1","title":"公司投产"});
        let b = json!({"body":"公司完成投资并正式投产。","sourceKey":"x","sourceItemId":"1","title":"公司投产"});
        assert_eq!(classify_candidate(&a, &b)["kind"], "update");
        assert_eq!(
            classify_candidate(&json!({"body":"收入12亿元"}), &json!({"body":"收入13亿元"}))["kind"],
            "new"
        );
    }
    #[test]
    fn whitelist_policy_and_boundaries() {
        let policy: Value = serde_json::from_str(include_str!(
            "../../../config/knowledge/information-feed-policy.json"
        ))
        .unwrap();
        let entries = stock_entries(&[json!({"code":"ABC.US","short_name":"ABC"})]);
        assert_eq!(
            evaluate_relevance("ABC公布财报", "利润增长", &entries, &policy).unwrap()["decision"],
            "pass"
        );
        assert_eq!(
            evaluate_relevance("XABC公布财报", "利润增长", &entries, &policy).unwrap()["decision"],
            "reject"
        );
        assert_eq!(
            evaluate_relevance("半导体订单增长", "公司扩产", &entries, &policy).unwrap()["decision"],
            "pass"
        );
    }
}
