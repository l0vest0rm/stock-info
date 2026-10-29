mod analysis;
pub mod content;
mod documents;
pub mod feed;
mod importer;
pub mod information_records;
pub mod ingest;
pub mod review;

use crate::AppState;
use axum::{
    Router,
    routing::{get, post},
};
use serde_json::Value;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/knowledge/docs", get(documents::list))
        .route("/knowledge/doc", get(documents::detail))
        .route("/knowledge/sources", get(documents::sources))
        .route("/knowledge/industries", get(documents::industries))
        .route("/knowledge/file", get(documents::file))
        .route("/knowledge/content", get(documents::content))
        .route("/knowledge/report-analysis", post(analysis::report))
        .route("/internal/knowledge/import", post(importer::import))
        .merge(feed::routes())
        .merge(review::routes())
}

pub fn content_routes() -> Router<AppState> {
    content::routes()
}
pub use content::{convert_report, read_content_text};
pub use ingest::{ingest_tick, process_once};
pub(crate) fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub(crate) fn parse_json(value: &Value) -> Value {
    if value.is_object() || value.is_array() {
        return value.clone();
    }
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}
pub(crate) fn object_key(key: &str) -> &str {
    key.strip_prefix("knowledge-content/").unwrap_or(key)
}
pub(crate) fn local_content_url(state: &AppState, key: &str) -> String {
    let path = key.trim_start_matches('/');
    let path = if path.starts_with("knowledge-content/") {
        path.to_string()
    } else {
        format!("knowledge-content/{path}")
    };
    let encoded = path
        .split('/')
        .map(|p| {
            let mut result = String::new();
            for b in p.as_bytes() {
                if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(b) {
                    result.push(*b as char);
                } else {
                    result.push_str(&format!("%{b:02X}"));
                }
            }
            result
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("http://{}/{encoded}", state.authority)
}
