//! Trusted application routing. Wire protocol and provider differences belong to llm-client.
use crate::AppState;
use anyhow::{Context, Result, ensure};
use llm_client::direct::Protocol;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub model: String,
    pub base_url: String,
    pub api_key_env: String,
    pub protocol: Protocol,
}

pub fn config(state: &AppState) -> Result<Config> {
    let config: Config =
        serde_json::from_slice(&std::fs::read(state.root.join("config/app/llm.json"))?)
            .context("invalid config/app/llm.json")?;
    ensure!(!config.model.trim().is_empty(), "LLM model is required");
    ensure!(
        !config.api_key_env.trim().is_empty(),
        "LLM API key environment name is required"
    );
    Ok(config)
}
