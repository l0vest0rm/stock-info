use crate::{
    AppState, cache_policy, codes,
    http::{number, parse_json_or_jsonp},
};
use anyhow::{Context, Result, bail};
use chrono::{Datelike, Duration, Local, Utc};
use reqwest::{
    Method, Url,
    header::{ACCEPT, HeaderMap, HeaderValue, REFERER, USER_AGENT},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

const INCOME_CUMULATIVE: &str = "eastmoney_f10_income.v1";
const INCOME_ANNUAL: &str = "eastmoney_f10_annual_income.v1";
const INCOME_QUARTERLY: &str = "eastmoney_f10_incomeqc.v1";

fn date(value: &Value) -> String {
    value.as_str().unwrap_or("").chars().take(10).collect()
}
fn string(value: &Value) -> String {
    value.as_str().unwrap_or("").trim().to_string()
}
fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
fn contract(row: &Value) -> &str {
    row["payload"]["FINANCIAL_SOURCE_CONTRACT"]
        .as_str()
        .unwrap_or("")
}
fn cumulative(row: &Value) -> bool {
    row["statementType"] == "income"
        && row["source"] == "eastmoney"
        && matches!(contract(row), INCOME_CUMULATIVE | INCOME_ANNUAL)
}
fn annual(row: &Value) -> bool {
    row["statementType"] == "income"
        && row["source"] == "eastmoney"
        && contract(row) == INCOME_ANNUAL
        && row["fiscalPeriod"] == "12M"
}
fn valid_metadata(row: &Value, expected: &str, fields: &[&str]) -> bool {
    contract(row) == expected
        && fields
            .iter()
            .all(|key| !string(&row["payload"][*key]).is_empty())
}

pub fn is_provisional(row: &Value) -> bool {
    matches!(
        row["payload"]["dataSource"].as_str(),
        Some("performance_report" | "performance_forecast")
    )
}

pub fn ensure_metadata(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut row = Value::Object(object(row));
            let source = row["payload"]["dataSource"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if !matches!(
                source.as_str(),
                "financial_report" | "performance_report" | "performance_forecast"
            ) {
                row["payload"] = Value::Object(object(&row["payload"]));
                row["payload"]["dataSource"] = json!("financial_report");
                row["payload"]["dataSourceLabel"] = json!("正式财报");
            } else if source != "financial_report"
                && row["payload"]["NETPROFIT"].is_null()
                && !row["payload"]["PARENT_NETPROFIT"].is_null()
            {
                row["payload"]["NETPROFIT"] = row["payload"]["PARENT_NETPROFIT"].clone();
            }
            row
        })
        .collect()
}

pub async fn load(
    state: &AppState,
    raw_code: &str,
    statement_type: &str,
) -> Result<(String, Vec<Value>)> {
    if !["income", "balance", "cashflow"].contains(&statement_type) {
        bail!("unsupported statement type");
    }
    let code = codes::normalize(raw_code);
    let snapshot_key = format!("financial-statements/{statement_type}/{code}.json");
    // Codes must be checked before using them as local object keys.
    if !codes::supported_company(&code) {
        return Ok(("eastmoney".into(), Vec::new()));
    }
    let store = state.market_store()?;
    let snapshot = store.get_json(&snapshot_key).await?.unwrap_or(Value::Null);
    let cached = ensure_metadata(
        snapshot["rows"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    let pending = if statement_type == "income" {
        snapshot["provisionalData"].clone()
    } else {
        Value::Null
    };
    let hk = code.ends_with(".HK");
    let us = code.ends_with(".US");
    let cn = code.ends_with(".SH") || code.ends_with(".SZ") || code.ends_with(".BJ");
    let source_contract_valid = if hk {
        cached.iter().all(|row| {
            valid_metadata(
                row,
                "eastmoney_hk_f10_main_indicator.v2",
                &["REPORTING_CURRENCY", "REPORTING_ACCOUNT_STANDARD"],
            )
        })
    } else if us {
        cached.iter().all(|row| {
            valid_metadata(
                row,
                "yahoo_finance_timeseries.v3",
                &["REPORTING_CURRENCY", "FISCAL_PERIOD"],
            )
        })
    } else if cn && statement_type == "income" {
        cached.iter().any(annual) && cached.iter().any(cumulative)
    } else {
        true
    };
    let now = Utc::now().timestamp_millis();
    if !cached.is_empty() && source_contract_valid {
        let latest = &cached[0];
        if is_provisional(latest) && now - latest["updatedAt"].as_i64().unwrap_or(0) < 30 * 60_000 {
            return Ok(("r2".into(), cached));
        }
        let unresolved = !pending.is_null()
            && !cached
                .iter()
                .any(|row| row["reportDate"] == pending["reportDate"]);
        if !unresolved && !is_provisional(latest) && cache_policy::financial_fresh(&cached, now) {
            return Ok(("r2".into(), cached));
        }
    }
    let (source, mut rows) = if us {
        (
            "yahoo",
            ensure_metadata(&fetch_us(state, &code, statement_type).await?),
        )
    } else if hk {
        (
            "eastmoney",
            ensure_metadata(&fetch_hk(state, &code, statement_type).await?),
        )
    } else if cn {
        let formal = fetch_cn(state, &code, statement_type).await?;
        let formal = ensure_metadata(&formal);
        if statement_type == "income" {
            let mut cumulative_rows: Vec<Value> = formal
                .iter()
                .filter(|row| cumulative(row))
                .cloned()
                .collect();
            let quarterized: Vec<Value> = formal
                .iter()
                .chain(cached.iter())
                .filter(|row| !cumulative(row))
                .cloned()
                .collect();
            cumulative_rows.extend(merge_provisional(
                &quarterized,
                pending["performanceRows"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                pending["forecastRows"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                now,
            ));
            cumulative_rows.sort_by(|a, b| {
                b["reportDate"]
                    .as_str()
                    .cmp(&a["reportDate"].as_str())
                    .then_with(|| cumulative(b).cmp(&cumulative(a)))
            });
            ("eastmoney", cumulative_rows)
        } else {
            ("eastmoney", formal)
        }
    } else {
        ("eastmoney", Vec::new())
    };
    if !rows.is_empty() {
        rows = ensure_metadata(&rows);
        let formalized = !pending.is_null()
            && rows
                .iter()
                .any(|row| row["reportDate"] == pending["reportDate"] && !is_provisional(row));
        let mut next = json!({"code":code,"statementType":statement_type,"source":rows[0]["source"],"updatedAt":rows[0]["updatedAt"],"reportDates":rows.iter().map(|row|row["reportDate"].clone()).collect::<Vec<_>>(),"rows":rows});
        if !formalized && !pending.is_null() {
            next["provisionalData"] = pending;
        }
        store.put_json(&snapshot_key, &next).await?;
    }
    Ok((source.into(), rows))
}

fn headers(referer: &str) -> Result<HeaderMap> {
    let mut result = HeaderMap::new();
    result.insert(REFERER, HeaderValue::from_str(referer)?);
    result.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    result.insert(USER_AGENT,HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"));
    Ok(result)
}

// The dynamic source TTL is selected once on a network response, not extended
// on cache hits. A stale quarter never becomes permanently fresh by polling.
async fn financial_json(state: &AppState, url: &Url, referer: &str, yahoo: bool) -> Result<Value> {
    let key = format!(
        "financial-primary:v1:{:x}",
        Sha256::digest(url.as_str().as_bytes())
    );
    let now = Utc::now().timestamp_millis();
    let cached = state
        .db
        .query(
            "SELECT body_text FROM http_cache WHERE cache_key=? AND expires_at>?",
            vec![key.clone().into(), now.into()],
        )
        .await?;
    if let Some(text) = cached.first().and_then(|row| row["body_text"].as_str()) {
        return parse_json_or_jsonp(text);
    }
    let text = state
        .http
        .text(url.as_str(), Method::GET, headers(referer)?, None)
        .await?;
    let body = parse_json_or_jsonp(&text)?;
    let mut dates = BTreeSet::new();
    if yahoo {
        if !body["timeseries"]["error"].is_null() {
            bail!("yahoo finance error: {}", body["timeseries"]["error"]);
        }
        for result in body["timeseries"]["result"]
            .as_array()
            .into_iter()
            .flatten()
        {
            for array in result
                .as_object()
                .into_iter()
                .flat_map(|o| o.values())
                .filter_map(Value::as_array)
            {
                for point in array {
                    let d = date(&point["asOfDate"]);
                    if !d.is_empty() {
                        dates.insert(d);
                    }
                }
            }
        }
    } else {
        for row in body["result"]["data"].as_array().into_iter().flatten() {
            let d = date(&row["REPORT_DATE"]);
            if !d.is_empty() {
                dates.insert(d);
            }
        }
    }
    let dates = dates
        .into_iter()
        .rev()
        .map(|date| json!({"reportDate":date}))
        .collect::<Vec<_>>();
    let ttl = cache_policy::financial_ttl(&dates, now);
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?) ON CONFLICT(cache_key) DO UPDATE SET body_text=excluded.body_text,status=200,expires_at=excluded.expires_at,updated_at=excluded.updated_at",vec![key.into(),url.as_str().into(),text.into(),(now+ttl).into(),now.into()]).await?;
    Ok(body)
}

pub fn report_type(state: &AppState, code: &str, statement_type: &str) -> Result<String> {
    let mapping = state.config("shared/finance-mappings.json")?;
    let family = if mapping["bankCodes"]
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v == code))
    {
        "B"
    } else if mapping["securityCodes"]
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v == code))
    {
        "S"
    } else if mapping["insuranceCodes"]
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v == code))
    {
        "I"
    } else {
        "G"
    };
    let suffix = match statement_type {
        "income" => "INCOMEQC",
        "balance" => "BALANCE",
        "cashflow" if family == "I" => "CASHFLOWQC",
        "cashflow" => "CASHFLOW",
        _ => bail!("unsupported statement type"),
    };
    Ok(format!("{family}{suffix}"))
}

fn report_dates() -> Vec<String> {
    let now = Local::now();
    let mut result = Vec::new();
    for offset in 0..8 {
        let year = now.year() - offset;
        if offset > 0 {
            result.push(format!("{year}-12-31"));
        }
        for (month, end) in [(9, "09-30"), (6, "06-30"), (3, "03-31")] {
            if offset > 0 || now.month() > month {
                result.push(format!("{year}-{end}"));
            }
        }
    }
    result
}

async fn fetch_cn_family(
    state: &AppState,
    code: &str,
    statement_type: &str,
    family: &str,
) -> Result<Vec<Value>> {
    let mut url = Url::parse("https://datacenter-web.eastmoney.com/securities/api/data/get")?;
    let style = if statement_type == "balance" {
        format!("F10_FINANCE_{family}")
    } else {
        format!("APP_F10_{family}")
    };
    let dates = report_dates().join("','");
    let filter = format!("(SECUCODE=\"{code}\")(REPORT_DATE in ('{dates}'))");
    let kind = format!("RPT_F10_FINANCE_{family}");
    url.query_pairs_mut().extend_pairs([
        ("type", kind.as_str()),
        ("sty", style.as_str()),
        ("filter", filter.as_str()),
        ("p", "1"),
        ("ps", ""),
        ("sr", "-1"),
        ("st", "REPORT_DATE"),
        ("source", "HSF10"),
        ("client", "PC"),
    ]);
    let body = financial_json(
        state,
        &url,
        "https://emweb.securities.eastmoney.com/",
        false,
    )
    .await?;
    let now = Utc::now().timestamp_millis();
    Ok(body["result"]["data"].as_array().into_iter().flatten().filter_map(|payload| {
        let d=date(&payload["REPORT_DATE"]); if d.is_empty() {return None;}
        Some(json!({"code":code,"statementType":statement_type,"reportDate":d,"fiscalPeriod":payload["REPORT_TYPE"].as_str(),"payload":payload,"source":"eastmoney","rawR2Key":null,"updatedAt":now}))
    }).collect())
}

pub async fn fetch_cn(
    state: &AppState,
    raw_code: &str,
    statement_type: &str,
) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    if ![".SH", ".SZ", ".BJ"]
        .iter()
        .any(|suffix| code.ends_with(suffix))
    {
        bail!("finance statement only supports CN A-share codes");
    }
    let kind = report_type(state, &code, statement_type)?;
    let mut quarterly = fetch_cn_family(state, &code, statement_type, &kind).await?;
    if statement_type != "income" {
        return Ok(quarterly);
    }
    for row in &mut quarterly {
        row["payload"]["FINANCIAL_SOURCE_CONTRACT"] = json!(INCOME_QUARTERLY);
    }
    let annual_kind = kind
        .strip_suffix("QC")
        .context("unexpected Eastmoney income family")?;
    let mut cumulative_rows = fetch_cn_family(state, &code, statement_type, annual_kind).await?;
    for row in &mut cumulative_rows {
        let label = string(&row["payload"]["REPORT_TYPE"]).to_uppercase();
        let annual = matches!(label.as_str(), "年报" | "ANNUAL" | "FY" | "12M");
        if annual {
            row["fiscalPeriod"] = json!("12M");
        }
        row["payload"]["FINANCIAL_SOURCE_CONTRACT"] = json!(if annual {
            INCOME_ANNUAL
        } else {
            INCOME_CUMULATIVE
        });
    }
    quarterly.extend(cumulative_rows);
    Ok(quarterly)
}

pub async fn fetch_hk(
    state: &AppState,
    raw_code: &str,
    statement_type: &str,
) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    if !regex::Regex::new(r"^\d{5}\.HK$")?.is_match(&code) {
        bail!("Hong Kong finance requires an .HK company code");
    }
    let mut url = Url::parse("https://datacenter.eastmoney.com/securities/api/data/v1/get")?;
    let filter = format!("(SECUCODE=\"{code}\")");
    url.query_pairs_mut().extend_pairs([
        ("reportName", "RPT_HKF10_FN_MAININDICATOR"),
        ("columns", "ALL"),
        ("filter", filter.as_str()),
        ("pageNumber", "1"),
        ("pageSize", "40"),
        ("sortColumns", "REPORT_DATE"),
        ("sortTypes", "-1"),
        ("source", "F10"),
        ("client", "PC"),
    ]);
    let referer = "https://emweb.securities.eastmoney.com/PC_HKF10/pages/home/index.html";
    let body = financial_json(state, &url, referer, false).await?;
    let mut summary_url =
        Url::parse("https://datacenter.eastmoney.com/securities/api/data/v1/get")?;
    summary_url.query_pairs_mut().extend_pairs([("reportName","RPT_CUSTOM_HKF10_APPFN_INCOME_SUMMARY"),("columns","SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,START_DATE,REPORT_DATE,FISCAL_YEAR,CURRENCY,ACCOUNT_STANDARD,REPORT_TYPE"),("filter",filter.as_str()),("pageNumber","1"),("pageSize","1"),("source","F10"),("client","PC")]);
    let summary = financial_json(state, &summary_url, referer, false).await?;
    let metadata: HashMap<String, Value> = summary["result"]["data"][0]["REPORT_LIST"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let d = date(&row["REPORT_DATE"]);
            (!d.is_empty()).then(|| (d, row.clone()))
        })
        .collect();
    let now = Utc::now().timestamp_millis();
    let rows=body["result"]["data"].as_array().into_iter().flatten().filter_map(|row| {
        let d=date(&row["REPORT_DATE"]); if d.is_empty(){return None;}
        let meta=metadata.get(&d).unwrap_or(&Value::Null);
        let mut payload=row.clone();
        let mut origins=Map::new();
        for (canonical,source) in [("TOTAL_OPERATE_INCOME","OPERATE_INCOME"),("PARENT_NETPROFIT","HOLDER_PROFIT"),("END_CCE","END_CASH")] {
            if row[source].is_number() {payload[canonical]=row[source].clone();origins.insert(canonical.into(),json!(source));}
        }
        if !origins.is_empty(){payload["FINANCIAL_FIELD_ORIGINS"]=Value::Object(origins);}
        payload["REPORTING_CURRENCY"]=if string(&meta["CURRENCY"]).is_empty(){Value::Null}else{json!(string(&meta["CURRENCY"]))};
        payload["REPORTING_ACCOUNT_STANDARD"]=if string(&meta["ACCOUNT_STANDARD"]).is_empty(){Value::Null}else{json!(string(&meta["ACCOUNT_STANDARD"]))};
        payload["FINANCIAL_SOURCE_CONTRACT"]=json!("eastmoney_hk_f10_main_indicator.v2");
        let fiscal=if string(&meta["REPORT_TYPE"]).is_empty(){row["REPORT_TYPE"].clone()}else{json!(string(&meta["REPORT_TYPE"]))};
        Some(json!({"code":code,"statementType":statement_type,"reportDate":d,"fiscalPeriod":fiscal,"payload":payload,"source":"eastmoney","rawR2Key":null,"updatedAt":now}))
    }).collect();
    Ok(rows)
}

const YAHOO_METRICS: &[(&str, &str)] = &[
    ("TotalRevenue", "totalOperateIncome"),
    ("CostOfRevenue", "operateCost"),
    ("GrossProfit", "grossProfit"),
    ("OperatingIncome", "operateProfit"),
    ("NetIncome", "netProfit"),
    ("BasicEPS", "basicEps"),
    ("DilutedEPS", "dilutedEps"),
    ("TotalAssets", "totaAssets"),
    ("TotalLiabilitiesNetMinorityInterest", "totalLiabilities"),
    ("StockholdersEquity", "totalEquity"),
    ("OperatingCashFlow", "netcashOperate"),
    ("FreeCashFlow", "freeCashFlow"),
    ("EndCashPosition", "endCce"),
];

pub fn yahoo_rows(body: &Value, code: &str, statement_type: &str, now: i64) -> Result<Vec<Value>> {
    if !body["timeseries"]["error"].is_null() {
        bail!("yahoo finance error: {}", body["timeseries"]["error"]);
    }
    let mut periods: BTreeMap<String, Value> = BTreeMap::new();
    for series in body["timeseries"]["result"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let Some(kind) = series["meta"]["type"][0].as_str() else {
            continue;
        };
        let Some(metric) = kind
            .strip_prefix("quarterly")
            .or_else(|| kind.strip_prefix("annual"))
        else {
            continue;
        };
        let Some((_, field)) = YAHOO_METRICS.iter().find(|(name, _)| *name == metric) else {
            continue;
        };
        for point in series[kind].as_array().into_iter().flatten() {
            let d = date(&point["asOfDate"]);
            if d.is_empty() {
                continue;
            }
            let duration = if string(&point["periodType"]).to_uppercase() == "12M"
                || kind.starts_with("annual")
            {
                "12M"
            } else {
                "3M"
            };
            let row=periods.entry(format!("{d}:{duration}")).or_insert_with(||json!({"reportDate":d,"noticeDate":d,"REPORT_DATE":d,"NOTICE_DATE":d,"FISCAL_PERIOD":duration,"YAHOO_PERIOD_TYPE":duration,"FINANCIAL_SOURCE_CONTRACT":"yahoo_finance_timeseries.v3","YAHOO_FIELD_CURRENCIES":{},"YAHOO_FIELD_DATA_IDS":{}}));
            row[*field] = json!(number(&point["reportedValue"]["raw"]));
            let currency = string(&point["currencyCode"]).to_uppercase();
            if currency.len() == 3 && currency.bytes().all(|b| b.is_ascii_uppercase()) {
                row["YAHOO_FIELD_CURRENCIES"][*field] = json!(currency);
            }
            let data_id = string(&point["dataId"]);
            if !data_id.is_empty() {
                row["YAHOO_FIELD_DATA_IDS"][*field] = json!(data_id);
            }
        }
    }
    let mut rows = Vec::new();
    for (_, mut payload) in periods {
        let currencies: BTreeSet<String> = payload["YAHOO_FIELD_CURRENCIES"]
            .as_object()
            .into_iter()
            .flat_map(|o| o.values())
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if currencies.len() == 1 {
            payload["REPORTING_CURRENCY"] = json!(currencies.first().unwrap());
        }
        if currencies.len() > 1 {
            payload["YAHOO_CURRENCY_CONFLICT"] = json!(true);
        }
        let prefix = if payload["FISCAL_PERIOD"] == "12M" {
            "annual"
        } else {
            "quarterly"
        };
        let mut origins = Map::new();
        for (canonical, field, metric) in [
            ("TOTAL_OPERATE_INCOME", "totalOperateIncome", "TotalRevenue"),
            ("OPERATE_COST", "operateCost", "CostOfRevenue"),
            ("GROSS_PROFIT", "grossProfit", "GrossProfit"),
            ("OPERATE_PROFIT", "operateProfit", "OperatingIncome"),
            ("NETPROFIT", "netProfit", "NetIncome"),
            ("PARENT_NETPROFIT", "netProfit", "NetIncome"),
            ("BASIC_EPS", "basicEps", "BasicEPS"),
            ("DILUTED_EPS", "dilutedEps", "DilutedEPS"),
            ("TOTAL_ASSETS", "totaAssets", "TotalAssets"),
            (
                "TOTAL_LIABILITIES",
                "totalLiabilities",
                "TotalLiabilitiesNetMinorityInterest",
            ),
            ("TOTAL_EQUITY", "totalEquity", "StockholdersEquity"),
            ("NETCASH_OPERATE", "netcashOperate", "OperatingCashFlow"),
            ("FREE_CASH_FLOW", "freeCashFlow", "FreeCashFlow"),
            ("END_CCE", "endCce", "EndCashPosition"),
        ] {
            if payload[field].is_number() {
                payload[canonical] = payload[field].clone();
                origins.insert(canonical.into(), json!(format!("{prefix}{metric}")));
            }
        }
        if !origins.is_empty() {
            payload["FINANCIAL_FIELD_ORIGINS"] = Value::Object(origins);
        }
        if statement_type == "income" {
            for (to, from) in [
                ("operateIncome", "totalOperateIncome"),
                ("totalOperateCost", "operateCost"),
                ("parentNetprofit", "netProfit"),
            ] {
                if let Some(value) = payload.get(from).cloned() {
                    payload[to] = value;
                }
            }
        }
        if statement_type == "balance"
            && let Some(value) = payload.get("totaAssets").cloned()
        {
            payload["totalAssets"] = value;
        }
        let d = payload["reportDate"].clone();
        let period = payload["FISCAL_PERIOD"].clone();
        rows.push(json!({"code":code,"statementType":statement_type,"reportDate":d,"fiscalPeriod":period,"payload":payload,"source":"yahoo","rawR2Key":null,"updatedAt":now}));
    }
    rows.sort_by(|a, b| {
        b["reportDate"]
            .as_str()
            .cmp(&a["reportDate"].as_str())
            .then_with(|| b["fiscalPeriod"].as_str().cmp(&a["fiscalPeriod"].as_str()))
    });
    Ok(rows)
}

pub async fn fetch_us(
    state: &AppState,
    raw_code: &str,
    statement_type: &str,
) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    if !code.ends_with(".US") {
        bail!("Yahoo financial statements only supports .US securities");
    }
    let symbol = code.strip_suffix(".US").unwrap();
    let mut url = Url::parse(
        "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/",
    )?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalid Yahoo endpoint"))?
        .pop_if_empty()
        .push(symbol);
    let kinds = YAHOO_METRICS
        .iter()
        .flat_map(|(metric, _)| [format!("quarterly{metric}"), format!("annual{metric}")])
        .collect::<Vec<_>>()
        .join(",");
    let period2 = Utc::now()
        .date_naive()
        .checked_add_signed(Duration::days(2))
        .context("Yahoo date overflow")?
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp()
        .to_string();
    url.query_pairs_mut().extend_pairs([
        ("type", kinds.as_str()),
        ("period1", "0"),
        ("period2", period2.as_str()),
    ]);
    let referer = format!("https://finance.yahoo.com/quote/{symbol}/financials/");
    // HttpClient enforces the local Yahoo proxy boundary before sending.
    let body = financial_json(state, &url, &referer, true).await?;
    yahoo_rows(&body, &code, statement_type, Utc::now().timestamp_millis())
}

#[derive(Default)]
struct Accumulator {
    last: u32,
    values: [Option<f64>; 3],
    complete: [bool; 3],
}

fn quarter(date: &str) -> Option<u32> {
    match date.get(5..7)? {
        "03" => Some(1),
        "06" => Some(2),
        "09" => Some(3),
        "12" => Some(4),
        _ => None,
    }
}

fn latest_payloads(rows: &[Value]) -> BTreeMap<String, Value> {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| b["NOTICE_DATE"].as_str().cmp(&a["NOTICE_DATE"].as_str()));
    let mut result = BTreeMap::new();
    for row in rows {
        let d = date(&row["REPORT_DATE"]);
        if !d.is_empty() {
            result.entry(d).or_insert(row);
        }
    }
    result
}

fn forecast_payloads(rows: &[Value]) -> BTreeMap<String, Value> {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| b["NOTICE_DATE"].as_str().cmp(&a["NOTICE_DATE"].as_str()));
    let mut result: BTreeMap<String, Value> = BTreeMap::new();
    for row in rows {
        let d = date(&row["REPORT_DATE"]);
        if d.is_empty() {
            continue;
        }
        if row.get("FORECAST_PROFIT_JZ").is_some() || row.get("FORECAST_REVENUE_JZ").is_some() {
            let current = result.entry(d).or_insert_with(|| json!({}));
            for (key, value) in object(&row) {
                current[key] = value;
            }
            continue;
        }
        let kind = string(&row["PREDICT_FINANCE_CODE"]);
        if !["004", "006"].contains(&kind.as_str()) || row["IS_LATEST"] == "F" {
            continue;
        }
        let current=result.entry(d).or_insert_with(||json!({"SECUCODE":row["SECUCODE"],"SECURITY_CODE":row["SECURITY_CODE"],"REPORT_DATE":row["REPORT_DATE"],"NOTICE_DATE":row["NOTICE_DATE"]}));
        let amount = number(&row["FORECAST_JZ"]).or_else(|| {
            match (
                number(&row["PREDICT_AMT_LOWER"]),
                number(&row["PREDICT_AMT_UPPER"]),
            ) {
                (Some(a), Some(b)) => Some((a + b) / 2.0),
                (Some(a), None) | (None, Some(a)) => Some(a),
                _ => None,
            }
        });
        if kind == "004" && current.get("FORECAST_PROFIT_JZ").is_none() {
            for (key, value) in object(&row) {
                current[key] = value;
            }
            current["FORECAST_PROFIT_JZ"] = json!(amount);
        }
        if kind == "006" && current.get("FORECAST_REVENUE_JZ").is_none() {
            current["FORECAST_REVENUE_JZ"] = json!(amount);
        }
    }
    result
}

pub fn merge_provisional(
    existing: &[Value],
    incoming_performance: &[Value],
    incoming_forecast: &[Value],
    now: i64,
) -> Vec<Value> {
    let normalized = ensure_metadata(existing);
    let mut formal = BTreeMap::new();
    let mut performances = Vec::new();
    let mut forecasts = Vec::new();
    for row in &normalized {
        match row["payload"]["dataSource"].as_str().unwrap_or("") {
            "financial_report" => {
                let d = string(&row["reportDate"]);
                if !d.is_empty() {
                    formal.entry(d).or_insert_with(|| row.clone());
                }
            }
            "performance_report" => {
                let mut payload = row["payload"].clone();
                for (to, from) in [
                    ("TOTAL_OPERATE_INCOME", "cumulativeTotalOperateIncome"),
                    ("PARENT_NETPROFIT", "cumulativeParentNetprofit"),
                    ("BASIC_EPS", "cumulativeBasicEps"),
                ] {
                    if !payload[from].is_null() {
                        payload[to] = payload[from].clone();
                    }
                }
                performances.push(payload);
            }
            "performance_forecast" => forecasts.push(row["payload"].clone()),
            _ => {}
        }
    }
    performances.extend_from_slice(incoming_performance);
    forecasts.extend_from_slice(incoming_forecast);
    let performance = latest_payloads(&performances);
    let forecast = forecast_payloads(&forecasts);
    let dates: BTreeSet<String> = formal
        .keys()
        .chain(performance.keys())
        .chain(forecast.keys())
        .cloned()
        .collect();
    let earliest = chrono::DateTime::from_timestamp_millis(now)
        .unwrap_or_default()
        .year()
        - 4;
    let mut accumulators: BTreeMap<i32, Accumulator> = BTreeMap::new();
    let mut selected = Vec::new();
    for d in dates {
        let Some(year) = d.get(..4).and_then(|s| s.parse::<i32>().ok()) else {
            continue;
        };
        let Some(q) = quarter(&d) else { continue };
        if year < earliest {
            continue;
        }
        let accumulator = accumulators.entry(year).or_default();
        let row = if let Some(formal) = formal.get(&d) {
            let mut formal = formal.clone();
            formal["payload"]["dataSource"] = json!("financial_report");
            formal["payload"]["dataSourceLabel"] = json!("正式财报");
            formal
        } else {
            let (raw, source) = if let Some(raw) = performance.get(&d) {
                (raw, "performance_report")
            } else if let Some(raw) = forecast.get(&d) {
                (raw, "performance_forecast")
            } else {
                continue;
            };
            let cumulative = [
                number(
                    &raw[if source == "performance_report" {
                        "TOTAL_OPERATE_INCOME"
                    } else {
                        "FORECAST_REVENUE_JZ"
                    }],
                ),
                number(
                    &raw[if source == "performance_report" {
                        "PARENT_NETPROFIT"
                    } else {
                        "FORECAST_PROFIT_JZ"
                    }],
                ),
                if source == "performance_report" {
                    number(&raw["BASIC_EPS"])
                } else {
                    None
                },
            ];
            let values: [Option<f64>; 3] = std::array::from_fn(|i| {
                let value = cumulative[i]?;
                if q == 1 {
                    Some(value)
                } else if accumulator.complete[i] && accumulator.last == q - 1 {
                    Some(value - accumulator.values[i]?)
                } else {
                    None
                }
            });
            if values.iter().all(Option::is_none) {
                continue;
            }
            let mut payload = Value::Object(object(raw));
            let label = if source == "performance_report" {
                "业绩快报"
            } else {
                "业绩预告"
            };
            let notice = date(&raw["NOTICE_DATE"]);
            for (key, value) in [
                ("REPORT_DATE", json!(d)),
                (
                    "NOTICE_DATE",
                    json!(if notice.is_empty() { &d } else { &notice }),
                ),
                ("REPORT_TYPE", json!(label)),
                ("TOTAL_OPERATE_INCOME", json!(values[0])),
                ("OPERATE_INCOME", json!(values[0])),
                ("PARENT_NETPROFIT", json!(values[1])),
                ("NETPROFIT", json!(values[1])),
                ("BASIC_EPS", json!(values[2])),
                ("cumulativeTotalOperateIncome", json!(cumulative[0])),
                ("cumulativeParentNetprofit", json!(cumulative[1])),
                ("cumulativeBasicEps", json!(cumulative[2])),
                ("dataSource", json!(source)),
                ("dataSourceLabel", json!(label)),
            ] {
                payload[key] = value;
            }
            let code = normalized
                .first()
                .and_then(|row| row["code"].as_str())
                .unwrap_or_else(|| {
                    raw["SECUCODE"]
                        .as_str()
                        .or_else(|| raw["SECURITY_CODE"].as_str())
                        .unwrap_or("")
                });
            json!({"code":code,"statementType":"income","reportDate":d,"fiscalPeriod":format!("{}M",q*3),"payload":payload,"source":if source=="performance_report"{"eastmoney_performance"}else{"eastmoney_forecast"},"rawR2Key":null,"updatedAt":now})
        };
        let sequential = q == 1 || accumulator.last == q - 1;
        for (i, key) in ["TOTAL_OPERATE_INCOME", "PARENT_NETPROFIT", "BASIC_EPS"]
            .iter()
            .enumerate()
        {
            let value = number(&row["payload"][*key]);
            accumulator.complete[i] =
                sequential && value.is_some() && (q == 1 || accumulator.complete[i]);
            accumulator.values[i] = if accumulator.complete[i] {
                Some(
                    if q == 1 {
                        0.0
                    } else {
                        accumulator.values[i].unwrap_or(0.0)
                    } + value.unwrap(),
                )
            } else {
                None
            };
        }
        accumulator.last = q;
        selected.push(row);
    }
    selected.sort_by(|a, b| b["reportDate"].as_str().cmp(&a["reportDate"].as_str()));
    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_state(root: &std::path::Path) -> AppState {
        AppState::new(
            crate::db::Database::open(root.join("fixture.sqlite")).unwrap(),
            root.to_path_buf(),
            "127.0.0.1:18000".into(),
        )
        .unwrap()
    }

    #[test]
    fn cn_provider_families_use_existing_classification_and_real_cashflow_endpoints() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("shared")).unwrap();
        std::fs::write(
            root.path().join("shared/finance-mappings.json"),
            r#"{"bankCodes":["600036.SH"],"securityCodes":["600030.SH"],"insuranceCodes":["601318.SH"]}"#,
        )
        .unwrap();
        let state = fixture_state(root.path());
        for (code, kind, expected) in [
            ("600036.SH", "income", "BINCOMEQC"),
            ("600030.SH", "balance", "SBALANCE"),
            ("601318.SH", "cashflow", "ICASHFLOWQC"),
            ("300308.SZ", "cashflow", "GCASHFLOW"),
            ("600036.SH", "cashflow", "BCASHFLOW"),
        ] {
            assert_eq!(report_type(&state, code, kind).unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn fresh_income_snapshot_is_read_only_and_preserves_both_source_families() {
        let root = tempfile::tempdir().unwrap();
        let state = fixture_state(root.path());
        // Fail before any filesystem operation if the caller intentionally
        // overrides the storage root. Never seed the user's real object store.
        assert!(state.data_dir().starts_with(root.path()));
        let now = Utc::now().timestamp_millis();
        let latest = cache_policy::latest_completed_quarter(now);
        let year = latest[..4].parse::<i32>().unwrap();
        let rows = json!([
            {"code":"600036.SH","statementType":"income","reportDate":latest,"fiscalPeriod":"9M","source":"eastmoney","updatedAt":now,"payload":{"FINANCIAL_SOURCE_CONTRACT":INCOME_CUMULATIVE,"TOTAL_OPERATE_INCOME":100,"dataSource":"financial_report","dataSourceLabel":"正式财报"}},
            {"code":"600036.SH","statementType":"income","reportDate":format!("{}-12-31",year-1),"fiscalPeriod":"12M","source":"eastmoney","updatedAt":now,"payload":{"FINANCIAL_SOURCE_CONTRACT":INCOME_ANNUAL,"TOTAL_OPERATE_INCOME":120,"dataSource":"financial_report","dataSourceLabel":"正式财报"}}
        ]);
        let snapshot = json!({"code":"600036.SH","statementType":"income","updatedAt":now,"source":"eastmoney","rows":rows});
        let key = "financial-statements/income/600036.SH.json";
        let store = state.market_store().unwrap();
        store.put_json(key, &snapshot).await.unwrap();
        let before = store.get(key).await.unwrap().unwrap();
        let (source, actual) = load(&state, "600036.SH", "income").await.unwrap();
        assert_eq!(source, "r2");
        assert_eq!(actual, rows.as_array().unwrap().clone());
        assert_eq!(store.get(key).await.unwrap().unwrap(), before);
        // load did not access a provider or invent a database cache table.
        assert!(
            state
                .db
                .query("SELECT name FROM sqlite_master WHERE type='table'", vec![])
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn snapshot_contracts_fail_closed_for_missing_reporting_currency_or_annual_source() {
        assert!(!valid_metadata(
            &json!({"payload":{"FINANCIAL_SOURCE_CONTRACT":"yahoo_finance_timeseries.v3","FISCAL_PERIOD":"3M"}}),
            "yahoo_finance_timeseries.v3",
            &["REPORTING_CURRENCY", "FISCAL_PERIOD"]
        ));
        assert!(!valid_metadata(
            &json!({"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_hk_f10_main_indicator.v2","REPORTING_CURRENCY":"CNY"}}),
            "eastmoney_hk_f10_main_indicator.v2",
            &["REPORTING_CURRENCY", "REPORTING_ACCOUNT_STANDARD"]
        ));
        assert!(!annual(
            &json!({"statementType":"income","source":"yahoo","fiscalPeriod":"12M","payload":{"FINANCIAL_SOURCE_CONTRACT":INCOME_ANNUAL}})
        ));
    }

    #[test]
    fn yahoo_preserves_period_identity_currency_and_aliases() {
        let body = json!({"timeseries":{"result":[{"meta":{"type":["quarterlyTotalRevenue"]},"quarterlyTotalRevenue":[{"asOfDate":"2026-06-30","periodType":"3M","currencyCode":"USD","reportedValue":{"raw":10},"dataId":"q"}]},{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[{"asOfDate":"2026-06-30","periodType":"12M","currencyCode":"USD","reportedValue":{"raw":40},"dataId":"y"}]}]}});
        let rows = yahoo_rows(&body, "TEST.US", "income", 1).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(
            |row| row["fiscalPeriod"] == "3M" && row["payload"]["TOTAL_OPERATE_INCOME"] == 10.0
        ));
        assert!(
            rows.iter().any(|row| row["fiscalPeriod"] == "12M"
                && row["payload"]["TOTAL_OPERATE_INCOME"] == 40.0)
        );
        assert!(
            rows.iter()
                .all(|row| row["payload"]["REPORTING_CURRENCY"] == "USD")
        );
        assert!(rows.iter().all(
            |row| row["payload"]["FINANCIAL_SOURCE_CONTRACT"] == "yahoo_finance_timeseries.v3"
        ));
    }
    #[test]
    fn provisional_requires_contiguous_quarters_and_never_replaces_formal() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-29T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let formal = json!({"code":"600036.SH","statementType":"income","reportDate":"2026-03-31","payload":{"TOTAL_OPERATE_INCOME":100,"PARENT_NETPROFIT":20,"BASIC_EPS":1},"source":"eastmoney","updatedAt":1});
        let performance = json!({"SECUCODE":"600036.SH","REPORT_DATE":"2026-06-30","TOTAL_OPERATE_INCOME":250,"PARENT_NETPROFIT":50,"BASIC_EPS":3});
        let rows = merge_provisional(std::slice::from_ref(&formal), &[performance], &[], now);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["payload"]["TOTAL_OPERATE_INCOME"], 150.0);
        assert_eq!(rows[0]["payload"]["PARENT_NETPROFIT"], 30.0);
        assert_eq!(rows[1]["payload"]["dataSource"], "financial_report");
        let missing =
            json!({"SECUCODE":"600036.SH","REPORT_DATE":"2026-09-30","TOTAL_OPERATE_INCOME":400});
        assert_eq!(merge_provisional(&[formal], &[missing], &[], now).len(), 1);
    }
    #[test]
    fn provisional_forecast_uses_midpoint_only_with_prior_anchor() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-29T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let row = json!({"SECUCODE":"600036.SH","REPORT_DATE":"2026-03-31","PREDICT_FINANCE_CODE":"004","PREDICT_AMT_LOWER":10,"PREDICT_AMT_UPPER":20});
        let rows = merge_provisional(&[], &[], &[row], now);
        assert_eq!(rows[0]["payload"]["PARENT_NETPROFIT"], 15.0);
        assert!(is_provisional(&rows[0]));
    }
}
