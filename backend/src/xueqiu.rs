use crate::{AppState, codes, http::number};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration};
use reqwest::{
    Method, Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};

pub fn cookie(state: &AppState) -> Result<String> {
    let configured = state.setting("LOCAL_XUEQIU_CREDENTIAL_STORE");
    let path = if configured.is_empty() {
        state.data_dir().join("runtime/xueqiu-credential.json")
    } else {
        state.root.join(configured)
    };
    let cookie = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)?
            .get("cookie")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let cookie = if cookie.is_empty() {
        state.setting("XUEQIU_COOKIE")
    } else {
        cookie
    };
    if cookie.trim().is_empty() {
        bail!("XUEQIU_COOKIE is required for Xueqiu stock requests");
    }
    Ok(cookie.trim().to_string())
}

fn headers(cookie: &str) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    for (name, value) in [
        ("cookie", cookie),
        ("referer", "https://xueqiu.com/"),
        (
            "user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        ),
        ("accept", "application/json"),
        ("accept-language", "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"),
        ("cache-control", "no-cache"),
        ("pragma", "no-cache"),
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
            HeaderValue::from_str(value)?,
        );
    }
    Ok(headers)
}

pub fn validate_body(text: &str) -> Result<Value> {
    if text.trim_start().starts_with('<') {
        if ["人机验证", "访问触发保护", "service/captcha"]
            .iter()
            .any(|s| text.contains(s))
        {
            bail!(
                "雪球访问触发保护，K线暂不可用。请在当前网络的浏览器打开 https://www.xueqiu.com/service/captcha 完成人机验证，再刷新本地雪球 Cookie 后重试。"
            );
        }
        bail!("雪球接口返回 HTML 而非行情数据，请检查雪球访问状态");
    }
    let body: Value = serde_json::from_str(text).context("雪球接口返回无效 JSON")?;
    if !body.is_object() {
        bail!("雪球接口返回无效数据结构");
    }
    let error_code = body["error_code"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| body["error_code"].to_string());
    let description = body["error_description"].as_str().unwrap_or("");
    if error_code == "400016"
        || description.contains("重新登录")
        || description.to_lowercase().contains("login")
        || (description.contains("登录") && description.contains("失效"))
    {
        bail!("雪球 Cookie 已失效或被拒绝，请刷新本地雪球 Cookie 后重试。");
    }
    if !body["error_code"].is_null() && error_code != "0" {
        bail!("雪球行情请求失败：{description}");
    }
    Ok(body)
}

pub fn map_kline(body: &Value, code: &str, fq: &str, now: i64) -> Result<Vec<Value>> {
    let columns = body["data"]["column"]
        .as_array()
        .context("雪球K线数据缺少行情字段")?;
    let items = body["data"]["item"]
        .as_array()
        .context("雪球K线数据缺少行情数据")?;
    for key in ["timestamp", "open", "high", "low", "close"] {
        if !columns.iter().any(|v| v.as_str() == Some(key)) {
            bail!("Xueqiu K-line response missing required column: {key}");
        }
    }
    let mut rows = Vec::new();
    for item in items.iter().filter(|item| item.is_array()) {
        let get = |name: &str| -> Option<f64> {
            number(&item[columns.iter().position(|v| v.as_str() == Some(name))?])
        };
        let Some(timestamp) = get("timestamp")
            .and_then(|t| DateTime::from_timestamp_millis(t as i64))
            .and_then(|t| t.checked_add_signed(Duration::hours(8)))
        else {
            continue;
        };
        let mut row = json!({"code":code,"period":"day","fq":fq,"updatedAt":now,"date":timestamp.format("%Y-%m-%d").to_string(),"source":"xueqiu","amplitude":null});
        for (target, source) in [
            ("volume", "volume"),
            ("open", "open"),
            ("high", "high"),
            ("low", "low"),
            ("close", "close"),
            ("turnover", "turnoverrate"),
            ("pctChange", "percent"),
            ("changeAmount", "chg"),
            ("amount", "amount"),
            ("peTtm", "pe"),
            ("pb", "pb"),
            ("ps", "ps"),
            ("pcf", "pcf"),
            ("marketCapital", "market_capital"),
            ("balance", "balance"),
        ] {
            row[target] = json!(get(source));
        }
        rows.push(row);
    }
    Ok(rows)
}

async fn validated_cached(
    state: &AppState,
    url: &str,
    key: &str,
    bypass: bool,
    validate: impl Fn(&Value) -> Result<()> + Send + Sync,
) -> Result<String> {
    let cookie = cookie(state)?;
    let now = chrono::Utc::now().timestamp_millis();
    if !bypass {
        let rows = state
            .db
            .query(
                "SELECT body_text FROM http_cache WHERE cache_key=? AND expires_at>?",
                vec![key.into(), now.into()],
            )
            .await?;
        if let Some(text) = rows.first().and_then(|v| v["body_text"].as_str()) {
            let valid = validate_body(text).and_then(|body| validate(&body));
            if valid.is_ok() {
                return Ok(text.to_string());
            }
            state
                .db
                .execute("DELETE FROM http_cache WHERE cache_key=?", vec![key.into()])
                .await?;
        }
    }
    let text = state
        .http
        .text(url, Method::GET, headers(&cookie)?, None)
        .await?;
    let body = validate_body(&text)?;
    validate(&body)?;
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?) ON CONFLICT(cache_key) DO UPDATE SET body_text=excluded.body_text,status=200,expires_at=excluded.expires_at,updated_at=excluded.updated_at",vec![key.into(),url.into(),text.clone().into(),(now+600_000).into(),now.into()]).await?;
    Ok(text)
}

pub async fn stock_kline(
    state: &AppState,
    code: &str,
    fq: &str,
    to: &str,
) -> Result<(Vec<Value>, String)> {
    stock_kline_with_refresh(state, code, fq, to, false).await
}

pub async fn stock_kline_with_refresh(
    state: &AppState,
    code: &str,
    fq: &str,
    to: &str,
    bypass: bool,
) -> Result<(Vec<Value>, String)> {
    let symbol = codes::xueqiu_symbol(code).context("unsupported Xueqiu stock code")?;
    let date = chrono::NaiveDate::parse_from_str(to, "%Y-%m-%d")?;
    let begin = date
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis()
        + 86_400_000;
    let mut url = Url::parse("https://stock.xueqiu.com/v5/stock/chart/kline.json")?;
    let fq_parameter = match fq {
        "qfq" | "before" => "before",
        "hfq" | "after" => "after",
        _ => "normal",
    };
    url.query_pairs_mut().extend_pairs([
        ("symbol", symbol.as_str()),
        ("begin", &begin.to_string()),
        ("period", "day"),
        ("type", fq_parameter),
        ("count", "-7500"),
        (
            "indicator",
            "kline,pe,pb,ps,pcf,market_capital,agt,ggt,balance",
        ),
    ]);
    let key = format!("xueqiu:kline:v1:{code}:day:{fq}:{to}");
    let text = validated_cached(state, url.as_str(), &key, bypass, |body| {
        map_kline(body, code, fq, chrono::Utc::now().timestamp_millis()).map(|_| ())
    })
    .await?;
    let rows = map_kline(
        &validate_body(&text)?,
        code,
        fq,
        chrono::Utc::now().timestamp_millis(),
    )?;
    Ok((rows, text))
}

pub fn parse_quote(body: &Value, code: &str) -> Result<Value> {
    let symbol = codes::xueqiu_symbol(code).context("不支持的雪球行情标的")?;
    let currency = if code.ends_with(".US") {
        "USD"
    } else if code.ends_with(".HK") {
        "HKD"
    } else {
        "CNY"
    };
    let quote = &body["data"]["quote"];
    let market_cap = number(&quote["market_capital"])
        .filter(|n| *n > 0.0)
        .context("雪球行情市值无效")?;
    let timestamp = number(&quote["timestamp"])
        .filter(|n| *n > 0.0)
        .and_then(|n| DateTime::from_timestamp_millis(n as i64))
        .context("雪球行情时间无效")?;
    if quote["symbol"].as_str() != Some(&symbol) || quote["currency"].as_str() != Some(currency) {
        bail!("雪球行情标的或币种无效");
    }
    let zone = if currency == "USD" {
        chrono_tz::America::New_York
    } else {
        chrono_tz::Asia::Shanghai
    };
    Ok(
        json!({"currency":currency,"marketCap":market_cap,"priceAsOf":timestamp.with_timezone(&zone).format("%Y-%m-%d").to_string(),"fetchedAt":chrono::Utc::now().to_rfc3339()}),
    )
}

pub async fn stock_quote(state: &AppState, code: &str, bypass: bool) -> Result<Value> {
    let symbol = codes::xueqiu_symbol(code).context("不支持的雪球行情标的")?;
    let mut url = Url::parse("https://stock.xueqiu.com/v5/stock/quote.json")?;
    url.query_pairs_mut()
        .extend_pairs([("symbol", symbol.as_str()), ("extend", "detail")]);
    let key = format!("xueqiu:quote:v1:{code}");
    let text = validated_cached(state, url.as_str(), &key, bypass, |body| {
        parse_quote(body, code).map(|_| ())
    })
    .await?;
    parse_quote(&validate_body(&text)?, code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_challenge_and_column_validation() {
        for text in [
            "<html>人机验证</html>",
            "{\"error_code\":400016}",
            "[]",
            "null",
            "{\"error_code\":1}",
        ] {
            assert!(validate_body(text).is_err());
        }
        let body = json!({"data":{"column":["close","timestamp","open","high","low","pe"],"item":[[10,1793232000000_i64,9,11,8,15]]}});
        let rows = map_kline(&body, "600036.SH", "normal", 1).unwrap();
        assert_eq!(rows[0]["close"], 10.0);
        assert_eq!(rows[0]["peTtm"], 15.0);
        assert_eq!(rows[0]["volume"], Value::Null);
        assert_eq!(rows[0]["source"], "xueqiu");
        assert!(
            map_kline(
                &json!({"data":{"column":[],"item":[]}}),
                "600036.SH",
                "normal",
                1
            )
            .is_err()
        );
    }
}
