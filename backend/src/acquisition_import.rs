//! Explicit local handoff of acquisition tasks only; no articles or publication queues.
use acquisition::{Store, config::Acquisition};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

pub fn import(
    store: &Store,
    flows: &[Acquisition],
    source: &Path,
    destination: &Path,
) -> Result<Value> {
    ensure!(
        source.canonicalize()? != destination.canonicalize()?,
        "source and destination must differ"
    );
    let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    conn.execute_batch("BEGIN DEFERRED")?;
    let source = Store::from_connection(conn)?;
    let definitions = source.task_definitions()?;
    // Validate all flows before writing anything. The caller explicitly requests this operation.
    for (_, flow, _, _) in &definitions {
        ensure!(
            flows.iter().any(|f| &f.name == flow),
            "missing flow: {flow}"
        );
    }
    store
        .conn()
        .execute_batch("SAVEPOINT acquisition_handoff")?;
    let result = (|| {
        let mut report = vec![];
        for (name, flow, status, settings) in definitions {
            let flow = flows.iter().find(|f| f.name == flow).unwrap();
            let task = store.put_task(flow, &name, &settings)?;
            let targets = source.targets(&name)?;
            let mut ids = HashMap::new();
            for target in &targets {
                let id = store.target_add(flow, &name, &target["input"])?;
                ids.insert(target["id"].as_i64().context("source target id")?, id);
                store.target_set_enabled(&name, id, target["enabled"] == true)?;
            }
            if let Some(session) = &settings.session {
                let old = source.conn();
                let (site,runtime,credentials,expires):(String,String,String,Option<String>)=old.query_row("SELECT site,runtime_type,credential_json,expires_at FROM acquisition_sessions WHERE name=?1",[session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).with_context(||format!("bound session missing for task {name}"))?;
                store.upsert_session(
                    session,
                    &site,
                    &runtime,
                    &serde_json::from_str(&credentials)?,
                    expires.as_deref(),
                )?;
                let states: Vec<(String, String)> = if source.is_compact() {
                    let raw: String = old.query_row(
                        "SELECT state_json FROM acquisition_sessions WHERE name=?1",
                        [session],
                        |r| r.get(0),
                    )?;
                    let state: Value = serde_json::from_str(&raw)?;
                    state
                        .as_object()
                        .context("invalid session state")?
                        .iter()
                        .map(|(k, v)| (k.clone(), v.to_string()))
                        .collect()
                } else {
                    let mut q=old.prepare("SELECT cache_key,state_json FROM acquisition_session_state WHERE session_name=?1")?;
                    q.query_map([session], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                };
                drop(old);
                for (key, value) in states {
                    crate_state(store, session, &key, &serde_json::from_str(&value)?)?;
                }
            }
            let old_cfg = source.effective(flows, Path::new("unused"), &name)?;
            let cfg = store.effective(flows, destination, &name)?;
            let old_task = source.sync_task(&old_cfg)?;
            if let Some(p) = &flow.polling {
                for target in &targets {
                    let mut old = target["input"].clone();
                    old["_target_id"] = target["id"].clone();
                    if let Some(scope) = target.get("scope_id") {
                        old["_scope_id"] = scope.clone();
                    }
                    let mut new = old.clone();
                    new.as_object_mut().unwrap().remove("_scope_id");
                    new["_target_id"] = json!(ids[&target["id"].as_i64().unwrap()]);
                    for stream in &p.streams {
                        let old_scope = acquisition::polling::scope_key(&old, stream)?;
                        if let Some(w) = source.poll_watermark(old_task, &old_scope)? {
                            store.save_poll_watermark(
                                task,
                                &acquisition::polling::scope_key(&new, stream)?,
                                w,
                            )?;
                        }
                    }
                }
            }
            if flow.feed.is_some()
                && let Some(w) =
                    source.poll_watermark(old_task, &acquisition::feed::scope_key(&old_cfg)?)?
            {
                store.save_poll_watermark(task, &acquisition::feed::scope_key(&cfg)?, w)?;
            }
            // Pagination progress must not depend on having a shadow records table.
            if let Some(p) = &cfg.pagination
                && let Some(w) = source.latest_numeric_field(old_task, &p.cursor_path)?
            {
                let path = format!("$.pagination.{}", serde_json::to_string(&p.cursor_path)?);
                store.conn().execute("UPDATE acquisition_tasks SET state_json=json_set(state_json,?1,?2) WHERE id=?3",params![path,w,task])?;
            }
            store.set_task_status(&name, &status)?;
            report.push(json!({"name":name,"status":status,"targets":targets.len()}));
        }
        Ok::<_, anyhow::Error>(
            json!({"tasks":report,"publication_imported":false,"historical_records_imported":false}),
        )
    })();
    if result.is_ok() {
        store.conn().execute_batch("RELEASE acquisition_handoff")?;
    } else {
        store
            .conn()
            .execute_batch("ROLLBACK TO acquisition_handoff; RELEASE acquisition_handoff")?;
    }
    result
}
fn crate_state(store: &Store, name: &str, key: &str, value: &Value) -> Result<()> {
    let raw: String = store.conn().query_row(
        "SELECT state_json FROM acquisition_sessions WHERE name=?1",
        [name],
        |r| r.get(0),
    )?;
    let mut state: Value = serde_json::from_str(&raw)?;
    state[key] = value.clone();
    store.conn().execute(
        "UPDATE acquisition_sessions SET state_json=?1 WHERE name=?2",
        params![state.to_string(), name],
    )?;
    Ok(())
}
