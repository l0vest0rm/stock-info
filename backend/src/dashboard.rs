pub mod comparability;
pub mod domain;
pub mod point_in_time;

use crate::{ApiError, ApiResult, AppState, codes, db::Database, ok};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

const NAMESPACE: &str = "valuation-screen-v5";
const LEASE_NAMESPACE: &str = "valuation-screen-v4-lease";
const FRESHNESS_MS: i64 = 600_000;
const RETENTION_MS: i64 = 7 * 86_400_000;
const LEASE_MS: i64 = 600_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/research/valuation-screen", get(read_route))
        .route("/research/valuation-screen/refresh", post(batch_route))
        .route("/research/valuation-screen/refresh/{code}", post(row_route))
        .route("/research/valuation-coverage", get(coverage_route))
        .route("/research/comparability", get(comparability_route))
}

async fn read_route(State(state): State<AppState>) -> ApiResult {
    Ok(ok(read(&state).await?))
}
async fn batch_route(State(state): State<AppState>) -> ApiResult {
    Ok(ok(refresh_batch(&state, 2).await?))
}
async fn row_route(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    match refresh_row(&state, &codes::normalize(&code)).await? {
        Some(result) => Ok(ok(result)),
        None => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "证券不在已核验观察池中".into(),
        )),
    }
}
async fn coverage_route() -> ApiResult {
    Ok(ok(crate::coverage::read()))
}
async fn comparability_route(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let code = codes::normalize(query.get("code").map(String::as_str).unwrap_or(""));
    if !codes::supported_company(&code) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "unsupported company code".into(),
        ));
    }
    let peers = query
        .get("peers")
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .map(codes::normalize)
        .filter(|code| !code.is_empty() && codes::supported_company(code))
        .collect::<Vec<_>>();
    Ok(ok(comparability::load(&state, &code, &peers).await?))
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn timestamp(value: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|date| date.timestamp_millis())
}
fn revision(state: &AppState) -> Result<String> {
    Ok(
        state.config("config/generated/valuation-revision.json")?["revision"]
            .as_str()
            .context("valuation dependency revision missing")?
            .to_string(),
    )
}
fn policy(state: &AppState) -> Result<Value> {
    state.config("config/investment-opportunity-policy.json")
}

pub fn targets(state: &AppState) -> Result<Vec<Value>> {
    let universe = state.config("config/investment-universe.json")?;
    let mut result = Vec::new();
    for company in array(&universe["companies"]) {
        if company["classificationStatus"] != "verified" {
            continue;
        }
        let securities = array(&company["securities"]);
        let security = securities
            .iter()
            .find(|security| security["ticker"] == company["preferredTicker"])
            .or_else(|| securities.first());
        let Some(security) = security else { continue };
        let Some(ticker) = security["ticker"].as_str() else {
            continue;
        };
        let market = security
            .get("market")
            .filter(|m| !m.is_null())
            .unwrap_or(&company["preferredMarket"]);
        let code = if market == "US" && !ticker.ends_with(".US") {
            format!("{ticker}.US")
        } else {
            ticker.to_string()
        };
        result.push(json!({"code":codes::normalize(&code),"name":company["displayName"],"market":market,"companyId":company["id"]}));
    }
    Ok(result)
}

fn parse_row(text: &str, revision: &str, policy_version: &Value) -> Option<Value> {
    let row: Value = serde_json::from_str(text).ok()?;
    if row["code"].as_str()?.is_empty()
        || row["computation"]["revision"] != revision
        || row["opportunity"]["policyVersion"] != *policy_version
        || timestamp(&row["computation"]["computedAt"]).is_none()
    {
        return None;
    }
    Some(row)
}

fn fresh(row: Option<&Value>, now: i64) -> bool {
    row.and_then(|row| timestamp(&row["computation"]["computedAt"]))
        .is_some_and(|computed| now >= computed && now - computed < FRESHNESS_MS)
}

async fn research_version(db: &Database, code: &str) -> Result<i64> {
    let versions = crate::observation::versions(db, code, 1).await?;
    Ok(versions
        .first()
        .and_then(|v| v["version"].as_i64())
        .unwrap_or(0))
}

async fn read_row(
    state: &AppState,
    code: &str,
    revision: &str,
    policy_version: &Value,
) -> Result<Option<Value>> {
    let now = Utc::now().timestamp_millis();
    let records = state.db.query("SELECT value_json FROM kv_cache WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)",vec![NAMESPACE.into(),code.into(),now.into()]).await?;
    let row = records
        .first()
        .and_then(|record| record["value_json"].as_str())
        .and_then(|text| parse_row(text, revision, policy_version));
    let current_version = research_version(&state.db, code).await?;
    Ok(row.filter(|row| row["researchVersion"].as_i64().unwrap_or(0) == current_version))
}

pub async fn read(state: &AppState) -> Result<Value> {
    let target_codes = targets(state)?
        .iter()
        .filter_map(|target| target["code"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    let revision = revision(state)?;
    let policy = policy(state)?;
    let now = Utc::now().timestamp_millis();
    let records = state.db.query("SELECT value_json FROM kv_cache WHERE namespace=? AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,key ASC",vec![NAMESPACE.into(),now.into()]).await?;
    let mut stored = HashMap::new();
    for record in records {
        if let Some(row) = record["value_json"]
            .as_str()
            .and_then(|text| parse_row(text, &revision, &policy["version"]))
            && let Some(code) = row["code"].as_str()
        {
            stored.insert(code.to_string(), row);
        }
    }
    let research = state.db.query("SELECT json_extract(value_json,'$.code') AS code,max(json_extract(value_json,'$.version')) AS version FROM kv_cache WHERE namespace='observation-ledger-v1' AND key>='observation-research:v1:' AND key<'observation-research:v1:~' GROUP BY json_extract(value_json,'$.code')",vec![]).await?;
    let research: HashMap<String, i64> = research
        .iter()
        .filter_map(|r| Some((r["code"].as_str()?.to_string(), r["version"].as_i64()?)))
        .collect();
    stored.retain(|code, row| {
        row["researchVersion"].as_i64().unwrap_or(0) == research.get(code).copied().unwrap_or(0)
    });
    let rows = target_codes
        .iter()
        .filter_map(|code| stored.get(code).cloned())
        .collect::<Vec<_>>();
    let mut pending = target_codes
        .iter()
        .filter(|code| !fresh(stored.get(*code), now))
        .cloned()
        .collect::<Vec<_>>();
    pending.sort_by_key(|code| {
        stored
            .get(code)
            .and_then(|row| timestamp(&row["computation"]["computedAt"]))
            .unwrap_or(0)
    });
    let mut verdicts: HashMap<String, usize> = HashMap::new();
    let mut blocked: HashMap<String, usize> = HashMap::new();
    for row in &rows {
        *verdicts
            .entry(row["verdict"].as_str().unwrap_or("unknown").to_string())
            .or_default() += 1;
        for reason in array(&row["blockReasons"]).iter().filter_map(Value::as_str) {
            *blocked.entry(reason.to_string()).or_default() += 1;
        }
    }
    let mut dates = rows
        .iter()
        .filter_map(|row| row["computation"]["computedAt"].as_str())
        .collect::<Vec<_>>();
    dates.sort();
    Ok(
        json!({"schemaVersion":5,"mode":"rolling","revision":revision,"freshnessMs":FRESHNESS_MS,
        "asOf":Utc::now().date_naive().to_string(),"generatedAt":dates.last(),"oldestComputedAt":dates.first(),
        "companies":target_codes.len(),"targets":target_codes,"rows":rows,"byVerdict":verdicts,"blockedDetail":blocked,
        "stale":!pending.is_empty(),"pending":pending,
        "warnings":["滚动结果，不是同一时点的历史回测快照；每条结果附计算标识和规则版本。","服务端定时分批更新；10分钟内复用计算结果，财报遵循数据源缓存周期。计算时间不代表行情或财报日期。"]}),
    )
}

async fn claim(db: &Database, key: &str, token: &str) -> Result<bool> {
    let now = Utc::now().timestamp_millis();
    Ok(!db.query("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at WHERE kv_cache.expires_at<=? RETURNING key",vec![LEASE_NAMESPACE.into(),key.into(),token.into(),(now+LEASE_MS).into(),now.into(),now.into()]).await?.is_empty())
}

async fn release(db: &Database, key: &str, token: &str) -> Result<()> {
    db.execute(
        "DELETE FROM kv_cache WHERE namespace=? AND key=? AND value_json=?",
        vec![LEASE_NAMESPACE.into(), key.into(), token.into()],
    )
    .await?;
    Ok(())
}

/// Computation injection permits deterministic cache/lease acceptance without
/// depending on provider availability; production always uses screen_one.
pub async fn refresh_with<F, Fut>(state: &AppState, code: &str, compute: F) -> Result<Option<Value>>
where
    F: FnOnce(AppState, Value) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let Some(target) = targets(state)?
        .into_iter()
        .find(|target| target["code"] == code)
    else {
        return Ok(None);
    };
    let revision = revision(state)?;
    let policy_version = policy(state)?["version"].clone();
    let row = read_row(state, code, &revision, &policy_version).await?;
    if fresh(row.as_ref(), Utc::now().timestamp_millis()) {
        return Ok(Some(json!({"state":"complete","row":row})));
    }
    let token = uuid::Uuid::new_v4().to_string();
    let mut slot = None;
    for index in 0..2 {
        let key = format!("slot:{index}");
        if claim(&state.db, &key, &token).await? {
            slot = Some(key);
            break;
        }
    }
    let Some(slot) = slot else {
        return Ok(Some(json!({"state":"busy","row":row})));
    };
    let key = format!("security:{code}");
    let mut owns_code = false;
    let result: Result<Option<Value>> = async {
        owns_code = claim(&state.db,&key,&token).await?;
        if !owns_code {return Ok(Some(json!({"state":"busy","row":read_row(state,code,&revision,&policy_version).await?})));}
        let existing = read_row(state,code,&revision,&policy_version).await?;
        if fresh(existing.as_ref(),Utc::now().timestamp_millis()) {return Ok(Some(json!({"state":"complete","row":existing})));}
        let mut row = compute(state.clone(),target).await?;
        row["computation"] = json!({"id":token,"revision":revision,"computedAt":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        let now = Utc::now().timestamp_millis();
        let saved = state.db.query("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM kv_cache WHERE namespace=? AND key IN (?,?) AND value_json=? AND expires_at>?)=2 ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at RETURNING key",vec![NAMESPACE.into(),code.into(),serde_json::to_string(&row)?.into(),(now+RETENTION_MS).into(),now.into(),LEASE_NAMESPACE.into(),key.clone().into(),slot.clone().into(),token.clone().into(),now.into()]).await?;
        if saved.is_empty() {bail!("估值计算租约已过期，旧任务结果未写入");}
        if row["researchVersion"].as_i64().unwrap_or(0)!=research_version(&state.db,code).await? {return Ok(Some(json!({"state":"busy","row":null})));}
        crate::observation::append_cohort(&state.db,&row).await?;
        Ok(Some(json!({"state":"complete","row":row})))
    }.await;
    let code_release = if owns_code {
        release(&state.db, &key, &token).await
    } else {
        Ok(())
    };
    let slot_release = release(&state.db, &slot, &token).await;
    let value = result?;
    code_release?;
    slot_release?;
    Ok(value)
}

pub async fn refresh_row(state: &AppState, code: &str) -> Result<Option<Value>> {
    refresh_owned_with(state, code, |state, target| async move {
        screen_with_failure(&state, &target).await
    })
    .await
}

/// The accepted refresh belongs to the runtime, not the browser connection.
/// Dropping a response waiter must not cancel a computation between acquiring
/// a SQLite lease and releasing it. A dropped JoinHandle detaches (not aborts)
/// the task; fenced persistence and normal lease cleanup still run.
pub async fn refresh_owned_with<F, Fut>(
    state: &AppState,
    code: &str,
    compute: F,
) -> Result<Option<Value>>
where
    F: FnOnce(AppState, Value) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value>> + Send + 'static,
{
    let owned_state = state.clone();
    let code = code.to_string();
    state
        .spawn(async move { refresh_with(&owned_state, &code, compute).await })
        .await?
}

pub async fn refresh_batch(state: &AppState, limit: usize) -> Result<Value> {
    let owned_state = state.clone();
    state
        .spawn(async move {
            refresh_batch_with(&owned_state, limit, |state, target| async move {
                screen_with_failure(&state, &target).await
            })
            .await
        })
        .await?
}

pub async fn refresh_batch_with<F, Fut>(state: &AppState, limit: usize, compute: F) -> Result<Value>
where
    F: Fn(AppState, Value) -> Fut + Sync,
    Fut: Future<Output = Result<Value>>,
{
    let dashboard = read(state).await?;
    let pending: Arc<Vec<String>> = Arc::new(
        array(&dashboard["pending"])
            .iter()
            .take(limit.clamp(1, 12))
            .filter_map(|code| code.as_str().map(str::to_string))
            .collect(),
    );
    let cursor = AtomicUsize::new(0);
    let worker = || async {
        loop {
            let index = cursor.fetch_add(1, Ordering::Relaxed);
            let Some(code) = pending.get(index) else {
                break;
            };
            refresh_with(state, code, &compute).await?;
        }
        Ok::<(), anyhow::Error>(())
    };
    let (first, second) = tokio::join!(worker(), worker());
    if first.is_err() || second.is_err() {
        bail!(
            "估值批次未完成，后续定时任务将重试: {} {}",
            first.err().map(|e| e.to_string()).unwrap_or_default(),
            second.err().map(|e| e.to_string()).unwrap_or_default()
        );
    }
    read(state).await
}

fn normalize_currency(value: Option<&str>) -> Option<&'static str> {
    match value.unwrap_or("").trim().to_uppercase().as_str() {
        "CNY" | "RMB" | "人民币" | "人民幣" => Some("CNY"),
        "USD" | "美元" | "US$" => Some("USD"),
        "HKD" | "港元" | "港币" | "港幣" => Some("HKD"),
        "KRW" | "韩元" | "韓元" => Some("KRW"),
        _ => None,
    }
}
fn trading_currency(market: &str) -> Option<&'static str> {
    match market {
        "CN" => Some("CNY"),
        "HK" => Some("HKD"),
        "US" => Some("USD"),
        _ => None,
    }
}
fn numeric(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| payload[*key].as_f64().filter(|n| n.is_finite()))
}
fn reporting_currency(rows: &[Value]) -> Option<String> {
    rows.iter().find_map(|row| {
        ["CURRENCY", "CURRENCY_TYPE", "REPORTING_CURRENCY"]
            .iter()
            .map(|key| &row["payload"][*key])
            .find(|value| !value.is_null())
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}
fn latest_report(rows: &[Value]) -> Option<&Value> {
    rows.iter().fold(None, |best: Option<&Value>, row| {
        if best.is_none_or(|best| row["reportDate"].as_str() > best["reportDate"].as_str()) {
            Some(row)
        } else {
            best
        }
    })
}
fn day_timestamp(date: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|date| {
            date.and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis()
        })
}
fn ttm_growth(points: &[Value]) -> Value {
    let Some(latest) = points.first() else {
        return Value::Null;
    };
    let Some(latest_time) = latest["reportDate"].as_str().and_then(day_timestamp) else {
        return Value::Null;
    };
    let best = points
        .iter()
        .skip(1)
        .filter_map(|point| {
            Some((
                point,
                (day_timestamp(point["reportDate"].as_str()?)? - (latest_time - 365 * 86_400_000))
                    .abs(),
            ))
        })
        .min_by_key(|(_, distance)| *distance);
    let Some((best, distance)) = best else {
        return Value::Null;
    };
    let (Some(now), Some(then)) = (
        latest["ttmNetProfit"].as_f64(),
        best["ttmNetProfit"].as_f64(),
    ) else {
        return Value::Null;
    };
    if distance > 45 * 86_400_000 || now <= 0.0 || then <= 0.0 {
        return Value::Null;
    }
    json!({"ttmGrowth":now/then-1.0,"reportDate":latest["reportDate"],"provisional":latest["provisional"]==true})
}

async fn screen_with_failure(state: &AppState, target: &Value) -> Result<Value> {
    match screen_one(state, target).await {
        Ok(row) => Ok(row),
        Err(error) => {
            let archetype =
                crate::coverage::company_archetype(target["code"].as_str().unwrap_or(""))
                    .unwrap_or_else(|| "other".into());
            let opportunity = domain::opportunity(
                &json!({"assessment":null,"archetype":archetype,"blockReasons":["request_failed"],"points":[],"adjustedBars":[],"cashflowTtm":null,"cashflowReportDate":null,"debtRatio":null,"balanceReportDate":null,"policy":policy(state)?}),
            );
            Ok(
                json!({"code":target["code"],"name":target["name"],"market":target["market"],"archetype":archetype,"verdict":"blocked","basis":null,"position":null,"blockReasons":["request_failed"],"note":"单家计算异常；这是执行问题，不代表公司无法估值。","growth":null,"executable":false,"unavailableReason":error.to_string(),"opportunity":opportunity}),
            )
        }
    }
}

async fn screen_one(state: &AppState, target: &Value) -> Result<Value> {
    let code = target["code"]
        .as_str()
        .context("screen target has no code")?;
    let market = target["market"].as_str().unwrap_or("");
    let archetype = crate::coverage::company_archetype(code).unwrap_or_else(|| "other".into());
    let (income, balance, cashflow) = tokio::try_join!(
        crate::finance::read_model(state, code, "income"),
        crate::finance::read_model(state, code, "balance"),
        crate::finance::read_model(state, code, "cashflow")
    )?;
    let series = crate::finance::quarterly_series(code, array(&income["rows"]), 16);
    let growth = ttm_growth(array(&series["points"]));
    // Scan declared currency across rows: a provisional row may omit it.
    let band_currency = reporting_currency(array(&income["rows"]));
    let today = Utc::now()
        .with_timezone(&chrono_tz::Asia::Shanghai)
        .date_naive()
        .to_string();
    let mut bars = Vec::new();
    let mut quote = Value::Null;
    let mut quote_meta = Value::Null;
    let mut quote_failed = false;
    let mut quote_stage = "雪球日线";
    let quote_result: Result<()> = async {
        bars=crate::xueqiu::stock_kline_with_refresh(state,code,"normal",&today,true).await?.0;
        if let Some(last)=bars.last().filter(|last|last["marketCapital"].as_f64().is_some_and(|n|n>0.0)) {
            quote=json!({"currency":trading_currency(market),"priceAsOf":last["date"],"marketCap":last["marketCapital"]});
            let fetched=last["updatedAt"].as_i64().and_then(DateTime::<Utc>::from_timestamp_millis).map(|date|date.to_rfc3339_opts(chrono::SecondsFormat::Millis,true));
            quote_meta=json!({"source":"雪球日线市值","date":last["date"],"fetchedAt":fetched});
        } else {
            quote_stage="雪球带日期市值";
            quote=crate::xueqiu::stock_quote(state,code,true).await?;
            quote_meta=json!({"source":"雪球行情市值（非K线）","date":quote["priceAsOf"],"fetchedAt":quote["fetchedAt"]});
        }
        Ok(())
    }.await;
    if quote_result.is_err() {
        quote_failed = true;
    }
    let comparable_currency = band_currency.is_some()
        && normalize_currency(band_currency.as_deref())
            == normalize_currency(trading_currency(market));
    let cap = if comparable_currency {
        quote["marketCap"].as_f64()
    } else {
        None
    };
    let bands = crate::finance::valuation_bands_with_market_cap(state, code, cap).await?;
    let mut result = domain::screen(
        &json!({"code":code,"archetype":archetype,"bands":bands["bands"],"bandCurrency":band_currency,"quote":quote,"growth":growth}),
    );
    let quote_age = quote["priceAsOf"]
        .as_str()
        .and_then(day_timestamp)
        .map(|time| (Utc::now().timestamp_millis() - time) as f64 / 86_400_000.0);
    let stale_quote = !quote_age.is_some_and(|age| (-1.0..=7.0).contains(&age));
    let financial_failed = [&income, &balance, &cashflow]
        .iter()
        .any(|model| model["sourceHealth"]["status"] != "healthy");
    if quote_failed || stale_quote || financial_failed {
        result["verdict"] = json!("blocked");
        result["basis"] = Value::Null;
        result["position"] = Value::Null;
        result["blockReasons"] = json!(["quote_missing"]);
        result["note"] = json!(if financial_failed {
            "本次财报刷新失败；不以旧财报冒充最新结果。".to_string()
        } else if quote_failed {
            format!("{quote_stage}请求失败；请检查数据源连接与凭据。")
        } else {
            "行情日期缺失或距今超过7天，不能判定当前估值。".to_string()
        });
    }
    let assessment = domain::assess(
        &json!({"result":result,"bands":bands,"series":series,"statements":income["rows"],"bars":bars,"quote":quote_meta,"historyComparable":comparable_currency}),
    );
    let block_reasons = if financial_failed {
        json!(["financial_refresh_failed"])
    } else if quote_failed {
        json!(["quote_fetch_failed"])
    } else if stale_quote {
        json!(["stale_quote"])
    } else {
        result["blockReasons"].clone()
    };
    // Adjusted prices are a distinct contract; no unadjusted drawdown fallback.
    let adjusted = crate::xueqiu::stock_kline_with_refresh(state, code, "qfq", &today, true)
        .await
        .map(|(rows, _)| rows)
        .unwrap_or_default();
    let cash_rows = if cashflow["sourceHealth"]["status"] == "healthy" {
        array(&cashflow["rows"])
    } else {
        &[]
    };
    let balance_rows = if balance["sourceHealth"]["status"] == "healthy" {
        array(&balance["rows"])
    } else {
        &[]
    };
    let cash_date = cash_rows
        .iter()
        .filter_map(|row| row["reportDate"].as_str())
        .max();
    let balance_row = latest_report(balance_rows);
    let assets = balance_row.and_then(|row| {
        numeric(
            &row["payload"],
            &["TOTAL_ASSETS", "totalAssets", "totaAssets"],
        )
    });
    let liabilities = balance_row.and_then(|row| {
        numeric(
            &row["payload"],
            &["TOTAL_LIABILITIES", "totalLiabilities", "totalLiab"],
        )
    });
    let cashflow_ttm = if market == "US" {
        None
    } else {
        crate::finance::series::ttm_value(cash_rows, |row| {
            numeric(
                &row["payload"],
                &["NETCASH_OPERATE", "netcashOperate", "netCashOperate"],
            )
        })
    };
    let research = crate::observation::versions(&state.db, code, 1)
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    let industry = crate::observation::verify_industry(
        &archetype,
        research.get("industryFacts").unwrap_or(&json!([])),
        Utc::now().timestamp_millis(),
    );
    let model = &research["expectations"];
    let matches_cap = match (model["marketCap"].as_f64(), quote["marketCap"].as_f64()) {
        (Some(model), Some(quote)) if quote > 0.0 => (model / quote - 1.0).abs() < 0.01,
        _ => false,
    };
    let forward = if research["thesis"]["status"] == "reviewed"
        && !model.is_null()
        && model["priceDate"] == quote["priceAsOf"]
        && model["currency"].as_str() == normalize_currency(trading_currency(market))
        && matches_cap
    {
        json!({"model":crate::observation::expectations(model,Utc::now().timestamp_millis()),"priceDate":model["priceDate"],"profitPeriod":model["profitPeriod"],"currency":model["currency"],"researchVersion":research["version"]})
    } else {
        Value::Null
    };
    let opportunity = domain::opportunity(
        &json!({"industry":industry,"forward":forward,"thesisReview":research["thesis"],"assessment":assessment,"archetype":archetype,"blockReasons":block_reasons,"points":series["points"],"adjustedBars":adjusted,"cashflowTtm":cashflow_ttm,"cashflowReportDate":cash_date,"debtRatio":assets.filter(|a|*a>0.0).zip(liabilities.filter(|l|*l>=0.0)).map(|(a,l)|l/a),"balanceReportDate":balance_row.map(|row|&row["reportDate"]),"policy":policy(state)?}),
    );
    let mut row = json!({"code":code,"name":target["name"],"market":target["market"],"archetype":archetype,"executable":false});
    if let Some(fields) = result.as_object() {
        for (key, value) in fields {
            row[key] = value.clone();
        }
    }
    row["blockReasons"] = block_reasons;
    row["growth"] = result["growth"].clone();
    row["assessment"] = assessment;
    row["opportunity"] = opportunity;
    row["researchVersion"] = json!(research["version"].as_i64().unwrap_or(0));
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn currency_scan_skips_provisional_rows_but_preserves_nullish_precedence() {
        assert_eq!(
            reporting_currency(&[
                json!({"payload":{}}),
                json!({"payload":{"CURRENCY":" 人民币 "}}),
            ]),
            Some("人民币".into())
        );
        assert_eq!(
            reporting_currency(&[
                json!({"payload":{"CURRENCY":"","CURRENCY_TYPE":"USD"}}),
                json!({"payload":{"CURRENCY":"CNY"}}),
            ]),
            Some("CNY".into())
        );
        assert_eq!(
            reporting_currency(&[json!({"payload":{"CURRENCY":null,"CURRENCY_TYPE":"HKD"}})]),
            Some("HKD".into())
        );
        assert_eq!(normalize_currency(Some("人民幣")), Some("CNY"));
        assert_eq!(normalize_currency(Some("unrecognized")), None);
    }

    #[test]
    fn newest_balance_ties_preserve_provider_order_and_numeric_contract() {
        let rows = [
            json!({"reportDate":"2026-06-30","payload":{"TOTAL_ASSETS":100}}),
            json!({"reportDate":"2026-06-30","payload":{"TOTAL_ASSETS":200}}),
            json!({"reportDate":"2025-12-31","payload":{"TOTAL_ASSETS":300}}),
        ];
        assert_eq!(latest_report(&rows), Some(&rows[0]));
        assert_eq!(
            numeric(&json!({"TOTAL_ASSETS":"100"}), &["TOTAL_ASSETS"]),
            None
        );
    }

    #[test]
    fn growth_uses_calendar_year_match_not_array_position_or_nonpositive_base() {
        let points = [
            json!({"reportDate":"2026-09-30","ttmNetProfit":120}),
            json!({"reportDate":"2026-06-30","ttmNetProfit":119}),
            json!({"reportDate":"2025-09-30","ttmNetProfit":100}),
        ];
        let growth = ttm_growth(&points);
        assert!((growth["ttmGrowth"].as_f64().unwrap() - 0.2).abs() < 1e-12);
        let missing = [points[0].clone(), points[1].clone()];
        assert!(ttm_growth(&missing).is_null());
        let negative = [
            points[0].clone(),
            json!({"reportDate":"2025-09-30","ttmNetProfit":-1}),
        ];
        assert!(ttm_growth(&negative).is_null());
    }
}
