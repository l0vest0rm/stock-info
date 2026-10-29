pub use stock_info_local::{ApiError, ApiResult, AppState, codes, http, ok};
#[path = "../src/knowledge/content.rs"]
mod content;
#[path = "../src/knowledge/review.rs"]
mod review;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::{fs, io::Write, path::PathBuf};
use stock_info_local::db::Database;
use tower::ServiceExt;

fn state() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db.sqlite")).unwrap();
    db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
    (dir, state)
}
async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn objects_preserve_content_range_encoding_and_head_contract() {
    let (_dir, state) = state();
    let store = state.knowledge_store().unwrap();
    store
        .put("reports/sample.pdf", b"%PDF-fixture-123456".to_vec())
        .await
        .unwrap();
    store
        .put("reports/sample.md.br", vec![1, 2, 3])
        .await
        .unwrap();
    store
        .put("featured-reports/fixture/report.json", b"{}".to_vec())
        .await
        .unwrap();
    let app = content::routes().with_state(state);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge-content/reports/sample.pdf")
                .header("range", "bytes=5-11")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-range"], "bytes 5-11/19");
    assert_eq!(
        &to_bytes(response.into_body(), 100).await.unwrap()[..],
        b"fixture"
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri("/knowledge-content/reports/sample.pdf")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-length"], "19");
    assert!(
        to_bytes(response.into_body(), 100)
            .await
            .unwrap()
            .is_empty()
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge-content/reports/sample.pdf")
                .header("range", "bytes=500-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge-content/reports/sample.md.br")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["content-encoding"], "br");
    let response = app
        .oneshot(
            Request::builder()
                .uri("/featured-reports/fixture/report.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-type"],
        "application/json; charset=utf-8"
    );
}

#[tokio::test]
async fn content_text_decodes_local_gzip_brotli_and_never_escapes() {
    let (dir, state) = state();
    let store = state.knowledge_store().unwrap();
    let text = "收入与利润\nRevenue 123";
    store
        .put("plain.md", text.as_bytes().to_vec())
        .await
        .unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(text.as_bytes()).unwrap();
    store
        .put("compressed.md.gz", gzip.finish().unwrap())
        .await
        .unwrap();
    let mut br = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::new(&mut br, 4096, 5, 22);
        writer.write_all(text.as_bytes()).unwrap();
    }
    store.put("compressed.md.br", br).await.unwrap();
    for key in [
        "plain.md",
        "knowledge-content/compressed.md.gz",
        "knowledge-content/compressed.md.br",
    ] {
        assert_eq!(
            content::read_content_text(&state, key)
                .await
                .unwrap()
                .as_deref(),
            Some(text)
        );
    }
    assert!(
        content::read_content_text(&state, "missing.md")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        content::read_content_text(&state, "../db.sqlite")
            .await
            .is_err()
    );
    assert!(
        content::read_content_text(&state, "localfs:/private")
            .await
            .is_err()
    );
    store
        .put("invalid.md.gz", b"not gzip".to_vec())
        .await
        .unwrap();
    assert!(
        content::read_content_text(&state, "invalid.md.gz")
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        let outside = dir.path().join("private.txt");
        fs::write(&outside, "private").unwrap();
        std::os::unix::fs::symlink(
            outside,
            state.data_dir().join("knowledge-content/escape.md"),
        )
        .unwrap();
        assert!(
            content::read_content_text(&state, "escape.md")
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn converter_rejects_untrusted_urls_before_network_and_reads_valid_cache() {
    let (dir, state) = state();
    let app = content::routes().with_state(state.clone());
    for url in [
        "http://127.0.0.1/secret.pdf",
        "https://evil.example/file.pdf",
        "https://user:secret@pdf.dfcfw.com/report.pdf",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/__convert-report")
                    .body(Body::from(
                        json!({"docId":"valid_report_id","url":url}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(json_body(response).await["data"], Value::Null);
    }
    let cache = dir.path().join("data/local/knowledge-work/markdown-cache");
    fs::create_dir_all(&cache).unwrap();
    fs::write(
        cache.join("valid_report_id.md"),
        "# Cached report\nRevenue 123",
    )
    .unwrap();
    assert_eq!(
        content::convert_report(
            &state,
            "valid_report_id",
            "https://pdf.dfcfw.com/report.pdf"
        )
        .await
        .unwrap(),
        "# Cached report\nRevenue 123"
    );
    assert!(
        content::convert_report(&state, "../private", "https://pdf.dfcfw.com/report.pdf")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn filtered_review_keep_persists_object_document_tags_links_atomically() {
    let (dir, state) = state();
    let review_dir = dir.path().join("data/knowledge-review");
    fs::create_dir_all(&review_dir).unwrap();
    fs::write(review_dir.join("topic-filter-2026-10-29.jsonl"),json!({"keep":false,"docId":"review_fixture_123","title":"银行财报","sourceType":"local_news","sourceName":"测试来源","targetName":"招商银行","targetCode":"600036.SH","publishedAt":"2026-10-29T00:00:00Z","score":10,"method":"test","reasons":["fixture"],"content":"# 财报\n收入增长"}).to_string()).unwrap();
    let app = review::routes().with_state(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge/filtered")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let list = json_body(response).await;
    assert_eq!(list["data"]["total"], 1);
    assert_eq!(list["data"]["list"][0]["source_type"], "filtered_review");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/knowledge/filtered/doc?id=review_fixture_123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        json_body(response).await["data"]["content"],
        "# 财报\n收入增长"
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/knowledge/filtered/keep")
                .header("content-type", "application/json")
                .body(Body::from("{\"id\":\"review_fixture_123\"}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["data"]["kept"], true);
    let rows=state.db.query("SELECT d.doc_id,c.content_sha256,l.code,t.tag FROM knowledge_docs d JOIN knowledge_doc_content_refs c USING(doc_id) JOIN knowledge_doc_security_links l USING(doc_id) JOIN knowledge_doc_tags t USING(doc_id) WHERE d.doc_id=?",vec![json!("review_fixture_123")]).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["code"], "600036.SH");
    assert_eq!(rows[0]["tag"], "review_kept");
    assert_eq!(rows[0]["content_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(
        content::read_content_text(
            &state,
            "knowledge-content/local-review/review_fixture_123.md"
        )
        .await
        .unwrap()
        .as_deref(),
        Some("# 财报\n收入增长")
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/knowledge/filtered")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(response).await["data"]["total"], 0);
}

#[tokio::test]
#[ignore = "requires dedicated Python pymupdf4llm or pymupdf renderer"]
async fn real_pdf_renderer_converts_a_local_cached_fixture() {
    use lopdf::{
        Document, Object, Stream,
        content::{Content, Operation},
        dictionary,
    };
    let (directory, state) = state();
    let work = directory.path().join("data/local/knowledge-work");
    fs::create_dir_all(work.join("remote-pdf")).unwrap();
    let mut pdf = Document::with_version("1.5");
    let pages_id = pdf.new_object_id();
    let font_id =
        pdf.add_object(dictionary! { "Type"=>"Font", "Subtype"=>"Type1", "BaseFont"=>"Helvetica" });
    let resources_id = pdf.add_object(dictionary! { "Font"=>dictionary! { "F1"=>font_id } });
    let contents = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![50.into(), 750.into()]),
            Operation::new("Tj", vec![Object::string_literal("Revenue 123")]),
            Operation::new("ET", vec![]),
        ],
    };
    let content_id = pdf.add_object(Stream::new(
        lopdf::Dictionary::new(),
        contents.encode().unwrap(),
    ));
    let page_id = pdf.add_object(dictionary! { "Type"=>"Page", "Parent"=>pages_id, "Contents"=>content_id, "Resources"=>resources_id, "MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()] });
    pdf.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! { "Type"=>"Pages", "Kids"=>vec![page_id.into()], "Count"=>1 },
        ),
    );
    let catalog = pdf.add_object(dictionary! { "Type"=>"Catalog", "Pages"=>pages_id });
    pdf.trailer.set("Root", catalog);
    let input = work.join("remote-pdf/renderer_fixture.pdf");
    pdf.save(&input).unwrap();
    let mut bytes = fs::read(&input).unwrap();
    bytes.resize(bytes.len().max(1200), b' ');
    fs::write(&input, bytes).unwrap();
    let markdown = content::convert_report(
        &state,
        "renderer_fixture",
        "https://pdf.dfcfw.com/fixture.pdf",
    )
    .await
    .unwrap();
    assert!(markdown.contains("Revenue 123"));
    assert!(work.join("markdown-cache/renderer_fixture.md").is_file());
}
