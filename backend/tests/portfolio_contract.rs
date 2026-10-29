//! Synthetic fixtures only: no user's portfolio, live DB, or provider calls.
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::Utc;
use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database, portfolio};
use tempfile::TempDir;
use tower::ServiceExt;

fn setup() -> (TempDir, Database) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path().join("portfolio.sqlite")).unwrap();
    db.connect()
        .unwrap()
        .execute_batch(include_str!("../../migrations/0117_create_kv_cache.sql"))
        .unwrap();
    (directory, db)
}
fn dashboard() -> Value {
    json!({"rows":[],"pending":[],"revision":"fixture","freshnessMs":600000})
}
fn draft(now: i64) -> Value {
    let mut value = portfolio::portfolio_template();
    value["asOf"] = json!(
        chrono::DateTime::from_timestamp_millis(now - 1000)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    value["source"] = json!("synthetic isolated test, not real holdings");
    value["positions"] = json!([{"account":"test","code":"600036.SH","quantity":10,"price":10,"currency":"CNY","fxToBase":1}]);
    value["cash"] = json!([{"account":"test","amount":100,"currency":"CNY","fxToBase":1}]);
    value
}
fn record(draft: &Value) -> Value {
    json!({"version":1,"snapshotVersion":1,"recordedAt":draft["asOf"],"draft":draft,"decisions":[]})
}
fn proposal(draft: &Value) -> Value {
    let mut target = draft.clone();
    target["positions"][0]["quantity"] = json!(5);
    target["cash"][0]["amount"] = json!(150);
    json!({"title":"synthetic reduce concentration","rationale":"compare holding unchanged","target":target,"estimatedCosts":0,"externalCashFlow":0})
}
fn risk_dashboard(now: i64, draft: &Value) -> Value {
    let mut result = dashboard();
    result["rows"] = json!([{"code":"600036.SH","researchVersion":1,"computation":{"id":"one","revision":"fixture","computedAt":draft["asOf"]},"opportunity":{"stage":"research_candidate","policyVersion":"test","gates":[{"key":"business","state":"fail","reasons":["earnings deteriorated"]}],"workflow":{"thesisStatus":"invalidated","queue":"review_risk","nextAction":"verify thesis"}}}]);
    assert!(
        chrono::DateTime::parse_from_rfc3339(
            result["rows"][0]["computation"]["computedAt"]
                .as_str()
                .unwrap()
        )
        .unwrap()
        .timestamp_millis()
            < now
    );
    result
}
fn semantic_equal(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{path}"),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                semantic_equal(a, b, &format!("{path}/{index}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}"
            );
            for (key, value) in a {
                semantic_equal(value, &b[key], &format!("{path}/{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn differential_typescript_domain_fixtures_preserve_complete_outputs_and_task_ids() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../src/portfolio/fixtures.json")).unwrap();
    for fixture in fixtures["assessments"].as_array().unwrap() {
        let current = (!fixture["current"].is_null()).then_some(&fixture["current"]);
        let actual = portfolio::assess_portfolio(
            current,
            &fixture["dashboard"],
            fixture["now"].as_i64().unwrap(),
        );
        semantic_equal(
            &actual,
            &fixture["expected"],
            fixture["name"].as_str().unwrap(),
        );
    }
    for (index, fixture) in fixtures["comparisons"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let actual = portfolio::compare_proposal(
            &fixture["current"],
            &fixture["input"],
            &fixture["dashboard"],
            fixture["now"].as_i64().unwrap(),
        )
        .unwrap();
        semantic_equal(&actual, &fixture["expected"], &format!("proposal/{index}"));
    }
}

#[test]
fn snapshot_validation_rejects_invalid_dates_fields_fx_and_duplicates() {
    let now = Utc::now().timestamp_millis();
    let valid = draft(now);
    portfolio::validate_portfolio(&valid, now).unwrap();
    let mut invalid = Vec::new();
    for as_of in ["bad", "2026-02-30T00:00:00Z", "2026-01-01T00:00:00"] {
        let mut d = valid.clone();
        d["asOf"] = json!(as_of);
        invalid.push(d);
    }
    let mut future = valid.clone();
    future["asOf"] = json!(
        chrono::DateTime::from_timestamp_millis(now + 100000)
            .unwrap()
            .to_rfc3339()
    );
    invalid.push(future);
    for (key, value) in [
        ("source", json!("")),
        ("strategy", json!("index")),
        ("privateKey", json!("not permitted")),
    ] {
        let mut d = valid.clone();
        d[key] = value;
        invalid.push(d);
    }
    for (key, value) in [
        ("maxHoldings", json!(40)),
        ("maxCompanyWeight", json!(2)),
        ("maxCompanyWeight", json!(0)),
        ("extra", json!(true)),
    ] {
        let mut d = valid.clone();
        d["rules"][key] = value;
        invalid.push(d);
    }
    for (key, value) in [
        ("quantity", json!(-1)),
        ("price", json!(0)),
        ("fxToBase", json!(2)),
        ("currency", json!("USD")),
        ("account", json!(" test ")),
    ] {
        let mut d = valid.clone();
        d["positions"][0][key] = value;
        invalid.push(d);
    }
    for key in ["positions", "cash"] {
        let mut d = valid.clone();
        let item = d[key][0].clone();
        d[key].as_array_mut().unwrap().push(item);
        invalid.push(d);
    }
    let mut negative_cash = valid.clone();
    negative_cash["cash"][0]["amount"] = json!(-1);
    invalid.push(negative_cash);
    let mut missing = valid.clone();
    missing["positions"][0]
        .as_object_mut()
        .unwrap()
        .remove("fxToBase");
    invalid.push(missing);
    for invalid in invalid {
        assert!(
            portfolio::validate_portfolio(&invalid, now).is_err(),
            "unexpected valid input: {invalid}"
        );
    }
    let mut base_float = valid.clone();
    base_float["rules"]["maxHoldings"] = json!(39.0);
    base_float["positions"][0]["fxToBase"] = json!(1.0);
    portfolio::validate_portfolio(&base_float, now).unwrap();
}

#[test]
fn proposal_locks_date_rules_price_and_fx_and_does_not_mutate_snapshot() {
    let now = Utc::now().timestamp_millis();
    let draft = draft(now);
    let current = record(&draft);
    let input = proposal(&draft);
    let compared = portfolio::compare_proposal(&current, &input, &dashboard(), now).unwrap();
    assert_eq!(compared["before"]["nav"], 200.0);
    assert_eq!(compared["after"]["nav"], 200.0);
    assert_eq!(compared["comparison"]["fundingGap"], 0.0);
    assert_eq!(compared["comparison"]["turnover"], 0.25);
    assert_eq!(compared["comparison"]["changes"][0]["valueChange"], -50.0);
    assert_eq!(current["draft"]["positions"][0]["quantity"], 10);
    for (key, value) in [
        ("asOf", json!("2026-01-01T00:00:00Z")),
        ("baseCurrency", json!("USD")),
    ] {
        let mut invalid = input.clone();
        invalid["target"][key] = value;
        assert!(portfolio::compare_proposal(&current, &invalid, &dashboard(), now).is_err());
    }
    let mut invalid = input.clone();
    invalid["target"]["rules"]["maxCompanyWeight"] = json!(0.9);
    assert!(portfolio::compare_proposal(&current, &invalid, &dashboard(), now).is_err());
    let mut invalid = input.clone();
    invalid["target"]["positions"][0]["price"] = json!(20);
    assert!(portfolio::compare_proposal(&current, &invalid, &dashboard(), now).is_err());
    let mut numeric_equivalent = input.clone();
    numeric_equivalent["target"]["positions"][0]["price"] = json!(10.0);
    numeric_equivalent["target"]["rules"]["maxHoldings"] = json!(39.0);
    portfolio::compare_proposal(&current, &numeric_equivalent, &dashboard(), now).unwrap();
}

#[tokio::test]
async fn ledger_get_is_read_only_and_cas_is_immutable_across_concurrent_writes() {
    let (_dir, db) = setup();
    let draft = draft(Utc::now().timestamp_millis());
    let dashboard = dashboard();
    let empty = portfolio::read(&db, &dashboard).await.unwrap();
    assert_eq!(empty["current"], Value::Null);
    assert_eq!(
        db.query("SELECT count(*) AS n FROM kv_cache", vec![])
            .await
            .unwrap()[0]["n"],
        0
    );
    portfolio::write(
        &db,
        &json!(0),
        &json!({"type":"snapshot","draft":draft}),
        &dashboard,
    )
    .await
    .unwrap();
    let stale = portfolio::write(
        &db,
        &json!(0),
        &json!({"type":"snapshot","draft":draft}),
        &dashboard,
    )
    .await
    .unwrap_err();
    assert!(
        stale
            .downcast_ref::<portfolio::PortfolioConflict>()
            .is_some()
    );
    let read = portfolio::read(&db, &dashboard).await.unwrap();
    let task = read["assessment"]["tasks"][0].clone();
    let command = json!({"type":"decision","taskId":task["id"],"choice":"keep","reason":"test only, no trade","until":null});
    let expected = json!(1);
    let (a, b) = tokio::join!(
        portfolio::write(&db, &expected, &command, &dashboard),
        portfolio::write(&db, &expected, &command, &dashboard)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let read = portfolio::read(&db, &dashboard).await.unwrap();
    assert_eq!(read["current"]["version"], 2);
    assert_eq!(read["current"]["snapshotVersion"], 1);
    let same = read["assessment"]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == task["id"])
        .unwrap();
    assert_eq!(same["decision"]["choice"], "keep");
    let mut forged = command.clone();
    forged["taskId"] = json!("forged");
    assert!(
        portfolio::write(&db, &json!(2), &forged, &dashboard)
            .await
            .unwrap_err()
            .downcast_ref::<portfolio::PortfolioConflict>()
            .is_some()
    );
    let mut past = command.clone();
    past["choice"] = json!("defer");
    past["until"] = draft["asOf"].clone();
    assert!(
        portfolio::write(&db, &json!(2), &past, &dashboard)
            .await
            .is_err()
    );
    assert!(
        portfolio::write(&db, &json!(2), &json!({"type":"trade"}), &dashboard)
            .await
            .is_err()
    );
    portfolio::write(
        &db,
        &json!(2),
        &json!({"type":"snapshot","draft":draft}),
        &dashboard,
    )
    .await
    .unwrap();
    let history = portfolio::versions(&db).await.unwrap();
    assert_eq!(history.len(), 3);
    assert!(history[0]["decisions"].as_array().unwrap().is_empty());
    assert_eq!(history[1]["decisions"].as_array().unwrap().len(), 1);
    assert_eq!(db.query("SELECT count(*) AS n FROM kv_cache WHERE expires_at IS NOT NULL OR namespace!='private-active-portfolio-v1'",vec![]).await.unwrap()[0]["n"],0);
}

#[tokio::test]
async fn proposal_decisions_are_separate_from_actual_holdings_and_validate_funding_and_basis() {
    let (_dir, db) = setup();
    let now = Utc::now().timestamp_millis();
    let draft = draft(now);
    let dashboard = dashboard();
    let input = proposal(&draft);
    portfolio::write(
        &db,
        &json!(0),
        &json!({"type":"snapshot","draft":draft}),
        &dashboard,
    )
    .await
    .unwrap();
    portfolio::write(
        &db,
        &json!(1),
        &json!({"type":"proposal","proposal":input}),
        &dashboard,
    )
    .await
    .unwrap();
    let current = portfolio::read(&db, &dashboard).await.unwrap()["current"].clone();
    assert_eq!(current["draft"]["positions"][0]["quantity"], 10);
    assert_eq!(current["proposals"][0]["comparison"]["fundingGap"], 0.0);
    let review = json!({"type":"review_proposal","id":"proposal-2","status":"confirmed","reason":"human decision only, not a fill"});
    let changed = portfolio::write(&db, &json!(2), &review, &risk_dashboard(now, &draft))
        .await
        .unwrap_err();
    assert!(changed.to_string().contains("依据已变化"));
    portfolio::write(&db, &json!(2), &review, &dashboard)
        .await
        .unwrap();
    let current = portfolio::read(&db, &dashboard).await.unwrap()["current"].clone();
    assert_eq!(current["proposals"][0]["status"], "confirmed");
    assert_eq!(current["draft"]["positions"][0]["quantity"], 10);
    let mut unknown = input.clone();
    unknown["estimatedCosts"] = Value::Null;
    portfolio::write(
        &db,
        &json!(3),
        &json!({"type":"proposal","proposal":unknown}),
        &dashboard,
    )
    .await
    .unwrap();
    let review = json!({"type":"review_proposal","id":"proposal-4","status":"confirmed","reason":"unknown costs must fail"});
    assert!(
        portfolio::write(&db, &json!(4), &review, &dashboard)
            .await
            .unwrap_err()
            .to_string()
            .contains("不能记录采纳")
    );
    portfolio::write(
        &db,
        &json!(4),
        &json!({"type":"snapshot","draft":draft}),
        &dashboard,
    )
    .await
    .unwrap();
    assert!(
        portfolio::write(&db, &json!(5), &review, &dashboard)
            .await
            .unwrap_err()
            .to_string()
            .contains("快照已变化")
    );
    let mut unfunded = input;
    unfunded["estimatedCosts"] = json!(10);
    portfolio::write(
        &db,
        &json!(5),
        &json!({"type":"proposal","proposal":unfunded}),
        &dashboard,
    )
    .await
    .unwrap();
    assert!(portfolio::write(&db,&json!(6),&json!({"type":"review_proposal","id":"proposal-6","status":"confirmed","reason":"unfunded"}),&dashboard).await.is_err());
}

#[tokio::test]
async fn ledger_history_window_retains_older_durable_versions() {
    let (_dir, db) = setup();
    let draft = draft(Utc::now().timestamp_millis());
    let dashboard = dashboard();
    for expected in 0..103 {
        portfolio::write(
            &db,
            &json!(expected),
            &json!({"type":"snapshot","draft":draft}),
            &dashboard,
        )
        .await
        .unwrap();
    }
    let history = portfolio::versions(&db).await.unwrap();
    assert_eq!(history.len(), 100);
    assert_eq!(history[0]["version"], 103);
    assert_eq!(history[99]["version"], 4);
    assert_eq!(
        db.query("SELECT count(*) AS n FROM kv_cache", vec![])
            .await
            .unwrap()[0]["n"],
        103
    );
}

async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 200_000).await.unwrap()).unwrap()
}
#[tokio::test]
async fn routes_keep_read_privacy_content_type_size_and_history_contracts() {
    let (_dir, db) = setup();
    let draft = draft(Utc::now().timestamp_millis());
    portfolio::write(
        &db,
        &json!(0),
        &json!({"type":"snapshot","draft":draft}),
        &dashboard(),
    )
    .await
    .unwrap();
    let state = AppState::new(
        db.clone(),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."),
        "127.0.0.1:8000".into(),
    )
    .unwrap();
    let app = portfolio::routes().with_state(state);
    for path in [
        "/research/portfolio/workspace",
        "/research/portfolio/history/1",
    ] {
        for (host, origin, site) in [
            ("evil.example", None, None),
            ("127.0.0.1:8000", Some("https://evil.example"), None),
            ("127.0.0.1:8000", None, Some("cross-site")),
        ] {
            let mut request = Request::builder().uri(path).header("host", host);
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            if let Some(site) = site {
                request = request.header("sec-fetch-site", site);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", "127.0.0.1:8000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    for version in ["bad", "0", "999"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/research/portfolio/history/{version}"))
                    .header("host", "127.0.0.1:8000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    for (content_type,input,status) in [("text/plain","{}".to_string(),StatusCode::UNSUPPORTED_MEDIA_TYPE),("application/json","x".repeat(150001),StatusCode::PAYLOAD_TOO_LARGE),("application/json","{".into(),StatusCode::BAD_REQUEST),("application/json",json!({"expectedVersion":1,"command":{"type":"snapshot","draft":draft},"extra":"not allowed"}).to_string(),StatusCode::BAD_REQUEST)] {
        let response=app.clone().oneshot(Request::builder().method("POST").uri("/research/portfolio/workspace").header("host","127.0.0.1:8000").header("content-type",content_type).body(Body::from(input)).unwrap()).await.unwrap();assert_eq!(response.status(),status);assert_eq!(body(response).await["data"],Value::Null);
    }
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/research/portfolio/workspace")
                .header("host", "127.0.0.1:8000")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"expectedVersion":1,"command":{"type":"snapshot","draft":draft}})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["data"]["current"]["version"], 2);
    assert_eq!(
        db.query(
            "SELECT count(*) AS n FROM kv_cache WHERE namespace!='private-active-portfolio-v1'",
            vec![]
        )
        .await
        .unwrap()[0]["n"],
        0
    );
}
