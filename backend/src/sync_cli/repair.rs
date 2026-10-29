use super::text;
use crate::AppState;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::fs;

pub fn run(state: &AppState, options: &Value) -> Result<Value> {
    let configured = text(options, "dir");
    let directory = if configured.is_empty() {
        state
            .data_dir()
            .join("market-data/financial-statements/income")
    } else {
        state.root.join(configured)
    };
    // This command is a narrowly scoped income-cache repair, never a general
    // recursive cleanup or cache eviction of durable ledger records.
    if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
        bail!("income snapshot directory must not be a symlink");
    }
    let mut entries = fs::read_dir(&directory)
        .with_context(|| {
            format!(
                "income snapshot directory is unreadable: {}",
                directory.display()
            )
        })?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort();
    let delete = options["delete"] == true;
    let (mut scanned, mut cn, mut cumulative, mut missing, mut annual, mut unreadable, mut deleted) =
        (0, 0, 0, 0, 0, 0, 0);
    let (mut removed, mut unreadable_files, mut non_cn) = (Vec::new(), Vec::new(), Vec::new());
    for entry in entries {
        let entry = entry.to_string_lossy();
        let Some(code) = entry.strip_suffix(".json") else {
            continue;
        };
        scanned += 1;
        if ![".SH", ".SZ", ".BJ"]
            .iter()
            .any(|suffix| code.ends_with(suffix))
        {
            non_cn.push(code.to_owned());
            continue;
        }
        cn += 1;
        let file = directory.join(entry.as_ref());
        let snapshot = fs::symlink_metadata(&file)
            .ok()
            .filter(|m| m.is_file() && !m.file_type().is_symlink())
            .and_then(|_| fs::read(&file).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(snapshot) = snapshot else {
            unreadable += 1;
            unreadable_files.push(entry.to_string());
            continue;
        };
        let contracts = snapshot["rows"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row["payload"]["FINANCIAL_SOURCE_CONTRACT"].as_str())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let has_cumulative = contracts.iter().any(|contract| {
            ["eastmoney_f10_income.v1", "eastmoney_f10_annual_income.v1"].contains(contract)
        });
        let has_annual = contracts.contains(&"eastmoney_f10_annual_income.v1");
        if has_cumulative {
            cumulative += 1;
        } else {
            missing += 1;
        }
        if !has_annual {
            annual += 1;
        }
        if has_cumulative {
            continue;
        }
        if delete {
            fs::remove_file(&file)?;
            deleted += 1;
        }
        if removed.len() < 20 {
            removed.push(code.to_owned());
        }
    }
    Ok(
        json!({"directory":directory,"mode":if delete{"delete"}else{"dry_run"},"scanned":scanned,"isCnAware":cn,"hasCumulative":cumulative,"missingCumulative":missing,"missingAnnual":annual,"unreadable":unreadable,"deleted":deleted,"removedCodes":removed,"unreadableFiles":unreadable_files,"skippedNonCn":non_cn,"note":if delete{"已删除缺累计家族的 A 股 income 快照；下次请求会从东财重新拉取累计 + 单季度两个家族。"}else{"仅统计，未删除任何文件；加 --delete 才真正清理。"}}),
    )
}
