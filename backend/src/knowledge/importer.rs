use super::{object_key, text};
use crate::{ApiError, ApiResult, AppState, ok};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_CONTENT: usize = 256 * 1024;
fn bad(status: StatusCode, msg: &str) -> ApiError {
    ApiError(status, msg.into())
}
fn nonempty(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max)
}
pub(crate) fn token_matches(expected: &str, supplied: &str) -> bool {
    if expected.is_empty() || expected.len() != supplied.len() {
        return false;
    }
    expected
        .bytes()
        .zip(supplied.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}
fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

pub async fn import(State(state): State<AppState>, request: Request) -> ApiResult {
    let bearer = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(char::is_whitespace))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim_start_matches(char::is_whitespace))
        .unwrap_or("");
    if !token_matches(&state.setting("KNOWLEDGE_IMPORT_TOKEN"), bearer) {
        return Err(bad(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(bad(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected application/json",
        ));
    }
    let bytes = to_bytes(request.into_body(), MAX_CONTENT + 8192)
        .await
        .map_err(|_| bad(StatusCode::BAD_REQUEST, "invalid or oversized JSON"))?;
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|_| bad(StatusCode::BAD_REQUEST, "invalid or oversized JSON"))?;
    import_payload(&state, payload).await
}

pub(crate) async fn import_payload(state: &AppState, payload: Value) -> ApiResult {
    let source = text(&payload["sourceKey"]);
    let valid = payload.is_object()
        && nonempty(&payload["sourceKey"], 64)
        && regex::Regex::new(r"^[a-z0-9][a-z0-9_-]*$")
            .unwrap()
            .is_match(source)
        && nonempty(&payload["sourceItemId"], 200)
        && nonempty(&payload["title"], 200)
        && nonempty(&payload["url"], 2048)
        && valid_url(text(&payload["url"]))
        && nonempty(&payload["publishedAt"], 40)
        && regex::Regex::new(
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$",
        )
        .unwrap()
        .is_match(text(&payload["publishedAt"]))
        && chrono::DateTime::parse_from_rfc3339(text(&payload["publishedAt"])).is_ok()
        && nonempty(&payload["body"], MAX_CONTENT)
        && (payload.get("sourceType").is_none()
            || matches!(
                text(&payload["sourceType"]),
                "information_feed" | "external_document"
            ))
        && (payload.get("sourceName").is_none() || nonempty(&payload["sourceName"], 100));
    if !valid {
        return Err(bad(StatusCode::BAD_REQUEST, "invalid knowledge import"));
    }
    let normalized = text(&payload["body"])
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string();
    if normalized.is_empty() || normalized.len() > MAX_CONTENT || normalized.contains('\0') {
        return Err(bad(StatusCode::BAD_REQUEST, "invalid content"));
    }
    let source_type = payload["sourceType"].as_str().unwrap_or("information_feed");
    let published = chrono::DateTime::parse_from_rfc3339(text(&payload["publishedAt"]))
        .unwrap()
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let now = chrono::Utc::now();
    let content_hash = hash(&normalized);
    let source_item = text(&payload["sourceItemId"]).trim();
    let identity = hash(format!("{source}\0{source_item}"));
    let version = hash(format!("{identity}\0{content_hash}"));
    let doc_id = format!(
        "{}_{}",
        if source_type == "information_feed" {
            "f"
        } else {
            "x"
        },
        &version[..24]
    );
    let story = format!("f_{}", &identity[..24]);
    let inline = normalized.len() <= 4096;
    let content_key = (!inline).then(|| format!("knowledge-content/external/{content_hash}.txt"));
    if let Some(key) = &content_key {
        state
            .knowledge_store()?
            .put(object_key(key), normalized.as_bytes().to_vec())
            .await?;
    }
    let metadata = if source_type == "information_feed" {
        json!({"feed":{"version":"v2","importVersion":"api-v1","originalFormat":"text","contentType":"news","sourceKey":source,"sourceItemId":source_item,"storyKey":story,"kind":"new","fullBodyHash":content_hash,"publishAllowed":true,"sources":[{"sourceKey":source}]}})
    } else {
        json!({"externalImport":{"version":"api-v1","sourceKey":source,"sourceItemId":source_item,"contentSha256":content_hash}})
    };
    let name = payload["sourceName"]
        .as_str()
        .map(str::trim)
        .unwrap_or(source)
        .to_string();
    let title = text(&payload["title"]).trim().to_string();
    let url = text(&payload["url"]).trim().to_string();
    let summary = normalized.chars().take(600).collect::<String>();
    let preview = normalized.chars().take(280).collect::<String>();
    let params = vec![
        json!(doc_id),
        json!(source_type),
        json!(if source_type == "information_feed" {
            "news"
        } else {
            "external_document"
        }),
        json!(name),
        json!(title),
        json!(url),
        json!(published),
        json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        json!("external_import"),
        json!("markdown"),
        json!(summary),
        json!(preview),
        if inline {
            json!(normalized)
        } else {
            Value::Null
        },
        if inline {
            json!(content_hash)
        } else {
            Value::Null
        },
        json!(metadata.to_string()),
        json!(published),
        json!(name.to_lowercase()),
        json!(now.timestamp_millis()),
    ];
    let persisted_id = doc_id.clone();
    let persisted_key = content_key.clone();
    let persisted_hash = content_hash.clone();
    let bytes = normalized.len();
    let millis = now.timestamp_millis();
    state.db.run(move|conn|{
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO knowledge_docs(doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,discovery_method,access_method,summary,content_preview,inline_content,inline_content_sha256,metadata_json,sort_time,source_name_normalized,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(doc_id) DO NOTHING",rusqlite::params_from_iter(params.iter().map(crate::db::sql_value)))?;
        if let Some(key)=persisted_key {tx.execute("INSERT INTO knowledge_doc_content_refs(doc_id,content_key,content_url,content_type,content_encoding,content_bytes,content_sha256,updated_at) VALUES(?,?,'','text/plain; charset=utf-8','identity',?,?,?) ON CONFLICT(doc_id) DO NOTHING",rusqlite::params![persisted_id,key,i64::try_from(bytes)?,persisted_hash,millis])?;}
        tx.commit()?;Ok(())
    }).await?;
    Ok(ok(
        json!({"docId":doc_id,"storyKey":if source_type=="information_feed"{json!(story)}else{Value::Null},"storage":if inline{"d1"}else{"r2"},"contentSha256":content_hash}),
    ))
}
pub(crate) fn valid_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn fixture() -> (tempfile::TempDir, AppState) {
        let root = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(root.path().join("db.sqlite")).unwrap();
        db.migrate(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        let state = AppState::new(db, root.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
        (root, state)
    }
    fn payload(body: &str) -> Value {
        json!({"sourceKey":"fixture","sourceItemId":"one","title":"测试标题","url":"https://example.com/item","publishedAt":"2026-10-29T10:00:00+08:00","body":body})
    }
    #[test]
    fn authentication_and_url_validation() {
        assert!(token_matches("secret", "secret"));
        assert!(!token_matches("secret", "SECRET"));
        assert!(!token_matches("", ""));
        assert!(!valid_url("https://user:password@example.com/file"));
        assert!(!valid_url("file:///etc/passwd"));
        assert!(valid_url("https://example.com/path"));
    }
    #[tokio::test]
    async fn inline_import_is_normalized_idempotent_and_versioned() {
        let (_dir, state) = fixture();
        let first = import_payload(&state, payload(" hello\r\nworld "))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
            .0["data"]
            .clone();
        let second = import_payload(&state, payload("hello\nworld"))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
            .0["data"]
            .clone();
        assert_eq!(first, second);
        assert_eq!(first["storage"], "d1");
        let rows = state
            .db
            .query(
                "SELECT inline_content,inline_content_sha256,metadata_json FROM knowledge_docs",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["inline_content"], "hello\nworld");
        assert_eq!(rows[0]["inline_content_sha256"], first["contentSha256"]);
        let metadata: Value =
            serde_json::from_str(rows[0]["metadata_json"].as_str().unwrap()).unwrap();
        assert_eq!(metadata["feed"]["importVersion"], "api-v1");
        let changed = import_payload(&state, payload("different"))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
            .0["data"]
            .clone();
        assert_ne!(changed["docId"], first["docId"]);
        assert_eq!(changed["storyKey"], first["storyKey"]);
        assert_eq!(
            state
                .db
                .query("SELECT doc_id FROM knowledge_docs", vec![])
                .await
                .unwrap()
                .len(),
            2
        );
    }
    #[tokio::test]
    async fn long_content_uses_local_object_and_reference_without_new_tables() {
        let (_dir, state) = fixture();
        let content = "研".repeat(2000);
        let result = import_payload(&state, payload(&content))
            .await
            .unwrap_or_else(|e| panic!("{}", e.1))
            .0["data"]
            .clone();
        assert_eq!(result["storage"], "r2");
        let rows=state.db.query("SELECT d.inline_content,c.content_key,c.content_bytes FROM knowledge_docs d JOIN knowledge_doc_content_refs c ON c.doc_id=d.doc_id",vec![]).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0]["inline_content"].is_null());
        assert_eq!(rows[0]["content_bytes"], 6000);
        let key = rows[0]["content_key"].as_str().unwrap();
        let object = state
            .knowledge_store()
            .unwrap()
            .get(object_key(key))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(object, content.as_bytes());
    }
    #[tokio::test]
    async fn malformed_imports_leave_database_unchanged() {
        let (_dir, state) = fixture();
        for (field, value) in [
            ("sourceKey", json!("../escape")),
            ("sourceType", json!("research_report")),
            ("url", json!("https://user:pass@example.com")),
            ("publishedAt", json!("yesterday")),
            ("body", json!("bad\0body")),
            ("body", json!("中".repeat(MAX_CONTENT / 2))),
        ] {
            let mut input = payload("valid");
            input[field] = value;
            assert!(import_payload(&state, input).await.is_err(), "{field}");
        }
        assert!(
            state
                .db
                .query("SELECT doc_id FROM knowledge_docs", vec![])
                .await
                .unwrap()
                .is_empty()
        );
    }
}
