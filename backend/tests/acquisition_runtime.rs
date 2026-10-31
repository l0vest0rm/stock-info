use serde_json::json;
use stock_info_local::{AppState, acquisition_runtime, db::Database};

fn setup() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("stock-info.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().to_owned(), "127.0.0.1:18000".into()).unwrap();
    std::fs::create_dir_all(dir.path().join("config/acquisitions")).unwrap();
    (dir, state)
}
fn write_flow(state: &AppState, url: &str) {
    std::fs::write(state.root.join("config/acquisitions/fixture.yaml"),format!("schema_version: 2\nname: fixture\nsite: fixture\ntarget_kind: feed\ninput_fields: [feed]\nrequest: {{url: '{url}'}}\nruntime: {{type: http}}\nparser: {{format: json}}\nstorage: {{source: fixture, key_path: id}}\n")).unwrap();
}
#[test]
fn approved_schema_matches_crate_without_taking_over_host_version() {
    assert_eq!(
        include_str!("../../migrations/0149_acquisition.sql"),
        acquisition::SCHEMA_V1
    );
    assert!(
        include_str!("../../migrations/0150_compact_acquisition.sql")
            .contains(acquisition::CORE_SCHEMA)
    );
    let (_dir, state) = setup();
    let conn = state.db.connect().unwrap();
    assert_eq!(
        conn.query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "3.54.1"
    );
    let before: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    let store = acquisition_runtime::store(&state).unwrap();
    assert!(store.all_tasks().unwrap().is_empty());
    assert_eq!(
        conn.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        before
    );
    assert_eq!(
        state
            .db
            .migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap(),
        0
    );
    assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('articles','article_tags','article_publish_outbox')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}
#[tokio::test]
async fn local_api_and_real_http_collection_share_existing_database_and_restart_dedupe() {
    use axum::{Json, Router, routing::get};
    use tower::ServiceExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/news",
                get(|| async { Json(json!([{"id":1,"title":"fixture","content":"body"}])) }),
            ),
        )
        .await
        .unwrap();
    });
    let (dir, state) = setup();
    write_flow(&state, &format!("http://{address}/news"));
    state
        .db
        .put_kv("host-ledger", "sentinel", &json!({"preserve":true}), None)
        .await
        .unwrap();
    std::fs::write(dir.path().join("task.json"),json!({"name":"local-news","flow":"fixture","settings":{"interval":"1s"},"targets":[{"feed":"all"}]}).to_string()).unwrap();
    acquisition_runtime::command(&state, &json!({"operation":"put","file":"task.json"}))
        .await
        .unwrap();
    let listed = acquisition_runtime::command(&state, &json!({"operation":"list"}))
        .await
        .unwrap();
    assert_eq!(listed[0]["status"], "paused");
    assert_eq!(
        acquisition_runtime::command(&state, &json!({"operation":"run","task":"local-news"}))
            .await
            .unwrap()["new_records"],
        0
    );
    acquisition_runtime::command(
        &state,
        &json!({"operation":"status","task":"local-news","status":"active"}),
    )
    .await
    .unwrap();
    let jobs = acquisition_runtime::start(&state).unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if state
                .db
                .query("SELECT doc_id FROM knowledge_docs", vec![])
                .await
                .unwrap()
                .len()
                == 1
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    jobs.shutdown().await.unwrap();
    assert_eq!(
        acquisition_runtime::command(&state, &json!({"operation":"run","task":"local-news"}))
            .await
            .unwrap()["new_records"],
        0
    );
    let reopened = Database::open(state.db.path()).unwrap();
    assert_eq!(
        reopened
            .query(
                "SELECT inline_content,metadata_json FROM knowledge_docs",
                vec![]
            )
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        reopened.get_kv("host-ledger", "sentinel").await.unwrap(),
        Some(json!({"preserve":true}))
    );
    let response = stock_info_local::router(state.clone(), dir.path())
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/health")
                .header("host", "127.0.0.1:18000")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert!(!dir.path().join("sub2me.db").exists());
    assert_eq!(
        reopened
            .query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='acquisition_records'",
                vec![]
            )
            .await
            .unwrap()
            .len(),
        0
    );
    let docs = reopened
        .query(
            "SELECT inline_content,metadata_json FROM knowledge_docs",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(docs[0]["inline_content"], "body");
    let metadata: serde_json::Value =
        serde_json::from_str(docs[0]["metadata_json"].as_str().unwrap()).unwrap();
    assert_eq!(metadata["acquisition"]["raw"]["id"], 1);
    let id = reopened
        .query("SELECT doc_id FROM knowledge_docs", vec![])
        .await
        .unwrap()[0]["doc_id"]
        .as_str()
        .unwrap()
        .to_string();
    let response = stock_info_local::router(state.clone(), dir.path())
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/api/knowledge/doc?id={id}"))
                .header("host", "127.0.0.1:18000")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["data"]["content"], "body");
    server.abort();
}
#[tokio::test]
async fn invalid_target_registration_rolls_back_without_enabling_a_task() {
    let (dir, state) = setup();
    write_flow(&state, "https://example.com/news");
    std::fs::write(dir.path().join("bad.json"),json!({"name":"bad","flow":"fixture","settings":{"interval":"5m"},"targets":[{"wrong":"all"}]}).to_string()).unwrap();
    assert!(
        acquisition_runtime::command(&state, &json!({"operation":"put","file":"bad.json"}))
            .await
            .is_err()
    );
    assert!(
        acquisition_runtime::store(&state)
            .unwrap()
            .all_tasks()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn legacy_schema_upgrade_moves_results_without_losing_raw_tags_sessions_or_watermarks() {
    let dir = tempfile::tempdir().unwrap();
    let migrations = dir.path().join("migrations");
    std::fs::create_dir(&migrations).unwrap();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations");
    for entry in std::fs::read_dir(&root).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().is_some_and(|x| x == "sql")
            && p.file_name().unwrap() != "0150_compact_acquisition.sql"
        {
            std::fs::copy(&p, migrations.join(p.file_name().unwrap())).unwrap();
        }
    }
    let db = Database::open(dir.path().join("db")).unwrap();
    db.migrate(&migrations).unwrap();
    let conn = db.connect().unwrap();
    conn.execute_batch("INSERT INTO tasks(id,name,config_path,runtime_type,status,flow_id,settings_json,created_at,updated_at) VALUES(7,'old','flow.yaml','http','paused','fixture','{\"interval\":\"5m\"}','x','x');
    INSERT INTO acquisition_records(task_id,source,data_json,record_hash,content_json,created_at) VALUES(7,'old','{\"id\":1}','hash','{\"title\":\"title\",\"body\":\"body\",\"source_name\":\"source\"}','x');
    INSERT INTO acquisition_record_tags(record_id,key,value) VALUES(1,'topic','one');
    INSERT INTO acquisition_sessions(name,site,runtime_type,credential_json,created_at,updated_at) VALUES('session','site','http','{\"token\":\"private\"}','x','x');
    INSERT INTO acquisition_session_state(session_name,cache_key,state_json) VALUES('session','cache','{\"v\":1}');
    INSERT INTO acquisition_targets(id,site,kind,identity_key,input_json) VALUES(2,'site','user','user_id:123:','{\"user_id\":\"123\"}');
    INSERT INTO acquisition_task_targets VALUES(7,2,1);
    INSERT INTO acquisition_poll_watermarks VALUES(7,'scope',42);").unwrap();
    std::fs::copy(
        root.join("0150_compact_acquisition.sql"),
        migrations.join("0150_compact_acquisition.sql"),
    )
    .unwrap();
    assert_eq!(db.migrate(&migrations).unwrap(), 1);
    assert_eq!(db.migrate(&migrations).unwrap(), 0);
    let store = acquisition::Store::from_connection(db.connect().unwrap()).unwrap();
    assert!(store.is_compact());
    assert_eq!(store.poll_watermark(7, "scope").unwrap(), Some(42));
    assert_eq!(store.targets("old").unwrap()[0]["scope_id"], 2);
    assert_eq!(
        store.session_material("session").unwrap()["token"],
        "private"
    );
    let cache: String = conn
        .query_row("SELECT state_json FROM acquisition_sessions", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&cache).unwrap()["cache"]["v"],
        1
    );
    let meta: String = conn
        .query_row(
            "SELECT metadata_json FROM knowledge_docs WHERE doc_id='acq_7_hash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(meta["acquisition"]["raw"]["id"], 1);
    assert_eq!(meta["acquisition"]["tags"][0]["value"], "one");
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'acquisition_%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn explicit_handoff_is_idempotent_preserves_source_and_paused_tasks() {
    let (dir, state) = setup();
    write_flow(&state, "https://example.test/news");
    let source_path = dir.path().join("source.db");
    let source = acquisition::Store::open_legacy(&source_path).unwrap();
    let flows = acquisition::config::load_dir(&state.root.join("config/acquisitions")).unwrap();
    let settings = acquisition::control::TaskSettings {
        interval: "5m".into(),
        session: None,
        proxy: None,
        application: None,
        source: Some("example".into()),
    };
    source.put_task(&flows[0], "handoff", &settings).unwrap();
    source
        .target_add(&flows[0], "handoff", &json!({"feed":"all"}))
        .unwrap();
    for _ in 0..2 {
        let result = acquisition_runtime::command(
            &state,
            &json!({"operation":"import-sub2me","file":source_path}),
        )
        .await
        .unwrap();
        assert_eq!(result["tasks"][0]["status"], "paused");
        assert_eq!(result["publication_imported"], false);
    }
    let destination = acquisition_runtime::store(&state).unwrap();
    assert_eq!(destination.all_tasks().unwrap().len(), 1);
    assert_eq!(destination.targets("handoff").unwrap().len(), 1);
    assert_eq!(source.all_tasks().unwrap()[0]["status"], "paused");
    assert_eq!(source.targets("handoff").unwrap().len(), 1);
}

#[tokio::test]
async fn shutdown_commits_current_input_and_restart_resumes_remaining_inputs() {
    shutdown_resume_scenario(false).await;
}

#[tokio::test]
async fn changed_flow_invalidates_partial_workflow_cursor() {
    shutdown_resume_scenario(true).await;
}

async fn shutdown_resume_scenario(change_flow: bool) {
    use axum::{Json, Router, extract::Query, routing::get};
    use std::sync::{Arc, Mutex};
    use tokio::sync::Notify;
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let router = Router::new()
        .route(
            "/groups",
            get(|| async { Json(json!([{"group":"g","symbols":["a","b","c"]}])) }),
        )
        .route(
            "/list",
            get({
                let seen = seen.clone();
                move |Query(q): Query<std::collections::HashMap<String, String>>| {
                    let seen = seen.clone();
                    async move {
                        seen.lock().unwrap().push(q["symbol"].clone());
                        Json(json!([{"id":q["symbol"]}]))
                    }
                }
            }),
        )
        .route(
            "/detail",
            get({
                let entered = entered.clone();
                let release = release.clone();
                move |Query(q): Query<std::collections::HashMap<String, String>>| {
                    let entered = entered.clone();
                    let release = release.clone();
                    async move {
                        if q["id"] == "a" {
                            entered.notify_one();
                            release.notified().await;
                        }
                        Json(json!({"id":q["id"],"title":"fixture","content":"body"}))
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (_dir, state) = setup();
    std::fs::write(
        state.root.join("config/acquisitions/fixture.yaml"),
        format!(
            r#"
name: fixture
schedule: {{interval: 1h}}
request: {{url: "http://{address}/groups"}}
runtime: {{type: http}}
parser: {{format: json}}
storage: {{source: fixture, key_path: id}}
workflow:
  inputs: {{filter_path: group, filter_values: [g], values_path: symbols, variable: symbol}}
  list:
    request: {{url: "http://{address}/list", query: {{symbol: "{{{{input.symbol}}}}"}}}}
    parser: {{format: json}}
  detail:
    request: {{url: "http://{address}/detail", query: {{id: "{{{{item.id}}}}"}}}}
    parser: {{format: json}}
"#
        ),
    )
    .unwrap();
    let flow = acquisition::config::load_dir(&state.root.join("config/acquisitions"))
        .unwrap()
        .remove(0);
    acquisition_runtime::store(&state)
        .unwrap()
        .sync_task(&flow)
        .unwrap();
    acquisition_runtime::store(&state)
        .unwrap()
        .target_add(&flow, "fixture", &json!({"group_id":"g"}))
        .unwrap();
    let jobs = acquisition_runtime::start(&state).unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    jobs.request_stop();
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), jobs.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["a"]);
    let rows = state
        .db
        .query("SELECT doc_id FROM knowledge_docs", vec![])
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "current input must commit before shutdown returns"
    );
    let store = acquisition_runtime::store(&state).unwrap();
    assert_eq!(store.all_runs(None).unwrap()[0]["status"], "interrupted");
    // Resume at the next due period, not on every service restart. Move only
    // this isolated fixture's attempt start into the past to reach eligibility.
    let due_start = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
    state
        .db
        .connect()
        .unwrap()
        .execute("UPDATE acquisition_runs SET started_at=?1", [&due_start])
        .unwrap();
    if change_flow {
        let path = state.root.join("config/acquisitions/fixture.yaml");
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("\ncontent: {source_name: changed-source}\n");
        std::fs::write(path, body).unwrap();
        release.notify_one();
        let jobs = acquisition_runtime::start(&state).unwrap().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if state
                    .db
                    .query("SELECT doc_id FROM knowledge_docs", vec![])
                    .await
                    .unwrap()
                    .len()
                    == 3
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        jobs.shutdown().await.unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["a", "a", "b", "c"],
            "changed flow must not skip inputs using an old cursor"
        );
        assert_eq!(store.all_runs(None).unwrap()[0]["status"], "success");
        server.abort();
        return;
    }
    // An isolated host write rejection must not advance the input cursor.
    state.db.connect().unwrap().execute_batch("CREATE TRIGGER reject_fixture_b AFTER INSERT ON knowledge_docs WHEN json_extract(NEW.metadata_json,'$.acquisition.raw.id')='b' BEGIN SELECT RAISE(ABORT,'fixture host write rejected'); END;").unwrap();
    let failing_jobs = acquisition_runtime::start(&state).unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store.all_runs(None).unwrap()[0]["status"] == "failed" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    failing_jobs.shutdown().await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["a", "b"]);
    assert_eq!(
        state
            .db
            .query("SELECT doc_id FROM knowledge_docs", vec![])
            .await
            .unwrap()
            .len(),
        1
    );
    state
        .db
        .connect()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_fixture_b")
        .unwrap();
    // A failed attempt is throttled too; advance to its next eligible period.
    state
        .db
        .connect()
        .unwrap()
        .execute("UPDATE acquisition_runs SET started_at=?1", [&due_start])
        .unwrap();
    let jobs = acquisition_runtime::start(&state).unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if state
                .db
                .query("SELECT doc_id FROM knowledge_docs", vec![])
                .await
                .unwrap()
                .len()
                == 3
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    jobs.shutdown().await.unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["a", "b", "b", "c"],
        "restart skips committed a but must retry rejected b"
    );
    assert_eq!(store.all_runs(None).unwrap()[0]["status"], "success");
    // A completed cursor starts a fresh cycle at its next due period,
    // rather than suppressing updates forever or replaying on restart.
    state
        .db
        .connect()
        .unwrap()
        .execute("UPDATE acquisition_runs SET started_at=?1", [&due_start])
        .unwrap();
    release.notify_one();
    let jobs = acquisition_runtime::start(&state).unwrap().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if seen.lock().unwrap().len() == 7
                && store.all_runs(None).unwrap()[0]["status"] == "success"
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    jobs.shutdown().await.unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["a", "b", "b", "c", "a", "b", "c"]
    );
    assert_eq!(
        state
            .db
            .query("SELECT doc_id FROM knowledge_docs", vec![])
            .await
            .unwrap()
            .len(),
        3
    );
    server.abort();
}

#[tokio::test]
async fn restart_respects_persisted_period_and_interval_edits_without_replaying_missed_rounds() {
    use axum::{Json, Router, routing::get};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::Duration;
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/news",
                get(move || {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        Json(json!([{"id":1,"title":"fixture","content":"body"}]))
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let (_dir, state) = setup();
    write_flow(&state, &format!("http://{address}/news"));
    std::fs::write(
        state.root.join("task.json"),
        json!({"name":"periodic","flow":"fixture","settings":{},"targets":[{"feed":"all"}]})
            .to_string(),
    )
    .unwrap();
    acquisition_runtime::command(&state, &json!({"operation":"put","file":"task.json"}))
        .await
        .unwrap();
    acquisition_runtime::command(
        &state,
        &json!({"operation":"status","task":"periodic","status":"active"}),
    )
    .await
    .unwrap();
    // Never-run tasks are immediately eligible, with the new default period.
    let scheduler = acquisition_runtime::start(&state).unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    scheduler.shutdown().await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    // All attempt outcomes throttle retries, not just successful attempts.
    for status in ["success", "failed", "interrupted", "running"] {
        state
            .db
            .connect()
            .unwrap()
            .execute("UPDATE acquisition_runs SET status=?1", [status])
            .unwrap();
        let scheduler = acquisition_runtime::start(&state).unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(1150)).await;
        scheduler.shutdown().await.unwrap();
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "restart repeated {status}"
        );
    }
    // Period edits are read without restart: 2-hour-old history was overdue,
    // increasing to 1 day delays it; reducing to 1 minute releases one round.
    let old = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
    state
        .db
        .connect()
        .unwrap()
        .execute("UPDATE acquisition_runs SET started_at=?1", [&old])
        .unwrap();
    state
        .db
        .connect()
        .unwrap()
        .execute(
            "UPDATE acquisition_tasks SET config_json=json_set(config_json,'$.interval','1d')",
            [],
        )
        .unwrap();
    let scheduler = acquisition_runtime::start(&state).unwrap().unwrap();
    tokio::time::sleep(Duration::from_millis(1150)).await;
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    state
        .db
        .connect()
        .unwrap()
        .execute(
            "UPDATE acquisition_tasks SET config_json=json_set(config_json,'$.interval','1m')",
            [],
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    scheduler.shutdown().await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        2,
        "missed periods must coalesce"
    );
    server.abort();
}
