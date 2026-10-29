#[path = "domain/render.rs"]
pub mod render;
use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use regex::Regex;
pub use render::{render_fund_holdings_statistics_html, render_fund_index_markdown};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub fn s(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => v.to_string(),
    }
}
pub fn n(v: &Value) -> Option<f64> {
    if v.is_null() {
        return None;
    }
    if let Some(value) = v.as_bool() {
        return Some(if value { 1.0 } else { 0.0 });
    }
    let text = s(v);
    if text.is_empty() || text == "---" {
        return None;
    }
    let clean = text.replace(',', "").replacen('%', "", 1);
    let value = if clean.trim().is_empty() {
        Some(0.0)
    } else {
        clean.trim().parse::<f64>().ok()
    };
    value.filter(|n| n.is_finite())
}
pub fn round(v: f64) -> Value {
    if v.is_finite() {
        json!((v * 100.0 + 0.5).floor() / 100.0)
    } else {
        Value::Null
    }
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static regex")
}
fn date(value: &str, label: &str) -> Result<()> {
    if !re(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").is_match(value) {
        bail!("{label} must use YYYY-MM-DD: {value}");
    }
    Ok(())
}
fn date_parts(value: &str) -> (i32, i32, i32) {
    let p = value
        .split('-')
        .map(|n| n.parse::<i32>().unwrap_or(0))
        .collect::<Vec<_>>();
    (p[0], p[1], p[2])
}
pub fn latest_quarterly_report_date(value: &str) -> Result<String> {
    date(value, "as-of")?;
    let (y, m, _) = date_parts(value);
    Ok(if m <= 3 {
        format!("{}-09-30", y - 1)
    } else if m <= 6 {
        format!("{y}-03-31")
    } else if m <= 9 {
        format!("{y}-06-30")
    } else {
        format!("{y}-09-30")
    })
}
pub fn previous_report_date(value: &str) -> Result<String> {
    date(value, "report-date")?;
    let (y, m, d) = date_parts(value);
    Ok(match (m, d) {
        (3, 31) => format!("{}-12-31", y - 1),
        (6, 30) => format!("{y}-03-31"),
        (9, 30) => format!("{y}-06-30"),
        _ => bail!("unsupported quarterly report date: {value}"),
    })
}
pub fn quarter_id(value: &str) -> Result<String> {
    date(value, "report-date")?;
    let (y, m, _) = date_parts(value);
    let q = match m {
        3 => 1,
        6 => 2,
        9 => 3,
        12 => 4,
        _ => bail!("unsupported quarter month: {value}"),
    };
    Ok(format!("{y}Q{q}"))
}
pub fn parse_fund_rank_rows(rows: &Value) -> Value {
    let html = re(r"<[^>]+>");
    let code_re = re(r"^[0-9]{6}$");
    json!(list(rows).iter().filter_map(|row|{
 if !row.is_array()||list(row).len()<10{return None;}let code=s(&row[1]).trim().to_owned();let name=html.replace_all(&s(&row[2]),"").replace("&amp;","&").replace("&nbsp;"," ").trim().to_owned();
 if !code_re.is_match(&code)||name.is_empty(){return None;}Some(json!({"rank":n(&row[0]).unwrap_or(0.0),"code":code,"name":name,"navDate":s(&row[3]).chars().take(10).collect::<String>(),"dailyReturnPct":n(&row[6]),"oneWeekReturnPct":n(&row[7]),"oneMonthReturnPct":n(&row[8]),"threeMonthReturnPct":n(&row[9]),"sixMonthReturnPct":n(&row[10]),"oneYearReturnPct":n(&row[11])}))
 }).collect::<Vec<_>>())
}
pub fn fund_share_class(name: &str) -> String {
    re(r"(?i)([ABC])(?:类)?$")
        .captures(name.trim())
        .map(|c| c[1].to_uppercase())
        .unwrap_or_default()
}
pub fn fund_base_name(name: &str) -> String {
    re(r"(?i)(?:[ABC])(?:类)?$")
        .replace(name.trim(), "")
        .trim()
        .to_owned()
}
fn rank_cmp(a: &Value, b: &Value) -> std::cmp::Ordering {
    n(&a["rank"])
        .unwrap_or(0.0)
        .total_cmp(&n(&b["rank"]).unwrap_or(0.0))
        .then_with(|| s(&a["code"]).cmp(&s(&b["code"])))
}
pub fn dedupe_fund_share_classes(funds: &Value, priority: &Value) -> Value {
    let default = json!(["A", "B", "C", ""]);
    let priority = if priority.is_array() {
        priority
    } else {
        &default
    };
    let position = |class: &Value| {
        list(priority)
            .iter()
            .position(|v| v == class)
            .unwrap_or(list(priority).len())
    };
    let mut groups: BTreeMap<String, Value> = BTreeMap::new();
    let normalize = re(r"[\s·・]");
    for fund in list(funds) {
        let mut candidate = fund.clone();
        let name = s(&fund["name"]);
        let base = fund_base_name(&name);
        let key = normalize.replace_all(&base, "").to_lowercase();
        candidate["baseName"] = json!(base);
        candidate["shareClass"] = json!(fund_share_class(&name));
        let replace = groups.get(&key).is_none_or(|current| {
            position(&candidate["shareClass"])
                .cmp(&position(&current["shareClass"]))
                .then_with(|| rank_cmp(&candidate, current))
                .is_lt()
        });
        if replace {
            groups.insert(key, candidate);
        }
    }
    let mut out = groups.into_values().collect::<Vec<_>>();
    out.sort_by(rank_cmp);
    json!(out)
}
pub fn find_fund_report_notice(notices: &Value, code: &str, report_date: &str) -> Value {
    let parts = report_date.split('-').collect::<Vec<_>>();
    if parts.len() < 2 {
        return Value::Null;
    }
    let year = parts[0];
    let pattern = match parts[1] {
        "03" => format!(r"{year}\s*年?\s*第?\s*1\s*季度报告"),
        "06" => format!(r"{year}\s*年?\s*第?\s*2\s*季度报告"),
        "09" => format!(r"{year}\s*年?\s*第?\s*3\s*季度报告"),
        "12" => format!(r"{year}\s*年(?:年度|年)报告"),
        _ => return Value::Null,
    };
    let pattern = re(&pattern);
    let excluded = re("提示性公告|摘要|更新招募说明书");
    list(notices)
        .iter()
        .find(|notice| {
            let fund = if notice["FUNDCODE"].is_null() {
                code.to_owned()
            } else {
                s(&notice["FUNDCODE"])
            };
            let title = s(&notice["TITLE"]);
            fund.trim() == code
                && !excluded.is_match(&title)
                && pattern.is_match(
                    &title
                        .chars()
                        .filter(|c| !c.is_whitespace())
                        .collect::<String>(),
                )
        })
        .cloned()
        .unwrap_or(Value::Null)
}
pub fn map_notice(item: &Value, code: &str) -> Value {
    let id = s(&item["ID"]).trim().to_owned();
    let fund = s(&item["FUNDCODE"]).trim().to_owned();
    json!({"id":id,"fundCode":if fund.is_empty(){code}else{&fund},"title":s(&item["TITLE"]).trim(),"publishDate":s(&item["PUBLISHDATEDesc"]).chars().take(10).collect::<String>(),"detailUrl":if id.is_empty(){String::new()}else{format!("https://fund.eastmoney.com/gonggao/{code},{id}.html")},"pdfUrl":if id.is_empty(){String::new()}else{format!("https://pdf.dfcfw.com/pdf/H2_{id}_1.pdf")}})
}
pub fn parse_fund_total_shares(text: &str) -> Value {
    re(r"报告期末基金份额总额\s*([0-9,]+(?:\.[0-9]+)?)\s*份")
        .captures(text)
        .and_then(|c| n(&json!(&c[1])))
        .map_or(Value::Null, |v| json!(v))
}
pub fn extract_management_discussion(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    let start = re(r"4\.4(?:\.1)?\s*报告期内基金(?:的)?投资策略和运作分析")
        .find(text)
        .or_else(|| re(r"报告期内基金(?:的)?投资策略和运作分析").find(text))
        .map_or(0, |m| m.start());
    let section = &text[start..];
    let end = re(r"§\s*5\s*投资组合报告")
        .find(section)
        .map_or(section.len(), |m| m.start());
    section[..end]
        .chars()
        .scan(0, |length, c| {
            *length += c.len_utf16();
            (*length <= max).then_some(c)
        })
        .collect::<String>()
        .trim()
        .to_owned()
}
pub fn extract_top_holding_bare_codes(text: &str, limit: usize) -> HashSet<String> {
    let Some(header) = re("前十名股票投资明细|所有股票投资明细").find(text) else {
        return HashSet::new();
    };
    let section = &text[header.start()..];
    let end = re(r"\n\s*5\.4\s")
        .find(&section[section.chars().next().map_or(0, char::len_utf8)..])
        .map(|m| m.start() + section.chars().next().map_or(0, char::len_utf8))
        .unwrap_or_else(|| {
            section
                .char_indices()
                .nth(20000)
                .map_or(section.len(), |(i, _)| i)
        });
    let row = re(r"(?m)^\s*([0-9]+)\s+([A-Za-z]?[0-9]{5,6})\s+");
    row.captures_iter(&section[..end])
        .filter(|c| c[1].parse::<usize>().unwrap_or(usize::MAX) <= limit)
        .map(|c| c[2].trim_start_matches(['A', 'a']).to_owned())
        .collect()
}
pub fn select_disclosed_holdings(holdings: &Value, text: &str, limit: usize) -> Value {
    let codes = extract_top_holding_bare_codes(text, limit);
    if codes.is_empty() {
        return json!(list(holdings).iter().take(limit).collect::<Vec<_>>());
    }
    json!(
        list(holdings)
            .iter()
            .filter(|row| codes.contains(
                s(&row["code"])
                    .split('.')
                    .next()
                    .unwrap_or("")
                    .trim_start_matches(['A', 'a'])
            ))
            .collect::<Vec<_>>()
    )
}
pub fn normalize_position_periods(periods: &Value) -> Value {
    let mut by_date = serde_json::Map::new();
    let valid = re(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
    for period in list(periods) {
        let date = s(&period["updateDate"])
            .chars()
            .take(10)
            .collect::<String>();
        if !valid.is_match(&date) || by_date.contains_key(&date) {
            continue;
        }
        let holdings=list(&period["data"]).iter().filter_map(|row|{if !row.is_array()||list(row).len()<4{return None;}let code=s(&row[0]).trim().to_owned();let name=s(&row[1]).trim().to_owned();if code.is_empty()||name.is_empty(){return None;}Some(json!({"code":code,"name":name,"weightPct":n(&row[2]).unwrap_or(0.0),"shares":n(&row[3]).unwrap_or(0.0)}))}).collect::<Vec<_>>();
        by_date.insert(date.clone(), json!({"reportDate":date,"holdings":holdings}));
    }
    Value::Object(by_date)
}
fn action(
    current: Option<&Value>,
    previous: Option<&Value>,
    current_shares: f64,
    previous_shares: f64,
    threshold: f64,
) -> (&'static str, &'static str, Value) {
    let Some(previous) = previous else {
        return ("entered_top", "新进前十大", Value::Null);
    };
    let Some(current) = current else {
        return ("exited_top", "退出前十大", Value::Null);
    };
    let shares = n(&previous["shares"]).unwrap_or(0.0);
    if current_shares <= 0.0 || previous_shares <= 0.0 || shares <= 0.0 {
        return ("unknown", "无法判断（缺少全基金份额）", Value::Null);
    }
    let change = ((n(&current["shares"]).unwrap_or(0.0) / current_shares)
        / (shares / previous_shares)
        - 1.0)
        * 100.0;
    let (code, label) = if change > threshold {
        ("increased", "加仓")
    } else if change < -threshold {
        ("decreased", "减仓")
    } else {
        ("unchanged", "基本持平")
    };
    (code, label, round(change))
}
fn assessment(action: &str, returns: Option<f64>, threshold: f64) -> &'static str {
    let Some(returns) = returns else {
        return "证据不足";
    };
    if action == "unknown" {
        return "证据不足";
    }
    if returns.abs() < threshold || action == "unchanged" {
        return "中性";
    }
    if ["increased", "entered_top"].contains(&action) {
        return if returns > 0.0 {
            "短期正确"
        } else {
            "短期错误"
        };
    }
    if ["decreased", "exited_top"].contains(&action) {
        return if returns < 0.0 {
            "短期正确"
        } else {
            "短期错误"
        };
    }
    "中性"
}
pub fn analyze_position_changes(options: &Value) -> Value {
    let current = list(&options["currentHoldings"]);
    let previous = list(&options["previousHoldings"]);
    let mut codes = Vec::new();
    let mut seen = HashSet::new();
    for item in current.iter().chain(previous) {
        let code = s(&item["code"]);
        if seen.insert(code.clone()) {
            codes.push(code);
        }
    }
    let mut rows=codes.into_iter().map(|code|{let c=current.iter().rev().find(|v|s(&v["code"])==code);let p=previous.iter().rev().find(|v|s(&v["code"])==code);let (action_code,label,change)=action(c,p,n(&options["currentFundShares"]).unwrap_or(0.0),n(&options["previousFundShares"]).unwrap_or(0.0),n(&options["actionThresholdPct"]).unwrap_or(10.0));let cw=c.and_then(|v|n(&v["weightPct"])).unwrap_or(0.0);let pw=p.and_then(|v|n(&v["weightPct"])).unwrap_or(0.0);let returns=&options["returnsByCode"][&code];let period=n(&returns["periodReturnPct"]);let post=n(&returns["postReportReturnPct"]);json!({"code":code,"name":c.or(p).map(|v|v["name"].clone()).unwrap_or_else(||json!(code)),"action":label,"actionCode":action_code,"perFundShareChangePct":change,"previousWeightPct":pw,"currentWeightPct":cw,"periodReturnPct":period,"postReportReturnPct":post,"estimatedContributionPct":period.map_or(Value::Null,|v|round((cw+pw)/2.0*v/100.0)),"shortTermAssessment":assessment(action_code,post,n(&options["assessmentThresholdPct"]).unwrap_or(3.0))})}).collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        n(&b["currentWeightPct"])
            .unwrap_or(0.0)
            .total_cmp(&n(&a["currentWeightPct"]).unwrap_or(0.0))
            .then_with(|| {
                n(&b["previousWeightPct"])
                    .unwrap_or(0.0)
                    .total_cmp(&n(&a["previousWeightPct"]).unwrap_or(0.0))
            })
    });
    json!(rows)
}
fn points(rows: &Value) -> Vec<(String, f64)> {
    let mut points = list(rows)
        .iter()
        .filter_map(|row| {
            if !row.is_array() || list(row).len() < 2 {
                return None;
            }
            let ts = n(&row[0])?;
            let close = n(&row[1])?;
            if close <= 0.0 {
                return None;
            }
            let time = DateTime::<Utc>::from_timestamp_millis(ts as i64)?;
            Some((time.date_naive().to_string(), close))
        })
        .collect::<Vec<_>>();
    points.sort_by(|a, b| a.0.cmp(&b.0));
    points
}
pub fn return_between_klines(rows: &Value, start: &str, end: &str) -> Value {
    let p = points(rows);
    let a = p.iter().rfind(|(date, _)| date.as_str() <= start);
    let b = p.iter().rfind(|(date, _)| date.as_str() <= end);
    match (a, b) {
        (Some(a), Some(b)) => round((b.1 / a.1 - 1.0) * 100.0),
        _ => Value::Null,
    }
}
pub fn build_output_filename(name: &str, code: &str, date: &str) -> Result<String> {
    let clean = re(r#"[\\/:*?"<>|]"#).replace_all(name, "-").to_string();
    let clean = re(r"\s+").replace_all(&clean, " ").trim().to_owned();
    Ok(format!("{clean}-{code}-{}.md", quarter_id(date)?))
}
pub fn aggregate_current_fund_holdings(evidences: &Value) -> Value {
    let mut holdings: BTreeMap<String, Value> = BTreeMap::new();
    for evidence in list(evidences) {
        let fund = &evidence["fund"];
        let mut seen = HashSet::new();
        for position in list(&evidence["positions"]["current"]) {
            let code = s(&position["code"]).trim().to_owned();
            if code.is_empty() || !seen.insert(code.clone()) {
                continue;
            }
            let item=holdings.entry(code.clone()).or_insert_with(||{let name=s(&position["name"]).trim().to_owned();json!({"code":code,"name":if name.is_empty(){code.clone()}else{name},"fundCount":0,"totalWeightPct":0,"averageWeightPct":0,"maxWeightPct":0,"funds":[]})});
            let weight = n(&position["weightPct"]).unwrap_or(0.0);
            item["fundCount"] = json!(n(&item["fundCount"]).unwrap_or(0.0) + 1.0);
            item["totalWeightPct"] = json!(n(&item["totalWeightPct"]).unwrap_or(0.0) + weight);
            item["maxWeightPct"] = json!(n(&item["maxWeightPct"]).unwrap_or(0.0).max(weight));
            let name = if fund["name"].is_null() {
                s(&fund["code"])
            } else {
                s(&fund["name"])
            };
            item["funds"].as_array_mut().unwrap().push(json!({"code":s(&fund["code"]),"name":name,"rank":n(&fund["rank"]),"weightPct":weight}));
        }
    }
    let mut rows = holdings
        .into_values()
        .map(|mut v| {
            let total = n(&v["totalWeightPct"]).unwrap_or(0.0);
            v["totalWeightPct"] = round(total);
            v["averageWeightPct"] = round(total / n(&v["fundCount"]).unwrap_or(1.0));
            v["maxWeightPct"] = round(n(&v["maxWeightPct"]).unwrap_or(0.0));
            v["funds"].as_array_mut().unwrap().sort_by(|a, b| {
                n(&b["weightPct"])
                    .unwrap_or(0.0)
                    .total_cmp(&n(&a["weightPct"]).unwrap_or(0.0))
                    .then_with(|| {
                        n(&a["rank"])
                            .unwrap_or(f64::INFINITY)
                            .total_cmp(&n(&b["rank"]).unwrap_or(f64::INFINITY))
                    })
            });
            v
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        n(&b["fundCount"])
            .unwrap_or(0.0)
            .total_cmp(&n(&a["fundCount"]).unwrap_or(0.0))
            .then_with(|| {
                n(&b["totalWeightPct"])
                    .unwrap_or(0.0)
                    .total_cmp(&n(&a["totalWeightPct"]).unwrap_or(0.0))
            })
            .then_with(|| s(&a["code"]).cmp(&s(&b["code"])))
    });
    json!(rows)
}
pub fn build_holding_market_snapshot(rows: &Value, as_of: &str, periods: &Value) -> Value {
    let latest = points(rows)
        .into_iter()
        .rfind(|(date, _)| date.as_str() <= as_of);
    let mut performance = serde_json::Map::new();
    for period in list(periods) {
        performance.insert(
            s(&period["key"]),
            latest.as_ref().map_or(Value::Null, |(date, _)| {
                return_between_klines(rows, &s(&period["startDate"]), date)
            }),
        );
    }
    json!({"price":latest.as_ref().map(|(_,price)|price),"priceDate":latest.map(|(date,_)|date).unwrap_or_default(),"performance":performance})
}
fn average(values: &[f64]) -> Value {
    if values.is_empty() {
        Value::Null
    } else {
        round(values.iter().sum::<f64>() / values.len() as f64)
    }
}
pub fn aggregate_report_forecasts(reports: &Value, options: &Value) -> Value {
    #[derive(Default)]
    struct Group {
        keys: HashSet<String>,
        revenue: Vec<f64>,
        profit: Vec<f64>,
        eps: Vec<f64>,
        pe: Vec<f64>,
    }
    let years = options["years"]
        .as_array()
        .map(|v| v.iter().filter_map(n).collect::<Vec<_>>());
    let mut groups: BTreeMap<i32, Group> = BTreeMap::new();
    for report in list(reports) {
        let key = if !report["infoCode"].is_null() {
            s(&report["infoCode"])
        } else if !report["url"].is_null() {
            s(&report["url"])
        } else {
            s(&report["title"])
        };
        for f in list(&report["forecasts"]) {
            let Some(year) = n(&f["year"]) else {
                continue;
            };
            if year.fract() != 0.0
                || years.as_ref().is_some_and(|v| !v.contains(&year))
                || years.is_none() && year < n(&options["minYear"]).unwrap_or(f64::NEG_INFINITY)
            {
                continue;
            }
            let g = groups.entry(year as i32).or_default();
            if !key.is_empty() {
                g.keys.insert(key.clone());
            }
            for (field, out) in [
                ("revenue", &mut g.revenue),
                ("netProfit", &mut g.profit),
                ("eps", &mut g.eps),
                ("pe", &mut g.pe),
            ] {
                if let Some(v) = n(&f[field]).filter(|v| *v > 0.0) {
                    out.push(v);
                }
            }
        }
    }
    let max = years.as_ref().map_or_else(
        || n(&options["maxYears"]).map_or(usize::MAX, |n| n as usize),
        Vec::len,
    );
    let cap = n(&options["marketCapYi"]).unwrap_or(0.0);
    let price = n(&options["currentPrice"]).unwrap_or(0.0);
    let mut out=groups.into_iter().take(max).map(|(year,g)|{let revenue=average(&g.revenue);let profit=average(&g.profit);let eps=average(&g.eps);let pe=if cap>0.0&&n(&profit).unwrap_or(0.0)>0.0{round(cap/n(&profit).unwrap())}else if price>0.0&&n(&eps).unwrap_or(0.0)>0.0{round(price/n(&eps).unwrap())}else{Value::Null};json!({"year":year,"revenueYi":revenue,"netProfitYi":profit,"eps":eps,"pe":pe,"reportedPe":average(&g.pe),"sampleCount":g.keys.len(),"revenueSampleCount":g.revenue.len(),"netProfitSampleCount":g.profit.len()})}).collect::<Vec<_>>();
    for i in 0..out.len() {
        for (value, key) in [
            ("revenueYi", "revenueGrowthPct"),
            ("netProfitYi", "netProfitGrowthPct"),
        ] {
            let current = n(&out[i][value]);
            let prior = if i > 0 { n(&out[i - 1][value]) } else { None };
            out[i][key] = match (current, prior) {
                (Some(c), Some(p)) if c > 0.0 && p > 0.0 => round((c / p - 1.0) * 100.0),
                _ => Value::Null,
            };
        }
    }
    json!(out)
}
pub fn render_prompt(template: &str, values: &Value) -> Result<String> {
    let mut out = template.to_owned();
    if let Some(values) = values.as_object() {
        for (key, value) in values {
            out = out.replace(&format!("{{{{{key}}}}}"), &s(value));
        }
    }
    let unresolved = re(r"\{\{([A-Z0-9_]+)\}\}")
        .captures_iter(&out)
        .map(|c| c[1].to_owned())
        .collect::<HashSet<_>>();
    if !unresolved.is_empty() {
        bail!(
            "unresolved prompt placeholders: {}",
            unresolved.into_iter().collect::<Vec<_>>().join(", ")
        );
    }
    Ok(out)
}
pub fn strip_markdown_fence(value: &str) -> String {
    let text = value.trim();
    re(r"(?is)^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$")
        .captures(text)
        .map_or_else(|| text.to_owned(), |c| c[1].trim().to_owned())
}
pub fn validate_generated_report(text: &str, fund: &Value) -> Result<String> {
    let text = text.trim();
    let code = s(&fund["code"]);
    if !text.starts_with("# ") {
        bail!("LLM report for {code} is missing a Markdown title");
    }
    let name = s(&fund["name"]);
    let base = s(&fund["baseName"]);
    if !text.contains(&code) || !(text.contains(&name) || !base.is_empty() && text.contains(&base))
    {
        bail!("LLM report for {code} is missing fund identity");
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn equivalent(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(k, v)| b.get(k).is_some_and(|b| equivalent(v, b)))
            }
            _ => a == b,
        }
    }
    #[test]
    fn original_javascript_domain_goldens() {
        let fixtures: Value = serde_json::from_str(include_str!("domain/fixtures.json")).unwrap();
        for (index, case) in list(&fixtures).iter().enumerate() {
            let a = &case["args"];
            let text = |i: usize| s(&a[i]);
            let actual = match s(&case["op"]).as_str() {
                "latestQuarterlyReportDate" => {
                    json!(latest_quarterly_report_date(&text(0)).unwrap())
                }
                "previousReportDate" => json!(previous_report_date(&text(0)).unwrap()),
                "quarterId" => json!(quarter_id(&text(0)).unwrap()),
                "parseFundRankRows" => parse_fund_rank_rows(&a[0]),
                "dedupeFundShareClasses" => dedupe_fund_share_classes(&a[0], &a[1]),
                "findFundReportNotice" => find_fund_report_notice(&a[0], &text(1), &text(2)),
                "mapNotice" => map_notice(&a[0], &text(1)),
                "parseFundTotalShares" => parse_fund_total_shares(&text(0)),
                "extractManagementDiscussion" => json!(extract_management_discussion(
                    &text(0),
                    a[1].as_u64().unwrap() as usize
                )),
                "selectDisclosedHoldings" => {
                    select_disclosed_holdings(&a[0], &text(1), a[2].as_u64().unwrap() as usize)
                }
                "normalizePositionPeriods" => normalize_position_periods(&a[0]),
                "analyzePositionChanges" => analyze_position_changes(&a[0]),
                "returnBetweenKlines" => return_between_klines(&a[0], &text(1), &text(2)),
                "buildHoldingMarketSnapshot" => {
                    build_holding_market_snapshot(&a[0], &text(1), &a[2])
                }
                "buildOutputFilename" => {
                    json!(build_output_filename(&text(0), &text(1), &text(2)).unwrap())
                }
                "aggregateCurrentFundHoldings" => aggregate_current_fund_holdings(&a[0]),
                "aggregateReportForecasts" => aggregate_report_forecasts(&a[0], &a[1]),
                op => panic!("unknown fixture op {op}"),
            };
            assert!(
                equivalent(&actual, &case["expected"]),
                "fixture {index} {}\nactual={actual}\nexpected={}",
                case["op"],
                case["expected"]
            );
        }
    }
    #[test]
    fn identity_and_template_validation_are_fail_closed() {
        assert!(
            validate_generated_report("# 错误 000002", &json!({"code":"000001","name":"基金"}))
                .is_err()
        );
        assert!(
            validate_generated_report("# 基金 000001", &json!({"code":"000001","name":"基金"}))
                .is_ok()
        );
        assert!(render_prompt("{{UNKNOWN}}", &json!({})).is_err());
        assert_eq!(strip_markdown_fence("```markdown\n# 基金\n```"), "# 基金");
        assert!(previous_report_date("2026-12-31").is_err());
    }
}
