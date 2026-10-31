use super::*;
use crate::db::Database;
use rusqlite::{OptionalExtension, params};

fn load(tx: &rusqlite::Transaction<'_>, ns: &str, key: &str) -> Result<Option<Value>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv_cache WHERE namespace=? AND key=?",
            params![ns, key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
fn put(tx: &rusqlite::Transaction<'_>, ns: &str, key: &str, v: &Value) -> Result<()> {
    tx.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,NULL,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json, expires_at=NULL,updated_at=excluded.updated_at",params![ns,key,v.to_string(),now()])?;
    Ok(())
}
fn bump(v: &mut Value) {
    v["revision"] = json!(v["revision"].as_i64().unwrap_or(0) + 1);
    v["updatedAt"] = json!(now().max(v["updatedAt"].as_i64().unwrap_or(0) + 1));
}
// Admission and business binding are separate commits. A failed HTTP write
// must neither send a prompt nor permanently prevent a later explicit retry.
fn expire_unbound(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let rows = {
        let mut stmt = tx.prepare("SELECT value_json FROM kv_cache WHERE namespace=? AND json_extract(value_json,'$.status')='queued' AND json_extract(value_json,'$.createdAt')<?")?;
        stmt.query_map(params![RUNS, now() - 120_000], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for raw in rows {
        let mut v: Value = serde_json::from_str(&raw)?;
        if !v["checkpoint"].is_null() {
            continue;
        }
        let bound = load(
            tx,
            text(&v["binding"]["namespace"]),
            text(&v["binding"]["key"]),
        )?;
        if bound
            .as_ref()
            .is_some_and(|b| b["task"]["runId"] == v["runId"])
        {
            continue;
        }
        v["status"] = json!("interrupted");
        v["completedAt"] = json!(now());
        v["errorMessage"] = json!("业务记录未绑定，已取消未派发的执行；可以重新提交。");
        bump(&mut v);
        put(tx, RUNS, text(&v["runId"]), &v)?;
    }
    Ok(())
}
pub async fn admit(db: &Database, mut v: Value) -> Result<Value> {
    db.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        expire_unbound(&tx)?;
        let active: i64 = tx.query_row("SELECT count(*) FROM kv_cache WHERE namespace=? AND json_extract(value_json,'$.name')=? AND json_extract(value_json,'$.status') IN ('queued','running')",params![RUNS,text(&v["name"])],|r|r.get(0))?;
        ensure!(active == 0,"this business already has an accepted local workflow; sync or recover it instead of resubmitting");
        let max_created: Option<i64> = tx.query_row("SELECT max(json_extract(value_json,'$.createdAt')) FROM kv_cache WHERE namespace=?",[RUNS],|r|r.get(0))?;
        let timestamp = now().max(max_created.unwrap_or(0)+1);
        v["createdAt"] = json!(timestamp); v["updatedAt"] = json!(timestamp);
        put(&tx,RUNS,text(&v["runId"]),&v)?; tx.commit()?; Ok(v)
    }).await
}
pub async fn queue_recovery(db: &Database, expected: &Value) -> Result<Value> {
    let expected = expected.clone();
    db.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut v = load(&tx, RUNS, text(&expected["runId"]))?.context("execution not found")?;
        ensure!(
            v["revision"] == expected["revision"]
                && matches!(text(&v["status"]), "failed" | "interrupted" | "succeeded"),
            "execution changed during recovery"
        );
        let binding = load(
            &tx,
            text(&v["binding"]["namespace"]),
            text(&v["binding"]["key"]),
        )?;
        ensure!(
            binding
                .as_ref()
                .is_some_and(|b| b["task"]["runId"] == v["runId"]),
            "cannot recover a superseded business execution"
        );
        v["resultReplayOnly"] = json!(v["status"] == "succeeded" || v["resultReplayOnly"] == true);
        v["cancelRequested"] = json!(false);
        v["status"] = json!("queued");
        v["recoveryRequired"] = json!(true);
        v["completedAt"] = Value::Null;
        v["errorMessage"] = Value::Null;
        bump(&mut v);
        put(&tx, RUNS, text(&v["runId"]), &v)?;
        tx.commit()?;
        Ok(v)
    })
    .await
}

#[derive(Clone)]
pub(crate) struct Claim {
    pub run: Value,
    pub owner: String,
    pub slot: String,
    pub token: i64,
}
const LEASE_MS: i64 = 60_000;
fn slot(v: &Value) -> String {
    hash(format!("{}\n{}", text(&v["endpoint"]), text(&v["profile"])).as_bytes())
}

pub async fn claim(db: &Database) -> Result<Option<Claim>> {
    db.run(move |conn| {
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        expire_unbound(&tx)?;
        let rows = {
            let mut stmt=tx.prepare("SELECT r.value_json FROM kv_cache r WHERE r.namespace=? AND json_extract(r.value_json,'$.status') IN ('queued','running') AND EXISTS (SELECT 1 FROM kv_cache b WHERE b.namespace=json_extract(r.value_json,'$.binding.namespace') AND b.key=json_extract(r.value_json,'$.binding.key') AND json_extract(b.value_json,'$.task.runId')=json_extract(r.value_json,'$.runId')) ORDER BY json_extract(r.value_json,'$.createdAt') LIMIT 100")?;
            stmt.query_map([RUNS],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for raw in rows {
            let mut v: Value=serde_json::from_str(&raw)?;
            let bound=load(&tx,text(&v["binding"]["namespace"]),text(&v["binding"]["key"]))?;
            if !bound.as_ref().is_some_and(|b| b["task"]["runId"] == v["runId"]) { continue; }
            let key=slot(&v);
            let lease=load(&tx,LEASES,&key)?.unwrap_or(json!({"fencingToken":0}));
            if lease["leaseUntil"].as_i64().unwrap_or(0)>now() {continue;}
            // A crashed runner without a durable cursor cannot be safely replayed.
            if v["status"]=="running" && v["checkpoint"].is_null() {
                v["status"]=json!("failed"); v["recoveryRequired"]=json!(true); v["completedAt"]=json!(now());
                v["errorMessage"]=json!("执行进程中断且没有已确认 checkpoint；为避免重复提交，请人工核对。");
                bump(&mut v); put(&tx,RUNS,text(&v["runId"]),&v)?; continue;
            }
            let owner=uuid::Uuid::new_v4().to_string();
            let token=lease["fencingToken"].as_i64().unwrap_or(0)+1;
            let lease=json!({"owner":owner,"fencingToken":token,"leaseUntil":now()+LEASE_MS,"runId":v["runId"],"retention":"durable"});
            put(&tx,LEASES,&key,&lease)?;
            v["status"]=json!("running"); v["owner"]=json!(owner); v["fencingToken"]=json!(token); v["leaseUntil"]=lease["leaseUntil"].clone();
            bump(&mut v); put(&tx,RUNS,text(&v["runId"]),&v)?;
            tx.commit()?; return Ok(Some(Claim{run:v,owner,slot:key,token}));
        }
        tx.commit()?; Ok(None)
    }).await
}

/// Every callback and terminal write checks the current lease inside the write
/// transaction. A stale worker can neither acknowledge a checkpoint nor publish.
pub async fn update(db: &Database, claim: &Claim, patch: Value, terminal: bool) -> Result<()> {
    let claim = claim.clone();
    db.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut lease = load(&tx, LEASES, &claim.slot)?.context("workflow lease missing")?;
        ensure!(
            lease["owner"] == claim.owner
                && lease["fencingToken"] == claim.token
                && lease["leaseUntil"].as_i64().unwrap_or(0) > now(),
            "workflow lease lost; action dispatch stopped"
        );
        let mut v = load(&tx, RUNS, text(&claim.run["runId"]))?.context("workflow run missing")?;
        ensure!(
            v["owner"] == claim.owner
                && v["fencingToken"] == claim.token
                && v["status"] == "running",
            "workflow owner changed"
        );
        for (k, value) in patch.as_object().context("invalid execution patch")? {
            v[k] = value.clone();
        }
        lease["leaseUntil"] = json!(if terminal { 0 } else { now() + LEASE_MS });
        v["leaseUntil"] = lease["leaseUntil"].clone();
        bump(&mut v);
        put(&tx, RUNS, text(&v["runId"]), &v)?;
        put(&tx, LEASES, &claim.slot, &lease)?;
        tx.commit()?;
        Ok(())
    })
    .await
}

pub async fn cancel(db: &Database, run: &Value) -> Result<()> {
    let id = text(&run["runId"]).to_string();
    db.run(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut v = load(&tx, RUNS, &id)?.context("execution not found")?;
        if v["status"] == "queued" {
            v["status"] = json!("interrupted");
            v["completedAt"] = json!(now());
        }
        if v["status"] == "running" || v["status"] == "interrupted" {
            v["cancelRequested"] = json!(true);
            bump(&mut v);
            put(&tx, RUNS, &id, &v)?;
        }
        tx.commit()?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("test.sqlite")).unwrap();
        db.migrate(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        (dir, db)
    }
    use std::path::Path;
    fn run(name: &str) -> Value {
        let (namespace, key) = binding(name).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        json!({"runId":id,"taskId":id,"engine":"cea","name":name,"status":"queued","revision":1,"binding":{"namespace":namespace,"key":key},"createdAt":now(),"updatedAt":now(),"endpoint":"ws://127.0.0.1:9876/api/v1/ws","profile":"test","checkpoint":null,"retention":"durable"})
    }
    async fn bind(db: &Database, v: &Value) {
        db.put_kv(
            text(&v["binding"]["namespace"]),
            text(&v["binding"]["key"]),
            &json!({"task":task_view(v)}),
            None,
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn admission_deduplicates_concurrent_business_submissions() {
        let (_dir, db) = setup();
        let input = run("macro:analysis:global");
        let (a, b) = tokio::join!(admit(&db, input.clone()), admit(&db, input));
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(
            db.query(
                "SELECT count(*) AS n FROM kv_cache WHERE namespace=?",
                vec![RUNS.into()]
            )
            .await
            .unwrap()[0]["n"],
            1
        );
        assert!(
            db.query(
                "SELECT expires_at FROM kv_cache WHERE namespace=?",
                vec![RUNS.into()]
            )
            .await
            .unwrap()[0]["expires_at"]
                .is_null()
        );
    }
    #[tokio::test]
    async fn unbound_admission_never_dispatches_and_profile_lease_serializes() {
        let (_dir, db) = setup();
        let a = admit(&db, run("macro:analysis:global")).await.unwrap();
        assert!(claim(&db).await.unwrap().is_none());
        bind(&db, &a).await;
        let first = claim(&db).await.unwrap().unwrap();
        let b = admit(&db, run("research:financial-analysis:600036.SH"))
            .await
            .unwrap();
        bind(&db, &b).await;
        assert!(claim(&db).await.unwrap().is_none());
        update(&db, &first, json!({"status":"succeeded"}), true)
            .await
            .unwrap();
        assert_eq!(claim(&db).await.unwrap().unwrap().run["runId"], b["runId"]);
    }
    #[tokio::test]
    async fn abandoned_unbound_admission_expires_without_dispatch_and_allows_retry() {
        let (_dir, db) = setup();
        let a = admit(&db, run("macro:analysis:global")).await.unwrap();
        db.execute(
            "UPDATE kv_cache SET value_json=json_set(value_json,'$.createdAt',0) WHERE namespace=?",
            vec![RUNS.into()],
        )
        .await
        .unwrap();
        assert!(claim(&db).await.unwrap().is_none());
        let old = db.get_kv(RUNS, text(&a["runId"])).await.unwrap().unwrap();
        assert_eq!(old["status"], "interrupted");
        assert!(old["checkpoint"].is_null());
        assert!(admit(&db, run("macro:analysis:global")).await.is_ok());
    }
    #[tokio::test]
    async fn expired_runner_without_checkpoint_fails_closed_and_stale_writer_is_fenced() {
        let (_dir, db) = setup();
        let a = admit(&db, run("macro:analysis:global")).await.unwrap();
        bind(&db, &a).await;
        let first = claim(&db).await.unwrap().unwrap();
        db.execute("UPDATE kv_cache SET value_json=json_set(value_json,'$.leaseUntil',0) WHERE namespace=?",vec![LEASES.into()]).await.unwrap();
        assert!(claim(&db).await.unwrap().is_none());
        assert!(
            update(
                &db,
                &first,
                json!({"checkpoint":{"untrusted":"old"}}),
                false
            )
            .await
            .is_err()
        );
        let v = db.get_kv(RUNS, text(&a["runId"])).await.unwrap().unwrap();
        assert_eq!(v["status"], "failed");
        assert!(v["checkpoint"].is_null());
        assert_eq!(v["recoveryRequired"], true);
    }
    #[tokio::test]
    async fn cancellation_does_not_claim_to_retract_provider_work() {
        let (_dir, db) = setup();
        let a = admit(&db, run("macro:analysis:global")).await.unwrap();
        bind(&db, &a).await;
        cancel(&db, &a).await.unwrap();
        assert!(claim(&db).await.unwrap().is_none());
        assert_eq!(
            db.get_kv(RUNS, text(&a["runId"])).await.unwrap().unwrap()["status"],
            "interrupted"
        );
    }
    #[tokio::test]
    async fn completed_result_retry_is_fenced_and_marked_receipt_only() {
        let (_dir, db) = setup();
        let a = admit(&db, run("macro:analysis:global")).await.unwrap();
        bind(&db, &a).await;
        let first = claim(&db).await.unwrap().unwrap();
        update(
            &db,
            &first,
            json!({"status":"succeeded","result":{"retained":true}}),
            true,
        )
        .await
        .unwrap();
        let done = db.get_kv(RUNS, text(&a["runId"])).await.unwrap().unwrap();
        let retry = queue_recovery(&db, &done).await.unwrap();
        assert_eq!(retry["resultReplayOnly"], true);
        assert_eq!(retry["result"]["retained"], true);
        assert!(queue_recovery(&db, &done).await.is_err());
        let next = claim(&db).await.unwrap().unwrap();
        assert!(next.token > first.token);
        assert_eq!(next.run["resultReplayOnly"], true);
    }
    #[tokio::test]
    async fn superseded_business_cannot_recover_an_old_run() {
        let (_dir, db) = setup();
        let a = admit(&db, run("macro:analysis:global")).await.unwrap();
        bind(&db, &a).await;
        let first = claim(&db).await.unwrap().unwrap();
        update(&db, &first, json!({"status":"failed"}), true)
            .await
            .unwrap();
        let failed = db.get_kv(RUNS, text(&a["runId"])).await.unwrap().unwrap();
        let b = admit(&db, run("macro:analysis:global")).await.unwrap();
        bind(&db, &b).await;
        assert!(queue_recovery(&db, &failed).await.is_err());
        assert_eq!(claim(&db).await.unwrap().unwrap().run["runId"], b["runId"]);
    }
    #[tokio::test]
    async fn checkpoint_write_failure_prevents_acknowledgement_and_new_owner_wins() {
        let (_dir, db) = setup();
        let a = admit(&db, run("macro:analysis:global")).await.unwrap();
        bind(&db, &a).await;
        let first = claim(&db).await.unwrap().unwrap();
        update(
            &db,
            &first,
            json!({"checkpoint":{"opaque":"stored"}}),
            false,
        )
        .await
        .unwrap();
        db.execute("UPDATE kv_cache SET value_json=json_set(value_json,'$.leaseUntil',0) WHERE namespace=?",vec![LEASES.into()]).await.unwrap();
        let second = claim(&db).await.unwrap().unwrap();
        assert!(second.token > first.token);
        assert!(
            update(&db, &first, json!({"result":"stale"}), true)
                .await
                .is_err()
        );
        update(
            &db,
            &second,
            json!({"status":"succeeded","result":"current"}),
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            db.get_kv(RUNS, text(&a["runId"])).await.unwrap().unwrap()["result"],
            "current"
        );
    }
}
