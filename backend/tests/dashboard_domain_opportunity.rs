use serde_json::{Value, json};
use stock_info_local::dashboard::domain;

fn assert_equivalent(actual: &Value, expected: &Value, path: &str) {
    if let (Some(a), Some(b)) = (actual.as_f64(), expected.as_f64()) {
        assert!(
            (a - b).abs() <= 1e-10_f64.max(b.abs() * 1e-12),
            "{path}: {a} != {b}"
        );
        return;
    }
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}: object fields differ"
            );
            for (key, value) in b {
                assert_equivalent(&a[key], value, &format!("{path}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length differs");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_equivalent(a, b, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn opportunity_full_payload_matches_typescript_across_policy_gates() {
    // Captured from the original implementation before retiring its sources.
    // Preserve every input and complete expected object; never regenerate with Rust.
    let cases: Vec<Value> = serde_json::from_reader(flate2::read::GzDecoder::new(
        include_bytes!("fixtures/dashboard_domain_opportunity.json.gz").as_slice(),
    ))
    .expect("frozen original-domain fixture must decode");
    assert_eq!(cases.len(), 343, "complete frozen gate matrix must execute");
    for case in &cases {
        let actual = domain::opportunity(&case["input"]);
        assert_equivalent(&actual, &case["expected"], case["label"].as_str().unwrap());
    }
}

#[test]
fn conservative_valuation_boundary_and_missing_inputs() {
    for (cap, expected) in [
        (79.0, "undervalued"),
        (80.0, "fair_low"),
        (129.0, "fair_low"),
        (130.0, "fair"),
        (180.0, "fair"),
        (216.0, "expensive"),
        (217.0, "very_expensive"),
        (-1.0, "unknown"),
    ] {
        assert_eq!(domain::band_position(cap, 80.0, 180.0), expected);
    }
    let input = json!({"result":{"verdict":"watch","basis":{"key":"pe_ttm"},"position":{"marketCap":100},"growth":{"verdict":"supports","ttmGrowth":0.1},"note":"fixture"},"bands":{"bands":[{"key":"pe_ttm","label":"PE","role":"primary","status":"available","unit":"multiple","range":{"low":8,"high":18},"denominator":{"value":10,"reportDate":"2026-06-30"},"assumptions":[]}],"warnings":[]},"series":{"points":[]},"statements":[],"bars":[],"quote":null,"historyComparable":true});
    assert_eq!(domain::assess(&input)["conservativeMargin"], -0.25);
    let mut yield_input = input.clone();
    yield_input["result"]["basis"]["key"] = json!("fcf_yield");
    yield_input["bands"]["bands"][0]["key"] = json!("fcf_yield");
    yield_input["bands"]["bands"][0]["unit"] = json!("percent");
    yield_input["bands"]["bands"][0]["range"] = json!({"low":3,"high":6});
    assert!(
        (domain::assess(&yield_input)["conservativeMargin"]
            .as_f64()
            .unwrap()
            - 0.4)
            .abs()
            < 1e-12
    );
}
