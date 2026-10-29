//! 13f.info manager, filings and position read APIs with the legacy array shape.
use crate::{ApiResult, AppState, ok};
use anyhow::{Result, anyhow};
use axum::{
    Router,
    extract::{Path, State},
    routing::get,
};
use regex::Regex;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde_json::{Value, json};
use std::sync::LazyLock;

const TTL_MS: i64 = 30 * 86_400_000;
static ROWS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<tr[^>]*>(.*?)</tr>").unwrap());
static CELLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<td[^>]*>(.*?)</td>").unwrap());
static SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<script.*?</script>").unwrap());
static STYLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<style.*?</style>").unwrap());
static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]+>").unwrap());
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static HREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)href=["']/manager/([^"']+)["']"#).unwrap());
static FILINGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)id=["']managerFilings["'].*?</table>"#).unwrap());
static ORDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)data-order=["']([^"']+)["']"#).unwrap());
static VOLUME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[TBM].*$").unwrap());

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/13f/manager/list", get(managers))
        .route("/13f/quarters/{id}", get(quarters))
        .route("/13f/position/{filing_id}", get(position))
}

fn headers(referer: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(REFERER, HeaderValue::from_str(referer).unwrap());
    headers
}

fn endpoint(parts: &[&str]) -> Result<String> {
    let mut url = Url::parse("https://13f.info")?;
    url.path_segments_mut()
        .map_err(|_| anyhow!("invalid 13f base URL"))?
        .extend(parts.iter().copied());
    Ok(url.to_string())
}

async fn cached_text(state: &AppState, url: &str, referer: &str) -> Result<String> {
    state
        .http
        .cached_text(&state.db, url, headers(referer), TTL_MS, false)
        .await
}

async fn managers(State(state): State<AppState>) -> ApiResult {
    let html = cached_text(&state, "https://13f.info/managers", "https://13f.info/").await?;
    Ok(ok(json!(parse_managers(&html))))
}

async fn quarters(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let html = cached_text(
        &state,
        &endpoint(&["manager", &id])?,
        "https://13f.info/managers",
    )
    .await?;
    Ok(ok(json!(parse_quarters(&html))))
}

async fn position(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let data = state
        .http
        .cached_json(
            &state.db,
            &endpoint(&["data", "13f", &id])?,
            headers("https://13f.info/"),
            TTL_MS,
            false,
        )
        .await?;
    Ok(ok(data
        .get("data")
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]))))
}

fn strip(html: &str) -> String {
    let mut text = html.to_string();
    for pattern in [&*SCRIPT, &*STYLE, &*TAGS] {
        text = pattern.replace_all(&text, "").into_owned();
    }
    SPACE
        .replace_all(&text.replace("&amp;", "&").replace("&nbsp;", " "), " ")
        .trim()
        .to_string()
}

fn cells(row: &str) -> Vec<String> {
    CELLS.captures_iter(row).map(|m| strip(&m[1])).collect()
}

fn parse_managers(html: &str) -> Vec<Value> {
    let mut rows = vec![json!([
        "0001759760-h-h-international-investment-llc",
        "H&H International Investment, LLC",
        "段永平基金",
        "$14 B",
        14000
    ])];
    for row in ROWS.captures_iter(html) {
        let values = cells(&row[1]);
        if values.len() < 5 || values[0].is_empty() {
            continue;
        }
        let Some(link) = HREF.captures(&row[1]).map(|m| m[1].to_string()) else {
            continue;
        };
        rows.push(json!([
            link,
            values[0],
            manager_chinese_name(&values[0]),
            values[4],
            parse_volume(&values[4])
        ]));
    }
    rows.sort_by(|a, b| {
        b[4].as_f64()
            .unwrap_or_default()
            .total_cmp(&a[4].as_f64().unwrap_or_default())
    });
    rows
}

fn parse_quarters(html: &str) -> Vec<Vec<String>> {
    let table = FILINGS.find(html).map(|m| m.as_str()).unwrap_or(html);
    let mut rows = Vec::new();
    for row in ROWS.captures_iter(table) {
        let mut values = cells(&row[1]);
        if values.len() < 6 {
            continue;
        }
        if let Some(order) = ORDER.captures(&row[1]) {
            values[5] = order[1].into();
        }
        if values[4] == "13F-HR" || values[4] == "RESTATEMENT" {
            rows.push(values);
        }
    }
    rows
}

fn manager_chinese_name(name: &str) -> &str {
    match name {
        "H&H International Investment, LLC" => "段永平基金",
        "Berkshire Hathaway Inc" => "伯克希尔哈撒韦",
        "HHLR ADVISORS, LTD." => "高领资本",
        "GOLDMAN SACHS GROUP INC" => "高盛集团",
        "Bridgewater Associates, LP" => "桥水基金",
        "ARK Investment Management LLC" => "方舟基金",
        "BlackRock Inc." => "贝莱德公司",
        "VANGUARD GROUP INC" => "先锋集团",
        "STATE STREET CORP" => "道富银行",
        _ => name,
    }
}

fn parse_volume(value: &str) -> f64 {
    let unit = if value.contains('T') {
        1e6
    } else if value.contains('B') {
        1e3
    } else if value.contains('M') {
        1.0
    } else {
        0.0
    };
    let cleaned = value.replace(['$', ','], "");
    let cleaned = VOLUME.replace(&cleaned, "");
    cleaned
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .unwrap_or_default()
        * unit
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managers_sort_volume_and_decode_legacy_fields() {
        let html = r#"<table><tr><td><a href='/manager/brk'>Berkshire Hathaway Inc</a></td><td>x</td><td>x</td><td>x</td><td>$1.2 T</td></tr><tr><td><a href='/manager/unknown'>Unknown &amp; Co</a></td><td>x</td><td>x</td><td>x</td><td>$5 M</td></tr><tr><td>invalid</td></tr></table>"#;
        let rows = parse_managers(html);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0][0], "brk");
        assert_eq!(rows[0][2], "伯克希尔哈撒韦");
        assert_eq!(rows[0][4], 1_200_000.0);
        assert_eq!(rows[2][1], "Unknown & Co");
        assert_eq!(
            strip("<style>x</style><script>x</script><b>A</b>&nbsp; B"),
            "A B"
        );
    }
    #[test]
    fn filings_use_manager_table_filter_and_sort_value() {
        let html = r#"<table><tr><td>unrelated</td><td>x</td><td>x</td><td>x</td><td>13F-HR</td><td>x</td></tr></table><table id='managerFilings'><tr><td>2026</td><td>a</td><td>b</td><td>c</td><td>13F-HR</td><td data-order='123'>display</td></tr><tr><td>2025</td><td>a</td><td>b</td><td>c</td><td>RESTATEMENT</td><td>v</td></tr><tr><td>2024</td><td>a</td><td>b</td><td>c</td><td>OTHER</td><td>v</td></tr></table>"#;
        let rows = parse_quarters(html);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][5], "123");
        assert_eq!(rows[1][4], "RESTATEMENT");
        assert_eq!(parse_volume("$2,500 M"), 2500.0);
        assert_eq!(parse_volume("unknown"), 0.0);
        assert_eq!(
            endpoint(&["manager", "a/b?c"]).unwrap(),
            "https://13f.info/manager/a%2Fb%3Fc"
        );
    }
}
