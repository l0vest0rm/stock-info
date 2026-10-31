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
        Err(error) => {
            let diagnostic = failure_diagnostic(&error);
            store::update(
                &state.db,
                &claim,
                json!({
                    "status":"failed", "completedAt":now(), "recoveryRequired":true,
                    "errorMessage":diagnostic["message"], "errorCode":diagnostic["code"],
                    "failedStep":diagnostic["step"], "matchCount":diagnostic["matchCount"]
                }),
                true,
            )
            .await?;
        }
    }
    reconcile(state).await;
    Ok(true)
}
fn failure_diagnostic(error: &anyhow::Error) -> Value {
    let server = error
        .chain()
        .find_map(|e| match e.downcast_ref::<cea_sdk::ClientError>() {
            Some(cea_sdk::ClientError::Server { code, details, .. }) => {
                Some((code.as_str(), details.as_ref()))
            }
            _ => None,
        });
    let (code, message) = match server.map(|s| s.0) {
        Some("locator.ambiguous") => (
            "locator.ambiguous",
            "回答正文定位不唯一；需修正读取规则后从原 checkpoint 恢复，不重发提示词。",
        ),
        Some("locator.not_found") => (
            "locator.not_found",
            "未找到预期页面元素；请核对页面后从原 checkpoint 恢复，不重发提示词。",
        ),
        Some("page.closed" | "resource.gone" | "resource.not_found" | "session.closed") => (
            "page.unavailable",
            "原研究页面不可用；仅可从原 checkpoint 恢复，不重发提示词。",
        ),
        _ => (
            "workflow.incomplete",
            "CEA 执行未完成；请查看本地失败证据并从原 checkpoint 恢复，不重发提示词。",
        ),
    };
    let step = error
        .chain()
        .find_map(|e| e.downcast_ref::<cea_sdk::WorkflowStepFailure>())
        .map(|e| e.step.as_str());
    json!({"code":code,"message":message,"step":step,"matchCount":server.and_then(|(_,d)|d).and_then(|d|d["match_count"].as_u64())})
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
    let mut checkpoint = if claim.run["checkpoint"].is_null() {
        None
    } else {
        Some(serde_json::from_value::<WorkflowCheckpoint>(
            claim.run["checkpoint"].clone(),
        )?)
    };
    if let Some(saved) = checkpoint.as_ref()
        && cea_sdk::can_reopen_workflow_read_only(&path, saved)?
    {
        let updates = serde_json::from_value(
            state.config("config/app/web-research.json")?["readOnlyLocatorUpdates"].clone(),
        )?;
        checkpoint = Some(cea_sdk::amend_workflow_read_only_locators(
            &path,
            &options,
            saved.clone(),
            &updates,
        )?);
    }
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
    #[test]
    fn locator_failure_is_specific_and_redacts_server_content() {
        let error = anyhow::Error::new(cea_sdk::ClientError::Server {
            code: "locator.ambiguous".into(),
            message: "private prompt and cookie".into(),
            retry: serde_json::from_value(json!("never")).unwrap(),
            details: Some(json!({"match_count":9,"html":"private page"})),
        })
        .context(cea_sdk::WorkflowStepFailure {
            step: "prove_answer_completed".into(),
        });
        let diagnostic = failure_diagnostic(&error);
        assert_eq!(diagnostic["code"], "locator.ambiguous");
        assert_eq!(diagnostic["step"], "prove_answer_completed");
        assert_eq!(diagnostic["matchCount"], 9);
        assert!(!diagnostic.to_string().contains("private"));
        assert!(
            !failure_diagnostic(&anyhow::anyhow!("private transport message"))
                .to_string()
                .contains("private")
        );
    }

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
