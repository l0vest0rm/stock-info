//! Reusable statement acquisition/normalization and research-report processing.
//! Optional public SQLite cache; no application database, listener, scheduler, credentials or fallback.
pub mod cache_policy;
pub mod codes;
#[cfg(feature = "sqlite-cache")]
pub mod data_cache;
#[cfg(feature = "sqlite-cache")]
pub mod shared_http;
pub mod finance {
    pub mod dividends;
    pub mod providers;
    pub mod series;
    pub mod valuations;
}
pub mod notices;
pub mod reports {
    pub mod analysis;
    pub mod domain;
    pub mod list;
    pub mod sources;
}
pub mod http;

use anyhow::Result;
use reqwest::header::HeaderMap;
use serde_json::Value;
use std::future::Future;

/// Host-owned I/O. Implementations must preserve errors and enforce their HTTP
/// proxy, credential, size, timeout and concurrency policies on every request.
/// Yahoo financial requests must use the host's configured Yahoo proxy/cache.
/// Cache expiry is absolute Unix milliseconds; reads must not extend it.
/// Implementors must namespace snapshots/cache independently of private ledgers.
pub trait Runtime: Sync {
    fn config(&self, path: &str) -> Result<Value>;
    fn read_snapshot(&self, key: &str) -> impl Future<Output = Result<Option<Value>>> + Send;
    fn write_snapshot(&self, key: &str, value: &Value) -> impl Future<Output = Result<()>> + Send;
    fn read_http_cache(
        &self,
        key: &str,
        now: i64,
    ) -> impl Future<Output = Result<Option<String>>> + Send;
    fn write_http_cache(
        &self,
        key: &str,
        url: &str,
        text: &str,
        expires_at: i64,
        now: i64,
    ) -> impl Future<Output = Result<()>> + Send;
    /// Malformed/expired optional JSON cache entries are misses.
    fn read_cache(
        &self,
        namespace: &str,
        key: &str,
        now: i64,
    ) -> impl Future<Output = Result<Option<Value>>> + Send;
    fn write_cache(
        &self,
        namespace: &str,
        key: &str,
        value: &Value,
        expires_at: i64,
    ) -> impl Future<Output = Result<()>> + Send;
    fn get_text(
        &self,
        url: &str,
        headers: HeaderMap,
    ) -> impl Future<Output = Result<String>> + Send;
    fn cached_json(
        &self,
        url: &str,
        headers: HeaderMap,
        ttl_ms: i64,
    ) -> impl Future<Output = Result<Value>> + Send;
    fn get_bytes(
        &self,
        url: &str,
        headers: HeaderMap,
        timeout_ms: Option<u64>,
    ) -> impl Future<Output = Result<(Vec<u8>, HeaderMap)>> + Send;
}
