//! Durable local observation research. Inputs are manually reviewed evidence,
//! not fabricated provider coverage. All records use the existing kv_cache.
use crate::{ApiError, ApiResult, AppState, codes, db::Database, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const NS: &str = "observation-ledger-v1";
const DAY_MS: i64 = 86_400_000;
const MAX_BODY: usize = 120_000;

fn now() -> i64 {
    Utc::now().timestamp_millis()
}
fn iso(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn date_ms(value: &Value) -> Option<i64> {
    let value = value.as_str()?;
    if value.len() != 10
        || !value.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return None;
    }
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    (date.to_string() == value).then(|| {
        date.and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis()
    })
}
pub fn valid_date(value: &Value) -> bool {
    date_ms(value).is_some()
}
pub fn valid_source(source: &Value, now_ms: i64) -> bool {
    let (Some(published), Some(checked)) = (
        date_ms(&source["publishedAt"]),
        date_ms(&source["checkedAt"]),
    ) else {
        return false;
    };
    reqwest::Url::parse(string(&source["url"])).is_ok_and(|url| url.scheme() == "https")
        && published <= checked
        && checked <= now_ms
        && !string(&source["note"]).trim().is_empty()
}

struct Rule {
    key: &'static str,
    label: &'static str,
    text: &'static str,
    test: fn(f64) -> bool,
    valid: fn(f64) -> bool,
}
fn signed(_: f64) -> bool {
    true
}
fn ratio(v: f64) -> bool {
    (0.0..=1.0).contains(&v)
}
fn positive(v: f64) -> bool {
    v > 0.0
}
fn rule(
    key: &'static str,
    label: &'static str,
    text: &'static str,
    test: fn(f64) -> bool,
    valid: fn(f64) -> bool,
) -> Rule {
    Rule {
        key,
        label,
        text,
        test,
        valid,
    }
}
fn rules(archetype: &str) -> Vec<Rule> {
    match archetype {
        "bank" => vec![
            rule("npl_ratio", "不良贷款率", "≤3%", |v| v <= 0.03, ratio),
            rule(
                "cet1_buffer",
                "核心一级资本高于适用要求的缓冲",
                ">0（适用要求须在来源中说明）",
                positive,
                signed,
            ),
            rule(
                "provision_coverage",
                "拨备覆盖率",
                "≥150%",
                |v| v >= 1.5,
                positive,
            ),
        ],
        "insurer" => vec![
            rule(
                "solvency_buffer",
                "偿付能力高于适用要求的缓冲",
                ">0（适用要求须在来源中说明）",
                positive,
                signed,
            ),
            rule(
                "nbv_growth",
                "可比新业务价值同比",
                "≥0",
                |v| v >= 0.0,
                signed,
            ),
            rule(
                "investment_stress_buffer",
                "压力情景后偿付能力缓冲",
                ">0",
                positive,
                signed,
            ),
        ],
        "cyclical_commodity" => vec![
            rule(
                "normalized_profit",
                "当前业务规模的中周期利润",
                ">0（本币元）",
                positive,
                signed,
            ),
            rule(
                "net_debt_normalized_ebitda",
                "净债务/中周期EBITDA",
                "≤3倍",
                |v| v <= 3.0,
                signed,
            ),
            rule(
                "inventory_days_change",
                "可比存货周转天数同比变化",
                "≤0天",
                |v| v <= 0.0,
                signed,
            ),
        ],
        "property_operator" => vec![
            rule(
                "ffo_payout",
                "分红/可持续FFO",
                "≤100%",
                |v| v <= 1.0,
                |v| v >= 0.0,
            ),
            rule("ltv", "债务/可比资产价值", "≤60%", |v| v <= 0.6, ratio),
            rule(
                "interest_coverage",
                "经营收益/利息",
                "≥2倍",
                |v| v >= 2.0,
                signed,
            ),
        ],
        "broker" => vec![
            rule(
                "net_capital_buffer",
                "净资本高于适用要求的缓冲",
                ">0",
                positive,
                signed,
            ),
            rule(
                "liquidity_buffer",
                "流动性高于适用要求的缓冲",
                ">0",
                positive,
                signed,
            ),
        ],
        "pre_profit_milestone" => vec![
            rule(
                "cash_runway_months",
                "压力情景现金生存期",
                "≥18个月",
                |v| v >= 18.0,
                |v| v >= 0.0,
            ),
            rule(
                "milestone_on_track",
                "关键节点按期且已核验",
                "=1；延期/失败=0",
                |v| v == 1.0,
                |v| v == 0.0 || v == 1.0,
            ),
            rule(
                "funding_gap",
                "下一关键节点前融资缺口",
                "≤0（本币元）",
                |v| v <= 0.0,
                signed,
            ),
        ],
        "stable_cash_dividend" | "exchange" => vec![
            rule(
                "fcf_dividend_coverage",
                "维护资本开支后现金流/分红",
                "≥1倍",
                |v| v >= 1.0,
                signed,
            ),
            rule(
                "net_debt_ebitda",
                "净债务/EBITDA",
                "≤3倍",
                |v| v <= 3.0,
                signed,
            ),
            rule(
                "interest_coverage",
                "经营收益/利息",
                "≥2倍",
                |v| v >= 2.0,
                signed,
            ),
        ],
        _ => vec![
            rule("roic_spread", "增量ROIC减资本成本", ">0", positive, signed),
            rule(
                "diluted_eps_growth",
                "可比扣非摊薄EPS同比",
                "≥0",
                |v| v >= 0.0,
                signed,
            ),
            rule(
                "cash_conversion",
                "同期间经营现金/利润",
                "≥80%",
                |v| v >= 0.8,
                signed,
            ),
        ],
    }
}

pub fn verify_industry(archetype: &str, facts: &Value, now_ms: i64) -> Value {
    let checks: Vec<Value> = rules(archetype).into_iter().map(|rule| {
        let matching:Vec<&Value> = facts.as_array().into_iter().flatten().filter(|f|f["key"]==rule.key).collect();
        let fact=matching.first().copied().unwrap_or(&Value::Null);
        let numeric=fact["value"].as_f64().filter(|v|v.is_finite());
        let valid=matching.len()==1 && numeric.is_some_and(rule.valid)
            && date_ms(&fact["period"]).is_some_and(|period| valid_source(&fact["source"],now_ms)
                && date_ms(&fact["source"]["publishedAt"]).is_some_and(|published|period<=published)
                && now_ms-period<=240*DAY_MS);
        let state=if !valid {"unknown"} else if (rule.test)(numeric.unwrap()) {"pass"} else {"fail"};
        json!({"key":rule.key,"label":rule.label,"rule":rule.text,"value":if valid {json!(numeric)} else {Value::Null},"state":state,"reason":if !valid {"缺少唯一、有效、240天内、有日期及人工核验来源的可比指标。"} else {"按已提供证据计算；来源真实性、适用要求和会计口径仍由研究复核人负责。"}})
    }).collect();
    let state = if checks.iter().any(|v| v["state"] == "fail") {
        "fail"
    } else if checks.iter().all(|v| v["state"] == "pass") {
        "pass"
    } else {
        "unknown"
    };
    json!({"version":"industry-quality-v1","archetype":archetype,"state":state,"checks":checks,"caveat":"研究政策阈值，不是法定监管标准或收益预测；缺失不通过，人工证据不冒充自动抓取。"})
}

pub fn expectations(input: &Value, now_ms: i64) -> Value {
    let mut result = json!({"status":"unavailable","reasons":[],"impliedGrowth":null,"scenarios":[],"method":"每股权益收益情景：逐年分红＋期末盈利倍数；反解达到要求回报率所需的盈利增长","caveats":["不是DCF或一致预期，不自动替代行业主估值。","分红与终值均考虑假设稀释；增长、分红和再投资的可行性须人工验证。","不支持跨币种混算或亏损基数；不计算没有依据的概率加权目标价。"]});
    let mut reasons = Vec::<String>::new();
    if input.is_null() {
        result["reasons"] = json!(["尚未录入有来源的盈利、市值与情景假设。"]);
        return result;
    }
    let n = |key: &str| input[key].as_f64().filter(|v| v.is_finite());
    let valid_numbers = [
        "marketCap",
        "normalizedProfit",
        "years",
        "requiredReturn",
        "annualDilution",
    ]
    .iter()
    .all(|key| n(key).is_some())
        && n("marketCap").is_some_and(|v| v > 0.0)
        && n("normalizedProfit").is_some_and(|v| v > 0.0)
        && n("years").is_some_and(|v| v.fract() == 0.0 && (1.0..=10.0).contains(&v))
        && n("requiredReturn").is_some_and(|v| v > 0.0 && v <= 0.5)
        && n("annualDilution").is_some_and(|v| (0.0..=0.5).contains(&v))
        && input["currency"]
            .as_str()
            .is_some_and(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase()))
        && input["amountScale"] == "base_units";
    if !valid_numbers {
        reasons.push("数值、币种或金额单位无效；使用同币种本币元、1–10年、正利润。".into());
    }
    if !date_ms(&input["priceDate"])
        .is_some_and(|date| date <= now_ms && now_ms - date <= 7 * DAY_MS)
        || !date_ms(&input["profitPeriod"])
            .is_some_and(|date| date <= now_ms && now_ms - date <= 240 * DAY_MS)
    {
        reasons.push("行情/盈利期间缺失、未来或过期。".into());
    }
    if !["marketCap", "profit", "assumptions"]
        .iter()
        .all(|key| valid_source(&input["sources"][key], now_ms))
    {
        reasons.push("市值、盈利及假设都需HTTPS来源、发布日期、核验日期和口径说明。".into());
    }
    let scenarios = input["scenarios"].as_array();
    let valid_scenarios = scenarios.is_some_and(|rows| {
        rows.len() == 3
            && rows
                .iter()
                .map(|v| string(&v["name"]))
                .collect::<HashSet<_>>()
                .len()
                == 3
            && rows.iter().all(|scenario| {
                ["bear", "base", "bull"].contains(&string(&scenario["name"]))
                    && scenario["growth"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v > -0.95 && v <= 2.0)
                    && scenario["terminalMultiple"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v > 0.0 && v <= 100.0)
                    && scenario["payoutRatio"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v))
                    && !string(&scenario["rationale"]).trim().is_empty()
            })
    });
    if !valid_scenarios {
        reasons.push("必须填写悲观/基准/乐观三个有效情景及理由。".into());
    }
    if let (Some(period), Some(published)) = (
        date_ms(&input["profitPeriod"]),
        date_ms(&input["sources"]["profit"]["publishedAt"]),
    ) && period > published
    {
        reasons.push("盈利来源发布日期早于盈利期间截至日。".into());
    }
    if !reasons.is_empty() {
        result["reasons"] = json!(reasons);
        return result;
    }
    let market_cap = n("marketCap").unwrap();
    let years = n("years").unwrap() as i32;
    let profit = n("normalizedProfit").unwrap();
    let dilution = n("annualDilution").unwrap();
    let required = n("requiredReturn").unwrap();
    let pv = |growth: f64, multiple: f64, payout: f64, rate: f64| {
        let mut total = 0.0;
        for y in 1..=years {
            total += profit * ((1.0 + growth) / (1.0 + dilution)).powi(y) * payout
                / (1.0 + rate).powi(y);
        }
        total
            + profit * ((1.0 + growth) / (1.0 + dilution)).powi(years) * multiple
                / (1.0 + rate).powi(years)
    };
    let solve =
        |f: &dyn Fn(f64) -> f64, mut low: f64, mut high: f64, increasing: bool| -> Option<f64> {
            if if increasing {
                f(low) > market_cap || f(high) < market_cap
            } else {
                f(low) < market_cap || f(high) > market_cap
            } {
                return None;
            }
            for _ in 0..100 {
                let mid = (low + high) / 2.0;
                if (f(mid) < market_cap) == increasing {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            Some((low + high) / 2.0)
        };
    let scenarios = scenarios.unwrap();
    let base = scenarios.iter().find(|s| s["name"] == "base").unwrap();
    let implied = solve(
        &|g| {
            pv(
                g,
                base["terminalMultiple"].as_f64().unwrap(),
                base["payoutRatio"].as_f64().unwrap(),
                required,
            )
        },
        -0.95,
        2.0,
        true,
    );
    result["impliedGrowth"] = json!(implied);
    let mut computed = Vec::new();
    for scenario in scenarios {
        let growth = scenario["growth"].as_f64().unwrap();
        let multiple = scenario["terminalMultiple"].as_f64().unwrap();
        let payout = scenario["payoutRatio"].as_f64().unwrap();
        let value = pv(growth, multiple, payout, required);
        let irr = solve(&|r| pv(growth, multiple, payout, r), -0.95, 10.0, false);
        if !value.is_finite() || irr.is_none() {
            reasons.push("情景收益率超出可求解范围。".into());
            continue;
        }
        computed.push(json!({"name":scenario["name"],"presentEquityValue":value,"annualizedReturn":irr,"margin":1.0-market_cap/value}));
    }
    let ordered: Vec<Option<f64>> = ["bear", "base", "bull"]
        .iter()
        .map(|name| {
            computed
                .iter()
                .find(|s| s["name"] == *name)
                .and_then(|s| s["presentEquityValue"].as_f64())
        })
        .collect();
    if ordered.iter().all(Option::is_some)
        && !(ordered[0].unwrap() <= ordered[1].unwrap()
            && ordered[1].unwrap() <= ordered[2].unwrap())
    {
        reasons.push("悲观/基准/乐观估值次序不一致，请复核假设。".into());
    }
    if implied.is_none() {
        reasons.push("隐含增长超出[-95%,200%]可求解区间。".into());
    }
    result["status"] = json!(if reasons.is_empty() {
        "available"
    } else {
        "unavailable"
    });
    result["reasons"] = json!(reasons);
    result["scenarios"] = json!(computed);
    result
}

pub fn research_template(archetype: &str) -> Value {
    json!({"thesis":{"status":"draft","business":"","marketConcern":"","variantView":"","counterEvidence":"","nextReview":"","invalidation":"","changeReason":"","changeType":"facts","evidence":[],"indicators":[]},"industryFacts":rules(archetype).iter().map(|r|json!({"key":r.key,"value":0,"period":"","source":{"url":"","publishedAt":"","checkedAt":"","note":""}})).collect::<Vec<_>>(),"expectations":null})
}

fn source_fields(source: &Value) -> bool {
    ["url", "publishedAt", "checkedAt", "note"]
        .iter()
        .all(|key| source[key].is_string())
}
pub fn validate_draft(draft: &Value, now_ms: i64) -> Result<()> {
    if !draft.is_object() {
        bail!("研究记录必须是对象");
    }
    let thesis = &draft["thesis"];
    let status = string(&thesis["status"]);
    if !["draft", "reviewed", "invalidated"].contains(&status)
        || !["facts", "price", "model", "data_repair"].contains(&string(&thesis["changeType"]))
    {
        bail!("论点状态/变更类型无效");
    }
    for key in [
        "business",
        "marketConcern",
        "variantView",
        "counterEvidence",
        "nextReview",
        "invalidation",
        "changeReason",
    ] {
        if !thesis[key]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 10000)
        {
            bail!("论点字段无效或过长");
        }
    }
    if string(&thesis["changeReason"]).trim().is_empty() {
        bail!("保存必须说明变更原因");
    }
    if !string(&thesis["nextReview"]).is_empty() && !valid_date(&thesis["nextReview"]) {
        bail!("验证日期无效");
    }
    let evidence = thesis["evidence"].as_array().context("论点证据来源无效")?;
    if evidence.len() > 30
        || !evidence
            .iter()
            .all(|s| source_fields(s) && (status != "reviewed" || valid_source(s, now_ms)))
    {
        bail!("论点证据来源无效");
    }
    let indicators = thesis["indicators"].as_array().context("验证指标无效")?;
    if indicators.len() > 20
        || !indicators.iter().all(|i| {
            ["name", "baseline", "condition"]
                .iter()
                .all(|key| i[key].is_string())
                && source_fields(&i["source"])
                && (status != "reviewed" || valid_source(&i["source"], now_ms))
        })
    {
        bail!("验证指标无效");
    }
    let today = DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis();
    if status == "reviewed"
        && (evidence.is_empty()
            || indicators.len() < 3
            || [
                "business",
                "variantView",
                "marketConcern",
                "counterEvidence",
                "invalidation",
            ]
            .iter()
            .any(|key| string(&thesis[key]).trim().is_empty())
            || !date_ms(&thesis["nextReview"]).is_some_and(|date| date >= today)
            || indicators.iter().any(|i| {
                ["name", "baseline", "condition"]
                    .iter()
                    .any(|key| string(&i[key]).trim().is_empty())
            }))
    {
        bail!("已复核论点需完整论据、反证、至少三个验证指标、未来验证日期和失效条件");
    }
    if status == "invalidated" && string(&thesis["invalidation"]).trim().is_empty() {
        bail!("失效记录必须说明失效条件/事实");
    }
    let facts = draft["industryFacts"]
        .as_array()
        .context("行业指标格式无效")?;
    if facts.len() > 30
        || facts.iter().any(|f| {
            !f["key"].is_string()
                || !f["value"].as_f64().is_some_and(f64::is_finite)
                || !f["period"].is_string()
                || f["source"].is_null()
        })
    {
        bail!("行业指标格式无效");
    }
    if draft.get("expectations").is_none()
        || (!draft["expectations"].is_null() && !draft["expectations"].is_object())
    {
        bail!("情景必须为对象或null");
    }
    Ok(())
}

fn prefix(code: &str) -> String {
    format!("observation-research:v1:{code}:")
}
fn cohort_prefix(code: &str) -> String {
    format!("observation-cohort:v1:{code}:")
}
fn outcome_prefix(code: &str) -> String {
    format!("observation-outcome:v1:{code}:")
}

pub async fn versions(db: &Database, code: &str, limit: usize) -> Result<Vec<Value>> {
    load_prefix(db, &prefix(code), limit.clamp(1, 100)).await
}
async fn load_prefix(db: &Database, prefix: &str, limit: usize) -> Result<Vec<Value>> {
    let rows=db.query("SELECT value_json FROM kv_cache WHERE namespace=? AND key>=? AND key<? ORDER BY key DESC LIMIT ?",vec![NS.into(),prefix.into(),format!("{prefix}~").into(),json!(limit)]).await?;
    rows.iter()
        .map(|row| {
            Ok(serde_json::from_str(
                row["value_json"]
                    .as_str()
                    .context("invalid observation record")?,
            )?)
        })
        .collect()
}

pub async fn read_research(
    db: &Database,
    code: &str,
    archetype: &str,
    can_write: bool,
) -> Result<Value> {
    let records = versions(db, code, 100).await?;
    let current = records.first().cloned().unwrap_or(Value::Null);
    Ok(
        json!({"canWrite":can_write,"code":code,"archetype":archetype,"current":current,"versions":records.iter().map(|v|json!({"version":v["version"],"recordedAt":v["recordedAt"],"status":v["thesis"]["status"],"changeType":v["thesis"]["changeType"],"changeReason":v["thesis"]["changeReason"]})).collect::<Vec<_>>(),"industry":verify_industry(archetype,&current["industryFacts"],now()),"expectationResult":expectations(&current["expectations"],now()),"template":research_template(archetype)}),
    )
}

#[derive(Debug)]
pub struct ObservationConflict(pub &'static str);
impl std::fmt::Display for ObservationConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ObservationConflict {}

pub async fn save_research(
    db: &Database,
    code: &str,
    archetype: &str,
    expected_version: &Value,
    draft: &Value,
) -> Result<Value> {
    let version = expected_version
        .as_u64()
        .or_else(|| {
            expected_version
                .as_f64()
                .filter(|v| {
                    v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v < 9_007_199_254_740_992.0
                })
                .map(|v| v as u64)
        })
        .context("expectedVersion无效")?;
    validate_draft(draft, now())?;
    if draft
        .as_object()
        .unwrap()
        .keys()
        .any(|key| !["thesis", "industryFacts", "expectations"].contains(&key.as_str()))
    {
        bail!("不允许额外字段；账户、仓位和交易信息不得写入研究记录");
    }
    let industry = verify_industry(archetype, &draft["industryFacts"], now());
    let expectation_result = expectations(&draft["expectations"], now());
    let mut record = draft.clone();
    record["code"] = json!(code);
    record["version"] = json!(version.checked_add(1).context("expectedVersion无效")?);
    record["recordedAt"] = json!(iso(now()));
    record["industry"] = industry;
    record["expectationResult"] = expectation_result;
    let prefix = prefix(code);
    let record_copy = record.clone();
    db.run(move |conn| {
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous:Option<String>=tx.query_row("SELECT value_json FROM kv_cache WHERE namespace=? AND key>=? AND key<? ORDER BY key DESC LIMIT 1",params![NS,prefix,format!("{prefix}~")],|row|row.get(0)).optional()?;
        let current=previous.map(|raw|serde_json::from_str::<Value>(&raw)).transpose()?.and_then(|v|v["version"].as_u64()).unwrap_or(0);
        if current!=version {return Err(ObservationConflict("记录已被其他编辑更新，请重新读取后合并；未覆盖原记录").into());}
        if record_copy["thesis"]["status"]=="reviewed"&&(record_copy["industry"]["state"]!="pass"||record_copy["expectationResult"]["status"]!="available") {bail!("已复核论点还需行业专用质量通过和完整可计算情景；缺口不能自动通过");}
        if let Err(error)=tx.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?)",params![NS,format!("{prefix}{:010}",version+1),record_copy.to_string(),now()]) {
            if error.sqlite_error_code()==Some(rusqlite::ErrorCode::ConstraintViolation) {return Err(ObservationConflict("并发编辑冲突；原记录已保留，请重新读取").into());}
            return Err(error.into());
        }
        tx.commit()?;
        Ok(())
    }).await?;
    Ok(record)
}

/// Only a successful fenced dashboard writer calls this. First UTC-day capture
/// wins, including excluded observations; never infer a historical cohort.
pub async fn append_cohort(db: &Database, row: &Value) -> Result<()> {
    let recorded_at = iso(now());
    let day = &recorded_at[..10];
    let record = json!({"id":format!("{}:{day}",string(&row["code"])),"code":row["code"],"recordedAt":recorded_at,"quoteDate":row["opportunity"]["price"]["asOf"],"stage":row["opportunity"].get("stage").filter(|v|!v.is_null()).cloned().unwrap_or(json!("insufficient_data")),"policyVersion":row["opportunity"].get("policyVersion").filter(|v|!v.is_null()).cloned().unwrap_or(json!("missing")),"dependencyRevision":row["computation"]["revision"],"computationId":row["computation"]["id"],"gates":row["opportunity"].get("gates").filter(|v|!v.is_null()).cloned().unwrap_or(json!([])),"signals":row["opportunity"].get("signals").filter(|v|!v.is_null()).cloned().unwrap_or(json!([])),"researchVersion":row["researchVersion"]});
    db.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?) ON CONFLICT(namespace,key) DO NOTHING",vec![NS.into(),format!("{}{day}",cohort_prefix(string(&row["code"]))).into(),record.to_string().into(),now().into()]).await?;
    Ok(())
}

pub fn evaluate_cohort(
    cohort: &Value,
    bars: &[Value],
    benchmark: &[Value],
    now_ms: i64,
    benchmark_code: Option<&str>,
) -> Vec<Value> {
    let valid = |rows: &[Value]| {
        !rows.is_empty()
            && rows.iter().all(|row| {
                date_ms(&row["date"]).is_some_and(|date| date <= now_ms)
                    && row["close"]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n > 0.0)
            })
            && rows
                .iter()
                .map(|r| string(&r["date"]))
                .collect::<HashSet<_>>()
                .len()
                == rows.len()
    };
    let mut rows = bars.to_vec();
    rows.sort_by(|a, b| string(&a["date"]).cmp(string(&b["date"])));
    let recorded = string(&cohort["recordedAt"]);
    let day = recorded.get(..10).unwrap_or(recorded);
    let start = rows.iter().position(|row| string(&row["date"]) > day);
    [20usize,60,120].into_iter().map(|horizon| {
        let mut result=json!({"id":cohort["id"],"horizon":horizon,"return":null,"benchmarkReturn":null,"excessReturn":null,"endDate":null,"evaluatedAt":iso(now_ms)});
        let fail=if !valid(&rows) {Some(("unavailable","雪球前复权序列无效。"))}
            else if start.is_none() {Some(("pending","尚无记录日期之后的交易日，等待真实前瞻样本。"))}
            else if string(&rows[0]["date"])>day {Some(("unavailable","行情窗口未覆盖记录日，无法确认首个后续交易日。"))}
            else if rows.get(start.unwrap()+horizon).is_none() {Some(("pending","尚未达到所需证券交易日数；不填零收益。"))}
            else {None};
        if let Some((state,reason))=fail {result["state"]=json!(state);result["reason"]=json!(reason);return result;}
        let entry=&rows[start.unwrap()];let end=&rows[start.unwrap()+horizon];
        if (date_ms(&end["date"]).unwrap()-date_ms(&entry["date"]).unwrap()) as f64>horizon as f64*2.2*DAY_MS as f64 {result["state"]=json!("unavailable");result["reason"]=json!("停牌/缺失跨度异常，不能作为普通交易窗口。");return result;}
        let ret=end["close"].as_f64().unwrap()/entry["close"].as_f64().unwrap()-1.0;
        let b0=benchmark.iter().find(|r|r["date"]==entry["date"]);let b1=benchmark.iter().find(|r|r["date"]==end["date"]);
        let br=if valid(benchmark) {b0.zip(b1).map(|(a,b)|b["close"].as_f64().unwrap()/a["close"].as_f64().unwrap()-1.0)} else {None};
        result["evidence"]=json!({"source":"xueqiu_qfq","entryDate":entry["date"],"entryClose":entry["close"],"exitClose":end["close"],"benchmarkCode":benchmark_code,"benchmarkEntryClose":if br.is_some() {b0.unwrap()["close"].clone()} else {Value::Null},"benchmarkExitClose":if br.is_some() {b1.unwrap()["close"].clone()} else {Value::Null}});
        result["state"]=json!("matured");result["return"]=json!(ret);result["benchmarkReturn"]=json!(br);result["excessReturn"]=json!(br.map(|b|ret-b));result["endDate"]=end["date"].clone();result["reason"]=json!(if br.is_none() {"同市场基准未覆盖，绝对收益有效、超额收益留空。"} else {"同日期基准比较；不是组合收益或严格总回报。"});result
    }).collect()
}

pub fn summarize_history(cohorts: &[Value], outcomes: &[Value]) -> Vec<Value> {
    let mut policies = Vec::new();
    let mut seen = HashSet::new();
    for cohort in cohorts {
        let key = format!(
            "{}:{}",
            string(&cohort["policyVersion"]),
            string(&cohort["dependencyRevision"])
        );
        if seen.insert(key) {
            policies.push((
                cohort["policyVersion"].clone(),
                cohort["dependencyRevision"].clone(),
            ));
        }
    }
    let mut result = Vec::new();
    for (policy, revision) in policies {
        for group in ["candidate", "excluded"] {
            for horizon in [20, 60, 120] {
                let ids: HashSet<&str> = cohorts
                    .iter()
                    .filter(|c| {
                        c["policyVersion"] == policy
                            && c["dependencyRevision"] == revision
                            && (c["stage"] == "research_candidate") == (group == "candidate")
                    })
                    .map(|c| string(&c["id"]))
                    .collect();
                let rows: Vec<&Value> = outcomes
                    .iter()
                    .filter(|o| ids.contains(string(&o["id"])) && o["horizon"] == horizon)
                    .collect();
                let matured: Vec<f64> = rows
                    .iter()
                    .filter(|o| o["state"] == "matured")
                    .filter_map(|o| o["return"].as_f64().filter(|n| n.is_finite()))
                    .collect();
                let excess: Vec<f64> = rows
                    .iter()
                    .filter(|o| {
                        o["state"] == "matured" && o["return"].as_f64().is_some_and(f64::is_finite)
                    })
                    .filter_map(|o| o["excessReturn"].as_f64().filter(|n| n.is_finite()))
                    .collect();
                result.push(json!({"policyVersion":policy,"dependencyRevision":revision,"group":group,"horizon":horizon,"samples":matured.len(),"pending":rows.iter().filter(|o|o["state"]=="pending").count(),"unavailable":rows.iter().filter(|o|o["state"]=="unavailable").count(),"meanReturn":if matured.is_empty(){None}else{Some(matured.iter().sum::<f64>()/matured.len() as f64)},"meanExcessReturn":if excess.is_empty(){None}else{Some(excess.iter().sum::<f64>()/excess.len() as f64)}}));
            }
        }
    }
    result
}

pub async fn read_history(db: &Database, code: &str) -> Result<Value> {
    let cohorts_prefix = cohort_prefix(code);
    let outcomes_prefix = outcome_prefix(code);
    let (cohorts, mut outcomes) = tokio::try_join!(
        load_prefix(db, &cohorts_prefix, 180),
        load_prefix(db, &outcomes_prefix, 540)
    )?;
    for cohort in &cohorts {
        for horizon in [20, 60, 120] {
            if !outcomes
                .iter()
                .any(|o| o["id"] == cohort["id"] && o["horizon"] == horizon)
            {
                outcomes.push(json!({"id":cohort["id"],"horizon":horizon,"state":"pending","return":null,"benchmarkReturn":null,"excessReturn":null,"endDate":null,"reason":"尚未执行前瞻效果核验。","evaluatedAt":""}));
            }
        }
    }
    Ok(
        json!({"summary":summarize_history(&cohorts,&outcomes),"cohorts":cohorts,"outcomes":outcomes,"limitations":["只展示最近180个真实记录日；首次每天计算同时记录入选和排除结果，历史不可补造。","以记录UTC日期之后的首个证券交易日收盘作为观察起点，不是实际成交或组合收益。","20/60/120证券交易日价格收益，使用同次雪球前复权序列；不是严格总回报，数据源重述仍是限制。","同一公司相邻样本重叠且相关，均值不代表独立样本统计显著性；保留政策版本，不能混当策略胜率。","缺少行情/基准、停牌或未到期都单列；不以零填缺口，不自动交易。"]}),
    )
}

pub async fn save_outcomes(db: &Database, code: &str, outcomes: &[Value]) -> Result<()> {
    for chunk in outcomes.chunks(40) {
        let prefix = outcome_prefix(code);
        let chunk = chunk.to_vec();
        db.run(move |conn| {
            let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for outcome in chunk {
                let key=format!("{prefix}{}:{}",string(&outcome["id"]),outcome["horizon"]);
                tx.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at WHERE json_extract(kv_cache.value_json,'$.state') <> 'matured'",params![NS,key,outcome.to_string(),now()])?;
            }
            tx.commit()?;Ok(())
        }).await?;
    }
    Ok(())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/research/observation/{code}",
            get(read_route).post(write_route),
        )
        .route("/research/observation/{code}/history", get(history_route))
        .route(
            "/research/observation/{code}/evaluate",
            axum::routing::post(evaluate_route),
        )
        .layer(middleware::from_fn(limit_body))
}

async fn limit_body(request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let result = match to_bytes(body, MAX_BODY).await {
        Ok(bytes) => {
            next.run(Request::from_parts(parts, Body::from(bytes)))
                .await
        }
        Err(_) => {
            ApiError(StatusCode::PAYLOAD_TOO_LARGE, "研究记录超过120KB".into()).into_response()
        }
    };
    let mut response = result;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
fn client_error(error: anyhow::Error) -> ApiError {
    ApiError(
        if error.downcast_ref::<ObservationConflict>().is_some() {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        },
        error.to_string(),
    )
}
fn validate_target(state: &AppState, code: &str) -> Result<String, ApiError> {
    let code = codes::normalize(code);
    let targets = crate::dashboard::targets(state).map_err(ApiError::from)?;
    if !targets.iter().any(|target| target["code"] == code) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "证券不在已核验观察池中".into(),
        ));
    }
    Ok(code)
}
async fn read_route(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let code = validate_target(&state, &code)?;
    if let Some(version) = query.get("version").filter(|s| !s.is_empty()) {
        let requested = version.parse::<f64>().unwrap_or(f64::NAN);
        let record = versions(&state.db, &code, 100)
            .await?
            .into_iter()
            .find(|v| v["version"].as_f64() == Some(requested));
        return record
            .map(ok)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "版本不在可读取窗口".into()));
    }
    let archetype = crate::coverage::company_archetype(&code).unwrap_or_else(|| "other".into());
    Ok(ok(read_research(&state.db, &code, &archetype, true).await?))
}
async fn write_route(
    State(state): State<AppState>,
    Path(code): Path<String>,
    request: Request,
) -> ApiResult {
    let code = validate_target(&state, &code)?;
    if !request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| s.starts_with("application/json"))
    {
        return Err(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "仅接受application/json".into(),
        ));
    }
    let bytes = to_bytes(request.into_body(), MAX_BODY)
        .await
        .map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, "研究记录超过120KB".into()))?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.to_string()))?;
    let archetype = crate::coverage::company_archetype(&code).unwrap_or_else(|| "other".into());
    Ok(ok(save_research(
        &state.db,
        &code,
        &archetype,
        &body["expectedVersion"],
        &body["draft"],
    )
    .await
    .map_err(client_error)?))
}
async fn history_route(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    let code = validate_target(&state, &code)?;
    Ok(ok(read_history(&state.db, &code).await?))
}
async fn load_evaluation_bars(state: &AppState, code: &str, today: &str) -> Result<Vec<Value>> {
    let (rows, _) = crate::xueqiu::stock_kline(state, code, "qfq", today).await?;
    if rows.is_empty()
        || rows.iter().any(|r| {
            r["source"] != "xueqiu"
                || !["qfq", "before"].contains(&string(&r["fq"]))
                || !r["close"].is_number()
        })
    {
        bail!("雪球前复权序列缺失或口径不符");
    }
    Ok(rows
        .iter()
        .map(|r| json!({"date":r["date"],"close":r["close"]}))
        .collect())
}
async fn evaluate_route(
    State(state): State<AppState>,
    Path(code): Path<String>,
    request: Request,
) -> ApiResult {
    let code = validate_target(&state, &code)?;
    // Match the route-wide legacy limit even when evaluate ignores body content.
    to_bytes(request.into_body(), MAX_BODY)
        .await
        .map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, "研究记录超过120KB".into()))?;
    let history = read_history(&state.db, &code).await?;
    let cohorts = history["cohorts"].as_array().unwrap();
    if cohorts.is_empty() {
        return Ok(ok(history));
    }
    let targets = crate::dashboard::targets(&state)?;
    let target = targets
        .iter()
        .find(|target| target["code"] == code)
        .unwrap();
    let benchmark = match string(&target["market"]) {
        "CN" => Some("000300.SH"),
        "HK" => Some("HSI.HK"),
        "US" => Some("SPX.US"),
        _ => None,
    };
    let today = Utc::now().date_naive().to_string();
    let bars = load_evaluation_bars(&state, &code, &today)
        .await
        .map_err(|error| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                format!("雪球效果核验失败；保留原记录、不切源：{error}"),
            )
        })?;
    let benchmark_bars = if let Some(symbol) = benchmark {
        load_evaluation_bars(&state, symbol, &today)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let outcomes: Vec<Value> = cohorts
        .iter()
        .flat_map(|cohort| evaluate_cohort(cohort, &bars, &benchmark_bars, now(), benchmark))
        .collect();
    save_outcomes(&state.db, &code, &outcomes).await?;
    Ok(ok(read_history(&state.db, &code).await?))
}
