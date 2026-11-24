//! Stock-info I/O adapter. Shared acquisition code never opens our SQLite DB.
use crate::AppState;
use anyhow::Result;
use reqwest::{Method, header::HeaderMap};
use securities_data::{Runtime, shared_http};
use serde_json::Value;

#[cfg(test)]
mod shared_cache_host_probe;

impl Runtime for AppState {
    fn config(&self, path: &str) -> Result<Value> {
        AppState::config(self, path)
    }
    async fn read_snapshot(&self, key: &str) -> Result<Option<Value>> {
        self.market_store()?.get_json(key).await
    }
    async fn write_snapshot(&self, key: &str, value: &Value) -> Result<()> {
        self.market_store()?.put_json(key, value).await
    }
    async fn read_http_cache(&self, key: &str, now: i64) -> Result<Option<String>> {
        if shared_http::is_primary_key(key) {
            let cache = self.public_cache.clone();
            let key = key.to_owned();
            return Ok(tokio::task::spawn_blocking(move || {
                shared_http::read_primary(&cache, &key, now)
            })
            .await?);
        }
        let rows = self
            .db
            .query(
                "SELECT body_text FROM http_cache WHERE cache_key=? AND expires_at>?",
                vec![key.into(), now.into()],
            )
            .await?;
        Ok(rows
            .first()
            .and_then(|row| row["body_text"].as_str())
            .map(str::to_owned))
    }
    async fn write_http_cache(
        &self,
        key: &str,
        url: &str,
        text: &str,
        expires_at: i64,
        now: i64,
    ) -> Result<()> {
        if shared_http::is_primary_key(key) {
            let cache = self.public_cache.clone();
            let (key, url, text) = (key.to_owned(), url.to_owned(), text.to_owned());
            return tokio::task::spawn_blocking(move || {
                shared_http::write_primary(&cache, &key, &url, &text, expires_at, now)
            })
            .await?;
        }
        self.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?) ON CONFLICT(cache_key) DO UPDATE SET body_text=excluded.body_text,status=200,expires_at=excluded.expires_at,updated_at=excluded.updated_at",vec![key.into(),url.into(),text.into(),expires_at.into(),now.into()]).await?;
        Ok(())
    }
    async fn read_cache(&self, namespace: &str, key: &str, now: i64) -> Result<Option<Value>> {
        let rows = self.db.query(
            "SELECT value_json FROM kv_cache WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)",
            vec![namespace.into(), key.into(), now.into()],
        ).await?;
        Ok(rows
            .first()
            .and_then(|row| row["value_json"].as_str())
            .and_then(|value| serde_json::from_str(value).ok()))
    }
    async fn write_cache(
        &self,
        namespace: &str,
        key: &str,
        value: &Value,
        expires_at: i64,
    ) -> Result<()> {
        self.db
            .put_kv(namespace, key, value, Some(expires_at))
            .await
    }
    async fn get_text(&self, url: &str, headers: HeaderMap) -> Result<String> {
        if securities_data::finance::providers::is_cn_statement_source(&reqwest::Url::parse(url)?) {
            #[cfg(test)]
            if let Some(response) = shared_cache_host_probe::fixture_response(url) {
                return response;
            }
            return self
                .http
                .public_source_text(url, Method::GET, headers, None, None)
                .await;
        }
        self.http.text(url, Method::GET, headers, None).await
    }
    async fn cached_json(&self, url: &str, headers: HeaderMap, ttl_ms: i64) -> Result<Value> {
        if shared_http::supports_get(url) {
            return shared_http::cached_get(&self.public_cache, url, &headers, ttl_ms, || async {
                #[cfg(test)]
                if let Some(result) = shared_cache_host_probe::fixture_response(url) {
                    return result;
                }
                self.http
                    .public_source_text(url, Method::GET, headers.clone(), None, None)
                    .await
            })
            .await;
        }
        self.http
            .cached_json(&self.db, url, headers, ttl_ms, false)
            .await
    }
    async fn get_bytes(
        &self,
        url: &str,
        headers: HeaderMap,
        timeout_ms: Option<u64>,
    ) -> Result<(Vec<u8>, HeaderMap)> {
        match timeout_ms {
            Some(timeout) => self.http.bytes_with_timeout(url, headers, timeout).await,
            None => self.http.bytes(url, headers).await,
        }
    }
}

impl securities_data::notices::NoticeRuntime for AppState {
    async fn cached_post_json(
        &self,
        url: &str,
        headers: HeaderMap,
        body: Option<String>,
        ttl: i64,
    ) -> Result<Value> {
        // This trait exposes only the two public CNINFO query POSTs: never cache
        // arbitrary POSTs, use a stale fallback or send credentials through it.
        shared_http::cached_post(
            &self.public_cache,
            url,
            &headers,
            body.as_deref(),
            ttl,
            || {
                self.http
                    .public_source_text(url, Method::POST, headers.clone(), body.clone(), None)
            },
        )
        .await
    }
}
