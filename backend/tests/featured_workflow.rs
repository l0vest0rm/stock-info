use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use stock_info_local::{
    AppState,
    db::Database,
    featured_workflow::{self, domain},
};
fn source() -> Value {
    json!({"title":"Research","pageCount":2,"issues":[],"sections":[{"id":"s1","title":"Risk factors","blocks":[{"id":"b1","original":"Revenue grew 12% to 1,234 dollars","sourceLocations":[{"page":1,"bbox":[0.1,0.1,0.8,0.3]}]}]},{"id":"s2","title":"Disclaimer","blocks":[{"id":"b2","original":"Copyright notice","sourceLocations":[{"page":2,"bbox":[0.1,0.1,0.8,0.3]}]}]}]})
}
fn translated() -> Vec<Value> {
    vec![
        json!({"id":"s1","title":"Risk factors","blocks":[{"id":"b1","translation":"收入增长12%至1,234美元","sourceLocations":[{"page":1,"bbox":[0.1,0.1,0.8,0.3]}]}]}),
    ]
}
fn fixture() -> (tempfile::TempDir, AppState, PathBuf, Value) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("test.sqlite")).unwrap();
    db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:18991".into()).unwrap();
    let report = dir.path().join("report");
    std::fs::create_dir(&report).unwrap();
    let pdf = b"%PDF-1.7\nfixture";
    let hash = format!("{:x}", Sha256::digest(pdf));
    let source = source();
    let content = json!({"schemaVersion":1,"reportId":hash,"title":"Test","institution":"Institution","reportDate":"2026-10-29","pageCount":2,"summary":"Summary","sections":domain::placeholders(&source,&translated()).unwrap()});
    for (name, value) in [("content.json", &content), ("source.json", &source)] {
        std::fs::write(report.join(name), serde_json::to_vec(value).unwrap()).unwrap();
    }
    std::fs::write(report.join("original.pdf"), pdf).unwrap();
    (dir, state, report, content)
}
#[test]
fn legal_filter_preserves_substantive_risk_and_anchors() {
    let source = source();
    let (selected, skipped) = domain::select(&source).unwrap();
    assert_eq!(selected["sections"].as_array().unwrap().len(), 1);
    assert_eq!(skipped[0]["id"], "b2");
    let restored = domain::placeholders(&source, &translated()).unwrap();
    assert!(
        restored[1]["blocks"][0]["translation"]
            .as_str()
            .unwrap()
            .contains("版权及使用限制")
    );
    domain::check_coverage(&json!({"sections":restored}), &source).unwrap();
    let mut changed = json!({"sections":restored});
    changed["sections"][0]["blocks"][0]["sourceLocations"][0]["page"] = json!(2);
    assert!(domain::check_coverage(&changed, &source).is_err());
}
#[test]
fn coverage_rejects_duplicate_unknown_or_missing_research() {
    let s = source();
    let b = translated()[0].clone();
    assert!(domain::check_coverage(&json!({"sections":[b.clone(),b]}), &s).is_err());
    assert!(domain::check_coverage(&json!({"sections":[]}), &s).is_err());
    let mut unknown = translated();
    unknown[0]["blocks"][0]["id"] = json!("other");
    assert!(domain::check_coverage(&json!({"sections":unknown}), &s).is_err());
    domain::check_coverage(&json!({"sections":translated()}), &s).unwrap();
}
#[test]
fn batching_coverage_and_budgets_are_strict() {
    let (selected, _) = domain::select(&source()).unwrap();
    let groups = domain::batches(&selected).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(
        domain::model_blocks(&groups[0])[0]["sectionTitle"],
        "Risk factors"
    );
    domain::validate_translation(
        &json!({"items":[{"id":"b1","translation":"译文"}],"digest":"摘要"}),
        &groups[0],
        true,
    )
    .unwrap();
    assert!(
        domain::validate_translation(
            &json!({"items":[{"id":"b1","translation":"译文"}]}),
            &groups[0],
            true
        )
        .is_err()
    );
    let mut large = selected;
    large["sections"][0]["blocks"][0]["original"] = json!("中".repeat(10000));
    assert!(domain::batches(&large).is_err());
    assert_eq!(domain::estimate_tokens("abc中文"), 5);
}
#[tokio::test]
async fn publication_is_local_verified_idempotent_and_cas_guarded() {
    let (_temp, state, report, mut content) = fixture();
    let options = json!({"directory":report});
    let result = featured_workflow::publish(&state, &options).await.unwrap();
    let again = featured_workflow::publish(&state, &options).await.unwrap();
    assert_eq!(result["code"], again["code"]);
    assert_eq!(
        state
            .db
            .query("SELECT * FROM featured_reports", vec![])
            .await
            .unwrap()
            .len(),
        1
    );
    content["summary"] = json!("Human review update");
    std::fs::write(
        report.join("content.json"),
        serde_json::to_vec(&content).unwrap(),
    )
    .unwrap();
    assert_eq!(
        featured_workflow::publish(&state, &options).await.unwrap()["code"],
        result["code"]
    );
    let rows = state
        .db
        .query("SELECT content_hash FROM featured_reports", vec![])
        .await
        .unwrap();
    assert_ne!(rows[0]["content_hash"], result["contentHash"]);
    let mut receipt: Value =
        serde_json::from_slice(&std::fs::read(report.join("published.json")).unwrap()).unwrap();
    receipt["contentHash"] = json!("a".repeat(64));
    std::fs::write(
        report.join("published.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    content["summary"] = json!("Another update");
    std::fs::write(
        report.join("content.json"),
        serde_json::to_vec(&content).unwrap(),
    )
    .unwrap();
    assert!(featured_workflow::publish(&state, &options).await.is_err());
}
#[tokio::test]
async fn publication_rejects_remote_receipt_wrong_pdf_and_changed_locations() {
    let (_temp, state, report, mut content) = fixture();
    assert!(
        featured_workflow::publish(
            &state,
            &json!({"directory":report,"baseUrl":"https://tinfo.cc"})
        )
        .await
        .is_err()
    );
    content["sections"][0]["blocks"][0]["sourceLocations"][0]["page"] = json!(2);
    std::fs::write(
        report.join("content.json"),
        serde_json::to_vec(&content).unwrap(),
    )
    .unwrap();
    assert!(
        featured_workflow::publish(&state, &json!({"directory":report}))
            .await
            .is_err()
    );
    assert!(
        state
            .db
            .query("SELECT * FROM featured_reports", vec![])
            .await
            .unwrap()
            .is_empty()
    );
}

#[test]
fn deterministic_selection_matches_88_original_javascript_cases() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/featured-workflow-domain.json")).unwrap();
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let (selected, skipped) = domain::select(&case["source"]).unwrap();
        assert_eq!(selected, case["selected"], "selection {index}");
        assert_eq!(json!(skipped), case["skipped"], "skipped {index}");
        let translated = selected["sections"].as_array().unwrap().iter().map(|s| json!({"id":s["id"],"title":s["title"],"blocks":s["blocks"].as_array().unwrap().iter().map(|b|json!({"id":b["id"],"translation":"翻译","sourceLocations":b["sourceLocations"]})).collect::<Vec<_>>()})).collect::<Vec<_>>();
        assert_eq!(
            json!(domain::placeholders(&case["source"], &translated).unwrap()),
            case["restored"],
            "restoration {index}"
        );
        assert_eq!(
            json!(domain::batches(&selected).unwrap()),
            case["batches"],
            "batch {index}"
        );
    }
    for case in golden["tokens"].as_array().unwrap() {
        assert_eq!(
            domain::estimate_tokens(case["text"].as_str().unwrap()),
            case["tokens"].as_u64().unwrap() as usize
        );
    }
}

#[test]
fn completed_model_cache_keys_match_original_javascript_field_order() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/featured-workflow-domain.json")).unwrap();
    for case in golden["cacheKeys"].as_array().unwrap() {
        assert_eq!(
            domain::cache_key(
                case["kind"].as_str().unwrap(),
                case["prompt"].as_str().unwrap(),
                &case["input"]
            )
            .unwrap(),
            case["key"].as_str().unwrap()
        );
    }
}
