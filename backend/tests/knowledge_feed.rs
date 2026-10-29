//! Unchanged feed handlers tested with a temporary, historically migrated DB.
pub use stock_info_local::{ApiError, ApiResult, AppState, ok};
#[path = "../src/knowledge/feed.rs"]
pub mod feed;
#[path = "../src/knowledge/information_records.rs"]
pub mod information_records;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{Value, json};
use stock_info_local::db::Database;
use tempfile::TempDir;
use tower::ServiceExt;

fn setup() -> (TempDir, Database, Router) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("fixture.sqlite")).unwrap();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    db.migrate(&root.join("migrations")).unwrap();
    let state = AppState::new(db.clone(), root, "127.0.0.1:8000".into()).unwrap();
    let app = Router::new().nest("/api", feed::routes()).with_state(state);
    (dir, db, app)
}
async fn get(app: &Router, path: &str) -> (StatusCode, Value) {
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
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn published(hours_ago: i64) -> String {
    (Utc::now() - Duration::hours(hours_ago)).to_rfc3339_opts(SecondsFormat::Millis, true)
}
async fn imported(db: &Database, id: &str, story: &str, date: &str, hash_valid: bool) {
    let hash = information_records::sha256_text("fixture original body");
    let metadata = json!({"feed":{"version":"v2","importVersion":"api-v1","originalFormat":"text","publishAllowed":true,"fullBodyHash":hash,"storyKey":story,"contentType":"news","kind":"new","sources":[{"sourceKey":"fixture_source"}]}});
    db.execute("INSERT INTO knowledge_docs(doc_id,source_type,source_name,title,published_at,sort_time,access_method,metadata_json,inline_content,inline_content_sha256,updated_at) VALUES(?,'information_feed','fixture','Imported fixture',?,?,'markdown',?,'fixture original body',?,1)",vec![json!(id),json!(date),json!(date),json!(metadata.to_string()),json!(if hash_valid {hash}else{"wrong".into()})]).await.unwrap();
}
async fn legacy(db: &Database, id: &str, story: &str, valid: bool) -> Value {
    let now = Utc::now().timestamp_millis();
    let date = published(0);
    let contracts = information_records::extraction_contracts().unwrap();
    let row = json!({"information_id":format!("i_{id}"),"doc_id":id,"entity":"招商银行","entity_key":"company:600036.SH","information_type":"fact","category":"net_profit","period":"2026-Q3","statement":"fixture factual statement","forecast_measurement_json":r#"{"value":100.0,"scale":1e20}"#,"sort_order":0,"created_at":now});
    let mut current = contracts[0].clone();
    for (key,value) in json!({"storageVersion":"information-records-v1","provenanceStatus":"verified","inputFingerprint":"fixture-fingerprint","contentSha256":"fixture-body-sha","recordsDigest":if valid {information_records::sha256_text(&information_records::records_digest_input(std::slice::from_ref(&row)).unwrap())}else{"corrupted".into()},"recordCount":1,"title":"Legacy fixture","publishedAt":date,"outcome":"extracted","categoryCandidateCount":0}).as_object().unwrap() {current[key]=value.clone();}
    let policy: Value = serde_json::from_str(include_str!(
        "../../config/knowledge/information-feed-policy.json"
    ))
    .unwrap();
    let metadata = json!({"feed":{"version":"v1","originalFormat":"text","storyKey":story,"contentType":"news","kind":"new","sources":[{"sourceKey":"legacy_source"}],"investmentGate":{"policyVersion":policy["relevance"]["version"],"effectiveDisposition":"pass","title":"Legacy fixture","bodySha256":"fixture-body-sha","reasonCodes":["stock"],"evidence":["600036.SH","招商银行"],"matchedKeywords":[]}},"informationExtraction":{"status":"complete","current":current,"categoryCandidates":[]}});
    let id = id.to_string();
    db.run(move|conn| {
        let tx=conn.transaction()?;
        tx.execute("INSERT INTO knowledge_docs(doc_id,source_type,title,published_at,sort_time,access_method,metadata_json,updated_at) VALUES(?1,'information_feed','Legacy fixture',?2,?2,'markdown',?3,?4)",rusqlite::params![id,date,metadata.to_string(),now])?;
        tx.execute("INSERT INTO knowledge_doc_content_refs(doc_id,content_key,content_sha256,updated_at) VALUES(?1,'knowledge-content/fixture.md','fixture-body-sha',?2)",rusqlite::params![id,now])?;
        tx.execute("INSERT INTO knowledge_information_records(information_id,doc_id,entity,entity_key,information_type,category,period,statement,forecast_measurement_json,sort_order,created_at) VALUES(?1,?2,'招商银行','company:600036.SH','fact','net_profit','2026-Q3','fixture factual statement',?3,0,?4)",rusqlite::params![format!("i_{id}"),id,r#"{"value":100.0,"scale":1e20}"#,now])?;
        for tag in ["company:600036.SH","category:net_profit"] {
            tx.execute("INSERT INTO knowledge_doc_tags(doc_id,tag,weight,tagging_input_fingerprint,contract_version) VALUES(?1,?2,100,'fixture-fingerprint',?3)",rusqlite::params![id,tag,contracts[0]["contractVersion"].as_str().unwrap()])?;
        }
        tx.commit()?;
        Ok(())
    }).await.unwrap();
    row
}

#[tokio::test]
async fn imported_versions_deduplicate_and_inline_integrity_is_required() {
    let (_dir, db, app) = setup();
    let story = "f_000000000000000000000001";
    imported(&db, "old", story, &published(1000), true).await;
    imported(&db, "new", story, &published(0), true).await;
    imported(
        &db,
        "unrelated",
        "f_000000000000000000000002",
        &published(1000),
        true,
    )
    .await;
    imported(
        &db,
        "bad",
        "f_000000000000000000000003",
        &published(0),
        false,
    )
    .await;
    let (status, response) = get(&app, "/api/knowledge/feed").await;
    assert_eq!(status, StatusCode::OK);
    let rows = response["data"]["list"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["doc_id"], "new");
    assert_eq!(rows[0]["tagging_status"], "source_only");
    assert_eq!(rows[0]["records"], json!([]));
    let (_, story_response) = get(&app, &format!("/api/knowledge/feed/story?key={story}")).await;
    assert_eq!(story_response["data"]["list"].as_array().unwrap().len(), 2);
    assert_eq!(story_response["data"]["list"][0]["doc_id"], "old");
    let (_, facets) = get(&app, "/api/knowledge/feed/facets").await;
    assert_eq!(
        facets["data"]["sources"],
        json!([{"id":"fixture_source","count":2}])
    );
}

#[tokio::test]
async fn validated_extractions_preserve_records_digest_filters_and_facets() {
    let (_dir, db, app) = setup();
    legacy(&db, "verified", "f_000000000000000000000001", true).await;
    legacy(&db, "corrupt", "f_000000000000000000000002", false).await;
    let (_, response) = get(
        &app,
        "/api/knowledge/feed?company=600036.SH&category=net_profit",
    )
    .await;
    let rows = response["data"]["list"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let verified = rows.iter().find(|row| row["doc_id"] == "verified").unwrap();
    assert_eq!(verified["tagging_status"], "complete");
    assert_eq!(verified["records"].as_array().unwrap().len(), 1);
    assert_eq!(
        verified["records"][0]["forecastMeasurement"]["value"],
        100.0
    );
    assert_eq!(verified["records"][0]["entity_key"], "company:600036.SH");
    let corrupt = rows.iter().find(|row| row["doc_id"] == "corrupt").unwrap();
    assert_eq!(corrupt["tagging_status"], "pending");
    assert_eq!(corrupt["records"], json!([]));
    assert_eq!(corrupt["tags"], json!([]));
    let (_, facets) = get(&app, "/api/knowledge/feed/facets").await;
    assert_eq!(facets["data"]["entities"][0]["id"], "company:600036.SH");
    assert_eq!(facets["data"]["entities"][0]["count"], 1);
    let (_, unmatched) = get(&app, "/api/knowledge/feed?entity=entity%3Anot-matched").await;
    assert_eq!(unmatched["data"]["list"], json!([]));
}

#[tokio::test]
async fn cursors_and_invalid_filters_are_bounded_without_sql_interpolation() {
    let (_dir, db, app) = setup();
    for index in 0..3 {
        imported(
            &db,
            &format!("doc{index}"),
            &format!("f_{index:024}"),
            &published(0),
            true,
        )
        .await;
    }
    let (_, first) = get(&app, "/api/knowledge/feed?limit=1").await;
    assert_eq!(first["data"]["has_next"], true);
    let cursor = first["data"]["next_cursor"].as_str().unwrap();
    let mut url = reqwest::Url::parse("http://fixture/api/knowledge/feed").unwrap();
    url.query_pairs_mut()
        .append_pair("limit", "1")
        .append_pair("cursor", cursor);
    let (_, second) = get(&app, &format!("{}?{}", url.path(), url.query().unwrap())).await;
    assert_ne!(
        first["data"]["list"][0]["doc_id"],
        second["data"]["list"][0]["doc_id"]
    );
    for path in [
        "/api/knowledge/feed?category=unknown",
        "/api/knowledge/feed?industry=unknown",
        "/api/knowledge/feed?status=source_only",
        "/api/knowledge/feed?cursor=broken",
        "/api/knowledge/feed?entity=entity%3A%25GG",
        "/api/knowledge/feed/story?key=f_%27OR1%3D1",
    ] {
        assert_eq!(get(&app, path).await.0, StatusCode::BAD_REQUEST, "{path}");
    }
    let date_cursor = STANDARD.encode(r#"{"time":"2026-10-29","id":"doc1"}"#);
    let mut url = reqwest::Url::parse("http://fixture/api/knowledge/feed").unwrap();
    url.query_pairs_mut().append_pair("cursor", &date_cursor);
    assert_eq!(
        get(&app, &format!("{}?{}", url.path(), url.query().unwrap()))
            .await
            .0,
        StatusCode::OK
    );
    let (_, none) = get(&app, "/api/knowledge/feed?source=%27%20OR%201%3D1--").await;
    assert_eq!(none["data"]["list"], json!([]));
    assert_eq!(
        db.query("SELECT count(*) AS n FROM knowledge_docs", vec![])
            .await
            .unwrap()[0]["n"],
        3
    );
}
