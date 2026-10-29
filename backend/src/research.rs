//! Public research API and durable local report reconciler. The retired
//! workbench API is intentionally not re-exposed by this replacement.
pub mod evidence;
pub mod financial;
pub mod financial_input;
pub mod investment;
pub mod repository;
pub mod taskd;

use crate::{ApiError, ApiResult, AppState, codes, ok};
use anyhow::Result;
use axum::{
    Router,
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/research/evidence/{code}", get(evidence_get))
        .route(
            "/research/company/{code}/financial-analysis",
            get(financial_get),
        )
        .route(
            "/research/company/{code}/investment-analysis",
            get(investment_get),
        )
        .route(
            "/research/company/{code}/financial-analysis/refresh",
            post(financial_refresh),
        )
        .route(
            "/research/company/{code}/financial-analysis/resume",
            post(financial_resume),
        )
        .route(
            "/research/company/{code}/financial-analysis/sync",
            post(financial_sync),
        )
        .route(
            "/research/company/{code}/investment-analysis/refresh",
            post(investment_refresh),
        )
        .route(
            "/research/company/{code}/investment-analysis/resume",
            post(investment_resume),
        )
        .route(
            "/research/company/{code}/investment-analysis/sync",
            post(investment_sync),
        )
}
fn company_code(code: &str) -> std::result::Result<String, ApiError> {
    let code = codes::normalize(code);
    if !codes::supported_company(&code) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "unsupported company code".into(),
        ));
    }
    Ok(code)
}
fn writable(state: &AppState, action: &str) -> std::result::Result<(), ApiError> {
    if state.setting("LLM_RUNTIME") != "local" {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("{action} is only available in local LLM runtime"),
        ));
    }
    Ok(())
}
fn request_error(error: anyhow::Error) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, error.to_string())
}
fn sync_error(error: anyhow::Error) -> ApiError {
    if taskd::is_read_unavailable(&error) {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "暂时无法连接 taskd；本地任务状态未改变，请稍后再同步。".into(),
        )
    } else {
        request_error(error)
    }
}
async fn evidence_get(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    let code = company_code(&code)?;
    Ok(ok(evidence::collect(&state, &code).await?))
}
async fn financial_get(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    let code = company_code(&code)?;
    let mut data = financial::load(&state, &code)
        .await
        .map_err(request_error)?;
    data["canManageLocally"] = json!(state.setting("LLM_RUNTIME") == "local");
    Ok(ok(data))
}
async fn investment_get(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    let code = company_code(&code)?;
    let mut data = investment::load(&state, &code)
        .await
        .map_err(request_error)?;
    data["canManageLocally"] = json!(state.setting("LLM_RUNTIME") == "local");
    Ok(ok(data))
}
async fn financial_refresh(
    State(state): State<AppState>,
    Path(code): Path<String>,
    body: Bytes,
) -> ApiResult {
    writable(&state, "financial analysis refresh")?;
    let code = company_code(&code)?;
    let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    Ok(ok(financial::enqueue(
        &state,
        &code,
        body["force"] != false,
        body["reasoningEffort"].as_str(),
    )
    .await
    .map_err(request_error)?))
}
async fn investment_refresh(
    State(state): State<AppState>,
    Path(code): Path<String>,
    body: Bytes,
) -> ApiResult {
    writable(&state, "investment analysis refresh")?;
    let code = company_code(&code)?;
    let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    Ok(ok(investment::enqueue(
        &state,
        &code,
        body["reasoningEffort"].as_str(),
    )
    .await
    .map_err(request_error)?))
}
async fn financial_resume(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    writable(&state, "financial analysis resume")?;
    let code = company_code(&code)?;
    Ok(ok(financial::resume(&state, &code)
        .await
        .map_err(request_error)?))
}
async fn investment_resume(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    writable(&state, "investment analysis resume")?;
    let code = company_code(&code)?;
    Ok(ok(investment::resume(&state, &code)
        .await
        .map_err(request_error)?))
}
async fn financial_sync(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    writable(&state, "financial analysis synchronization")?;
    let code = company_code(&code)?;
    Ok(ok(financial::sync(&state, &code)
        .await
        .map_err(sync_error)?))
}
async fn investment_sync(State(state): State<AppState>, Path(code): Path<String>) -> ApiResult {
    writable(&state, "investment analysis synchronization")?;
    let code = company_code(&code)?;
    Ok(ok(investment::sync(&state, &code)
        .await
        .map_err(sync_error)?))
}

pub async fn reconcile(state: &AppState) -> Result<Value> {
    if state.setting("LLM_RUNTIME") != "local" {
        return Ok(json!({"inspected":0,"failed":0}));
    }
    let records=state.db.query("SELECT namespace,key AS code FROM kv_cache WHERE namespace IN (?,?) AND json_valid(value_json) AND json_extract(value_json,'$.task.name') IS NOT NULL AND (json_extract(value_json,'$.task.status') IN ('queued','leased','running','interrupt_requested') OR (json_extract(value_json,'$.task.status')='failed' AND json_extract(value_json,'$.pendingProjection')=1) OR (json_extract(value_json,'$.task.status')='succeeded' AND (json_extract(value_json,'$.markdown') IS NULL OR json_extract(value_json,'$.pendingProjection')=1))) ORDER BY updated_at ASC",vec![financial::NAMESPACE.into(),investment::NAMESPACE.into()]).await?;
    let mut failed = 0;
    for record in &records {
        let code = record["code"].as_str().unwrap_or("");
        let result = if record["namespace"] == investment::NAMESPACE {
            investment::reconcile_one(state, code).await
        } else {
            financial::reconcile_one(state, code).await
        };
        if let Err(error) = result {
            failed += 1;
            eprintln!("research reconciliation failed for {code}: {error}");
        }
    }
    Ok(json!({"inspected":records.len(),"failed":failed}))
}
