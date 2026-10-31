//! Acquisition runs in this process and uses the host's existing SQLite file.
//! No subprocess, separate database, LLM execution or automatic task seeding.
use crate::AppState;
use acquisition::{
    Engine, Store,
    config::{self, Acquisition},
    control::TaskSettings,
    scheduler::{FlowSource, Scheduler},
};
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub fn store(state: &AppState) -> Result<Store> {
    Store::from_connection(state.db.connect()?)?
        .with_record_storage(Arc::new(crate::acquisition_storage::KnowledgeStorage))
}
fn flows(state: &AppState) -> Result<Vec<Acquisition>> {
    let setting = state.setting("LOCAL_ACQUISITION_CONFIG_DIR");
    let path = state.root.join(if setting.is_empty() {
        "config/acquisitions"
    } else {
        &setting
    });
    config::load_dir(&path)
}
pub fn start(state: &AppState) -> Result<Option<Scheduler>> {
    if state.setting("LOCAL_SCHEDULER") == "0" {
        return Ok(None);
    }
    let source = FlowSource {
        engine: Engine::new(store(state)?)?,
        flows: Arc::new(flows(state)?),
        db_path: state.db.path().to_path_buf(),
    };
    Ok(Some(Scheduler::start(Arc::new(source), 4)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    name: String,
    flow: String,
    settings: TaskSettings,
    #[serde(default)]
    targets: Vec<Value>,
}
pub async fn command(state: &AppState, options: &Value) -> Result<Value> {
    let state = state.clone();
    let options = options.clone();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || runtime.block_on(command_inner(&state, &options))).await?
}
async fn command_inner(state: &AppState, options: &Value) -> Result<Value> {
    let store = store(state)?;
    match options["operation"].as_str().unwrap_or("list") {
        "list" => Ok(json!(store.all_tasks()?)),
        "import-sub2me" => {
            let path = state.root.join(
                options["file"]
                    .as_str()
                    .context("import-sub2me requires --file source.db")?,
            );
            crate::acquisition_import::import(&store, &flows(state)?, &path, state.db.path())
        }
        "put" => {
            let path = state
                .root
                .join(options["file"].as_str().context("put requires --file")?);
            let input: Registration = serde_json::from_slice(&std::fs::read(path)?)?;
            let flows = flows(state)?;
            let flow = flows
                .iter()
                .find(|f| f.name == input.flow)
                .context("flow not found")?;
            // Use a savepoint: invalid targets cannot leave a half-registered task.
            store
                .conn()
                .execute_batch("SAVEPOINT register_acquisition")?;
            let result = (|| {
                let id = store.put_task(flow, &input.name, &input.settings)?;
                for target in input.targets {
                    store.target_add(flow, &input.name, &target)?;
                }
                Ok::<_, anyhow::Error>(id)
            })();
            match result {
                Ok(id) => {
                    store.conn().execute_batch("RELEASE register_acquisition")?;
                    Ok(
                        json!({"id":id,"name":input.name,"activation":"explicit status command required for new tasks"}),
                    )
                }
                Err(e) => {
                    store.conn().execute_batch(
                        "ROLLBACK TO register_acquisition; RELEASE register_acquisition",
                    )?;
                    Err(e)
                }
            }
        }
        "status" => {
            let name = options["task"].as_str().context("status requires --task")?;
            let status = options["status"]
                .as_str()
                .context("status requires --status")?;
            ensure!(store.set_task_status(name, status)?, "task not found");
            Ok(json!({"name":name,"status":status}))
        }
        "session-import" => {
            let name = options["task"]
                .as_str()
                .context("session-import requires --task")?;
            let file = state.root.join(
                options["file"]
                    .as_str()
                    .context("session-import requires --file")?,
            );
            let cfg = store.effective(&flows(state)?, state.db.path(), name)?;
            let cookies = acquisition::http_session::read_private(&file)?;
            acquisition::http_session::import(&cfg, &cookies).await?;
            Ok(json!({"name":name,"session":"imported_and_validated"}))
        }
        "run" => {
            let name = options["task"].as_str().context("run requires --task")?;
            let cfg = store.effective(&flows(state)?, state.db.path(), name)?;
            let count = Engine::new(store)?.run(&cfg).await?;
            Ok(json!({"name":name,"new_records":count}))
        }
        other => bail!("unknown acquisition operation: {other}"),
    }
}
