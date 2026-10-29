//! Durable investment reports. GET reads only the local projection; only an
//! explicit enqueue submits work, and recovery reopens the recorded task.
use super::{repository, taskd};
use crate::{AppState, codes, db::Database, http::number};
use anyhow::{Context, Result, bail};
use chrono::{Datelike, SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Value, json};

pub const NAMESPACE: &str = "research_investment_analysis";
pub const PROMPT_VERSION: &str = "investment-analysis.taskd.v8";
pub const INPUT_SCHEMA_VERSION: &str = "investment-analysis-input.v3";
const MODEL: &str = "gpt-5.6-luna";

pub fn task_name(code: &str) -> String {
    format!("research:investment-analysis:{code}")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}
fn nonempty(value: &Value) -> Value {
    let value = text(value);
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}
fn parsed(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}
fn object_json(value: &Value) -> Value {
    let parsed = parsed(value);
    if parsed.is_object() {
        parsed
    } else {
        Value::Null
    }
}
fn json_string(value: &Value, default: &str) -> Value {
    json!(value.as_str().unwrap_or(default))
}
fn json_array(value: &Value) -> Value {
    let value = parsed(value);
    if value.is_array() { value } else { json!([]) }
}
fn no_recovery() -> Value {
    json!({"phase":"none","reason":null})
}
fn parse_recovery(value: &Value) -> Value {
    if ["none", "recovering", "manual_required"].contains(&text(&value["phase"])) {
        json!({"phase":text(&value["phase"]),"reason":nonempty(&value["reason"])})
    } else {
        no_recovery()
    }
}

fn parse_task(value: &Value) -> Value {
    let name = text(&value["name"]);
    let status = text(&value["status"]);
    let created = number(&value["createdAt"]);
    let updated = number(&value["updatedAt"]);
    if name.is_empty()
        || ![
            "queued",
            "leased",
            "running",
            "interrupt_requested",
            "succeeded",
            "failed",
            "interrupted",
            "superseded",
        ]
        .contains(&status)
        || created.is_none()
        || updated.is_none()
    {
        return Value::Null;
    }
    let mut task = json!({"name":name,"status":status,"createdAt":value["createdAt"].as_i64().map_or_else(||json!(created),|n|json!(n)),
        "updatedAt":value["updatedAt"].as_i64().map_or_else(||json!(updated),|n|json!(n)),
        "completedAt":value["completedAt"].as_i64().map_or_else(||json!(number(&value["completedAt"])),|n|json!(n)),
        "errorMessage":nonempty(&value["errorMessage"])});
    if !value["taskId"].is_null() {
        task["taskId"] = value["taskId"]
            .as_i64()
            .map_or_else(|| json!(number(&value["taskId"])), |n| json!(n));
    }
    task
}

/// Legacy v3 reports remain readable without manufacturing a new provider run.
pub async fn read_stored(db: &Database, code: &str) -> Result<Option<Value>> {
    let Some(parsed) = repository::read(db, NAMESPACE, code).await? else {
        return Ok(None);
    };
    if !parsed.is_object() {
        return Ok(None);
    }
    let task = parse_task(&parsed["task"]);
    let markdown = nonempty(&parsed["markdown"]);
    let recovery = parse_recovery(&parsed["recovery"]);
    if markdown.is_null() && task.is_null() && recovery["phase"] == "none" {
        return Ok(None);
    }
    let mut result = json!({
        "inputJson":if parsed["inputJson"].is_string(){parsed["inputJson"].clone()}else{Value::Null},
        "markdown":markdown,"citationsJson":json_string(&parsed["citationsJson"],"[]"),
        "sourcesJson":json_string(&parsed["sourcesJson"],"[]"),
        "terminalEvidenceJson":if parsed["terminalEvidenceJson"].is_string(){parsed["terminalEvidenceJson"].clone()}else{Value::Null},
        "projectedAt":parsed["projectedAt"].as_i64().map_or_else(||json!(number(&parsed["projectedAt"])),|n|json!(n)),
        "task":task,"recovery":recovery
    });
    if parsed.get("pendingInputJson").is_some() {
        result["pendingInputJson"] = if parsed["pendingInputJson"].is_string() {
            parsed["pendingInputJson"].clone()
        } else {
            Value::Null
        };
    }
    if parsed.get("pendingProjection").is_some() {
        result["pendingProjection"] = json!(parsed["pendingProjection"] == true);
    }
    Ok(Some(result))
}

pub async fn write_stored(db: &Database, code: &str, value: &Value) -> Result<()> {
    repository::save(db, NAMESPACE, code, value, None).await
}

fn merge(current: Option<&Value>, patch: &Value) -> Value {
    let defaults = json!({"pendingInputJson":null,"pendingProjection":false,"inputJson":null,"markdown":null,
        "citationsJson":"[]","sourcesJson":"[]","terminalEvidenceJson":null,"projectedAt":null,"task":null,"recovery":no_recovery()});
    let mut result = serde_json::Map::new();
    for (key, default) in defaults.as_object().unwrap() {
        result.insert(
            key.clone(),
            patch
                .get(key)
                .or_else(|| current.and_then(|c| c.get(key)))
                .unwrap_or(default)
                .clone(),
        );
    }
    Value::Object(result)
}

fn report_version(input: &Value) -> Value {
    let input = parsed(input);
    let version = nonempty(&input["schemaVersion"]);
    json!({"status":if version==INPUT_SCHEMA_VERSION{"current"}else if version.is_null(){"unknown"}else{"legacy"},
        "inputSchemaVersion":version,"currentInputSchemaVersion":INPUT_SCHEMA_VERSION})
}

pub fn response_from_stored(result: &Value) -> Value {
    let task = &result["task"];
    let recovery = &result["recovery"];
    let markdown = &result["markdown"];
    let available = !text(markdown).is_empty();
    let can_recover = task["status"] == "failed" && recovery["phase"] == "none";
    json!({
        "availability":if available{"available"}else if recovery["phase"]=="manual_required"||task["status"]=="failed"{"failed"}else if !task.is_null(){"pending"}else{"empty"},
        "task":task,"recovery":recovery,"input":parsed(&result["inputJson"]),
        "report":if available{json!({"markdown":markdown,"citations":json_array(&result["citationsJson"]),"sources":json_array(&result["sourcesJson"]),"terminalMetadata":parsed(&result["terminalEvidenceJson"]),"projectedAt":result["projectedAt"]})}else{Value::Null},
        "reportVersion":if available{report_version(&result["inputJson"])}else{Value::Null},
        "resume":{"available":can_recover,"reason":if can_recover{"recover_provider_turn"}else if recovery["phase"]=="manual_required"{"manual_required"}else if available{"already_projected"}else{"not_failed"}}
    })
}

pub async fn load(state: &AppState, code: &str) -> Result<Value> {
    let code = code.trim().to_uppercase();
    Ok(match read_stored(&state.db, &code).await? {
        Some(result) => response_from_stored(&result),
        None => {
            json!({"availability":"empty","task":null,"recovery":no_recovery(),"input":null,"report":null,"resume":{"available":false,"reason":"not_failed"}})
        }
    })
}

fn ensure_local(state: &AppState, operation: &str) -> Result<()> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("investment analysis {operation} is only available in local LLM runtime");
    }
    Ok(())
}

pub fn reasoning_effort(value: Option<&str>) -> Result<&str> {
    let value = value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("xhigh");
    if !["low", "medium", "high", "xhigh"].contains(&value) {
        bail!("unsupported investment-analysis reasoning effort");
    }
    Ok(value)
}

pub async fn enqueue(state: &AppState, code: &str, reasoning: Option<&str>) -> Result<Value> {
    ensure_local(state, "submission")?;
    let code = codes::normalize(code);
    let prepared = prepare(state, &code).await?;
    let current = read_stored(&state.db, &code).await?;
    let reasoning = reasoning_effort(reasoning)?;
    let input = &prepared["input"];
    let task = taskd::submit_report(state,&json!({
        "name":task_name(&code),"taskType":"webqa.chatgpt.v1","model":MODEL,"reasoningEffort":reasoning,
        "waitTimeoutMs":7_200_000,"prompt":prepared["prompt"],"businessInput":input,
        "diagnostics":{"securityCode":code,"model":MODEL,"reasoningEffort":reasoning,"promptVersion":input["promptVersion"],"schemaVersion":input["schemaVersion"]}
    })).await?;
    let input_json = json!(serde_json::to_string(input)?);
    let stored = merge(
        current.as_ref(),
        &json!({"pendingProjection":true,"pendingInputJson":input_json,
        "inputJson":if current.as_ref().is_some_and(|c|!text(&c["markdown"]).is_empty()){current.as_ref().unwrap()["inputJson"].clone()}else{input_json},
        "task":taskd::task_view(&task),"recovery":no_recovery()}),
    );
    repository::save(&state.db, NAMESPACE, &code, &stored, None).await?;
    Ok(json!({"accepted":true,"task":taskd::task_view(&task),"input":input}))
}

fn business_input(task: &Value) -> Value {
    let value = &task["input"]["business_input"];
    if value.is_object() {
        value.clone()
    } else {
        Value::Null
    }
}

async fn persist_task(
    state: &AppState,
    code: &str,
    current: &Value,
    input: &Value,
    task: &Value,
    recovery: &Value,
) -> Result<Value> {
    let mut patch = json!({"task":if task.is_null(){Value::Null}else{taskd::task_view(task)},"recovery":recovery});
    if text(&current["markdown"]).is_empty() && input.is_object() {
        patch["inputJson"] = json!(serde_json::to_string(input)?);
    }
    let stored = merge(Some(current), &patch);
    repository::save(&state.db, NAMESPACE, code, &stored, Some(current)).await?;
    Ok(stored)
}

fn recovery_after(current: &Value, task: &Value) -> Value {
    if current["phase"] == "recovering" && taskd::is_terminal(task) {
        return json!({"phase":"manual_required","reason":if text(&task["errorMessage"]).is_empty(){"找回后的任务没有产生可验证的完成结果。"}else{text(&task["errorMessage"])}});
    }
    if task["status"] == "failed" && !taskd::has_recoverable_checkpoint(&task["checkpoint"]) {
        let unknown = text(&task["errorMessage"])
            .to_lowercase()
            .starts_with("outcomeunknown:");
        return json!({"phase":"manual_required","reason":if unknown{"无法确认原会话，且任务没有可验证的原会话 checkpoint。"}else{"任务没有可验证的原会话 checkpoint，不能执行无重放找回。"}});
    }
    current.clone()
}

pub async fn reconcile_one(state: &AppState, code: &str) -> Result<()> {
    if state.setting("LLM_RUNTIME") != "local" {
        return Ok(());
    }
    let code = code.trim().to_uppercase();
    let Some(current) = read_stored(&state.db, &code).await? else {
        return Ok(());
    };
    if current["task"].is_null()
        || (!text(&current["markdown"]).is_empty()
            && current["pendingProjection"] != true
            && !taskd::is_pending(&current["task"]))
    {
        return Ok(());
    }
    let observed = async {
        match taskd::observe(state,&current["task"]).await? {
            None => { persist_task(state,&code,&current,&object_json(&current["inputJson"]),&Value::Null,
                &json!({"phase":"manual_required","reason":"taskd 已找不到原任务，无法确认已提交的 ChatGPT 会话。"})).await?; }
            Some(task) if task["status"] == "succeeded" => {
                let mut input = business_input(&task);
                if !input.is_object() {
                    let fallback = current.get("pendingInputJson").filter(|v|!v.is_null()).cloned().unwrap_or_else(|| {
                        if current["pendingProjection"]==true && !text(&current["markdown"]).is_empty() {Value::Null} else {current["inputJson"].clone()}
                    });
                    input = object_json(&fallback);
                }
                if !input.is_object() { bail!("investment analysis task has no frozen input snapshot"); }
                if text(&input["security"]["code"]).to_uppercase()!=code { bail!("investment analysis frozen input security mismatch"); }
                project(state,&input,&task,&current).await?;
            }
            Some(task) => {
                let input = business_input(&task);
                let input = if input.is_object(){input}else{object_json(&current["inputJson"])};
                persist_task(state,&code,&current,&input,&task,&recovery_after(&current["recovery"],&task)).await?;
            }
        }
        Ok::<_,anyhow::Error>(())
    }.await;
    if let Err(error) = observed {
        if taskd::is_read_unavailable(&error) {
            return Err(error);
        }
        let stored = merge(
            Some(&current),
            &json!({"recovery":{"phase":"manual_required","reason":error.to_string()}}),
        );
        repository::save(&state.db, NAMESPACE, &code, &stored, Some(&current)).await?;
        return Err(error);
    }
    Ok(())
}

pub async fn sync(state: &AppState, code: &str) -> Result<Value> {
    ensure_local(state, "synchronization")?;
    let code = code.trim().to_uppercase();
    reconcile_one(state, &code).await?;
    load(state, &code).await
}

pub async fn resume(state: &AppState, code: &str) -> Result<Value> {
    let code = code.trim().to_uppercase();
    let stored = read_stored(&state.db, &code)
        .await?
        .context("investment analysis has no recorded task to recover")?;
    if stored["task"].is_null() {
        bail!("investment analysis has no recorded task to recover");
    }
    ensure_local(state, "recovery")?;
    let (remote, recoverable) =
        taskd::recover_with_status(state, &stored["task"], &["failed"]).await?;
    let mut recovery = stored["recovery"].clone();
    match remote.as_ref() {
        None => {
            recovery = json!({"phase":"manual_required","reason":"taskd 已找不到原任务，无法确认已提交的 ChatGPT 会话。"})
        }
        Some(_) if recoverable => {
            recovery = json!({"phase":"recovering","reason":"正在只读找回已提交的 ChatGPT 结果；不会重发提示词。"})
        }
        Some(remote) if remote["status"] == "failed" => {
            recovery = json!({"phase":"manual_required","reason":if taskd::has_recoverable_checkpoint(&remote["checkpoint"]){"taskd 未能重新排队原任务，无法确认已提交的 ChatGPT 会话。"}else{"任务缺少可验证的原会话 checkpoint，无法安全找回，也不会重发提示词。"}})
        }
        Some(_) => {}
    }
    let mut input = remote.as_ref().map(business_input).unwrap_or(Value::Null);
    if !input.is_object() {
        input = object_json(&stored["inputJson"]);
    }
    persist_task(
        state,
        &code,
        &stored,
        &input,
        remote.as_ref().unwrap_or(&Value::Null),
        &recovery,
    )
    .await?;
    reconcile_one(state, &code).await?;
    load(state, &code).await
}

pub fn validate_terminal_evidence(evidence: &Value) -> Result<()> {
    if text(&evidence["schemaVersion"]) != "webqa.completion-evidence.v1"
        || text(&evidence["outcome"]) != "succeeded"
    {
        bail!("investment analysis taskd result lacks terminal WebQA completion evidence");
    }
    Ok(())
}

pub fn validate_markdown(markdown: &str) -> Result<()> {
    if markdown.encode_utf16().count() < 800 {
        bail!("investment analysis result is shorter than 800 characters");
    }
    let headings = Regex::new(r"(?m)^# ([1-9]|1[0-2])(?:\\)?\. ")
        .unwrap()
        .captures_iter(markdown)
        .map(|capture| capture[1].to_string())
        .collect::<std::collections::HashSet<_>>();
    if headings.len() != 12 {
        bail!("investment analysis result must contain all twelve numbered H1 headings");
    }
    Ok(())
}

async fn project(state: &AppState, input: &Value, task: &Value, expected: &Value) -> Result<()> {
    let result = taskd::extract_result(&task["result"])?;
    validate_terminal_evidence(&result["terminalEvidence"])?;
    let markdown = text(&result["content"]["markdown"]);
    validate_markdown(markdown)?;
    let code = text(&input["security"]["code"]);
    if code.is_empty() {
        bail!("investment analysis input has no security code");
    }
    let stored = json!({"pendingProjection":false,"pendingInputJson":null,"inputJson":serde_json::to_string(input)?,
        "markdown":markdown,"citationsJson":serde_json::to_string(&result["citations"])?,"sourcesJson":serde_json::to_string(&result["sources"])?,
        "terminalEvidenceJson":serde_json::to_string(&result["terminalEvidence"])?,"projectedAt":Utc::now().timestamp_millis(),
        "task":taskd::task_view(task),"recovery":no_recovery()});
    repository::save(&state.db, NAMESPACE, code, &stored, Some(expected)).await
}

pub async fn prepare(state: &AppState, input_code: &str) -> Result<Value> {
    let code = codes::normalize(input_code);
    let query = code.split('.').next().unwrap_or(&code);
    let securities = crate::market::search_securities(state, query).await?;
    let security = securities
        .iter()
        .find(|security| codes::normalize(text(&security["code"])) == code)
        .context("security was not found")?;
    let now = Utc::now();
    let today = now.date_naive().to_string();
    let from = format!("{}-01-01", now.year() - 1);
    let bars = crate::market::load_kline(state, &code, "normal", &from, &today).await?;
    let latest = bars
        .iter()
        .rev()
        .find(|row| row.get("close").is_some())
        .with_context(|| format!("Xueqiu K-line is empty for investment analysis: {code}"))?;
    let market_cap = number(&latest["marketCapital"]);
    let valuation = crate::finance::latest_valuation(state, &code, market_cap).await?;
    let companies = state.config("config/generated/eastmoney-company-em2016-profiles.json")?;
    let local_profile = companies["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|profile| {
            profile["code"] == code
                && profile["availability"] == "available"
                && !text(&profile["industry"]).is_empty()
        });
    let framework = if let Some(profile) = local_profile {
        let industries =
            state.config("config/research/research-eastmoney-em2016-industry-profiles.json")?;
        framework_for_industry(&industries, text(&profile["industry"]))
    } else {
        Value::Null
    };
    let input = json!({"schemaVersion":INPUT_SCHEMA_VERSION,"promptVersion":PROMPT_VERSION,"preparedAt":now.to_rfc3339_opts(SecondsFormat::Millis,true),
        "security":{"code":security["code"],"name":security["name"],"market":security["market"],"type":security["type"],"currency":security["currency"]},
        "marketSnapshot":{"asOf":latest["date"],"marketDataSource":"xueqiu","valuationSource":valuation["source"],"latestPrice":latest["close"],"marketCapYi":market_cap.map(|cap|cap/100_000_000.0),
            "peTtm":valuation["peTtm"],"pb":valuation["pb"],"psTtm":valuation["psTtm"],"pcfTtm":valuation["pcfTtm"],"valuationBasis":valuation["basis"]},
        "businessBoundary":{"status":if local_profile.is_some(){"confirmed"}else{"unknown"},"note":null,"products":[],"customers":[],"regions":[]},
        "analysisFramework":framework});
    let template =
        std::fs::read_to_string(state.root.join("prompts/research/operating-analysis.md"))?;
    let prompt = build_prompt(template.trim(), &input);
    Ok(json!({"securityCode":code,"input":input,"prompt":prompt}))
}

pub fn framework_for_industry(config: &Value, industry: &str) -> Value {
    let profile = config["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|candidate| {
            candidate["industries"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v.as_str() == Some(industry)))
        });
    profile.map(|profile|json!({"primaryFormula":profile["primaryFormula"],"operatingMetrics":profile["operatingMetrics"],"valuationMethods":profile["valuationMethods"],"stressFactors":profile["stressFactors"]})).unwrap_or(Value::Null)
}

fn display(value: &Value, unit: &str) -> String {
    let Some(value) = number(value) else {
        return "未提供".into();
    };
    let formatted = fixed_two(value);
    if unit.is_empty() {
        formatted
    } else {
        format!("{formatted} {unit}")
    }
}

// Number(value.toFixed(2)) uses the exact IEEE-754 rational and resolves a
// decimal half away from zero. Rust's formatter uses ties-to-even, while
// multiplying by 100 first introduces another rounding (e.g. 2.675). Keep the
// original prompt values without either difference.
fn fixed_two(value: f64) -> String {
    let absolute = value.abs();
    if absolute >= 1e21 {
        let scientific = format!("{value:e}");
        return scientific.replace('e', "e+").replace("e+-", "e-");
    }
    let bits = absolute.to_bits();
    let exponent_bits = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (mantissa, exponent) = if exponent_bits == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1_u64 << 52), exponent_bits - 1023 - 52)
    };
    let numerator = u128::from(mantissa) * 100;
    let rounded = if exponent >= 0 {
        numerator << exponent as u32
    } else {
        let shift = (-exponent) as u32;
        if shift >= 128 {
            0
        } else {
            let quotient = numerator >> shift;
            let remainder = numerator & ((1_u128 << shift) - 1);
            quotient + u128::from(remainder >= (1_u128 << (shift - 1)))
        }
    };
    let sign = if value.is_sign_negative() && rounded != 0 {
        "-"
    } else {
        ""
    };
    let whole = rounded / 100;
    match rounded % 100 {
        0 => format!("{sign}{whole}"),
        remainder if remainder % 10 == 0 => format!("{sign}{whole}.{}", remainder / 10),
        remainder => format!("{sign}{whole}.{remainder:02}"),
    }
}
fn display_basis(value: &Value) -> String {
    if !value.is_object() {
        return "未提供".into();
    }
    format!(
        "{}；报告期 {}；公告日 {}",
        text(&value["source"]),
        text(&value["reportDate"]),
        value["noticeDate"].as_str().unwrap_or("未提供")
    )
}
fn list_or_missing(value: &Value) -> String {
    let joined = value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|v| v.as_str().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    if joined.is_empty() {
        "未提供".into()
    } else {
        joined
    }
}
pub fn brief(input: &Value) -> String {
    let market = &input["marketSnapshot"];
    let framework = &input["analysisFramework"];
    vec![
        "## 研究对象".into(),
        format!("- 公司：{}", text(&input["security"]["name"])),
        format!("- 证券代码：{}", text(&input["security"]["code"])),
        format!("- 报告时点：{}", text(&input["preparedAt"])),
        String::new(),
        "## 已确认的市场快照".into(),
        format!("- 截至：{}", text(&market["asOf"])),
        format!(
            "- 行情源：{}（仅价格、市值）",
            text(&market["marketDataSource"])
        ),
        format!(
            "- 估值源：{}（按最新已披露财报、快报、预告派生）",
            text(&market["valuationSource"])
        ),
        format!(
            "- 最新价格：{}",
            display(&market["latestPrice"], text(&input["security"]["currency"]))
        ),
        format!("- 总市值：{}", display(&market["marketCapYi"], "亿元")),
        format!("- PE（TTM）：{}", display(&market["peTtm"], "")),
        format!("- PB：{}", display(&market["pb"], "")),
        format!("- PS（TTM）：{}", display(&market["psTtm"], "")),
        format!("- PCF（TTM）：{}", display(&market["pcfTtm"], "")),
        format!(
            "- 利润/营收口径：{}",
            display_basis(&market["valuationBasis"]["income"])
        ),
        format!(
            "- 净资产口径：{}",
            display_basis(&market["valuationBasis"]["balance"])
        ),
        format!(
            "- 经营现金流口径：{}",
            display_basis(&market["valuationBasis"]["cashflow"])
        ),
        String::new(),
        "## 研究框架（不是公司事实）".into(),
        format!(
            "- 量价成本主公式：{}",
            framework["primaryFormula"].as_str().unwrap_or("未提供")
        ),
        format!(
            "- 优先核验指标：{}",
            list_or_missing(&framework["operatingMetrics"])
        ),
        format!(
            "- 可用估值方法：{}",
            list_or_missing(&framework["valuationMethods"])
        ),
        format!(
            "- 压力因素：{}",
            list_or_missing(&framework["stressFactors"])
        ),
    ]
    .join("\n")
}
pub fn build_prompt(template: &str, input: &Value) -> String {
    template.replacen("{{INPUT_DATA}}", &brief(input), 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("investment.sqlite")).unwrap();
        db.migrate(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:18000".into()).unwrap();
        (dir, state)
    }

    fn completed_task() -> Value {
        let markdown = (1..=12)
            .map(|n| format!("# {n}. section\n{}\n", "verified evidence".repeat(8)))
            .collect::<String>();
        json!({"taskId":1,"name":"research:investment-analysis:AAPL.US","status":"succeeded","createdAt":1,"updatedAt":2,"completedAt":2,"errorMessage":null,
            "result":{"format":"taskd.webqa.result.v2","content":{"format":"web-helper.rich-content.v1","markdown":markdown,"assets":[]},
                "citations":[{"id":"source-1"}],"sources":[{"url":"https://www.sec.gov/"}],"raw_snapshot":{"provider_url":"https://chatgpt.com/c/existing"},
                "terminal_evidence":{"schemaVersion":"webqa.completion-evidence.v1","outcome":"succeeded"},"execution":{"provider":"chatgpt-web"}}})
    }

    #[tokio::test]
    async fn get_reads_durable_projection_without_touching_providers_or_expiry() {
        let (_dir, state) = isolated_state();
        let record = merge(
            None,
            &json!({"markdown":"already validated report","inputJson":"{\"schemaVersion\":\"investment-analysis-input.v1\"}",
            "task":{"taskId":1,"name":"research:investment-analysis:AAPL.US","status":"succeeded","createdAt":1,"updatedAt":2,"completedAt":2},"projectedAt":2}),
        );
        write_stored(&state.db, "AAPL.US", &record).await.unwrap();
        state
            .db
            .execute(
                "UPDATE kv_cache SET expires_at=1 WHERE namespace=? AND key=?",
                vec![NAMESPACE.into(), "AAPL.US".into()],
            )
            .await
            .unwrap();
        let before = state
            .db
            .query(
                "SELECT value_json,expires_at,updated_at FROM kv_cache WHERE namespace=? AND key=?",
                vec![NAMESPACE.into(), "AAPL.US".into()],
            )
            .await
            .unwrap();
        let response = load(&state, " aapl.us ").await.unwrap();
        assert_eq!(response["availability"], "available");
        assert_eq!(response["reportVersion"]["status"], "legacy");
        let after = state
            .db
            .query(
                "SELECT value_json,expires_at,updated_at FROM kv_cache WHERE namespace=? AND key=?",
                vec![NAMESPACE.into(), "AAPL.US".into()],
            )
            .await
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(
            load(&state, "MSFT.US").await.unwrap()["availability"],
            "empty"
        );
    }

    #[tokio::test]
    async fn terminal_projection_preserves_provenance_and_cannot_replace_a_new_run() {
        let (_dir, state) = isolated_state();
        let task = completed_task();
        let input = json!({"schemaVersion":INPUT_SCHEMA_VERSION,"security":{"code":"AAPL.US"}});
        let pending = merge(
            None,
            &json!({"pendingProjection":true,"pendingInputJson":serde_json::to_string(&input).unwrap(),"task":taskd::task_view(&task)}),
        );
        write_stored(&state.db, "AAPL.US", &pending).await.unwrap();
        project(&state, &input, &task, &pending).await.unwrap();
        let projected = read_stored(&state.db, "AAPL.US").await.unwrap().unwrap();
        assert_eq!(projected["pendingProjection"], false);
        assert!(projected["pendingInputJson"].is_null());
        let response = response_from_stored(&projected);
        assert_eq!(response["report"]["citations"], task["result"]["citations"]);
        assert_eq!(response["report"]["sources"], task["result"]["sources"]);
        assert_eq!(
            response["report"]["terminalMetadata"],
            task["result"]["terminal_evidence"]
        );
        assert_eq!(response["reportVersion"]["status"], "current");
        let next = merge(
            Some(&projected),
            &json!({"pendingProjection":true,"pendingInputJson":"new frozen input","task":{"taskId":2,"name":"research:investment-analysis:AAPL.US","status":"queued","createdAt":3,"updatedAt":3,"completedAt":null,"errorMessage":null}}),
        );
        write_stored(&state.db, "AAPL.US", &next).await.unwrap();
        project(&state, &input, &task, &pending).await.unwrap();
        let current = read_stored(&state.db, "AAPL.US").await.unwrap().unwrap();
        assert_eq!(current["task"]["taskId"], 2);
        assert_eq!(current["pendingInputJson"], "new frozen input");
        assert_eq!(current["markdown"], projected["markdown"]);
    }

    #[tokio::test]
    async fn invalid_terminal_evidence_cannot_mutate_the_previous_report() {
        let (_dir, state) = isolated_state();
        let mut task = completed_task();
        let pending = merge(
            None,
            &json!({"markdown":"old validated report","task":taskd::task_view(&task),"pendingProjection":true}),
        );
        write_stored(&state.db, "AAPL.US", &pending).await.unwrap();
        task["result"]["terminal_evidence"]["outcome"] = json!("unknown");
        assert!(
            project(
                &state,
                &json!({"security":{"code":"AAPL.US"}}),
                &task,
                &pending
            )
            .await
            .is_err()
        );
        let stored = read_stored(&state.db, "AAPL.US").await.unwrap().unwrap();
        assert_eq!(stored["markdown"], "old validated report");
        assert_eq!(stored["pendingProjection"], true);
        assert!(stored["projectedAt"].is_null());
    }

    #[test]
    fn twelve_semantic_sections_and_terminal_evidence_are_required() {
        let normal = (1..=12)
            .map(|n| format!("# {n}. section\n{}\n", "evidence".repeat(12)))
            .collect::<String>();
        validate_markdown(&normal).unwrap();
        let escaped = normal.replace(". section", "\\. section");
        validate_markdown(&escaped).unwrap();
        assert!(validate_markdown(&normal.replace("# 12. ", "## 12. ")).is_err());
        assert!(validate_markdown("# 1. brief").is_err());
        validate_terminal_evidence(
            &json!({"schemaVersion":"webqa.completion-evidence.v1","outcome":"succeeded"}),
        )
        .unwrap();
        assert!(validate_terminal_evidence(&json!({"outcome":"succeeded"})).is_err());
        assert!(
            validate_terminal_evidence(
                &json!({"schemaVersion":"webqa.completion-evidence.v1","outcome":"failed"})
            )
            .is_err()
        );
    }

    #[test]
    fn frozen_prompt_briefs_match_the_original_typescript_contract() {
        // Generated from buildResearchInvestmentAnalysisPrompt using three
        // synthetic CN/US/HK inputs; no provider requests or private records.
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("investment/prompt-brief-fixtures.json")).unwrap();
        assert_eq!(fixtures.len(), 3);
        for fixture in fixtures {
            assert_eq!(brief(&fixture["input"]), fixture["brief"].as_str().unwrap());
        }
    }

    #[test]
    fn old_valid_report_stays_available_and_exposes_legacy_version() {
        let stored = merge(
            None,
            &json!({"markdown":"validated old report","inputJson":"{\"schemaVersion\":\"investment-analysis-input.v1\"}",
            "task":{"status":"failed"},"recovery":{"phase":"manual_required","reason":"new projection failed"},"citationsJson":"[1]","sourcesJson":"broken"}),
        );
        let response = response_from_stored(&stored);
        assert_eq!(response["availability"], "available");
        assert_eq!(response["report"]["markdown"], "validated old report");
        assert_eq!(response["reportVersion"]["status"], "legacy");
        assert_eq!(response["report"]["citations"], json!([1]));
        assert_eq!(response["report"]["sources"], json!([]));
        assert_eq!(response["resume"]["reason"], "manual_required");
    }

    #[test]
    fn merge_keeps_prior_frozen_report_and_new_pending_input_separate() {
        let original = merge(
            None,
            &json!({"markdown":"old","inputJson":"old-input","projectedAt":123}),
        );
        let pending = merge(
            Some(&original),
            &json!({"pendingProjection":true,"pendingInputJson":"new-input","task":{"name":"current"}}),
        );
        assert_eq!(pending["markdown"], "old");
        assert_eq!(pending["inputJson"], "old-input");
        assert_eq!(pending["pendingInputJson"], "new-input");
        assert_eq!(pending["projectedAt"], 123);
        let projected = merge(
            Some(&pending),
            &json!({"pendingProjection":false,"pendingInputJson":null,"inputJson":"new-input","markdown":"new"}),
        );
        assert!(projected["pendingInputJson"].is_null());
        assert_eq!(projected["inputJson"], "new-input");
    }

    #[test]
    fn missing_checkpoint_never_authorizes_replay_recovery() {
        let failed = json!({"status":"failed","checkpoint":null,"errorMessage":"OutcomeUnknown: browser interrupted"});
        assert_eq!(
            recovery_after(&no_recovery(), &failed)["phase"],
            "manual_required"
        );
        let recovering = json!({"phase":"recovering","reason":"observing"});
        assert_eq!(
            recovery_after(
                &recovering,
                &json!({"status":"interrupted","errorMessage":null})
            )["reason"],
            "找回后的任务没有产生可验证的完成结果。"
        );
        assert_eq!(reasoning_effort(None).unwrap(), "xhigh");
        assert!(reasoning_effort(Some("automatic")).is_err());
    }

    #[test]
    fn brief_has_no_unlinked_business_facts_and_uses_financial_multiples() {
        let input = json!({"security":{"code":"600036.SH","name":"招商银行","currency":"CNY"},"preparedAt":"2026-10-29T00:00:00Z",
            "marketSnapshot":{"asOf":"2026-10-28","marketDataSource":"xueqiu","valuationSource":"financial-statements","latestPrice":40.125,"marketCapYi":1000,"peTtm":null,"pb":0.93,"psTtm":null,"pcfTtm":null,
                "valuationBasis":{"balance":{"source":"financial_report","reportDate":"2026-09-30","noticeDate":null}}},"analysisFramework":null,
            "businessBoundary":{"products":["unlinked fact must not enter prompt"]}});
        let output = build_prompt("Before\n{{INPUT_DATA}}\nAfter", &input);
        assert!(output.contains("- PB：0.93"));
        assert!(output.contains("- PE（TTM）：未提供"));
        assert!(output.contains("financial_report；报告期 2026-09-30；公告日 未提供"));
        assert!(!output.contains("unlinked fact must not enter prompt"));
        assert!(output.starts_with("Before\n## 研究对象"));
        assert_eq!(display(&json!(40.125), "CNY"), "40.13 CNY");
        assert_eq!(display(&json!(2.675), ""), "2.67");
        assert_eq!(display(&json!(1.005), ""), "1");
        assert_eq!(display(&json!(-0.001), ""), "0");
    }
}
