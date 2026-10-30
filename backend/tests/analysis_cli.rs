use serde_json::Value;
use stock_info_local::analysis_cli;
fn compare(actual: &Value, expected: &Value, context: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!(
                (a - b).abs() <= 1e-10 * a.abs().max(b.abs()).max(1.0),
                "{context}: {a} != {b}"
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{context}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                compare(a, b, &format!("{context}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{context}");
            for (k, b) in b {
                compare(
                    a.get(k).unwrap_or_else(|| panic!("{context}: missing {k}")),
                    b,
                    &format!("{context}.{k}"),
                );
            }
        }
        _ => assert_eq!(actual, expected, "{context}"),
    }
}
#[test]
fn native_stateless_analysis_preserves_original_full_outputs() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/analysis-cli.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 219);
    for (index, case) in cases.iter().enumerate() {
        let actual = analysis_cli::evaluate(&case["input"]).unwrap();
        compare(&actual, &case["expected"], &format!("case {index}"));
    }
}
#[test]
fn rejects_unknown_operation_and_does_not_open_database() {
    assert!(analysis_cli::evaluate(&serde_json::json!({"op":"unknown"})).is_err());
    assert!(analysis_cli::evaluate(&Value::Null).is_err());
    assert_eq!(
        analysis_cli::evaluate(&serde_json::json!([])).unwrap(),
        serde_json::json!([])
    );
}

#[test]
fn stdin_cli_is_stateless_even_without_project_config_or_valid_server_settings() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let root = tempfile::tempdir().unwrap();
    for (body, succeeds) in [
        (r#"{"op":"constants"}"#, true),
        (r#"{"op":"unknown"}"#, false),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_stock-info-local"))
            .arg("--analysis-json")
            .current_dir(root.path())
            .env("HOST", "not-a-host")
            .env("PORT", "not-a-port")
            .env("LOCAL_DB_PATH", root.path().join("must-not-create.sqlite"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.success(),
            succeeds,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        if succeeds {
            let response: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(response["minimumCoverage"], 0.25);
            assert_eq!(response["fields"]["pe_ttm"]["seriesKey"], "peTtm");
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
