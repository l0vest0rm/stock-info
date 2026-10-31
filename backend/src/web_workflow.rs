//! Local durable browser research. CEA owns every workflow step and recovery
//! cursor; this host owns admission, fenced storage and business projection.
mod result;
mod runtime;
mod store;
use crate::AppState;
use anyhow::{Context, Result, bail, ensure};
use cea_sdk::WorkflowCheckpoint;
pub use result::{canonical_markdown, extract_result};
pub use runtime::{Worker, start, tick};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const RUNS: &str = "local_web_workflow_runs_v1";
pub const LEASES: &str = "local_web_workflow_leases_v1";
pub const FORMAT: &str = "web-research-result.v1";
pub(crate) fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("").trim()
}
pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn local(state: &AppState) -> Result<()> {
    ensure!(
        state.setting("LLM_RUNTIME") == "local",
        "browser research requires LLM_RUNTIME=local"
    );
    Ok(())
}
pub fn model(state: &AppState) -> Result<String> {
    Ok(text(&state.config("config/app/web-research.json")?["model"]).to_string())
}
pub fn is_read_unavailable(_: &anyhow::Error) -> bool {
    false
}
pub fn is_pending(task: &Value) -> bool {
    matches!(
        text(&task["status"]),
        "queued" | "leased" | "running" | "interrupt_requested"
    )
}
pub fn is_terminal(task: &Value) -> bool {
    matches!(
        text(&task["status"]),
        "succeeded" | "failed" | "interrupted" | "superseded"
    )
}
pub fn task_view(task: &Value) -> Value {
    let mut view = json!({});
    for key in [
        "taskId",
        "runId",
        "engine",
        "revision",
        "name",
        "status",
        "errorMessage",
        "createdAt",
        "updatedAt",
        "completedAt",
        "recoveryRequired",
        "lastStep",
        "startedAt",
        "errorCode",
        "failedStep",
        "matchCount",
    ] {
        view[key] = task[key].clone();
    }
    view
}
pub fn observed_identity(expected: &Value, actual: &Value) -> bool {
    expected.is_object()
        && expected["name"] == actual["name"]
        && expected["createdAt"] == actual["createdAt"]
        && (expected["taskId"].is_null() || expected["taskId"] == actual["taskId"])
        && (expected["runId"].is_null() || expected["runId"] == actual["runId"])
}
pub fn has_recoverable_checkpoint(v: &Value) -> bool {
    serde_json::from_value::<WorkflowCheckpoint>(v.clone()).is_ok_and(|c| c.side_effect_possible())
}
pub(crate) fn binding(name: &str) -> Result<(String, String)> {
    for (prefix, ns) in [
        (
            "research:financial-analysis:",
            "research_financial_analysis",
        ),
        (
            "research:investment-analysis:",
            "research_investment_analysis",
        ),
        ("company:report-discovery:", "company_report_discovery"),
    ] {
        if let Some(code) = name.strip_prefix(prefix) {
            ensure!(!code.is_empty(), "empty business key");
            return Ok((ns.into(), code.to_uppercase()));
        }
    }
    if name == "macro:analysis:global" {
        return Ok(("macro_analysis".into(), "GLOBAL".into()));
    }
    bail!("unsupported browser research business name")
}

/// Durable admission only. Workers require the business projection to refer to
/// this run before opening a Page, so failed HTTP persistence cannot send work.
pub async fn submit_report(state: &AppState, options: &Value) -> Result<Value> {
    local(state)?;
    ensure!(
        !text(&options["prompt"]).is_empty(),
        "research prompt is required"
    );
    let (namespace, key) = binding(text(&options["name"]))?;
    let cfg = state.config("config/app/web-research.json")?;
    let effort = match text(&options["reasoningEffort"]) {
        "" => "xhigh",
        v => v,
    };
    let increments = cfg["reasoning"][effort]["increments"]
        .as_u64()
        .filter(|n| *n <= 4)
        .context("unsupported reasoning effort")?;
    let path = state.root.join(text(&cfg["workflow"]));
    cea_sdk::validate_workflow(&path)?;
    let template = std::fs::read_to_string(&path)?;
    ensure!(
        template.matches("# reasoning-increments").count() == 1,
        "workflow reasoning expansion marker missing"
    );
    let steps = (0..increments)
        .map(|i| {
            format!("- press: {{ id: reasoning_increment_{i}, locator: power, key: ArrowRight }}")
        })
        .collect::<Vec<_>>()
        .join("\n  ");
    let workflow = template.replace("# reasoning-increments", &steps);
    let configured_endpoint = state.setting("CEA_ENDPOINT");
    let endpoint = if configured_endpoint.is_empty() {
        "ws://127.0.0.1:9876/api/v1/ws".to_string()
    } else {
        configured_endpoint
    };
    let profile = match state.setting("LOCAL_WEB_RESEARCH_PROFILE") {
        s if s.is_empty() => text(&cfg["profile"]).to_string(),
        s => s,
    };
    ensure!(
        !profile.is_empty() && !text(&cfg["model"]).is_empty(),
        "web research profile/model is required"
    );
    let variables = BTreeMap::from([
        ("profile".to_string(), profile.clone()),
        ("prompt".into(), text(&options["prompt"]).to_string()),
        ("model_label".into(), text(&cfg["model"]).to_string()),
        (
            "model_index".into(),
            cfg["modelIndex"]
                .as_u64()
                .filter(|n| *n > 0)
                .context("modelIndex must be positive")?
                .to_string(),
        ),
        (
            "reasoning_label".into(),
            text(&cfg["reasoning"][effort]["label"]).to_string(),
        ),
    ]);
    let id = uuid::Uuid::new_v4().to_string();
    let directory = state.data_dir().join("web-research").join(&id);
    std::fs::create_dir_all(&directory)?;
    let directory = std::fs::canonicalize(directory)?;
    // Private audit directory, never mounted by the content server.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let frozen = directory.join("workflow.yaml");
    std::fs::write(&frozen, &workflow)?;
    cea_sdk::validate_workflow(&frozen)?;
    let record = json!({"runId":id,"taskId":id,"engine":"cea","revision":1,"name":options["name"],"taskType":"local.web-research.v1", "status":"queued", "createdAt":now(),"updatedAt":now(),"completedAt":null,"errorMessage":null,
        "retention":"durable","storageVersion":1,"binding":{"namespace":namespace,"key":key},
        "input":{"business_input":options["businessInput"]},"variables":variables,"endpoint":endpoint,"profile":profile,
        "workflowSnapshot":workflow,"workflowHash":hash(workflow.as_bytes()),"inputFingerprint":hash(serde_json::to_string(&variables)?.as_bytes()),"directory":directory,
        "checkpoint":null,"result":null,"recoveryRequired":false,"owner":null,"leaseUntil":0,"fencingToken":0});
    store::admit(&state.db, record).await
}

pub async fn observe(state: &AppState, expected: &Value) -> Result<Option<Value>> {
    local(state)?;
    let id = text(&expected["runId"]);
    // Old taskd identities never become local CEA runs and never trigger remote I/O.
    if id.is_empty() {
        let mut old = expected.clone();
        old["status"] = json!("failed");
        old["errorMessage"] =
            json!("旧 taskd 执行未迁移；请人工核对原会话。本机不会自动重发提示词。");
        old["checkpoint"] = Value::Null;
        old["recoveryRequired"] = json!(true);
        return Ok(Some(old));
    }
    let task = state.db.get_kv(RUNS, id).await?;
    if let Some(actual) = &task {
        ensure!(
            observed_identity(expected, actual),
            "recorded execution identity mismatch"
        );
    }
    Ok(task)
}

pub async fn recover_with_status(
    state: &AppState,
    expected: &Value,
    statuses: &[&str],
) -> Result<(Option<Value>, bool)> {
    let Some(task) = observe(state, expected).await? else {
        return Ok((None, false));
    };
    if !statuses.contains(&text(&task["status"])) || text(&task["runId"]).is_empty() {
        return Ok((Some(task), false));
    }
    if task["status"] == "succeeded" {
        let output = std::path::Path::new(text(&task["directory"])).join("output");
        if cea_sdk::read_workflow_result(&output)?.is_none() {
            return Ok((Some(task), false));
        }
        let next = store::queue_recovery(&state.db, &task).await?;
        return Ok((Some(next), true));
    }
    // Even a pre-submission crash resumes its exact SDK cursor; never starts anew.
    if serde_json::from_value::<WorkflowCheckpoint>(task["checkpoint"].clone()).is_err() {
        return Ok((Some(task), false));
    }
    let next = store::queue_recovery(&state.db, &task).await?;
    Ok((Some(next), true))
}
pub async fn recover(
    state: &AppState,
    expected: &Value,
    statuses: &[&str],
) -> Result<Option<Value>> {
    Ok(recover_with_status(state, expected, statuses).await?.0)
}

/// Local diagnostics intentionally expose neither frozen prompts nor credentials,
/// opaque SDK state, source HTML or filesystem paths.
pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/research/web-workflows/{id}", get(status_route))
        .route("/research/web-workflows/{id}/resume", post(resume_route))
        .route("/research/web-workflows/{id}/cancel", post(cancel_route))
}
async fn lookup(state: &AppState, id: &str) -> Result<Value> {
    local(state)?;
    uuid::Uuid::parse_str(id).context("invalid local execution ID")?;
    state
        .db
        .get_kv(RUNS, id)
        .await?
        .context("local execution not found")
}
async fn status_route(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> crate::ApiResult {
    let run = lookup(&state, &id).await?;
    Ok(crate::ok(
        json!({"task":task_view(&run),"hasCheckpoint":!run["checkpoint"].is_null(),"hasResult":!run["result"].is_null()}),
    ))
}
async fn resume_route(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> crate::ApiResult {
    let run = lookup(&state, &id).await?;
    let (task, recovering) =
        recover_with_status(&state, &run, &["failed", "interrupted", "succeeded"]).await?;
    runtime::reconcile(&state).await;
    Ok(crate::ok(
        json!({"task":task.as_ref().map(task_view),"recovering":recovering}),
    ))
}
async fn cancel_route(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> crate::ApiResult {
    let run = lookup(&state, &id).await?;
    store::cancel(&state.db, &run).await?;
    runtime::reconcile(&state).await;
    Ok(crate::ok(
        json!({"accepted":true,"providerRequestRetracted":false}),
    ))
}
