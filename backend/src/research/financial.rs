//! Frozen financial-analysis reports. Page reads only inspect the durable local
//! projection; background reconciliation observes an exact web_workflow execution.
use super::{financial_input, repository};
use crate::web_workflow;
use crate::{AppState, db::Database, http::number};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

pub const NAMESPACE: &str = "research_financial_analysis";

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}
fn nullable_text(value: &Value) -> Value {
    let s = text(value);
    if s.is_empty() { Value::Null } else { json!(s) }
}
fn parsed(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}
fn array(value: &Value) -> Value {
    let p = parsed(value);
    if p.is_array() { p } else { json!([]) }
}
fn snapshot(value: &Value) -> Value {
    let value = if value.is_string() {
        parsed(value)
    } else {
        value.clone()
    };
    if value.is_object() && !text(&value["securityCode"]).is_empty() {
        value
    } else {
        Value::Null
    }
}
fn numeric(value: &Value) -> Value {
    if let Some(i) = value.as_i64() {
        json!(i)
    } else if let Some(n) = number(value) {
        if n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
            json!(n as i64)
        } else {
            json!(n)
        }
    } else {
        Value::Null
    }
}
fn parse_task(value: &Value) -> Value {
    if text(&value["name"]).is_empty()
        || !matches!(
            text(&value["status"]),
            "queued"
                | "leased"
                | "running"
                | "interrupt_requested"
                | "succeeded"
                | "failed"
                | "interrupted"
                | "superseded"
        )
        || number(&value["createdAt"]).is_none()
        || number(&value["updatedAt"]).is_none()
    {
        return Value::Null;
    }
    let mut task = crate::web_workflow::task_view(value);
    task["errorMessage"] = nullable_text(&value["errorMessage"]);
    task
}
pub fn task_name(code: &str) -> String {
    format!("research:financial-analysis:{}", code.trim().to_uppercase())
}

pub async fn read_stored(db: &Database, code: &str) -> Result<Option<Value>> {
    let Some(value) = repository::read(db, NAMESPACE, code).await? else {
        return Ok(None);
    };
    if !value.is_object() {
        return Ok(None);
    }
    let task = parse_task(&value["task"]);
    let snapshot_json = value["snapshotJson"]
        .as_str()
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
    let markdown = nullable_text(&value["markdown"]);
    if snapshot_json.is_null() && markdown.is_null() && task.is_null() {
        return Ok(None);
    }
    let mut result = json!({"snapshotJson":snapshot_json,"markdown":markdown,"citationsJson":value["citationsJson"].as_str().unwrap_or("[]"),"sourcesJson":value["sourcesJson"].as_str().unwrap_or("[]"),"terminalEvidenceJson":value["terminalEvidenceJson"].as_str().map(|s|json!(s)).unwrap_or(Value::Null),"projectedAt":if value["projectedAt"].is_null(){Value::Null}else{numeric(&value["projectedAt"])},"projectionError":nullable_text(&value["projectionError"]),"task":task});
    if value.get("pendingSnapshotJson").is_some() {
        result["pendingSnapshotJson"] = value["pendingSnapshotJson"]
            .as_str()
            .map(|s| json!(s))
            .unwrap_or(Value::Null);
    }
    if value.get("pendingProjection").is_some() {
        result["pendingProjection"] = json!(value["pendingProjection"] == true);
    }
    Ok(Some(result))
}
pub async fn write_stored(db: &Database, code: &str, value: &Value) -> Result<()> {
    repository::save(db, NAMESPACE, code, value, None).await
}

fn merge(current: Option<&Value>, patch: &Value) -> Value {
    let mut value = json!({"pendingSnapshotJson":null,"pendingProjection":false,"snapshotJson":null,"markdown":null,"citationsJson":"[]","sourcesJson":"[]","terminalEvidenceJson":null,"projectedAt":null,"projectionError":null,"task":null});
    if let Some(current) = current {
        for key in [
            "pendingSnapshotJson",
            "pendingProjection",
            "snapshotJson",
            "markdown",
            "citationsJson",
            "sourcesJson",
            "terminalEvidenceJson",
            "projectedAt",
            "projectionError",
            "task",
        ] {
            if let Some(v) = current.get(key) {
                value[key] = v.clone();
            }
        }
    }
    if let Some(patch) = patch.as_object() {
        for (key, v) in patch {
            value[key] = v.clone();
        }
    }
    value
}
pub fn response_from_stored(result: &Value) -> Value {
    let snapshot = snapshot(&result["snapshotJson"]);
    let has_report = !text(&result["markdown"]).is_empty();
    let report = if has_report {
        json!({"markdown":result["markdown"],"citations":array(&result["citationsJson"]),"sources":array(&result["sourcesJson"]),"terminalMetadata":parsed(&result["terminalEvidenceJson"]),"projectedAt":result["projectedAt"]})
    } else {
        Value::Null
    };
    let input_schema = nullable_text(&snapshot["schemaVersion"]);
    let code_version = nullable_text(&snapshot["codeVersion"]);
    let report_version = if has_report {
        json!({"status":if input_schema==financial_input::PROTOCOL_VERSION&&code_version==financial_input::CODE_VERSION{"current"}else if !input_schema.is_null()||!code_version.is_null(){"legacy"}else{"unknown"},"inputSchemaVersion":input_schema,"codeVersion":code_version,"currentInputSchemaVersion":financial_input::PROTOCOL_VERSION,"currentCodeVersion":financial_input::CODE_VERSION})
    } else {
        Value::Null
    };
    let availability = if has_report {
        "available"
    } else if !text(&result["projectionError"]).is_empty()
        || web_workflow::is_terminal(&result["task"])
    {
        "failed"
    } else if !result["task"].is_null() {
        "pending"
    } else {
        "empty"
    };
    json!({"availability":availability,"task":result["task"],"snapshot":snapshot,"report":report,"reportVersion":report_version,"resume":{"available":!has_report&&!result["task"].is_null(),"reason":if has_report{"already_projected"}else if !text(&result["projectionError"]).is_empty(){"retry_projection_only"}else if web_workflow::is_terminal(&result["task"]){"inspect_existing_task_only"}else{"observe_existing_task_only"}}})
}
pub async fn load(state: &AppState, code: &str) -> Result<Value> {
    Ok(match read_stored(&state.db, code).await? {
        Some(value) => response_from_stored(&value),
        None => {
            json!({"availability":"empty","task":null,"snapshot":null,"report":null,"resume":{"available":false,"reason":"not_failed"}})
        }
    })
}
fn reasoning(value: Option<&str>) -> Result<&str> {
    let value = value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("xhigh");
    if !["low", "medium", "high", "xhigh"].contains(&value) {
        bail!("unsupported financial-analysis reasoning effort");
    }
    Ok(value)
}
fn local(state: &AppState, operation: &str) -> Result<()> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("financial analysis {operation} is only available in local LLM runtime");
    }
    Ok(())
}

pub async fn enqueue(
    state: &AppState,
    code: &str,
    force: bool,
    effort: Option<&str>,
) -> Result<Value> {
    local(state, "submission")?;
    let prepared = financial_input::prepare(state, code).await?;
    let input = &prepared["snapshot"];
    let code = text(&input["securityCode"]);
    let current = read_stored(&state.db, code).await?;
    let effort = reasoning(effort)?;
    let task=web_workflow::submit_report(state,&json!({"name":task_name(code),"taskType":"webqa.chatgpt.v1","model":web_workflow::model(state)?,"reasoningEffort":effort,"waitTimeoutMs":3_600_000,"prompt":prepared["prompt"],"businessInput":input,"diagnostics":{"securityCode":code,"model":web_workflow::model(state)?,"reasoningEffort":effort,"promptVersion":input["codeVersion"],"schemaVersion":input["schemaVersion"]}})).await?;
    let serialized = json!(serde_json::to_string(input)?);
    let stored = merge(
        current.as_ref(),
        &json!({"pendingProjection":true,"pendingSnapshotJson":serialized,"snapshotJson":if current.as_ref().is_some_and(|v|!text(&v["markdown"]).is_empty()){current.as_ref().unwrap()["snapshotJson"].clone()}else{serialized},"task":web_workflow::task_view(&task)}),
    );
    repository::save(&state.db, NAMESPACE, code, &stored, None).await?;
    Ok(
        json!({"accepted":true,"task":web_workflow::task_view(&task),"snapshot":input,"force":force}),
    )
}

async fn persist(
    state: &AppState,
    code: &str,
    current: &Value,
    input: &Value,
    task: Option<&Value>,
    error: Option<&str>,
) -> Result<Value> {
    let mut patch = json!({"pendingProjection":true,"task":task.map(web_workflow::task_view).unwrap_or(Value::Null),"projectionError":error.map(|s|json!(s)).unwrap_or(Value::Null)});
    if text(&current["markdown"]).is_empty() && !input.is_null() {
        patch["snapshotJson"] = json!(serde_json::to_string(input)?);
    }
    let stored = merge(Some(current), &patch);
    repository::save(&state.db, NAMESPACE, code, &stored, Some(current)).await?;
    Ok(stored)
}
fn task_snapshot(task: &Value) -> Value {
    snapshot(&task["input"]["business_input"])
}

async fn project(
    state: &AppState,
    code: &str,
    input: &Value,
    task: &Value,
    current: &Value,
) -> Result<()> {
    let result = web_workflow::extract_result(&task["result"])?;
    let markdown = text(&result["content"]["markdown"]);
    financial_input::validate_markdown(markdown)?;
    let stored = json!({"pendingProjection":false,"pendingSnapshotJson":null,"snapshotJson":serde_json::to_string(input)?,"markdown":markdown,"citationsJson":serde_json::to_string(&result["citations"])?,"sourcesJson":serde_json::to_string(&result["sources"])?,"terminalEvidenceJson":serde_json::to_string(&result["terminalEvidence"])?,"projectedAt":chrono::Utc::now().timestamp_millis(),"projectionError":null,"task":web_workflow::task_view(task)});
    repository::save(&state.db, NAMESPACE, code, &stored, Some(current)).await
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
            && !web_workflow::is_pending(&current["task"]))
    {
        return Ok(());
    }
    if super::repository::unchanged_failed_execution(&state.db, &current["task"]).await? {
        return Ok(());
    }
    let result = async {
        match web_workflow::observe(state, &current["task"]).await? {
            None => {
                persist(
                    state,
                    &code,
                    &current,
                    &snapshot(&current["snapshotJson"]),
                    None,
                    Some("local ledger no longer has the recorded financial-analysis task"),
                )
                .await?;
            }
            Some(task) => {
                if task["status"] == "succeeded" {
                    let mut input = task_snapshot(&task);
                    if input.is_null() {
                        input = if !current["pendingSnapshotJson"].is_null() {
                            snapshot(&current["pendingSnapshotJson"])
                        } else if current["pendingProjection"] == true
                            && !text(&current["markdown"]).is_empty()
                        {
                            Value::Null
                        } else {
                            snapshot(&current["snapshotJson"])
                        };
                    }
                    if input.is_null() {
                        bail!("financial analysis task has no frozen input snapshot");
                    }
                    if text(&input["securityCode"]).to_uppercase() != code {
                        bail!("financial analysis frozen input security mismatch");
                    }
                    project(state, &code, &input, &task, &current).await?;
                } else {
                    let input = task_snapshot(&task);
                    let input = if input.is_null() {
                        snapshot(&current["snapshotJson"])
                    } else {
                        input
                    };
                    persist(state, &code, &current, &input, Some(&task), None).await?;
                }
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        if web_workflow::is_read_unavailable(&error) {
            return Err(error);
        }
        let task =
            repository::projection_failed_task(&state.db, &current["task"], &error.to_string())
                .await?;
        persist(
            state,
            &code,
            &current,
            &snapshot(&current["snapshotJson"]),
            Some(&task),
            Some(&error.to_string()),
        )
        .await?;
        return Err(error);
    }
    Ok(())
}
pub async fn resume(state: &AppState, code: &str) -> Result<Value> {
    let code = code.trim().to_uppercase();
    let stored = read_stored(&state.db, &code)
        .await?
        .context("financial analysis has no recorded task to recover")?;
    if stored["task"].is_null() {
        bail!("financial analysis has no recorded task to recover");
    }
    local(state, "recovery")?;
    let remote = web_workflow::recover(
        state,
        &stored["task"],
        &["succeeded", "failed", "interrupted", "superseded"],
    )
    .await?;
    if let Some(task) = remote {
        let input = task_snapshot(&task);
        let input = if input.is_null() {
            snapshot(&stored["snapshotJson"])
        } else {
            input
        };
        persist(state, &code, &stored, &input, Some(&task), None).await?;
    } else {
        persist(
            state,
            &code,
            &stored,
            &snapshot(&stored["snapshotJson"]),
            None,
            Some("local ledger no longer has the recorded financial-analysis task"),
        )
        .await?;
    }
    reconcile_one(state, &code).await?;
    load(state, &code).await
}
pub async fn sync(state: &AppState, code: &str) -> Result<Value> {
    local(state, "synchronization")?;
    reconcile_one(state, code).await?;
    load(state, code).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn frozen_terminal_projection_preserves_sources_and_rejects_stale_writes() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("financial.sqlite")).unwrap();
        db.migrate(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
        let input = json!({"securityCode":"600036.SH","schemaVersion":financial_input::PROTOCOL_VERSION,"codeVersion":financial_input::CODE_VERSION});
        let markdown = (1..=8)
            .map(|n| format!("# {n}. section\n{}\n", "财务依据".repeat(35)))
            .collect::<String>();
        let mut task = json!({"taskId":1,"name":task_name("600036.SH"),"status":"succeeded","createdAt":1,"updatedAt":2,"completedAt":2,"result":{"format":"taskd.webqa.result.v2","content":{"format":"web-helper.rich-content.v1","markdown":markdown,"assets":[]},"citations":[{"title":"filing","url":"https://fixture.invalid/filing"}],"sources":[{"url":"https://fixture.invalid/filing"}],"terminal_evidence":{"schemaVersion":"fixture-evidence"},"execution":{},"raw_snapshot":{}}});
        let pending = merge(
            None,
            &json!({"pendingProjection":true,"pendingSnapshotJson":serde_json::to_string(&input).unwrap(),"task":web_workflow::task_view(&task)}),
        );
        write_stored(&state.db, "600036.SH", &pending)
            .await
            .unwrap();
        project(&state, "600036.SH", &input, &task, &pending)
            .await
            .unwrap();
        let projected = read_stored(&state.db, "600036.SH").await.unwrap().unwrap();
        let response = response_from_stored(&projected);
        assert_eq!(response["reportVersion"]["status"], "current");
        assert_eq!(response["report"]["sources"], task["result"]["sources"]);
        assert_eq!(response["report"]["citations"], task["result"]["citations"]);
        assert_eq!(
            response["report"]["terminalMetadata"],
            task["result"]["terminal_evidence"]
        );
        assert_eq!(projected["pendingProjection"], false);
        assert!(projected["pendingSnapshotJson"].is_null());
        let next = merge(
            Some(&projected),
            &json!({"pendingProjection":true,"task":{"taskId":2,"name":task_name("600036.SH"),"status":"queued","createdAt":3,"updatedAt":3}}),
        );
        write_stored(&state.db, "600036.SH", &next).await.unwrap();
        project(&state, "600036.SH", &input, &task, &pending)
            .await
            .unwrap();
        assert_eq!(
            read_stored(&state.db, "600036.SH").await.unwrap().unwrap()["task"]["taskId"],
            2
        );
        task["result"]["content"]["markdown"] = json!("too short");
        assert!(
            project(&state, "600036.SH", &input, &task, &next)
                .await
                .is_err()
        );
        assert_eq!(
            read_stored(&state.db, "600036.SH").await.unwrap().unwrap()["markdown"],
            projected["markdown"]
        );
    }
    #[test]
    fn read_models_preserve_published_report_during_pending_new_run() {
        let stored = json!({"snapshotJson":serde_json::to_string(&json!({"securityCode":"600036.SH","schemaVersion":"old","codeVersion":"old"})).unwrap(),"markdown":"published","pendingProjection":true,"task":{"name":"task","status":"running"},"citationsJson":"[]","sourcesJson":"[]","terminalEvidenceJson":"{}","projectedAt":1});
        let response = response_from_stored(&stored);
        assert_eq!(response["availability"], "available");
        assert_eq!(response["report"]["markdown"], "published");
        assert_eq!(response["reportVersion"]["status"], "legacy");
        assert_eq!(response["resume"]["available"], false);
        let merged = merge(
            Some(&stored),
            &json!({"pendingProjection":true,"task":{"name":"new","status":"queued"}}),
        );
        assert_eq!(merged["markdown"], "published");
    }
    #[test]
    fn task_parser_rejects_invalid_status_and_preserves_integer_identity() {
        let task = json!({"taskId":2,"name":"report","status":"failed","createdAt":5,"updatedAt":7,"completedAt":null});
        assert_eq!(parse_task(&task)["createdAt"], 5);
        assert_eq!(
            parse_task(&json!({"name":"bad","status":"invented","createdAt":1,"updatedAt":2})),
            Value::Null
        );
        assert!(reasoning(Some("arbitrary")).is_err());
        assert_eq!(reasoning(None).unwrap(), "xhigh");
    }
}
