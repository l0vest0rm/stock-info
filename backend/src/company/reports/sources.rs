//! Provider adapters for company report source lists and report text.
//!
//! Only existing kv_cache namespaces are used. Provider failures stay errors;
//! optional-source degradation is a policy decision of the report assembler.

use crate::{AppState, codes};
use anyhow::{Context, Result, bail};
use regex::Regex;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde_json::{Value, json};
use std::collections::HashSet;

const SOURCE_TTL: i64 = 12 * 60 * 60 * 1000;
const FORECAST_TTL: i64 = 30 * 24 * 60 * 60 * 1000;
// Local migration boundary, not an explicit timeout from the old bare fetch.
// Large PDFs need a separate budget from the shared 10-second API deadline;
// the Rust runtime bounds the entire download to five minutes.
const PDF_DOWNLOAD_TIMEOUT_MS: u64 = 300_000;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static company report regular expression")
}

fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.trim().to_string(),
        value => value.to_string().trim().to_string(),
    }
}

fn headers(referer: &str) -> Result<HeaderMap> {
    let mut result = HeaderMap::new();
    result.insert(REFERER, HeaderValue::from_str(referer)?);
    result.insert(
        "user-agent",
        HeaderValue::from_static("Mozilla/5.0 (compatible; stock-info-local/0.1)"),
    );
    Ok(result)
}

pub fn validate_report_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).context("invalid report URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        bail!("report URL must use HTTP or HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("credentials are forbidden in report URLs");
    }
    Ok(url)
}

fn namespace(key: &str) -> Result<&'static str> {
    for (prefix, namespace) in [
        ("company-reports-source:", "company_reports_source"),
        ("company-report-discovery:", "company_report_discovery"),
        ("report-forecast:", "company_report_forecast"),
        ("shared-report-analysis:", "shared_report_analysis"),
        ("knowledge-report-analysis:", "knowledge_report_analysis"),
        (
            "company-news-report-analysis:",
            "company_news_report_analysis",
        ),
        ("sina-report-list:", "sina_report_list"),
        ("sina-report-detail:", "sina_report_detail"),
        ("eastmoney-report-pdf-text:", "eastmoney_report_pdf_text"),
        ("llm-daily-quota:", "daily_llm_quota"),
        ("companies-follow-config", "companies_follow_config"),
        ("us.options.chain.v2.", "us_option_chain"),
    ] {
        if key.starts_with(prefix) {
            return Ok(namespace);
        }
    }
    bail!("unsupported kv_cache key namespace mapping")
}

pub async fn read_app(state: &AppState, key: &str) -> Result<Option<Value>> {
    let key = key.trim();
    let namespace = namespace(key)?;
    let rows = state.db.query(
        "SELECT value_json FROM kv_cache WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)",
        vec![namespace.into(), key.into(), chrono::Utc::now().timestamp_millis().into()],
    ).await?;
    // Historical malformed optional cache entries are cache misses, not a
    // poisoned source pool or a request failure.
    Ok(rows
        .first()
        .and_then(|row| row["value_json"].as_str())
        .and_then(|value| serde_json::from_str(value).ok()))
}

pub async fn write_app(state: &AppState, key: &str, value: &Value, ttl_ms: i64) -> Result<()> {
    let key = key.trim();
    state
        .db
        .put_kv(
            namespace(key)?,
            key,
            value,
            Some(
                chrono::Utc::now()
                    .timestamp_millis()
                    .saturating_add(ttl_ms.max(1)),
            ),
        )
        .await
}

fn report_pdf_url(item: &Value) -> String {
    let info_code = text(&item["infoCode"]);
    if info_code.is_empty() {
        return String::new();
    }
    let encoded: String = url_encoded_segment(&info_code);
    format!("https://pdf.dfcfw.com/pdf/H3_{encoded}_1.pdf")
}

fn url_encoded_segment(value: &str) -> String {
    // encodeURIComponent semantics: encode slash and delimiter characters, not
    // form-urlencoded '+' spaces. The provider's IDs are normally ASCII AP….
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").unwrap();
        }
    }
    encoded
}

pub fn map_eastmoney_item(item: &Value, code: &str) -> Value {
    let mut mapped = item.as_object().cloned().unwrap_or_default();
    mapped.insert("code".into(), code.into());
    for key in [
        "stockCode",
        "stockName",
        "title",
        "orgName",
        "orgSName",
        "publishDate",
        "infoCode",
        "attachPages",
        "predictThisYearEps",
        "predictNextYearEps",
        "predictNextTwoYearEps",
        "predictThisYearProfit",
        "predictNextYearProfit",
        "predictNextTwoYearProfit",
        "sRatingName",
    ] {
        mapped.insert(key.into(), text(&item[key]).into());
    }
    mapped.insert("url".into(), report_pdf_url(item).into());
    Value::Object(mapped)
}

pub async fn eastmoney_reports(
    state: &AppState,
    code: &str,
    page: usize,
    page_size: usize,
) -> Result<Vec<Value>> {
    let normalized = codes::normalize(code);
    let bare = normalized.split('.').next().unwrap_or("");
    if bare.is_empty() {
        return Ok(Vec::new());
    }
    let mut url = Url::parse("https://reportapi.eastmoney.com/report/list")?;
    let now = chrono::Utc::now().timestamp_millis().to_string();
    let page = page.to_string();
    let page_size = page_size.to_string();
    url.query_pairs_mut().extend_pairs([
        ("cb", "jQuery"),
        ("industryCode", "*"),
        ("pageSize", &page_size),
        ("industry", "*"),
        ("rating", "*"),
        ("ratingChange", "*"),
        ("beginTime", "2022-01-01"),
        ("endTime", "2040-12-31"),
        ("pageNo", &page),
        ("fields", ""),
        ("qType", "0"),
        ("orgCode", ""),
        ("code", bare),
        ("rcode", ""),
        ("_", &now),
    ]);
    let payload = state
        .http
        .cached_json(
            &state.db,
            url.as_str(),
            headers("https://data.eastmoney.com/report/")?,
            6 * 60 * 60 * 1000,
            false,
        )
        .await?;
    Ok(payload["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| map_eastmoney_item(item, &normalized))
        .collect())
}

fn sina_symbol(code: &str) -> Option<String> {
    let normalized = codes::normalize(code);
    let (bare, suffix) = normalized.rsplit_once('.')?;
    match suffix {
        "SZ" | "SH" | "BJ" => Some(format!("{}{bare}", suffix.to_lowercase())),
        _ => None,
    }
}

pub async fn sina_reports(state: &AppState, code: &str, page: usize) -> Result<Vec<Value>> {
    let Some(symbol) = sina_symbol(code) else {
        return Ok(Vec::new());
    };
    let mut url = Url::parse(
        "https://stock.finance.sina.com.cn/stock/go.php/vReport_List/kind/search/index.phtml",
    )?;
    url.query_pairs_mut().extend_pairs([
        ("symbol", symbol.as_str()),
        ("t1", "all"),
        ("p", &page.to_string()),
    ]);
    let html = decoded_page_with_ttl(
        state,
        url.as_str(),
        &format!("sina-report-list:{symbol}:{page}"),
        SOURCE_TTL,
    )
    .await?;
    let normalized = codes::normalize(code);
    let mut rows = parse_sina_reports(&html);
    for row in &mut rows {
        row["code"] = normalized.clone().into();
        row["publishDate"] = normalize_sina_date(row["publishDate"].as_str().unwrap_or("")).into();
        row["orgSName"] = row["orgName"].clone();
        row["sRatingName"] = row["rating"].clone();
        row.as_object_mut().unwrap().remove("rating");
        row["pages"] = json!(0);
    }
    Ok(rows)
}

pub fn parse_sina_reports(html: &str) -> Vec<Value> {
    let row_regex = re(r"(?is)<tr[^>]*>(.*?)</tr>");
    let anchor_regex = re(r#"(?is)<a[^>]+href=["']([^"']*vReport_Show[^"']*)["'][^>]*>(.*?)</a>"#);
    let title_regex = re(r#"(?is)title=["']([^"']+)["']"#);
    let td_regex = re(r"(?is)<td[^>]*>(.*?)</td>");
    let mut reports = Vec::new();
    let mut seen = HashSet::new();
    for row in row_regex.captures_iter(html) {
        let fragment = &row[1];
        let Some(anchor) = anchor_regex.captures(fragment) else {
            continue;
        };
        let Some(url) = normalize_sina_url(&anchor[1]) else {
            continue;
        };
        let title = strip_html(
            title_regex
                .captures(&anchor[0])
                .map(|capture| capture[1].to_string())
                .as_deref()
                .unwrap_or(&anchor[2]),
        );
        if title.is_empty() || !seen.insert(url.clone()) {
            continue;
        }
        let cells: Vec<String> = td_regex
            .captures_iter(fragment)
            .map(|capture| strip_html(&capture[1]))
            .filter(|cell| !cell.is_empty())
            .collect();
        let org_after_date = cells
            .iter()
            .position(|value| looks_date(value))
            .and_then(|index| cells.get(index + 1));
        let org = org_after_date
            .filter(|value| looks_org(value))
            .cloned()
            .unwrap_or_else(|| first_field(&cells, looks_org));
        reports.push(json!({"title": title, "url": url, "orgName": org, "publishDate": first_field(&cells, looks_date), "rating": first_field(&cells, looks_rating)}));
    }
    reports
}

fn first_field(cells: &[String], predicate: fn(&str) -> bool) -> String {
    cells
        .iter()
        .find(|cell| predicate(cell))
        .cloned()
        .unwrap_or_default()
}
fn looks_date(value: &str) -> bool {
    re(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}").is_match(value)
}
fn looks_org(value: &str) -> bool {
    !value.is_empty()
        && !looks_date(value)
        && [
            "证券", "投顾", "投资", "资本", "研究", "银行", "国际", "基金",
        ]
        .iter()
        .any(|marker| value.contains(marker))
}
fn looks_rating(value: &str) -> bool {
    [
        "买入",
        "增持",
        "中性",
        "减持",
        "卖出",
        "推荐",
        "审慎推荐",
        "强烈推荐",
    ]
    .iter()
    .any(|marker| value.contains(marker))
}

fn normalize_sina_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.starts_with("//") {
        Some(format!("https:{raw}"))
    } else if raw.starts_with('/') {
        Some(format!("https://stock.finance.sina.com.cn{raw}"))
    } else if raw.starts_with("http://") || raw.starts_with("https://") {
        Some(raw.into())
    } else {
        None
    }
}

fn normalize_sina_date(raw: &str) -> String {
    let regex = re(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})");
    let Some(capture) = regex.captures(raw) else {
        return raw.trim().into();
    };
    format!(
        "{}-{:02}-{:02} 00:00:00.000",
        &capture[1],
        capture[2].parse::<u32>().unwrap_or(0),
        capture[3].parse::<u32>().unwrap_or(0)
    )
}

fn strip_html(input: &str) -> String {
    let stripped = re(r"(?s)<[^>]+>").replace_all(input, " ").into_owned();
    let stripped = re(r"(?i)&nbsp;|&#160;")
        .replace_all(&stripped, " ")
        .into_owned();
    let stripped = re(r"(?i)&amp;").replace_all(&stripped, "&").into_owned();
    let stripped = re(r"(?i)&lt;").replace_all(&stripped, "<").into_owned();
    let stripped = re(r"(?i)&gt;").replace_all(&stripped, ">").into_owned();
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn extract_sina_content(html: &str) -> String {
    if let Some(block) =
        re(r#"(?is)<div[^>]+class=["'][^"']*blk_container[^"']*["'][^>]*>(.*?)</div>"#)
            .captures(html)
    {
        let text = strip_html(&block[1]);
        if text.encode_utf16().count() > 120 {
            return text;
        }
    }
    let mut best = String::new();
    for pattern in [
        r#"(?is)<div[^>]+id=["']artibody["'][^>]*>(.*?)</div>"#,
        r#"(?is)<div[^>]+class=["'][^"']*article[^"']*["'][^>]*>(.*?)</div>"#,
        r#"(?is)<div[^>]+class=["'][^"']*report-content[^"']*["'][^>]*>(.*?)</div>"#,
        r#"(?is)<div[^>]+class=["'][^"']*content[^"']*["'][^>]*>(.*?)</div>"#,
    ] {
        if let Some(block) = re(pattern).captures(html) {
            let text = strip_html(&block[1]);
            if text.encode_utf16().count() > best.encode_utf16().count() {
                best = text;
            }
        }
    }
    if best.is_empty() {
        strip_html(html)
    } else {
        best
    }
}

pub fn decode_page(bytes: &[u8], content_type: &str) -> String {
    let charset = re(r"(?i)charset=([^;]+)")
        .captures(content_type)
        .map(|capture| capture[1].trim().to_lowercase())
        .unwrap_or_else(|| "utf-8".into());
    if charset == "gbk" || charset == "gb2312" {
        encoding_rs::GBK.decode(bytes).0.into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub async fn decoded_page(state: &AppState, url: &str, cache_key: &str) -> Result<String> {
    let ttl = if cache_key.starts_with("sina-report-list:") {
        SOURCE_TTL
    } else {
        FORECAST_TTL
    };
    decoded_page_with_ttl(state, url, cache_key, ttl).await
}

pub async fn decoded_page_with_ttl(
    state: &AppState,
    url: &str,
    cache_key: &str,
    ttl_ms: i64,
) -> Result<String> {
    if let Some(cached) = read_app(state, cache_key).await?.and_then(|value| {
        value["text"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    }) {
        return Ok(cached);
    }
    let url = validate_report_url(url)?;
    let (bytes, response_headers) = state
        .http
        .bytes(url.as_str(), headers("https://finance.sina.com.cn/")?)
        .await?;
    let content_type = response_headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let decoded = decode_page(&bytes, content_type);
    write_app(state, cache_key, &json!({"text": decoded}), ttl_ms).await?;
    Ok(decoded)
}

pub fn extract_pdf_text(bytes: &[u8]) -> Result<String> {
    if !bytes.starts_with(b"%PDF") {
        bail!("Eastmoney report response is not a PDF");
    }
    let document =
        lopdf::Document::load_mem(bytes).context("Eastmoney report PDF could not be decoded")?;
    let pages: Vec<u32> = document.get_pages().keys().take(30).copied().collect();
    let text = document
        .extract_text(&pages)
        .context("Eastmoney report PDF text extraction failed")?
        .trim()
        .to_string();
    if text.is_empty() {
        bail!("Eastmoney report PDF has no extractable text");
    }
    Ok(text)
}

pub async fn eastmoney_pdf_text(state: &AppState, info_code: &str) -> Result<String> {
    let cache_key = format!("eastmoney-report-pdf-text:{info_code}");
    if let Some(cached) = read_app(state, &cache_key).await?.and_then(|value| {
        value["text"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    }) {
        return Ok(cached);
    }
    let url = report_pdf_url(&json!({"infoCode": info_code}));
    if url.is_empty() {
        bail!("Eastmoney report PDF requires infoCode");
    }
    let (bytes, _) = state
        .http
        .bytes_with_timeout(
            &url,
            headers("https://data.eastmoney.com/report/")?,
            PDF_DOWNLOAD_TIMEOUT_MS,
        )
        .await?;
    let text = tokio::task::spawn_blocking(move || extract_pdf_text(&bytes)).await??;
    write_app(state, &cache_key, &json!({"text": text}), FORECAST_TTL).await?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_mapping_retains_provider_fields_and_encodes_pdf_identity() {
        let value = map_eastmoney_item(
            &json!({"infoCode":" AP123 ","title":" title ","predictThisYearEps":1.5,"unknown":"preserved"}),
            "600036.SH",
        );
        assert_eq!(value["predictThisYearEps"], "1.5");
        assert_eq!(value["url"], "https://pdf.dfcfw.com/pdf/H3_AP123_1.pdf");
        assert_eq!(value["unknown"], "preserved");
        assert_eq!(value["orgSName"], "");
        assert_eq!(
            report_pdf_url(&json!({"infoCode":"a/b?c"})),
            "https://pdf.dfcfw.com/pdf/H3_a%2Fb%3Fc_1.pdf"
        );
    }

    #[test]
    fn sina_list_parses_relative_urls_metadata_and_deduplicates() {
        let html = r#"<table><tr><td><a href="/stock/go.php/vReport_Show/kind/search/rptid/123/index.phtml" title="报告&amp;估值">ignored</a></td><td>2026/9/2</td><td>中信证券</td><td>买入</td></tr><tr><td><a href="/stock/go.php/vReport_Show/kind/search/rptid/123/index.phtml">duplicate</a></td></tr><tr><td><a href="javascript:vReport_Show">unsafe</a></td></tr></table>"#;
        let rows = parse_sina_reports(html);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], "报告&估值");
        assert_eq!(rows[0]["orgName"], "中信证券");
        assert_eq!(rows[0]["rating"], "买入");
        assert_eq!(
            normalize_sina_date(rows[0]["publishDate"].as_str().unwrap()),
            "2026-09-02 00:00:00.000"
        );
        assert_eq!(sina_symbol("600036.SH"), Some("sh600036".into()));
        assert_eq!(sina_symbol("00700.HK"), None);
    }

    #[test]
    fn decoded_content_preserves_gbk_and_selects_article() {
        let input = "公司净利润增长";
        let (bytes, _, _) = encoding_rs::GBK.encode(input);
        assert_eq!(decode_page(&bytes, "text/html; charset=gb2312"), input);
        assert_eq!(
            decode_page(input.as_bytes(), "text/html; charset=utf-8"),
            input
        );
        assert_eq!(
            extract_sina_content(
                "<nav>导航</nav><div id='artibody'>研究 <b>正文</b>&nbsp;内容</div>"
            ),
            "研究 正文 内容"
        );
        assert_eq!(
            extract_sina_content("<p>fallback&nbsp;&amp; data</p>"),
            "fallback & data"
        );
        // JavaScript compares UTF-16 lengths, not UTF-8 byte lengths. A
        // shorter Chinese block must not beat a longer ASCII article.
        let chinese = "研".repeat(20);
        let ascii = "a".repeat(30);
        assert_eq!(
            extract_sina_content(&format!(
                "<div class='article'>{chinese}</div><div class='content'>{ascii}</div>"
            )),
            ascii
        );
    }

    #[test]
    fn url_and_pdf_failures_are_explicit() {
        assert!(validate_report_url("file:///etc/passwd").is_err());
        assert!(validate_report_url("https://user:password@example.com/report").is_err());
        assert!(validate_report_url("https://example.com/report").is_ok());
        assert!(extract_pdf_text(b"<html>challenge</html>").is_err());
        assert!(extract_pdf_text(b"%PDF-invalid").is_err());
        assert_eq!(
            namespace("sina-report-list:sh600036:1").unwrap(),
            "sina_report_list"
        );
        assert_eq!(
            namespace("eastmoney-report-pdf-text:AP123").unwrap(),
            "eastmoney_report_pdf_text"
        );
        assert!(namespace("unknown").is_err());
    }

    #[test]
    fn pdf_extraction_reads_text_and_preserves_thirty_page_bound() {
        use lopdf::{
            Document, Object, Stream,
            content::{Content, Operation},
            dictionary,
        };
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font = document
            .add_object(dictionary! {"Type"=>"Font", "Subtype"=>"Type1", "BaseFont"=>"Courier"});
        let resources = document.add_object(dictionary! {"Font"=>dictionary! {"F1"=>font}});
        let mut pages = Vec::new();
        for page_number in 1..=31 {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 12.into()]),
                    Operation::new(
                        "Tj",
                        vec![Object::string_literal(format!("PAGE_{page_number:02}"))],
                    ),
                    Operation::new("ET", vec![]),
                ],
            };
            let content_id =
                document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let page_id = document.add_object(
                dictionary! {"Type"=>"Page", "Parent"=>pages_id, "Contents"=>content_id},
            );
            pages.push(Object::Reference(page_id));
        }
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type"=>"Pages", "Kids"=>pages, "Count"=>31, "Resources"=>resources,
                "MediaBox"=>vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let catalog = document.add_object(dictionary! {"Type"=>"Catalog", "Pages"=>pages_id});
        document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        let extracted = extract_pdf_text(&bytes).unwrap();
        assert!(extracted.contains("PAGE_01"));
        assert!(extracted.contains("PAGE_30"));
        assert!(!extracted.contains("PAGE_31"));
    }

    #[tokio::test]
    async fn app_cache_preserves_namespace_ttl_and_ignores_malformed_entries() {
        let temp = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(temp.path().join("reports.sqlite")).unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        db.migrate(&root.join("migrations")).unwrap();
        let state = AppState::new(db, root, "127.0.0.1:8000".into()).unwrap();
        let key = "company-reports-source:v5:600036.SH";
        assert!(read_app(&state, key).await.unwrap().is_none());
        write_app(&state, key, &json!([{"title":"cached"}]), SOURCE_TTL)
            .await
            .unwrap();
        assert_eq!(
            read_app(&state, key).await.unwrap(),
            Some(json!([{"title":"cached"}]))
        );
        let stored = state
            .db
            .query(
                "SELECT namespace, expires_at FROM kv_cache WHERE key=?",
                vec![key.into()],
            )
            .await
            .unwrap();
        assert_eq!(stored[0]["namespace"], "company_reports_source");
        assert!(stored[0]["expires_at"].as_i64().unwrap() > chrono::Utc::now().timestamp_millis());
        state
            .db
            .execute(
                "UPDATE kv_cache SET value_json='not-json' WHERE key=?",
                vec![key.into()],
            )
            .await
            .unwrap();
        assert!(read_app(&state, key).await.unwrap().is_none());
        state
            .db
            .execute(
                "UPDATE kv_cache SET value_json='[]', expires_at=1 WHERE key=?",
                vec![key.into()],
            )
            .await
            .unwrap();
        assert!(read_app(&state, key).await.unwrap().is_none());
        assert!(write_app(&state, "unknown", &json!({}), 1).await.is_err());
    }
}
