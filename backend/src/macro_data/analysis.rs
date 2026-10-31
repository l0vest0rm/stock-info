//! Durable macro research read model and explicit web_workflow lifecycle actions.
//! Page reads never contact web_workflow; observation/recovery never resubmit prompts.
use crate::{AppState, db::Database, research::repository, web_workflow};
use anyhow::{Result, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::OnceLock;

const NAMESPACE: &str = "macro_analysis";
const KEY: &str = "GLOBAL";
const TASK_NAME: &str = "macro:analysis:global";
const SCHEMA: &str = "macro-analysis-input.v1";
const PROMPT_VERSION: &str = "macro-analysis.cea.v2";

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}
fn parse_json(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}
fn json_array(value: &Value) -> Value {
    let parsed = parse_json(value);
    if parsed.is_array() { parsed } else { json!([]) }
}
fn no_recovery() -> Value {
    json!({"phase":"none","reason":null})
}
fn manual(reason: impl AsRef<str>) -> Value {
    json!({"phase":"manual_required","reason":reason.as_ref()})
}
fn local(state: &AppState, operation: &str) -> Result<()> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("macro analysis {operation} is only available in local LLM runtime");
    }
    Ok(())
}

pub async fn load(state: &AppState) -> Result<Value> {
    let stored = load_stored(&state.db).await?;
    let mut view = stored.as_ref().map(response).unwrap_or_else(empty_response);
    view["canManageLocally"] = json!(state.setting("LLM_RUNTIME") == "local");
    Ok(view)
}

pub async fn reconcile(state: &AppState) -> Result<bool> {
    if state.setting("LLM_RUNTIME") != "local" {
        return Ok(false);
    }
    let Some(stored) = load_stored(&state.db).await? else {
        return Ok(false);
    };
    if stored["task"].is_null()
        || (stored["pendingProjection"] != true && !web_workflow::is_pending(&stored["task"]))
    {
        return Ok(false);
    }
    if repository::unchanged_failed_execution(&state.db, &stored["task"]).await? {
        return Ok(false);
    }
    sync(state).await?;
    Ok(true)
}

pub async fn enqueue(state: &AppState, reasoning_effort: Option<&str>) -> Result<Value> {
    local(state, "submission")?;
    let effort = normalize_reasoning_effort(reasoning_effort)?;
    let input = json!({"schemaVersion":SCHEMA,"promptVersion":PROMPT_VERSION,"preparedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
    let prompt = std::fs::read_to_string(state.root.join("prompts/macro.md"))?;
    let task = web_workflow::submit_report(state,&json!({"name":TASK_NAME,"taskType":"webqa.chatgpt.v1","model":web_workflow::model(state)?,
        "reasoningEffort":effort,"waitTimeoutMs":7_200_000,"prompt":prompt,"businessInput":input,
        "diagnostics":{"model":web_workflow::model(state)?,"reasoningEffort":effort,"promptVersion":PROMPT_VERSION,"schemaVersion":SCHEMA,"scope":"global_macro"}})).await?;
    let current = load_stored(&state.db).await?;
    let input_json = serde_json::to_string(&input)?;
    let old_input = current
        .as_ref()
        .filter(|s| !text(&s["markdown"]).is_empty())
        .map(|s| s["inputJson"].clone())
        .unwrap_or_else(|| json!(input_json));
    let next = merge(
        current.as_ref(),
        &json!({"pendingProjection":true,"pendingInputJson":input_json,"inputJson":old_input,
        "task":web_workflow::task_view(&task),"recovery":no_recovery()}),
    );
    repository::save(&state.db, NAMESPACE, KEY, &next, None).await?;
    Ok(json!({"accepted":true,"task":web_workflow::task_view(&task),"input":input}))
}

pub async fn sync(state: &AppState) -> Result<Value> {
    local(state, "synchronization")?;
    let Some(stored) = load_stored(&state.db).await? else {
        return Ok(empty_response());
    };
    if stored["task"].is_null() {
        return Ok(empty_response());
    }
    let result = observe_and_project(state, &stored).await;
    if let Err(error) = result {
        if web_workflow::is_read_unavailable(&error) {
            return Err(error);
        }
        let latest = load_stored(&state.db).await?.unwrap_or(stored);
        let patch = json!({"pendingProjection":true,"task":repository::projection_failed_task(&state.db, &latest["task"], &error.to_string()).await?,"recovery":manual(error.to_string())});
        let next = merge(Some(&latest), &patch);
        repository::save(&state.db, NAMESPACE, KEY, &next, Some(&latest)).await?;
        return Err(error);
    }
    load(state).await
}

async fn observe_and_project(state: &AppState, stored: &Value) -> Result<()> {
    let Some(remote) = web_workflow::observe(state, &stored["task"]).await? else {
        let next = merge(
            Some(stored),
            &json!({"task":null,"recovery":manual("本机已找不到原任务，无法确认已提交的 ChatGPT 会话。")}),
        );
        return repository::save(&state.db, NAMESPACE, KEY, &next, Some(stored)).await;
    };
    if remote["status"] == "succeeded" {
        let input = input_from_value(&remote["input"]["business_input"])
            .or_else(|| {
                input_from_value(&parse_json(if stored["pendingInputJson"].is_null() {
                    &stored["inputJson"]
                } else {
                    &stored["pendingInputJson"]
                }))
            })
            .ok_or_else(|| anyhow::anyhow!("macro analysis task has no frozen input snapshot"))?;
        // Persist terminal observation before validating content, so malformed
        // completed output cannot remain queued for perpetual background retries.
        let terminal = merge(
            Some(stored),
            &json!({"task":web_workflow::task_view(&remote),"recovery":no_recovery()}),
        );
        repository::save(&state.db, NAMESPACE, KEY, &terminal, Some(stored)).await?;
        let result = web_workflow::extract_result(&remote["result"])?;
        validate_terminal_evidence(&result["terminalEvidence"])?;
        let markdown = text(&result["content"]["markdown"]);
        validate_markdown(markdown)?;
        let next = merge(
            Some(&terminal),
            &json!({"pendingProjection":false,"pendingInputJson":null,"inputJson":serde_json::to_string(&input)?,
            "markdown":markdown,"citationsJson":serde_json::to_string(&result["citations"])?,"sourcesJson":serde_json::to_string(&result["sources"])?,
            "terminalEvidenceJson":serde_json::to_string(&result["terminalEvidence"])?,"projectedAt":chrono::Utc::now().timestamp_millis(),
            "task":web_workflow::task_view(&remote),"recovery":no_recovery()}),
        );
        repository::save(&state.db, NAMESPACE, KEY, &next, Some(&terminal)).await?;
    } else {
        // observe() has already rejected a different task identity.
        let next = merge(
            Some(stored),
            &json!({"task":web_workflow::task_view(&remote),"recovery":recovery_after_task(&stored["recovery"],&remote)}),
        );
        repository::save(&state.db, NAMESPACE, KEY, &next, Some(stored)).await?;
    }
    Ok(())
}

pub async fn resume(state: &AppState) -> Result<Value> {
    local(state, "recovery")?;
    let stored = load_stored(&state.db)
        .await?
        .filter(|s| !s["task"].is_null())
        .ok_or_else(|| anyhow::anyhow!("macro analysis has no recorded task to recover"))?;
    let (remote, recoverable) = web_workflow::recover_with_status(
        state,
        &stored["task"],
        &["failed", "interrupted", "succeeded"],
    )
    .await?;
    let recovery = match remote.as_ref() {
        None => manual("本机已找不到原任务，无法确认已提交的 ChatGPT 会话。"),
        Some(_) if recoverable => {
            json!({"phase":"recovering","reason":"正在续接原执行 checkpoint；不会重放已派发动作。"})
        }
        Some(task) if task["status"] == "failed" => {
            if !web_workflow::has_recoverable_checkpoint(&task["checkpoint"]) {
                manual("任务缺少可验证的原会话 checkpoint，无法安全找回，也不会重发提示词。")
            } else {
                manual("本机执行器未能重新排队原任务，无法确认已提交的 ChatGPT 会话。")
            }
        }
        Some(_) => stored["recovery"].clone(),
    };
    let next = merge(
        Some(&stored),
        &json!({"task":remote.as_ref().map(web_workflow::task_view),"recovery":recovery}),
    );
    repository::save(&state.db, NAMESPACE, KEY, &next, Some(&stored)).await?;
    load(state).await
}

pub fn validate_terminal_evidence(evidence: &Value) -> Result<()> {
    if text(&evidence["schemaVersion"]) != "webqa.completion-evidence.v1"
        || text(&evidence["outcome"]) != "succeeded"
    {
        bail!("macro analysis web_workflow result lacks terminal WebQA completion evidence");
    }
    Ok(())
}

pub fn validate_markdown(markdown: &str) -> Result<()> {
    // JS String.length counts UTF-16 units, not UTF-8 bytes or Unicode scalars.
    if markdown.encode_utf16().count() < 4_000 {
        bail!("macro analysis result is shorter than 4000 characters");
    }
    // The authoritative macro prompt now defines twelve numbered sections.
    // Keep its topology, minimum length and conclusion contract synchronized;
    // the retired thirty-one-section requirement rejected valid current output.
    const EXPECTED: [&str; 12] = [
        "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二",
    ];
    static HEADINGS: OnceLock<Regex> = OnceLock::new();
    let headings =
        HEADINGS.get_or_init(|| Regex::new(r"(?m)^#{1,6} ([一二三四五六七八九十]+)、").unwrap());
    let found = headings
        .captures_iter(markdown)
        .map(|c| c[1].to_string())
        .collect::<std::collections::HashSet<_>>();
    if !EXPECTED.iter().all(|heading| found.contains(*heading)) {
        bail!("macro analysis result must contain all twelve numbered sections");
    }
    static CONCLUSION: OnceLock<Regex> = OnceLock::new();
    if !CONCLUSION
        .get_or_init(|| Regex::new(r"(?m)^# 一句话结论\s*$").unwrap())
        .is_match(markdown)
    {
        bail!("macro analysis result must contain the one-sentence conclusion H1 heading");
    }
    Ok(())
}

async fn load_stored(db: &Database) -> Result<Option<Value>> {
    let stored: Option<Value> = repository::read(db, NAMESPACE, KEY).await?;
    Ok(stored.as_ref().and_then(normalize_stored))
}

fn normalize_stored(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let task = parse_task(&value["task"]);
    let markdown = text(&value["markdown"]);
    if task.is_none() && markdown.is_empty() {
        return None;
    }
    let mut result = merge(
        None,
        &json!({"pendingProjection":value["pendingProjection"]==true,"task":task,
        "markdown":if markdown.is_empty(){Value::Null}else{json!(markdown)},"recovery":parse_recovery(&value["recovery"]),
        "projectedAt":number_value(scalar_number(&value["projectedAt"]))}),
    );
    for key in ["pendingInputJson", "inputJson", "terminalEvidenceJson"] {
        result[key] = value[key].as_str().map(|s| json!(s)).unwrap_or(Value::Null);
    }
    for key in ["citationsJson", "sourcesJson"] {
        result[key] = json!(value[key].as_str().unwrap_or("[]"));
    }
    Some(result)
}

fn merge(current: Option<&Value>, patch: &Value) -> Value {
    let mut result = json!({"pendingProjection":false,"pendingInputJson":null,"inputJson":null,"markdown":null,"citationsJson":"[]","sourcesJson":"[]","terminalEvidenceJson":null,"projectedAt":null,"task":null,"recovery":no_recovery()});
    for source in current.into_iter().chain(std::iter::once(patch)) {
        for key in [
            "pendingProjection",
            "pendingInputJson",
            "inputJson",
            "markdown",
            "citationsJson",
            "sourcesJson",
            "terminalEvidenceJson",
            "projectedAt",
            "task",
            "recovery",
        ] {
            if let Some(value) = source.get(key) {
                result[key] = value.clone();
            }
        }
    }
    result
}

fn response(stored: &Value) -> Value {
    let has_markdown = !text(&stored["markdown"]).is_empty();
    let task = &stored["task"];
    let manual = stored["recovery"]["phase"] == "manual_required";
    let recovery_available = task["status"] == "failed" && stored["recovery"]["phase"] == "none";
    json!({"availability":if has_markdown {"available"} else if manual || web_workflow::is_terminal(task) {"failed"} else if !task.is_null() {"pending"} else {"empty"},
        "task":task,"recovery":stored["recovery"],"input":parse_json(&stored["inputJson"]),
        "report":if has_markdown {json!({"markdown":stored["markdown"],"citations":json_array(&stored["citationsJson"]),"sources":json_array(&stored["sourcesJson"]),"terminalMetadata":parse_json(&stored["terminalEvidenceJson"]),"projectedAt":stored["projectedAt"]})} else {Value::Null},
        "resume":{"available":recovery_available,"reason":if recovery_available {"recover_provider_turn"} else if manual {"manual_required"} else if has_markdown {"already_projected"} else {"not_failed"}}})
}

fn empty_response() -> Value {
    json!({"availability":"empty","task":null,"recovery":no_recovery(),"input":null,"report":null,"resume":{"available":false,"reason":"not_failed"}})
}

fn input_from_value(value: &Value) -> Option<Value> {
    (value.is_object()
        && text(&value["schemaVersion"]) == SCHEMA
        && text(&value["promptVersion"]) == PROMPT_VERSION
        && !text(&value["preparedAt"]).is_empty())
    .then(|| value.clone())
}

fn scalar_number(value: &Value) -> Option<f64> {
    if value.is_null() {
        return None;
    }
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

fn number_value(number: Option<f64>) -> Value {
    match number {
        Some(number)
            if number.fract() == 0.0 && number >= i64::MIN as f64 && number < i64::MAX as f64 =>
        {
            json!(number as i64)
        }
        Some(number) => json!(number),
        None => Value::Null,
    }
}

fn parse_task(value: &Value) -> Option<Value> {
    const STATUSES: [&str; 8] = [
        "queued",
        "leased",
        "running",
        "interrupt_requested",
        "succeeded",
        "failed",
        "interrupted",
        "superseded",
    ];
    if !value.is_object()
        || text(&value["name"]).is_empty()
        || !STATUSES.contains(&text(&value["status"]))
    {
        return None;
    }
    let created = scalar_number(&value["createdAt"])?;
    let updated = scalar_number(&value["updatedAt"])?;
    let mut task = web_workflow::task_view(value);
    task["createdAt"] = number_value(Some(created));
    task["updatedAt"] = number_value(Some(updated));
    if task["runId"].is_null() {
        task["taskId"] =
            number_value(scalar_number(&value["taskId"]).filter(|n| *n > 0.0 && n.fract() == 0.0));
    }
    Some(task)
}

fn parse_recovery(value: &Value) -> Value {
    let phase = text(&value["phase"]);
    if ["none", "recovering", "manual_required"].contains(&phase) {
        json!({"phase":phase,"reason":if text(&value["reason"]).is_empty(){Value::Null}else{json!(text(&value["reason"]))}})
    } else {
        no_recovery()
    }
}

fn recovery_after_task(current: &Value, task: &Value) -> Value {
    if current["phase"] == "recovering" && web_workflow::is_terminal(task) {
        return manual(if text(&task["errorMessage"]).is_empty() {
            "找回后的任务没有产生可验证的完成结果。"
        } else {
            text(&task["errorMessage"])
        });
    }
    if task["status"] == "failed" && !web_workflow::has_recoverable_checkpoint(&task["checkpoint"])
    {
        return manual("任务没有可验证的原会话 checkpoint，不能执行无重放找回。");
    }
    current.clone()
}

fn normalize_reasoning_effort(value: Option<&str>) -> Result<&str> {
    let effort = value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("xhigh");
    if !["low", "medium", "high", "xhigh"].contains(&effort) {
        bail!("unsupported macro-analysis reasoning effort");
    }
    Ok(effort)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report() -> String {
        let headings = [
            "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二",
        ];
        format!(
            "# 报告\n{}\n# 一句话结论\n{}",
            headings
                .iter()
                .map(|h| format!("## {h}、主题"))
                .collect::<Vec<_>>()
                .join("\n"),
            "研究证据".repeat(1100)
        )
    }
    #[test]
    fn validates_numbered_topology_and_utf16_minimum() {
        let markdown = report();
        assert!(validate_markdown(&markdown).is_ok());
        assert!(validate_markdown(&markdown.replace("## 十二、主题", "## 缺失章节")).is_err());
        assert!(validate_markdown(&markdown.replace("# 一句话结论", "## 一句话结论")).is_err());
        assert!(validate_markdown("研究".repeat(1500).as_str()).is_err());
        assert!(
            validate_terminal_evidence(
                &json!({"schemaVersion":"webqa.completion-evidence.v1","outcome":"succeeded"})
            )
            .is_ok()
        );
        assert!(
            validate_terminal_evidence(
                &json!({"schemaVersion":"webqa.completion-evidence.v1","outcome":"failed"})
            )
            .is_err()
        );
    }

    #[test]
    fn validator_stays_aligned_with_authoritative_prompt_topology() {
        let prompt = include_str!("../../../prompts/macro.md");
        // The prompt is instructions, not a completed research report. Padding
        // isolates its numbered topology from the report-length requirement.
        let topology_fixture = format!("{prompt}\n{}", "证据".repeat(1000));
        assert!(validate_markdown(&topology_fixture).is_ok());
        assert!(
            validate_markdown(&topology_fixture.replace("# 十二、", "# 缺少第十二章、")).is_err()
        );
    }
    #[test]
    fn stored_normalization_keeps_report_while_next_run_is_pending() {
        let current = normalize_stored(&json!({"markdown":" old report ","inputJson":"{\"old\":true}","citationsJson":"[1]","task":{"name":"macro:analysis:global","status":"succeeded","taskId":1,"createdAt":1,"updatedAt":2},"recovery":{"phase":"none"},"projectedAt":2})).unwrap();
        let next = merge(
            Some(&current),
            &json!({"pendingProjection":true,"pendingInputJson":"{\"new\":true}","task":{"name":TASK_NAME,"status":"queued","createdAt":3,"updatedAt":3}}),
        );
        let view = response(&next);
        assert_eq!(view["availability"], "available");
        assert_eq!(view["report"]["markdown"], "old report");
        assert_eq!(view["input"]["old"], true);
        assert_eq!(view["task"]["status"], "queued");
        assert_eq!(next["pendingInputJson"], "{\"new\":true}");
    }
    #[test]
    fn invalid_storage_and_terminal_recovery_are_not_pending() {
        assert!(
            normalize_stored(&json!({"task":{"name":TASK_NAME,"status":"invented"}})).is_none()
        );
        let failed = merge(
            None,
            &json!({"pendingProjection":false,"task":{"status":"failed"},"recovery":manual("malformed completed report")}),
        );
        assert_eq!(response(&failed)["availability"], "failed");
        assert_eq!(response(&failed)["resume"]["available"], false);
        assert_eq!(normalize_reasoning_effort(None).unwrap(), "xhigh");
        assert!(normalize_reasoning_effort(Some("maximum")).is_err());
    }

    #[test]
    fn integer_task_identity_survives_legacy_normalization() {
        let remote = json!({"taskId":42,"name":TASK_NAME,"status":"running","createdAt":1_793_000_000_000_i64,"updatedAt":1_793_000_000_001_i64});
        let stored_task = parse_task(&remote).unwrap();
        assert!(web_workflow::observed_identity(&stored_task, &remote));
        assert_eq!(stored_task["taskId"].as_i64(), Some(42));
        let numeric_strings = json!({"taskId":"42","name":TASK_NAME,"status":"running","createdAt":"1793000000000","updatedAt":"1793000000001"});
        assert!(web_workflow::observed_identity(
            &parse_task(&numeric_strings).unwrap(),
            &remote
        ));
        let changed_run = json!({"taskId":43,"name":TASK_NAME,"createdAt":1_793_000_000_000_i64});
        assert!(!web_workflow::observed_identity(&stored_task, &changed_run));
    }

    #[tokio::test]
    async fn loading_legacy_expired_report_is_read_only_and_durable() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("macro.sqlite")).unwrap();
        db.migrate(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let legacy = json!({"markdown":"legacy report","inputJson":"{\"schemaVersion\":\"legacy\"}","citationsJson":"[1]","sourcesJson":"[2]","terminalEvidenceJson":"{\"old\":true}","projectedAt":123});
        db.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,?,?)",vec![NAMESPACE.into(),KEY.into(),legacy.to_string().into(),1.into(),123.into()]).await.unwrap();
        let before = db
            .query(
                "SELECT * FROM kv_cache WHERE namespace=? AND key=?",
                vec![NAMESPACE.into(), KEY.into()],
            )
            .await
            .unwrap();
        let state = AppState::new(
            db.clone(),
            dir.path().to_path_buf(),
            "127.0.0.1:8000".into(),
        )
        .unwrap();
        let view = load(&state).await.unwrap();
        assert_eq!(view["availability"], "available");
        assert_eq!(view["report"]["markdown"], "legacy report");
        assert_eq!(view["report"]["citations"], json!([1]));
        assert_eq!(view["report"]["terminalMetadata"], json!({"old":true}));
        assert_eq!(
            db.query(
                "SELECT * FROM kv_cache WHERE namespace=? AND key=?",
                vec![NAMESPACE.into(), KEY.into()]
            )
            .await
            .unwrap(),
            before
        );
    }
}
