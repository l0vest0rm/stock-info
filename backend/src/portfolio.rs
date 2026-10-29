//! Private, append-only portfolio ledger and deterministic what-if arithmetic.
//! It never fetches prices, schedules research, sends notifications or trades.
use crate::{ApiError, ApiResult, AppState, db::Database, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Request, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

const NAMESPACE: &str = "private-active-portfolio-v1";
const MAX_BODY: usize = 150_000;
static UNIVERSE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../config/investment-universe.json"))
        .expect("validated investment universe")
});

#[derive(Debug)]
pub struct PortfolioConflict(pub String);
impl std::fmt::Display for PortfolioConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for PortfolioConflict {}
fn conflict(message: &str) -> anyhow::Error {
    PortfolioConflict(message.into()).into()
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| !trim(s).is_empty() && s.encode_utf16().count() <= max)
}
fn positive(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 1e15)
}
fn optional_positive(value: &Value) -> bool {
    value.is_null() || positive(value)
}
fn numeric(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn equal(left: &Value, right: &Value) -> bool {
    if left.is_number() && right.is_number() {
        left.as_f64() == right.as_f64()
    } else {
        left == right
    }
}
fn object(value: &Value, keys: &[&str]) -> Result<()> {
    let object = value.as_object().context("字段缺失或含不支持的额外字段")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        bail!("字段缺失或含不支持的额外字段");
    }
    Ok(())
}
fn only_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}
fn timestamp(value: &Value) -> Option<i64> {
    let value = value.as_str()?;
    static DATETIME: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$").unwrap()
    });
    if !DATETIME.is_match(value) {
        return None;
    }
    static MINUTE_PRECISION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$").unwrap()
    });
    let normalized = if MINUTE_PRECISION.is_match(value) {
        format!("{}:00{}", &value[..16], &value[16..])
    } else {
        value.into()
    };
    DateTime::parse_from_rfc3339(&normalized)
        .map(|time| time.timestamp_millis())
        .ok()
        .or_else(|| {
            DateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M%:z")
                .map(|time| time.timestamp_millis())
                .ok()
        })
}

fn now_iso(now: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn security_code(security: &Value) -> String {
    let ticker = string(&security["ticker"]);
    if security["market"] == "US" && !ticker.ends_with(".US") {
        format!("{ticker}.US")
    } else {
        ticker.into()
    }
}
fn company(code: &str) -> Option<&'static Value> {
    array(&UNIVERSE["companies"]).iter().find(|company| {
        array(&company["securities"])
            .iter()
            .any(|security| security_code(security) == code)
    })
}

pub fn portfolio_template() -> Value {
    json!({"strategy":"diversified_active","baseCurrency":"CNY","asOf":"","source":"",
        "rules":{"maxHoldings":39,"maxCompanyWeight":null,"maxSectorWeight":null,"benchmark":""},"positions":[],"cash":[]})
}

pub fn validate_portfolio(draft: &Value, now: i64) -> Result<()> {
    object(
        draft,
        &[
            "strategy",
            "baseCurrency",
            "asOf",
            "source",
            "rules",
            "positions",
            "cash",
        ],
    )?;
    let currencies = ["CNY", "HKD", "USD", "KRW"];
    if draft["strategy"] != "diversified_active"
        || !currencies.contains(&string(&draft["baseCurrency"]))
    {
        bail!("策略或基准币种无效");
    }
    let as_of = string(&draft["asOf"]);
    let valid_calendar = as_of
        .get(..10)
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .is_some_and(|date| as_of.get(..10) == Some(&date.to_string()));
    if !valid_calendar
        || !text(&draft["asOf"], 200)
        || !as_of.contains('T')
        || timestamp(&draft["asOf"]).is_none_or(|at| at > now)
    {
        bail!("快照时间必须是含时区的非未来时间");
    }
    if !text(&draft["source"], 1000) {
        bail!("请填写快照来源及核对口径");
    }
    let rules = &draft["rules"];
    object(
        rules,
        &[
            "maxHoldings",
            "maxCompanyWeight",
            "maxSectorWeight",
            "benchmark",
        ],
    )?;
    if rules["maxHoldings"].as_f64() != Some(39.0)
        || ["maxCompanyWeight", "maxSectorWeight"].iter().any(|key| {
            !rules[key].is_null() && (!positive(&rules[key]) || numeric(&rules[key]) > 1.0)
        })
        || !rules["benchmark"].is_string()
        || string(&rules["benchmark"]).encode_utf16().count() > 200
    {
        bail!("持仓上限固定39；权重上限须为0至1之间的正数或留空");
    }
    if !draft["positions"].is_array()
        || !draft["cash"].is_array()
        || array(&draft["positions"]).len() > 200
        || array(&draft["cash"]).len() > 100
        || (array(&draft["positions"]).is_empty() && array(&draft["cash"]).is_empty())
    {
        bail!("请录入持仓或现金；明细超出支持范围");
    }
    let mut seen = HashSet::new();
    let valid_code =
        regex::Regex::new(r"^(?:\d{6}\.(?:SH|SZ|BJ|KS|KQ)|\d{5}\.HK|[A-Z0-9.-]+\.US)$").unwrap();
    for position in array(&draft["positions"]) {
        object(
            position,
            &[
                "account", "code", "quantity", "price", "currency", "fxToBase",
            ],
        )?;
        if !text(&position["account"], 80)
            || string(&position["account"]) != trim(string(&position["account"]))
            || !text(&position["code"], 40)
            || !valid_code.is_match(string(&position["code"]))
            || !positive(&position["quantity"])
            || !optional_positive(&position["price"])
        {
            bail!("持仓账户、证券代码、数量或价格无效");
        }
        let expected = match string(&position["code"]).rsplit('.').next().unwrap_or("") {
            "SH" | "SZ" | "BJ" => "CNY",
            "HK" => "HKD",
            "US" => "USD",
            "KS" | "KQ" => "KRW",
            _ => "",
        };
        if position["currency"] != expected {
            bail!("持仓价格币种必须匹配证券交易币种");
        }
        if !seen.insert((string(&position["account"]), string(&position["code"]))) {
            bail!("同账户同证券不能重复；请先合并数量");
        }
    }
    seen.clear();
    for cash in array(&draft["cash"]) {
        object(cash, &["account", "currency", "amount", "fxToBase"])?;
        if !text(&cash["account"], 80)
            || string(&cash["account"]) != trim(string(&cash["account"]))
            || cash["amount"]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || !(0.0..=1e15).contains(&n))
        {
            bail!("现金金额或账户无效；暂不支持融资与负债账户");
        }
        if !seen.insert((string(&cash["account"]), string(&cash["currency"]))) {
            bail!("同账户同币种现金不能重复");
        }
    }
    for entry in array(&draft["positions"])
        .iter()
        .chain(array(&draft["cash"]))
    {
        if !currencies.contains(&string(&entry["currency"]))
            || !optional_positive(&entry["fxToBase"])
            || (entry["currency"] == draft["baseCurrency"]
                && entry["fxToBase"].as_f64() != Some(1.0))
        {
            bail!("币种或汇率无效；汇率为1单位原币折合基准币，本币必须为1");
        }
    }
    Ok(())
}

fn task(
    current: Option<&Value>,
    kind: &str,
    subject: &str,
    title: &str,
    reason: &str,
    evidence: Vec<String>,
    action: &str,
) -> Value {
    let snapshot = current
        .map(|value| value["snapshotVersion"].clone())
        .unwrap_or(json!(0));
    let id = serde_json::to_string(&json!([snapshot, kind, subject, reason, evidence]))
        .expect("finite task identity");
    let decision = current
        .and_then(|current| {
            array(&current["decisions"])
                .iter()
                .find(|d| d["taskId"] == id)
        })
        .cloned()
        .unwrap_or(Value::Null);
    json!({"id":id,"kind":kind,"subject":subject,"title":title,"reason":reason,"evidence":evidence,"action":action,"decision":decision})
}

// Exact positive IEEE-754 rounding used by JS Number.toFixed(2), including
// half-way values (Rust formatting rounds ties to even instead).
fn fixed2(number: f64) -> String {
    let bits = number.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = if exponent == 0 {
        bits & ((1_u64 << 52) - 1)
    } else {
        (bits & ((1_u64 << 52) - 1)) | (1_u64 << 52)
    };
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let numerator = u128::from(mantissa) * 100;
    let rounded = if shift >= 0 {
        numerator.checked_shl(shift as u32).unwrap_or(u128::MAX)
    } else if -shift >= 128 {
        0
    } else {
        let denominator = 1_u128 << (-shift as u32);
        numerator / denominator + u128::from((numerator % denominator) * 2 >= denominator)
    };
    format!(
        "{}{}.{:02}",
        if number < 0.0 { "-" } else { "" },
        rounded / 100,
        rounded % 100
    )
}

fn add_group(groups: &mut Vec<Value>, id: &str, name: &str, value: f64) {
    if let Some(group) = groups.iter_mut().find(|group| group["id"] == id) {
        group["value"] = json!(numeric(&group["value"]) + value);
    } else {
        groups.push(json!({"id":id,"name":name,"value":value}));
    }
}
fn valid_row<'a>(dashboard: &'a Value, code: &str, now: i64) -> Option<&'a Value> {
    let row = array(&dashboard["rows"])
        .iter()
        .find(|row| row["code"] == code)?;
    let age = now.checked_sub(timestamp(&row["computation"]["computedAt"])?)?;
    if row["opportunity"].is_null()
        || row["computation"]["revision"] != dashboard["revision"]
        || age < 0
        || age as f64 >= numeric(&dashboard["freshnessMs"])
        || array(&dashboard["pending"])
            .iter()
            .any(|pending| pending == code)
    {
        None
    } else {
        Some(row)
    }
}

pub fn assess_portfolio(current: Option<&Value>, dashboard: &Value, now: i64) -> Value {
    let mut tasks = Vec::new();
    let mut result = json!({"nav":null,"equityValue":null,"cashValue":null,"securityCount":0,"companyCount":0,"companies":[],"sectors":[],"tasks":[],"executable":false,"limitations":[
        "分散化主动组合，不复制指数；39只是上限，不要求凑满。",
        "权重分母为录入的股票市值加现金；不代表未录入的家庭资产。价格、汇率和数量来自人工核对快照，不自动当作最新行情。",
        "仅覆盖单公司与一级行业集中度；共同因子、币种风险、税费、可交易性与相关性尚未完成验证，不能据此认定组合已充分分散。",
        "仅提供站内复核待办和决策留痕，不发送外部推送、不自动交易、不生成已执行成交或组合业绩。"]});
    let Some(record) = current else {
        result["tasks"] = json!([task(
            None,
            "setup",
            "portfolio",
            "先建立真实组合快照",
            "尚无实际持仓与现金，不能从观察池推导调仓。",
            vec![],
            "录入持仓、现金、汇率和组合规则"
        )]);
        return result;
    };
    let draft = &record["draft"];
    let positions = array(&draft["positions"]);
    let cash = array(&draft["cash"]);
    let complete = positions
        .iter()
        .all(|p| !p["price"].is_null() && !p["fxToBase"].is_null())
        && cash.iter().all(|c| !c["fxToBase"].is_null());
    if !complete {
        tasks.push(task(
            current,
            "data",
            "valuation",
            "组合市值存在缺口",
            "价格或汇率缺失；总资产及全部权重留空，不以部分资产作分母。",
            vec![],
            "补齐同口径价格和汇率",
        ));
    }
    if timestamp(&draft["asOf"]).is_none_or(|at| now - at > 36 * 3_600_000 || at > now) {
        tasks.push(task(
            current,
            "data",
            "snapshot",
            "持仓快照需核对",
            "快照超过36小时或时间异常；显示的权重仅代表旧快照。",
            vec![string(&draft["asOf"]).into()],
            "核对最新数量、价格、现金和汇率后保存新快照",
        ));
    }
    if complete {
        let equity: f64 = positions
            .iter()
            .map(|p| numeric(&p["quantity"]) * numeric(&p["price"]) * numeric(&p["fxToBase"]))
            .sum();
        let cash: f64 = cash
            .iter()
            .map(|c| numeric(&c["amount"]) * numeric(&c["fxToBase"]))
            .sum();
        let nav = equity + cash;
        if nav.is_finite() && nav > 0.0 {
            result["nav"] = json!(nav);
            result["equityValue"] = json!(equity);
            result["cashValue"] = json!(cash);
        } else {
            tasks.push(task(
                current,
                "data",
                "nav",
                "总资产不可计算",
                "总资产必须为有限正数。",
                vec![],
                "核对资产金额",
            ));
        }
    }
    let mut companies = Vec::new();
    let mut sectors = Vec::new();
    for position in positions {
        let code = string(&position["code"]);
        let company = company(code);
        let id = company.map(|c| string(&c["id"])).unwrap_or(code);
        let value = if complete {
            numeric(&position["quantity"])
                * numeric(&position["price"])
                * numeric(&position["fxToBase"])
        } else {
            0.0
        };
        add_group(
            &mut companies,
            id,
            company.map(|c| string(&c["displayName"])).unwrap_or(code),
            value,
        );
        let sector_id = company
            .map(|c| string(&c["primarySectorId"]))
            .unwrap_or("unknown");
        let sector_name = array(&UNIVERSE["sectors"])
            .iter()
            .find(|s| s["id"] == sector_id)
            .map(|s| string(&s["name"]))
            .unwrap_or("未覆盖行业");
        add_group(&mut sectors, sector_id, sector_name, value);
        if let Some(company) = company {
            if company["classificationStatus"] != "verified"
                || !array(&company["securities"])
                    .iter()
                    .find(|s| security_code(s) == code)
                    .is_some_and(|s| s["identityVerified"] == true)
            {
                tasks.push(task(
                    current,
                    "data",
                    &format!("{code}:identity"),
                    "证券身份或行业分类待核验",
                    "研究归类不能代替交易权利核验。",
                    vec![code.into()],
                    "核实上市身份、证券权利和行业证据",
                ));
            }
        } else {
            tasks.push(task(
                current,
                "data",
                code,
                "持仓未纳入研究覆盖",
                "观察池外证券的公司合并、行业及研究覆盖待核验。",
                vec![code.into()],
                "先补研究身份与分类，不自动剔除真实持仓",
            ));
        }
    }
    let count = positions
        .iter()
        .map(|p| string(&p["code"]))
        .collect::<HashSet<_>>()
        .len();
    result["securityCount"] = json!(count);
    result["companyCount"] = json!(companies.len());
    for group in companies.iter_mut().chain(sectors.iter_mut()) {
        if let Some(nav) = result["nav"].as_f64() {
            group["weight"] = json!(numeric(&group["value"]) / nav);
        } else {
            group["value"] = Value::Null;
            group["weight"] = Value::Null;
        }
    }
    if count > 39 {
        tasks.push(task(
            current,
            "risk",
            "count",
            "持仓数量超过39只",
            &format!("当前{count}只证券；多账户同证券合并计数。"),
            vec![],
            "人工评估精简方案，不自动卖出",
        ));
    }
    for (key, groups, label) in [
        ("maxCompanyWeight", &companies, "单公司"),
        ("maxSectorWeight", &sectors, "行业"),
    ] {
        if draft["rules"][key].is_null() {
            tasks.push(task(
                current,
                "setup",
                key,
                &format!("{label}权重上限待配置"),
                "未配置不等于通过风险约束。",
                vec![],
                "按个人风险承受能力设置上限",
            ));
        } else {
            let limit = numeric(&draft["rules"][key]);
            for group in groups {
                if let Some(weight) = group["weight"].as_f64().filter(|weight| *weight > limit) {
                    tasks.push(task(
                        current,
                        "risk",
                        &format!("{key}:{}", string(&group["id"])),
                        &format!("{}超过{label}上限", string(&group["name"])),
                        &format!(
                            "快照权重{}%，上限{}%。",
                            fixed2(weight * 100.0),
                            fixed2(limit * 100.0)
                        ),
                        vec![string(&draft["asOf"]).into()],
                        "比较维持、新增资金调整与减持；先核实快照，勿直接生成交易",
                    ));
                }
            }
        }
    }
    if trim(string(&draft["rules"]["benchmark"])).is_empty() {
        tasks.push(task(
            current,
            "setup",
            "benchmark",
            "评价基准待确定",
            "基准用于评价，不用于机械配仓。",
            vec![],
            "填写长期评价基准及评价期限",
        ));
    }
    let mut seen = HashSet::new();
    for position in positions {
        let code = string(&position["code"]);
        if !seen.insert(code) || company(code).is_none() {
            continue;
        }
        let Some(row) = valid_row(dashboard, code, now) else {
            tasks.push(task(
                current,
                "data",
                code,
                &format!("{code}研究数据待更新"),
                "缺少当前有效研究结果，不能解释为经营恶化或安全。",
                vec![],
                "等待后台刷新或检查数据源；不更换行情来源",
            ));
            continue;
        };
        let op = &row["opportunity"];
        let flow = &op["workflow"];
        let mut evidence = vec![
            format!("研究版本:{}", row["researchVersion"].as_u64().unwrap_or(0)),
            format!("政策:{}", string(&op["policyVersion"])),
            format!("依赖:{}", string(&row["computation"]["revision"])),
            format!("论点:{}", string(&flow["thesisStatus"])),
        ];
        evidence.extend(array(&op["gates"]).iter().map(|gate| {
            format!(
                "{}:{}:{}",
                string(&gate["key"]),
                string(&gate["state"]),
                array(&gate["reasons"])
                    .iter()
                    .map(string)
                    .collect::<Vec<_>>()
                    .join("；")
            )
        }));
        if flow["thesisStatus"] == "invalidated" || flow["queue"] == "review_risk" {
            tasks.push(task(
                current,
                "risk",
                code,
                &format!("{code}持仓论点或经营风险待复核"),
                string(&flow["nextAction"]),
                evidence,
                "查看公司证据链，确认原论点是否失效；复核不等于卖出",
            ));
        } else if flow["queue"] == "repair_data" {
            tasks.push(task(
                current,
                "data",
                code,
                &format!("{code}研究证据存在缺口"),
                string(&flow["nextAction"]),
                evidence,
                "修复证据后再判断，不从缺失值推导买卖",
            ));
        } else if flow["thesisStatus"] != "reviewed" {
            tasks.push(task(
                current,
                "research",
                code,
                &format!("{code}持仓论点待验证"),
                string(&flow["nextAction"]),
                evidence,
                "完成论点与失效条件复核；未复核不自动换仓",
            ));
        }
    }
    let held: HashSet<&str> = positions
        .iter()
        .map(|p| {
            company(string(&p["code"]))
                .map(|c| string(&c["id"]))
                .unwrap_or_else(|| string(&p["code"]))
        })
        .collect();
    for row in array(&dashboard["rows"]) {
        let code = string(&row["code"]);
        let Some(company) = company(code) else {
            continue;
        };
        let Some(valid) = valid_row(dashboard, code, now) else {
            continue;
        };
        let op = &valid["opportunity"];
        if held.contains(string(&company["id"]))
            || op["stage"] != "research_candidate"
            || op["workflow"]["thesisStatus"] != "reviewed"
            || !array(&op["gates"])
                .iter()
                .all(|gate| gate["state"] == "pass")
        {
            continue;
        }
        tasks.push(task(current,"research",code,&format!("{}进入组合适配研究",string(&company["displayName"])),"量化初筛与人工论点复核通过，但尚未证明适合当前组合。",vec![format!("研究版本:{}",row["researchVersion"].as_u64().unwrap_or(0)),format!("政策:{}",string(&op["policyVersion"])),format!("依赖:{}",string(&row["computation"]["revision"]))],"比较维持不动、新增资金与替换持仓；先核验行业/共同风险、交易成本及账户可交易性，不直接买入"));
    }
    let mut ids = HashSet::new();
    tasks.retain(|task| ids.insert(string(&task["id"]).to_string()));
    tasks.sort_by_key(|task| match string(&task["kind"]) {
        "risk" => 0,
        "data" => 1,
        "setup" => 2,
        _ => 3,
    });
    result["companies"] = json!(companies);
    result["sectors"] = json!(sectors);
    result["tasks"] = json!(tasks);
    result
}

pub fn compare_proposal(
    current: &Value,
    input: &Value,
    dashboard: &Value,
    now: i64,
) -> Result<Value> {
    object(
        input,
        &[
            "title",
            "rationale",
            "target",
            "estimatedCosts",
            "externalCashFlow",
        ],
    )?;
    if !text(&input["title"], 120) || !text(&input["rationale"], 2000) {
        bail!("方案名称和比较理由必填");
    }
    let target = &input["target"];
    let draft = &current["draft"];
    validate_portfolio(target, now)?;
    if !input["estimatedCosts"].is_null()
        && input["estimatedCosts"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || !(0.0..=1e15).contains(&n))
    {
        bail!("费用必须为非负基准币金额或未知");
    }
    if input["externalCashFlow"]
        .as_f64()
        .is_none_or(|n| !n.is_finite() || n.abs() > 1e15)
    {
        bail!("新增/提取资金金额无效");
    }
    if target["baseCurrency"] != draft["baseCurrency"]
        || target["asOf"] != draft["asOf"]
        || [
            "maxHoldings",
            "maxCompanyWeight",
            "maxSectorWeight",
            "benchmark",
        ]
        .iter()
        .any(|key| !equal(&target["rules"][key], &draft["rules"][key]))
    {
        bail!("方案须沿用原快照的时间、基准币种和规则；不能靠改规则消除超限");
    }
    let before = assess_portfolio(Some(current), dashboard, now);
    let mut proposed = current.clone();
    proposed["draft"] = target.clone();
    proposed["decisions"] = json!([]);
    let after = assess_portfolio(Some(&proposed), dashboard, now);
    let entries: Vec<&Value> = [
        array(&draft["positions"]),
        array(&draft["cash"]),
        array(&target["positions"]),
        array(&target["cash"]),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut issues: Vec<String> = Vec::new();
    let mut account_currencies: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut accounts = HashSet::new();
    for entry in &entries {
        account_currencies
            .entry(string(&entry["account"]))
            .or_default()
            .insert(string(&entry["currency"]));
        accounts.insert(string(&entry["account"]));
    }
    if account_currencies
        .values()
        .any(|currencies| currencies.len() > 1)
    {
        issues.push("账户涉及多币种，须人工核验换汇、币种现金和账户交易权限。".into());
    }
    let mut prices: HashMap<&str, &Value> = HashMap::new();
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    for position in array(&draft["positions"])
        .iter()
        .chain(array(&target["positions"]))
    {
        let code = string(&position["code"]);
        if prices
            .get(code)
            .is_some_and(|price| !equal(price, &position["price"]))
        {
            bail!("同一证券跨账户比较必须使用相同价格；请先核对真实快照");
        }
        prices.insert(code, &position["price"]);
        let key = (string(&position["account"]), code);
        if seen.insert(key) {
            keys.push(key);
        }
    }
    let mut changes = Vec::new();
    let mut gross = 0.0;
    let mut known = true;
    for (account, code) in keys {
        let find = |positions: &[Value]| {
            positions
                .iter()
                .find(|p| p["account"] == account && p["code"] == code)
                .cloned()
        };
        let old = find(array(&draft["positions"]));
        let next = find(array(&target["positions"]));
        if let (Some(old), Some(next)) = (&old, &next)
            && ["price", "fxToBase", "currency"]
                .iter()
                .any(|key| !equal(&old[key], &next[key]))
        {
            bail!("同一持仓的价格/汇率不能在方案中变化；请先更新真实快照");
        }
        let quote = next.as_ref().or(old.as_ref()).expect("position key exists");
        let before_quantity = old.as_ref().map(|p| numeric(&p["quantity"])).unwrap_or(0.0);
        let after_quantity = next
            .as_ref()
            .map(|p| numeric(&p["quantity"]))
            .unwrap_or(0.0);
        let difference = after_quantity - before_quantity;
        if difference == 0.0 {
            continue;
        }
        let change = if quote["price"].is_null() || quote["fxToBase"].is_null() {
            None
        } else {
            Some(difference * numeric(&quote["price"]) * numeric(&quote["fxToBase"]))
        };
        changes.push(json!({"account":account,"code":code,"beforeQuantity":before_quantity,"afterQuantity":after_quantity,"valueChange":change}));
        if let Some(value) = change {
            gross += value.abs();
        } else {
            known = false;
        }
    }
    let mut rates: HashMap<&str, &Value> = HashMap::new();
    for entry in entries {
        let currency = string(&entry["currency"]);
        if rates
            .get(currency)
            .is_some_and(|rate| !equal(rate, &entry["fxToBase"]))
        {
            bail!("同一比较口径的同币种汇率必须一致");
        }
        rates.insert(currency, &entry["fxToBase"]);
    }
    let funding = before["nav"]
        .as_f64()
        .zip(after["nav"].as_f64())
        .zip(input["estimatedCosts"].as_f64())
        .map(|((before, after), costs)| {
            after + costs - before - numeric(&input["externalCashFlow"])
        });
    match funding {
        None => issues.push("估值或费用未齐，资金守恒尚未验证。".into()),
        Some(gap) if gap.abs() > 0.01 => {
            issues.push("目标股票与现金、费用、新增资金不平衡；不得当作可执行方案。".into())
        }
        _ => {}
    }
    if accounts.len() > 1 {
        issues.push("跨账户资金可用性/调拨尚未核验；总资产平衡不代表每个账户可执行。".into());
    }
    if array(&before["tasks"])
        .iter()
        .any(|t| ["data", "setup"].contains(&string(&t["kind"])))
    {
        issues.push("原组合存在数据或配置缺口，先完成核对。".into());
    }
    if array(&after["tasks"])
        .iter()
        .any(|t| ["data", "setup", "risk"].contains(&string(&t["kind"])))
    {
        issues.push("目标组合仍有数据、规则或风险待办，请逐项复核。".into());
    }
    issues.push(
        "共同风险、交易单位、流动性及实际税费需人工复核；确认方案不等于成交，也不会修改真实持仓。"
            .into(),
    );
    let turnover = if known {
        before["nav"].as_f64().map(|nav| gross / nav)
    } else {
        None
    };
    let mut result = input.clone();
    result["before"] = before;
    result["after"] = after;
    result["comparison"] =
        json!({"changes":changes,"turnover":turnover,"fundingGap":funding,"issues":issues});
    result["executable"] = json!(false);
    Ok(result)
}

fn versions_on(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn
        .prepare("SELECT value_json FROM kv_cache WHERE namespace=? ORDER BY key DESC LIMIT 100")?;
    let raw = stmt
        .query_map([NAMESPACE], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    raw.into_iter()
        .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .collect()
}
pub async fn versions(db: &Database) -> Result<Vec<Value>> {
    db.run(|conn| versions_on(conn)).await
}
pub async fn read(db: &Database, dashboard: &Value) -> Result<Value> {
    let versions = versions(db).await?;
    let current = versions.first();
    Ok(
        json!({"current":current,"template":portfolio_template(),"assessment":assess_portfolio(current,dashboard,Utc::now().timestamp_millis()),"history":versions.iter().map(|v|json!({"version":v["version"],"snapshotVersion":v["snapshotVersion"],"recordedAt":v["recordedAt"]})).collect::<Vec<_>>()}),
    )
}

fn next_version(
    current: Option<&Value>,
    expected: u64,
    command: &Value,
    dashboard: &Value,
    now: i64,
) -> Result<Value> {
    if current.map(|c| numeric(&c["version"])).unwrap_or(0.0) != expected as f64 {
        return Err(conflict("记录已更新；请重新读取后合并，原记录未覆盖"));
    }
    if !command.is_object() {
        bail!("命令无效");
    }
    let recorded = now_iso(now);
    let mut next = current.cloned().unwrap_or(Value::Null);
    match string(&command["type"]) {
        "snapshot" => {
            if !only_keys(command, &["type", "draft"]) {
                bail!("快照命令含额外字段");
            }
            validate_portfolio(&command["draft"], now)?;
            next = json!({"version":expected+1,"snapshotVersion":expected+1,"recordedAt":recorded,"draft":command["draft"],"decisions":[],"proposals":current.map(|c|array(&c["proposals"])).unwrap_or(&[])});
        }
        "decision" => {
            let Some(current) = current else {
                bail!("需先建立快照，且仅接受决策字段");
            };
            if !only_keys(command, &["type", "taskId", "choice", "reason", "until"]) {
                bail!("需先建立快照，且仅接受决策字段");
            }
            if !["keep", "reviewed", "defer"].contains(&string(&command["choice"]))
                || !text(&command["reason"], 2000)
            {
                bail!("请选择处理方式并填写理由");
            }
            let until = &command["until"];
            if command["choice"] == "defer" {
                if timestamp(until).is_none_or(|at| at <= now) {
                    bail!("延期须填写含时区的未来复核时间，其他处理方式until须为null");
                }
            } else if !command.as_object().unwrap().contains_key("until") || !until.is_null() {
                bail!("延期须填写含时区的未来复核时间，其他处理方式until须为null");
            }
            let assessment = assess_portfolio(Some(current), dashboard, now);
            let Some(task) = array(&assessment["tasks"])
                .iter()
                .find(|task| task["id"] == command["taskId"])
            else {
                return Err(conflict("待办依据已变化，请刷新后重新判断"));
            };
            let mut evidence = task.clone();
            evidence.as_object_mut().unwrap().remove("decision");
            let mut decisions = vec![
                json!({"taskId":task["id"],"choice":command["choice"],"reason":trim(string(&command["reason"])),"until":until,"recordedAt":recorded,"task":evidence}),
            ];
            decisions.extend(
                array(&current["decisions"])
                    .iter()
                    .filter(|d| d["taskId"] != task["id"])
                    .take(299)
                    .cloned(),
            );
            next["version"] = json!(expected + 1);
            next["recordedAt"] = json!(recorded);
            next["decisions"] = json!(decisions);
        }
        "proposal" => {
            let Some(current) = current else {
                bail!("需先建立真实组合；方案命令字段无效");
            };
            if !only_keys(command, &["type", "proposal"]) {
                bail!("需先建立真实组合；方案命令字段无效");
            }
            let mut proposal = compare_proposal(current, &command["proposal"], dashboard, now)?;
            proposal["id"] = json!(format!("proposal-{}", expected + 1));
            proposal["basedOnSnapshot"] = current["snapshotVersion"].clone();
            proposal["createdAt"] = json!(recorded);
            proposal["status"] = json!("draft");
            proposal["reviewReason"] = Value::Null;
            let mut proposals = vec![proposal];
            proposals.extend(array(&current["proposals"]).iter().take(9).cloned());
            next["version"] = json!(expected + 1);
            next["recordedAt"] = json!(recorded);
            next["proposals"] = json!(proposals);
        }
        "review_proposal" => {
            let Some(current) = current else {
                bail!("方案处理方式与理由无效");
            };
            if !only_keys(command, &["type", "id", "status", "reason"])
                || !["confirmed", "rejected"].contains(&string(&command["status"]))
                || !text(&command["reason"], 2000)
            {
                bail!("方案处理方式与理由无效");
            }
            let Some(proposal) = array(&current["proposals"])
                .iter()
                .find(|p| p["id"] == command["id"])
            else {
                return Err(conflict("方案不存在或已经处理"));
            };
            if proposal["status"] != "draft" {
                return Err(conflict("方案不存在或已经处理"));
            }
            if proposal["basedOnSnapshot"] != current["snapshotVersion"] {
                return Err(conflict("真实快照已变化，须重新生成对比"));
            }
            if command["status"] == "confirmed" {
                let input = json!({"title":proposal["title"],"rationale":proposal["rationale"],"target":proposal["target"],"estimatedCosts":proposal["estimatedCosts"],"externalCashFlow":proposal["externalCashFlow"]});
                let compared = compare_proposal(current, &input, dashboard, now)?;
                let ids = |assessment: &Value| {
                    let mut ids = array(&assessment["tasks"])
                        .iter()
                        .map(|task| string(&task["id"]).to_string())
                        .collect::<Vec<_>>();
                    ids.sort();
                    ids
                };
                if ids(&compared["before"]) != ids(&proposal["before"])
                    || ids(&compared["after"]) != ids(&proposal["after"])
                {
                    return Err(conflict("研究或风险依据已变化，请重新生成方案对比"));
                }
                if compared["comparison"]["fundingGap"]
                    .as_f64()
                    .is_none_or(|gap| gap.abs() > 0.01)
                    || numeric(&compared["after"]["securityCount"]) > 39.0
                    || timestamp(&current["draft"]["asOf"])
                        .is_none_or(|at| now - at > 36 * 3_600_000)
                {
                    bail!("方案资金不平衡、费用/估值缺失、持仓超限或快照过期；不能记录采纳");
                }
            }
            let proposals = array(&current["proposals"])
                .iter()
                .map(|proposal| {
                    let mut proposal = proposal.clone();
                    if proposal["id"] == command["id"] {
                        proposal["status"] = command["status"].clone();
                        proposal["reviewReason"] = command["reason"].clone();
                    }
                    proposal
                })
                .collect::<Vec<_>>();
            next["version"] = json!(expected + 1);
            next["recordedAt"] = json!(recorded);
            next["proposals"] = json!(proposals);
        }
        _ => bail!("不支持的命令；不接受交易执行指令"),
    }
    Ok(next)
}

pub async fn write(
    db: &Database,
    expected: &Value,
    command: &Value,
    dashboard: &Value,
) -> Result<Value> {
    let expected = expected
        .as_u64()
        .or_else(|| {
            expected
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n < u64::MAX as f64)
                .map(|n| n as u64)
        })
        .context("expectedVersion无效")?;
    if expected == u64::MAX {
        bail!("expectedVersion无效");
    }
    let command = command.clone();
    let dashboard = dashboard.clone();
    db.run(move |conn|{
        // Read and validate the expected revision after taking SQLite's write
        // lock. A second writer must never overwrite or fork the durable log.
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current:Option<String>=tx.query_row("SELECT value_json FROM kv_cache WHERE namespace=? ORDER BY key DESC LIMIT 1",[NAMESPACE],|row|row.get(0)).optional()?;
        let current=current.map(|raw|serde_json::from_str::<Value>(&raw)).transpose()?;
        let now=Utc::now().timestamp_millis();let next=next_version(current.as_ref(),expected,&command,&dashboard,now)?;
        match tx.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?)",params![NAMESPACE,format!("{:012}",expected+1),serde_json::to_string(&next)?,now]) {
            Ok(_)=>{},Err(error) if error.sqlite_error_code()==Some(rusqlite::ErrorCode::ConstraintViolation)=>return Err(conflict("并发编辑冲突；未覆盖原记录，请刷新")),Err(error)=>return Err(error.into()),
        }
        tx.commit()?;Ok(next)
    }).await
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/research/portfolio/workspace", get(workspace).post(save))
        .route("/research/portfolio/history/{version}", get(history))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn(private_boundary))
}

async fn private_boundary(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let authority = reqwest::Url::parse(&format!("http://{host}"));
    let valid = !host.chars().any(|c| matches!(c, '@' | '/' | '?' | '#'))
        && authority.as_ref().is_ok_and(|url| {
            matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            )
        });
    let origin = request.headers().get("origin");
    let same_origin = origin.is_none_or(|value| {
        value
            .to_str()
            .is_ok_and(|value| value == format!("http://{host}"))
    });
    let cross_site = request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|value| value == "cross-site");
    let mut response = if valid && same_origin && !cross_site {
        next.run(request).await
    } else {
        ApiError(StatusCode::FORBIDDEN, "仅允许本机同源组合访问".into()).into_response()
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}
async fn workspace(State(state): State<AppState>) -> ApiResult {
    Ok(ok(
        read(&state.db, &crate::dashboard::read(&state).await?).await?
    ))
}
async fn history(State(state): State<AppState>, Path(version): Path<String>) -> ApiResult {
    let version = version.parse::<f64>().ok();
    let record = versions(&state.db)
        .await?
        .into_iter()
        .find(|record| record["version"].as_f64() == version);
    match record {
        Some(record) => Ok(ok(record)),
        None => Err(ApiError(
            StatusCode::NOT_FOUND,
            "版本不在最近100条可读取窗口".into(),
        )),
    }
}
async fn save(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult {
    let body = body.map_err(|error| {
        ApiError(
            error.status(),
            if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                "组合记录超过150KB".into()
            } else {
                "组合保存失败".into()
            },
        )
    })?;
    if !headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return Err(ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "仅接受application/json".into(),
        ));
    }
    let operation = async {
        let body: Value = serde_json::from_slice(&body).context("组合保存失败")?;
        if !only_keys(&body, &["expectedVersion", "command"]) {
            bail!("请求含额外字段");
        }
        let dashboard = crate::dashboard::read(&state).await?;
        write(
            &state.db,
            &body["expectedVersion"],
            &body["command"],
            &dashboard,
        )
        .await?;
        read(&state.db, &crate::dashboard::read(&state).await?).await
    }
    .await;
    match operation {
        Ok(value) => Ok(ok(value)),
        Err(error) => Err(ApiError(
            if error.downcast_ref::<PortfolioConflict>().is_some() {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            error.to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn percentage_rounding_uses_javascript_half_way_rule() {
        for (number, expected) in [
            (0.125, "0.13"),
            (0.375, "0.38"),
            (1.005, "1.00"),
            (2.675, "2.67"),
            (50.0, "50.00"),
        ] {
            assert_eq!(fixed2(number), expected);
        }
    }
    #[test]
    fn explicit_timezone_and_minute_precision_match_iso_inputs() {
        for value in [
            "2026-10-29T12:00Z",
            "2026-10-29T12:00:00Z",
            "2026-10-29T20:00+08:00",
            "2026-10-29T20:00:00.000+08:00",
        ] {
            assert_eq!(timestamp(&json!(value)), Some(1793275200000));
        }
        for value in [
            "2026-10-29T12:00:00",
            "2026-10-29t12:00:00Z",
            "2026-10-29T12:00:00z",
        ] {
            assert!(timestamp(&json!(value)).is_none());
        }
    }
}
