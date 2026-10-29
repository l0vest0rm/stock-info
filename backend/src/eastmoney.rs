use crate::AppState;
use anyhow::Result;
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue, REFERER},
};
use serde_json::Value;

pub async fn data_page(
    state: &AppState,
    endpoint: &str,
    params: &[(String, String)],
    ttl_ms: i64,
) -> Result<Value> {
    let mut url = Url::parse(endpoint)?;
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    let mut headers = HeaderMap::new();
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://emweb.securities.eastmoney.com/"),
    );
    state
        .http
        .cached_json(&state.db, url.as_str(), headers, ttl_ms, false)
        .await
}

pub async fn data_rows(
    state: &AppState,
    endpoint: &str,
    params: &[(String, String)],
    ttl_ms: i64,
) -> Result<Vec<Value>> {
    Ok(
        data_page(state, endpoint, params, ttl_ms).await?["result"]["data"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    )
}
