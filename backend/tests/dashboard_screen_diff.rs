//! Contract acceptance against complete frozen outputs of the retired backend.
//! No providers, database, current wall clock or fabricated model outputs are used.
use serde_json::{Value, json};
use stock_info_local::dashboard::{domain, point_in_time};

fn equivalent(actual: &Value, expected: &Value, path: &str) {
    if let (Some(a), Some(b)) = (actual.as_f64(), expected.as_f64()) {
        assert!(
            (a - b).abs() <= 1e-12_f64.max(b.abs() * 1e-12),
            "{path}: {a} != {b}"
        );
        return;
    }
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}: fields"
            );
            for (key, value) in b {
                equivalent(&a[key], value, &format!("{path}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                equivalent(a, b, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn screen_assessment_and_knowledge_time_match_original_domain() {
    // Captured from the original implementation before retiring its sources.
    // Preserve every input and complete expected object; never regenerate with Rust.
    let cases: Vec<Value> = serde_json::from_reader(flate2::read::GzDecoder::new(
        include_bytes!("fixtures/dashboard_screen_diff.json.gz").as_slice(),
    ))
    .expect("frozen original-domain fixture must decode");
    assert_eq!(cases.len(), 65, "complete frozen gate matrix must execute");
    for (i, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let actual = match case["op"].as_str().unwrap() {
            "screen" => domain::screen(input),
            "assess" => {
                let mut value = domain::assess(input);
                value.as_object_mut().unwrap().remove("computedAt");
                value
            }
            "pit" => json!(point_in_time::build(
                input["statements"].as_array().unwrap(),
                input["marketCaps"].as_array().unwrap(),
                300.0
            )),
            _ => unreachable!(),
        };
        equivalent(
            &actual,
            &case["expected"],
            &format!("case {i} {}", case["op"]),
        );
    }
}
