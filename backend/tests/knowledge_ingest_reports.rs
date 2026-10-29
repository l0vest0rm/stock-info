// Compile discovery's deterministic contract suite independently of the
// scheduler orchestration so it needs no provider credentials or live database.
pub use stock_info_local::{AppState, db};
#[allow(dead_code)]
#[path = "../src/knowledge/ingest/reports_fetch.rs"]
mod reports_fetch;
