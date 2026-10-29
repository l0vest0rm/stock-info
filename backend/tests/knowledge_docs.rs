use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::path::PathBuf;
use stock_info_local::{AppState, db::Database, knowledge};
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(root.path().join("db.sqlite")).unwrap();
    db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, root.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
    (root, state)
}
async fn seed(state: &AppState, id: &str, source_type: &str, title: &str, metadata: Value) {
    state.db.execute("INSERT INTO knowledge_docs(doc_id,source_type,report_type,source_name,source_name_normalized,title,url,published_at,fetched_at,sort_time,access_method,content_preview,metadata_json,updated_at) VALUES(?,?,'company_report','测试来源','测试来源',?,'https://example.com/report.pdf','2026-10-29T10:00:00.000Z','2026-10-29T10:00:00.000Z','2026-10-29T10:00:00.000Z','remote_pdf',?,?,1)",vec![json!(id),json!(source_type),json!(title),json!(title),json!(metadata.to_string())]).await.unwrap();
}
async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn stored_content_reference_drives_markdown_route_and_inline_detail() {
    let (_dir, state) = fixture();
    seed(&state,"doc1","research_report","测试研报",json!({"stockLinks":[{"name":"招商银行","code":"600036.SH","aliases":["招行"]}],"pageCount":12})).await;
    state.db.execute("UPDATE knowledge_docs SET target_name='招商银行',target_code='600036.SH',inline_content='inline detail',recommendation_tags_json='[\"招商银行\",\"600036.SH\",\"成长\"]' WHERE doc_id='doc1'",vec![]).await.unwrap();
    state.db.execute("INSERT INTO knowledge_doc_content_refs(doc_id,content_key,content_url,content_type,content_encoding,content_bytes,content_sha256,updated_at) VALUES('doc1','knowledge-content/reports/fixture.md','','text/markdown','identity',5,'fixture',1)",vec![]).await.unwrap();
    let app = knowledge::routes().with_state(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge/doc?id=doc1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data = body(response).await["data"].clone();
    assert_eq!(data["access_method"], "markdown");
    assert_eq!(data["content"], "inline detail");
    assert_eq!(
        data["content_url"],
        "http://127.0.0.1:8000/knowledge-content/reports/fixture.md"
    );
    assert_eq!(data["tags"], json!(["成长", "pdf"]));
    assert_eq!(data["stock_links"][0]["code"], "600036.SH");
    assert_eq!(data["report_pages"], 12.0);
    let probe = state.db.connect().unwrap();
    let before: i64 = probe
        .pragma_query_value(None, "data_version", |row| row.get(0))
        .unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/knowledge/docs?sourceType=company_report")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let data = body(response).await["data"].clone();
    assert_eq!(data["list"].as_array().unwrap().len(), 1);
    assert_eq!(data["list"][0]["access_method"], "markdown");
    assert!(data["list"][0].get("content").is_none());
    assert_eq!(
        before,
        probe
            .pragma_query_value(None, "data_version", |row| row.get::<_, i64>(0))
            .unwrap()
    );
}

#[tokio::test]
async fn document_filters_pagination_and_dedup_preserve_shape() {
    let (_dir, state) = fixture();
    seed(
        &state,
        "a",
        "external_document",
        "共同标题",
        json!({"source":"tencent_stock_news"}),
    )
    .await;
    seed(
        &state,
        "b",
        "external_document",
        "共同标题",
        json!({"source":"tencent_stock_news"}),
    )
    .await;
    seed(&state, "c", "research_report", "独立研报", json!({})).await;
    state
        .db
        .execute(
            "INSERT INTO knowledge_doc_security_links(doc_id,code) VALUES('c','600036.SH')",
            vec![],
        )
        .await
        .unwrap();
    state
        .db
        .execute(
            "INSERT INTO knowledge_doc_tags(doc_id,tag,weight) VALUES('c','growth',100)",
            vec![],
        )
        .await
        .unwrap();
    let app = knowledge::routes().with_state(state);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge/docs?pageSize=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let data = body(response).await["data"].clone();
    assert_eq!(data["page"], 1);
    assert_eq!(data["page_size"], 1);
    assert_eq!(data["total"], 2);
    assert_eq!(data["has_next"], true);
    for path in [
        "/knowledge/docs?code=600036.SH",
        "/knowledge/docs?tags=growth",
        "/knowledge/docs?sourceType=company_report",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let data = body(response).await["data"].clone();
        assert_eq!(data["list"].as_array().unwrap().len(), 1);
        assert_eq!(data["list"][0]["doc_id"], "c");
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/knowledge/docs?code=%27%20OR%201%3D1%20--")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body(response).await["data"]["list"], json!([]));
}

#[tokio::test]
async fn redirects_are_local_or_valid_originals_and_failures_explicit() {
    let (_dir, state) = fixture();
    seed(&state, "doc", "external_document", "外部文档", json!({})).await;
    let app = knowledge::routes().with_state(state);
    for (path, status) in [
        ("/knowledge/doc", StatusCode::BAD_REQUEST),
        ("/knowledge/doc?id=missing", StatusCode::NOT_FOUND),
        ("/knowledge/content?key=localfs:private", StatusCode::GONE),
        ("/knowledge/content?key=../private", StatusCode::BAD_REQUEST),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge/file?id=doc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response.headers()["location"],
        "https://example.com/report.pdf"
    );
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    let response = app
        .oneshot(
            Request::builder()
                .uri("/knowledge/content?key=knowledge-content/external/a.txt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response.headers()["location"],
        "http://127.0.0.1:8000/knowledge-content/external/a.txt"
    );
}

#[tokio::test]
async fn cached_report_analysis_does_not_submit_model_work() {
    let (_dir, state) = fixture();
    seed(
        &state,
        "cached",
        "research_report",
        "已完成研报",
        json!({"pageCount":9}),
    )
    .await;
    let analysis = json!({"analysisCalled":true,"analysisSucceeded":true,"forecasts":[{"year":2026,"revenue":10,"netProfit":2,"profitGrowth":20}],"targetPrice":15,"updatedAt":123});
    state
        .db
        .put_kv(
            "knowledge_report_analysis",
            "knowledge-report-analysis:cached",
            &analysis,
            None,
        )
        .await
        .unwrap();
    let app = knowledge::routes().with_state(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/knowledge/report-analysis")
                .header("content-type", "application/json")
                .body(Body::from("{\"id\":\"cached\"}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data = body(response).await["data"].clone();
    assert_eq!(data["analysis_updated_at"], 123);
    assert_eq!(data["analysis_called"], true);
    assert_eq!(data["forecasts"][0]["profit_growth"], 20.0);
    assert!(data["latest_price"].is_null());
    assert!(data["peg_2026"].is_null());
    assert_eq!(data["recommended"], false);
    assert_eq!(data["target_price"], 15);
}

#[tokio::test]
async fn unauthenticated_import_cannot_persist_documents() {
    let (_dir, state) = fixture();
    let db = state.db.clone();
    let app = knowledge::routes().with_state(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/knowledge/import")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        db.query("SELECT doc_id FROM knowledge_docs", vec![])
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn filtered_file_redirect_uses_review_files_after_legacy_tables_are_dropped() {
    let (dir, state) = fixture();
    let review = dir.path().join("data/knowledge-review");
    std::fs::create_dir_all(&review).unwrap();
    let rows = [
        json!({"docId":"pending","keep":false,"url":"https://example.com/original.pdf"}),
        json!({"docId":"unsafe","keep":false,"url":"https://user:secret@example.com/private.pdf"}),
        json!({"docId":"kept","keep":true,"url":"https://example.com/kept.pdf"}),
        json!({"docId":"empty","keep":false,"url":""}),
    ];
    std::fs::write(
        review.join("topic-filter-20261029.jsonl"),
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    assert!(
        state
            .db
            .query(
                "SELECT name FROM sqlite_master WHERE name='knowledge_filtered_docs'",
                vec![]
            )
            .await
            .unwrap()
            .is_empty()
    );
    let app = knowledge::routes().with_state(state);
    for (id, status) in [
        ("pending", StatusCode::FOUND),
        ("unsafe", StatusCode::BAD_REQUEST),
        ("kept", StatusCode::NOT_FOUND),
        ("empty", StatusCode::NOT_FOUND),
        ("missing", StatusCode::NOT_FOUND),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/knowledge/file?id={id}&filtered=1"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{id}");
        if id == "pending" {
            assert_eq!(
                response.headers()["location"],
                "https://example.com/original.pdf"
            );
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        }
    }
}
