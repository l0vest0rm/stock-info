//! Durable, bounded provisional-financial ingestion. The state and snapshot
//! shapes intentionally remain readable by the transitional local runtime.
use super::providers::{ensure_metadata, merge_provisional};
use crate::{AppState, cache_policy, codes, db::Database, http::number};
use anyhow::{Context, Result};
use chrono::{Duration, NaiveDate, Utc};
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    pin::Pin,
};

const STATE_NAMESPACE: &str = "sync_state";
const STATE_KEY: &str = "financial-provisional";
const PAGE_SIZE: usize = 50;
const DEFAULT_BOOTSTRAP_PAGES: usize = 25;
const WRITE_CONCURRENCY: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Source {
    PerformanceReport,
    PerformanceForecast,
}

impl Source {
    fn key(self) -> &'static str {
        match self {
            Self::PerformanceReport => "performance_report",
            Self::PerformanceForecast => "performance_forecast",
        }
    }
    fn disclosure_fields(self) -> [&'static str; 2] {
        match self {
            Self::PerformanceReport => ["UPDATE_DATE", "NOTICE_DATE"],
            Self::PerformanceForecast => ["NOTICE_DATE", "UPDATE_DATE"],
        }
    }
    fn row_key(self, row: &Value) -> String {
        let code = js_string(coalesce(&row["SECUCODE"], &row["SECURITY_CODE"]));
        match self {
            Self::PerformanceReport => code,
            Self::PerformanceForecast => {
                format!("{code}:{}", js_string(&row["PREDICT_FINANCE_CODE"]))
            }
        }
    }
    fn accepts(self, row: &Value) -> bool {
        self == Self::PerformanceReport || js_string(&row["IS_LATEST"]) != "F"
    }
}

#[derive(Clone, Debug)]
struct DataPage {
    rows: Vec<Value>,
    pages: usize,
}

type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<DataPage>> + Send + 'a>>;
trait PageFetcher: Sync {
    fn fetch<'a>(
        &'a self,
        state: &'a AppState,
        source: Source,
        report_date: &'a str,
        page: usize,
    ) -> FetchFuture<'a>;
}
struct Provider;
impl PageFetcher for Provider {
    fn fetch<'a>(
        &'a self,
        state: &'a AppState,
        source: Source,
        report_date: &'a str,
        page: usize,
    ) -> FetchFuture<'a> {
        Box::pin(async move {
            let (report, filter, sort) = match source {
                Source::PerformanceReport => (
                    "RPT_FCI_PERFORMANCEE",
                    format!(
                        "(SECURITY_TYPE_CODE in (\"058001001\",\"058001008\"))(TRADE_MARKET_CODE!=\"069001017\")(REPORT_DATE='{report_date}')"
                    ),
                    "UPDATE_DATE,SECURITY_CODE",
                ),
                Source::PerformanceForecast => (
                    "RPT_PUBLIC_OP_NEWPREDICT",
                    format!("(REPORT_DATE='{report_date}')"),
                    "NOTICE_DATE,SECURITY_CODE",
                ),
            };
            let mut url = Url::parse("https://datacenter-web.eastmoney.com/api/data/v1/get")?;
            url.query_pairs_mut().extend_pairs([
                ("reportName", report),
                ("columns", "ALL"),
                ("filter", &filter),
                ("pageNumber", &page.to_string()),
                ("pageSize", &PAGE_SIZE.to_string()),
                ("sortTypes", "-1,-1"),
                ("sortColumns", sort),
            ]);
            let mut headers = HeaderMap::new();
            headers.insert(
                REFERER,
                HeaderValue::from_static("https://emweb.securities.eastmoney.com/"),
            );
            let body = state
                .http
                .cached_json(&state.db, url.as_str(), headers, 600_000, false)
                .await?;
            let pages = number(&body["result"]["pages"])
                .filter(|n| *n >= 1.0 && n.fract() == 0.0 && *n <= usize::MAX as f64)
                .map(|n| n as usize)
                .unwrap_or(1);
            Ok(DataPage {
                rows: body["result"]["data"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                pages,
            })
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    schema_version: usize,
    report_date: String,
    bootstrap_next_page: usize,
    bootstrap_complete: bool,
    bootstrap_max_disclosure_date: Option<String>,
    watermark_date: Option<String>,
}
impl Checkpoint {
    fn empty(report_date: &str) -> Self {
        Self {
            schema_version: 2,
            report_date: report_date.into(),
            bootstrap_next_page: 1,
            bootstrap_complete: false,
            bootstrap_max_disclosure_date: None,
            watermark_date: None,
        }
    }
    fn normalize(value: Option<&Value>, report_date: &str) -> Self {
        let Some(value) =
            value.filter(|value| value.is_object() && value["reportDate"] == report_date)
        else {
            return Self::empty(report_date);
        };
        let next = coalesce(
            &value["bootstrapNextPage"],
            coalesce(&value["backfillNextPage"], &value["nextPage"]),
        );
        Self {
            schema_version: 2,
            report_date: report_date.into(),
            bootstrap_next_page: number(next)
                .filter(|n| *n >= 1.0 && n.fract() == 0.0 && *n <= usize::MAX as f64)
                .map(|n| n as usize)
                .unwrap_or(1),
            bootstrap_complete: value["bootstrapComplete"] == true
                || value["backfillComplete"] == true,
            bootstrap_max_disclosure_date: nonempty_date(&value["bootstrapMaxDisclosureDate"]),
            watermark_date: nonempty_date(&value["watermarkDate"]),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceStats {
    phase: &'static str,
    pages_fetched: usize,
    bootstrap_pages_processed: usize,
    incremental_pages_processed: usize,
    rows_read: usize,
    incremental_rows_read: usize,
    stop_date: Option<String>,
    watermark_before: Option<String>,
    watermark_after: Option<String>,
    watermark_advanced: bool,
    bootstrap_complete: bool,
}
impl Default for SourceStats {
    fn default() -> Self {
        Self {
            phase: "bootstrap",
            pages_fetched: 0,
            bootstrap_pages_processed: 0,
            incremental_pages_processed: 0,
            rows_read: 0,
            incremental_rows_read: 0,
            stop_date: None,
            watermark_before: None,
            watermark_after: None,
            watermark_advanced: false,
            bootstrap_complete: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    report_date: String,
    pages_fetched: usize,
    latest_pages_changed: usize,
    latest_pages_unchanged: usize,
    backfill_pages_processed: usize,
    rows_read: usize,
    companies_seen: usize,
    snapshots_updated: usize,
    snapshots_initialized: usize,
    formal_rows_protected: usize,
    bootstrap_pages_processed: usize,
    incremental_pages_processed: usize,
    incremental_rows_read: usize,
    incremental_cycles_completed: usize,
    incremental_cycles_failed: usize,
    watermarks_advanced: usize,
    source_stats: HashMap<&'static str, SourceStats>,
}
impl Stats {
    fn empty(report_date: &str) -> Self {
        Self {
            report_date: report_date.into(),
            pages_fetched: 0,
            latest_pages_changed: 0,
            latest_pages_unchanged: 0,
            backfill_pages_processed: 0,
            rows_read: 0,
            companies_seen: 0,
            snapshots_updated: 0,
            snapshots_initialized: 0,
            formal_rows_protected: 0,
            bootstrap_pages_processed: 0,
            incremental_pages_processed: 0,
            incremental_rows_read: 0,
            incremental_cycles_completed: 0,
            incremental_cycles_failed: 0,
            watermarks_advanced: 0,
            source_stats: HashMap::from([
                ("performance_report", SourceStats::default()),
                ("performance_forecast", SourceStats::default()),
            ]),
        }
    }
    fn source(&mut self, source: Source) -> &mut SourceStats {
        self.source_stats
            .get_mut(source.key())
            .expect("both source stats initialized")
    }
    fn fetched(&mut self, source: Source) {
        self.pages_fetched += 1;
        self.source(source).pages_fetched += 1;
    }
    fn bootstrapped(&mut self, source: Source) {
        self.bootstrap_pages_processed += 1;
        self.backfill_pages_processed += 1;
        self.source(source).bootstrap_pages_processed += 1;
    }
}

/// Both sources share the persisted v2 state, but each has its own resumable
/// checkpoint. A bootstrap transitions to incremental only on the next run.
pub async fn sync_provisional(state: &AppState, scheduled_ms: i64) -> Result<Value> {
    sync_with_fetcher(state, scheduled_ms, &Provider, DEFAULT_BOOTSTRAP_PAGES).await
}

async fn sync_with_fetcher<F: PageFetcher>(
    state: &AppState,
    scheduled_ms: i64,
    fetcher: &F,
    max_bootstrap_pages: usize,
) -> Result<Value> {
    let report_date = cache_policy::latest_completed_quarter(scheduled_ms);
    let started_at = Utc::now().timestamp_millis();
    let mut stats = Stats::empty(&report_date);
    write_status(&state.db, "running", started_at, None, &stats, None).await?;
    let result = async {
        sync_source(
            state,
            Source::PerformanceReport,
            &report_date,
            &mut stats,
            fetcher,
            max_bootstrap_pages.max(1),
        )
        .await?;
        sync_source(
            state,
            Source::PerformanceForecast,
            &report_date,
            &mut stats,
            fetcher,
            max_bootstrap_pages.max(1),
        )
        .await?;
        Result::<()>::Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            write_status(
                &state.db,
                "succeeded",
                started_at,
                Some(Utc::now().timestamp_millis()),
                &stats,
                None,
            )
            .await?;
            Ok(serde_json::to_value(stats)?)
        }
        Err(error) => {
            write_status(
                &state.db,
                "failed",
                started_at,
                Some(Utc::now().timestamp_millis()),
                &stats,
                Some(error.to_string()),
            )
            .await?;
            Err(error)
        }
    }
}

async fn sync_source<F: PageFetcher>(
    state: &AppState,
    source: Source,
    report_date: &str,
    stats: &mut Stats,
    fetcher: &F,
    max_pages: usize,
) -> Result<()> {
    let financial_state = read_state(&state.db).await?;
    let key = format!("{report_date}:{}", source.key());
    let checkpoint = Checkpoint::normalize(financial_state["checkpoints"].get(&key), report_date);
    stats.source(source).bootstrap_complete = checkpoint.bootstrap_complete;
    if checkpoint.bootstrap_complete {
        stats.source(source).phase = "incremental";
        incremental(state, source, checkpoint, report_date, stats, fetcher).await
    } else {
        let checkpoint = bootstrap(
            state,
            source,
            checkpoint,
            report_date,
            stats,
            fetcher,
            max_pages,
        )
        .await?;
        stats.source(source).bootstrap_complete = checkpoint.bootstrap_complete;
        Ok(())
    }
}

async fn bootstrap<F: PageFetcher>(
    state: &AppState,
    source: Source,
    mut checkpoint: Checkpoint,
    report_date: &str,
    stats: &mut Stats,
    fetcher: &F,
    max_pages: usize,
) -> Result<Checkpoint> {
    let first = fetcher.fetch(state, source, report_date, 1).await?;
    stats.fetched(source);
    let mut total_pages = first.pages.max(1);
    let mut next_page = checkpoint
        .bootstrap_next_page
        .min(total_pages.saturating_add(1))
        .max(1);
    let mut processed = 0;
    if next_page == 1 {
        process_rows(state, source, report_date, first.rows.clone(), stats).await?;
        stats.bootstrapped(source);
        processed += 1;
        checkpoint.bootstrap_next_page = 2;
        checkpoint.bootstrap_max_disclosure_date = max_date(
            checkpoint.bootstrap_max_disclosure_date,
            max_disclosure(source, &first.rows),
        );
        write_checkpoint(&state.db, source, report_date, &checkpoint).await?;
        next_page = 2;
    }
    while next_page <= total_pages && processed < max_pages {
        let page = fetcher.fetch(state, source, report_date, next_page).await?;
        stats.fetched(source);
        total_pages = total_pages.max(page.pages.max(1));
        process_rows(state, source, report_date, page.rows.clone(), stats).await?;
        stats.bootstrapped(source);
        processed += 1;
        checkpoint.bootstrap_next_page = next_page.saturating_add(1);
        checkpoint.bootstrap_max_disclosure_date = max_date(
            checkpoint.bootstrap_max_disclosure_date,
            max_disclosure(source, &page.rows),
        );
        write_checkpoint(&state.db, source, report_date, &checkpoint).await?;
        next_page = next_page.saturating_add(1);
    }
    if next_page > total_pages {
        checkpoint.bootstrap_next_page = next_page;
        checkpoint.bootstrap_complete = true;
        checkpoint.watermark_date = checkpoint.bootstrap_max_disclosure_date.clone();
        write_checkpoint(&state.db, source, report_date, &checkpoint).await?;
    }
    Ok(checkpoint)
}

async fn incremental<F: PageFetcher>(
    state: &AppState,
    source: Source,
    mut checkpoint: Checkpoint,
    report_date: &str,
    stats: &mut Stats,
    fetcher: &F,
) -> Result<()> {
    let watermark_before = checkpoint.watermark_date.clone();
    let stop_date = watermark_before
        .as_deref()
        .map(|date| {
            NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .context("invalid financial disclosure watermark")
                .map(|date| (date - Duration::days(2)).to_string())
        })
        .transpose()?;
    stats.source(source).watermark_before = watermark_before.clone();
    stats.source(source).stop_date = stop_date.clone();
    let mut page_number = 1;
    let mut total_pages = 1;
    let mut crossed = false;
    let mut rows = Vec::new();
    let mut newest_date = None;
    while page_number <= total_pages {
        let page = fetcher
            .fetch(state, source, report_date, page_number)
            .await?;
        stats.fetched(source);
        stats.incremental_pages_processed += 1;
        stats.source(source).incremental_pages_processed += 1;
        total_pages = total_pages.max(page.pages.max(1));
        let empty = page.rows.is_empty();
        let mut page_crossed = false;
        for row in page.rows {
            let date = disclosure_date(source, &row);
            if date
                .as_ref()
                .zip(stop_date.as_ref())
                .is_some_and(|(date, stop)| date < stop)
            {
                page_crossed = true;
                continue;
            }
            newest_date = max_date(newest_date, date);
            rows.push(row);
        }
        if page_crossed || empty || page_number >= total_pages {
            crossed = true;
            break;
        }
        page_number = page_number.saturating_add(1);
    }
    if !crossed {
        stats.incremental_cycles_failed += 1;
        return Ok(());
    }
    let row_count = rows.len();
    process_rows(state, source, report_date, rows, stats).await?;
    stats.incremental_rows_read += row_count;
    stats.source(source).incremental_rows_read += row_count;
    let watermark_after = max_date(watermark_before.clone(), newest_date);
    let advanced = watermark_after != watermark_before;
    checkpoint.watermark_date = watermark_after.clone();
    write_checkpoint(&state.db, source, report_date, &checkpoint).await?;
    stats.source(source).watermark_after = watermark_after;
    stats.source(source).watermark_advanced = advanced;
    if advanced {
        stats.watermarks_advanced += 1;
    }
    stats.incremental_cycles_completed += 1;
    Ok(())
}

async fn process_rows(
    state: &AppState,
    source: Source,
    report_date: &str,
    incoming: Vec<Value>,
    stats: &mut Stats,
) -> Result<()> {
    let rows = dedupe(incoming, source);
    stats.rows_read += rows.len();
    stats.source(source).rows_read += rows.len();
    let mut by_code: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for row in rows {
        let code = codes::normalize(&js_string(coalesce(
            &row["SECUCODE"],
            &row["SECURITY_CODE"],
        )));
        if ![".SH", ".SZ", ".BJ"]
            .iter()
            .any(|suffix| code.ends_with(suffix))
        {
            continue;
        }
        by_code.entry(code).or_default().push(row);
    }
    stats.companies_seen += by_code.len();
    let mut entries = by_code.into_iter();
    loop {
        let mut jobs = tokio::task::JoinSet::new();
        for _ in 0..WRITE_CONCURRENCY {
            let Some((code, company_rows)) = entries.next() else {
                break;
            };
            let state = state.clone();
            let report_date = report_date.to_string();
            jobs.spawn(async move {
                write_company(&state, source, &report_date, &code, company_rows).await
            });
        }
        if jobs.is_empty() {
            break;
        }
        let mut first_error = None;
        while let Some(result) = jobs.join_next().await {
            match result {
                Ok(Ok(CompanyWrite::FormalProtected)) => stats.formal_rows_protected += 1,
                Ok(Ok(CompanyWrite::Updated { initialized })) => {
                    stats.snapshots_updated += 1;
                    if initialized {
                        stats.snapshots_initialized += 1;
                    }
                }
                Ok(Err(error)) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error.into());
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
    }
    Ok(())
}

enum CompanyWrite {
    FormalProtected,
    Updated { initialized: bool },
}
async fn write_company(
    state: &AppState,
    source: Source,
    report_date: &str,
    code: &str,
    incoming: Vec<Value>,
) -> Result<CompanyWrite> {
    let store = state.market_store()?;
    let key = format!("financial-statements/income/{code}.json");
    let snapshot = store.get_json(&key).await?;
    let existing = ensure_metadata(
        &snapshot
            .as_ref()
            .and_then(|value| value["rows"].as_array())
            .cloned()
            .unwrap_or_default(),
    );
    let existing_quarter = existing.iter().find(|row| row["reportDate"] == report_date);
    if existing_quarter.is_some_and(|row| row["payload"]["dataSource"] == "financial_report") {
        return Ok(CompanyWrite::FormalProtected);
    }
    let now = Utc::now().timestamp_millis();
    let provisional = merge_stored_provisional(
        snapshot.as_ref().map(|value| &value["provisionalData"]),
        source,
        report_date,
        incoming,
        now,
    );
    let performance = provisional["performanceRows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let forecast = provisional["forecastRows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let merged = merge_provisional(&existing, &performance, &forecast, now);
    let rows = if merged.iter().any(|row| row["reportDate"] == report_date) {
        merged
    } else {
        existing
    };
    let updated_at = rows
        .first()
        .and_then(|row| row["updatedAt"].as_i64())
        .unwrap_or(now);
    let origin = rows
        .first()
        .and_then(|row| row["source"].as_str())
        .unwrap_or("eastmoney");
    store.put_json(&key, &json!({"code":code,"statementType":"income","source":origin,"updatedAt":updated_at,
        "reportDates": rows.iter().map(|row|row["reportDate"].clone()).collect::<Vec<_>>(),"rows":rows,"provisionalData":provisional})).await?;
    Ok(CompanyWrite::Updated {
        initialized: snapshot.is_none(),
    })
}

fn merge_stored_provisional(
    existing: Option<&Value>,
    source: Source,
    report_date: &str,
    incoming: Vec<Value>,
    now: i64,
) -> Value {
    let current = existing.filter(|value| value["reportDate"] == report_date);
    let mut performance = current
        .and_then(|value| value["performanceRows"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut forecast = current
        .and_then(|value| value["forecastRows"].as_array())
        .cloned()
        .unwrap_or_default();
    match source {
        Source::PerformanceReport => {
            let mut combined = incoming;
            combined.extend(performance);
            performance = dedupe(combined, source);
        }
        Source::PerformanceForecast => {
            let mut combined = incoming;
            combined.extend(forecast);
            forecast = dedupe(combined, source);
        }
    }
    json!({"reportDate":report_date,"performanceRows":performance,"forecastRows":forecast,"updatedAt":now})
}

fn dedupe(rows: Vec<Value>, source: Source) -> Vec<Value> {
    let mut seen = HashSet::new();
    rows.into_iter()
        .filter(|row| source.accepts(row) && seen.insert(source.row_key(row)))
        .collect()
}
fn disclosure_date(source: Source, row: &Value) -> Option<String> {
    source
        .disclosure_fields()
        .iter()
        .find_map(|field| nonempty_date(&row[field]))
}
fn max_disclosure(source: Source, rows: &[Value]) -> Option<String> {
    rows.iter()
        .filter_map(|row| disclosure_date(source, row))
        .max()
}
fn max_date(left: Option<String>, right: Option<String>) -> Option<String> {
    left.into_iter()
        .chain(right)
        .filter(|date| !date.is_empty())
        .max()
}
fn nonempty_date(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|s| s.chars().take(10).collect::<String>())
        .filter(|s| !s.is_empty())
}
fn coalesce<'a>(first: &'a Value, second: &'a Value) -> &'a Value {
    if first.is_null() { second } else { first }
}
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        value => value.to_string(),
    }
}
fn empty_state() -> Value {
    json!({"status":"idle","startedAt":null,"finishedAt":null,"error":null,"stats":null,"checkpoints":{}})
}

async fn read_state(db: &Database) -> Result<Value> {
    let rows = db.query("SELECT value_json FROM kv_cache WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)",vec![STATE_NAMESPACE.into(),STATE_KEY.into(),Utc::now().timestamp_millis().into()]).await?;
    let mut value = rows
        .first()
        .and_then(|row| row["value_json"].as_str())
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(empty_state);
    if !["idle", "running", "succeeded", "failed"]
        .iter()
        .any(|status| value["status"] == *status)
    {
        value["status"] = json!("idle");
    }
    for field in ["startedAt", "finishedAt"] {
        if !value[field].is_number() {
            value[field] = Value::Null;
        }
    }
    if !value["error"].is_string() {
        value["error"] = Value::Null;
    }
    if !value["stats"].is_object() {
        value["stats"] = Value::Null;
    }
    if !value["checkpoints"].is_object() {
        value["checkpoints"] = json!({});
    }
    Ok(value)
}
async fn write_checkpoint(
    db: &Database,
    source: Source,
    report_date: &str,
    checkpoint: &Checkpoint,
) -> Result<()> {
    let mut value = read_state(db).await?;
    value["checkpoints"][format!("{report_date}:{}", source.key())] =
        serde_json::to_value(checkpoint)?;
    db.put_kv(STATE_NAMESPACE, STATE_KEY, &value, None).await
}
async fn write_status(
    db: &Database,
    status: &str,
    started_at: i64,
    finished_at: Option<i64>,
    stats: &Stats,
    error: Option<String>,
) -> Result<()> {
    let mut value = read_state(db).await?;
    value["status"] = json!(status);
    value["startedAt"] = json!(started_at);
    value["finishedAt"] = json!(finished_at);
    value["error"] = json!(error);
    value["stats"] = serde_json::to_value(stats)?;
    db.put_kv(STATE_NAMESPACE, STATE_KEY, &value, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fixture {
        pages: HashMap<(Source, usize), DataPage>,
        calls: Mutex<Vec<(Source, usize)>>,
        fail: Option<(Source, usize)>,
    }
    impl PageFetcher for Fixture {
        fn fetch<'a>(
            &'a self,
            _state: &'a AppState,
            source: Source,
            _report: &'a str,
            page: usize,
        ) -> FetchFuture<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push((source, page));
                if self.fail == Some((source, page)) {
                    anyhow::bail!("fixture provider failure");
                }
                Ok(self
                    .pages
                    .get(&(source, page))
                    .cloned()
                    .unwrap_or(DataPage {
                        rows: vec![],
                        pages: 1,
                    }))
            })
        }
    }
    fn state() -> (tempfile::TempDir, AppState) {
        // AppState intentionally honors the caller's real object directories.
        // Fixture tests must fail before constructing a store if those paths
        // are exported, rather than accidentally writing a real snapshot.
        for key in ["LOCAL_DATA_DIR", "LOCAL_MARKET_DATA_DIR"] {
            assert!(
                std::env::var_os(key).is_none_or(|value| value.is_empty()),
                "unset {key} before running isolated financial sync fixtures"
            );
        }
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(root.path().join("stock-info.sqlite")).unwrap();
        db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let state = AppState::new(db, root.path().to_path_buf(), "127.0.0.1:18000".into()).unwrap();
        (root, state)
    }
    fn timestamp() -> i64 {
        chrono::DateTime::parse_from_rfc3339("2026-10-29T00:00:00Z")
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn checkpoint_compatibility_and_raw_source_merge() {
        let checkpoint = Checkpoint::normalize(
            Some(
                &json!({"reportDate":"2026-09-30","backfillNextPage":3,"backfillComplete":true,"watermarkDate":"2026-10-20T01:00:00Z"}),
            ),
            "2026-09-30",
        );
        assert_eq!(checkpoint.schema_version, 2);
        assert_eq!(checkpoint.bootstrap_next_page, 3);
        assert!(checkpoint.bootstrap_complete);
        assert_eq!(checkpoint.watermark_date.as_deref(), Some("2026-10-20"));
        assert_eq!(
            Checkpoint::normalize(
                Some(&json!({"reportDate":"2026-06-30","nextPage":9})),
                "2026-09-30"
            )
            .bootstrap_next_page,
            1
        );
        let existing = json!({"reportDate":"2026-09-30","performanceRows":[{"SECUCODE":"600036.SH","v":1}],"forecastRows":[{"SECUCODE":"600036.SH","PREDICT_FINANCE_CODE":"004","v":3}]});
        let merged = merge_stored_provisional(
            Some(&existing),
            Source::PerformanceReport,
            "2026-09-30",
            vec![json!({"SECUCODE":"600036.SH","v":2})],
            1,
        );
        assert_eq!(merged["performanceRows"][0]["v"], 2);
        assert_eq!(merged["forecastRows"][0]["v"], 3);
        assert!(dedupe(vec![json!({"IS_LATEST":"F"})], Source::PerformanceForecast).is_empty());
    }

    #[tokio::test]
    async fn bounded_bootstrap_resumes_then_incremental_advances_watermark() {
        let (_root, state) = state();
        let fixture = Fixture {
            pages: HashMap::from([
                (
                    (Source::PerformanceReport, 1),
                    DataPage {
                        pages: 3,
                        rows: vec![json!({"SECUCODE":"not-supported","UPDATE_DATE":"2026-10-21"})],
                    },
                ),
                (
                    (Source::PerformanceReport, 2),
                    DataPage {
                        pages: 3,
                        rows: vec![
                            json!({"SECUCODE":"not-supported-2","UPDATE_DATE":"2026-10-20"}),
                        ],
                    },
                ),
                (
                    (Source::PerformanceReport, 3),
                    DataPage {
                        pages: 3,
                        rows: vec![
                            json!({"SECUCODE":"not-supported-3","UPDATE_DATE":"2026-10-19"}),
                        ],
                    },
                ),
            ]),
            ..Default::default()
        };
        let stats = sync_with_fetcher(&state, timestamp(), &fixture, 1)
            .await
            .unwrap();
        assert_eq!(
            stats["sourceStats"]["performance_report"]["bootstrapComplete"],
            false
        );
        assert_eq!(
            read_state(&state.db).await.unwrap()["checkpoints"]["2026-09-30:performance_report"]["bootstrapNextPage"],
            2
        );
        fixture.calls.lock().unwrap().clear();
        sync_with_fetcher(&state, timestamp(), &fixture, 1)
            .await
            .unwrap();
        assert_eq!(
            fixture
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(source, _)| *source == Source::PerformanceReport)
                .copied()
                .collect::<Vec<_>>(),
            vec![
                (Source::PerformanceReport, 1),
                (Source::PerformanceReport, 2)
            ]
        );
        let stats = sync_with_fetcher(&state, timestamp(), &fixture, 1)
            .await
            .unwrap();
        assert_eq!(
            stats["sourceStats"]["performance_report"]["bootstrapComplete"],
            true
        );
        assert_eq!(
            read_state(&state.db).await.unwrap()["checkpoints"]["2026-09-30:performance_report"]["watermarkDate"],
            "2026-10-21"
        );
        let incremental = Fixture {
            pages: HashMap::from([(
                (Source::PerformanceReport, 1),
                DataPage {
                    pages: 2,
                    rows: vec![
                        json!({"SECUCODE":"new","UPDATE_DATE":"2026-10-23"}),
                        json!({"SECUCODE":"too-old","UPDATE_DATE":"2026-10-18"}),
                    ],
                },
            )]),
            ..Default::default()
        };
        let stats = sync_with_fetcher(&state, timestamp(), &incremental, 1)
            .await
            .unwrap();
        assert_eq!(
            stats["sourceStats"]["performance_report"]["phase"],
            "incremental"
        );
        assert_eq!(
            stats["sourceStats"]["performance_report"]["stopDate"],
            "2026-10-19"
        );
        assert_eq!(
            stats["sourceStats"]["performance_report"]["incrementalRowsRead"],
            1
        );
        assert_eq!(
            stats["sourceStats"]["performance_report"]["watermarkAfter"],
            "2026-10-23"
        );
        assert_eq!(stats["watermarksAdvanced"], 1);
        assert!(
            !incremental
                .calls
                .lock()
                .unwrap()
                .contains(&(Source::PerformanceReport, 2))
        );
        let stored = state
            .db
            .query(
                "SELECT expires_at FROM kv_cache WHERE namespace=? AND key=?",
                vec![STATE_NAMESPACE.into(), STATE_KEY.into()],
            )
            .await
            .unwrap();
        assert!(stored[0]["expires_at"].is_null());
    }

    #[tokio::test]
    async fn failed_page_preserves_cursor_and_reports_failure() {
        let (_root, state) = state();
        let fixture = Fixture {
            pages: HashMap::from([(
                (Source::PerformanceReport, 1),
                DataPage {
                    pages: 2,
                    rows: vec![],
                },
            )]),
            fail: Some((Source::PerformanceReport, 2)),
            ..Default::default()
        };
        assert!(
            sync_with_fetcher(&state, timestamp(), &fixture, 25)
                .await
                .is_err()
        );
        let stored = read_state(&state.db).await.unwrap();
        assert_eq!(stored["status"], "failed");
        assert_eq!(
            stored["checkpoints"]["2026-09-30:performance_report"]["bootstrapNextPage"],
            2
        );
        assert_eq!(
            stored["checkpoints"]["2026-09-30:performance_report"]["bootstrapComplete"],
            false
        );
        assert_eq!(stored["stats"]["pagesFetched"], 1);
    }

    #[tokio::test]
    async fn formal_snapshot_is_not_replaced_by_provisional_ingestion() {
        let (_root, state) = state();
        let key = "financial-statements/income/600036.SH.json";
        let snapshot = json!({"code":"600036.SH","statementType":"income","rows":[{"code":"600036.SH","statementType":"income","reportDate":"2026-09-30","source":"eastmoney","updatedAt":1,"payload":{"dataSource":"financial_report","PARENT_NETPROFIT":123}}]});
        state
            .market_store()
            .unwrap()
            .put_json(key, &snapshot)
            .await
            .unwrap();
        let fixture = Fixture {
            pages: HashMap::from([(
                (Source::PerformanceReport, 1),
                DataPage {
                    pages: 1,
                    rows: vec![
                        json!({"SECUCODE":"600036.SH","UPDATE_DATE":"2026-10-20","REPORT_DATE":"2026-09-30","PARENT_NETPROFIT":456}),
                    ],
                },
            )]),
            ..Default::default()
        };
        let stats = sync_with_fetcher(&state, timestamp(), &fixture, 25)
            .await
            .unwrap();
        assert_eq!(stats["formalRowsProtected"], 1);
        assert_eq!(stats["snapshotsUpdated"], 0);
        assert_eq!(
            state.market_store().unwrap().get_json(key).await.unwrap(),
            Some(snapshot)
        );

        // Without earlier-quarter anchors, a cumulative Q3 disclosure stays
        // pending raw evidence; it cannot become an invented single quarter.
        let pending = json!({"SECUCODE":"300308.SZ","UPDATE_DATE":"2026-10-20","REPORT_DATE":"2026-09-30","TOTAL_OPERATE_INCOME":300,"PARENT_NETPROFIT":50});
        let mut raw_stats = Stats::empty("2026-09-30");
        process_rows(
            &state,
            Source::PerformanceReport,
            "2026-09-30",
            vec![pending.clone()],
            &mut raw_stats,
        )
        .await
        .unwrap();
        let raw_snapshot = state
            .market_store()
            .unwrap()
            .get_json("financial-statements/income/300308.SZ.json")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(raw_stats.snapshots_initialized, 1);
        assert_eq!(raw_stats.snapshots_updated, 1);
        assert_eq!(raw_snapshot["rows"], json!([]));
        assert_eq!(
            raw_snapshot["provisionalData"]["performanceRows"],
            json!([pending])
        );
    }
}
