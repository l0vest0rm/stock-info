//! Native local data maintenance. These operations never invoke a JavaScript
//! runtime, create tables, or dispatch a remote database write.
pub mod configs;
mod profiles;
mod repair;
pub mod stocks;

use crate::AppState;
use anyhow::{Result, bail};
use serde_json::Value;
use std::{fs, io::Write, path::Path};

pub async fn run(state: &AppState, operation: &str, options: &Value) -> Result<Value> {
    if options["remote"] == true {
        bail!("remote Cloudflare maintenance is retired");
    }
    match operation {
        "profiles" => profiles::run(state, options).await,
        "repair-income" => {
            let state = state.clone();
            let options = options.clone();
            tokio::task::spawn_blocking(move || repair::run(&state, &options)).await?
        }
        "sp500" | "asia-popular" | "csi" | "hk-popular" => {
            stocks::run(state, operation, options).await
        }
        "valuation" | "institutional-keywords" => configs::run(state, operation, options).await,
        _ => bail!("unknown sync operation: {operation}"),
    }
}

pub(super) fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("").trim()
}

pub(super) fn write_json(path: &Path, value: &Value) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("output has no parent"))?;
    fs::create_dir_all(parent)?;
    // Keep an interrupted command from truncating a previously valid catalog.
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temporary, value)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}
