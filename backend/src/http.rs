use crate::db::Database;
use anyhow::{Context, Result, bail};
use reqwest::{Client, Method, header::HeaderMap};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

/// Provider error text is available only to source-specific validators; neither
/// Display nor Debug can leak response bodies, credentials or query strings.
pub struct ProviderRejection {
    pub status: reqwest::StatusCode,
    pub body: String,
    host: String,
}
impl std::fmt::Display for ProviderRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "provider rejected request: host={} status={}",
            self.host, self.status
        )
    }
}
impl std::fmt::Debug for ProviderRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for ProviderRejection {}

struct RequestPolicy {
    timeout: Duration,
    retry: bool,
    max_bytes: usize,
}

#[derive(Clone)]
pub struct HttpClient {
    client: Client,
    limits: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    timeout: Duration,
    concurrency: usize,
    relay: String,
    proxy_domains: Vec<String>,
}

impl HttpClient {
    pub fn new() -> Result<Self> {
        let timeout =
            Duration::from_millis(setting("HTTP_REQUEST_TIMEOUT_MS").parse().unwrap_or(10000));
        let concurrency = setting("HTTP_DOMAIN_CONCURRENCY")
            .parse::<usize>()
            .unwrap_or(5)
            .max(1);
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .timeout(timeout)
                .user_agent("Mozilla/5.0 stock-info-local/0.1")
                .build()?,
            limits: Default::default(),
            timeout,
            concurrency,
            relay: setting("HTTP_PROXY_RELAY_URL"),
            proxy_domains: setting("HTTP_PROXY_DOMAINS")
                .split([',', ' '])
                .map(|s| s.trim().trim_start_matches('.').to_lowercase())
                .filter(|s| !s.is_empty())
                .collect(),
        })
    }

    pub async fn text(
        &self,
        url: &str,
        method: Method,
        headers: HeaderMap,
        body: Option<String>,
    ) -> Result<String> {
        let (bytes, _) = self
            .request_bytes(url, method, headers, body, self.timeout, true)
            .await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn bytes(&self, url: &str, headers: HeaderMap) -> Result<(Vec<u8>, HeaderMap)> {
        self.request_bytes(url, Method::GET, headers, None, self.timeout, true)
            .await
    }

    pub async fn text_once(
        &self,
        url: &str,
        method: Method,
        headers: HeaderMap,
        body: Option<String>,
        timeout_ms: u64,
    ) -> Result<String> {
        let (bytes, _) = self
            .request_bytes(
                url,
                method,
                headers,
                body,
                Duration::from_millis(timeout_ms),
                false,
            )
            .await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn text_with_timeout(
        &self,
        url: &str,
        method: Method,
        headers: HeaderMap,
        body: Option<String>,
        timeout_ms: u64,
    ) -> Result<String> {
        let (bytes, _) = self
            .request_bytes(
                url,
                method,
                headers,
                body,
                Duration::from_millis(timeout_ms),
                true,
            )
            .await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn bytes_with_timeout(
        &self,
        url: &str,
        headers: HeaderMap,
        timeout_ms: u64,
    ) -> Result<(Vec<u8>, HeaderMap)> {
        self.request_bytes(
            url,
            Method::GET,
            headers,
            None,
            Duration::from_millis(timeout_ms),
            true,
        )
        .await
    }

    async fn request_bytes(
        &self,
        url: &str,
        method: Method,
        headers: HeaderMap,
        body: Option<String>,
        timeout: Duration,
        retry: bool,
    ) -> Result<(Vec<u8>, HeaderMap)> {
        self.request_bytes_policy(
            url,
            method,
            headers,
            body,
            RequestPolicy {
                timeout,
                retry,
                max_bytes: usize::MAX,
            },
        )
        .await
    }

    /// Enforces the cap while decoding/streaming, including relayed requests.
    pub async fn bytes_limited(
        &self,
        url: &str,
        headers: HeaderMap,
        timeout_ms: u64,
        max_bytes: usize,
    ) -> Result<(Vec<u8>, HeaderMap)> {
        self.request_bytes_policy(
            url,
            Method::GET,
            headers,
            None,
            RequestPolicy {
                timeout: Duration::from_millis(timeout_ms),
                retry: true,
                max_bytes,
            },
        )
        .await
    }

    async fn request_bytes_policy(
        &self,
        url: &str,
        method: Method,
        headers: HeaderMap,
        body: Option<String>,
        policy: RequestPolicy,
    ) -> Result<(Vec<u8>, HeaderMap)> {
        let RequestPolicy {
            timeout,
            retry,
            max_bytes,
        } = policy;
        let parsed = reqwest::Url::parse(url)?;
        let host = parsed.host_str().context("HTTP request has no host")?;
        let semaphore = {
            let mut limits = self
                .limits
                .lock()
                .map_err(|_| anyhow::anyhow!("HTTP limiter poisoned"))?;
            limits
                .entry(host.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(self.concurrency)))
                .clone()
        };
        let _permit = tokio::time::timeout(timeout, semaphore.acquire())
            .await
            .context("HTTP concurrency timeout")??;
        let yahoo = host == "yahoo.com" || host.ends_with(".yahoo.com");
        let proxy = yahoo
            || self
                .proxy_domains
                .iter()
                .any(|domain| host == domain || host.ends_with(&format!(".{domain}")));
        if proxy && self.relay.is_empty() {
            bail!(
                "HTTP_PROXY_RELAY_URL is required for configured proxy domains and local Yahoo requests"
            );
        }
        // Do not retry POST/ambiguous remote execution. GET network failures may
        // be retried once; provider rejection remains explicit to consumers.
        let attempts = if retry && method == Method::GET { 2 } else { 1 };
        for attempt in 0..attempts {
            let request = if proxy {
                let headers: HashMap<_, _> = headers
                    .iter()
                    .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v)))
                    .collect();
                self.client.post(&self.relay).json(
                    &json!({"url":url,"method":method.as_str(),"headers":headers,"body":body}),
                )
            } else {
                let request = self
                    .client
                    .request(method.clone(), parsed.clone())
                    .headers(headers.clone());
                if let Some(body) = &body {
                    request.body(body.clone())
                } else {
                    request
                }
            };
            match request.timeout(timeout).send().await {
                Ok(mut response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let mut bytes = Vec::new();
                        while bytes.len() < 16_384 {
                            let Some(chunk) = response
                                .chunk()
                                .await
                                .map_err(|error| error.without_url())?
                            else {
                                break;
                            };
                            let count = chunk.len().min(16_384 - bytes.len());
                            bytes.extend_from_slice(&chunk[..count]);
                        }
                        return Err(ProviderRejection {
                            status,
                            body: String::from_utf8_lossy(&bytes).into_owned(),
                            host: host.to_owned(),
                        }
                        .into());
                    }
                    let headers = response.headers().clone();
                    if response
                        .content_length()
                        .is_some_and(|n| n > max_bytes as u64)
                    {
                        bail!("provider response exceeds byte limit");
                    }
                    let mut bytes = Vec::new();
                    while let Some(chunk) = response
                        .chunk()
                        .await
                        .map_err(|error| error.without_url())?
                    {
                        if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
                            bail!("provider response exceeds byte limit");
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    return Ok((bytes, headers));
                }
                Err(error) if attempt + 1 == attempts => return Err(error.without_url().into()),
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
        unreachable!()
    }

    pub async fn json(&self, url: &str, headers: HeaderMap) -> Result<Value> {
        parse_json_or_jsonp(&self.text(url, Method::GET, headers, None).await?)
    }

    pub async fn cached_json(
        &self,
        db: &Database,
        url: &str,
        headers: HeaderMap,
        ttl_ms: i64,
        bypass: bool,
    ) -> Result<Value> {
        parse_json_or_jsonp(&self.cached_text(db, url, headers, ttl_ms, bypass).await?)
    }

    pub async fn cached_text(
        &self,
        db: &Database,
        url: &str,
        headers: HeaderMap,
        ttl_ms: i64,
        bypass: bool,
    ) -> Result<String> {
        let key = cache_key("GET", url, &headers, None)?;
        let now = chrono::Utc::now().timestamp_millis();
        if !bypass {
            let rows = db
                .query(
                    "SELECT body_text FROM http_cache WHERE cache_key=? AND expires_at>?",
                    vec![key.clone().into(), now.into()],
                )
                .await?;
            if let Some(text) = rows.first().and_then(|v| v["body_text"].as_str()) {
                return Ok(text.to_string());
            }
        }
        let text = self.text(url, Method::GET, headers, None).await?;
        // Provider-specific auth/content validators must use uncached text and
        // persist only validated payloads rather than caching error JSON here.
        db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?) ON CONFLICT(cache_key) DO UPDATE SET body_text=excluded.body_text,status=200,expires_at=excluded.expires_at,updated_at=excluded.updated_at",vec![key.into(),url.into(),text.clone().into(),(now+ttl_ms.max(1)).into(),now.into()]).await?;
        Ok(text)
    }
}

pub fn cache_key(
    method: &str,
    url: &str,
    headers: &HeaderMap,
    body: Option<&str>,
) -> Result<String> {
    // Struct serialization preserves the original JSON.stringify field order;
    // a Value map sorts keys and would invalidate every existing Node cache.
    #[derive(serde::Serialize)]
    struct Key<'a> {
        method: &'a str,
        url: &'a str,
        headers: std::collections::BTreeMap<&'a str, &'a str>,
        body: Option<&'a str>,
    }
    let headers = headers
        .iter()
        .map(|(k, v)| {
            (
                k.as_str(),
                if k == "cookie" || k == "authorization" {
                    "<redacted>"
                } else {
                    v.to_str().unwrap_or("")
                },
            )
        })
        .collect();
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&Key {
            method,
            url,
            headers,
            body
        })?)
    ))
}

pub fn setting(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}

pub fn parse_json_or_jsonp(text: &str) -> Result<Value> {
    let text = text.trim();
    if text.starts_with('{') || text.starts_with('[') {
        return Ok(serde_json::from_str(text)?);
    }
    if let (Some(start), Some(end)) = (text.find('('), text.rfind(')'))
        && end > start
    {
        return Ok(serde_json::from_str(&text[start + 1..end])?);
    }
    bail!("invalid provider JSON/JSONP payload")
}

pub fn number(value: &Value) -> Option<f64> {
    if let Some(raw) = value.get("raw") {
        return number(raw);
    }
    if value.is_null() || value.as_str() == Some("") {
        return None;
    }
    value
        .as_f64()
        .or_else(|| value.as_str()?.replace(',', "").parse().ok())
        .filter(|n| n.is_finite())
}
