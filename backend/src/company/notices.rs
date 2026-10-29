use crate::{AppState, codes, http::parse_json_or_jsonp};
use anyhow::{Context, Result, bail};
use reqwest::{
    Method, Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ORIGIN: &str = "https://www.cninfo.com.cn";

pub async fn company_notices(
    state: &AppState,
    raw_code: &str,
    page: f64,
    page_size: f64,
    category: &str,
    research: bool,
) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    let suffix = code.rsplit('.').next().unwrap_or("");
    if research {
        if suffix != "SZ" {
            return Ok(Vec::new());
        }
        return disclosure(state, &code, page, page_size, "relation", "", "公司调研").await;
    }
    if ["SH", "SZ", "BJ", "HK"].contains(&suffix) {
        disclosure(state, &code, page, page_size, "fulltext", category, "公告").await
    } else {
        eastmoney_notices(state, &code, page, page_size).await
    }
}

fn market(suffix: &str) -> Option<(&'static str, &'static str)> {
    match suffix {
        "SH" => Some(("sse", "sh")),
        "SZ" => Some(("szse", "sz")),
        "BJ" => Some(("bj", "bj;third")),
        "HK" => Some(("hke", "hk")),
        _ => None,
    }
}

pub async fn periodic_reports(
    state: &AppState,
    raw_code: &str,
    page_size: usize,
) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    let suffix = code.rsplit('.').next().unwrap_or("");
    if market(suffix).is_none() {
        bail!("unsupported CNINFO periodic report code: {raw_code}");
    }
    let category_suffix = if suffix == "HK" { "hk" } else { "szsh" };
    let mut rows = Vec::new();
    for category in [
        "category_ndbg",
        "category_bndbg",
        "category_yjdbg",
        "category_sjdbg",
    ] {
        let category = format!("{category}_{category_suffix}");
        for attempt in 1..=3 {
            match disclosure(
                state,
                &code,
                1.0,
                page_size as f64,
                "fulltext",
                &category,
                "定期报告",
            )
            .await
            {
                Ok(page) => {
                    rows.extend(page);
                    break;
                }
                Err(error) if attempt < 3 && is_rejection(&error) => {
                    tokio::time::sleep(std::time::Duration::from_millis(2000 * attempt)).await;
                }
                Err(error) => return Err(error),
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
    Ok(rows)
}

fn is_rejection(error: &anyhow::Error) -> bool {
    regex::Regex::new(r"status=[45]\d\d")
        .unwrap()
        .is_match(&error.to_string())
}

async fn disclosure(
    state: &AppState,
    code: &str,
    page: f64,
    page_size: f64,
    tab: &str,
    category: &str,
    fallback: &str,
) -> Result<Vec<Value>> {
    let (stock, suffix) = code
        .rsplit_once('.')
        .context("unsupported CNINFO company disclosure code")?;
    let (column, plate) = market(suffix).context("unsupported CNINFO company disclosure code")?;
    let count = if suffix == "HK" { 5 } else { 6 };
    if stock.len() != count || !stock.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("unsupported CNINFO company disclosure code: {code}");
    }
    if !page.is_finite() || page.fract() != 0.0 || !(1.0..=100.0).contains(&page) {
        bail!("CNINFO announcement page must be between 1 and 100: {page}");
    }
    let mut url = Url::parse(&format!("{ORIGIN}/new/information/topSearch/query"))?;
    url.query_pairs_mut()
        .extend_pairs([("keyWord", stock), ("maxNum", "10")]);
    let securities =
        cached_post_json(state, url.as_str(), HeaderMap::new(), None, 30 * 86_400_000).await?;
    let org = securities
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["code"].as_str() == Some(stock)))
        .and_then(|row| row["orgId"].as_str())
        .unwrap_or("")
        .trim();
    if org.is_empty() {
        bail!("CNINFO security organization was not found: {code}");
    }
    let page_size = page_size.trunc().clamp(1.0, 30.0).to_string();
    let page = page.to_string();
    let stock_org = format!("{stock},{org}");
    let body = reqwest::Url::parse_with_params(
        "http://localhost",
        [
            ("stock", stock_org.as_str()),
            ("tabName", tab),
            ("pageSize", page_size.as_str()),
            ("pageNum", page.as_str()),
            ("column", column),
            ("category", category),
            ("plate", plate),
            ("seDate", ""),
            ("searchkey", ""),
            ("secid", ""),
            ("sortName", ""),
            ("sortType", ""),
            ("isHLtitle", "true"),
        ],
    )?
    .query()
    .unwrap_or("")
    .to_string();
    let mut headers = HeaderMap::new();
    let mut referer = Url::parse(&format!("{ORIGIN}/new/disclosure/stock"))?;
    referer
        .query_pairs_mut()
        .extend_pairs([("stockCode", stock), ("orgId", org)]);
    for (name, value) in [
        ("accept", "application/json, text/javascript, */*; q=0.01"),
        (
            "content-type",
            "application/x-www-form-urlencoded; charset=UTF-8",
        ),
        ("origin", ORIGIN),
        ("referer", referer.as_str()),
        ("x-requested-with", "XMLHttpRequest"),
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
            HeaderValue::from_str(value)?,
        );
    }
    let body = cached_post_json(
        state,
        &format!("{ORIGIN}/new/hisAnnouncement/query"),
        headers,
        Some(body),
        30 * 60_000,
    )
    .await?;
    Ok(map_announcements(&body, fallback))
}

pub fn map_announcements(body: &Value, fallback: &str) -> Vec<Value> {
    let strip = regex::Regex::new(r"<[^>]*>").unwrap();
    body["announcements"].as_array().into_iter().flatten().filter_map(|item| {
        let id = item["announcementId"].as_str().unwrap_or("").trim();
        let title = strip.replace_all(item["announcementTitle"].as_str().unwrap_or(""),"").trim().to_string();
        if id.is_empty() || title.is_empty() {return None;}
        let date = crate::http::number(&item["announcementTime"]).and_then(|n|chrono::DateTime::from_timestamp_millis(n as i64)).and_then(|d|d.checked_add_signed(chrono::Duration::hours(8))).map(|d|d.format("%Y-%m-%d").to_string()).unwrap_or_default();
        let kind = item["announcementTypeName"].as_str().unwrap_or("").trim();
        let adjunct = item["adjunctUrl"].as_str().unwrap_or("").trim();
        let pdf = if adjunct.is_empty(){String::new()}else{Url::parse("https://static.cninfo.com.cn/").unwrap().join(adjunct).map(|u|u.to_string()).unwrap_or_default()};
        Some(json!({"artCode":id,"title":title,"noticeDate":date,"noticeType":if kind.is_empty(){fallback}else{kind},"pdfUrl":pdf}))
    }).collect()
}

async fn cached_post_json(
    state: &AppState,
    url: &str,
    headers: HeaderMap,
    body: Option<String>,
    ttl: i64,
) -> Result<Value> {
    let safe_headers = headers
        .iter()
        .filter_map(|(name, value)| value.to_str().ok().map(|value| (name.as_str(), value)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(
            &json!({"method":"POST","url":url,"headers":safe_headers,"body":body})
        )?)
    );
    let now = chrono::Utc::now().timestamp_millis();
    let rows = state
        .db
        .query(
            "SELECT body_text FROM http_cache WHERE cache_key=? AND expires_at>?",
            vec![key.clone().into(), now.into()],
        )
        .await?;
    if let Some(text) = rows.first().and_then(|row| row["body_text"].as_str()) {
        return parse_json_or_jsonp(text);
    }
    let text = state.http.text(url, Method::POST, headers, body).await?;
    let result = parse_json_or_jsonp(&text)?;
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'POST',200,'{}',?,?,?) ON CONFLICT(cache_key) DO UPDATE SET body_text=excluded.body_text,status=200,expires_at=excluded.expires_at,updated_at=excluded.updated_at",vec![key.into(),url.into(),text.into(),(now+ttl).into(),now.into()]).await?;
    Ok(result)
}

async fn eastmoney_notices(
    state: &AppState,
    code: &str,
    page: f64,
    page_size: f64,
) -> Result<Vec<Value>> {
    let suffix = code.rsplit('.').next().unwrap_or("");
    let mut url = Url::parse("https://np-anotice-stock.eastmoney.com/api/security/ann")?;
    let callback = format!("jQuery{}", chrono::Utc::now().timestamp_millis());
    let page = page.to_string();
    let page_size = page_size.to_string();
    url.query_pairs_mut().extend_pairs([
        ("cb", callback.as_str()),
        ("sr", "-1"),
        ("page_size", page_size.as_str()),
        ("page_index", page.as_str()),
        (
            "ann_type",
            if suffix == "HK" {
                "H"
            } else if suffix == "US" {
                "U,U_Pink"
            } else {
                "A"
            },
        ),
        ("client_source", "web"),
        ("stock_list", code.split('.').next().unwrap_or(code)),
        ("f_node", ""),
        ("s_node", ""),
    ]);
    let mut headers = HeaderMap::new();
    headers.insert(
        "referer",
        HeaderValue::from_static("https://data.eastmoney.com/"),
    );
    let body = state
        .http
        .cached_json(&state.db, url.as_str(), headers, 6 * 3_600_000, false)
        .await?;
    Ok(body["data"]["list"].as_array().into_iter().flatten().filter_map(|item|{
        let id=item["art_code"].as_str().unwrap_or("").trim();let title=item["title"].as_str().unwrap_or("").trim();
        if id.is_empty()||title.is_empty(){return None;}
        Some(json!({"artCode":id,"title":title,"noticeDate":item["notice_date"].as_str().unwrap_or("").chars().take(10).collect::<String>(),"noticeType":item["columns"][0]["column_name"].as_str().unwrap_or("").trim(),"pdfUrl":format!("https://pdf.dfcfw.com/pdf/H3_{}_1.pdf", super::encode_component(id))}))
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cninfo_shape_and_date_timezone_are_preserved() {
        let rows = map_announcements(
            &json!({"announcements":[{"announcementId":"A1","announcementTitle":"<em>年度</em>报告","announcementTime":1767196800000_i64,"adjunctUrl":"finalpage/a.pdf"},{"announcementId":"","announcementTitle":"bad"}]}),
            "定期报告",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], "年度报告");
        assert_eq!(rows[0]["noticeType"], "定期报告");
        assert_eq!(
            rows[0]["pdfUrl"],
            "https://static.cninfo.com.cn/finalpage/a.pdf"
        );
        assert_eq!(rows[0]["noticeDate"], "2026-01-01");
    }
    #[test]
    fn registry_market_categories_are_not_exchange_guesses() {
        assert_eq!(market("SH"), Some(("sse", "sh")));
        assert_eq!(market("BJ"), Some(("bj", "bj;third")));
        assert!(market("US").is_none());
        assert!(is_rejection(&anyhow::anyhow!("status=403 Forbidden")));
        assert!(!is_rejection(&anyhow::anyhow!("network timed out")));
    }
}
