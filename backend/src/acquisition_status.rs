//! Read-only local acquisition monitoring. Never returns settings, cookies or raw errors.
use crate::{ApiResult, AppState, ok};
use axum::{Router, extract::State, routing::get};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

pub fn routes() -> Router<AppState> {
    Router::new().route("/local/acquisitions", get(read))
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
                Ok(json!({"status":r.get::<_,String>(0)?,"started_at":r.get::<_,Option<String>>(1)?,
                    "finished_at":r.get::<_,Option<String>>(2)?,"issue":error.as_deref().map(failure_summary),
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
        task["interval"] = json!(interval);
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
