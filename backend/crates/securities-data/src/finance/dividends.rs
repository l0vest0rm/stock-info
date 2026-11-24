//! Eastmoney dividend history, plan normalization and announcement-based yields.
//! Dividend and share-capital sources are Eastmoney only; prices are explicit inputs.
use crate::{Runtime, codes, http::number};
use anyhow::Result;
use chrono::NaiveDate;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Raw provider dividend decisions, announcement-date ascending. Includes
/// reporting periods required by dividend_yield_from_rows; preserves the
/// existing first-page/100-row source contract and 24-hour HTTP cache policy.
pub async fn fetch_history(state: &impl Runtime, code: &str) -> Result<Vec<Value>> {
    fetch_rows(state, code, "RPT_F10_DIVIDEND_MAIN", "SECUCODE,SECURITY_CODE,NOTICE_DATE,REPORT_DATE,REPORT_TIME,IMPL_PLAN_PROFILE,ASSIGN_PROGRESS,EQUITY_RECORD_DATE,EX_DIVIDEND_DATE,PAY_CASH_DATE", "1").await
}

/// Raw provider rows for the existing share-bonus contract, newest first.
pub async fn fetch_share_bonus_rows(state: &impl Runtime, code: &str) -> Result<Vec<Value>> {
    fetch_rows(state, code, "RPT_F10_DIVIDEND_MAIN", "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,NOTICE_DATE,IMPL_PLAN_PROFILE,ASSIGN_PROGRESS,EQUITY_RECORD_DATE,EX_DIVIDEND_DATE,PAY_CASH_DATE", "-1").await
}

/// Additional share issues (not IPOs, debt or margin financing). Returns the
/// provider's original units and nullable fields, newest notice first, up to 100 rows.
pub async fn share_additional(state: &impl Runtime, code: &str) -> Result<Vec<Value>> {
    fetch_rows(state, code, "RPT_F10_DIVIDEND_SEO", "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,NOTICE_DATE,ISSUE_NUM,NET_RAISE_FUNDS,ISSUE_PRICE,ISSUE_WAY_EXPLAIN,REG_DATE,LISTING_DATE,RECEIVE_DATE", "-1").await
}

async fn fetch_rows(
    state: &impl Runtime,
    code: &str,
    report: &str,
    columns: &str,
    sort: &str,
) -> Result<Vec<Value>> {
    let code = codes::normalize(code);
    let filter = format!("(SECUCODE=\"{code}\")");
    let mut url = Url::parse("https://datacenter.eastmoney.com/securities/api/data/v1/get")?;
    url.query_pairs_mut().extend_pairs([
        ("reportName", report),
        ("columns", columns),
        ("quoteColumns", ""),
        ("filter", &filter),
        ("pageNumber", "1"),
        ("pageSize", "100"),
        ("sortTypes", sort),
        ("sortColumns", "NOTICE_DATE"),
        ("source", "HSF10"),
        ("client", "PC"),
    ]);
    let mut headers = HeaderMap::new();
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://emweb.securities.eastmoney.com/"),
    );
    let value = state.cached_json(url.as_str(), headers, 86_400_000).await?;
    Ok(value["result"]["data"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

/// Eastmoney share-capital changes, newest first, up to the existing 5,000-row
/// source limit. Empty source history stays empty; no current-price fallback.
pub async fn share_changes(state: &impl Runtime, raw_code: &str) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    if !is_cn(&code) {
        return Ok(vec![]);
    }
    let filter = format!("(SECUCODE=\"{code}\")");
    let mut url = Url::parse("https://datacenter-web.eastmoney.com/securities/api/data/v1/get")?;
    url.query_pairs_mut().extend_pairs([
        ("reportName", "RPT_F10_EH_EQUITY"),
        ("columns", "SECUCODE,SECURITY_CODE,END_DATE,TOTAL_SHARES,LIMITED_SHARES,LIMITED_OTHARS,LIMITED_DOMESTIC_NATURAL,LIMITED_STATE_LEGAL,UNLIMITED_SHARES,LISTED_A_SHARES,FREE_SHARES,LIMITED_A_SHARES,LIMITED_DOMESTIC_NOSTATE,CHANGE_REASON"),
        ("quoteColumns", ""), ("filter", &filter), ("pageNumber", "1"),
        ("pageSize", "5000"), ("sortTypes", "-1"), ("sortColumns", "END_DATE"),
        ("source", "HSF10"), ("client", "PC"),
    ]);
    let mut headers = HeaderMap::new();
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://emweb.securities.eastmoney.com/"),
    );
    let value = state.cached_json(url.as_str(), headers, 86_400_000).await?;
    Ok(share_changes_from_rows(
        value["result"]["data"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    ))
}

/// Normalize newest-first Eastmoney equity records, preserving legacy fields,
/// share-change arithmetic and JavaScript decimal rounding.
pub fn share_changes_from_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter().enumerate().map(|(index,row)|{
        let total=number(&row["TOTAL_SHARES"]).unwrap_or(0.0);
        let previous=rows.get(index+1).and_then(|r|number(&r["TOTAL_SHARES"])).unwrap_or(0.0);
        json!({"totalShares":total,"changeDate":trim_date(&row["END_DATE"]),"changeReason":row.get("CHANGE_REASON").unwrap_or(&json!("")),"changeRatio":if previous!=0.0{ryu_js::Buffer::new().format_to_fixed(100.0*total/previous-100.0, 4).to_string()}else{"0.0000".into()},
            "freeShares":row["FREE_SHARES"],"limitedAShares":row["LIMITED_A_SHARES"],"limitedDomesticNatural":row["LIMITED_DOMESTIC_NATURAL"],"limitedDomesticNostate":row["LIMITED_DOMESTIC_NOSTATE"],"limitedOthers":row["LIMITED_OTHARS"],"limitedShares":row["LIMITED_SHARES"],"limitedStateLegal":row["LIMITED_STATE_LEGAL"],"listedAShares":row["LISTED_A_SHARES"],"unlimitedShares":row["UNLIMITED_SHARES"],"changeShares":if index+1<rows.len(){total-previous}else{0.0}})
    }).collect()
}

pub async fn share_bonuses(state: &impl Runtime, raw_code: &str) -> Result<Vec<Value>> {
    let code = codes::normalize(raw_code);
    let (rows, changes) = tokio::try_join!(
        fetch_share_bonus_rows(state, &code),
        share_changes(state, &code)
    )?;
    Ok(share_bonuses_from_rows(&rows, &changes))
}

/// Preserve the source's per-ten-share plan convention and event-date share basis.
/// `changes` must be ordered newest first and contain changeDate/totalShares.
pub fn share_bonuses_from_rows(rows: &[Value], changes: &[Value]) -> Vec<Value> {
    rows.iter().filter_map(|row|{
        let plan=row["IMPL_PLAN_PROFILE"].as_str().unwrap_or("");if plan.is_empty()||plan=="不分配不转增"{return None;}
        let bonus=plan_number(&plan.replacen('元',"",1),"派")/10.0;
        let event=first_date(row,&["EQUITY_RECORD_DATE","EX_DIVIDEND_DATE","NOTICE_DATE"]);
        let shares=changes.iter().find(|item|item["changeDate"].as_str().unwrap_or("")<=event.as_str()).and_then(|item|number(&item["totalShares"])).unwrap_or(0.0);
        Some(json!({"noticeDate":trim_date(&row["NOTICE_DATE"]),"progress":row.get("ASSIGN_PROGRESS").unwrap_or(&json!("")),"plan":plan,"give":plan_number(plan,"送")/10.0,"trans":plan_number(plan,"转")/10.0,"bonus":bonus,"bonusTotal":bonus*shares,"divDate":trim_date(&row["EX_DIVIDEND_DATE"]),"recordDate":trim_date(&row["EQUITY_RECORD_DATE"])}))
    }).collect()
}

#[derive(Clone)]
struct DividendDecision {
    quarter: i64,
    announced: String,
    event: String,
    report: String,
    plan: String,
    cash: f64,
}
fn dividend_decision(row: &Value) -> Option<DividendDecision> {
    let report = first_date(row, &["REPORT_TIME", "REPORT_DATE"]);
    let quarter = report_quarter(&report)?;
    let announced = trim_date(&row["NOTICE_DATE"]);
    if announced.is_empty() {
        return None;
    }
    let plan = row["IMPL_PLAN_PROFILE"].as_str().unwrap_or("").to_string();
    let event = first_date(
        row,
        &[
            "EX_DIVIDEND_DATE",
            "EQUITY_RECORD_DATE",
            "PAY_CASH_DATE",
            "NOTICE_DATE",
        ],
    );
    Some(DividendDecision {
        quarter,
        announced,
        event,
        report,
        plan: plan.clone(),
        cash: plan_number(&plan.replacen('元', "", 1), "派") / 10.0,
    })
}
fn trailing_cash(active: &BTreeMap<i64, DividendDecision>) -> f64 {
    let Some(latest) = active.keys().next_back().copied() else {
        return 0.0;
    };
    active
        .iter()
        .filter(|(quarter, _)| **quarter > latest - 4 && **quarter <= latest)
        .map(|(_, decision)| decision.cash)
        .sum()
}
/// Fetch dividend decisions and compute yields from caller-provided ascending,
/// unadjusted date/close rows. This library never acquires stock prices/K-lines.
pub async fn dividend_yield(state: &impl Runtime, raw_code: &str, bars: &[Value]) -> Result<Value> {
    let code = codes::normalize(raw_code);
    if !is_cn(&code) {
        return Ok(empty_dividend_yield());
    }
    let raw = fetch_history(state, &code).await?;
    Ok(dividend_yield_from_rows(&raw, bars))
}
pub fn dividend_yield_from_rows(raw: &[Value], bars: &[Value]) -> Value {
    let mut decisions = raw.iter().filter_map(dividend_decision).collect::<Vec<_>>();
    decisions.sort_by(|a, b| a.announced.cmp(&b.announced));
    // Zero-cash decisions are excluded, matching cashDividends: an annual
    // board proposal can revise an earlier nonzero cash distribution only if
    // it itself contains an explicit cash amount.
    decisions.retain(|item| item.cash > 0.0);
    let bars = bars
        .iter()
        .filter(|bar| {
            bar.get("close").is_some() && bar["date"].as_str().is_some_and(|s| !s.is_empty())
        })
        .collect::<Vec<_>>();
    if decisions.is_empty() || bars.is_empty() {
        return empty_dividend_yield();
    }
    let mut active = BTreeMap::new();
    let mut index = 0;
    let mut points = vec![];
    for bar in &bars {
        let date = bar["date"].as_str().unwrap_or("");
        while index < decisions.len() && decisions[index].announced.as_str() <= date {
            let d = decisions[index].clone();
            active.insert(d.quarter, d);
            index += 1;
        }
        if let Some(close) = number(&bar["close"]).filter(|n| *n > 0.0)
            && !active.is_empty()
        {
            points.push(json!([
                date_timestamp(date),
                100.0 * trailing_cash(&active) / close
            ]));
        }
    }
    while index < decisions.len() {
        let d = decisions[index].clone();
        active.insert(d.quarter, d);
        index += 1;
    }
    let annual = trailing_cash(&active);
    let close = bars
        .iter()
        .rev()
        .find_map(|bar| number(&bar["close"]).filter(|n| *n > 0.0))
        .unwrap_or(0.0);
    json!({"currentYield":if close>0.0{100.0*annual/close}else{0.0},"annualizedCash":annual,"annualizedCashPerShare":annual,"latestEventDate":decisions.last().map(|d|d.event.as_str()).unwrap_or(""),"series":points,"events":decisions.iter().map(|d|json!({"ts":date_timestamp(&d.event),"plan":d.plan,"reportDate":d.report,"cashPerShare":d.cash})).collect::<Vec<_>>()})
}
/// Latest four reporting quarters, NOT a rolling announcement/ex-date year.
/// Annual plans cover the full year until an earlier cash distribution in that
/// fiscal year establishes a separate interim installment. Never prorate a
/// full-year amount across the boundary of a new interim reporting cycle.
/// Unknown proposals are not zeros; explicit cancellations replace revisions.
/// Legacy rolling-quarter consumers retain their existing API above.
pub fn periodic_dividend_yield_from_rows(raw: &[Value], bars: &[Value]) -> Vec<Value> {
    let cash_pattern = regex::Regex::new(r"派\s*\d+(?:\.\d+)?").expect("constant regex");
    let mut decisions = raw
        .iter()
        .filter_map(|row| {
            let decision = dividend_decision(row)?;
            let explicit_cash = cash_pattern.is_match(&decision.plan);
            (explicit_cash || decision.plan == "不分配不转增").then_some(decision)
        })
        .filter(|d| NaiveDate::parse_from_str(&d.announced, "%Y-%m-%d").is_ok())
        .collect::<Vec<_>>();
    decisions.sort_by(|a, b| a.announced.cmp(&b.announced));
    let mut active: BTreeMap<i64, DividendDecision> = BTreeMap::new();
    let mut index = 0;
    let mut points = vec![];
    for bar in bars {
        let Some(date) = bar["date"].as_str() else {
            continue;
        };
        if NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
            continue;
        }
        while index < decisions.len() && decisions[index].announced.as_str() <= date {
            let d = decisions[index].clone();
            active.insert(d.quarter, d);
            index += 1;
        }
        let Some(close) = number(&bar["close"]).filter(|v| v.is_finite() && *v > 0.0) else {
            continue;
        };
        let Some(latest) = active.keys().next_back().copied() else {
            continue;
        };
        let first = latest - 3;
        let mut covered = [false; 4];
        let mut cash = 0.0;
        let mut periods = vec![];
        let mut overlaps_boundary = false;
        for (&end, d) in active.range(first..=latest) {
            let year_start = end / 4 * 4;
            let start = active
                .range(year_start..end)
                .rev()
                .find(|(_, previous)| previous.cash > 0.0)
                .map_or(year_start, |(quarter, _)| quarter + 1);
            if d.cash > 0.0 && start < first {
                overlaps_boundary = true;
                continue;
            }
            for quarter in start.max(first)..=end {
                covered[(quarter - first) as usize] = true;
            }
            cash += d.cash;
            periods.push(json!({"reportDate": quarter_end(end), "cashPerShare": d.cash}));
        }
        let complete = !overlaps_boundary && covered.iter().all(|v| *v);
        points.push(json!({"date":date,
            "value":if complete {Some(100.0 * cash / close)} else {None},
            "status":if complete {"available"} else {"incomplete_cycle"},
            "reportDate":quarter_end(latest),
            "cashPerShare":if complete {Some(cash)} else {None},
            "dividendPeriods":periods}));
    }
    points
}
fn quarter_end(quarter: i64) -> String {
    let end = ["03-31", "06-30", "09-30", "12-31"][(quarter % 4) as usize];
    format!("{}-{end}", quarter / 4)
}

fn empty_dividend_yield() -> Value {
    json!({"currentYield":0,"annualizedCash":0,"annualizedCashPerShare":0,"latestEventDate":"","series":[],"events":[]})
}
fn report_quarter(value: &str) -> Option<i64> {
    let re = regex::Regex::new(r"^(\d{4})-(\d{2})-(\d{2})").unwrap();
    if let Some(caps) = re.captures(value) {
        return Some(caps[1].parse::<i64>().ok()? * 4 + (caps[2].parse::<i64>().ok()? - 1) / 3);
    }
    let year = regex::Regex::new(r"(\d{4})")
        .unwrap()
        .captures(value)?
        .get(1)?
        .as_str()
        .parse::<i64>()
        .ok()?;
    ["一季", "半年", "三季", "年报"]
        .iter()
        .position(|s| value.contains(s))
        .map(|quarter| year * 4 + quarter as i64)
}
fn plan_number(plan: &str, marker: &str) -> f64 {
    let Some(index) = plan.find(marker) else {
        return 0.0;
    };
    regex::Regex::new(r"^\s*(\d+(?:\.\d+)?)")
        .unwrap()
        .captures(&plan[index + marker.len()..])
        .and_then(|caps| caps[1].parse().ok())
        .unwrap_or(0.0)
}
fn trim_date(value: &Value) -> String {
    value.as_str().unwrap_or("").chars().take(10).collect()
}
fn first_date(row: &Value, fields: &[&str]) -> String {
    fields
        .iter()
        .map(|key| trim_date(&row[*key]))
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}
fn date_timestamp(value: &str) -> i64 {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc().timestamp_millis())
        .unwrap_or(0)
}
fn is_cn(code: &str) -> bool {
    [".SH", ".SZ", ".BJ"]
        .iter()
        .any(|suffix| code.ends_with(suffix))
}
