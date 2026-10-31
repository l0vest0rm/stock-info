//! Local acquisition monitoring and interval settings. Never returns settings, cookies or raw errors.
use crate::{ApiError, ApiResult, AppState, ok};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, put},
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/local/acquisitions", get(read))
        .route("/local/acquisitions/{id}/interval", put(update_interval))
}

fn failure_summary(error: &str) -> &'static str {
    let e = error.to_lowercase();
    if e.contains("session") || e.contains("cookie") || e.contains("login") || e.contains("401") {
        "会话不可用或登录验证失败；需在本机更新会话"
    } else if e.contains("403") || e.contains("429") || e.contains("captcha") {
        "上游拒绝或限制请求；需检查站点访问权限及限流"
    } else if e.contains("capture") || e.contains("feature") || e.contains("provider") {
        "本机采集能力或应用捕获不可用"
    } else if e.contains("timeout") || e.contains("connect") || e.contains("request") {
        "网络或上游请求失败；需检查代理及站点连通性"
    } else {
        "采集失败；详细诊断请查看本机运行日志（页面不展示原始错误以保护凭据）"
    }
}

pub fn snapshot(state: &AppState) -> anyhow::Result<Value> {
    let store = crate::acquisition_runtime::store(state)?;
    let conn = store.conn();
    // One consistent read snapshot, without migrations or task scheduling.
    conn.execute_batch("BEGIN DEFERRED")?;
    let mut tasks = {
        let mut stmt =
            conn.prepare("SELECT id,name,status,last_run_at FROM acquisition_tasks ORDER BY id")?;
        stmt.query_map([],|r|{let status:String=r.get(2)?;Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"task_type":"acquisition","runtime_type":"http","enabled":status=="active","status":status,"last_run_at":r.get::<_,Option<String>>(3)?,"next_run_at":null}))})?.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for task in &mut tasks {
        let id = task["id"].as_i64().unwrap();
        let (flow, interval): (Option<String>, Option<String>) = conn.query_row(
            "SELECT flow_id,json_extract(config_json,'$.interval') FROM acquisition_tasks WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let run = conn.query_row(
            "SELECT status,started_at,finished_at,error_message,json_extract(metadata_json,'$.new_records') FROM acquisition_runs WHERE task_id=?1 ORDER BY id DESC LIMIT 1",
            [id], |r| {
                let error: Option<String> = r.get(3)?;
                let status: String = r.get(0)?;
                let issue = if status == "interrupted" {
                    Some("服务退出前已保存采集进度；启用任务后将从安全检查点续跑")
                } else { error.as_deref().map(failure_summary) };
                Ok(json!({"status":status,"started_at":r.get::<_,Option<String>>(1)?,
                    "finished_at":r.get::<_,Option<String>>(2)?,"issue":issue,
                    "new_records":r.get::<_,Option<i64>>(4)?}))
            },
        ).optional()?;
        let success: Option<String> = conn.query_row(
            "SELECT max(finished_at) FROM acquisition_runs WHERE task_id=?1 AND status='success'",
            [id],
            |r| r.get(0),
        )?;
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM knowledge_docs WHERE json_extract(metadata_json,'$.acquisition.taskId')=?1",
            [id],
            |r| r.get(0),
        )?;
        let targets: i64 = conn.query_row(
            "SELECT count(*) FROM acquisition_tasks t,json_each(t.targets_json) target WHERE t.id=?1 AND json_extract(target.value,'$.enabled')=1",
            [id],
            |r| r.get(0),
        )?;
        task["flow"] = json!(flow);
        task["interval"] = json!(interval.as_deref().unwrap_or("30m"));
        let last = run
            .as_ref()
            .and_then(|r| r["started_at"].as_str())
            .or_else(|| task["last_run_at"].as_str())
            .and_then(|v| {
                chrono::DateTime::parse_from_rfc3339(v)
                    .map(|v| v.with_timezone(&chrono::Utc))
                    .ok()
                    .or_else(|| {
                        chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S")
                            .ok()
                            .map(|v| v.and_utc())
                    })
            });
        let duration = acquisition::config::Schedule {
            interval: interval.unwrap_or_else(|| "30m".into()),
        }
        .duration()?;
        task["next_run_at"] = if task["status"] == "active" {
            json!(acquisition::scheduler::next_run_at(last, duration)?.map(|v| v.to_rfc3339()))
        } else {
            Value::Null
        };
        task["latest_run"] = json!(run);
        task["last_success_at"] = json!(success);
        task["record_count"] = json!(count);
        task["target_count"] = json!(targets);
    }
    conn.execute_batch("COMMIT")?;
    Ok(json!({"checked_at":chrono::Utc::now().to_rfc3339(),
        "scheduler_enabled":state.setting("LOCAL_SCHEDULER") != "0", "tasks":tasks}))
}

async fn read(State(state): State<AppState>) -> ApiResult {
    let result = tokio::task::spawn_blocking(move || snapshot(&state))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(ok(result))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IntervalUpdate {
    interval_minutes: u64,
}

async fn update_interval(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(input): Json<IntervalUpdate>,
) -> ApiResult {
    // The route also inherits the local Host / same-origin middleware. Require
    // Origin explicitly for mutations, including non-browser clients.
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if headers.get("origin").and_then(|v| v.to_str().ok())
        != Some(format!("http://{host}").as_str())
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "same-origin required".into(),
        ));
    }
    if !(1..=10080).contains(&input.interval_minutes) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "interval_minutes must be 1..10080".into(),
        ));
    }
    let interval = format!("{}m", input.interval_minutes);
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = state.db.connect()?;
        // Change only the period; preserve credentials, checkpoints and status.
        Ok(conn.execute("UPDATE acquisition_tasks SET config_json=json_set(config_json,'$.interval',?1),updated_at=?2 WHERE id=?3",
            rusqlite::params![interval, chrono::Utc::now().to_rfc3339(), id])? > 0)
    }).await.map_err(anyhow::Error::from)??;
    if !result {
        return Err(ApiError(StatusCode::NOT_FOUND, "task not found".into()));
    }
    Ok(ok(
        json!({"id":id,"interval_minutes":input.interval_minutes}),
    ))
}
