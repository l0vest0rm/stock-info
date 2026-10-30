//! Frozen outputs captured while every assertion in the old basic opportunity
//! checker passed. No JavaScript backend or Node subprocess is needed here.
use flate2::read::GzDecoder;
use serde_json::{Value, json};
use std::{collections::BTreeSet, io::Read};
use stock_info_local::{AppState, dashboard::domain, db::Database, xueqiu};

fn equivalent(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!(
                (a - b).abs() <= 1e-10_f64.max(b.abs() * 1e-12),
                "{path}: {a} != {b}"
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                equivalent(a, b, &format!("{path}/{i}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}: object fields"
            );
            for (key, value) in b {
                equivalent(&a[key], value, &format!("{path}/{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn every_original_basic_opportunity_and_valuation_call_keeps_its_full_output() {
    let mut bytes = Vec::new();
    GzDecoder::new(&include_bytes!("fixtures/retired-baseline.json.gz")[..])
        .read_to_end(&mut bytes)
        .unwrap();
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fixture["summary"]["cases"], 17);
    let calls = fixture["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 87, "all former basic calls must execute");
    assert_eq!(
        calls
            .iter()
            .map(|c| c["group"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        18
    );
    let mut counts = [0; 4];
    for (index, case) in calls.iter().enumerate() {
        let args = case["args"].as_array().unwrap();
        let actual = match case["op"].as_str().unwrap() {
            "band" => {
                counts[0] += 1;
                json!(domain::band_position(
                    args[0].as_f64().unwrap_or(f64::NAN),
                    args[1].as_f64().unwrap(),
                    args[2].as_f64().unwrap()
                ))
            }
            "assess" => {
                counts[1] += 1;
                let mut value = domain::assess(&args[0]);
                assert!(
                    chrono::DateTime::parse_from_rfc3339(value["computedAt"].as_str().unwrap())
                        .is_ok()
                );
                value.as_object_mut().unwrap().remove("computedAt");
                value
            }
            "opportunity" => {
                counts[2] += 1;
                domain::opportunity(&args[0])
            }
            "price" => {
                counts[3] += 1;
                domain::price_metrics(
                    args[0].as_array().unwrap(),
                    &args[1],
                    args[2].as_i64().unwrap(),
                )
            }
            op => panic!("unknown frozen operation {op}"),
        };
        equivalent(
            &actual,
            &case["expected"],
            &format!("{index}: {}", case["group"]),
        );
    }
    assert_eq!(counts, [9, 4, 70, 4]);
}

#[test]
fn stock_quote_rejections_and_hong_kong_exchange_date_keep_basic_contract() {
    let quote = json!({"symbol":"00700","currency":"HKD","market_capital":5.2e12,"timestamp":chrono::DateTime::parse_from_rfc3339("2026-10-29T01:00:00Z").unwrap().timestamp_millis()});
    let parsed =
        xueqiu::parse_quote(&json!({"error_code":0,"data":{"quote":quote}}), "00700.HK").unwrap();
    assert_eq!(parsed["priceAsOf"], "2026-10-29");
    assert_eq!(parsed["marketCap"], 5.2e12);
    for text in [
        "<html>captcha</html>",
        "null",
        "{}",
        "{\"error_code\":400016}",
        "{\"error_code\":500}",
    ] {
        let result =
            xueqiu::validate_body(text).and_then(|body| xueqiu::parse_quote(&body, "NVDA.US"));
        assert!(result.is_err(), "must reject {text}");
    }
}

#[tokio::test]
async fn missing_cookie_is_rejected_before_cache_or_network_even_for_spot_quotes() {
    // Environment belongs to a new child, never mutate the parallel test process.
    if std::env::var("STOCK_INFO_COOKIE_GUARD_CHILD").as_deref() != Ok("1") {
        let dir = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "missing_cookie_is_rejected_before_cache_or_network_even_for_spot_quotes",
                "--nocapture",
            ])
            .env("STOCK_INFO_COOKIE_GUARD_CHILD", "1")
            .env_remove("XUEQIU_COOKIE")
            .env("LOCAL_DATA_DIR", dir.path())
            .env(
                "LOCAL_XUEQIU_CREDENTIAL_STORE",
                dir.path().join("missing-credential.json"),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("empty.sqlite")).unwrap();
    let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
    let error = xueqiu::stock_quote(&state, "NVDA.US", false)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("XUEQIU_COOKIE"));
}

#[tokio::test]
async fn report_forecasts_keep_publication_years_and_unauthorized_clients_never_receive_links() {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use stock_info_local::{company, router};
    use tower::ServiceExt;

    let normalized = company::reports::domain::normalize_forward(
        &json!({"publishDate":"2025-09-20","predictThisYearEps":"2","predictNextYearEps":"3","predictNextYearPe":"12","forecasts":[{"year":2026,"eps":4}]}),
    );
    assert_eq!(normalized["forecasts"][0]["year"], 2025);
    assert_eq!(normalized["forecasts"][1]["year"], 2026);
    assert_eq!(normalized["forecasts"][1]["eps"], 4.0);
    assert_eq!(normalized["forecasts"][1]["pe"], 12.0);
    for input in [
        json!({"predictThisYearEps":"2"}),
        json!({"publishDate":"2026-01-01","predictThisYearEps":""}),
    ] {
        assert!(
            company::reports::domain::normalize_forward(&input)["forecasts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    let projected = company::project_report_items(&[
        json!({"code":"300308.SZ","infoCode":"AP123","url":"https://pdf.dfcfw.com/example.pdf","llmRawResponse":"private model response","contentKey":"private-key"}),
    ]);
    assert_eq!(projected[0]["reportCarrier"], "东方财富");
    for key in ["url", "infoCode", "llmRawResponse", "contentKey"] {
        assert!(
            projected[0].get(key).is_none(),
            "projection must redact {key}"
        );
    }
    assert_eq!(
        projected[0]["reportUrl"],
        "https://pdf.dfcfw.com/example.pdf"
    );
    // The local-only runtime has no cloud anonymous session. Unauthorized
    // clients are rejected before provider access, not given a redacted list.
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("empty.sqlite")).unwrap();
    let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
    let app = router(state, dir.path());
    for (host, origin) in [
        ("evil.example:8000", None),
        ("127.0.0.1:8000", Some("https://evil.example")),
    ] {
        let mut request = Request::builder()
            .uri("/api/company/reports?code=300308.SZ&readOnly=1")
            .header("host", host);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert!(body["data"].is_null());
        let text = body.to_string();
        for secret in [
            "pdf.dfcfw.com",
            "AP123",
            "reportUrl",
            "private model response",
        ] {
            assert!(!text.contains(secret));
        }
    }
}
