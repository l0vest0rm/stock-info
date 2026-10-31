use super::*;
use cea_sdk::{WorkflowCheckpoint, WorkflowOptions, WorkflowReport};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};

pub struct Worker {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Worker {
    pub fn request_stop(&self) {
        let _ = self.stop.send(true);
    }
    pub async fn stop(self) {
        self.request_stop();
        let _ = self.task.await;
    }
}
/// Explicit accepted work runs even with LOCAL_SCHEDULER=0; no provider work
/// exists unless a user submitted and bound a durable business execution.
pub fn start(state: &AppState) -> Worker {
    let (stop, mut stopped) = watch::channel(false);
    let state = state.clone();
    let task = tokio::spawn(async move {
        loop {
            if *stopped.borrow() {
                break;
            }
            if state.setting("LLM_RUNTIME") == "local" {
                tokio::select! {
                    _=stopped.changed()=>break,
                    r=tick(&state)=>{ if r.is_err() { eprintln!("local web workflow tick failed; durable execution retained"); } }
                }
            }
            tokio::select! {_=stopped.changed()=>break,_=tokio::time::sleep(Duration::from_secs(2))=>{}}
        }
    });
    Worker { stop, task }
}

pub async fn tick(state: &AppState) -> Result<bool> {
    local(state)?;
    let claimed = store::claim(&state.db).await?;
    let Some(claim) = claimed else {
        reconcile(state).await;
        return Ok(false);
    };
    // Publish queued/recovery -> running before a potentially long SDK wait.
    reconcile(state).await;
    // Refresh independently of slow CEA waits; loss drops the runner future.
    let execution = execute(state, &claim);
    tokio::pin!(execution);
    let mut pulse = tokio::time::interval(Duration::from_secs(10));
    let result = loop {
        tokio::select! {
            r=&mut execution=>break r,
            _=pulse.tick()=>{
                let current = state.db.get_kv(RUNS,text(&claim.run["runId"])).await?.context("execution missing")?;
                if current["cancelRequested"]==true {
                    store::update(&state.db,&claim,json!({"status":"interrupted","completedAt":now(),"recoveryRequired":true,"errorMessage":"本地执行已停止；网页已收到的请求并未撤回。"}),true).await?;
                    // Return drops the in-flight SDK future before another tick.
                    return Ok(true);
                }
                store::update(&state.db,&claim,json!({}),false).await?;
            }
        }
    };
    match result {
        Ok(report) => {
            let directory = PathBuf::from(text(&claim.run["directory"]));
            let result = result::from_report(&claim.run, &report, &directory.join("output"));
            match result {
                Ok(result) => {
                    // Commit before cleanup. Recovery can reread the SDK receipt
                    // if the host crashes between artifact and SQLite publication.
                    store::update(&state.db,&claim,json!({"status":"succeeded","result":result,"completedAt":now(),"recoveryRequired":false,"errorMessage":null}),true).await?;
                    // Only resources created by this workflow are eligible.
                    let _ = cea_sdk::close_workflow_page(
                        text(&claim.run["endpoint"]),
                        &report.server_instance_id,
                        &report.page_id,
                    )
                    .await;
                }
                Err(_) => {
                    fail(
                        state,
                        &claim,
                        "CEA 已完成但结果证据或资源校验失败；可重试读取原结果，不会重发提示词。",
                    )
                    .await?;
                }
            }
        }
        Err(_) => {
            // Do not echo provider pages/prompts/paths/credentials from errors.
            fail(state,&claim,"CEA 执行未完成：请检查本机连接、登录、模型/思考强度与页面；恢复只使用原 checkpoint，不重发提示词。").await?;
        }
    }
    reconcile(state).await;
    Ok(true)
}
async fn fail(state: &AppState, claim: &store::Claim, message: &str) -> Result<()> {
    store::update(&state.db,claim,json!({"status":"failed","completedAt":now(),"errorMessage":message,"recoveryRequired":true}),true).await
}
pub(super) async fn reconcile(state: &AppState) {
    let _ = crate::research::reconcile(state).await;
    let _ = crate::macro_data::reconcile(state).await;
    let _ = crate::company::reconcile_discoveries(state).await;
}
fn page_gone(e: &anyhow::Error) -> bool {
    e.chain().any(|e| matches!(e.downcast_ref::<cea_sdk::ClientError>(),Some(cea_sdk::ClientError::Server{code,..}) if matches!(code.as_str(),"resource.gone"|"resource.not_found"|"page.closed"|"session.closed"))) || e.to_string().contains("server instance changed")
}
async fn execute(state: &AppState, claim: &store::Claim) -> Result<WorkflowReport> {
    let dir = Path::new(text(&claim.run["directory"]));
    let path = dir.join("workflow.yaml");
    ensure!(
        hash(&std::fs::read(&path)?) == text(&claim.run["workflowHash"]),
        "frozen workflow changed"
    );
    let output = dir.join("output");
    if let Some(report) = cea_sdk::read_workflow_result(&output)? {
        return Ok(report);
    }
    ensure!(
        claim.run["resultReplayOnly"] != true,
        "completed SDK receipt is missing; browser execution refused"
    );
    let options = WorkflowOptions {
        endpoint: Some(text(&claim.run["endpoint"]).to_string()),
        output_dir: output,
        variables: serde_json::from_value(claim.run["variables"].clone())?,
    };
    let checkpoint = if claim.run["checkpoint"].is_null() {
        None
    } else {
        Some(serde_json::from_value::<WorkflowCheckpoint>(
            claim.run["checkpoint"].clone(),
        )?)
    };
    let observe = |checkpoint: WorkflowCheckpoint| {
        let db = state.db.clone();
        let claim = claim.clone();
        async move {
            store::update(
                &db,
                &claim,
                json!({"lastStep":checkpoint.last_step(),"checkpoint":checkpoint}),
                false,
            )
            .await
        }
    };
    // A surviving Page may have a stale streaming DOM even though the provider
    // conversation is complete. Let the SDK decide whether the remaining
    // cursor is strictly read-only, then recover by opening that confirmed URL.
    // Before submission, exact-cursor recovery remains mandatory.
    if let Some(saved) = checkpoint.as_ref()
        && cea_sdk::can_reopen_workflow_read_only(&path, saved)?
    {
        return cea_sdk::recover_workflow_observed(&path, options, saved.clone(), observe).await;
    }
    let outcome = {
        let mut running = Box::pin(cea_sdk::run_workflow_observed(
            &path,
            options.clone(),
            checkpoint.clone(),
            observe,
        ));
        tokio::select! {
            result = &mut running => result,
            _ = tokio::time::sleep(Duration::from_secs(300)) => {
                let current = state.db.get_kv(RUNS, text(&claim.run["runId"])).await?
                    .context("execution missing")?;
                let saved = serde_json::from_value::<WorkflowCheckpoint>(current["checkpoint"].clone()).ok();
                if let Some(saved) = saved
                    && cea_sdk::can_reopen_workflow_read_only(&path, &saved)?
                {
                    // Drop the original runner before creating a replacement Page.
                    // This watchdog never retries a dispatch: only the SDK-approved
                    // read-only suffix can be reopened, once per worker claim.
                    drop(running);
                    return cea_sdk::recover_workflow_observed(&path, options, saved, observe).await;
                }
                running.await
            }
        }
    };
    match outcome {
        Ok(report) => Ok(report),
        Err(e)
            if checkpoint
                .as_ref()
                .is_some_and(WorkflowCheckpoint::side_effect_possible)
                && page_gone(&e) =>
        {
            cea_sdk::recover_workflow_observed(&path, options, checkpoint.unwrap(), |checkpoint| {
                let db = state.db.clone();
                let claim = claim.clone();
                async move {
                    store::update(
                        &db,
                        &claim,
                        json!({"lastStep":checkpoint.last_step(),"checkpoint":checkpoint}),
                        false,
                    )
                    .await
                }
            })
            .await
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn receipt_only_retry_never_connects_when_receipt_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("workflow.yaml"), "frozen").unwrap();
        let db = crate::db::Database::open(dir.path().join("test.sqlite")).unwrap();
        let state = AppState::new(db, dir.path().into(), "127.0.0.1:18099".into()).unwrap();
        let claim = store::Claim {
            run: json!({"directory":dir.path(),"workflowHash":hash(b"frozen"),"resultReplayOnly":true,"endpoint":"ws://127.0.0.1:1/"}),
            owner: "owner".into(),
            slot: "slot".into(),
            token: 1,
        };
        let error = tokio::time::timeout(Duration::from_secs(1), execute(&state, &claim))
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("receipt is missing"));
    }
}
