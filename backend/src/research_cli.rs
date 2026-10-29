//! Native local research commands. API consumers remain explicit loopback clients;
//! no Worker URL, JavaScript subprocess, or implicit remote publication is used.
pub mod buy_point;
pub mod earnings;
pub mod fund_quarterly;
pub mod institutional_tracks;
use crate::AppState;
use anyhow::{Context, Result, bail};
use reqwest::{Method, Url, header::HeaderMap};
use serde_json::Value;
use std::{fs, io::Write, path::Path};

pub fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("").trim()
}
pub fn read_config(state: &AppState, path: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(state.root.join(path))?)?)
}
pub fn write_text(path: &Path, text: &str) -> Result<()> {
    let parent = path.parent().context("output has no parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(text.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|e| e.error)?;
    Ok(())
}
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    write_text(path, &(serde_json::to_string_pretty(value)? + "\n"))
}
pub async fn api(state: &AppState, path: &str, parameters: &[(String, String)]) -> Result<Value> {
    if !path.starts_with("/api/") || path.starts_with("//") {
        bail!("invalid local API path");
    }
    let mut url = Url::parse(&format!("http://{}{}", state.authority, path))?;
    url.query_pairs_mut()
        .extend_pairs(parameters.iter().map(|(k, v)| (k, v)));
    let text = state
        .http
        .text_with_timeout(url.as_str(), Method::GET, HeaderMap::new(), None, 120_000)
        .await?;
    let result: Value = serde_json::from_str(&text)?;
    if result["code"].as_i64() != Some(200) {
        bail!(
            "local API {path} failed: {}",
            result["msg"].as_str().unwrap_or("invalid response")
        );
    }
    Ok(result["data"].clone())
}
fn local_api_state(state: &AppState, options: &Value) -> Result<AppState> {
    let mut local = state.clone();
    if !string(options, "baseUrl").is_empty() {
        let url = Url::parse(string(options, "baseUrl"))?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || !matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            )
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("research API base URL must be a plain loopback HTTP origin");
        }
        local.authority = url
            .as_str()
            .strip_prefix("http://")
            .unwrap()
            .trim_end_matches('/')
            .to_string();
    }
    Ok(local)
}
pub async fn run(state: &AppState, operation: &str, options: &Value) -> Result<Value> {
    let state = local_api_state(state, options)?;
    match operation {
        "earnings" => earnings::run(&state, options).await,
        "fund-quarterly" => fund_quarterly::run(&state, options).await,
        "buy-point" => buy_point::run(&state, options).await,
        "institutional-tracks" => institutional_tracks::run(&state, options).await,
        _ => bail!("unknown research command: {operation}"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn explicit_loopback_origins_only() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("db.sqlite")).unwrap();
        let state = AppState::new(db, dir.path().into(), "127.0.0.1:8000".into()).unwrap();
        for url in [
            "https://tinfo.cc",
            "http://127.0.0.1:8000/private",
            "http://user:secret@127.0.0.1:8000",
            "http://127.0.0.1:8000/?secret=x",
        ] {
            assert!(
                local_api_state(&state, &json!({"baseUrl":url})).is_err(),
                "{url}"
            );
        }
        for url in [
            "http://localhost:18000",
            "http://127.0.0.1:18000/",
            "http://[::1]:18000",
        ] {
            assert!(
                local_api_state(&state, &json!({"baseUrl":url})).is_ok(),
                "{url}"
            );
        }
    }
}
