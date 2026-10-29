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

/// Trusted native CLI configuration only. Keep endpoint and credentials out of
/// untrusted HTTP options; no process-global environment mutation is needed.
pub async fn direct_text_with_credential(
    state: &AppState,
    options: &Value,
    base_url: &str,
    api_key: &str,
) -> Result<String> {
    require_direct_local(state)?;
    let key = required(api_key, "local direct LLM credential")?;
    direct_text_endpoint_events(state, options, base_url, &key, None).await
}

/// Caller-owned trusted application configuration, kept separate from the
/// request's model/prompt JSON so an API body cannot redirect credential use.
pub struct DirectEndpoint {
    pub base_url: String,
    pub api_key_env: String,
}

#[derive(Debug)]
struct DirectTerminalFailure(String);
impl fmt::Display for DirectTerminalFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for DirectTerminalFailure {}
pub fn is_explicit_terminal_failure(error: &anyhow::Error) -> bool {
    error.downcast_ref::<DirectTerminalFailure>().is_some()
}

pub async fn direct_text_configured(
    state: &AppState,
    options: &Value,
    endpoint: &DirectEndpoint,
) -> Result<String> {
    direct_text_configured_events(state, options, endpoint, None).await
}
pub async fn direct_text_configured_events(
    state: &AppState,
    options: &Value,
    endpoint: &DirectEndpoint,
    events: Option<tokio::sync::mpsc::UnboundedSender<String>>,
) -> Result<String> {
    require_direct_local(state)?;
    let key = [
        state.setting(&endpoint.api_key_env),
        state.setting("LLM_API_KEY"),
    ]
    .into_iter()
    .find(|value| !value.trim().is_empty())
    .context("local direct LLM credential is not configured")?;
    direct_text_endpoint_events(state, options, &endpoint.base_url, &key, events).await
}
pub async fn direct_text_events(
    state: &AppState,
    options: &Value,
    events: Option<tokio::sync::mpsc::UnboundedSender<String>>,
) -> Result<String> {
    require_direct_local(state)?;
    let key = [
        state.setting("OPENAI_API_KEY"),
        state.setting("LLM_API_KEY"),
    ]
    .into_iter()
    .find(|s| !s.trim().is_empty())
    .context("local direct LLM credential is not configured")?;
    let base = [
        state.setting("OPENAI_BASE_URL"),
        state.setting("LLM_BASE_URL"),
    ]
    .into_iter()
    .find(|s| !s.trim().is_empty())
    .unwrap_or_else(|| "https://api.m2ai.cc/api/v1/openai".into());
    direct_text_endpoint_events(state, options, &base, &key, events).await
}

fn require_direct_local(state: &AppState) -> Result<()> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("direct LLM calls are disabled outside local runtime");
    }
    Ok(())
}

async fn direct_text_endpoint_events(
    state: &AppState,
    options: &Value,
    base: &str,
    key: &str,
    events: Option<tokio::sync::mpsc::UnboundedSender<String>>,
) -> Result<String> {
    require_direct_local(state)?;
    let expected_model = options
        .get("expectedModel")
        .map(|value| required(text(value), "expected response model"))
        .transpose()?;
    let base = required(base, "local direct LLM base URL")?;
    let url = Url::parse(&base)?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("invalid local direct LLM base URL");
    }
    let mut input = options["input"]
        .as_array()
        .context("direct LLM input must be an array")?
        .clone();
    for message in &mut input {
        if message["role"] == "assistant" {
            for part in message["content"]
                .as_array_mut()
                .context("invalid direct LLM message content")?
            {
                if part["type"] != "input_text" {
                    bail!("Responses assistant history supports text only");
                }
                part["type"] = json!("output_text");
            }
        }
    }
    let body = json!({"model":options["model"],"instructions":options.get("instructions").cloned().unwrap_or_else(||json!("")),"input":input,"store":false,"stream":true});
    // Responses streaming deliberately omits max_output_tokens/temperature,
    // matching the shared client's stream-only provider contract.
    let client = Client::builder().no_proxy().build()?;
    let mut response = tokio::time::timeout(
        Duration::from_secs(120),
        client
            .post(format!("{}/responses", base.trim_end_matches('/')))
            .bearer_auth(key)
            .header("accept", "text/event-stream")
            .json(&body)
            .send(),
    )
    .await
    .context("LLM stream did not start within 120000ms")??;
    if !response.status().is_success() {
        bail!(
            "responses stream failed: status={}",
            response.status().as_u16()
        );
    }
    let mut pending = Vec::<u8>::new();
    let mut output = String::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(120), response.chunk())
            .await
            .context("LLM stream idle timeout")??;
        let Some(chunk) = chunk else {
            break;
        };
        pending.extend_from_slice(&chunk);
        // Byte-buffer event framing preserves split UTF-8 sequences.
        loop {
            let lf = pending
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|p| (p, 2));
            let crlf = pending
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|p| (p, 4));
            let boundary = match (lf, crlf) {
                (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
                (a, b) => a.or(b),
            };
            let Some((end, width)) = boundary else {
                break;
            };
            let bytes = pending.drain(..end + width).collect::<Vec<_>>();
            if consume_checked_event(
                &String::from_utf8(bytes)?,
                &mut output,
                events.as_ref(),
                expected_model.as_deref(),
            )? {
                return Ok(output.trim().to_string());
            }
        }
        if let Ok(raw) = std::str::from_utf8(&pending)
            && event_payload(raw).is_some_and(|event| {
                matches!(
                    text(&event["type"]),
                    "response.completed" | "response.failed" | "response.incomplete" | "error"
                )
            })
            && consume_checked_event(raw, &mut output, events.as_ref(), expected_model.as_deref())?
        {
            return Ok(output.trim().to_string());
        }
        if events.as_ref().is_some_and(|channel| channel.is_closed()) {
            bail!("direct LLM stream consumer disconnected");
        }
    }
    bail!(
        "LLM stream ended before response.completed after partial output ({} chars)",
        output.chars().count()
    )
}

fn response_text(value: &Value) -> String {
    if let Some(text) = value["text"].as_str() {
        return text.to_string();
    }
    if let Some(text) = value["output_text"].as_str() {
        return text.to_string();
    }
    let mut chunks = Vec::new();
    let items = if value.is_array() {
        value.as_array()
    } else {
        value["output"]
            .as_array()
            .or_else(|| value["content"].as_array())
    };
    for item in items.into_iter().flatten() {
        if let Some(text) = item["text"].as_str() {
            chunks.push(text.to_string());
        }
        for content in item["content"].as_array().into_iter().flatten() {
            if let Some(text) = content["text"].as_str() {
                chunks.push(text.to_string());
            }
        }
    }
    chunks.join("\n")
}
fn event_payload(raw: &str) -> Option<Value> {
    let data = raw
        .lines()
        .filter_map(|line| line.trim().strip_prefix("data:"))
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != "[DONE]")
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&data).ok()
}
fn consume_event(
    raw: &str,
    output: &mut String,
    events: Option<&tokio::sync::mpsc::UnboundedSender<String>>,
) -> Result<bool> {
    let Some(event) = event_payload(raw) else {
        return Ok(false);
    };
    let emit = |delta: &str, output: &mut String| {
        output.push_str(delta);
        if let Some(channel) = events {
            let _ = channel.send(delta.to_string());
        }
    };
    match text(&event["type"]) {
        "response.output_text.delta" => {
            if let Some(delta) = event["delta"].as_str() {
                emit(delta, output);
            }
        }
        "response.output_text.done" if output.is_empty() => {
            if let Some(delta) = event["text"].as_str() {
                emit(delta, output);
            }
        }
        "response.content_part.added" | "response.content_part.done" if output.is_empty() => {
            if matches!(text(&event["part"]["type"]), "output_text" | "text")
                && let Some(delta) = event["part"]["text"].as_str()
            {
                emit(delta, output);
            }
        }
        "response.output_item.added" | "response.output_item.done" if output.is_empty() => {
            emit(&response_text(&event["item"]), output);
        }
        "response.completed" => {
            if output.is_empty() {
                emit(&response_text(&event["response"]), output);
            }
            if output.trim().is_empty() {
                return Err(DirectTerminalFailure(
                    "LLM stream completed without output text".into(),
                )
                .into());
            }
            return Ok(true);
        }
        "response.failed" | "error" | "response.incomplete" => {
            let message = [
                &event["response"]["error"]["message"],
                &event["response"]["incomplete_details"]["reason"],
                &event["error"]["message"],
            ]
            .into_iter()
            .map(text)
            .find(|s| !s.is_empty())
            .unwrap_or("provider returned an incomplete response");
            return Err(DirectTerminalFailure(format!(
                "LLM stream failed: {}",
                message.chars().take(400).collect::<String>()
            ))
            .into());
        }
        _ => {}
    }
    Ok(false)
}

fn consume_checked_event(
    raw: &str,
    output: &mut String,
    events: Option<&tokio::sync::mpsc::UnboundedSender<String>>,
    expected_model: Option<&str>,
) -> Result<bool> {
    if let Some(expected) = expected_model
        && let Some(event) = event_payload(raw)
        && event["type"] == "response.completed"
        && event["response"]["model"].as_str() != Some(expected)
    {
        bail!("LLM terminal response model does not match expected model");
    }
    consume_event(raw, output, events)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caller_can_require_an_exact_terminal_model_before_committing_text() {
        let raw = |model: Value| {
            format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":{"model":model,"output_text":"validated text"}})
            )
        };
        for model in [Value::Null, json!("gpt-6"), json!("gpt-6-luna-alias")] {
            let error =
                consume_checked_event(&raw(model), &mut String::new(), None, Some("gpt-6-luna"))
                    .unwrap_err();
            assert!(!is_explicit_terminal_failure(&error));
        }
        let mut text = String::new();
        assert!(
            consume_checked_event(
                &raw(json!("gpt-6-luna")),
                &mut text,
                None,
                Some("gpt-6-luna")
            )
            .unwrap()
        );
        assert_eq!(text, "validated text");
        assert!(consume_checked_event(&raw(Value::Null), &mut String::new(), None, None).unwrap());
    }
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
    #[test]
    fn streaming_requires_explicit_completion_and_preserves_deltas() {
        let mut output = String::new();
        assert!(
            !consume_event(
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\n\n",
                &mut output,
                None
            )
            .unwrap()
        );
        assert_eq!(output, "你好");
        assert!(
            consume_event(
                "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                &mut output,
                None
            )
            .unwrap()
        );
        assert!(
            consume_event(
                "data: {\"type\":\"response.failed\",\"error\":{\"message\":\"failed\"}}\n\n",
                &mut output,
                None
            )
            .is_err()
        );
        assert!(
            consume_event(
                "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                &mut String::new(),
                None
            )
            .is_err()
        );
    }
}
