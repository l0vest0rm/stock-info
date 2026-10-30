use anyhow::{Result, bail};
use chrono::{DateTime, NaiveDate};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

macro_rules! regex {
    ($pattern:literal) => {{
        static REGEX: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new($pattern).expect("static report regex"));
        &*REGEX
    }};
}

pub fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.trim().to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values
            .iter()
            .map(text)
            .collect::<Vec<_>>()
            .join(",")
            .trim()
            .to_string(),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub fn number(value: &Value) -> Option<f64> {
    if value.is_null() || value.as_str() == Some("") {
        return None;
    }
    value
        .as_f64()
        .or_else(|| {
            let value = value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| text(value))
                .replace(',', "");
            parse_number_string(value.strip_suffix('%').unwrap_or(&value))
        })
        .filter(|number| number.is_finite())
}

fn parse_number_string(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            if digits.is_empty() {
                return None;
            }
            let mut number = 0.0;
            for ch in digits.chars() {
                number = number * (radix as f64) + (ch.to_digit(radix)? as f64);
            }
            return number.is_finite().then_some(number);
        }
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::String(value) => parse_number_string(value),
        _ => parse_number_string(&text(value)),
    }
}
fn positive(value: &Value) -> Option<f64> {
    number(value).filter(|number| *number > 0.0)
}
fn round2(value: f64) -> f64 {
    (value * 100.0 + 0.5).floor() / 100.0
}
fn first(item: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| text(&item[*key]))
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}
fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

pub fn normalize_date(value: &str) -> String {
    let raw = value.trim();
    if let Some(captures) = regex!(r"^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})").captures(raw) {
        let year = captures[1].parse::<i32>().unwrap_or_default();
        let month = captures[2].parse::<u32>().unwrap_or_default();
        let day = captures[3].parse::<u32>().unwrap_or_default();
        // Date.parse accepts day overflow within 01..31 for an otherwise ISO
        // calendar date; keep the normalized text chosen by the existing code.
        if (1..=31).contains(&day) && NaiveDate::from_ymd_opt(year, month, 1).is_some() {
            return format!("{year:04}-{month:02}-{day:02}");
        }
        return String::new();
    }
    if let Ok(date) = DateTime::parse_from_rfc3339(raw) {
        return date.with_timezone(&chrono::Utc).date_naive().to_string();
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(raw) {
        return date.with_timezone(&chrono::Utc).date_naive().to_string();
    }
    for format in ["%Y-%m-%d", "%Y/%m/%d", "%b %d, %Y", "%B %d, %Y"] {
        if let Ok(date) = NaiveDate::parse_from_str(raw, format) {
            return date.to_string();
        }
    }
    String::new()
}

pub fn canonical_url(value: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(value.trim()) else {
        return String::new();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return String::new();
    }
    url.set_fragment(None);
    let excluded = regex!(r"(?i)^(?:utm_|spm|from|source|ref|referrer|share|clickid|sessionid)");
    let mut pairs = url
        .query_pairs()
        .filter(|(key, _)| !excluded.is_match(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    url.set_query(None);
    if !pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(pairs);
    }
    url.to_string().trim_end_matches('/').to_string()
}

pub fn normalize_provenance(item: &Value) -> Value {
    let mut result = object(item);
    result.insert(
        "provenance".into(),
        json!(if text(&item["provenance"]) == "web_search" {
            "web_search"
        } else {
            "existing"
        }),
    );
    Value::Object(result)
}

fn dedup_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter_map(|character| match character {
            ' ' | '\t' | '\n' | '\r' | '　' | ':' | '：' | '"' | '\'' => None,
            '（' => Some('('),
            '）' => Some(')'),
            '－' | '—' | '–' => Some('-'),
            other => Some(other),
        })
        .collect()
}

pub fn normalize_title(value: &str) -> String {
    let trimmed = value.trim();
    let colon = trimmed
        .find('：')
        .into_iter()
        .chain(trimmed.find(':'))
        .max();
    let prefix = colon.map(|index| &trimmed[..index]).unwrap_or("");
    let has_prefix =
        regex!(r"^[\u{4e00}-\u{9fa5}A-Za-z0-9]+(?:\(\d{6}(?:\.[A-Z]{2})?\))\s*$").is_match(prefix);
    let mut core = if has_prefix {
        let index = colon.unwrap();
        trimmed[index + trimmed[index..].chars().next().unwrap().len_utf8()..].to_string()
    } else {
        trimmed.to_string()
    };
    if !has_prefix {
        core = regex!(r"^[\u{4e00}-\u{9fa5}A-Za-z0-9]+(?:\(\d{6}(?:\.[A-Z]{2})?\))\s*[：:]?")
            .replace(&core, "")
            .into_owned();
    }
    dedup_text(&regex!(r"[，,、。！？!?\-]").replace_all(&core, ""))
}

fn normalize_org(value: &str) -> String {
    let without_hk = regex!(r"[（(]香港[）)]").replace_all(value, "");
    dedup_text(&regex!(r"(股份)?有限责任公司|股份有限公司|有限公司").replace_all(&without_hk, ""))
}

pub fn dedup_keys(item: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    let url = canonical_url(&first(item, &["url", "detailUrl"]));
    if !url.is_empty() {
        keys.push(format!("url:{url}"));
    }
    let info = text(&item["infoCode"]);
    let document = first(item, &["knowledgeDocId", "doc_id"]);
    if !info.is_empty() {
        keys.push(format!("native:eastmoney:{}", info.to_lowercase()));
    } else if !document.is_empty() {
        keys.push(format!("native:knowledge:{document}"));
    }
    let code = crate::codes::normalize(&text(&item["code"]));
    let title = normalize_title(&text(&item["title"]));
    let org = normalize_org(&first(item, &["orgSName", "orgName", "org", "institution"]));
    if code.is_empty() || title.is_empty() || org.is_empty() {
        return keys;
    }
    let date = normalize_date(&first(item, &["publishDate", "publishedAt"]));
    keys.push(if date.is_empty() {
        format!("identity-no-date:{code}|title:{title}|org:{org}")
    } else {
        format!("identity:{code}|date:{date}|title:{title}|org:{org}")
    });
    keys
}

pub fn report_id(item: &Value) -> String {
    let info = text(&item["infoCode"]);
    if !info.is_empty() {
        return format!("eastmoney:{info}");
    }
    let url = text(&item["url"]);
    if !url.is_empty() {
        return format!("sina:{url}");
    }
    let title = text(&item["title"]);
    if title.is_empty() {
        return String::new();
    }
    let date = text(&item["publishDate"])
        .chars()
        .take(10)
        .collect::<String>();
    format!(
        "{}|{date}|{title}",
        crate::codes::normalize(&text(&item["code"]))
    )
}

pub fn sort_time(item: &Value) -> i64 {
    let date = text(&item["publishDate"])
        .chars()
        .take(10)
        .collect::<String>();
    NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .ok()
        .map(|date| {
            date.and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis()
        })
        .unwrap_or(0)
}

pub fn merge_forecasts(preferred: &[Value], fallback: &[Value]) -> Vec<Value> {
    let mut merged = BTreeMap::<i64, Map<String, Value>>::new();
    for row in fallback.iter().chain(preferred) {
        let Some(year) = js_number(&row["year"])
            .filter(|year| year.fract() == 0.0)
            .map(|year| year as i64)
        else {
            continue;
        };
        merged.entry(year).or_default().extend(object(row));
    }
    merged.into_values().map(Value::Object).collect()
}

fn merge_primary(primary: &Value, supplement: &Value) -> Value {
    let mut result = object(supplement);
    result.extend(object(primary));
    let supplement_url = text(&supplement["url"]);
    if !supplement_url.is_empty() {
        result.insert("detailUrl".into(), json!(supplement_url));
    }
    let forecasts = merge_forecasts(
        primary["forecasts"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        supplement["forecasts"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    if !forecasts.is_empty() {
        result.insert("forecasts".into(), json!(forecasts));
    }
    let mut valuation = object(&supplement["valuation"]);
    valuation.extend(object(&primary["valuation"]));
    if !valuation.is_empty() {
        result.insert("valuation".into(), Value::Object(valuation));
    }
    let preferred = text(&primary["provenance"]);
    let fallback = text(&supplement["provenance"]);
    result.insert(
        "provenance".into(),
        json!(if preferred == "web_search" && fallback != "web_search" {
            "existing".into()
        } else if !preferred.is_empty() {
            preferred
        } else if !fallback.is_empty() {
            fallback
        } else {
            "existing".into()
        }),
    );
    Value::Object(result)
}

pub fn merge_reports(primary: &[Value], supplements: &[Value]) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    let mut merged_keys: Vec<Vec<String>> = Vec::new();
    // Match the earliest current row, not the first incoming key. A merge can
    // change a row's identity keys; update this index rather than remembering
    // historical aliases (which would change the original dedup semantics).
    let mut index_by_key = HashMap::<String, BTreeSet<usize>>::new();
    let mut seen = HashSet::new();
    for item in primary.iter().chain(supplements) {
        let item = normalize_provenance(item);
        let keys = dedup_keys(&item);
        if keys.is_empty() {
            if item["provenance"] == "web_search" {
                merged.push(item);
                merged_keys.push(keys);
            }
            continue;
        }
        let matching_index = keys
            .iter()
            .filter_map(|key| {
                index_by_key
                    .get(key)
                    .and_then(|indices| indices.first())
                    .copied()
            })
            .min();
        if let Some(index) = matching_index {
            merged[index] = merge_primary(&merged[index], &item);
            for key in &merged_keys[index] {
                if let Some(indices) = index_by_key.get_mut(key) {
                    indices.remove(&index);
                    if indices.is_empty() {
                        index_by_key.remove(key);
                    }
                }
            }
            merged_keys[index] = dedup_keys(&merged[index]);
            for key in &merged_keys[index] {
                index_by_key.entry(key.clone()).or_default().insert(index);
            }
            continue;
        }
        // Keep the original seen set separate: only newly inserted rows add
        // keys, and stale initial keys still suppress a later unmatched row.
        if keys.iter().any(|key| seen.contains(key)) {
            continue;
        }
        seen.extend(keys.iter().cloned());
        let index = merged.len();
        for key in &keys {
            index_by_key.entry(key.clone()).or_default().insert(index);
        }
        merged_keys.push(keys);
        merged.push(item);
    }
    merged.sort_by_key(|item| std::cmp::Reverse(sort_time(item)));
    merged
}

fn raw_urls(value: &Value) -> Vec<String> {
    ["url", "detailUrl", "sourceUrl", "reportUrl"]
        .iter()
        .map(|key| canonical_url(&text(&value[*key])))
        .filter(|url| !url.is_empty())
        .collect()
}
fn raw_ids(value: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    let values = ["infoCode", "reportId", "rptid", "rptId", "id"]
        .iter()
        .map(|key| text(&value[*key]))
        .chain(raw_urls(value));
    for raw in values {
        if let Some(info) = regex!(r"(?i)AP\d{12,}").find(&raw) {
            ids.insert(info.as_str().to_uppercase());
        }
        if let Some(captures) =
            regex!(r"(?i)(?:rptid|reportid)[/_-]?([A-Za-z0-9_-]+)").captures(&raw)
        {
            ids.insert(captures[1].to_lowercase());
        }
        if regex!(r"^\d{8,}$").is_match(&raw) {
            ids.insert(raw);
        }
    }
    ids
}
pub fn raw_report(output: &Value, item: &Value) -> Option<Value> {
    let reports = serde_json::from_str::<Value>(&text(&output["response"]["text"])).ok()?;
    let urls = raw_urls(item);
    let ids = raw_ids(item);
    reports
        .as_array()?
        .iter()
        .find(|candidate| {
            candidate.is_object()
                && (raw_urls(candidate).iter().any(|url| urls.contains(url))
                    || raw_ids(candidate).iter().any(|id| ids.contains(id)))
        })
        .cloned()
}

pub fn parse_forecasts(rows: &[Value]) -> Vec<Value> {
    let mut forecasts = Vec::new();
    for row in rows.iter().filter(|row| row.is_object()) {
        let Some(year) = js_number(&row["year"]).filter(|year| year.fract() == 0.0 && *year > 0.0)
        else {
            continue;
        };
        let mut result = Map::new();
        result.insert("year".into(), json!(year as i64));
        for field in [
            "revenue",
            "revenueGrowth",
            "netProfit",
            "profitGrowth",
            "eps",
            "pe",
        ] {
            if let Some(value) = number(&row[field]) {
                result.insert(field.into(), json!(value));
            }
        }
        if ["revenue", "netProfit", "eps", "pe"]
            .iter()
            .all(|field| !result.contains_key(*field))
        {
            continue;
        }
        forecasts.push(Value::Object(result));
    }
    forecasts.sort_by_key(|row| row["year"].as_i64().unwrap_or_default());
    forecasts
}

pub fn parse_analysis(text: &str) -> Result<Value> {
    let parsed = text
        .find('{')
        .zip(text.rfind('}'))
        .filter(|(start, end)| end > start)
        .and_then(|(start, end)| serde_json::from_str::<Value>(&text[start..=end]).ok());
    let Some(rows) = parsed
        .as_ref()
        .and_then(|value| value["forecasts"].as_array())
    else {
        bail!("LLM forecast response did not contain a forecasts array");
    };
    Ok(
        json!({"forecasts":parse_forecasts(rows),"targetPrice":positive(&parsed.unwrap()["targetPrice"])}),
    )
}

pub fn analysis_has_values(value: &Value) -> bool {
    value["forecasts"]
        .as_array()
        .is_some_and(|rows| !rows.is_empty() || positive(&value["targetPrice"]).is_some())
}
pub fn analysis_success(value: &Value) -> bool {
    value["forecasts"].is_array() && value["analysisSucceeded"] == true
}

pub fn format_for_llm(content: &str) -> String {
    let mut formatted = content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\u{00a0}', '\u{200b}', '\u{feff}'], " ");
    let cjk = regex!(r"([\u{3400}-\u{9fff}])[\t ]+([\u{3400}-\u{9fff}])");
    for _ in 0..4 {
        let next = cjk.replace_all(&formatted, "$1$2").into_owned();
        if next == formatted {
            break;
        }
        formatted = next;
    }
    regex!(r"(?-u:\b)(20\d?)\s(\d)")
        .replace_all(&formatted, "$1$2")
        .into_owned()
}

pub fn likely_news(title: &str, content: &str) -> bool {
    let haystack = format!("{title}\n{content}").to_lowercase();
    let keywords: Vec<String> = serde_json::from_str(include_str!(
        "../../../../config/research/company-news-report-keywords.json"
    ))
    .expect("company-news-report-keywords config");
    keywords.iter().any(|keyword| {
        let keyword = keyword.trim().to_lowercase();
        if keyword.is_empty() || !haystack.contains(&keyword) {
            return false;
        }
        let mut stripped = haystack.clone();
        for prefix in [
            "没有",
            "无",
            "未提及",
            "不含",
            "并无",
            "未给出",
            "未披露",
            "未提供",
            "并未给出",
        ] {
            stripped = stripped.replace(&format!("{prefix}{keyword}"), "");
        }
        stripped.contains(&keyword)
    })
}

pub fn current_pe(forecast: &Value, overview: &Value) -> Option<f64> {
    if let (Some(profit), Some(cap)) = (
        positive(&forecast["netProfit"]),
        positive(&overview["marketCapYi"]),
    ) {
        return Some(round2(cap / profit));
    }
    positive(&forecast["eps"])
        .zip(positive(&overview["latestPrice"]))
        .map(|(eps, price)| round2(price / eps))
}
pub fn current_net_profit(forecast: &Value, overview: &Value) -> Option<f64> {
    Some(round2(
        positive(&overview["marketCapYi"])? / positive(&overview["latestPrice"])?
            * positive(&forecast["eps"])?,
    ))
}

pub fn apply_current_pe(
    items: &[Value],
    overview: Option<&Value>,
    actual_annual: &BTreeMap<i64, f64>,
) -> Vec<Value> {
    let Some(overview) = overview else {
        return items.to_vec();
    };
    let computed: Map<String, Value> = actual_annual
        .iter()
        .filter_map(|(year, profit)| {
            current_pe(&json!({"year":year,"netProfit":profit}), overview)
                .map(|pe| (year.to_string(), json!(pe)))
        })
        .collect();
    items
        .iter()
        .map(|item| {
            let mut result = object(item);
            if let Some(forecasts) = item["forecasts"].as_array() {
                result.insert(
                    "forecasts".into(),
                    json!(
                        forecasts
                            .iter()
                            .map(|forecast| {
                                let mut row = object(forecast);
                                if let Some(pe) = current_pe(forecast, overview) {
                                    row.insert("computedPe".into(), json!(pe));
                                    row.insert(
                                        "computedPeAsOf".into(),
                                        overview["updatedAt"].clone(),
                                    );
                                }
                                if forecast.get("netProfit").is_none()
                                    && let Some(profit) = current_net_profit(forecast, overview)
                                {
                                    row.insert("computedNetProfit".into(), json!(profit));
                                    row.insert(
                                        "computedNetProfitAsOf".into(),
                                        overview["updatedAt"].clone(),
                                    );
                                }
                                Value::Object(row)
                            })
                            .collect::<Vec<_>>()
                    ),
                );
            }
            if !computed.is_empty() {
                result.insert("computedPeByYear".into(), Value::Object(computed.clone()));
                result.insert("computedPeAsOf".into(), overview["updatedAt"].clone());
            }
            Value::Object(result)
        })
        .collect()
}

pub fn aggregate(code: &str, items: &[Value]) -> Value {
    let normalized = crate::codes::normalize(code);
    let mut grouped = BTreeMap::<i64, BTreeMap<&str, Vec<f64>>>::new();
    for item in items
        .iter()
        .filter(|item| crate::codes::normalize(&text(&item["code"])) == normalized)
    {
        for forecast in item["forecasts"].as_array().into_iter().flatten() {
            let Some(year) = js_number(&forecast["year"]).filter(|year| year.fract() == 0.0) else {
                continue;
            };
            let values = grouped.entry(year as i64).or_default();
            for field in ["revenue", "revenueGrowth", "netProfit", "profitGrowth"] {
                if let Some(value) = number(&forecast[field])
                    .filter(|value| !matches!(field, "revenue" | "netProfit") || *value > 0.0)
                {
                    values.entry(field).or_default().push(value);
                }
            }
        }
    }
    json!(
        grouped
            .into_iter()
            .filter_map(|(year, fields)| {
                let mut row = Map::new();
                row.insert("year".into(), json!(year));
                for (field, values) in fields {
                    if !values.is_empty() {
                        row.insert(
                            field.into(),
                            json!(round2(values.iter().sum::<f64>() / values.len() as f64)),
                        );
                    }
                }
                (row.len() > 1).then_some(Value::Object(row))
            })
            .collect::<Vec<_>>()
    )
}

fn discovery_url(value: &Value) -> String {
    let raw = text(value);
    let markdown = regex!(r"(?i)^\[[^\]]*\]\((https?://[^\s)]+)\)$");
    canonical_url(
        markdown
            .captures(&raw)
            .map(|captures| captures.get(1).unwrap().as_str())
            .unwrap_or(&raw),
    )
}
fn discovery_title(url: &str) -> String {
    let title = reqwest::Url::parse(url)
        .ok()
        .map(|url| {
            let path = url.path().trim_matches('/');
            format!(
                "{}{}{}",
                url.host_str().unwrap_or(""),
                if path.is_empty() { "" } else { "/" },
                path
            )
        })
        .unwrap_or_else(|| url.to_string());
    title
        .chars()
        .filter(|ch| !ch.is_control())
        .take(240)
        .collect::<String>()
        .trim()
        .to_string()
}
fn parse_valuation(value: &Value) -> Value {
    let mut valuation = Map::new();
    for key in ["rating", "targetPriceCurrency", "valuationMethod"] {
        let value = text(&value[key]);
        if !value.is_empty() {
            valuation.insert(key.into(), json!(value));
        }
    }
    for key in ["targetPrice", "targetPe"] {
        if let Some(value) = positive(&value[key]) {
            valuation.insert(key.into(), json!(value));
        }
    }
    Value::Object(valuation)
}

pub fn parse_discovery(
    text_body: &str,
    code: &str,
    citations: &[Value],
) -> Result<(Vec<Value>, usize)> {
    let parsed: Value = serde_json::from_str(text_body.trim())
        .map_err(|_| anyhow::anyhow!("company report discovery response was not a JSON array"))?;
    let Some(reports) = parsed.as_array() else {
        bail!("company report discovery response was not a JSON array");
    };
    let cited: HashSet<String> = citations
        .iter()
        .map(|citation| canonical_url(&text(&citation["url"])))
        .filter(|url| !url.is_empty())
        .collect();
    let mut rejected = 0;
    let mut accepted = Vec::new();
    for row in reports {
        if !row.is_object() {
            rejected += 1;
            continue;
        }
        let url = discovery_url(&row["url"]);
        let mut title = text(&row["title"]);
        if title.is_empty() && !url.is_empty() {
            title = discovery_title(&url);
        }
        if title.is_empty() || (!cited.is_empty() && !url.is_empty() && !cited.contains(&url)) {
            rejected += 1;
            continue;
        }
        let institution = text(&row["institution"]);
        let published = normalize_date(&text(&row["publishedAt"]));
        let forecasts = parse_forecasts(
            row["forecasts"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        let valuation = parse_valuation(&row["valuation"]);
        let mut item = json!({"code":crate::codes::normalize(code),"title":title,"pages":0,"forecasts":forecasts,"provenance":"web_search"});
        if let Some(target) =
            positive(&row["targetPrice"]).or_else(|| positive(&valuation["targetPrice"]))
        {
            item["targetPrice"] = json!(target);
        }
        if !institution.is_empty() {
            item["orgName"] = json!(institution);
            item["orgSName"] = item["orgName"].clone();
        }
        if !published.is_empty() {
            item["publishDate"] = json!(published);
        }
        if !url.is_empty() {
            item["url"] = json!(url);
        }
        if valuation.as_object().is_some_and(|value| !value.is_empty()) {
            item["valuation"] = valuation;
        }
        accepted.push(item);
    }
    Ok((accepted, rejected))
}

pub fn normalize_forward(item: &Value) -> Value {
    let strict_number = |value: &Value| {
        value
            .as_f64()
            .or_else(|| {
                parse_number_string(value.as_str().filter(|value| !value.trim().is_empty())?)
            })
            .filter(|number| number.is_finite())
    };
    let publication = text(&item["publishDate"]);
    let year = regex!(r"^(\d{4})[-/]")
        .captures(&publication)
        .and_then(|captures| captures[1].parse::<i64>().ok())
        .unwrap_or_default();
    let mut forecasts = BTreeMap::<i64, Map<String, Value>>::new();
    if (2000..=2100).contains(&year) {
        for (offset, suffix) in ["ThisYear", "NextYear", "NextTwoYear"].iter().enumerate() {
            let eps = strict_number(&item[format!("predict{suffix}Eps")]);
            let pe = strict_number(&item[format!("predict{suffix}Pe")]);
            let profit = strict_number(&item[format!("predict{suffix}Profit")]);
            if eps.is_some() || pe.is_some() || profit.is_some() {
                let year = year + offset as i64;
                let mut row = Map::new();
                row.insert("year".into(), json!(year));
                if let Some(eps) = eps {
                    row.insert("eps".into(), json!(eps));
                }
                if let Some(pe) = pe.filter(|pe| *pe > 0.0) {
                    row.insert("pe".into(), json!(pe));
                }
                if let Some(profit) = profit {
                    row.insert("netProfit".into(), json!(profit));
                }
                forecasts.insert(year, row);
            }
        }
    }
    for row in item["forecasts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row.is_object())
    {
        let Some(year) = strict_number(&row["year"])
            .filter(|year| *year != 0.0 && year.fract() == 0.0)
            .map(|year| year as i64)
        else {
            continue;
        };
        let entry = forecasts.entry(year).or_insert_with(|| {
            let mut entry = Map::new();
            entry.insert("year".into(), json!(year));
            entry
        });
        for field in [
            "eps",
            "pe",
            "netProfit",
            "revenue",
            "profitGrowth",
            "revenueGrowth",
        ] {
            if let Some(number) = strict_number(&row[field]) {
                entry.insert(field.into(), json!(number));
            }
        }
    }
    let mut result = object(item);
    result.insert(
        "forecasts".into(),
        json!(
            forecasts
                .into_values()
                .map(Value::Object)
                .collect::<Vec<_>>()
        ),
    );
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Frozen straightforward implementation used to verify the indexed join's
    // first-match, key mutation, stale seen-set and stable ordering semantics.
    fn reference_merge(primary: &[Value], supplements: &[Value]) -> Vec<Value> {
        let mut merged = Vec::new();
        let mut seen = HashSet::new();
        for item in primary.iter().chain(supplements) {
            let item = normalize_provenance(item);
            let keys = dedup_keys(&item);
            if keys.is_empty() {
                if item["provenance"] == "web_search" {
                    merged.push(item);
                }
                continue;
            }
            if let Some(index) = merged
                .iter()
                .position(|prior| dedup_keys(prior).iter().any(|key| keys.contains(key)))
            {
                merged[index] = merge_primary(&merged[index], &item);
                continue;
            }
            if keys.iter().any(|key| seen.contains(key)) {
                continue;
            }
            seen.extend(keys);
            merged.push(item);
        }
        merged.sort_by_key(|item| std::cmp::Reverse(sort_time(item)));
        merged
    }

    #[test]
    fn indexed_merge_preserves_first_match_mutating_keys_and_stale_seen_keys() {
        let primary = vec![
            json!({"detailUrl":"https://example.com/old","infoCode":"first","publishDate":"2026-10-29","marker":"first"}),
            json!({"url":"https://example.com/second","infoCode":"second","publishDate":"2026-10-29","marker":"second"}),
            json!({"provenance":"web_search","marker":"keyless"}),
        ];
        let supplements = vec![
            json!({"url":"https://example.com/new","infoCode":"first","extra":"acquired"}),
            // The old URL is no longer a current key, but remains seen.
            json!({"url":"https://example.com/old","marker":"must-not-insert"}),
            // URL points at the second row, native id at the first: earliest wins.
            json!({"url":"https://example.com/second","infoCode":"first","bridge":true}),
            json!({"url":"https://example.com/new","extra2":true}),
        ];
        let expected = reference_merge(&primary, &supplements);
        let actual = merge_reports(&primary, &supplements);
        assert_eq!(actual, expected);
        assert_eq!(actual.len(), 3);
        assert_eq!(actual[0]["marker"], "first");
        assert_eq!(actual[0]["bridge"], true);
        assert_eq!(actual[0]["extra2"], true);
    }

    #[test]
    fn indexed_merge_handles_a_thousand_reports_with_bounded_work_and_deterministic_output() {
        let primary = (0..1000).map(|i| json!({"code":"600036.SH","title":format!("业绩研究第{i}期"),"orgName":"研究证券股份有限公司","publishDate":"2026-10-29","infoCode":format!("AP{i:012}"),"url":format!("https://example.com/{i}"),"forecasts":[{"year":2027,"eps":i}]})).collect::<Vec<_>>();
        let supplements = (0..1000).rev().map(|i| json!({"infoCode":format!("AP{i:012}"),"detailUrl":format!("https://supplement.example/{i}"),"forecasts":[{"year":2027,"eps":-1,"netProfit":i+1}]})).collect::<Vec<_>>();
        let started = std::time::Instant::now();
        let actual = merge_reports(&primary, &supplements);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "1000-report indexed merge exceeded a generous five-second local processing budget"
        );
        assert_eq!(actual.len(), 1000);
        for (i, item) in actual.iter().enumerate() {
            assert_eq!(item["infoCode"], format!("AP{i:012}"));
            assert_eq!(item["forecasts"][0]["eps"], i);
            assert_eq!(item["forecasts"][0]["netProfit"], i + 1);
        }
        assert_eq!(actual, merge_reports(&primary, &supplements));
        assert_eq!(
            merge_reports(&primary[..100], &supplements[900..]),
            reference_merge(&primary[..100], &supplements[900..])
        );
    }

    #[test]
    fn parses_forecasts_without_fabricating_missing_values() {
        let analysis=parse_analysis("```json\n{\"forecasts\":[{\"year\":2027,\"revenue\":\"1,200\",\"profitGrowth\":\"-5%\"},{\"year\":2026,\"eps\":0},{\"year\":2029,\"profitGrowth\":10}],\"targetPrice\":-1}\n```").unwrap();
        assert_eq!(analysis["targetPrice"], Value::Null);
        assert_eq!(analysis["forecasts"].as_array().unwrap().len(), 2);
        assert_eq!(analysis["forecasts"][0], json!({"year":2026,"eps":0.0}));
        assert_eq!(analysis["forecasts"][1]["profitGrowth"], -5.0);
        assert!(parse_analysis("[]").is_err());
        assert!(!analysis_has_values(
            &json!({"forecasts":[],"targetPrice":0})
        ));
        assert!(analysis_success(
            &json!({"forecasts":[],"analysisSucceeded":true})
        ));
    }
    #[test]
    fn merges_primary_forecasts_and_provenance_without_losing_supplement() {
        let primary = json!({"code":"600036.SH","title":"招商银行(600036)：盈利改善","orgName":"机构证券股份有限公司","publishDate":"2026-10-29","infoCode":"AP20261029000000","forecasts":[{"year":2027,"eps":3}],"provenance":"existing"});
        let supplement = json!({"code":"600036.SH","title":"盈利改善","institution":"机构证券","publishDate":"2026/10/29","url":"https://EXAMPLE.com/report?utm_source=x","forecasts":[{"year":2027,"eps":4,"netProfit":20},{"year":2028,"eps":5}],"provenance":"web_search"});
        let rows = merge_reports(&[primary], &[supplement]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["provenance"], "existing");
        assert_eq!(rows[0]["forecasts"][0]["eps"], 3);
        assert_eq!(rows[0]["forecasts"][0]["netProfit"], 20);
        assert_eq!(rows[0]["forecasts"][1]["year"], 2028);
        assert_eq!(
            canonical_url("HTTPS://EXAMPLE.COM/a/?b=2&a=1&utm_source=x#fragment"),
            "https://example.com/a/?a=1&b=2"
        );
    }
    #[test]
    fn discovery_keeps_partial_hits_but_enforces_cited_url_when_present() {
        let raw = json!([{"title":"partial"},{"url":"[report](https://EXAMPLE.com/r?utm_source=x)","forecasts":[{"year":2027,"netProfit":3}]},{"title":"uncited","url":"https://evil.example/r"},null]);
        let (rows, rejected) = parse_discovery(
            &raw.to_string(),
            "600036",
            &[json!({"url":"https://example.com/r"})],
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rejected, 2);
        assert_eq!(rows[0]["title"], "partial");
        assert_eq!(rows[1]["title"], "example.com/r");
        assert_eq!(rows[1]["provenance"], "web_search");
        assert_eq!(rows[1]["code"], "600036.SH");
        assert!(parse_discovery("```json\n[]\n```", "600036.SH", &[]).is_err());
    }
    #[test]
    fn preserves_publication_relative_years_and_current_pe_basis() {
        let normalized = normalize_forward(
            &json!({"publishDate":"2023-12-01","predictThisYearEps":"2","predictNextYearPe":-1,"forecasts":[{"year":2023,"eps":3},{"year":2025,"profitGrowth":-5}]}),
        );
        assert_eq!(normalized["forecasts"][0], json!({"year":2023,"eps":3.0}));
        assert_eq!(normalized["forecasts"][1], json!({"year":2024}));
        assert_eq!(normalized["forecasts"][2]["year"], 2025);
        let overview = json!({"marketCapYi":100,"latestPrice":20,"updatedAt":123});
        let items = apply_current_pe(
            &[json!({"forecasts":[{"year":2027,"eps":2},{"year":2028,"netProfit":-1} ]})],
            Some(&overview),
            &BTreeMap::from([(2026, 5.0)]),
        );
        assert_eq!(items[0]["forecasts"][0]["computedPe"], 10.0);
        assert_eq!(items[0]["forecasts"][0]["computedNetProfit"], 10.0);
        assert!(items[0]["forecasts"][1].get("computedPe").is_none());
        assert_eq!(items[0]["computedPeByYear"]["2026"], 20.0);
    }
    #[test]
    fn aggregates_valid_values_and_ignores_negated_news_keywords() {
        let items = [
            json!({"code":"600036.SH","forecasts":[{"year":2027,"netProfit":10,"profitGrowth":-5},{"year":2027,"netProfit":20,"profitGrowth":5}]}),
            json!({"code":"00700.HK","forecasts":[{"year":2027,"netProfit":1000}]}),
        ];
        assert_eq!(
            aggregate("600036", &items),
            json!([{"year":2027,"netProfit":15.0,"profitGrowth":0.0}])
        );
        assert!(likely_news("公司研报", "首次覆盖，盈利预测"));
        assert!(!likely_news("公司消息", "未给出目标价，没有盈利预测"));
        assert_eq!(
            format_for_llm("盈 利 预 测 202 7\r\n财 务\u{200b}报 告"),
            "盈利预测 2027\n财务报告"
        );
        assert_eq!(format_for_llm("盈利202 7"), "盈利2027");
        assert!(parse_analysis("}{").is_err());
        assert_eq!(number(&json!("1,200%")), Some(1200.0));
        assert_eq!(number(&json!("5% ")), None);
        assert_eq!(
            parse_forecasts(&[json!({"year":"2027%","eps":1})]),
            Vec::<Value>::new()
        );
    }
    #[test]
    fn raw_identity_prefers_urls_or_native_ids() {
        let output = json!({"response":{"text":json!([{"title":"right","url":"https://example.com/r?utm_source=x"},{"title":"other","id":"AP20261029000000"}]).to_string()}});
        assert_eq!(
            raw_report(&output, &json!({"url":"https://example.com/r"})).unwrap()["title"],
            "right"
        );
        assert_eq!(
            raw_report(&output, &json!({"infoCode":"AP20261029000000"})).unwrap()["title"],
            "other"
        );
        assert!(raw_report(&output, &json!({"title":"right"})).is_none());
    }

    #[test]
    fn normalizes_dates_and_url_queries_like_existing_source() {
        for (input, expected) in [
            ("2026/1/2", "2026-01-02"),
            ("2026年2月3日", "2026-02-03"),
            ("2026-02-30", "2026-02-30"),
            ("2026-13-01", ""),
            ("2026-01-00", ""),
            ("2026-01-32", ""),
        ] {
            assert_eq!(normalize_date(input), expected);
        }
        assert_eq!(
            canonical_url("https://EXAMPLE.com/?x=2&x=1&ref=x&FROM=y"),
            "https://example.com/?x=2&x=1"
        );
        assert_eq!(
            canonical_url("https://example.com/?utm_source=x"),
            "https://example.com"
        );
        assert_eq!(canonical_url("ftp://example.com"), "");
        assert_eq!(number(&json!("0x10")), Some(16.0));
        assert!(number(&json!(true)).is_none());
    }
}
