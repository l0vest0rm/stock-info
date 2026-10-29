//! Local Eastmoney research-report discovery. This is the native replacement
//! for `scripts/fetch-eastmoney-reports.mjs`; it writes source documents to the
//! configured ingestion inbox, never to a remote database or object store.
use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};
use chrono_tz::Asia::Shanghai;
use reqwest::{Url, header::HeaderMap};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
};

const SOURCE: &str = "eastmoney_reports";
const SHARED_DATA: &str = "/Users/terry/git/data";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchRange {
    pub begin_time: String,
    pub end_time: String,
    pub mode: &'static str,
}

fn text(value: &Value) -> String {
    js_string(value).trim().to_string()
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}

fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    let number = match value {
        None => return fallback,
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(value)) => Some(if *value { 1.0 } else { 0.0 }),
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) if value.trim().is_empty() => Some(0.0),
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    };
    number
        .filter(|number| {
            number.is_finite()
                && number.fract() == 0.0
                && *number >= i64::MIN as f64
                && *number < i64::MAX as f64
        })
        .map(|number| number as i64)
        .unwrap_or(fallback)
}

fn local_date(value: &Value) -> Option<NaiveDate> {
    let value = text(value);
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return None;
    }
    let date = NaiveDate::parse_from_str(&value, "%Y-%m-%d").ok()?;
    // JavaScript's numeric Date constructor maps years 0..99 into 1900..1999;
    // the legacy parser's roundtrip check consequently rejects those inputs.
    if value[..4].parse::<u16>().ok()? < 100 {
        return None;
    }
    (date.format("%Y-%m-%d").to_string() == value).then_some(date)
}

/// The legacy process used the launcher's local time zone. Pinning Shanghai
/// makes that original workstation behavior independent of the Rust host TZ.
pub fn resolve_range(
    config: &Value,
    root_config: &Value,
    previous: &Value,
    now: DateTime<Utc>,
) -> Result<FetchRange> {
    let end =
        local_date(&config["endTime"]).unwrap_or_else(|| now.with_timezone(&Shanghai).date_naive());
    let lookback = integer(
        config
            .get("lookbackDays")
            .filter(|value| !value.is_null())
            .or_else(|| root_config.get("maxReportAgeDays")),
        60,
    );
    let lookback = if lookback > 0 { lookback } else { 60 };
    let overlap = integer(config.get("overlapDays"), 1);
    let overlap = if overlap >= 0 { overlap } else { 1 };
    let floor = end
        .checked_sub_signed(
            Duration::try_days(lookback).context("report lookback is out of range")?,
        )
        .context("report lookback date is out of range")?;
    let (begin, mode) = if let Some(begin) = local_date(&config["beginTime"]) {
        (begin, "explicit_begin")
    } else if let Some(last_end) = local_date(&previous["lastEndTime"]) {
        let resumed = last_end
            .checked_sub_signed(
                Duration::try_days(overlap).context("report overlap is out of range")?,
            )
            .context("report resume date is out of range")?;
        (floor.max(resumed), "resume")
    } else {
        (floor, "lookback")
    };
    Ok(FetchRange {
        begin_time: begin.to_string(),
        end_time: end.to_string(),
        mode,
    })
}

fn component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

pub fn map_report(item: &Value, report_type: &str, now: DateTime<Utc>) -> Value {
    let info = text(&item["infoCode"]);
    let title = text(&item["title"]);
    let code = text(&item["stockCode"]);
    let name = text(&item["stockName"]);
    let institution = if truthy(&item["orgSName"]) {
        text(&item["orgSName"])
    } else {
        text(&item["orgName"])
    };
    let industry = if truthy(&item["indvInduName"]) {
        text(&item["indvInduName"])
    } else {
        text(&item["industryName"])
    };
    let published = text(&item["publishDate"])
        .chars()
        .take(10)
        .collect::<String>();
    let target_name = if name.is_empty() {
        industry.clone()
    } else {
        name.clone()
    };
    let target_code = if code.is_empty() {
        String::new()
    } else {
        format!("{code}.{}", if code.starts_with('6') { "SH" } else { "SZ" })
    };
    let mut tags = vec!["pdf".to_string()];
    match report_type {
        "company_report" => tags.push("公司研报".into()),
        "industry_report" => tags.push("行业研报".into()),
        _ => {}
    }
    if !industry.is_empty() && !tags.contains(&industry) {
        tags.push(industry.clone());
    }
    let url = if info.is_empty() {
        String::new()
    } else {
        format!("https://pdf.dfcfw.com/pdf/H3_{}_1.pdf", component(&info))
    };
    let id = if info.is_empty() {
        String::new()
    } else {
        format!(
            "k_{}",
            &format!(
                "{:x}",
                Sha256::digest(format!("eastmoney_report|{info}").as_bytes())
            )[..24]
        )
    };
    let summary = [&title, &institution, &target_name, &industry]
        .into_iter()
        .filter(|value| !value.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    json!({
        "docId": id, "sourceType": "research_report", "reportType": report_type,
        "sourceName": if institution.is_empty() { "东方财富" } else { &institution },
        "title": title, "url": url, "publishedAt": published,
        "fetchedAt": now.to_rfc3339_opts(SecondsFormat::Millis, true), "eventTime": published,
        "targetName": target_name, "targetCode": target_code,
        "discoveryMethod": "eastmoney_report_list", "accessMethod": "remote_pdf",
        "summary": summary, "markdown": "", "tags": tags,
        "metadata": {
            "source": "eastmoney_report_list", "infoCode": info, "stockCode": code,
            "stockName": name, "orgName": text(&item["orgName"]), "orgSName": text(&item["orgSName"]),
            "industryName": industry, "publishDate": text(&item["publishDate"]),
            "researchForecastEvidence": {
                "schemaVersion": "research-source-forecast.v1", "carrierRelation": "republication",
                "carrier": { "displayName": "东方财富", "evidenceUrl": url,
                    "evidenceTitle": if title.is_empty() { "东方财富研报载体" } else { &title } }
            }, "raw": item
        }
    })
}

fn load_state(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn configured_path(root: &Path, config: &Value, key: &str, fallback: &Path) -> PathBuf {
    let configured = text(&config[key]);
    if configured.is_empty() {
        root.join(fallback)
    } else {
        root.join(configured)
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("report output path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".stock-info-report-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub async fn fetch(state: &AppState, config: &Value) -> Result<Value> {
    fetch_with(state, config, Utc::now(), |url| async move {
        let mut headers = HeaderMap::new();
        headers.insert(
            "referer",
            "https://data.eastmoney.com/report/".parse().unwrap(),
        );
        headers.insert(
            "user-agent",
            "Mozilla/5.0 (compatible; stock-info-local/0.1)"
                .parse()
                .unwrap(),
        );
        state.http.json(&url, headers).await
    })
    .await
}

async fn fetch_with<F, Fut>(
    state: &AppState,
    config: &Value,
    now: DateTime<Utc>,
    mut request: F,
) -> Result<Value>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let cfg = &config["eastmoneyReports"];
    if cfg["enabled"] == false {
        return Ok(json!({"source":SOURCE,"skipped":true,"reason":"disabled"}));
    }
    if !cfg.is_null() && !cfg.is_object() {
        bail!("eastmoneyReports must be an object");
    }
    let output = configured_path(
        &state.root,
        cfg,
        "outputDir",
        &Path::new(SHARED_DATA).join("reports"),
    );
    let state_dir = configured_path(
        &state.root,
        config,
        "stateDir",
        &Path::new(SHARED_DATA).join("stock-info/knowledge/state"),
    );
    let state_file = configured_path(
        &state_dir,
        cfg,
        "stateFile",
        Path::new("eastmoney-report-fetch-state.json"),
    );
    let path = state_file.clone();
    let previous = tokio::task::spawn_blocking(move || load_state(&path)).await?;
    let range = resolve_range(cfg, config, &previous, now)?;
    let defaults = json!([{"value":"0","reportType":"company_report"},{"value":"1","reportType":"industry_report"}]);
    let qtypes = cfg
        .get("qTypes")
        .filter(|v| !v.is_null())
        .unwrap_or(&defaults)
        .as_array()
        .context("eastmoneyReports.qTypes must be an array")?;
    let pages = integer(cfg.get("pages"), 3);
    let page_size = integer(cfg.get("pageSize"), 100);
    let mut docs = Vec::new();
    let mut seen = HashSet::new();
    for qtype in qtypes {
        if !qtype.is_object() {
            bail!("report qType must be an object");
        }
        let qtype_value = text(&qtype["value"]);
        if qtype_value.is_empty() {
            bail!("report qType value is required");
        }
        let report_type = text(&qtype["reportType"]);
        let report_type = if report_type.is_empty() {
            "research_report"
        } else {
            &report_type
        };
        for page in 1..=pages {
            let mut url = Url::parse("https://reportapi.eastmoney.com/report/list")?;
            url.query_pairs_mut().extend_pairs([
                ("cb", "jQuery"),
                ("industryCode", "*"),
                ("pageSize", &page_size.to_string()),
                ("industry", "*"),
                ("rating", "*"),
                ("ratingChange", "*"),
                ("beginTime", range.begin_time.as_str()),
                ("endTime", range.end_time.as_str()),
                ("pageNo", &page.to_string()),
                ("fields", ""),
                ("qType", qtype_value.as_str()),
                ("orgCode", ""),
                ("code", "*"),
                ("rcode", ""),
                ("_", &Utc::now().timestamp_millis().to_string()),
            ]);
            let response = request(url.into())
                .await
                .context("Eastmoney report list request failed")?;
            let empty = Vec::new();
            let items = response["data"].as_array().unwrap_or(&empty);
            for item in items {
                let doc = map_report(item, report_type, now);
                if let Some(id) = doc["docId"].as_str().filter(|id| !id.is_empty())
                    && seen.insert(id.to_string())
                {
                    docs.push(doc);
                }
            }
            if (items.len() as i64) < page_size {
                break;
            }
        }
    }
    // The original filename used toISOString(), i.e. UTC, while the request
    // range used the launcher's local calendar. Preserve both distinct bases.
    let file = output.join(format!("eastmoney-reports-{}.jsonl", now.format("%Y%m%d")));
    let mut next = previous;
    next["lastBeginTime"] = json!(range.begin_time);
    next["lastEndTime"] = json!(range.end_time);
    next["lastFetchedAt"] = json!(now.to_rfc3339_opts(SecondsFormat::Millis, true));
    next["lastFetchedDocs"] = json!(docs.len());
    let summary = json!({"source":SOURCE,"output":file,"fetched":docs.len(),"beginTime":range.begin_time,"endTime":range.end_time,"rangeMode":range.mode,"stateFile":state_file});
    tokio::task::spawn_blocking(move || -> Result<()> {
        fs::create_dir_all(output)?;
        fs::create_dir_all(state_dir)?;
        if !docs.is_empty() {
            let mut bytes = Vec::new();
            for doc in docs {
                serde_json::to_writer(&mut bytes, &doc)?;
                bytes.push(b'\n');
            }
            atomic_write(&file, &bytes)?;
        }
        let mut bytes = serde_json::to_vec_pretty(&next)?;
        bytes.push(b'\n');
        atomic_write(&state_file, &bytes)?;
        Ok(())
    })
    .await??;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn instant(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }
    #[test]
    fn range_preserves_explicit_resume_floor_overlap_and_shanghai_calendar() {
        let now = instant("2026-10-29T16:30:00Z");
        assert_eq!(
            resolve_range(&json!({}), &json!({}), &json!({}), now).unwrap(),
            FetchRange {
                begin_time: "2026-08-31".into(),
                end_time: "2026-10-30".into(),
                mode: "lookback"
            }
        );
        assert_eq!(
            resolve_range(
                &json!({"beginTime":"2026-09-01","endTime":"2026-10-29"}),
                &json!({}),
                &json!({"lastEndTime":"2026-10-28"}),
                now
            )
            .unwrap()
            .begin_time,
            "2026-09-01"
        );
        let resumed = resolve_range(
            &json!({"lookbackDays":10,"overlapDays":2}),
            &json!({}),
            &json!({"lastEndTime":"2026-10-29"}),
            now,
        )
        .unwrap();
        assert_eq!(resumed.begin_time, "2026-10-27");
        assert_eq!(resumed.mode, "resume");
        assert_eq!(
            resolve_range(
                &json!({"lookbackDays":10}),
                &json!({}),
                &json!({"lastEndTime":"2020-01-01"}),
                now
            )
            .unwrap()
            .begin_time,
            "2026-10-20"
        );
        assert!(local_date(&json!("2026-02-30")).is_none());
        assert!(local_date(&json!("2026-2-03")).is_none());
        assert!(local_date(&json!("0099-01-01")).is_none());
        assert_eq!(
            resolve_range(
                &json!({"lookbackDays":null,"overlapDays":-5}),
                &json!({"maxReportAgeDays":10}),
                &json!({"lastEndTime":"2026-10-29"}),
                now
            )
            .unwrap()
            .begin_time,
            "2026-10-28"
        );
        assert_eq!(
            resolve_range(
                &json!({"lookbackDays":null}),
                &json!({"maxReportAgeDays":10}),
                &json!({}),
                now
            )
            .unwrap()
            .begin_time,
            "2026-10-20"
        );
    }
    #[test]
    fn report_mapping_retains_source_carrier_and_stable_identity() {
        let item = json!({"infoCode":"AP20261029000001","title":" 公司增长 ","stockCode":"600036","stockName":"招商银行","orgSName":"机构","indvInduName":"银行","publishDate":"2026-10-29 13:20:00","attachPages":20});
        let doc = map_report(&item, "company_report", instant("2026-10-29T05:20:00Z"));
        assert_eq!(doc["targetCode"], "600036.SH");
        assert_eq!(doc["publishedAt"], "2026-10-29");
        assert_eq!(doc["fetchedAt"], "2026-10-29T05:20:00.000Z");
        assert_eq!(
            doc["metadata"]["researchForecastEvidence"]["carrierRelation"],
            "republication"
        );
        assert_eq!(doc["metadata"]["raw"], item);
        assert_eq!(doc["tags"], json!(["pdf", "公司研报", "银行"]));
        assert_eq!(doc["docId"].as_str().unwrap().len(), 26);
        assert_eq!(
            map_report(&item, "industry_report", instant("2020-01-01T00:00:00Z"))["docId"],
            doc["docId"]
        );
        assert_eq!(
            map_report(&json!({}), "research_report", Utc::now())["docId"],
            ""
        );
    }
    fn state(directory: &tempfile::TempDir) -> AppState {
        AppState::new(
            crate::db::Database::open(directory.path().join("test.sqlite")).unwrap(),
            directory.path().to_path_buf(),
            "127.0.0.1:18000".into(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn disabled_does_not_fetch_or_create_workflow_files() {
        let root = tempfile::tempdir().unwrap();
        let state = state(&root);
        let output = fetch_with(
            &state,
            &json!({"eastmoneyReports":{"enabled":false}}),
            Utc::now(),
            |_| async { panic!("disabled discovery requested a provider") },
        )
        .await
        .unwrap();
        assert_eq!(
            output,
            json!({"source":"eastmoney_reports","skipped":true,"reason":"disabled"})
        );
        assert!(!root.path().join("reports").exists());
    }
    #[tokio::test]
    async fn pages_dedupe_and_atomic_state_keep_metadata_without_silent_failure() {
        let root = tempfile::tempdir().unwrap();
        let state = state(&root);
        fs::create_dir(root.path().join("state")).unwrap();
        fs::write(
            root.path().join("state/eastmoney-report-fetch-state.json"),
            json!({"lastEndTime":"2026-10-28","privateRetainedField":"retain"}).to_string(),
        )
        .unwrap();
        let cfg = json!({"stateDir":"state","eastmoneyReports":{"outputDir":"reports","pageSize":1,"pages":2,"endTime":"2026-10-29"}});
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = requests.clone();
        let output=fetch_with(&state,&cfg,instant("2026-10-29T16:30:00Z"),move|url|{captured.lock().unwrap().push(url);async{Ok(json!({"data":[{"infoCode":"AP20261029000001","title":"报告","stockCode":"000001"}]}))}}).await.unwrap();
        assert_eq!(output["fetched"], 1);
        assert_eq!(requests.lock().unwrap().len(), 4);
        let body = fs::read_to_string(root.path().join("reports/eastmoney-reports-20261029.jsonl"))
            .unwrap();
        assert_eq!(body.lines().count(), 1);
        let next = load_state(&root.path().join("state/eastmoney-report-fetch-state.json"));
        assert_eq!(next["privateRetainedField"], "retain");
        assert_eq!(next["lastFetchedDocs"], 1);
        assert_eq!(next["lastBeginTime"], "2026-10-27");
        let before = fs::read(root.path().join("state/eastmoney-report-fetch-state.json")).unwrap();
        assert!(
            fetch_with(&state, &cfg, Utc::now(), |_| async {
                bail!("rejected upstream")
            })
            .await
            .is_err()
        );
        assert_eq!(
            fs::read(root.path().join("state/eastmoney-report-fetch-state.json")).unwrap(),
            before
        );
        assert!(
            !fs::read_dir(root.path().join("state"))
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp"))
        );
    }

    #[tokio::test]
    async fn short_pages_stop_and_empty_results_preserve_existing_inbox() {
        let root = tempfile::tempdir().unwrap();
        let state = state(&root);
        fs::create_dir(root.path().join("reports")).unwrap();
        let inbox = root.path().join("reports/eastmoney-reports-20261029.jsonl");
        fs::write(&inbox, "existing unread documents\n").unwrap();
        let cfg = json!({"stateDir":"state","eastmoneyReports":{"outputDir":"reports","pageSize":100,"pages":10}});
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        let output = fetch_with(&state, &cfg, instant("2026-10-29T00:00:00Z"), move |_| {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok(json!({"data":[]})) }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(output["fetched"], 0);
        assert_eq!(
            fs::read_to_string(inbox).unwrap(),
            "existing unread documents\n"
        );
        assert_eq!(
            load_state(&root.path().join("state/eastmoney-report-fetch-state.json"))["lastFetchedDocs"],
            0
        );
    }
}
