//! Direct native model calls, independent of browser workflows.
use crate::AppState;
use anyhow::{Result, bail};
use serde_json::{Value, json};
fn required(value: &str, label: &str) -> Result<String> {
    if value.trim().is_empty() {
        bail!("{label} is required");
    }
    Ok(value.trim().to_string())
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
