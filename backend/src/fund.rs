//! Local fund APIs, with Eastmoney-only NAV history and original HTML contracts.
use crate::{ApiResult, AppState, cache_policy, codes, http::parse_json_or_jsonp, market, ok};
use anyhow::{Result, bail};
use axum::{
    Router,
    extract::{Query, State},
    routing::get,
};
use chrono::{Datelike, Duration, Local, Utc};
use regex::Regex;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER, USER_AGENT},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

type Params = HashMap<String, String>;
const DEFAULT_REFERER: &str = "https://fundf10.eastmoney.com/";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/fund/info", get(info))
        .route("/fund/position", get(position))
        .route("/fund/asset-allocation", get(allocation))
        .route("/fund/share-change", get(share_change))
        .route("/fund/notices", get(notices))
        .route("/fund/constituents", get(constituents))
        .route("/fund/rank", get(rank))
        .route("/fund/companies", get(companies))
        .route("/fund/compare", get(compare))
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("constant fund parser regex")
}
fn capture(text: &str, pattern: &str) -> String {
    re(pattern)
        .captures(text)
        .and_then(|m| m.get(1))
        .map(|m| m.as_str().trim().to_owned())
        .unwrap_or_default()
}
fn strip_tags(text: &str) -> String {
    let no_script = re(r"(?is)<script\b[^>]*>.*?</script>").replace_all(text, "");
    let no_style = re(r"(?is)<style\b[^>]*>.*?</style>").replace_all(&no_script, "");
    re(r"<[^>]+>")
        .replace_all(&no_style, "")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}
fn text(text: &str) -> String {
    strip_tags(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn match_date(text: &str) -> String {
    if let Some(date) = re(r"\d{4}-\d{2}-\d{2}").find(text) {
        return date.as_str().to_owned();
    }
    re(r"(\d{4})年(\d{2})月(\d{2})日")
        .captures(text)
        .map(|m| format!("{}-{}-{}", &m[1], &m[2], &m[3]))
        .unwrap_or_default()
}
fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        value => value.to_string(),
    }
}
fn nullable_number(text: &str) -> Option<f64> {
    let text = text.replace([',', '%'], "");
    let text = text.trim();
    if text.is_empty() || text == "---" || text == "-" {
        return None;
    }
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn num(value: &Value) -> f64 {
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .or_else(|| value.as_str().and_then(nullable_number))
        .unwrap_or(0.0)
}
fn positive_int(value: Option<&String>, fallback: usize) -> usize {
    value
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as usize)
        .unwrap_or(fallback)
}
// Match ECMAScript toFixed(2) on the exact binary input. Multiplication by
// 100 before rounding would change cases such as 1.005 and 2.675.
fn fixed2(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-Infinity"
        } else {
            "Infinity"
        }
        .into();
    }
    if value.abs() >= 1e21 {
        return ryu_js::Buffer::new().format_finite(value).to_string();
    }
    let bits = value.abs().to_bits();
    let encoded_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (mantissa, exponent) = if encoded_exponent == 0 {
        (u128::from(fraction), -1074)
    } else {
        (
            u128::from(fraction | (1_u64 << 52)),
            encoded_exponent - 1023 - 52,
        )
    };
    let numerator = mantissa * 100;
    let rounded = if exponent >= 0 {
        numerator << exponent as u32
    } else if -exponent >= 128 {
        0
    } else {
        let shift = (-exponent) as u32;
        let quotient = numerator >> shift;
        let remainder = numerator & ((1_u128 << shift) - 1);
        quotient + u128::from(remainder >= (1_u128 << (shift - 1)))
    };
    format!(
        "{}{}.{:02}",
        if value < 0.0 { "-" } else { "" },
        rounded / 100,
        rounded % 100
    )
}
fn bare(code: &str) -> &str {
    code.trim().split('.').next().unwrap_or("")
}
fn normalize_compare(code: &str) -> Option<String> {
    let code = code.trim().to_uppercase();
    re(r"^\d{6}(?:\.(?:OF|SH|SZ))?$")
        .is_match(&code)
        .then(|| format!("{}.OF", bare(&code)))
}
fn rows(html: &str, include_headers: bool) -> Vec<Vec<String>> {
    let cell_re = if include_headers {
        re(r"(?is)<(?:th|td)\b[^>]*>(.*?)</(?:th|td)>")
    } else {
        re(r"(?is)<td\b[^>]*>(.*?)</td>")
    };
    re(r"(?is)<tr\b[^>]*>(.*?)</tr>")
        .captures_iter(html)
        .map(|row| {
            cell_re
                .captures_iter(&row[1])
                .map(|c| text(&c[1]))
                .collect()
        })
        .collect()
}
fn archives_content(raw: &str) -> String {
    let mut text = raw.trim().trim_end_matches(';').trim();
    // Some cached/provider variants are already HTML. An attribute '=' is
    // not a JavaScript assignment and must not discard the first holdings box.
    if text.starts_with('<') {
        return text.to_owned();
    }
    let content = capture(text, r#"(?s)content:"(.*?)",\s*arryear:"#);
    if !content.is_empty() {
        return content.replace("\\\"", "\"").replace("\\/", "/");
    }
    if let Some(equal) = text.find('=') {
        text = text[equal + 1..].trim().trim_end_matches(';').trim();
    }
    if (text.starts_with('"') && text.ends_with('"'))
        || (text.starts_with('\'') && text.ends_with('\''))
    {
        return text[1..text.len() - 1].to_owned();
    }
    text.to_owned()
}

async fn fetch_text(state: &AppState, url: &str, referer: &str) -> Result<String> {
    let mut headers = HeaderMap::new();
    headers.insert(REFERER, HeaderValue::from_str(referer)?);
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"));
    state
        .http
        .cached_text(&state.db, url, headers, 86_400_000, false)
        .await
}

async fn info(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(
        fetch_info(&state, market::required(&query, "code")?).await?
    ))
}
async fn position(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(json!(
        fetch_position(
            &state,
            market::required(&query, "code")?,
            positive_int(query.get("num"), 2)
        )
        .await?
    )))
}
async fn allocation(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(fetch_allocation(
        &state,
        market::required(&query, "code")?,
    )
    .await?))
}
async fn share_change(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = bare(market::required(&query, "code")?);
    let mut url = Url::parse("https://fundf10.eastmoney.com/FundArchivesDatas.aspx")
        .map_err(anyhow::Error::from)?;
    url.query_pairs_mut().extend_pairs([
        ("type", "gmbd"),
        ("mode", "0"),
        ("code", code),
        ("rt", "0.1"),
    ]);
    let raw = fetch_text(&state, url.as_str(), DEFAULT_REFERER).await?;
    Ok(ok(json!(parse_share_change(&archives_content(&raw)))))
}
async fn notices(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = bare(market::required(&query, "code")?);
    let page = positive_int(query.get("page"), 1).min(10_000);
    let page_size = positive_int(query.get("pageSize"), 20).min(100);
    let category = query
        .get("category")
        .map(|s| s.trim())
        .filter(|s| re(r"^[0-6]$").is_match(s))
        .unwrap_or("0");
    let mut url =
        Url::parse("https://api.fund.eastmoney.com/f10/JJGG").map_err(anyhow::Error::from)?;
    url.query_pairs_mut().extend_pairs([
        ("fundcode", code),
        ("pageIndex", &page.to_string()),
        ("pageSize", &page_size.to_string()),
        ("type", category),
    ]);
    let body = parse_json_or_jsonp(&fetch_text(&state, url.as_str(), DEFAULT_REFERER).await?)?;
    Ok(ok(parse_notices(&body, code, page, page_size)?))
}
async fn constituents(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let code = bare(market::required(&query, "code")?);
    let result = fetch_constituents(&state, code).await;
    Ok(ok(match result {
        Ok(value) => value,
        Err(error) => {
            json!({"tradeDate":"","navPerCreationUnit":"","unitNav":"","recordCount":0,"rows":[],"sourceError":error.to_string()})
        }
    }))
}
async fn rank(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    Ok(ok(fetch_rank(&state, &query).await?))
}
async fn companies(State(state): State<AppState>) -> ApiResult {
    let raw = fetch_text(
        &state,
        "https://fund.eastmoney.com/js/jjjz_gs.js?v=0.1",
        "https://fund.eastmoney.com/",
    )
    .await?;
    let value = match (raw.find('['), raw.rfind(']')) {
        (Some(start), Some(end)) if end > start => {
            serde_json::from_str(&raw[start..=end]).map_err(anyhow::Error::from)?
        }
        _ => json!([]),
    };
    Ok(ok(value))
}

pub fn parse_info(html: &str, code: &str, today: &str) -> Value {
    let all = text(html);
    let mut info = json!({"name":text(&capture(html,r#"(?is)<div\b[^>]*class=["']fundDetail-tit["'][^>]*>(.*?)</div>"#)),"manager":"","company":"","beginDate":"","updateDate":"","style":"","scale":""});
    for cells in rows(html, true) {
        for pair in cells.as_chunks::<2>().0 {
            let key = pair[0].trim_end_matches(['：', ':']).trim();
            let value = pair[1].trim_end_matches(['：', ':']).trim();
            match key {
                "基金简称" if info["name"] == "" => info["name"] = json!(value),
                "基金经理人" | "基金经理" => info["manager"] = json!(value),
                "基金管理人" => info["company"] = json!(value),
                "成立日期/规模" => info["beginDate"] = json!(match_date(value)),
                "基金类型" => info["style"] = json!(value),
                "净资产规模" => {
                    let scale = capture(value, r"(\d+(?:\.\d+)?)\s*亿");
                    info["scale"] = json!(if scale.is_empty() {
                        value.to_owned()
                    } else {
                        scale
                    });
                    let date = match_date(value);
                    if !date.is_empty() {
                        info["updateDate"] = json!(date);
                    }
                }
                _ => {}
            }
        }
    }
    if info["name"] == "" {
        let name = capture(&all, r"基金简称\s+([^\s]+)");
        info["name"] = json!(if name.is_empty() {
            code.to_owned()
        } else {
            name
        });
    }
    if info["updateDate"] == "" {
        let date = match_date(&all);
        info["updateDate"] = json!(if date.is_empty() {
            today.to_owned()
        } else {
            date
        });
    }
    info
}
pub async fn fetch_info(state: &AppState, code: &str) -> Result<Value> {
    let code = bare(code);
    let html = fetch_text(
        state,
        &format!("https://fundf10.eastmoney.com/jbgk_{code}.html"),
        DEFAULT_REFERER,
    )
    .await?;
    Ok(parse_info(
        &html,
        code,
        &Utc::now().date_naive().to_string(),
    ))
}
pub fn parse_allocation(html: &str) -> Vec<Value> {
    let table = re(r"(?is)<table\b[^>]*>(.*?)</table>")
        .captures_iter(html)
        .map(|m| m[1].to_owned())
        .find(|table| {
            let t = text(table);
            t.contains("报告期") && t.contains("股票占净比") && t.contains("净资产")
        });
    let Some(table) = table else { return vec![] };
    let mut result: Vec<Value>=rows(&table,true).into_iter().filter(|cells|cells.len()>=5 && re(r"^\d{4}-\d{2}-\d{2}$").is_match(&cells[0])).map(|c|json!({"reportDate":c[0],"stockPct":nullable_number(&c[1]),"bondPct":nullable_number(&c[2]),"cashPct":nullable_number(&c[3]),"netAssetsBillion":nullable_number(&c[4])})).collect();
    result.sort_by(|a, b| b["reportDate"].as_str().cmp(&a["reportDate"].as_str()));
    result
}
pub async fn fetch_allocation(state: &AppState, code: &str) -> Result<Value> {
    let code = bare(code);
    let html = fetch_text(
        state,
        &format!("https://fundf10.eastmoney.com/zcpz_{code}.html"),
        DEFAULT_REFERER,
    )
    .await?;
    Ok(json!({"code":format!("{code}.OF"),"source":"eastmoney","rows":parse_allocation(&html)}))
}
fn holding_code(code: &str, name: &str) -> String {
    let code = code.trim().to_uppercase();
    let code = code.strip_prefix('A').unwrap_or(&code);
    let lower = name.to_lowercase();
    if ["005930", "000660", "042700"].contains(&code)
        || ["samsung", "sk hynix", "hanmi"]
            .iter()
            .any(|n| lower.contains(n))
        || name.contains("三星")
        || name.contains("海力士")
    {
        format!("{code}.KS")
    } else {
        codes::normalize(code)
    }
}
pub fn parse_positions(raw: &str) -> Vec<Value> {
    let content = archives_content(raw);
    let positions: Vec<_> = re(r#"(?is)<div\b[^>]*class=["'][^"']*boxitem[^"']*["'][^>]*>"#)
        .find_iter(&content)
        .map(|m| (m.start(), m.end()))
        .collect();
    let mut result = Vec::new();
    for (index, (_, start)) in positions.iter().enumerate() {
        let end = positions
            .get(index + 1)
            .map(|p| p.0)
            .unwrap_or(content.len());
        let html = &content[*start..end];
        let date = re(r"(?is)<label\b[^>]*>(.*?)</label>")
            .captures_iter(html)
            .map(|m| match_date(&text(&m[1])))
            .find(|date| !date.is_empty())
            .unwrap_or_default();
        if date.is_empty() {
            continue;
        }
        let data: Vec<_> = rows(html, false)
            .into_iter()
            .filter(|c| c.len() >= 6)
            .filter_map(|c| {
                let code = holding_code(&c[1], &c[2]);
                if code.is_empty() || c[2].is_empty() {
                    return None;
                }
                let (ratio, shares) = if c.len() > 7 { (6, 7) } else { (4, 5) };
                Some(json!([
                    code,
                    c[2],
                    nullable_number(&c[ratio]).unwrap_or(0.0),
                    nullable_number(&c[shares]).unwrap_or(0.0)
                ]))
            })
            .collect();
        result.push(json!({"updateDate":date,"data":data}));
    }
    result
}
pub async fn fetch_position(state: &AppState, code: &str, count: usize) -> Result<Vec<Value>> {
    let code = bare(code);
    let now = Local::now();
    let start = now.year() - i32::from(now.month() < 4);
    let mut result = Vec::new();
    for year in [start, start - 1] {
        let mut url = Url::parse("https://fundf10.eastmoney.com/FundArchivesDatas.aspx")?;
        url.query_pairs_mut().extend_pairs([
            ("type", "jjcc"),
            ("code", code),
            ("topline", "20"),
            ("year", &year.to_string()),
            ("month", ""),
            ("rt", "0.1"),
        ]);
        result.extend(parse_positions(
            &fetch_text(state, url.as_str(), DEFAULT_REFERER).await?,
        ));
    }
    result.sort_by(|a, b| b["updateDate"].as_str().cmp(&a["updateDate"].as_str()));
    let mut seen = HashSet::new();
    result.retain(|r| seen.insert(r["updateDate"].clone().to_string()));
    result.truncate(count);
    for row in &mut result {
        row["sourceCode"] = json!(format!("{code}.OF"));
        row["sourceName"] = json!("");
        row["sourceKind"] = json!("fund");
    }
    Ok(result)
}
pub fn parse_share_change(html: &str) -> Vec<Value> {
    let rows: Vec<_> = rows(html, false)
        .into_iter()
        .filter(|c| c.len() >= 6)
        .collect();
    rows.iter().enumerate().map(|(idx,c)|{let total=nullable_number(&c[3]).unwrap_or(0.0);let prev=rows.get(idx+1).and_then(|p|nullable_number(&p[3])).unwrap_or(0.0);json!({"date":c[0],"purchase":c[1],"redeem":c[2],"totalShare":c[3],"netAsset":c[4],"change":c[5],"shareChange":if prev>0.0{json!(fixed2((total/prev-1.0)*100.0))}else{json!(0)}})}).collect()
}
fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub fn parse_notices(body: &Value, code: &str, page: usize, page_size: usize) -> Result<Value> {
    if !body["ErrCode"].is_number() || body["ErrCode"].as_f64() != Some(0.0) {
        bail!(
            "eastmoney fund notices error: code={} msg={}",
            body.get("ErrCode")
                .map(value_text)
                .unwrap_or_else(|| "unknown".into()),
            value_text(&body["ErrMsg"])
        );
    }
    let rows:Vec<_>=body["Data"].as_array().into_iter().flatten().filter_map(|item|{let id=value_text(&item["ID"]).trim().to_owned();let title=value_text(&item["TITLE"]).trim().to_owned();if id.is_empty()||title.is_empty(){return None;}let item_code=item.get("FUNDCODE").map(value_text).filter(|s|!s.trim().is_empty()).unwrap_or_else(||code.into());let item_code=item_code.trim();let escaped=encode_component(&id);Some(json!({"id":id,"fundCode":item_code,"title":title,"category":value_text(&item["NEWCATEGORY"]).trim(),"publishDate":value_text(&item["PUBLISHDATEDesc"]).chars().take(10).collect::<String>(),"detailUrl":format!("https://fund.eastmoney.com/gonggao/{},{}.html",encode_component(item_code),escaped),"pdfUrl":if item["ATTACHTYPE"]=="0"{format!("https://pdf.dfcfw.com/pdf/H2_{escaped}_1.pdf")}else{String::new()}}))}).collect();
    Ok(
        json!({"rows":rows,"totalCount":num(&body["TotalCount"]),"page":body.get("PageIndex").map(num).unwrap_or(page as f64),"pageSize":body.get("PageSize").map(num).unwrap_or(page_size as f64)}),
    )
}
fn clean_money(value: &Value) -> String {
    value_text(value)
        .replacen('￥', "", 1)
        .replace(',', "")
        .trim()
        .to_owned()
}
fn sse_date(date: &str) -> String {
    if re(r"^\d{8}$").is_match(date) {
        format!("{}-{}-{}", &date[..4], &date[4..6], &date[6..8])
    } else {
        date.into()
    }
}
async fn sse_json(state: &AppState, code: &str, page: Option<usize>) -> Result<Value> {
    let mut url = Url::parse("https://query.sse.com.cn/commonQuery.do")?;
    url.query_pairs_mut().extend_pairs([
        (
            "jsonCallBack",
            if page.is_some() {
                "jsonpCallbackLicaiFundConstituents"
            } else {
                "jsonpCallbackLicaiFundOverview"
            },
        ),
        (
            "isPagination",
            if page.is_some() { "true" } else { "false" },
        ),
        ("FUNDID2", code),
        (
            "sqlId",
            if page.is_some() {
                "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C"
            } else {
                "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C"
            },
        ),
    ]);
    if let Some(page) = page {
        let page = page.to_string();
        url.query_pairs_mut().extend_pairs([
            ("pageHelp.pageSize", "10"),
            ("pageHelp.cacheSize", "1"),
            ("pageHelp.pageNo", &page),
            ("pageHelp.beginPage", &page),
            ("pageHelp.endPage", &page),
        ]);
    }
    parse_json_or_jsonp(&fetch_text(state, url.as_str(), "https://www.sse.com.cn/").await?)
}
pub fn project_constituents(overview: &Value, rows: &[Value]) -> Value {
    json!({"tradeDate":sse_date(&value_text(&overview["TRADING_DAY"])),"navPerCreationUnit":clean_money(&overview["NAVPERCU"]),"unitNav":clean_money(&overview["NAV"]),"recordCount":num(&overview["RECORD_NUM"]),"priceSourceNote":"","rows":rows.iter().map(|r|json!({"rank":num(&r["NUM"]),"securityCode":value_text(&r["INSTRUMENT_ID"]).trim(),"securityName":value_text(&r["INSTRUMENT_NAME"]).trim(),"priceCode":null,"price":"","priceSource":null,"quantity":value_text(&r["QUANTITY"]).replace(',',""),"navPct":""})).collect::<Vec<_>>()})
}
async fn fetch_constituents(state: &AppState, code: &str) -> Result<Value> {
    let overview = sse_json(state, code, None).await?["result"]
        .as_array()
        .and_then(|rows| rows.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut page = 1;
    let mut page_count = 1;
    let mut rows = Vec::new();
    while page <= page_count && page <= 50 {
        let body = sse_json(state, code, Some(page)).await?;
        page_count = num(&body["pageHelp"]["pageCount"]).max(1.0) as usize;
        let items = body["result"]
            .as_array()
            .filter(|r| !r.is_empty())
            .or_else(|| body["pageHelp"]["data"].as_array());
        rows.extend(items.into_iter().flatten().cloned());
        page += 1;
    }
    Ok(project_constituents(&overview, &rows))
}
fn style_label(style: &str) -> &str {
    match style {
        "gp" => "股票型",
        "hh" => "混合型",
        "zq" => "债券型",
        "zs" => "指数型",
        "ct" => "场内交易",
        "qdii" => "QDII",
        "lof" => "LOF",
        "fof" => "FOF",
        _ => "",
    }
}
pub fn parse_rank(raw: &str, style: &str) -> Result<Value> {
    let section = capture(raw, r"datas:\[(.*)\],allRecords:");
    let items: Vec<String> = if section.is_empty() {
        vec![]
    } else {
        serde_json::from_str(&format!("[{section}]"))?
    };
    let rows: Vec<_> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let f: Vec<_> = item.split(',').collect();
            if f.len() < 19 {
                return None;
            }
            let mut row = vec![
                json!(index + 1),
                json!(f[0]),
                json!(format!(
                    "<a href=\"fund.html?code={}.OF\">{}</a>",
                    f[0], f[1]
                )),
            ];
            row.extend(f[3..=16].iter().map(|s| json!(s)));
            row.extend([
                json!(""),
                json!(""),
                json!(
                    f.get(24)
                        .filter(|s| !s.is_empty())
                        .copied()
                        .unwrap_or_else(|| style_label(style))
                ),
                json!(f[18]),
                json!(""),
            ]);
            Some(Value::Array(row))
        })
        .collect();
    let field = |name: &str, default: u64| {
        capture(raw, &format!("{name}:(\\d+)"))
            .parse::<u64>()
            .unwrap_or(default)
    };
    Ok(
        json!({"rows":rows,"allRecords":field("allRecords",0),"pageIndex":field("pageIndex",1),"pageNum":field("pageNum",50),"allPages":field("allPages",1)}),
    )
}
async fn fetch_rank(state: &AppState, query: &Params) -> Result<Value> {
    let get = |key: &str, default: &str| {
        query
            .get(key)
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| default.into())
    };
    let today = Utc::now().date_naive();
    let end = get("ed", &today.to_string());
    let start = get(
        "sd",
        &format!("{}-{}", Local::now().year() - 1, end.get(5..).unwrap_or("")),
    );
    let style = get("ft", "all");
    let params = [
        ("op", "ph".into()),
        ("dt", "kf".into()),
        ("ft", style.clone()),
        ("rs", "".into()),
        ("gs", get("gs", "0")),
        ("sc", get("sc", "3yzf")),
        ("st", get("st", "desc")),
        ("sd", start),
        ("ed", end),
        ("qdii", "".into()),
        ("tabSubtype", ",,,,,".into()),
        ("pi", get("pi", "1")),
        ("pn", get("pn", "50")),
        ("dx", "1".into()),
        ("v", "0.7199999265711771".into()),
    ];
    let mut url = Url::parse("https://fund.eastmoney.com/data/rankhandler.aspx")?;
    url.query_pairs_mut().extend_pairs(params);
    parse_rank(
        &fetch_text(
            state,
            url.as_str(),
            "https://fund.eastmoney.com/data/fundranking.html",
        )
        .await?,
        &style,
    )
}
async fn compare(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let mut seen = HashSet::new();
    let codes: Vec<_> = query
        .get("codes")
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .filter_map(normalize_compare)
        .filter(|code| seen.insert(code.clone()))
        .take(6)
        .collect();
    if codes.len() < 2 {
        return Ok(ok(
            json!({"rows":[],"limitation":"请提供 2–6 只基金代码进行比较。"}),
        ));
    }
    let now = Utc::now();
    let to = now.date_naive().to_string();
    let from = (now - Duration::days(366)).date_naive().to_string();
    let mut rows = Vec::new();
    for code in codes {
        // Source metadata belongs to the same snapshot decision as the NAV load.
        let snapshot = state
            .market_store()?
            .get_json(&format!("fund-nav/{code}.json"))
            .await?;
        let cached = snapshot.as_ref().is_some_and(|s| {
            s["updatedAt"].as_i64().is_some_and(|at| {
                at > 0 && now.timestamp_millis() < at + cache_policy::market_ttl(&code, at)
            }) && s["startDate"].as_str().is_some_and(|d| d <= from.as_str())
                && s["endDate"].as_str().is_some_and(|d| d >= to.as_str())
        });
        let (info, allocation, positions, nav) = tokio::try_join!(
            fetch_info(&state, &code),
            fetch_allocation(&state, &code),
            fetch_position(&state, &code, 1),
            market::load_kline(&state, &code, "forward", &from, &to)
        )?;
        let nav: Vec<_> = nav.into_iter().filter(|v| v.get("nav").is_some()).collect();
        let first = nav
            .iter()
            .find(|r| !r["accumNav"].is_null() || !r["nav"].is_null());
        let latest = nav.last();
        let first_value = first.and_then(|r| {
            crate::http::number(&r["accumNav"]).or_else(|| crate::http::number(&r["nav"]))
        });
        let latest_value = latest.and_then(|r| {
            crate::http::number(&r["accumNav"]).or_else(|| crate::http::number(&r["nav"]))
        });
        let performance = match (first_value, latest_value) {
            (Some(a), Some(b)) if a != 0.0 && b != 0.0 => {
                json!({"oneYearReturnPct":fixed2((b/a-1.0)*100.0).parse::<f64>().ok().filter(|n|n.is_finite()),"from":first.map(|r|&r["date"]),"to":latest.map(|r|&r["date"])})
            }
            _ => Value::Null,
        };
        rows.push(json!({"code":code,"info":info,"allocation":allocation["rows"].as_array().and_then(|r|r.first()),"holdingCount":positions.first().and_then(|p|p["data"].as_array()).map(Vec::len),"performance":performance,"dataHealth":{"navSource":if cached{"r2"}else{"eastmoney"},"navRows":nav.len(),"latestNavDate":latest.map(|r|&r["date"])}}));
    }
    Ok(ok(
        json!({"rows":rows,"limitation":"比较只呈现公开数据；收益未统一为同一风险基准，不能直接推导配置建议。"}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn return_and_share_rounding_matches_javascript() {
        for (value, expected) in [
            (1.005, "1.00"),
            (2.675, "2.67"),
            (0.125, "0.13"),
            (-1.005, "-1.00"),
            (-0.0001, "-0.00"),
            (1000.0, "1000.00"),
        ] {
            assert_eq!(fixed2(value), expected);
        }
        assert!(parse_notices(&json!({"ErrCode":0.0}), "000001", 1, 20).is_ok());
        assert!(parse_notices(&json!({"ErrCode":"0"}), "000001", 1, 20).is_err());
    }
    #[test]
    fn allocation_missing_is_null_and_newest_first() {
        let html = "<table><tr><th>报告期</th><th>股票占净比</th><th>债券</th><th>现金</th><th>净资产</th></tr><tr><td>2026-06-30</td><td>80.5%</td><td>---</td><td>2%</td><td>1,234.56</td></tr><tr><td>2026-09-30</td><td>-</td><td>0</td><td>1</td><td>100</td></tr></table>";
        let rows = parse_allocation(html);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["reportDate"], "2026-09-30");
        assert_eq!(rows[0]["stockPct"], Value::Null);
        assert_eq!(rows[1]["netAssetsBillion"], 1234.56);
    }
    #[test]
    fn info_and_archived_holdings_parse_chinese_dates_and_korean_identity() {
        let info = parse_info(
            "<div class='fundDetail-tit'>测试基金</div><table><tr><th>基金经理</th><td>张三</td><th>净资产规模</th><td>10.2亿（2026-09-30）</td></tr></table>",
            "000001",
            "2026-10-29",
        );
        assert_eq!(info["name"], "测试基金");
        assert_eq!(info["manager"], "张三");
        assert_eq!(info["scale"], "10.2");
        assert_eq!(info["updateDate"], "2026-09-30");
        let html = "<div class='boxitem'><label>截止日期2026年09月30日</label><table><tr><td>1</td><td>005930</td><td>三星</td><td>x</td><td>9.5%</td><td>1,000</td></tr></table></div><div class='boxitem'><label>2026-06-30</label></div>";
        let rows = parse_positions(html);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0]["data"][0],
            json!(["005930.KS", "三星", 9.5, 1000.0])
        );
        let wrapped = format!("var apidata={{content:\"{html}\", arryear:[]}};");
        assert_eq!(parse_positions(&wrapped), rows);
    }
    #[test]
    fn share_change_and_notices_preserve_shapes() {
        let changes = parse_share_change(
            "<tr><td>2026-09-30</td><td>10</td><td>5</td><td>120</td><td>1</td><td>2</td></tr><tr><td>2026-06-30</td><td>10</td><td>5</td><td>100</td><td>1</td><td>2</td></tr>",
        );
        assert_eq!(changes[0]["shareChange"], "20.00");
        assert_eq!(changes[1]["shareChange"], 0);
        assert!(parse_notices(&json!({"ErrCode":1}), "000001", 1, 20).is_err());
        let parsed=parse_notices(&json!({"ErrCode":0,"Data":[{"ID":"abc/1","TITLE":" 季报 ","ATTACHTYPE":"0","PUBLISHDATEDesc":"2026-10-29 12:00"}]}),"000001",2,20).unwrap();
        assert_eq!(parsed["rows"][0]["publishDate"], "2026-10-29");
        assert!(
            parsed["rows"][0]["pdfUrl"]
                .as_str()
                .unwrap()
                .contains("abc%2F1")
        );
        assert_eq!(parsed["page"], 2.0);
    }
    #[test]
    fn constituents_do_not_invent_market_prices() {
        let value = project_constituents(
            &json!({"TRADING_DAY":"20261029","NAV":"￥1,234.5","RECORD_NUM":1}),
            &[
                json!({"NUM":1,"INSTRUMENT_ID":"600036","INSTRUMENT_NAME":"招商银行","QUANTITY":"1,000"}),
            ],
        );
        assert_eq!(value["tradeDate"], "2026-10-29");
        assert_eq!(value["unitNav"], "1234.5");
        assert_eq!(value["rows"][0]["priceCode"], Value::Null);
        assert_eq!(value["rows"][0]["price"], "");
        assert_eq!(value["rows"][0]["quantity"], "1000");
    }
    #[test]
    fn rank_and_compare_filters_preserve_existing_contract() {
        let mut fields = (0..25).map(|n| n.to_string()).collect::<Vec<_>>();
        fields[0] = "000001".into();
        fields[1] = "基金".into();
        let raw = format!(
            "var rankData={{datas:[{}],allRecords:2,pageIndex:1,pageNum:50,allPages:1}}",
            serde_json::to_string(&fields.join(",")).unwrap()
        );
        let value = parse_rank(&raw, "hh").unwrap();
        assert_eq!(value["rows"][0].as_array().unwrap().len(), 22);
        assert_eq!(value["rows"][0][1], "000001");
        assert_eq!(value["allRecords"], 2);
        assert_eq!(normalize_compare("000001.SH"), Some("000001.OF".into()));
        assert_eq!(normalize_compare("../../private"), None);
    }
}
