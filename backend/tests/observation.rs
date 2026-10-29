//! Deterministic observation research tests against the actual Rust module.
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::{Duration, NaiveDate};
use serde_json::{Value, json};
use stock_info_local::{AppState, db, observation};
use tempfile::TempDir;
use tower::ServiceExt;

fn fixture_now() -> i64 {
    chrono::DateTime::parse_from_rfc3339("2026-10-29T12:00:00Z")
        .unwrap()
        .timestamp_millis()
}
fn source() -> Value {
    json!({"url":"https://example.com/filing","publishedAt":"2026-10-28","checkedAt":"2026-10-29","note":"fixture, comparable basis"})
}
fn bank() -> Value {
    json!([{"key":"npl_ratio","value":0.01,"period":"2026-09-30","source":source()},{"key":"cet1_buffer","value":0.02,"period":"2026-09-30","source":source()},{"key":"provision_coverage","value":2,"period":"2026-09-30","source":source()}])
}
fn assumptions() -> Value {
    json!({"marketCap":100,"normalizedProfit":10,"currency":"CNY","amountScale":"base_units","priceDate":"2026-10-28","profitPeriod":"2026-09-30","years":3,"requiredReturn":0.1,"annualDilution":0,"sources":{"marketCap":source(),"profit":source(),"assumptions":source()},"scenarios":[{"name":"bear","growth":0,"terminalMultiple":8,"payoutRatio":0,"rationale":"bear"},{"name":"base","growth":0.1,"terminalMultiple":10,"payoutRatio":0,"rationale":"base"},{"name":"bull","growth":0.2,"terminalMultiple":12,"payoutRatio":0,"rationale":"bull"}]})
}
fn draft() -> Value {
    let mut draft = observation::research_template("bank");
    draft["thesis"]["changeReason"] = json!("fixture");
    draft
}
fn setup() -> (TempDir, db::Database) {
    let dir = tempfile::tempdir().unwrap();
    let database = db::Database::open(dir.path().join("test.sqlite")).unwrap();
    // Reuse the existing historical schema; no added table or migration.
    database
        .connect()
        .unwrap()
        .execute_batch(include_str!("../../migrations/0117_create_kv_cache.sql"))
        .unwrap();
    (dir, database)
}
fn cohort() -> Value {
    json!({"id":"TEST:2026-01-01","code":"TEST","recordedAt":"2026-01-01T18:00:00Z","quoteDate":"2026-01-01","stage":"research_candidate","policyVersion":"fixture","dependencyRevision":"fixture","computationId":"fixture","gates":[],"signals":[],"researchVersion":0})
}
fn bars() -> Vec<Value> {
    (0..150).map(|i|json!({"date":NaiveDate::from_ymd_opt(2026,1,1).unwrap().checked_add_signed(Duration::days(i)).unwrap().to_string(),"close":100+i})).collect()
}

#[test]
fn every_industry_missing_data_fails_closed_and_evidence_is_reviewed() {
    let now = fixture_now();
    let facts = bank();
    assert_eq!(
        observation::verify_industry("bank", &facts, now)["state"],
        "pass"
    );
    let mut duplicate = facts.clone();
    duplicate.as_array_mut().unwrap().push(facts[0].clone());
    assert_eq!(
        observation::verify_industry("bank", &duplicate, now)["state"],
        "unknown"
    );
    let mut stale = facts.clone();
    for fact in stale.as_array_mut().unwrap() {
        fact["period"] = json!("2020-01-01");
    }
    assert_eq!(
        observation::verify_industry("bank", &stale, now)["state"],
        "unknown"
    );
    let mut failed = facts.clone();
    failed[0]["value"] = json!(0.04);
    assert_eq!(
        observation::verify_industry("bank", &failed, now)["state"],
        "fail"
    );
    let mut injected = facts.clone();
    for fact in injected.as_array_mut().unwrap() {
        fact["source"]["url"] = json!("javascript:alert(1)");
    }
    assert_eq!(
        observation::verify_industry("bank", &injected, now)["state"],
        "unknown"
    );
    for archetype in [
        "bank",
        "insurer",
        "cyclical_commodity",
        "property_operator",
        "broker",
        "pre_profit_milestone",
        "stable_cash_dividend",
        "exchange",
        "growth_manufacturing",
    ] {
        let verified = observation::verify_industry(archetype, &json!([]), now);
        assert_eq!(verified["state"], "unknown");
        assert!(verified["checks"].as_array().unwrap().len() >= 2);
    }
    assert!(!observation::valid_date(&json!("2026-02-30")));
    assert!(!observation::valid_date(&json!("2026-1-1")));
    assert!(!observation::valid_date(&json!("-0010-01-01")));
    assert!(!observation::valid_source(
        &json!({"url":"http://example.com","publishedAt":"2026-10-28","checkedAt":"2026-10-29","note":"x"}),
        now
    ));
}

#[test]
fn scenarios_match_earnings_model_and_reject_invalid_inputs() {
    let now = fixture_now();
    let input = assumptions();
    let result = observation::expectations(&input, now);
    assert_eq!(result["status"], "available");
    assert!((result["impliedGrowth"].as_f64().unwrap() - 0.1).abs() < 1e-10);
    assert!((result["scenarios"][1]["annualizedReturn"].as_f64().unwrap() - 0.1).abs() < 1e-10);
    let mut diluted = input.clone();
    diluted["annualDilution"] = json!(0.1);
    assert!(
        observation::expectations(&diluted, now)["impliedGrowth"]
            .as_f64()
            .unwrap()
            > result["impliedGrowth"].as_f64().unwrap()
    );
    for (key, value) in [
        ("marketCap", json!(0)),
        ("normalizedProfit", json!(-1)),
        ("currency", json!("")),
        ("priceDate", json!("2027-01-01")),
        ("priceDate", json!("2025-01-01")),
        ("years", json!(1.5)),
        ("scenarios", json!([])),
        ("sources", json!({})),
    ] {
        let mut invalid = input.clone();
        invalid[key] = value;
        assert_eq!(
            observation::expectations(&invalid, now)["status"],
            "unavailable"
        );
    }
    let mut reviewed = draft();
    reviewed["thesis"]["status"] = json!("reviewed");
    assert!(
        observation::validate_draft(&reviewed, now)
            .unwrap_err()
            .to_string()
            .contains("已复核")
    );
    assert!(observation::validate_draft(&draft(), now).is_ok());
}

#[test]
fn forward_returns_start_after_capture_and_missing_data_remain_null() {
    let rows = bars();
    let c = cohort();
    let outcomes = observation::evaluate_cohort(&c, &rows, &rows, fixture_now(), None);
    assert!(outcomes.iter().all(|o| o["state"] == "matured"));
    assert!((outcomes[0]["return"].as_f64().unwrap() - (121.0 / 101.0 - 1.0)).abs() < 1e-10);
    assert!(
        outcomes
            .iter()
            .all(|o| o["excessReturn"].as_f64() == Some(0.0))
    );
    assert!(
        observation::evaluate_cohort(&c, &rows[..10], &[], fixture_now(), None)
            .iter()
            .all(|o| o["state"] == "pending")
    );
    assert!(
        observation::evaluate_cohort(&c, &rows[10..], &[], fixture_now(), None)
            .iter()
            .all(|o| o["state"] == "unavailable")
    );
    let mut duplicate = rows.clone();
    duplicate.push(rows[0].clone());
    assert!(
        observation::evaluate_cohort(&c, &duplicate, &[], fixture_now(), None)
            .iter()
            .all(|o| o["state"] == "unavailable")
    );
    assert!(
        observation::evaluate_cohort(&c, &rows, &[], fixture_now(), None)
            .iter()
            .all(|o| o["benchmarkReturn"].is_null())
    );
    let summary = observation::summarize_history(&[c], &outcomes);
    assert_eq!(summary[0]["samples"], 1);
    assert!(summary[3]["meanReturn"].is_null());
    let mut excluded = cohort();
    excluded["id"] = json!("EXCLUDED");
    excluded["stage"] = json!("clue");
    excluded["dependencyRevision"] = json!("different-revision");
    let mut excluded_outcomes = outcomes.clone();
    for o in &mut excluded_outcomes {
        o["id"] = json!("EXCLUDED");
        o["return"] = json!(-0.5);
    }
    let mut combined = outcomes;
    combined.extend(excluded_outcomes);
    let summary = observation::summarize_history(&[cohort(), excluded], &combined);
    assert_eq!(summary.len(), 12);
    assert_eq!(summary[0]["samples"], 1);
    assert_eq!(summary[9]["meanReturn"], -0.5);
}

#[tokio::test]
async fn immutable_history_cas_and_daily_cohorts() {
    let (_dir, database) = setup();
    let d = draft();
    let saved = observation::save_research(&database, "TEST", "bank", &json!(0), &d)
        .await
        .unwrap();
    assert_eq!(saved["version"], 1);
    assert!(
        observation::save_research(&database, "TEST", "bank", &json!(0), &d)
            .await
            .unwrap_err()
            .downcast_ref::<observation::ObservationConflict>()
            .is_some()
    );
    let expected = json!(1);
    let (a, b) = tokio::join!(
        observation::save_research(&database, "TEST", "bank", &expected, &d),
        observation::save_research(&database, "TEST", "bank", &expected, &d)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let read = observation::read_research(&database, "TEST", "bank", true)
        .await
        .unwrap();
    assert_eq!(read["versions"].as_array().unwrap().len(), 2);
    assert_eq!(read["current"]["version"], 2);
    let mut row = json!({"code":"TEST","computation":{"id":"one","revision":"fixture","computedAt":chrono::Utc::now().to_rfc3339()},"opportunity":{"stage":"clue","policyVersion":"fixture","price":{"asOf":"2026-01-01"},"gates":[],"signals":[]}});
    observation::append_cohort(&database, &row).await.unwrap();
    row["opportunity"]["stage"] = json!("research_candidate");
    observation::append_cohort(&database, &row).await.unwrap();
    let history = observation::read_history(&database, "TEST").await.unwrap();
    assert_eq!(history["cohorts"].as_array().unwrap().len(), 1);
    assert_eq!(history["cohorts"][0]["stage"], "clue");
    let count: i64 = database
        .connect()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM kv_cache WHERE expires_at IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    let outcomes = observation::evaluate_cohort(&cohort(), &bars(), &bars(), fixture_now(), None);
    observation::save_outcomes(&database, "TEST", &outcomes)
        .await
        .unwrap();
    let mut rewritten = outcomes.clone();
    for row in &mut rewritten {
        row["return"] = json!(999);
    }
    observation::save_outcomes(&database, "TEST", &rewritten)
        .await
        .unwrap();
    let history = observation::read_history(&database, "TEST").await.unwrap();
    assert!(
        history["outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["id"] == "TEST:2026-01-01")
            .all(|o| o["return"] != 999)
    );
    let mut private = d.clone();
    private["holdings"] = json!([]);
    assert!(
        observation::save_research(&database, "TEST", "bank", &json!(2), &private)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn reviewed_records_require_industry_and_scenario_evidence() {
    let (_dir, database) = setup();
    let today = chrono::Utc::now().date_naive().to_string();
    let current_source = json!({"url":"https://example.com/filing","publishedAt":today,"checkedAt":today,"note":"manually reviewed comparable filing"});
    let mut reviewed = draft();
    reviewed["thesis"]["status"] = json!("reviewed");
    for key in [
        "business",
        "marketConcern",
        "variantView",
        "counterEvidence",
        "invalidation",
    ] {
        reviewed["thesis"][key] = json!("reviewed fixture");
    }
    reviewed["thesis"]["nextReview"] =
        json!((chrono::Utc::now().date_naive() + Duration::days(1)).to_string());
    reviewed["thesis"]["evidence"] = json!([current_source]);
    reviewed["thesis"]["indicators"]=json!((0..3).map(|i|json!({"name":format!("indicator-{i}"),"baseline":"baseline","condition":"condition","source":current_source})).collect::<Vec<_>>());
    let mut facts = bank();
    for fact in facts.as_array_mut().unwrap() {
        fact["period"] = json!(today);
        fact["source"] = current_source.clone();
    }
    reviewed["industryFacts"] = facts;
    let mut model = assumptions();
    model["priceDate"] = json!(today);
    model["profitPeriod"] = json!(today);
    for key in ["marketCap", "profit", "assumptions"] {
        model["sources"][key] = current_source.clone();
    }
    reviewed["expectations"] = model;
    let mut missing = reviewed.clone();
    missing["industryFacts"] = json!([]);
    assert!(
        observation::save_research(&database, "REVIEW", "bank", &json!(0), &missing)
            .await
            .unwrap_err()
            .to_string()
            .contains("行业专用质量")
    );
    let saved = observation::save_research(&database, "REVIEW", "bank", &json!(0.0), &reviewed)
        .await
        .unwrap();
    assert_eq!(saved["version"], 1);
    assert_eq!(saved["industry"]["state"], "pass");
    assert_eq!(saved["expectationResult"]["status"], "available");
    let mut no_scenario = reviewed.clone();
    no_scenario["expectations"] = Value::Null;
    assert!(
        observation::save_research(&database, "REVIEW", "bank", &json!(1), &no_scenario)
            .await
            .is_err()
    );
    let mut no_field = draft();
    no_field.as_object_mut().unwrap().remove("expectations");
    assert!(observation::validate_draft(&no_field, fixture_now()).is_err());
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap()
}
#[tokio::test]
async fn version_routes_body_validation_and_conflict_status() {
    let (dir, database) = setup();
    let state = AppState::new(
        database.clone(),
        dir.path().to_path_buf(),
        "127.0.0.1:8000".into(),
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("config")).unwrap();
    std::fs::write(dir.path().join("config/investment-universe.json"),json!({"companies":[{"id":"fixture-bank","classificationStatus":"verified","preferredTicker":"600036.SH","preferredMarket":"CN","securities":[{"ticker":"600036.SH","market":"CN"}]}]}).to_string()).unwrap();
    let app = observation::routes().with_state(state);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/research/observation/600036.SH")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(json_body(response).await["data"]["current"].is_null());
    assert!(
        observation::versions(&database, "600036.SH", 100)
            .await
            .unwrap()
            .is_empty()
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/research/observation/INVALID")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/research/observation/600036.SH")
                .header("content-type", "text/plain")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    for expected in [StatusCode::OK, StatusCode::CONFLICT] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/research/observation/600036.SH")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"expectedVersion":0,"draft":draft()}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/research/observation/600036.SH?version=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/research/observation/600036.SH")
                .header("content-type", "application/json")
                .body(Body::from("x".repeat(120_001)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/research/observation/600036.SH/evaluate")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/research/observation/600036.SH")
                .body(Body::from("x".repeat(120_001)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
