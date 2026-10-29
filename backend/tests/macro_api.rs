use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use stock_info_local::{
    AppState,
    db::Database,
    macro_data::{self, repository},
};
use tower::ServiceExt;

fn setup() -> (tempfile::TempDir, Database, Router) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path().join("macro.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(
        db.clone(),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."),
        "127.0.0.1:18000".into(),
    )
    .unwrap();
    let app = Router::new()
        .nest("/api", macro_data::routes())
        .with_state(state);
    (directory, db, app)
}

async fn get(app: Router, path: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let value =
        serde_json::from_slice(&to_bytes(response.into_body(), 2_000_000).await.unwrap()).unwrap();
    (status, value)
}

#[tokio::test]
async fn macro_catalog_and_windowed_asof_preserve_revisions_without_writes() {
    let (_directory, db, app) = setup();
    let indicators = repository::list_indicators(&db, true).await.unwrap();
    let indicator = indicators
        .first()
        .expect("historical migrations provide macro catalog");
    let id = indicator["id"].as_i64().unwrap();
    repository::put_data(
        &db,
        &[
            json!({"indicatorId":id,"periodDay":20250101,"publishedAt":90,"value":80.0}),
            json!({"indicatorId":id,"periodDay":20260101,"publishedAt":100,"value":100.0}),
            json!({"indicatorId":id,"periodDay":20260101,"publishedAt":200,"value":120.0}),
        ],
    )
    .await
    .unwrap();
    let before = db
        .query("SELECT COUNT(*) AS count FROM macro_data", vec![])
        .await
        .unwrap();
    let (status, catalog) = get(app.clone(), "/api/macro/catalog").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(catalog["code"], 200);
    assert!(!catalog["data"]["regions"].as_array().unwrap().is_empty());
    let definition = &catalog["data"]["series"][0];
    assert!(definition.get("nextFetchAt").is_none());
    assert!(definition.get("lastError").is_none());
    assert!(definition.get("metric").is_some());
    assert!(catalog["data"]["capabilities"]["frequencies"].is_array());
    for (as_of, expected) in [(150, 100.0), (250, 120.0)] {
        let (status, series) = get(
            app.clone(),
            &format!("/api/macro/series?ids={id},{id}&from=2026-01-01&to=2026-12-31&asOf={as_of}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(series["data"]["series"].as_array().unwrap().len(), 1);
        let points = series["data"]["series"][0]["points"].as_array().unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0]["value"], expected);
        assert_eq!(points[0]["period"], "2026-01-01");
        assert_eq!(series["data"]["comparison"]["status"], "single_series");
    }
    let (status, overview) = get(
        app.clone(),
        &format!(
            "/api/macro/overview?regions={}&asOf=150",
            indicator["regionCode"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entry = overview["data"]["series"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["definition"]["id"] == id)
        .unwrap();
    assert_eq!(entry["current"]["value"], 100.0);
    assert_eq!(entry["availability"]["status"], "available");
    assert_eq!(
        before,
        db.query("SELECT COUNT(*) AS count FROM macro_data", vec![])
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn macro_parameter_errors_remain_explicit_json_failures() {
    let (_directory, _db, app) = setup();
    for path in [
        "/api/macro/series",
        "/api/macro/series?ids=0&from=2026-01-01&to=2026-12-31",
        "/api/macro/series?ids=1&from=2026-02-30&to=2026-12-31",
        "/api/macro/series?ids=1&from=2026-12-31&to=2026-01-01",
        "/api/macro/series?ids=1&from=2026-01-01&to=2026-12-31&measure=zscore",
        "/api/macro/series?ids=99999999&from=2026-01-01&to=2026-12-31",
        "/api/macro/overview?asOf=-2",
        "/api/macro/overview?asOf=not-a-date",
    ] {
        let (status, response) = get(app.clone(), path).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(response["code"], 400);
        assert_eq!(response["data"], Value::Null);
    }
}
