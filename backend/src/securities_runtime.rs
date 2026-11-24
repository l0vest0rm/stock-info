//! Stock-info I/O adapter. Shared acquisition code never opens our SQLite DB.
use crate::{AppState, http::parse_json_or_jsonp};
use anyhow::Result;
use reqwest::{Method, header::HeaderMap};
use securities_data::Runtime;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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
        self.http.text(url, Method::GET, headers, None).await
    }
    async fn cached_json(&self, url: &str, headers: HeaderMap, ttl_ms: i64) -> Result<Value> {
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
        let safe_headers = headers
            .iter()
            .filter_map(|(name, value)| value.to_str().ok().map(|value| (name.as_str(), value)))
            .collect::<std::collections::BTreeMap<_, _>>();
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(
                &json!({"method":"POST","url":url,"headers":safe_headers,"body":body})
            )?)
        );
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(text) = self.read_http_cache(&key, now).await? {
            return parse_json_or_jsonp(&text);
        }
        let text = self.http.text(url, Method::POST, headers, body).await?;
        let result = parse_json_or_jsonp(&text)?;
        self.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'POST',200,'{}',?,?,?) ON CONFLICT(cache_key) DO UPDATE SET body_text=excluded.body_text,status=200,expires_at=excluded.expires_at,updated_at=excluded.updated_at",vec![key.into(),url.into(),text.into(),(now+ttl).into(),now.into()]).await?;
        Ok(result)
    }
}
