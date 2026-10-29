use anyhow::Result;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use stock_info_local::{AppState, dashboard, db::Database};
use tempfile::TempDir;
use tokio::sync::Notify;
use tower::ServiceExt;

fn fixture() -> (TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("config/generated")).unwrap();
    let companies=["600036.SH","600519.SH","000001.SZ"].iter().map(|code|json!({"id":code,"displayName":code,"classificationStatus":"verified","preferredMarket":"CN","preferredTicker":code,"securities":[{"ticker":code,"market":"CN"}]})).collect::<Vec<_>>();
    std::fs::write(
        root.join("config/investment-universe.json"),
        json!({"companies":companies}).to_string(),
    )
    .unwrap();
    std::fs::write(
        root.join("config/generated/valuation-revision.json"),
        json!({"revision":"a".repeat(64)}).to_string(),
    )
    .unwrap();
    std::fs::write(
        root.join("config/investment-opportunity-policy.json"),
        json!({"version":"fixture-policy"}).to_string(),
    )
    .unwrap();
    let db = Database::open(root.join("test.sqlite")).unwrap();
    db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, root.to_path_buf(), "127.0.0.1:8000".into()).unwrap();
    (dir, state)
}

fn row(target: &Value, version: i64) -> Value {
    json!({"code":target["code"],"executable":false,"verdict":"blocked","blockReasons":["request_failed"],"opportunity":{"policyVersion":"fixture-policy"},"note":"fixture","researchVersion":version})
}

async fn wait_for(calls: &AtomicUsize, n: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) != n {
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("fixture computation barrier");
}

fn held(
    state: AppState,
    code: &'static str,
    calls: Arc<AtomicUsize>,
    gate: Arc<Notify>,
) -> tokio::task::JoinHandle<Result<Option<Value>>> {
    tokio::spawn(async move {
        dashboard::refresh_with(&state, code, move |_, target| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            gate.notified().await;
            Ok(row(&target, 0))
        })
        .await
    })
}

#[tokio::test]
async fn real_sqlite_cache_leases_fencing_reuse_and_research_revision() {
    let (_dir, state) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let empty = dashboard::read(&state).await.unwrap();
    assert_eq!(empty["rows"], json!([]));
    assert_eq!(empty["pending"].as_array().unwrap().len(), 3);
    assert_eq!(
        state
            .db
            .query("SELECT * FROM kv_cache", vec![])
            .await
            .unwrap()
            .len(),
        0,
        "GET does not write"
    );
    assert!(
        dashboard::refresh_with(&state, "INVALID", |_, _| async {
            panic!("must not compute");
            #[allow(unreachable_code)]
            Ok(Value::Null)
        })
        .await
        .unwrap()
        .is_none()
    );
    let gate_a = Arc::new(Notify::new());
    let gate_b = Arc::new(Notify::new());
    let a = held(state.clone(), "600036.SH", calls.clone(), gate_a.clone());
    wait_for(&calls, 1).await;
    let busy = dashboard::refresh_with(&state, "600036.SH", |_, _| async {
        panic!("same security must be single-flight");
        #[allow(unreachable_code)]
        Ok(Value::Null)
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(busy["state"], "busy");
    let b = held(state.clone(), "600519.SH", calls.clone(), gate_b.clone());
    wait_for(&calls, 2).await;
    let busy = dashboard::refresh_with(&state, "000001.SZ", |_, _| async {
        panic!("global two-slot limit");
        #[allow(unreachable_code)]
        Ok(Value::Null)
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(busy["state"], "busy");
    gate_a.notify_one();
    gate_b.notify_one();
    let first = a.await.unwrap().unwrap().unwrap();
    b.await.unwrap().unwrap();
    let reused = dashboard::refresh_with(&state, "600036.SH", |_, _| async {
        panic!("fresh row must reuse");
        #[allow(unreachable_code)]
        Ok(Value::Null)
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        reused["row"]["computation"]["id"],
        first["row"]["computation"]["id"]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let computed_calls = calls.clone();
    let full = dashboard::refresh_batch_with(&state, 2, move |_, target| {
        let calls = computed_calls.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(row(&target, 0))
        }
    })
    .await
    .unwrap();
    assert_eq!(full["rows"].as_array().unwrap().len(), 3);
    assert_eq!(full["stale"], false);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    dashboard::refresh_batch_with(&state, 2, |_, _| async {
        panic!("fresh batch no-op");
        #[allow(unreachable_code)]
        Ok(Value::Null)
    })
    .await
    .unwrap();
    assert_eq!(full["blockedDetail"]["request_failed"], 3);
    assert_eq!(
        state
            .db
            .query(
                "SELECT * FROM kv_cache WHERE namespace='valuation-screen-v4-lease'",
                vec![]
            )
            .await
            .unwrap()
            .len(),
        0
    );
    let mut changed = first["row"].clone();
    changed["computation"]["revision"] = json!("old");
    state.db.execute("UPDATE kv_cache SET value_json=? WHERE namespace='valuation-screen-v5' AND key='600036.SH'",vec![changed.to_string().into()]).await.unwrap();
    assert_eq!(
        dashboard::read(&state).await.unwrap()["rows"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let gate = Arc::new(Notify::new());
    let old = held(state.clone(), "600036.SH", calls.clone(), gate.clone());
    wait_for(&calls, 4).await;
    state.db.execute("UPDATE kv_cache SET value_json='new-owner' WHERE namespace='valuation-screen-v4-lease' AND key='security:600036.SH'",vec![]).await.unwrap();
    gate.notify_one();
    let error = old.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("租约已过期"));
    let remaining=state.db.query("SELECT value_json FROM kv_cache WHERE namespace='valuation-screen-v4-lease' AND key='security:600036.SH'",vec![]).await.unwrap();
    assert_eq!(
        remaining[0]["value_json"], "new-owner",
        "old owner cannot release successor lease"
    );
    state
        .db
        .execute(
            "DELETE FROM kv_cache WHERE namespace='valuation-screen-v4-lease'",
            vec![],
        )
        .await
        .unwrap();
    let error = dashboard::refresh_with(&state, "600036.SH", |_, _| async {
        anyhow::bail!("fixture storage failure")
    })
    .await
    .unwrap_err();
    assert!(error.to_string().contains("fixture storage failure"));
    assert!(
        state
            .db
            .query(
                "SELECT * FROM kv_cache WHERE namespace='valuation-screen-v4-lease'",
                vec![]
            )
            .await
            .unwrap()
            .is_empty()
    );
    state.db.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES('valuation-screen-v4-lease','slot:0','expired',0,0)",vec![]).await.unwrap();
    dashboard::refresh_with(&state, "600036.SH", |_, target| async move {
        Ok(row(&target, 0))
    })
    .await
    .unwrap();
    assert_eq!(dashboard::read(&state).await.unwrap()["stale"], false);
    state
        .db
        .execute("DELETE FROM kv_cache", vec![])
        .await
        .unwrap();
    let bounded =
        dashboard::refresh_batch_with(&state, 2, |_, target| async move { Ok(row(&target, 0)) })
            .await
            .unwrap();
    assert_eq!(bounded["rows"].as_array().unwrap().len(), 2);
    assert_eq!(bounded["pending"].as_array().unwrap().len(), 1);
    dashboard::refresh_batch_with(&state, 2, |_, target| async move { Ok(row(&target, 0)) })
        .await
        .unwrap();
    state
        .db
        .put_kv(
            "observation-ledger-v1",
            "observation-research:v1:600036.SH:0000000001",
            &json!({"code":"600036.SH","version":1}),
            None,
        )
        .await
        .unwrap();
    assert!(
        dashboard::read(&state).await.unwrap()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["code"] != "600036.SH")
    );
    let updated = dashboard::refresh_with(&state, "600036.SH", |_, target| async move {
        Ok(row(&target, 1))
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(updated["row"]["researchVersion"], 1);
    assert_eq!(dashboard::read(&state).await.unwrap()["stale"], false);
    let cohorts=state.db.query("SELECT value_json,expires_at FROM kv_cache WHERE namespace='observation-ledger-v1' AND key LIKE 'observation-cohort:%'",vec![]).await.unwrap();
    assert_eq!(cohorts.len(), 3);
    assert!(cohorts.iter().all(|cohort| cohort["expires_at"].is_null()));
}

#[test]
fn quote_contract_preserves_exchange_date_absolute_units_and_rejects_wrong_identity() {
    let quote = json!({"symbol":"NVDA","currency":"USD","market_capital":5.2e12,"timestamp":1793235600000_i64});
    let body = json!({"error_code":0,"data":{"quote":quote}});
    let parsed = stock_info_local::xueqiu::parse_quote(&body, "NVDA.US").unwrap();
    assert_eq!(parsed["currency"], "USD");
    assert_eq!(parsed["marketCap"], 5.2e12);
    // 2026-10-29 01:00 UTC is 2026-10-28 on the US exchange.
    let time = chrono::DateTime::parse_from_rfc3339("2026-10-29T01:00:00Z")
        .unwrap()
        .timestamp_millis();
    let mut valid = body;
    valid["data"]["quote"]["timestamp"] = json!(time);
    assert_eq!(
        stock_info_local::xueqiu::parse_quote(&valid, "NVDA.US").unwrap()["priceAsOf"],
        "2026-10-28"
    );
    for (field, value) in [
        ("symbol", json!("META")),
        ("currency", json!("CNY")),
        ("market_capital", Value::Null),
        ("market_capital", json!(0)),
        ("market_capital", json!(-1)),
        ("timestamp", Value::Null),
        ("timestamp", json!(0)),
        ("timestamp", json!(1e20)),
    ] {
        let mut invalid = valid.clone();
        invalid["data"]["quote"][field] = value;
        assert!(stock_info_local::xueqiu::parse_quote(&invalid, "NVDA.US").is_err());
    }
}

#[tokio::test]
async fn dashboard_http_routes_read_only_and_fresh_refresh_contracts() {
    let (_dir, state) = fixture();
    let api = dashboard::routes().with_state(state.clone());
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .uri("/research/valuation-screen")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(payload["code"], 200);
    assert_eq!(payload["data"]["schemaVersion"], 5);
    assert_eq!(payload["data"]["mode"], "rolling");
    assert!(
        state
            .db
            .query("SELECT * FROM kv_cache", vec![])
            .await
            .unwrap()
            .is_empty()
    );
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/research/valuation-screen/refresh/INVALID")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    for code in ["600036.SH", "600519.SH", "000001.SZ"] {
        dashboard::refresh_with(&state, code, |_, target| async move { Ok(row(&target, 0)) })
            .await
            .unwrap();
    }
    for uri in [
        "/research/valuation-screen/refresh/600036",
        "/research/valuation-screen/refresh",
    ] {
        let response = api
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(payload["code"], 200);
        if uri.ends_with("600036") {
            assert_eq!(payload["data"]["state"], "complete");
            assert_eq!(payload["data"]["row"]["code"], "600036.SH");
        } else {
            assert_eq!(payload["data"]["stale"], false);
        }
    }
    let response = api
        .oneshot(
            Request::builder()
                .uri("/research/comparability?code=INVALID")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn batch_limit_caps_cron_at_twelve_with_two_concurrent_computations() {
    let (_dir, state) = fixture();
    let companies=(0..15).map(|index| {
        let code=format!("{:06}.SH",600000+index);
        json!({"id":code,"displayName":code,"classificationStatus":"verified","preferredMarket":"CN","preferredTicker":code,"securities":[{"ticker":code,"market":"CN"}]})
    }).collect::<Vec<_>>();
    std::fs::write(
        state.root.join("config/investment-universe.json"),
        json!({"companies":companies}).to_string(),
    )
    .unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let active_compute = active.clone();
    let max_compute = maximum.clone();
    let calls_compute = calls.clone();
    let first = dashboard::refresh_batch_with(&state, usize::MAX, move |_, target| {
        let active = active_compute.clone();
        let maximum = max_compute.clone();
        let calls = calls_compute.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(current, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(row(&target, 0))
        }
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 12);
    assert!(maximum.load(Ordering::SeqCst) <= 2);
    assert_eq!(first["rows"].as_array().unwrap().len(), 12);
    assert_eq!(first["pending"].as_array().unwrap().len(), 3);
    let second =
        dashboard::refresh_batch_with(&state, 0, |_, target| async move { Ok(row(&target, 0)) })
            .await
            .unwrap();
    assert_eq!(second["rows"].as_array().unwrap().len(), 13);
    assert_eq!(second["pending"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn disconnecting_refresh_waiter_does_not_cancel_runtime_owned_computation() {
    let (_dir, state) = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Notify::new());
    let state_request = state.clone();
    let calls_compute = calls.clone();
    let gate_compute = gate.clone();
    let request = tokio::spawn(async move {
        dashboard::refresh_owned_with(&state_request, "600036.SH", move |_, target| async move {
            calls_compute.fetch_add(1, Ordering::SeqCst);
            gate_compute.notified().await;
            Ok(row(&target, 0))
        })
        .await
    });
    wait_for(&calls, 1).await;
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(state.tasks.len(), 1, "runtime tracks the accepted refresh");
    state.tasks.close();
    gate.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), state.tasks.wait())
        .await
        .expect("graceful shutdown drains the accepted refresh");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let dashboard = dashboard::read(&state).await.unwrap();
            let leases = state
                .db
                .query(
                    "SELECT * FROM kv_cache WHERE namespace='valuation-screen-v4-lease'",
                    vec![],
                )
                .await
                .unwrap();
            if dashboard["rows"].as_array().unwrap().len() == 1 && leases.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("detached refresh persists and releases leases");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
