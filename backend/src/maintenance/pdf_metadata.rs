//! Repair only metadata on historically imported local PDFs. No schema changes,
//! model requests, file conversion or source re-imports occur here.
use crate::AppState;
use anyhow::{Context, Result, ensure};
use regex::Regex;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Duration};

fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.trim().into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items.iter().map(text).collect::<Vec<_>>().join(","),
        _ => value.to_string(),
    }
}
fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("constant PDF metadata pattern")
}
fn date(value: &str) -> String {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    if digits.len() != 8 {
        return String::new();
    }
    let year: u32 = digits[..4].parse().unwrap();
    let month: u32 = digits[4..6].parse().unwrap();
    let day: u32 = digits[6..].parse().unwrap();
    if !(2000..=2100).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return String::new();
    }
    format!("{}-{}-{}", &digits[..4], &digits[4..6], &digits[6..])
}
fn stock_code(value: &str) -> String {
    let raw = value.trim().to_uppercase();
    if let Some(c) = re(r"^US([A-Z0-9.-]+)\.(OQ|NQ|N|AMEX|PK|OB)$").captures(&raw) {
        return format!("{}.US", &c[1]);
    }
    if let Some(c) = re(r"^([036]\d{5})$").captures(&raw) {
        return format!(
            "{}.{}",
            &c[1],
            if c[1].starts_with('6') { "SH" } else { "SZ" }
        );
    }
    if re(r"^(\d{4}\.(TW|TWO)|\d{3,5}\.HK|[A-Z0-9.-]+\.(SH|SZ|HK|US|TW|TWO))$").is_match(&raw) {
        raw
    } else {
        String::new()
    }
}
/// Exact historical filename grammar, intentionally retaining its 1..31 day
/// check (including February 31) and its narrow stock suffix allowlist.
fn parse_filename(file: &str) -> Value {
    let stem = Path::new(file)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .trim()
        .to_owned();
    let normalized = re("[_-]+").replace_all(&stem, " ").trim().to_owned();
    let tokens: Vec<_> = re("[-_]+")
        .split(&stem)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.is_empty() {
        return json!({"originalStem":normalized,"normalizedStem":normalized,"publishedAt":"","sourceName":"","targetName":"","targetCode":"","reportType":"research_report","title":normalized});
    }
    let di = tokens.iter().take(3).position(|t| !date(t).is_empty());
    let prefix = di
        .filter(|i| *i > 0)
        .map(|i| tokens[..i].join(" "))
        .unwrap_or_default();
    let si = di.filter(|i| i + 2 < tokens.len()).map(|i| i + 1);
    let titles = &tokens[si
        .map(|i| i + 1)
        .unwrap_or_else(|| di.map(|i| i + 1).unwrap_or(0))..];
    let lead = titles.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    let mut kind = if re("行业|赛道|策略|周报|月报|晨报|深度行业").is_match(&prefix)
        || re("行业|赛道|策略|周报|月报|晨报").is_match(&lead)
    {
        "industry_report"
    } else if re("个股|公司|点评|首次覆盖").is_match(&prefix) {
        "company_report"
    } else {
        "research_report"
    };
    let joined = titles.join(" ");
    let clean = |s: &str| re(r"[（(]\s*$").replace(s, "").trim().to_owned();
    let (mut name, mut code) = (String::new(), String::new());
    if kind != "industry_report" {
        if let Some(c) = re(r"^(.+?)\(([^()]+)\)").captures(&joined) {
            let parsed = stock_code(&c[2]);
            if !parsed.is_empty() {
                name = clean(&c[1]);
                code = parsed;
            }
        }
        if code.is_empty() && titles.len() >= 2 {
            let parsed = stock_code(titles[1]);
            if !parsed.is_empty() {
                name = clean(titles[0]);
                code = parsed;
            }
        }
    }
    let mut title = joined.trim().to_owned();
    if !code.is_empty() {
        kind = "company_report";
        if titles.len() >= 2 && clean(titles[0]) == name && stock_code(titles[1]) == code {
            title = titles[2..].join(" ").trim().to_owned();
            if title.is_empty() {
                title = format!("{name} ({code})");
            }
        }
    }
    if title.is_empty() {
        title = normalized.clone();
    }
    json!({"originalStem":stem,"normalizedStem":normalized,"publishedAt":di.map(|i|date(tokens[i])).unwrap_or_default(),"sourceName":si.map(|i|tokens[i]).unwrap_or(""),"targetName":name,"targetCode":code,"reportType":kind,"title":title})
}
fn normalize(value: &str) -> String {
    re(r"\s+").replace_all(value, " ").trim().into()
}
fn build_update(row: &Value) -> Option<Value> {
    let metadata = row["metadata"].as_object().cloned().unwrap_or_default();
    let original = text(
        metadata
            .get("originalFile")
            .filter(|v| !text(v).is_empty())
            .or_else(|| metadata.get("inputFile"))
            .unwrap_or(&Value::Null),
    );
    if original.is_empty() {
        return None;
    }
    let parsed = parse_filename(&original);
    let current = |key: &str| text(&row[key]);
    let fallback = |key: &str| {
        let value = current(key);
        if value.is_empty() {
            text(&parsed[key])
        } else {
            value
        }
    };
    let source = current("sourceName");
    let source = if ["", "本地导入", "local import"].contains(&source.to_lowercase().as_str()) {
        text(&parsed["sourceName"])
    } else {
        source
    };
    let published = fallback("publishedAt");
    let event = current("eventTime");
    let event = if !text(&parsed["publishedAt"]).is_empty()
        && (event.is_empty() || event == current("fetchedAt"))
    {
        text(&parsed["publishedAt"])
    } else {
        event
    };
    let name = fallback("targetName");
    let code = fallback("targetCode");
    let report = current("reportType");
    let parsed_report = text(&parsed["reportType"]);
    let report = if !parsed_report.is_empty()
        && (report.is_empty() || report == "research_report")
        && (parsed_report != "research_report" || !code.is_empty())
    {
        if code.is_empty() {
            parsed_report
        } else {
            "company_report".into()
        }
    } else {
        report
    };
    let old_title = current("title");
    let parsed_title = text(&parsed["title"]);
    let normalized_title = normalize(&old_title);
    let title = if !parsed_title.is_empty()
        && parsed_title != old_title
        && (normalized_title == normalize(&text(&parsed["normalizedStem"]))
            || normalized_title == normalize(&text(&parsed["originalStem"]))
            || (!text(&parsed["publishedAt"]).is_empty()
                && normalized_title.starts_with(&text(&parsed["publishedAt"]).replace('-', ""))))
    {
        parsed_title.clone()
    } else {
        old_title.clone()
    };
    let old_summary = current("summary");
    let summary = if old_summary.is_empty()
        || old_summary == old_title
        || normalize(&old_summary) == normalize(&text(&parsed["normalizedStem"]))
    {
        parsed_title
    } else {
        old_summary
    };
    let changed = [
        ("sourceName", &source),
        ("publishedAt", &published),
        ("eventTime", &event),
        ("targetName", &name),
        ("targetCode", &code),
        ("reportType", &report),
        ("title", &title),
        ("summary", &summary),
    ]
    .iter()
    .any(|(key, value)| current(key) != **value);
    if !changed {
        return None;
    }
    let mut metadata = Value::Object(metadata);
    metadata["filenameParse"] = json!({"publishedAt":parsed["publishedAt"],"sourceName":parsed["sourceName"],"targetName":parsed["targetName"],"targetCode":parsed["targetCode"],"reportType":parsed["reportType"]});
    let mut codes = vec![code.trim().to_uppercase()];
    codes.extend(
        metadata["stockLinks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|link| text(&link["code"]).to_uppercase()),
    );
    let mut seen = HashSet::new();
    codes.retain(|s| !s.is_empty() && seen.insert(s.clone()));
    let sort = [event.clone(), published.clone(), current("fetchedAt")]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    Some(
        json!({"docId":row["docId"],"sourceName":source,"publishedAt":published,"eventTime":event,"targetName":name,"targetCode":code,"reportType":report,"title":title,"summary":summary,"metadataJson":serde_json::to_string(&metadata).ok()?,"sortTime":sort,"sourceNameNormalized":source.to_lowercase(),"targetCodeNormalized":code.to_uppercase(),"securityCodes":codes}),
    )
}
fn execute(conn: &mut Connection, apply: bool) -> Result<Value> {
    ensure!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='knowledge_docs'",
            [],
            |r| r.get::<_, i64>(0)
        )? == 1,
        "configured local SQLite database is missing table knowledge_docs"
    );
    let file = conn
        .path()
        .context("knowledge metadata repair requires a file database")?
        .to_owned();
    let tx = conn.transaction_with_behavior(if apply {
        rusqlite::TransactionBehavior::Immediate
    } else {
        rusqlite::TransactionBehavior::Deferred
    })?;
    let rows = {
        let mut stmt=tx.prepare("SELECT doc_id,coalesce(source_name,''),coalesce(title,''),coalesce(summary,''),coalesce(published_at,''),coalesce(fetched_at,''),coalesce(event_time,''),coalesce(target_name,''),coalesce(target_code,''),coalesce(report_type,''),coalesce(metadata_json,'') FROM knowledge_docs WHERE source_type='research_report' AND discovery_method='local_process_once' AND coalesce(json_extract(metadata_json,'$.originalFile'),'') LIKE '%.pdf'")?;
        stmt.query_map([], |r| {
            let keys = [
                "docId",
                "sourceName",
                "title",
                "summary",
                "publishedAt",
                "fetchedAt",
                "eventTime",
                "targetName",
                "targetCode",
                "reportType",
                "metadata",
            ];
            let mut row = json!({});
            for (index, key) in keys.iter().enumerate() {
                let value: String = r.get(index)?;
                row[*key] = if *key == "metadata" {
                    serde_json::from_str::<Value>(&value)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or(json!({}))
                } else {
                    json!(value)
                };
            }
            Ok(row)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let updates: Vec<_> = rows.iter().filter_map(build_update).collect();
    if apply {
        for row in &updates {
            tx.execute("UPDATE knowledge_docs SET source_name=?1,published_at=?2,event_time=?3,target_name=?4,target_code=?5,report_type=?6,title=?7,summary=?8,metadata_json=?9,sort_time=?10,source_name_normalized=?11,target_code_normalized=?12 WHERE doc_id=?13",params![text(&row["sourceName"]),text(&row["publishedAt"]),text(&row["eventTime"]),text(&row["targetName"]),text(&row["targetCode"]),text(&row["reportType"]),text(&row["title"]),text(&row["summary"]),text(&row["metadataJson"]),text(&row["sortTime"]),text(&row["sourceNameNormalized"]),text(&row["targetCodeNormalized"]),text(&row["docId"])])?;
            tx.execute(
                "DELETE FROM knowledge_doc_security_links WHERE doc_id=?",
                [text(&row["docId"])],
            )?;
            for code in row["securityCodes"].as_array().into_iter().flatten() {
                tx.execute("INSERT INTO knowledge_doc_security_links(doc_id,code) VALUES(?,?) ON CONFLICT(doc_id,code) DO NOTHING",params![text(&row["docId"]),text(code)])?;
            }
        }
    }
    tx.commit()?;
    let mut result = json!({"dryRun":!apply,"databaseFile":file,"candidates":rows.len(),"updated":updates.len()});
    if !updates.is_empty() {
        result["sample"] = json!(updates.into_iter().take(5).collect::<Vec<_>>());
    }
    Ok(result)
}
pub async fn run(state: &AppState, options: &Value) -> Result<Value> {
    let apply = super::apply(options);
    let supplied = super::string(options, "dbFile");
    if supplied.is_empty() {
        return state.db.run(move |conn| execute(conn, apply)).await;
    }
    let file = state.root.join(supplied);
    ensure!(
        file.is_file(),
        "configured local SQLite database does not exist: {}",
        file.display()
    );
    tokio::task::spawn_blocking(move || {
        let flags = if apply {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let mut conn = Connection::open_with_flags(file, flags)?;
        conn.busy_timeout(Duration::from_secs(30))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        execute(&mut conn, apply)
    })
    .await?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_javascript_filename_goldens() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("pdf_metadata_cases.json")).unwrap();
        for case in cases {
            assert_eq!(
                parse_filename(case["file"].as_str().unwrap()),
                case["expected"],
                "{}",
                case["file"]
            );
        }
    }
}
