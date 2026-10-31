//! Explicit read-only receipt/source smoke. Never sends or regenerates a prompt,
//! opens the user's SQLite, or publishes a result into a business ledger.
use std::{collections::BTreeMap, path::PathBuf};

#[tokio::test]
#[ignore = "requires explicit CEA_LIVE_CONVERSATION_URL, CEA_LIVE_OUTPUT_DIR and logged-in CEA Profile"]
async fn read_real_existing_answer_without_resubmission() {
    let url = std::env::var("CEA_LIVE_CONVERSATION_URL").unwrap();
    assert!(url.starts_with("https://chatgpt.com/c/"));
    let output = PathBuf::from(std::env::var("CEA_LIVE_OUTPUT_DIR").unwrap());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut variables = BTreeMap::from([("conversation_url".into(), url)]);
    if let Ok(profile) = std::env::var("LOCAL_WEB_RESEARCH_PROFILE") {
        variables.insert("profile".into(), profile);
    }
    if let Ok(selector) = std::env::var("CEA_LIVE_ANSWER_SELECTOR") {
        variables.insert("answer_selector".into(), selector);
    }
    let report = cea_sdk::run_workflow(
        &root.join("config/workflows/chatgpt-read-result.yaml"),
        cea_sdk::WorkflowOptions {
            endpoint: std::env::var("CEA_ENDPOINT").ok(),
            output_dir: output.clone(),
            variables,
        },
    )
    .await
    .unwrap();
    let proof: serde_json::Value =
        serde_json::from_str(&report.outputs["answer_text_sources"]).unwrap();
    assert_eq!(proof["errors"], serde_json::json!([]));
    let markdown = stock_info_local::web_workflow::canonical_markdown(
        &std::fs::read_to_string(&report.markdown_path).unwrap(),
    );
    assert!(!markdown.trim().is_empty());
    match std::env::var("CEA_LIVE_VALIDATOR").as_deref() {
        Ok("financial") => {
            stock_info_local::research::financial_input::validate_markdown(&markdown).unwrap()
        }
        Ok("investment") => {
            stock_info_local::research::investment::validate_markdown(&markdown).unwrap()
        }
        Err(_) => {}
        _ => panic!("unknown CEA_LIVE_VALIDATOR"),
    }
    if std::env::var("CEA_LIVE_REQUIRE_LINKS").as_deref() == Ok("1") {
        assert!(!proof["links"].as_array().unwrap().is_empty());
    }
    assert!(cea_sdk::read_workflow_result(&output).unwrap().is_some());
    println!(
        "verified real read-only SDK receipt; source links={}",
        proof["links"].as_array().unwrap().len()
    );
    cea_sdk::close_workflow_page(
        std::env::var("CEA_ENDPOINT")
            .as_deref()
            .unwrap_or("ws://127.0.0.1:9876/api/v1/ws"),
        &report.server_instance_id,
        &report.page_id,
    )
    .await
    .unwrap();
}
