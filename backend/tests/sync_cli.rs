use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use stock_info_local::{AppState, db::Database, sync_cli};

fn state() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("test.sqlite")).unwrap();
    db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:8000".into()).unwrap();
    (dir, state)
}
#[tokio::test]
async fn profiles_reuses_usable_existing_entries_and_preserves_other_codes_without_network() {
    let (dir, state) = state();
    let output = dir
        .path()
        .join("config/generated/eastmoney-company-em2016-profiles.json");
    fs::create_dir_all(output.parent().unwrap()).unwrap();
    fs::write(&output,json!({"profiles":[{"code":"600036.SH","industry":"金融-银行-股份制银行","availability":"available","products":["存款","存款"],"name":"招商银行"},{"code":"AAPL.US","industry":"科技-硬件-手机","availability":"available"}]}).to_string()).unwrap();
    let report = sync_cli::run(&state, "profiles", &json!({"codes":"600036.sh"}))
        .await
        .unwrap();
    assert_eq!(report["fetched"], 0);
    assert_eq!(report["totalProfiles"], 2);
    let data: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    assert_eq!(
        data["coverage"],
        json!({"total":2,"available":2,"unavailable":0})
    );
    assert_eq!(data["profiles"][0]["products"], json!(["存款"]));
    assert_eq!(
        data["schemaVersion"],
        "eastmoney-company-em2016-profiles.v1"
    );
}
#[tokio::test]
async fn repair_only_deletes_explicitly_requested_obsolete_a_share_income_snapshots() {
    let (dir, state) = state();
    let folder = dir.path().join("income");
    fs::create_dir(&folder).unwrap();
    let valid = json!({"rows":[{"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_annual_income.v1"}}]});
    fs::write(folder.join("600036.SH.json"), valid.to_string()).unwrap();
    fs::write(
        folder.join("300308.SZ.json"),
        json!({"rows":[{"payload":{"FINANCIAL_SOURCE_CONTRACT":"old_single_quarter"}}]})
            .to_string(),
    )
    .unwrap();
    fs::write(folder.join("AAPL.US.json"), "{}").unwrap();
    fs::write(folder.join("000001.SZ.json"), "not json").unwrap();
    let report = sync_cli::run(&state, "repair-income", &json!({"dir":"income"}))
        .await
        .unwrap();
    assert_eq!(report["mode"], "dry_run");
    assert_eq!(report["scanned"], 4);
    assert_eq!(report["hasCumulative"], 1);
    assert_eq!(report["missingCumulative"], 1);
    assert_eq!(report["unreadable"], 1);
    assert!(folder.join("300308.SZ.json").exists());
    let report = sync_cli::run(
        &state,
        "repair-income",
        &json!({"dir":"income","delete":true}),
    )
    .await
    .unwrap();
    assert_eq!(report["deleted"], 1);
    assert!(!folder.join("300308.SZ.json").exists());
    for name in ["600036.SH.json", "AAPL.US.json", "000001.SZ.json"] {
        assert!(folder.join(name).exists());
    }
}
#[tokio::test]
async fn remote_sync_is_rejected_before_any_output_is_created() {
    let (dir, state) = state();
    assert!(
        sync_cli::run(
            &state,
            "profiles",
            &json!({"codes":"600036.SH","remote":true})
        )
        .await
        .is_err()
    );
    assert!(!dir.path().join("config").exists());
}
