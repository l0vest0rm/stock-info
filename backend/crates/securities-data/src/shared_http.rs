//! Public, account-free caches shared by host runtimes. Transport, including proxy and
//! size limits, remains injected. Never wrap arbitrary HTTP or authenticated requests.
use crate::{data_cache::Cache, http::parse_json_or_jsonp};
use anyhow::{Result, ensure};
use reqwest::{Url, header::HeaderMap};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, future::Future};

const DAY: i64 = 86_400_000;
const PRIMARY: &str = "securities.statement-http.v1";
const PREFIX: &str = "financial-public-cn:v1:";
#[derive(Clone, Copy)]
enum Kind {
    Report,
    Notice,
    Dividend,
    Summary,
    Earnings,
    Lookup,
    Announcement,
    Statement,
}
fn endpoint(raw: &str) -> Option<(Url, Kind)> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let (kind, allowed): (_, &[&str]) = match (url.host_str()?, url.path()) {
        ("reportapi.eastmoney.com", "/report/list") => (
            Kind::Report,
            &[
                "cb",
                "industryCode",
                "pageSize",
                "industry",
                "rating",
                "ratingChange",
                "beginTime",
                "endTime",
                "pageNo",
                "fields",
                "qType",
                "orgCode",
                "code",
                "rcode",
                "_",
            ],
        ),
        ("np-anotice-stock.eastmoney.com", "/api/security/ann") => (
            Kind::Notice,
            &[
                "cb",
                "sr",
                "page_size",
                "page_index",
                "ann_type",
                "client_source",
                "stock_list",
                "f_node",
                "s_node",
                "_",
            ],
        ),
        (
            "datacenter.eastmoney.com" | "datacenter-web.eastmoney.com",
            "/securities/api/data/v1/get",
        ) => (
            Kind::Dividend,
            &[
                "reportName",
                "columns",
                "quoteColumns",
                "filter",
                "pageNumber",
                "pageSize",
                "sortTypes",
                "sortColumns",
                "source",
                "client",
            ],
        ),
        ("datacenter-web.eastmoney.com", "/api/data/v1/get") => (
            Kind::Summary,
            &[
                "reportName",
                "columns",
                "filter",
                "sortColumns",
                "sortTypes",
                "pageSize",
                "pageNumber",
            ],
        ),
        ("datacenter-web.eastmoney.com", "/securities/api/data/get") => (
            Kind::Statement,
            &[
                "type", "sty", "filter", "p", "ps", "sr", "st", "source", "client",
            ],
        ),
        ("www.cninfo.com.cn", "/new/information/topSearch/query") => {
            (Kind::Lookup, &["keyWord", "maxNum"])
        }
        ("www.cninfo.com.cn", "/new/hisAnnouncement/query") => (Kind::Announcement, &[]),
        _ => return None,
    };
    let mut pairs = BTreeMap::new();
    for (k, v) in url.query_pairs() {
        if !allowed.contains(&k.as_ref()) || pairs.insert(k, v).is_some() {
            return None;
        }
    }
    let report = pairs.get("reportName").map(|v| v.as_ref());
    if matches!(kind, Kind::Dividend)
        && !matches!(
            report,
            Some("RPT_F10_DIVIDEND_MAIN" | "RPT_F10_DIVIDEND_SEO" | "RPT_F10_EH_EQUITY")
        )
    {
        return None;
    }
    let kind = if matches!(kind, Kind::Summary) {
        match report {
            Some("RPT_VALUEANALYSIS_DET") => Kind::Summary,
            Some("RPT_FCI_PERFORMANCEE" | "RPT_PUBLIC_OP_NEWPREDICT") => Kind::Earnings,
            _ => return None,
        }
    } else {
        kind
    };
    Some((url, kind))
}
pub fn supports_get(raw: &str) -> bool {
    matches!(
        endpoint(raw),
        Some((
            _,
            Kind::Report | Kind::Notice | Kind::Dividend | Kind::Summary | Kind::Earnings
        ))
    )
}
pub fn supports_post(raw: &str) -> bool {
    matches!(endpoint(raw), Some((_, Kind::Lookup | Kind::Announcement)))
}
fn public_headers(h: &HeaderMap) -> Result<Vec<(String, Vec<u8>)>> {
    let mut values = vec![];
    for (k, v) in h {
        ensure!(
            matches!(
                k.as_str(),
                "accept"
                    | "referer"
                    | "user-agent"
                    | "origin"
                    | "content-type"
                    | "x-requested-with"
            ),
            "non-public request header"
        );
        values.push((k.to_string(), v.as_bytes().to_vec()));
    }
    values.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(values)
}
fn request_key(url: &Url, kind: Kind, headers: &HeaderMap) -> Result<Value> {
    let query: BTreeMap<_, _> = url
        .query_pairs()
        .filter(|(k, _)| {
            !matches!(kind, Kind::Report | Kind::Notice) || !matches!(k.as_ref(), "cb" | "_")
        })
        .collect();
    Ok(json!([
        url.origin().ascii_serialization(),
        url.path(),
        query,
        public_headers(headers)?
    ]))
}
fn check_rows(body: &Value, url: &Url) -> Result<()> {
    ensure!(
        body["success"] == true,
        "source rejected public finance request"
    );
    let rows = body["result"]["data"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid public finance rows"))?;
    let filter = url
        .query_pairs()
        .find(|(k, _)| k == "filter")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let code = filter
        .strip_prefix("(SECUCODE=\"")
        .and_then(|s| s.split_once("\")"))
        .map(|(s, _)| s);
    for row in rows {
        ensure!(row.is_object(), "invalid financial record");
        if let (Some(expected), Some(actual)) = (code, row.get("SECUCODE").and_then(Value::as_str))
        {
            ensure!(actual == expected, "financial identity mismatch");
        }
    }
    Ok(())
}
pub fn empty_public_rows(raw: &str, body: &Value) -> bool {
    matches!(endpoint(raw), Some((_, Kind::Dividend | Kind::Earnings)))
        && body["success"] == false
        && body["code"] == 9201
        && body["message"] == "返回数据为空"
        && body["result"].is_null()
}
pub fn is_primary_key(key: &str) -> bool {
    key.strip_prefix(PREFIX).is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn read_primary(cache: &Cache, key: &str, now: i64) -> Option<String> {
    if !is_primary_key(key) {
        return None;
    }
    cache.read_text(PRIMARY, key, now)
}
pub fn write_primary(
    cache: &Cache,
    key: &str,
    raw: &str,
    text: &str,
    expires: i64,
    now: i64,
) -> Result<()> {
    let Some((url, Kind::Statement)) = endpoint(raw) else {
        anyhow::bail!("unsupported statement source");
    };
    ensure!(
        key == format!("{PREFIX}{:x}", Sha256::digest(raw.as_bytes())),
        "statement key mismatch"
    );
    check_rows(&parse_json_or_jsonp(text)?, &url)?;
    cache.write_text(
        PRIMARY,
        key,
        text,
        now,
        expires.min(now.saturating_add(DAY)),
    );
    Ok(())
}

pub async fn cached_get<F>(
    cache: &Cache,
    raw: &str,
    h: &HeaderMap,
    ttl: i64,
    load: impl FnOnce() -> F,
) -> Result<Value>
where
    F: Future<Output = Result<String>>,
{
    let Some((
        url,
        kind @ (Kind::Report | Kind::Notice | Kind::Dividend | Kind::Summary | Kind::Earnings),
    )) = endpoint(raw)
    else {
        anyhow::bail!("unsupported public GET");
    };
    let key = request_key(&url, kind, h)?;
    cache
        .fetch(
            "securities.public-get.v1",
            &key,
            ttl.clamp(0, DAY),
            || async {
                let body = parse_json_or_jsonp(&load().await?)?;
                match kind {
                    Kind::Report | Kind::Notice => {
                        let entries = if matches!(kind, Kind::Report) {
                            &body["data"]
                        } else {
                            &body["data"]["list"]
                        };
                        let rows = entries
                            .as_array()
                            .ok_or_else(|| anyhow::anyhow!("invalid disclosure list"))?;
                        ensure!(
                            body["success"] != false && rows.iter().all(Value::is_object),
                            "invalid disclosure rows"
                        );
                        if matches!(kind, Kind::Report)
                            && let Some((_, code)) = url.query_pairs().find(|(k, _)| k == "code")
                        {
                            ensure!(
                                rows.iter().all(|r| r
                                    .get("stockCode")
                                    .and_then(Value::as_str)
                                    .is_none_or(|s| s == code)),
                                "research report identity mismatch"
                            );
                        }
                    }
                    Kind::Dividend | Kind::Earnings if empty_public_rows(raw, &body) => {
                        return Ok(json!({"success":true,"result":{"data":[]}}));
                    }
                    Kind::Dividend | Kind::Summary | Kind::Earnings => check_rows(&body, &url)?,
                    _ => unreachable!(),
                }
                Ok(body)
            },
        )
        .await
}
pub async fn cached_post<F>(
    cache: &Cache,
    raw: &str,
    h: &HeaderMap,
    body: Option<&str>,
    ttl: i64,
    load: impl FnOnce() -> F,
) -> Result<Value>
where
    F: Future<Output = Result<String>>,
{
    let Some((url, kind @ (Kind::Lookup | Kind::Announcement))) = endpoint(raw) else {
        anyhow::bail!("unsupported public POST");
    };
    let mut form = BTreeMap::new();
    if matches!(kind, Kind::Lookup) {
        ensure!(body.is_none(), "invalid lookup payload");
    } else {
        let mut parsed = url.clone();
        parsed.set_query(Some(
            body.ok_or_else(|| anyhow::anyhow!("missing notice form"))?,
        ));
        for (k, v) in parsed.query_pairs() {
            ensure!(
                matches!(
                    k.as_ref(),
                    "stock"
                        | "tabName"
                        | "pageSize"
                        | "pageNum"
                        | "column"
                        | "category"
                        | "plate"
                        | "seDate"
                        | "searchkey"
                        | "secid"
                        | "sortName"
                        | "sortType"
                        | "isHLtitle"
                ) && form.insert(k.into_owned(), v.into_owned()).is_none(),
                "invalid notice form"
            );
        }
    }
    let key = (request_key(&url, kind, h)?, form);
    cache
        .fetch(
            "securities.cninfo.read-post.v1",
            &key,
            ttl.clamp(0, DAY),
            || async {
                let v = parse_json_or_jsonp(&load().await?)?;
                ensure!(
                    if matches!(kind, Kind::Lookup) {
                        v.is_array()
                    } else {
                        v["announcements"].is_array()
                            || (v["totalAnnouncement"] == 0
                                && v.get("announcements") == Some(&Value::Null))
                    },
                    "invalid CNINFO response"
                );
                Ok(v)
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_is_limited_to_known_public_representation() {
        let base = "https://reportapi.eastmoney.com/report/list";
        for url in [
            format!("{base}?secret=123"),
            format!("{base}?code=a&code=b"),
            format!("{base}#part"),
            base.replace("https://", "https://a:b@"),
            base.replace("https://", "http://"),
        ] {
            assert!(!supports_get(&url));
        }
        let u = Url::parse(base).unwrap();
        let mut h = HeaderMap::new();
        h.insert("authorization", "private".parse().unwrap());
        assert!(request_key(&u, Kind::Report, &h).is_err());
        assert!(!supports_post("https://www.cninfo.com.cn/private/query"));
    }
    #[test]
    fn primary_policy_rejects_forged_key_invalid_payload_and_caps_expiry() {
        let dir = std::env::temp_dir().join(format!("public-primary-{}", rand::random::<u64>()));
        let cache = Cache::at(dir.join("cache.sqlite3"));
        let url = "https://datacenter-web.eastmoney.com/securities/api/data/get?type=RPT_F10_FINANCE_GINCOMEQC&filter=(SECUCODE%3D%22600519.SH%22)";
        let key = format!("{PREFIX}{:x}", Sha256::digest(url));
        assert!(
            write_primary(
                &cache,
                &key,
                &url.replace("GINCOMEQC", "GOTHER"),
                "{}",
                100,
                1
            )
            .is_err()
        );
        assert!(
            write_primary(
                &cache,
                &key,
                url,
                r#"{"success":false,"result":{"data":[]}}"#,
                100,
                1
            )
            .is_err()
        );
        assert!(
            write_primary(
                &cache,
                &key,
                url,
                r#"{"success":true,"result":{"data":[{"SECUCODE":"000001.SZ"}]}}"#,
                100,
                1
            )
            .is_err()
        );
        assert!(read_primary(&cache, &key, 2).is_none());
        let ok = r#"{"success":true,"result":{"data":[]}}"#;
        write_primary(&cache, &key, url, ok, 10 * DAY, 1).unwrap();
        assert_eq!(read_primary(&cache, &key, DAY).as_deref(), Some(ok));
        assert_eq!(read_primary(&cache, &key, DAY + 1), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod earnings_tests {
    use super::*;
    #[tokio::test]
    async fn by_company_and_by_report_period_use_distinct_reusable_rows() {
        let dir = std::env::temp_dir().join(format!("shared-earnings-{}", rand::random::<u64>()));
        let cache = Cache::at(dir.join("kv.sqlite3"));
        let h = HeaderMap::new();
        let base = "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_FCI_PERFORMANCEE&pageNumber=1&filter=";
        let one = format!("{base}%28SECUCODE%3D%22600519.SH%22%29");
        let market = format!("{base}%28REPORT_DATE%3D%272026-09-30%27%29");
        let failure = r#"{"success":false,"code":9201,"message":"other","result":null}"#;
        assert!(
            cached_get(&cache, &one, &h, 600000, || async { Ok(failure.into()) })
                .await
                .is_err()
        );
        let empty = r#"{"success":false,"code":9201,"message":"返回数据为空","result":null}"#;
        let response = cached_get(&cache, &one, &h, 600000, || async { Ok(empty.into()) })
            .await
            .unwrap();
        assert_eq!(response["result"]["data"], json!([]));
        assert_eq!(
            response,
            cached_get(&cache, &one, &h, 600000, || async {
                anyhow::bail!("unexpected upstream")
            })
            .await
            .unwrap()
        );
        let result = cached_get(&cache, &market, &h, 600000, || async {
            Ok(r#"{"success":true,"result":{"data":[{"SECUCODE":"000001.SZ"}]}}"#.into())
        })
        .await
        .unwrap();
        assert_eq!(result["result"]["data"][0]["SECUCODE"], "000001.SZ");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
