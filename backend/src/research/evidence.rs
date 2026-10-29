//! Primary registry identity evidence. This is not a financial-statement feed:
//! Yahoo/Eastmoney remain the selected structured sources in `finance`.
use crate::{AppState, codes};
use anyhow::{Context, Result, bail};
use chrono::{Duration, NaiveDate, Utc};
use regex::Regex;
use reqwest::{
    Url,
    header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    sync::{Arc, Mutex, OnceLock},
};

const HKEX: &str = "https://www1.hkexnews.hk";
const SEC: &str = "https://www.sec.gov";
const SEC_DATA: &str = "https://data.sec.gov";
const DAY_MS: i64 = 86_400_000;

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}
fn string(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else if let Some(value) = value.as_str() {
        value.trim().into()
    } else if let Some(number) = value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && n.abs() < 1e21)
    {
        format!("{number:.0}")
    } else {
        value.to_string()
    }
}
fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= i64::MIN as f64 && *n <= i64::MAX as f64)
            .map(|n| n as i64)
    })
}
fn compiled(pattern: &'static str) -> Arc<Regex> {
    static PATTERNS: OnceLock<Mutex<HashMap<&'static str, Arc<Regex>>>> = OnceLock::new();
    PATTERNS
        .get_or_init(Default::default)
        .lock()
        .expect("registry regex cache poisoned")
        .entry(pattern)
        .or_insert_with(|| Arc::new(Regex::new(pattern).expect("valid registry pattern")))
        .clone()
}
fn re(pattern: &'static str, value: &str) -> bool {
    compiled(pattern).is_match(value)
}
fn periodic(title: &str) -> bool {
    re(
        r"(?i)(年度报告|半年度报告|[第]?[一二三四五六]?季度报告|annual report|interim report|quarterly report|form 10-k|form 20-f|form 10-q)",
        title,
    )
}

/// The evidence contract validates the publication's ISO shape. Registry
/// parsers separately require a real calendar date where the provider needs it.
pub fn validate_record(record: &Value) -> Value {
    if record.is_null() || !(record.is_object() || record.is_array()) {
        return json!({"ok":false,"problems":["not_an_object"]});
    }
    let mut problems = Vec::new();
    let source = record["source"].as_str().unwrap_or("");
    if ![
        "cninfo_filing",
        "hkex_filing",
        "sec_filing",
        "sse_filing",
        "szse_filing",
        "issuer_ir",
        "exchange_quote",
    ]
    .contains(&source)
    {
        problems.push("unknown_source");
    }
    if record["kind"] != "primary" {
        problems.push("secondary_source_rejected");
    }
    for (key, problem) in [
        ("security", "missing_security"),
        ("documentId", "missing_document_id"),
        ("title", "missing_title"),
    ] {
        if text(&record[key]).is_empty() {
            problems.push(problem);
        }
    }
    if !re(
        r"^\d{4}-\d{2}-\d{2}$",
        record["publishedAt"].as_str().unwrap_or(""),
    ) {
        problems.push("invalid_published_at");
    }
    let url = record["url"].as_str().unwrap_or("");
    if !url.starts_with("https://") {
        problems.push("invalid_url");
    } else {
        let required_host = match source {
            "cninfo_filing" => Some("cninfo.com.cn"),
            "hkex_filing" => Some("hkexnews.hk"),
            "sec_filing" => Some("sec.gov"),
            "sse_filing" => Some("sse.com.cn"),
            "szse_filing" => Some("szse.cn"),
            _ => None,
        };
        if let Some(required) = required_host {
            match Url::parse(url) {
                Ok(url) => {
                    if let Some(host) = url.host_str()
                        && host != required
                        && !host.ends_with(&format!(".{required}"))
                    {
                        problems.push("url_host_mismatch");
                    }
                }
                Err(_) => problems.push("unparsable_url"),
            }
        }
    }
    json!({"ok":problems.is_empty(),"problems":problems})
}

pub fn can_verify_identity(security: &str, records: &[Value]) -> Value {
    let records: Vec<_> = records
        .iter()
        .filter(|record| record["security"] == security)
        .collect();
    if records.is_empty() {
        return json!({"ok":false,"problems":["no_evidence_for_security"]});
    }
    let mut problems = Vec::new();
    let mut seen = HashSet::new();
    for record in &records {
        let valid = validate_record(record);
        for problem in valid["problems"].as_array().into_iter().flatten() {
            if let Some(problem) = problem.as_str()
                && seen.insert(problem.to_string())
            {
                problems.push(problem.to_string());
            }
        }
    }
    if !problems.is_empty() {
        return json!({"ok":false,"problems":problems});
    }
    if !records.iter().any(|record| {
        [
            "cninfo_filing",
            "hkex_filing",
            "sec_filing",
            "sse_filing",
            "szse_filing",
            "issuer_ir",
        ]
        .contains(&text(&record["source"]))
    }) {
        return json!({"ok":false,"problems":["no_identity_source"]});
    }
    json!({"ok":true,"problems":[]})
}

pub fn latest_evidence_date(records: &[Value]) -> Option<String> {
    records
        .iter()
        .filter(|record| validate_record(record)["ok"] == true)
        .filter_map(|record| record["publishedAt"].as_str())
        .max()
        .map(str::to_string)
}

pub fn identity_report(securities: &[String], records: &[Value]) -> Vec<Value> {
    securities
        .iter()
        .map(|security| {
            let result = can_verify_identity(security, records);
            json!({"security":security,"verified":result["ok"],"problems":result["problems"]})
        })
        .collect()
}

pub fn evidence_coverage(securities: &[String], records: &[Value]) -> Value {
    let covered: Vec<_> = securities
        .iter()
        .filter(|security| can_verify_identity(security, records)["ok"] == true)
        .collect();
    let missing: Vec<_> = securities
        .iter()
        .filter(|security| !covered.contains(security))
        .collect();
    json!({"covered":covered,"missing":missing,"total":securities.len()})
}

pub fn expected_registry(code: &str) -> Option<&'static str> {
    match codes::normalize(code).rsplit('.').next().unwrap_or("") {
        "SH" | "SZ" | "BJ" => Some("cninfo"),
        "HK" => Some("hkex"),
        "US" => Some("sec"),
        _ => None,
    }
}

/// API data shape, including raw record count before validation and identity
/// derived only from valid primary records bound to this exact security line.
pub async fn collect(state: &AppState, raw_code: &str) -> Result<Value> {
    let security = codes::normalize(raw_code);
    let collection = match expected_registry(&security) {
        Some("cninfo") => collect_cninfo(state, &security).await,
        Some("hkex") => collect_hkex(state, &security).await,
        Some("sec") => collect_sec(state, &security).await,
        _ => collection(
            &security,
            "unsupported",
            None,
            Vec::new(),
            Some("unsupported_security".into()),
        ),
    };
    let raw = collection["records"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let records: Vec<_> = raw
        .iter()
        .filter(|record| validate_record(record)["ok"] == true)
        .cloned()
        .collect();
    let identity = can_verify_identity(&security, &records);
    Ok(
        json!({"security":security,"status":collection["status"],"registry":collection["registry"],"failure":collection["failure"],
        "recordCount":raw.len(),"validRecords":records.len(),"identityVerified":identity["ok"],"identityProblems":identity["problems"],"lastEvidenceDate":latest_evidence_date(&records),"records":records}),
    )
}

fn collection(
    security: &str,
    status: &str,
    registry: Option<&str>,
    records: Vec<Value>,
    failure: Option<String>,
) -> Value {
    json!({"security":security,"status":status,"registry":registry,"records":records,"failure":failure})
}
fn error_message(error: &anyhow::Error) -> String {
    error.to_string().chars().take(200).collect()
}

pub fn cninfo_records(security: &str, notices: &[Value]) -> Vec<Value> {
    notices.iter().filter_map(|notice| {
        let id = string(&notice["artCode"]);
        let title = text(&notice["title"]);
        let date = text(&notice["noticeDate"]);
        let url = text(&notice["pdfUrl"]);
        if id.is_empty() || title.is_empty() || date.is_empty() || url.is_empty() || !periodic(title) { return None; }
        Some(json!({"source":"cninfo_filing","kind":"primary","security":security,"documentId":id,"title":title,"publishedAt":date,"url":url}))
    }).collect()
}

async fn collect_cninfo(state: &AppState, security: &str) -> Value {
    match crate::company::periodic_reports(state, security, 30).await {
        Ok(notices) => {
            let records = cninfo_records(security, &notices);
            collection(
                security,
                if records.is_empty() {
                    "no_documents"
                } else {
                    "collected"
                },
                Some("cninfo"),
                records,
                None,
            )
        }
        Err(error) => collection(
            security,
            "source_failed",
            Some("cninfo"),
            Vec::new(),
            Some(error_message(&error)),
        ),
    }
}

#[derive(Debug)]
struct InvalidRegistryResponse(String);
impl fmt::Display for InvalidRegistryResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for InvalidRegistryResponse {}
fn invalid(message: &str) -> anyhow::Error {
    InvalidRegistryResponse(message.to_string()).into()
}

pub fn parse_hkex_rows(payload: &Value) -> Result<Vec<Value>> {
    if !payload.is_object() {
        return Err(invalid("HKEX title-search response was not an object."));
    }
    let result = payload["result"]
        .as_str()
        .ok_or_else(|| invalid("HKEX title-search response did not contain a string result."))?;
    let rows: Value = serde_json::from_str(result)
        .map_err(|_| invalid("HKEX title-search result was not valid JSON."))?;
    let rows = rows
        .as_array()
        .ok_or_else(|| invalid("HKEX title-search result was not an array."))?;
    Ok(rows.iter().filter(|row| row.is_object()).cloned().collect())
}

fn strip_html(value: &str) -> String {
    let html = compiled(r"<[^>]*>");
    let slash = compiled(r"(?i)&(?:#x2f|#47);");
    let ampersand = compiled(r"(?i)&amp;");
    let plain = html.replace_all(value, "");
    let plain = slash.replace_all(&plain, "/");
    ampersand.replace_all(&plain, "&").trim().to_string()
}

pub fn hkex_documents(security: &str, rows: &[Value]) -> Vec<Value> {
    rows.iter().filter_map(|row| {
        let id = string(&row["NEWS_ID"]);
        let link = string(&row["FILE_LINK"]);
        let title = strip_html(&string(&row["TITLE"]));
        let date_text = string(&row["DATE_TIME"]);
        if !re(r"^\d{2}/\d{2}/\d{4}(?:\s+\d{2}:\d{2})?$",&date_text) { return None; }
        let date = NaiveDate::parse_from_str(date_text.get(..10)?,"%d/%m/%Y").ok()?.to_string();
        if id.is_empty() || link.is_empty() || title.is_empty() { return None; }
        let url = Url::parse(&format!("{HKEX}/")).ok()?.join(&link).ok()?;
        Some(json!({"registry":"hkex","securityCode":security,"documentId":id,"title":title,"publishedAt":date,"documentUrl":url.as_str(),
            "documentType":if text(&row["FILE_TYPE"]).is_empty(){Value::Null}else{json!(text(&row["FILE_TYPE"]))},"sourceLocator":format!("HKEXnews NEWS_ID={id}")}))
    }).collect()
}

fn unavailable(security: &str, code: &str, message: &str, retryable: bool) -> Value {
    json!({"registry":"hkex","securityCode":security,"documents":[],"availability":"unavailable","failure":{"code":code,"message":message,"retryable":retryable}})
}

/// One supported official HKEX index only; inactive issuer lookup is within
/// that same registry and never falls back to CNINFO or a quote provider.
pub async fn hkex_index(
    state: &AppState,
    raw_code: &str,
    from: &str,
    to: &str,
    page_size: usize,
) -> Result<Value> {
    let security = codes::normalize(raw_code);
    let Some((stock, "HK")) = security.rsplit_once('.') else {
        return Ok(unavailable(
            &security,
            "unsupported_security",
            "HKEX statutory filing lookup is restricted to HK securities.",
            false,
        ));
    };
    if !re(r"^\d{5}$", stock) {
        return Ok(unavailable(
            &security,
            "unsupported_security",
            "HKEX statutory filing lookup requires a five-digit HK stock code.",
            false,
        ));
    }
    let range = NaiveDate::parse_from_str(from, "%Y-%m-%d")
        .ok()
        .zip(NaiveDate::parse_from_str(to, "%Y-%m-%d").ok())
        .filter(|(start, end)| {
            start.to_string() == from
                && end.to_string() == to
                && start <= end
                && (*end - *start).num_days() <= 366
        });
    let Some((from, to)) = range else {
        return Ok(unavailable(
            &security,
            "invalid_date_range",
            "HKEX title search requires an inclusive date range of at most 366 days (YYYY-MM-DD).",
            false,
        ));
    };
    let result: Result<Vec<Value>> = async {
        let active = state.http.cached_json(&state.db,&format!("{HKEX}/ncms/script/eds/activestock_sehk_e.json"),HeaderMap::new(),7*DAY_MS,false).await?;
        let active = active.as_array().ok_or_else(||invalid("HKEX active-security index was not an array."))?;
        let issuer_id = |items:&[Value]|items.iter().find(|item|string(&item["c"])==stock && integer(&item["i"]).is_some()).and_then(|item|integer(&item["i"]));
        let mut issuer = issuer_id(active);
        if issuer.is_none() {
            let inactive = state.http.cached_json(&state.db,&format!("{HKEX}/ncms/script/eds/inactivestock_sehk_e.json"),HeaderMap::new(),7*DAY_MS,false).await?;
            issuer = issuer_id(inactive.as_array().ok_or_else(||invalid("HKEX inactive-security index was not an array."))?);
        }
        let Some(issuer) = issuer.filter(|id|*id!=0) else { return Err(anyhow::anyhow!("issuer_not_found")); };
        let mut url = Url::parse(&format!("{HKEX}/search/titleSearchServlet.do"))?;
        url.query_pairs_mut().extend_pairs([("sortDir","0"),("sortByOptions","DateTime"),("category","0"),("market","SEHK"),("stockId",&issuer.to_string()),
            ("documentType",""),("fromDate",&from.format("%Y%m%d").to_string()),("toDate",&to.format("%Y%m%d").to_string()),("title",""),("searchType","1"),
            ("t1code",""),("t2Gcode",""),("t2code",""),("rowRange",&page_size.clamp(1,1000).to_string()),("lang","E")]);
        let payload = state.http.cached_json(&state.db,url.as_str(),HeaderMap::new(),30*60_000,false).await?;
        let rows = parse_hkex_rows(&payload)?;
        let documents = hkex_documents(&security,&rows);
        if !rows.is_empty() && documents.is_empty() { return Err(invalid("HKEX title search returned rows but none contained an id, release date, title, and document URL.")); }
        Ok(documents)
    }.await;
    Ok(match result {
        Ok(documents) => {
            json!({"registry":"hkex","securityCode":security,"availability":if documents.is_empty(){"not_found"}else{"available"},"documents":documents,"failure":null})
        }
        Err(error) if error.to_string() == "issuer_not_found" => unavailable(
            &security,
            "issuer_not_found",
            &format!("HKEX active-security index did not contain {stock}."),
            false,
        ),
        Err(error) => {
            let invalid = error.downcast_ref::<InvalidRegistryResponse>().is_some();
            unavailable(
                &security,
                if invalid {
                    "upstream_response_invalid"
                } else {
                    "upstream_request_failed"
                },
                &error.to_string(),
                !invalid,
            )
        }
    })
}

async fn collect_hkex(state: &AppState, security: &str) -> Value {
    let today = Utc::now().date_naive();
    let from = today - Duration::days(365);
    let index = match hkex_index(state, security, &from.to_string(), &today.to_string(), 100).await
    {
        Ok(index) => index,
        Err(_) => {
            return collection(
                security,
                "source_failed",
                Some("hkex"),
                Vec::new(),
                Some("upstream_request_failed".into()),
            );
        }
    };
    if index["availability"] != "available" {
        return collection(
            security,
            if index["availability"] == "not_found" {
                "no_documents"
            } else {
                "source_failed"
            },
            Some("hkex"),
            Vec::new(),
            index["failure"]["code"].as_str().map(str::to_string),
        );
    }
    let records = index["documents"].as_array().into_iter().flatten().filter(|document|periodic(text(&document["title"]))).map(|document| {
        json!({"source":"hkex_filing","kind":"primary","security":security,"documentId":document["documentId"],"title":document["title"],"publishedAt":text(&document["publishedAt"]).get(..10).unwrap_or(""),"url":document["documentUrl"]})
    }).collect::<Vec<_>>();
    collection(
        security,
        if records.is_empty() {
            "no_documents"
        } else {
            "collected"
        },
        Some("hkex"),
        records,
        None,
    )
}

fn sec_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("stock-info/0.1 research@stock-info.local"),
    );
    headers
}

pub fn sec_filings(recent: &Value) -> Vec<Value> {
    recent["accessionNumber"].as_array().into_iter().flatten().enumerate().filter_map(|(index,_)| {
        let accession = text(&recent["accessionNumber"][index]);
        let primary = text(&recent["primaryDocument"][index]);
        let filed = text(&recent["filingDate"][index]);
        let report = text(&recent["reportDate"][index]);
        let form = text(&recent["form"][index]);
        if accession.is_empty() || primary.is_empty() || !re(r"^\d{4}-\d{2}-\d{2}$",filed) || form.is_empty() { return None; }
        Some(json!({"accessionNumber":accession,"primaryDocument":primary,"filingDate":filed,"reportDate":if re(r"^\d{4}-\d{2}-\d{2}$",report){report}else{""},"form":form}))
    }).collect()
}

pub fn sec_filing_url(cik: &str, filing: &Value) -> Option<String> {
    let accession = text(&filing["accessionNumber"]).replace('-', "");
    let document = text(&filing["primaryDocument"]);
    if !re(r"^\d+$", &accession) || !re(r"(?i)^[A-Za-z0-9._-]+\.(?:htm|html|xhtml)$", document) {
        return None;
    }
    let numeric_cik = cik.parse::<u64>().ok()?;
    Some(format!(
        "{SEC}/Archives/edgar/data/{numeric_cik}/{accession}/{document}"
    ))
}

pub async fn sec_registrant_index(state: &AppState, raw_code: &str) -> Result<Value> {
    let security = codes::normalize(raw_code);
    if !re(r"^[A-Z0-9.-]+\.US$", &security) {
        bail!("SEC XBRL verification only supports US securities: {raw_code}");
    }
    let ticker = security.strip_suffix(".US").unwrap();
    let candidates: HashSet<_> = [
        ticker.to_string(),
        ticker.replace('.', "-"),
        ticker.replace('-', "."),
    ]
    .into_iter()
    .collect();
    let payload = state
        .http
        .cached_json(
            &state.db,
            &format!("{SEC}/files/company_tickers.json"),
            sec_headers(),
            7 * DAY_MS,
            false,
        )
        .await?;
    let entries: Vec<&Value> = match &payload {
        Value::Object(map) => map.values().collect(),
        Value::Array(array) => array.iter().collect(),
        _ => Vec::new(),
    };
    let registrant = entries
        .into_iter()
        .find(|item| {
            candidates.contains(&text(&item["ticker"]).to_uppercase())
                && !string(&item["cik_str"]).is_empty()
        })
        .context(format!("SEC registrant CIK was not found for {ticker}"))?;
    let cik = string(&registrant["cik_str"]);
    if !re(r"^\d{1,10}$", &cik) {
        bail!("invalid SEC CIK");
    }
    let cik = format!("{cik:0>10}");
    let submissions = state
        .http
        .cached_json(
            &state.db,
            &format!("{SEC_DATA}/submissions/CIK{cik}.json"),
            sec_headers(),
            DAY_MS,
            false,
        )
        .await?;
    let mut filings = BTreeMap::new();
    for filing in sec_filings(&submissions["filings"]["recent"]) {
        filings.insert(string(&filing["accessionNumber"]), filing);
    }
    let mut pages = Vec::new();
    for file in submissions["filings"]["files"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let name = text(&file["name"]);
        if name.is_empty() {
            continue;
        }
        let address = Url::parse(&format!("{SEC_DATA}/submissions/"))?.join(name)?;
        if address.host_str() != Some("data.sec.gov")
            || !address.path().starts_with("/submissions/")
        {
            continue;
        }
        pages.push(async move {
            state
                .http
                .cached_json(&state.db, address.as_str(), sec_headers(), DAY_MS, false)
                .await
                .ok()
        });
    }
    // Preserve the original concurrent read-only overflow lookup; the shared
    // HTTP domain limiter owns the bound. Failure of one older index page
    // does not discard either recent filings or another successful page.
    for page in futures_util::future::join_all(pages)
        .await
        .into_iter()
        .flatten()
    {
        let recent = if page["filings"]["recent"].is_object() {
            &page["filings"]["recent"]
        } else {
            &page
        };
        for filing in sec_filings(recent) {
            filings.insert(string(&filing["accessionNumber"]), filing);
        }
    }
    Ok(
        json!({"securityCode":security,"ticker":ticker,"cik":cik,"entityName":if text(&registrant["title"]).is_empty(){Value::Null}else{json!(text(&registrant["title"]))},"companyFacts":{"facts":{}},"filings":filings.into_values().collect::<Vec<_>>()}),
    )
}

pub fn sec_records(security: &str, registrant: &Value) -> Vec<Value> {
    let mut records = registrant["filings"].as_array().into_iter().flatten().filter(|filing|re(r"(?i)^(10-K|10-Q|20-F|40-F)(/A)?$",text(&filing["form"]))).filter_map(|filing| {
        let url = sec_filing_url(text(&registrant["cik"]),filing)?;
        let published = text(&filing["filingDate"]).get(..10)?;
        if !re(r"^\d{4}-\d{2}-\d{2}$",published) { return None; }
        let entity = if text(&registrant["entityName"]).is_empty(){text(&registrant["ticker"])}else{text(&registrant["entityName"])};
        let form = text(&filing["form"]);
        let report = text(&filing["reportDate"]);
        let title = format!("{entity} {form}{}",if report.is_empty(){String::new()}else{format!(" ({report})")});
        Some(json!({"source":"sec_filing","kind":"primary","security":security,"documentId":filing["accessionNumber"],"title":title,"publishedAt":published,"url":url}))
    }).collect::<Vec<_>>();
    records.sort_by(|left, right| text(&right["publishedAt"]).cmp(text(&left["publishedAt"])));
    records
}

async fn collect_sec(state: &AppState, security: &str) -> Value {
    match sec_registrant_index(state, security).await {
        Ok(registrant) => {
            let records = sec_records(security, &registrant);
            collection(
                security,
                if records.is_empty() {
                    "no_documents"
                } else {
                    "collected"
                },
                Some("sec"),
                records,
                None,
            )
        }
        Err(error) => collection(
            security,
            "source_failed",
            Some("sec"),
            Vec::new(),
            Some(error_message(&error)),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn filing() -> Value {
        json!({"source":"cninfo_filing","kind":"primary","security":"600036.SH","documentId":"1218000001","title":"招商银行 2026 年半年度报告","publishedAt":"2026-08-22","url":"https://static.cninfo.com.cn/finalpage/2026-08-22/1218000001.PDF"})
    }
    #[test]
    fn primary_sources_are_security_bound_and_secondary_is_rejected() {
        assert_eq!(validate_record(&filing()), json!({"ok":true,"problems":[]}));
        let mut secondary = filing();
        secondary["source"] = json!("issuer_ir");
        secondary["kind"] = json!("secondary");
        secondary["url"] = json!("https://news.example.com/a");
        assert_eq!(
            validate_record(&secondary)["problems"],
            json!(["secondary_source_rejected"])
        );
        for (key, value, problem) in [
            ("documentId", "", "missing_document_id"),
            ("title", "  ", "missing_title"),
            ("publishedAt", "2026/08/22", "invalid_published_at"),
            ("publishedAt", " 2026-08-22 ", "invalid_published_at"),
            ("url", "http://static.cninfo.com.cn/x.pdf", "invalid_url"),
            ("source", "wechat_post", "unknown_source"),
            ("source", " cninfo_filing ", "unknown_source"),
            ("security", "", "missing_security"),
            ("url", "https://example.com/fake.pdf", "url_host_mismatch"),
        ] {
            let mut record = filing();
            record[key] = json!(value);
            assert!(
                validate_record(&record)["problems"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(problem))
            );
        }
        assert_eq!(can_verify_identity("600036.SH", &[filing()])["ok"], true);
        assert_eq!(
            can_verify_identity("03968.HK", &[filing()])["problems"],
            json!(["no_evidence_for_security"])
        );
        let mut quote = filing();
        quote["source"] = json!("exchange_quote");
        quote["url"] = json!("https://quote.example.com/600036");
        assert_eq!(
            can_verify_identity("600036.SH", &[quote])["problems"],
            json!(["no_identity_source"])
        );
        assert_eq!(latest_evidence_date(&[secondary]), None);
        let mut newer = filing();
        newer["publishedAt"] = json!("2026-09-30");
        assert_eq!(
            latest_evidence_date(&[filing(), newer]),
            Some("2026-09-30".into())
        );
        let securities = vec!["600036.SH".to_string(), "03968.HK".to_string()];
        assert_eq!(
            evidence_coverage(&securities, &[filing()]),
            json!({"covered":["600036.SH"],"missing":["03968.HK"],"total":2})
        );
        assert_eq!(
            identity_report(&securities, &[filing()])[1]["verified"],
            false
        );
    }
    #[test]
    fn registry_hosts_are_not_interchangeable() {
        let mut record = filing();
        record["source"] = json!("hkex_filing");
        record["url"] = json!("https://www1.hkexnews.hk/x.pdf");
        assert_eq!(validate_record(&record)["ok"], true);
        record["source"] = json!("sec_filing");
        assert_eq!(validate_record(&record)["ok"], false);
        record["url"] = json!("https://www.sec.gov/Archives/edgar/data/1045810/x.htm");
        assert_eq!(validate_record(&record)["ok"], true);
        record["url"] = json!("https://sec.gov.evil.example/x.htm");
        assert_eq!(
            validate_record(&record)["problems"],
            json!(["url_host_mismatch"])
        );
    }
    #[test]
    fn periodic_filter_finds_quarter_reports_without_di_prefix() {
        let notices = vec![
            json!({"artCode":"1","title":"2026年三季度报告","noticeDate":"2026-10-29","pdfUrl":"https://static.cninfo.com.cn/a.pdf"}),
            json!({"artCode":"2","title":"董事会决议公告","noticeDate":"2026-10-29","pdfUrl":"https://static.cninfo.com.cn/b.pdf"}),
        ];
        assert_eq!(cninfo_records("600036.SH", &notices).len(), 1);
        assert!(periodic("Annual Report"));
    }
    #[test]
    fn hkex_requires_valid_result_array_and_real_registry_dates() {
        for payload in [
            json!(null),
            json!([]),
            json!({}),
            json!({"result":"{"}),
            json!({"result":"{}"}),
        ] {
            assert!(parse_hkex_rows(&payload).is_err());
        }
        let rows=parse_hkex_rows(&json!({"result":"[null,1,{}, {\"NEWS_ID\":1,\"TITLE\":\"Annual &amp; Interim Report\",\"DATE_TIME\":\"22/08/2026 16:30\",\"FILE_LINK\":\"/listedco/a.pdf\"}]"})).unwrap();
        assert_eq!(rows.len(), 2);
        let docs = hkex_documents("00981.HK", &rows);
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["publishedAt"], "2026-08-22");
        assert_eq!(docs[0]["title"], "Annual & Interim Report");
        assert_eq!(
            docs[0]["documentUrl"],
            "https://www1.hkexnews.hk/listedco/a.pdf"
        );
        assert!(hkex_documents("00981.HK",&[json!({"NEWS_ID":1,"TITLE":"Annual report","DATE_TIME":"31/02/2026","FILE_LINK":"/a.pdf"})]).is_empty());
    }
    #[test]
    fn sec_includes_foreign_periodic_forms_and_excludes_current_reports_and_viewers() {
        let recent = json!({"accessionNumber":["0000000001-26-000001","0000000001-26-000002","0000000001-26-000003","0000000001-26-000004"],"primaryDocument":["annual.htm","current.htm","xsl/viewer.xml","quarter.xhtml"],"filingDate":["2026-08-22","2026-09-01","2026-09-01","2026-10-29"],"reportDate":["2026-06-30","","","2026-09-30"],"form":["20-F","6-K","40-F","10-Q/A"]});
        let filings = sec_filings(&recent);
        assert_eq!(filings.len(), 4);
        let registrant =
            json!({"ticker":"TSM","entityName":"TSMC","cik":"0000000001","filings":filings});
        let records = sec_records("TSM.US", &registrant);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["documentId"], "0000000001-26-000004");
        assert_eq!(records[1]["title"], "TSMC 20-F (2026-06-30)");
        assert_eq!(
            records[1]["url"],
            "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/annual.htm"
        );
        assert_eq!(can_verify_identity("TSM.US", &records)["ok"], true);
    }
    #[test]
    fn error_messages_are_unicode_safe_and_bounded() {
        let message = "失败".repeat(300);
        assert_eq!(
            error_message(&anyhow::anyhow!(message)).chars().count(),
            200
        );
        assert_eq!(expected_registry("600036"), Some("cninfo"));
        assert_eq!(expected_registry("00700.HK"), Some("hkex"));
        assert_eq!(expected_registry("NVDA.US"), Some("sec"));
        assert_eq!(expected_registry("019785.OF"), None);
    }

    async fn cached_response(state: &AppState, url: &str, headers: HeaderMap, payload: Value) {
        // Reuse the runtime serializer: its struct field order is part of the
        // durable cache contract, unlike serde_json::Value's sorted object keys.
        let key = crate::http::cache_key("GET", url, &headers, None).unwrap();
        let now = Utc::now().timestamp_millis();
        state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?)", vec![key.into(),url.into(),payload.to_string().into(),(now+DAY_MS).into(),now.into()]).await.unwrap();
    }

    fn fixture_state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("fixture.sqlite")).unwrap();
        // Use the historical schema verbatim; no invented tables or schema
        // initialization changes are needed for registry/cache fixtures.
        db.connect()
            .unwrap()
            .execute_batch(include_str!(
                "../../../migrations/0002_external_call_cache.sql"
            ))
            .unwrap();
        let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
        (dir, state)
    }

    #[tokio::test]
    async fn sec_collection_uses_full_cached_official_index_including_overflow() {
        let (_dir, state) = fixture_state();
        cached_response(
            &state,
            "https://www.sec.gov/files/company_tickers.json",
            sec_headers(),
            json!({"0":{"ticker":"TSM","cik_str":1,"title":"TSMC"}}),
        )
        .await;
        cached_response(&state,"https://data.sec.gov/submissions/CIK0000000001.json",sec_headers(),json!({"filings":{"recent":{"accessionNumber":["0000000001-26-000003"],"primaryDocument":["current.htm"],"filingDate":["2026-10-29"],"reportDate":[""],"form":["6-K"]},"files":[{"name":"CIK0000000001-submissions-001.json"}]}})).await;
        cached_response(&state,"https://data.sec.gov/submissions/CIK0000000001-submissions-001.json",sec_headers(),json!({"accessionNumber":["0000000001-26-000001"],"primaryDocument":["annual.htm"],"filingDate":["2026-08-22"],"reportDate":["2026-06-30"],"form":["20-F"]})).await;
        let data = collect(&state, "TSM.US").await.unwrap();
        assert_eq!(data["status"], "collected");
        assert_eq!(data["registry"], "sec");
        assert_eq!(data["recordCount"], 1);
        assert_eq!(data["validRecords"], 1);
        assert_eq!(data["identityVerified"], true);
        assert_eq!(data["lastEvidenceDate"], "2026-08-22");
        assert_eq!(data["records"][0]["documentId"], "0000000001-26-000001");
        assert_eq!(data["failure"], Value::Null);
        let request_count = state
            .db
            .query("SELECT COUNT(*) AS n FROM http_cache", Vec::new())
            .await
            .unwrap();
        assert_eq!(
            request_count[0]["n"], 3,
            "identity lookup must not download company-facts financial data"
        );
    }

    #[tokio::test]
    async fn hkex_failures_distinguish_bad_payload_unknown_issuer_and_date_range() {
        let (_dir, state) = fixture_state();
        cached_response(
            &state,
            "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_e.json",
            HeaderMap::new(),
            json!({"not":"an array"}),
        )
        .await;
        let bad = hkex_index(&state, "00981.HK", "2025-10-29", "2026-10-29", 100)
            .await
            .unwrap();
        assert_eq!(bad["failure"]["code"], "upstream_response_invalid");
        assert_eq!(bad["failure"]["retryable"], false);
        let bad_range = hkex_index(&state, "00981.HK", "2024-10-29", "2026-10-29", 100)
            .await
            .unwrap();
        assert_eq!(bad_range["failure"]["code"], "invalid_date_range");

        let (_other, other) = fixture_state();
        cached_response(
            &other,
            "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_e.json",
            HeaderMap::new(),
            json!([]),
        )
        .await;
        cached_response(
            &other,
            "https://www1.hkexnews.hk/ncms/script/eds/inactivestock_sehk_e.json",
            HeaderMap::new(),
            json!([]),
        )
        .await;
        let missing = hkex_index(&other, "00981.HK", "2025-10-29", "2026-10-29", 100)
            .await
            .unwrap();
        assert_eq!(missing["availability"], "unavailable");
        assert_eq!(missing["failure"]["code"], "issuer_not_found");
        assert_eq!(missing["failure"]["retryable"], false);
    }

    #[tokio::test]
    async fn hkex_collection_keeps_raw_count_but_identity_uses_valid_primary_rows_only() {
        let (_dir, state) = fixture_state();
        cached_response(
            &state,
            "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_e.json",
            HeaderMap::new(),
            json!([{"i":77.0,"c":"00981"}]),
        )
        .await;
        let today = Utc::now().date_naive();
        let from = today - Duration::days(365);
        let mut url = Url::parse("https://www1.hkexnews.hk/search/titleSearchServlet.do").unwrap();
        url.query_pairs_mut().extend_pairs([
            ("sortDir", "0"),
            ("sortByOptions", "DateTime"),
            ("category", "0"),
            ("market", "SEHK"),
            ("stockId", "77"),
            ("documentType", ""),
            ("fromDate", &from.format("%Y%m%d").to_string()),
            ("toDate", &today.format("%Y%m%d").to_string()),
            ("title", ""),
            ("searchType", "1"),
            ("t1code", ""),
            ("t2Gcode", ""),
            ("t2code", ""),
            ("rowRange", "100"),
            ("lang", "E"),
        ]);
        let rows = json!([
            {"NEWS_ID":1,"TITLE":"Annual Report","DATE_TIME":"22/08/2026 16:30","FILE_LINK":"/listedco/annual.pdf"},
            {"NEWS_ID":2,"TITLE":"Interim report","DATE_TIME":"30/09/2026 16:30","FILE_LINK":"https://evil.example/interim.pdf"},
            {"NEWS_ID":3,"TITLE":"Board resolutions","DATE_TIME":"29/10/2026 16:30","FILE_LINK":"/listedco/notice.pdf"}
        ]);
        cached_response(
            &state,
            url.as_str(),
            HeaderMap::new(),
            json!({"result":rows.to_string()}),
        )
        .await;
        let data = collect(&state, "00981.HK").await.unwrap();
        assert_eq!(data["status"], "collected");
        assert_eq!(data["recordCount"], 2);
        assert_eq!(data["validRecords"], 1);
        assert_eq!(data["identityVerified"], true);
        assert_eq!(data["lastEvidenceDate"], "2026-08-22");
        assert_eq!(data["records"][0]["security"], "00981.HK");
        assert_eq!(
            can_verify_identity("688981.SH", data["records"].as_array().unwrap())["ok"],
            false
        );
    }
}
