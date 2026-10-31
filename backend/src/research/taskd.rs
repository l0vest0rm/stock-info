//! Taskd's caller protocol and no-replay report workflow. These helpers never
//! log credentials or prompts; observation and recovery are separate actions.
use crate::AppState;
use anyhow::{Context, Result, bail};
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::{Value, json};
use std::{fmt, time::Duration};

const STATUSES: &[&str] = &[
    "queued",
    "leased",
    "running",
    "interrupt_requested",
    "succeeded",
    "failed",
    "interrupted",
    "superseded",
];

#[derive(Debug)]
struct ReadUnavailable(String);
impl fmt::Display for ReadUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "taskd read unavailable: {}", self.0)
    }
}
impl std::error::Error for ReadUnavailable {}

pub fn is_read_unavailable(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ReadUnavailable>().is_some() || regex::Regex::new(r"(?i)errorCode=(?:network_fetch_failed|timeout_error|abort_error)\b|\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNRESET|ECONNREFUSED|Connect Timeout Error)\b").unwrap().is_match(&error.to_string())
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}
fn required(value: &str, label: &str) -> Result<String> {
    if value.trim().is_empty() {
        bail!("{label} is required");
    }
    Ok(value.trim().to_string())
}
fn local(state: &AppState) -> Result<()> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("taskd caller is only available in local LLM runtime");
    }
    Ok(())
}

fn endpoint(state: &AppState, parts: &[&str], capability: bool) -> Result<(Url, String, String)> {
    local(state)?;
    let base = required(&state.setting("TASKD_BASE_URL"), "TASKD_BASE_URL")?;
    let namespace = match state.setting("TASKD_NAMESPACE").trim() {
        "" => "stock-info".to_string(),
        value => value.to_string(),
    };
    let token = [
        state.setting("STOCK_INFO_TASKD_CALLER_TOKEN"),
        state.setting("TASKD_CALLER_TOKEN"),
    ]
    .into_iter()
    .find(|s| !s.trim().is_empty())
    .context("STOCK_INFO_TASKD_CALLER_TOKEN is required")?;
    let mut url = Url::parse(base.trim_end_matches('/'))?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("unsupported taskd URL scheme");
    }
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalid taskd base URL"))?
        .pop_if_empty()
        .extend(["v1", "namespaces", namespace.as_str()])
        .extend(if capability {
            &["executors"][..]
        } else {
            &["tasks"][..]
        })
        .extend(parts);
    Ok((url, token, namespace))
}

async fn request(
    state: &AppState,
    method: Method,
    parts: &[&str],
    body: Option<&Value>,
    capability: bool,
    query: Option<(&str, &str)>,
) -> Result<Option<Value>> {
    let (mut url, token, _) = endpoint(state, parts, capability)?;
    if let Some((key, value)) = query {
        url.query_pairs_mut().append_pair(key, value);
    }
    let timeout = Duration::from_millis(
        state
            .setting("HTTP_REQUEST_TIMEOUT_MS")
            .parse()
            .unwrap_or(10_000),
    );
    let client = Client::builder().no_proxy().timeout(timeout).build()?;
    let attempts = if method == Method::GET { 2 } else { 1 };
    for attempt in 0..attempts {
        let mut req = client
            .request(method.clone(), url.clone())
            .bearer_auth(&token);
        if let Some(body) = body {
            req = req.json(body);
        }
        let response = match req.send().await {
            Ok(response) => response,
            Err(error) => {
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    continue;
                }
                if method == Method::GET {
                    return Err(ReadUnavailable(
                        if error.is_timeout() {
                            "timeout_error"
                        } else {
                            "network_fetch_failed"
                        }
                        .into(),
                    )
                    .into());
                }
                return Err(anyhow::anyhow!(
                    "taskd request failed: {}",
                    error.without_url()
                ));
            }
        };
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let status = response.status();
        let raw = response.text().await.map_err(|error| {
            if method == Method::GET {
                anyhow::Error::from(ReadUnavailable(error.without_url().to_string()))
            } else {
                anyhow::Error::from(error.without_url())
            }
        })?;
        if !status.is_success() {
            // Do not echo arbitrary remote diagnostics that could include a
            // reflected bearer credential or frozen private business input.
            bail!("taskd returned {}", status.as_u16());
        }
        return Ok(Some(
            serde_json::from_str(&raw).context("taskd returned invalid JSON")?,
        ));
    }
    unreachable!()
}

fn positive(value: &Value, label: &str) -> Result<i64> {
    let n = value
        .as_i64()
        .or_else(|| value.as_str()?.parse().ok())
        .context(format!("{label} is invalid"))?;
    if n < 1 {
        bail!("{label} is invalid");
    }
    Ok(n)
}
fn optional_positive(value: &Value) -> Result<Value> {
    if value.is_null() {
        Ok(Value::Null)
    } else {
        Ok(json!(positive(value, "taskd integer")?))
    }
}
pub fn normalize_task(row: &Value) -> Result<Value> {
    if !row.is_object() {
        bail!("taskd returned a non-object response");
    }
    let status = required(text(&row["status"]), "taskd task status")?;
    if !STATUSES.contains(&status.as_str()) {
        bail!("taskd returned unsupported status: {status}");
    }
    Ok(
        json!({"taskId":positive(&row["task_id"],"taskd task_id")?,"namespace":required(text(&row["namespace"]),"taskd namespace")?,"name":required(text(&row["client_task_name"]),"taskd client_task_name")?,"taskType":required(text(&row["task_type"]),"taskd task_type")?,"input":row["input"],"status":status,"checkpoint":row["checkpoint"],"result":row["result"],"errorMessage":if text(&row["error_message"]).is_empty(){Value::Null}else{json!(text(&row["error_message"]))},"supersededByTaskId":optional_positive(&row["superseded_by_task_id"])? ,"createdAt":positive(&row["created_at"],"taskd created_at")?,"updatedAt":positive(&row["updated_at"],"taskd updated_at")?,"completedAt":optional_positive(&row["completed_at"])?}),
    )
}

pub async fn get(state: &AppState, name: &str) -> Result<Option<Value>> {
    let name = required(name, "taskd task name")?;
    request(state, Method::GET, &["by-name", &name], None, false, None)
        .await?
        .as_ref()
        .map(normalize_task)
        .transpose()
}
pub async fn availability(state: &AppState, task_type: &str) -> Result<Value> {
    let task_type = required(task_type, "taskd task type")?;
    let raw = request(
        state,
        Method::GET,
        &["availability"],
        None,
        true,
        Some(("task_type", &task_type)),
    )
    .await?
    .context("taskd availability missing")?;
    let namespace = match state.setting("TASKD_NAMESPACE").trim() {
        "" => "stock-info".into(),
        s => s.to_string(),
    };
    if raw["namespace"] != namespace || raw["task_type"] != task_type {
        bail!("taskd availability response did not match requested capability");
    }
    let nonnegative = |key: &str| -> Result<i64> {
        let n = raw[key]
            .as_i64()
            .context("taskd availability count is invalid")?;
        if n < 0 {
            bail!("taskd availability count is invalid");
        }
        Ok(n)
    };
    Ok(
        json!({"namespace":namespace,"taskType":task_type,"online":raw["online"].as_bool().unwrap_or(false),"available":raw["available"].as_bool().unwrap_or(false),"onlineExecutorCount":nonnegative("online_executor_count")?,"availableExecutorCount":nonnegative("available_executor_count")?,"availableSlotCount":nonnegative("available_slot_count")?}),
    )
}

pub async fn submit_report(state: &AppState, options: &Value) -> Result<Value> {
    local(state)?;
    let namespace = match state.setting("TASKD_NAMESPACE").trim() {
        "" => "stock-info".into(),
        s => s.to_string(),
    };
    let body = report_request(&namespace, options)?;
    let task = request(state, Method::POST, &[], Some(&body), false, None)
        .await?
        .context("taskd submit returned no task")?;
    normalize_task(&task)
}

fn report_request(namespace: &str, options: &Value) -> Result<Value> {
    let name = required(text(&options["name"]), "taskd task name")?;
    let task_type = required(text(&options["taskType"]), "taskd task type")?;
    let prompt = required(text(&options["prompt"]), "LLM prompt")?;
    let timeout = options["waitTimeoutMs"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(3_600_000)
        .min(86_400_000);
    let mut payload = json!({"platform":namespace,"conversation_id":format!("stock-info:{name}"),"provider":"chatgpt-web","input":prompt,"new_session":true,"timeout_ms":timeout,"mode":"ask"});
    if !text(&options["reasoningEffort"]).is_empty() {
        payload["reasoning_effort"] = options["reasoningEffort"].clone();
    }
    if options.get("businessInput").is_some() {
        payload["business_input"] = options["businessInput"].clone();
    }
    Ok(json!({"client_task_name":name,"task_type":task_type,"input":payload}))
}

pub fn task_view(task: &Value) -> Value {
    json!({"taskId":task["taskId"],"name":task["name"],"status":task["status"],"errorMessage":task["errorMessage"],"createdAt":task["createdAt"],"updatedAt":task["updatedAt"],"completedAt":task["completedAt"]})
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
pub fn observed_identity(expected: &Value, actual: &Value) -> bool {
    expected.is_object()
        && expected["name"] == actual["name"]
        && expected["createdAt"] == actual["createdAt"]
        && (expected["taskId"].is_null() || expected["taskId"] == actual["taskId"])
}
pub fn has_recoverable_checkpoint(value: &Value) -> bool {
    if !text(&value["provider_url"]).is_empty() {
        return true;
    }
    let submission = &value["submission"];
    let status = if text(&submission["state"]).is_empty() {
        text(&value["submission_state"])
    } else {
        text(&submission["state"])
    };
    submission["schema_version"] == "provider_submission.v1"
        && !text(&submission["marker"]).is_empty()
        && matches!(status, "" | "click_issued" | "url_bound")
}
pub async fn observe(state: &AppState, expected: &Value) -> Result<Option<Value>> {
    let task = get(state, text(&expected["name"])).await?;
    if let Some(task) = &task {
        if !observed_identity(expected, task) {
            bail!("recorded task was superseded; refusing a different run");
        }
        if task["status"] == "succeeded" && task["result"].is_null() {
            bail!("taskd succeeded task has no result");
        }
    }
    Ok(task)
}
pub async fn recover_with_status(
    state: &AppState,
    expected: &Value,
    statuses: &[&str],
) -> Result<(Option<Value>, bool)> {
    let Some(task) = get(state, text(&expected["name"])).await? else {
        return Ok((None, false));
    };
    if !observed_identity(expected, &task) {
        bail!("recorded task was superseded; refusing to recover another run");
    }
    if !statuses.contains(&text(&task["status"]))
        || !has_recoverable_checkpoint(&task["checkpoint"])
    {
        return Ok((Some(task), false));
    }
    let name = required(text(&expected["name"]), "taskd task name")?;
    let recovered = request(
        state,
        Method::POST,
        &["by-name", &name, "recover"],
        None,
        false,
        None,
    )
    .await?
    .as_ref()
    .map(normalize_task)
    .transpose()?;
    if recovered
        .as_ref()
        .is_some_and(|task| !observed_identity(expected, task))
    {
        bail!("recorded task was superseded during recovery");
    }
    Ok((recovered, true))
}
pub async fn recover(
    state: &AppState,
    expected: &Value,
    statuses: &[&str],
) -> Result<Option<Value>> {
    Ok(recover_with_status(state, expected, statuses).await?.0)
}

pub fn extract_result(result: &Value) -> Result<Value> {
    if result["format"] != "taskd.webqa.result.v2" {
        bail!("taskd WebQA result must use taskd.webqa.result.v2");
    }
    let content = &result["content"];
    if content["format"] != "web-helper.rich-content.v1"
        || !content["markdown"].is_string()
        || !content["assets"].is_array()
    {
        bail!("taskd WebQA result must include web-helper.rich-content.v1 content");
    }
    if !result["citations"].is_array() || !result["sources"].is_array() {
        bail!("taskd WebQA result must preserve citations and sources arrays");
    }
    if !result["raw_snapshot"].is_object()
        || !result["terminal_evidence"].is_object()
        || !result["execution"].is_object()
    {
        bail!("taskd WebQA result must preserve raw_snapshot, terminal_evidence, and execution");
    }
    Ok(
        json!({"format":"taskd.webqa.result.v2","content":content,"citations":result["citations"],"sources":result["sources"],"rawSnapshot":result["raw_snapshot"],"terminalEvidence":result["terminal_evidence"],"execution":result["execution"]}),
    )
}

pub async fn direct_text(state: &AppState, options: &Value) -> Result<String> {
    direct_text_events(state, options, None).await
}

pub use llm_client::direct::is_explicit_terminal_failure;

pub async fn direct_text_events(
    state: &AppState,
    options: &Value,
    events: Option<tokio::sync::mpsc::UnboundedSender<String>>,
) -> Result<String> {
    require_direct_local(state)?;
    let config = crate::llm::config(state)?;
    let key = required(
        &state.setting(&config.api_key_env),
        "configured LLM API key",
    )?;
    let mut options = options.clone();
    if let Some(expected) = options.get("expectedModel") {
        anyhow::ensure!(
            expected.as_str() == Some(&config.model),
            "LLM contract model differs from config; run npm run build:prompts"
        );
    }
    options["model"] = json!(config.model);
    llm_client::direct::text_once(&options, &config.base_url, config.protocol, &key, events).await
}

fn require_direct_local(state: &AppState) -> Result<()> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("direct LLM calls are disabled outside local runtime");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_wire_envelope_preserves_frozen_input_without_private_diagnostics() {
        let options = json!({"name":"research:financial-analysis:600036.SH","taskType":"webqa.chatgpt.v1","model":"gpt-5.6-luna","reasoningEffort":"xhigh","waitTimeoutMs":7200000,"prompt":"冻结输入：你好","businessInput":{"securityCode":"600036.SH","snapshotId":"fnv-test"},"diagnostics":{"securityCode":"600036.SH","private":"not-a-wire-field"}});
        let expected = json!({"client_task_name":"research:financial-analysis:600036.SH","task_type":"webqa.chatgpt.v1","input":{"platform":"stock-info","conversation_id":"stock-info:research:financial-analysis:600036.SH","provider":"chatgpt-web","input":"冻结输入：你好","reasoning_effort":"xhigh","new_session":true,"timeout_ms":7200000,"mode":"ask","business_input":{"securityCode":"600036.SH","snapshotId":"fnv-test"}}});
        assert_eq!(report_request("stock-info", &options).unwrap(), expected);
        let basic = json!({"name":"r","taskType":"webqa.chatgpt.v1","prompt":"prompt"});
        let result = report_request("fixture-ns", &basic).unwrap();
        assert_eq!(result["input"]["timeout_ms"], 3_600_000);
        assert_eq!(result["input"]["platform"], "fixture-ns");
        assert!(result["input"].get("business_input").is_none());
        let mut capped = basic;
        capped["waitTimeoutMs"] = json!(900_000_000);
        assert_eq!(
            report_request("n", &capped).unwrap()["input"]["timeout_ms"],
            86_400_000
        );
    }
    #[test]
    fn identity_checkpoints_and_result_contract_are_strict() {
        let expected = json!({"taskId":1,"name":"r:AAPL.US","createdAt":10});
        assert!(observed_identity(&expected, &expected));
        assert!(!observed_identity(
            &expected,
            &json!({"taskId":2,"name":"r:AAPL.US","createdAt":10})
        ));
        assert!(has_recoverable_checkpoint(
            &json!({"submission":{"schema_version":"provider_submission.v1","marker":"m","state":"click_issued"}})
        ));
        assert!(!has_recoverable_checkpoint(
            &json!({"submission":{"schema_version":"provider_submission.v1","marker":"m","state":"draft"}})
        ));
        assert!(extract_result(&json!({"markdown":"not authoritative"})).is_err());
        let result = json!({"format":"taskd.webqa.result.v2","content":{"format":"web-helper.rich-content.v1","markdown":"answer","assets":[]},"citations":[],"sources":[],"raw_snapshot":{},"terminal_evidence":{},"execution":{}});
        assert_eq!(
            extract_result(&result).unwrap()["content"]["markdown"],
            "answer"
        );
    }
}
