//! Native input normalization for the local knowledge ingestion pipeline.
use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, TimeZone, Utc};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{Duration, UNIX_EPOCH},
};
type Aliases = HashMap<String, Option<String>>;
fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.trim().to_owned(),
        _ => v.to_string(),
    }
}
fn pick(v: &Value, keys: &[&str]) -> Value {
    keys.iter()
        .map(|k| &v[*k])
        .find(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null)
}
fn string(v: &Value, keys: &[&str]) -> String {
    text(&pick(v, keys))
}
fn object(v: &Value) -> Value {
    if v.is_object() {
        v.clone()
    } else if let Some(s) = v.as_str() {
        serde_json::from_str::<Value>(s)
            .ok()
            .filter(Value::is_object)
            .unwrap_or(json!({}))
    } else {
        json!({})
    }
}
fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn unique(v: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.into_iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}
fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => Some(0.),
        Value::Bool(b) => Some(if *b { 1. } else { 0. }),
        Value::String(s) => {
            if s.trim().is_empty() {
                Some(0.)
            } else {
                s.trim().parse().ok()
            }
        }
        _ => v.as_f64(),
    }
    .filter(|n| n.is_finite())
}
fn int(v: &Value, fallback: i64) -> i64 {
    if v.is_null() {
        return fallback;
    }
    number(v)
        .filter(|n| n.fract() == 0.)
        .map(|n| n as i64)
        .unwrap_or(fallback)
}
fn cut(s: &str, n: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= n
        })
        .collect()
}
fn replace(s: &str, re: &str, to: &str) -> String {
    Regex::new(re)
        .expect("static pattern")
        .replace_all(s, to)
        .into_owned()
}
fn stable(s: &str) -> String {
    format!("k_{:x}", Sha256::digest(s.as_bytes()))[..26].to_owned()
}
fn basename(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn title_file(path: &Path) -> String {
    replace(
        &path.file_stem().unwrap_or_default().to_string_lossy(),
        "[_-]+",
        " ",
    )
    .trim()
    .into()
}
fn extension(path: &Path) -> String {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
}
fn base_name(name: &str) -> String {
    replace(
        &replace(name, r"(?i)\.(SH|SZ|US|HK|BJ|PT)$", ""),
        r"(?i)-(SW|W|B|S|R)$",
        "",
    )
    .trim()
    .into()
}
fn short_name(name: &str) -> String {
    replace(
        name,
        r"(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$",
        "",
    )
    .trim()
    .into()
}
fn alias_keys(name: &str) -> Vec<String> {
    unique([
        name.to_lowercase(),
        base_name(name).to_lowercase(),
        short_name(&base_name(name)).to_lowercase(),
    ])
}
async fn load_aliases(state: &AppState) -> Aliases {
    let mut map = Aliases::new();
    if let Ok(rows)=state.db.query("select code,short_name as alias from stock union all select code,code as alias from stock union all select code,alias from stock_alias",vec![]).await {for row in rows{let code=text(&row["code"]);if supported_code(&code).is_empty(){continue}for alias in alias_keys(&text(&row["alias"])) {map.entry(alias).and_modify(|old|{if old.as_ref()!=Some(&code){*old=None}}).or_insert_with(||Some(code.clone()));}}}
    map
}
pub fn supported_code(input: &str) -> String {
    let raw = input.trim().to_uppercase();
    let us = Regex::new(r"^US([A-Z0-9.-]+)\.(OQ|NQ|N|AMEX|PK|OB)$").unwrap();
    let mut code = if let Some(c) = us.captures(&raw) {
        format!("{}.US", &c[1])
    } else if let Some(c) = Regex::new(r"^(SH|SZ|BJ)(\d{6})$").unwrap().captures(&raw) {
        format!("{}.{}", &c[2], &c[1])
    } else if let Some(c) = Regex::new(r"^HK(\d{5})$").unwrap().captures(&raw) {
        format!("{}.HK", &c[1])
    } else {
        raw.clone()
    };
    if code == raw
        && let Some(c) = Regex::new(r"(?:^|[^0-9])([0-9]\d{5})(?:[^0-9]|$)")
            .unwrap()
            .captures(&raw)
    {
        let n = &c[1];
        let market = match n.as_bytes()[0] {
            b'6' | b'5' | b'9' => "SH",
            b'0' | b'1' | b'2' | b'3' => "SZ",
            _ => "BJ",
        };
        code = format!("{n}.{market}");
    }
    if Regex::new(r"^(\d{6}\.(SH|SZ|BJ)|\d{5}\.HK|[A-Z0-9.-]+\.US)$")
        .unwrap()
        .is_match(&code)
    {
        code
    } else {
        String::new()
    }
}
fn resolve(code: &str, name: &str, aliases: &Aliases) -> String {
    let code = supported_code(code);
    if !code.is_empty() {
        return code;
    }
    alias_keys(name)
        .iter()
        .find_map(|k| aliases.get(k).and_then(Clone::clone))
        .unwrap_or_default()
}
fn links(mut doc: Value, aliases: &Aliases) -> Value {
    let meta = object(&doc["metadata"]);
    let names = arr(&meta["stockNames"]);
    let codes = arr(&meta["stockCodes"]);
    let mut pairs = vec![(text(&doc["targetCode"]), text(&doc["targetName"]))];
    for i in 0..names.len().max(codes.len()) {
        pairs.push((
            codes.get(i).map(text).unwrap_or_default(),
            names.get(i).map(text).unwrap_or_default(),
        ));
    }
    pairs.push((
        text(&meta["raw"]["stockCode"]),
        text(&meta["raw"]["stockName"]),
    ));
    let mut seen = HashSet::new();
    let mut output = vec![];
    for (code, name) in pairs {
        let code = resolve(&code, &name, aliases);
        if code.is_empty() || !seen.insert(format!("{code}|{name}")) {
            continue;
        }
        let base = base_name(&name);
        let bare = code.split('.').next().unwrap_or("").to_owned();
        let a = unique([
            code.clone(),
            bare,
            name.clone(),
            base.clone(),
            short_name(&base),
        ]);
        output.push(json!({"code":code,"name":name,"aliases":a}));
    }
    doc["metadata"] = meta;
    doc["metadata"]["stockNames"] = json!(
        output
            .iter()
            .map(|v| text(&v["name"]))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    );
    doc["metadata"]["stockCodes"] =
        json!(output.iter().map(|v| text(&v["code"])).collect::<Vec<_>>());
    doc["metadata"]["stockLinks"] = json!(output);
    doc
}
fn filename_code(s: &str) -> String {
    let s = s.trim().to_uppercase();
    if Regex::new(r"^[036]\d{5}$").unwrap().is_match(&s) {
        return format!("{}.{}", s, if s.starts_with('6') { "SH" } else { "SZ" });
    }
    if let Some(c) = Regex::new(r"^US([A-Z0-9.-]+)\.(OQ|NQ|N|AMEX|PK|OB)$")
        .unwrap()
        .captures(&s)
    {
        return format!("{}.US", &c[1]);
    }
    if Regex::new(r"^(\d{4}\.(TW|TWO)|\d{3,5}\.HK|[A-Z0-9.-]+\.(SH|SZ|HK|US|TW|TWO))$")
        .unwrap()
        .is_match(&s)
    {
        s
    } else {
        String::new()
    }
}
pub fn parse_filename(path: &Path) -> Value {
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .trim()
        .to_owned();
    let normalized = replace(&stem, "[_-]+", " ").trim().to_owned();
    let tokens = Regex::new("[-_]+")
        .unwrap()
        .split(&stem)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let date = |s: &str| -> String {
        let d = replace(s, r"[^\d]", "");
        if d.len() != 8 {
            return String::new();
        }
        let y = d[..4].parse::<u32>().unwrap_or(0);
        let m = d[4..6].parse::<u32>().unwrap_or(0);
        let day = d[6..].parse::<u32>().unwrap_or(0);
        if (2000..=2100).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&day) {
            format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..])
        } else {
            String::new()
        }
    };
    let di = tokens.iter().take(3).position(|s| !date(s).is_empty());
    let si = di.filter(|i| i + 2 < tokens.len()).map(|i| i + 1);
    let titles = &tokens[si.map(|i| i + 1).or(di.map(|i| i + 1)).unwrap_or(0)..];
    let prefix = di.map(|i| tokens[..i].join(" ")).unwrap_or_default();
    let lead = titles.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    let industry = Regex::new("行业|赛道|策略|周报|月报|晨报").unwrap();
    let mut kind = if industry.is_match(&prefix) || industry.is_match(&lead) {
        "industry_report"
    } else if Regex::new("个股|公司|点评|首次覆盖")
        .unwrap()
        .is_match(&prefix)
    {
        "company_report"
    } else {
        "research_report"
    };
    let joined = titles.join(" ");
    let (mut name, mut code) = (String::new(), String::new());
    if kind != "industry_report" {
        if let Some(c) = Regex::new(r"^(.+?)\(([^()]+)\)").unwrap().captures(&joined) {
            code = filename_code(&c[2]);
            if !code.is_empty() {
                name = replace(&c[1], r"[（(]\s*$", "").trim().into();
            }
        }
        if code.is_empty() && titles.len() >= 2 {
            code = filename_code(titles[1]);
            if !code.is_empty() {
                name = replace(titles[0], r"[（(]\s*$", "").trim().into();
            }
        }
    }
    if !code.is_empty() {
        kind = "company_report"
    }
    let title = if !code.is_empty()
        && titles.len() >= 2
        && replace(titles[0], r"[（(]\s*$", "").trim() == name
        && filename_code(titles[1]) == code
    {
        let s = titles[2..].join(" ");
        if s.is_empty() {
            format!("{name} ({code})")
        } else {
            s
        }
    } else {
        joined
    };
    json!({"originalStem":stem,"normalizedStem":normalized,"publishedAt":di.map(|i|date(tokens[i])).unwrap_or_default(),"sourceName":si.map(|i|tokens[i]).unwrap_or(""),"targetName":name,"targetCode":code,"reportType":kind,"title":if title.is_empty(){normalized}else{title}})
}
pub fn source_fingerprint(path: &Path) -> Result<Value> {
    let stat = std::fs::metadata(path)?;
    Ok(
        json!({"sourceFile":basename(path),"sourceMtimeMs":stat.modified()?.duration_since(UNIX_EPOCH)?.as_millis() as u64,"sourceSize":stat.len()}),
    )
}
pub fn source_fingerprint_for(path: &Path, config: &Value) -> Result<Value> {
    let mut fp = source_fingerprint(path)?;
    let mut dirs = arr(&config["inputDirs"])
        .iter()
        .map(text)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    dirs.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for dir in dirs {
        if let Ok(relative) = path.strip_prefix(&dir) {
            fp["sourceFile"] = json!(relative.to_string_lossy());
            break;
        }
    }
    Ok(fp)
}
fn strip_html(s: &str) -> String {
    let s = replace(&replace(s, r"(?i)<\s*br\s*/?>", "\n"), r"(?i)</p\s*>", "\n");
    replace(
        &replace(&s, "<[^>]+>", "")
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">"),
        r"\n{3,}",
        "\n\n",
    )
    .trim()
    .into()
}
fn normalize_date(v: &Value) -> Result<String> {
    let s = text(v);
    if s.is_empty() {
        return Ok(s);
    }
    let n = if v.is_number() || s.chars().all(|c| c.is_ascii_digit()) {
        number(v)
    } else {
        None
    };
    if let Some(n) = n {
        let ms = if n > 10_000_000_000. { n } else { n * 1000. };
        return Utc
            .timestamp_millis_opt(ms as i64)
            .single()
            .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
            .context("invalid source timestamp");
    }
    Ok(s)
}
fn raw_input(mut raw: Value, path: &Path, aliases: &Aliases) -> Result<Value> {
    if !raw.is_object() {
        bail!("input document must be an object")
    }
    let content = object(&raw["content"]);
    let stocks = arr(&pick(&raw, &["stockInfo", "stock_info"]));
    let html = string(&content, &["text"]);
    let html = if html.is_empty() {
        text(&raw["content_html"])
    } else {
        html
    };
    let body = string(&raw, &["markdown", "mdText", "md_text", "body"]);
    let body = if !body.is_empty() {
        body
    } else {
        let html = strip_html(&html);
        if html.is_empty() {
            text(&raw["text"])
        } else {
            html
        }
    };
    let tencent = extension(path) == "json"
        && (!raw["dedupe_title"].is_null() || !raw["stockInfo"].is_null() || !html.is_empty());
    if !tencent {
        if !body.is_empty() {
            raw["content"] = json!(body)
        }
        return Ok(raw);
    }
    let title = string(&raw, &["title", "dedupe_title"]);
    let source = string(&raw, &["sourceName", "source_name", "source"]);
    let source = if source.is_empty() {
        "腾讯自选股".into()
    } else {
        source
    };
    let mut name = string(&raw, &["targetName", "target_name"]);
    let mut code = resolve(
        &string(&raw, &["targetCode", "target_code"]),
        &name,
        aliases,
    );
    if name.is_empty() && code.is_empty() {
        let candidates = stocks
            .iter()
            .map(|s| {
                let n = text(&s["name"]);
                (resolve(&text(&s["symbol"]), &n, aliases), n)
            })
            .filter(|(c, n)| {
                (!c.is_empty() || !n.is_empty())
                    && !c.to_lowercase().starts_with("pt")
                    && !Regex::new("(?i)ETF|LOF|QDII|概念|指数|板块|主题|基金")
                        .unwrap()
                        .is_match(n)
            })
            .collect::<Vec<_>>();
        if let Some((c, n)) = if candidates.len() == 1 {
            candidates.first()
        } else {
            candidates
                .iter()
                .find(|(_, n)| !base_name(n).is_empty() && title.contains(&base_name(n)))
        } {
            code = c.clone();
            name = n.clone();
        }
    }
    let mut clean = body.trim().to_owned();
    for re in [
        r"^作者[丨|｜:：\s]*[^\s，。,；;:：]{1,40}\s*",
        r"^(公众号|点击上方)[^。！？!?]{0,80}[。！？!?]?\s*",
        r"^来源[：:]\s*[^\s]+\s*",
        r"^原标题[：:]\s*",
    ] {
        clean = replace(&clean, re, "");
    }
    let ignored = Regex::new(r"^作者[丨|｜:：\s]|^(公众号|点击上方|来源|原标题)|加星标").unwrap();
    if ignored.is_match(&clean) {
        clean = clean
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .skip_while(|s| ignored.is_match(s))
            .collect::<Vec<_>>()
            .join(" ");
    }
    let signature = stable(&format!(
        "tencent_stock_news|{source}|{title}|{}",
        cut(&replace(&clean, r"[^\p{L}\p{N}]+", ""), 1200)
    ));
    let mut meta = object(&pick(&raw, &["metadata", "metadata_json"]));
    meta["source"] = json!("tencent_stock_news");
    meta["newsId"] = json!(text(&raw["id"]));
    meta["dedupeSignature"] = json!(signature);
    meta["stockNames"] = json!(unique(stocks.iter().map(|s| text(&s["name"]))));
    meta["stockCodes"] = json!(unique(
        stocks
            .iter()
            .map(|s| text(&s["symbol"]))
            .chain(arr(&raw["stock_codes"]).iter().map(text))
    ));
    meta["originalFile"] = json!(basename(path));
    let explicit = string(&raw, &["docId", "doc_id"]);
    raw["docId"] = json!(if explicit.is_empty() {
        signature
    } else {
        explicit
    });
    raw["title"] = json!(title);
    raw["sourceName"] = json!(source);
    let source_type = string(&raw, &["sourceType", "source_type"]);
    raw["sourceType"] = json!(if source_type.is_empty() {
        "local_news".to_owned()
    } else {
        source_type
    });
    let report_type = string(&raw, &["reportType", "report_type"]);
    raw["reportType"] = json!(if report_type.is_empty() {
        "news".to_owned()
    } else {
        report_type
    });
    let date = normalize_date(&pick(
        &raw,
        &[
            "publishedAt",
            "published_at",
            "publish_time",
            "time",
            "date",
        ],
    ))?;
    raw["publishedAt"] = json!(date);
    raw["eventTime"] = json!(date);
    raw["targetName"] = json!(name);
    raw["targetCode"] = json!(code);
    raw["content"] = json!(body);
    raw["metadata"] = meta;
    Ok(raw)
}
fn normalize(
    raw: Value,
    path: &Path,
    cfg: &Value,
    fp: &Value,
    now: i64,
    aliases: &Aliases,
) -> Result<Value> {
    let raw = raw_input(raw, path, aliases)?;
    let title = string(&raw, &["title"]);
    let title = if title.is_empty() {
        title_file(path)
    } else {
        title
    };
    let markdown = string(&raw, &["mdText", "md_text", "markdown", "content", "body"]);
    let source = string(&raw, &["sourceType", "source_type"]);
    let source = if source.is_empty() {
        if extension(path) == "pdf" || text(&raw["url"]).contains(".pdf") {
            "research_report".into()
        } else {
            let s = text(&cfg["defaultSourceType"]);
            if s.is_empty() { "local_news".into() } else { s }
        }
    } else {
        source
    };
    let report = string(&raw, &["reportType", "report_type"]);
    let report = if report.is_empty() {
        if source == "research_report" {
            if !string(&raw, &["targetCode", "target_code"]).is_empty() {
                "company_report"
            } else {
                "research_report"
            }
        } else if extension(path) == "pdf" {
            "research_report"
        } else {
            "news"
        }
        .to_owned()
    } else {
        report
    };
    let mut meta = object(&pick(&raw, &["metadata", "metadata_json"]));
    let time = Utc
        .timestamp_millis_opt(now)
        .single()
        .context("invalid processing time")?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    for (k, v) in [
        ("processedAt", json!(time)),
        ("inputFile", json!(basename(path))),
        ("inputRelativeFile", fp["sourceFile"].clone()),
        ("sourceMtimeMs", fp["sourceMtimeMs"].clone()),
        ("sourceSize", fp["sourceSize"].clone()),
        ("pdfStored", json!(false)),
    ] {
        meta[k] = v;
    }
    let mut tags = arr(&raw["tags"]).iter().map(text).collect::<Vec<_>>();
    if extension(path) == "pdf" {
        tags.push("pdf".into())
    }
    let id = string(&raw, &["docId", "doc_id", "id"]);
    let id = if id.is_empty() {
        stable(&format!(
            "{}|{}|{}|{}",
            text(&raw["url"]),
            title,
            string(&raw, &["publishedAt", "published_at", "date"]),
            basename(path)
        ))
    } else {
        id
    };
    let source_name = string(&raw, &["sourceName", "source_name"]);
    let fallback = |s: String, d: &str| if s.is_empty() { d.to_owned() } else { s };
    let doc = json!({"docId":id,"title":title,"sourceType":source,"reportType":report,"sourceName":fallback(source_name,&text(&cfg["defaultSourceName"])),"url":text(&raw["url"]),"publishedAt":string(&raw,&["publishedAt","published_at","date"]),"fetchedAt":fallback(string(&raw,&["fetchedAt","fetched_at"]),&time),"eventTime":string(&raw,&["eventTime","event_time","publishedAt","published_at","date"]),"targetName":string(&raw,&["targetName","target_name"]),"targetCode":string(&raw,&["targetCode","target_code"]),"discoveryMethod":fallback(string(&raw,&["discoveryMethod","discovery_method"]),"local_process_once"),"accessMethod":fallback(string(&raw,&["accessMethod","access_method"]),"markdown"),"summary":text(&raw["summary"]),"markdown":cut(&markdown,int(&cfg["maxMarkdownChars"],120000).max(0) as usize),"metadata":meta,"tags":unique(tags),"recommendationScore":int(&pick(&raw,&["recommendationScore","recommendation_score"]),0),"recommendationLevel":string(&raw,&["recommendationLevel","recommendation_level"]),"recommendationReasons":unique(arr(&pick(&raw,&["recommendationReasons","recommendation_reasons"])).iter().map(text)),"rankScore":int(&pick(&raw,&["rankScore","rank_score"]),0),"sourceWeight":int(&pick(&raw,&["sourceWeight","source_weight"]),0)});
    Ok(links(doc, aliases))
}
pub async fn process_file(
    state: &AppState,
    path: &Path,
    cfg: &Value,
    now_ms: i64,
) -> Result<Vec<Value>> {
    let aliases = load_aliases(state).await;
    let fp = source_fingerprint_for(path, cfg)?;
    let ext = extension(path);
    let raw = match ext.as_str() {
        "json" | "jsonl" => {
            let body = std::fs::read_to_string(path)?;
            let body = body.trim();
            if body.is_empty() {
                vec![]
            } else if let Ok(v) = serde_json::from_str::<Value>(body) {
                if let Value::Array(a) = v { a } else { vec![v] }
            } else {
                body.lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(serde_json::from_str)
                    .collect::<std::result::Result<Vec<Value>, _>>()?
            }
        }
        "pdf" => {
            let p = parse_filename(path);
            let id = stable(&format!("|{}||{}", title_file(path), basename(path)));
            vec![
                json!({"docId":id,"title":p["title"],"sourceType":"research_report","reportType":p["reportType"],"sourceName":if text(&p["sourceName"]).is_empty(){cfg["defaultSourceName"].clone()}else{p["sourceName"].clone()},"accessMethod":"local_pdf_pending","publishedAt":p["publishedAt"],"eventTime":p["publishedAt"],"targetName":p["targetName"],"targetCode":p["targetCode"],"summary":p["title"],"markdown":"","metadata":{"originalFile":basename(path),"pdfStored":false,"localPdfPath":path.to_string_lossy(),"filenameParse":{"publishedAt":p["publishedAt"],"sourceName":p["sourceName"],"targetName":p["targetName"],"targetCode":p["targetCode"],"reportType":p["reportType"]}},"tags":["pdf"]}),
            ]
        }
        "md" | "txt" => {
            let body = std::fs::read_to_string(path)?;
            let title = body
                .lines()
                .find_map(|l| {
                    let rest = l.strip_prefix('#')?;
                    rest.starts_with(char::is_whitespace).then(|| rest.trim())
                })
                .map(str::to_owned)
                .unwrap_or_else(|| title_file(path));
            vec![
                json!({"title":title,"sourceType":cfg.get("defaultSourceType").cloned().unwrap_or(json!("local_news")),"reportType":cfg.get("defaultReportType").cloned().unwrap_or(json!("news")),"sourceName":cfg["defaultSourceName"],"accessMethod":"markdown","markdown":body,"metadata":{"originalFile":basename(path)}}),
            ]
        }
        _ => bail!("unsupported knowledge input extension: {}", path.display()),
    };
    raw.into_iter()
        .map(|v| normalize(v, path, cfg, &fp, now_ms, &aliases))
        .collect()
}
pub fn finalize(mut doc: Value, cfg: &Value) -> Value {
    let mut score = int(&cfg["sourceTypeScores"][text(&doc["sourceType"])], 0)
        + int(&cfg["reportTypeScores"][text(&doc["reportType"])], 0);
    let mut tags = arr(&doc["tags"]).iter().map(text).collect::<Vec<_>>();
    for t in &tags {
        score += int(&cfg["tagScores"][t], 0)
    }
    let haystack = format!(
        "{}\n{}",
        text(&doc["title"]),
        cut(&text(&doc["markdown"]), 8000)
    )
    .to_lowercase();
    let mut reasons = vec![];
    for signal in arr(&cfg["signals"]) {
        if arr(&signal["keywords"])
            .iter()
            .any(|k| haystack.contains(&text(k).to_lowercase()))
        {
            score += int(&signal["score"], 0);
            tags.push(text(&signal["tag"]));
            reasons.push(text(&signal["reason"]));
        }
    }
    let recommendation = if doc.get("recommendationScore").and_then(number).is_some() {
        int(&doc["recommendationScore"], 0)
    } else {
        score.max(0)
    };
    let existing = unique(arr(&doc["recommendationReasons"]).iter().map(text));
    doc["recommendationScore"] = json!(recommendation);
    doc["rankScore"] = json!(if doc.get("rankScore").and_then(number).is_some() {
        int(&doc["rankScore"], recommendation)
    } else {
        recommendation
    });
    doc["summary"] = json!(text(&doc["summary"]));
    doc["tags"] = json!(unique(tags));
    doc["recommendationReasons"] = json!(if existing.is_empty() {
        unique(reasons)
    } else {
        existing
    });
    links(doc, &Aliases::new())
}
pub async fn materialize(
    state: &AppState,
    path: &Path,
    mut doc: Value,
    cfg: &Value,
) -> Result<Value> {
    let aliases = load_aliases(state).await;
    let url = text(&doc["url"]);
    let pdf = url.to_lowercase().contains(".pdf");
    let report = text(&doc["sourceType"]) == "research_report"
        || ["company_report", "industry_report", "research_report"]
            .contains(&text(&doc["reportType"]).as_str());
    if text(&cfg["reportPdfMode"]) == "original_link" && report && pdf {
        doc["accessMethod"] = json!("remote_pdf");
        doc["markdown"] = json!("");
        doc["metadata"]["pdfStored"] = json!(false);
        doc["metadata"]["remotePdfMaterialized"] = json!(false);
        doc["metadata"]["remotePdfUrl"] = json!(url);
    } else if pdf
        && text(&doc["accessMethod"])
            .to_lowercase()
            .contains("remote_pdf")
    {
        let id = text(&doc["docId"]);
        let markdown = crate::knowledge::content::convert_report(state, &id, &url).await?;
        doc["markdown"] = json!(markdown);
        doc["accessMethod"] = json!("markdown_from_remote_pdf");
        doc["metadata"]["pdfStored"] = json!(false);
        doc["metadata"]["remotePdfMaterialized"] = json!(true);
        doc["metadata"]["remotePdfUrl"] = json!(url);
        doc["metadata"]["remotePdfWorkFile"] = json!(format!("{}.pdf", safe_file(&id)));
    } else if text(&doc["accessMethod"]) == "local_pdf_pending" || extension(path) == "pdf" {
        doc["markdown"] = json!(convert_local(state, path, &text(&doc["docId"]), cfg).await?);
        doc["accessMethod"] = json!("markdown_from_local_pdf");
        doc["metadata"]["pdfStored"] = json!(false);
        doc["metadata"]["localPdfMaterialized"] = json!(true);
    }
    Ok(links(doc, &aliases))
}
fn safe_file(s: &str) -> String {
    let s = replace(s, "[^a-zA-Z0-9._-]+", "-")
        .trim_matches('-')
        .to_owned();
    if s.is_empty() { "file".into() } else { s }
}
async fn convert_local(state: &AppState, path: &Path, id: &str, cfg: &Value) -> Result<String> {
    let work = text(&cfg["workDir"]);
    let work = if work.is_empty() {
        state.data_dir().join("knowledge-work")
    } else {
        state.root.join(work)
    };
    let cache = work.join("markdown-cache");
    std::fs::create_dir_all(&cache)?;
    let path = std::fs::canonicalize(path)?;
    let stat = std::fs::metadata(&path)?;
    let fp = json!({"file":path.to_string_lossy(),"basename":basename(&path),"mtimeMs":stat.modified()?.duration_since(UNIX_EPOCH)?.as_secs_f64()*1000.,"size":stat.len()});
    let md = cache.join(format!("{}.md", safe_file(id)));
    let meta = cache.join(format!("{}.json", safe_file(id)));
    if let Ok(v) = std::fs::read(&meta)
        .and_then(|s| serde_json::from_slice::<Value>(&s).map_err(std::io::Error::other))
        && v["mtimeMs"] == fp["mtimeMs"]
        && v["size"] == fp["size"]
        && (v["file"] == fp["file"]
            || v["basename"] == fp["basename"]
            || Path::new(&text(&v["file"])).file_name() == path.file_name())
        && let Ok(s) = std::fs::read_to_string(&md)
    {
        return Ok(s);
    }
    let python = text(&cfg["python"]);
    let python = if python.is_empty() {
        std::env::var("PYTHON_BIN").unwrap_or_else(|_| "python3".into())
    } else {
        python
    };
    let temp = tempfile::NamedTempFile::new_in(&cache)?;
    let code = "import pathlib,sys\npdf=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])\ntry:\n import pymupdf4llm\n text=pymupdf4llm.to_markdown(str(pdf))\nexcept Exception:\n import fitz\n doc=fitz.open(str(pdf))\n text='\\n\\n'.join(page.get_text('text') for page in doc)\nout.write_text(text,encoding='utf-8')\n";
    let output = tokio::time::timeout(
        Duration::from_millis(int(&cfg["pdfConversionTimeoutMs"], 120000).max(1) as u64),
        tokio::process::Command::new(&python)
            .arg("-c")
            .arg(code)
            .arg(&path)
            .arg(temp.path())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("knowledge PDF conversion timed out")?
    .context("starting Python PDF converter (requires pymupdf4llm or PyMuPDF)")?;
    if !output.status.success() {
        bail!(
            "PDF conversion failed (requires pymupdf4llm or PyMuPDF): {}",
            cut(&String::from_utf8_lossy(&output.stderr), 2000)
        )
    }
    let markdown = std::fs::read_to_string(temp.path())?;
    std::fs::write(md, &markdown)?;
    std::fs::write(meta, serde_json::to_vec(&fp)?)?;
    Ok(markdown)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filenames() {
        let p = parse_filename(Path::new(
            "个股-20261028-中信证券-贵州茅台-600519-稳定增长.pdf",
        ));
        assert_eq!(p["targetCode"], "600519.SH");
        assert_eq!(p["title"], "稳定增长");
        assert_eq!(p["publishedAt"], "2026-10-28");
        assert_eq!(
            parse_filename(Path::new("行业-20261028-中信-新能源周报.pdf"))["reportType"],
            "industry_report"
        );
    }
    #[test]
    fn source_codes() {
        assert_eq!(supported_code("sh600036"), "600036.SH");
        assert_eq!(supported_code("USNVDA.OQ"), "NVDA.US");
        assert_eq!(supported_code("HK00700"), "00700.HK");
        assert_eq!(supported_code("pt001"), "");
    }
    #[test]
    fn score_preserves_explicit_zero() {
        let v = finalize(
            json!({"title":"人工智能","markdown":"","tags":[],"recommendationScore":0,"rankScore":0,"targetCode":"600036.SH","targetName":"招商银行","metadata":{}}),
            &json!({"signals":[{"keywords":["人工智能"],"score":9,"tag":"ai","reason":"相关"}]}),
        );
        assert_eq!(v["recommendationScore"], 0);
        assert_eq!(v["tags"], json!(["ai"]));
        assert_eq!(v["metadata"]["stockLinks"][0]["aliases"][1], "600036");
    }
    #[test]
    fn tencent_dedupe_and_html() {
        let raw = json!({"title":"招商银行公告","stockInfo":[{"name":"招商银行","symbol":"sh600036"}],"content":{"text":"<p>来源：腾讯 正文&amp;内容</p>"},"publish_time":1700000000});
        let path = Path::new("a.json");
        let d = raw_input(raw, path, &Aliases::new()).unwrap();
        assert_eq!(d["targetCode"], "600036.SH");
        assert_eq!(d["content"], "来源：腾讯 正文&内容");
        assert!(text(&d["docId"]).starts_with("k_"));
        assert_eq!(text(&d["docId"]).len(), 26);
    }
    #[test]
    fn ambiguous_alias_not_guessed() {
        let mut a = Aliases::new();
        a.insert("同名".into(), None);
        assert_eq!(resolve("", "同名", &a), "");
    }
}

#[cfg(test)]
mod input_regressions {
    use super::*;
    #[test]
    fn plain_json_preserves_dates_and_default_markdown_limit() {
        let doc = normalize(json!({"title":"报告", "markdown":"正文", "published_at":"2026-10-28", "metadata_json":"{\"custom\":true}"}), Path::new("test.json"), &json!({}), &json!({"sourceFile":"a/test.json", "sourceMtimeMs":1,"sourceSize":2}), 0, &Aliases::new()).unwrap();
        assert_eq!(doc["markdown"], "正文");
        assert_eq!(doc["eventTime"], "2026-10-28");
        assert_eq!(doc["metadata"]["custom"], true);
        assert_eq!(doc["metadata"]["inputRelativeFile"], "a/test.json");
        assert_eq!(doc["fetchedAt"], "1970-01-01T00:00:00.000Z");
    }
    #[test]
    fn fingerprint_retains_relative_nested_source() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("news");
        std::fs::create_dir(&nested).unwrap();
        let file = nested.join("a.md");
        std::fs::write(&file, "body").unwrap();
        let fp = source_fingerprint_for(&file, &json!({"inputDirs":[dir.path()]})).unwrap();
        assert_eq!(fp["sourceFile"], "news/a.md");
        assert_eq!(fp["sourceSize"], 4);
    }
}
