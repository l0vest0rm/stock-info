use crate::{ApiError, ApiResult, AppState, ok};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::StatusCode,
};
use chrono::{DateTime, NaiveDate};
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};

const NAMESPACE: &str = "companies_follow_config";
const KEY: &str = "companies-follow-config";

pub async fn read(State(state): State<AppState>) -> ApiResult {
    let raw = state.db.run(|conn| {
        Ok(conn.query_row("SELECT value_json FROM kv_cache WHERE namespace=?1 AND key=?2 AND (expires_at IS NULL OR expires_at>?3)",
            rusqlite::params![NAMESPACE, KEY, chrono::Utc::now().timestamp_millis()], |row| row.get::<_, String>(0)).optional()?)
    }).await?;
    let mut data = match raw.as_deref() {
        Some(raw) => normalize(&serde_json::from_str(raw).map_err(anyhow::Error::from)?),
        None => normalize(&json!({})),
    };
    data["storage"] = json!("backend");
    data["configured"] = json!(raw.is_some());
    Ok(ok(data))
}

pub async fn write(
    State(state): State<AppState>,
    body: Result<Json<Value>, JsonRejection>,
) -> ApiResult {
    let Json(body) = body.map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "invalid companies follow config".into(),
        )
    })?;
    if !body.is_object() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid companies follow config".into(),
        ));
    }
    let mut config = normalize(&body);
    let serialized = serde_json::to_string(&config).map_err(anyhow::Error::from)?;
    state.db.run(move |conn| {
        conn.execute("INSERT INTO kv_cache (namespace,key,value_json,expires_at,updated_at) VALUES (?1,?2,?3,NULL,?4) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,expires_at=NULL,updated_at=excluded.updated_at",
            rusqlite::params![NAMESPACE, KEY, serialized, chrono::Utc::now().timestamp_millis()])?;
        Ok(())
    }).await?;
    config["storage"] = json!("backend");
    config["configured"] = json!(true);
    Ok(ok(config))
}

fn object(value: &Value) -> impl Iterator<Item = (&String, &Value)> {
    value.as_object().into_iter().flatten()
}

// Matches Number() for the JSON scalar inputs accepted by the existing route.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

fn positive_map(value: &Value, max: f64) -> Value {
    Value::Object(
        object(value)
            .filter_map(|(code, value)| {
                let code = code.trim().to_uppercase();
                let n = number(value)?;
                (!code.is_empty() && n > 0.0 && n <= max).then(|| (code, json!(n)))
            })
            .collect(),
    )
}

fn valid_year(year: &str) -> bool {
    year.len() == 4 && year.bytes().all(|byte| byte.is_ascii_digit())
}

fn normalize(value: &Value) -> Value {
    let tracks: Map<String, Value> = object(&value["tracks"])
        .filter_map(|(code, track)| {
            let code = code.trim().to_uppercase();
            let track = track.as_str()?.trim();
            (!code.is_empty() && !track.is_empty()).then(|| (code, json!(track)))
        })
        .collect();
    let mut risk = Map::new();
    for (key, max) in [("accountRiskPct", 5.0), ("maxStockPositionPct", 100.0)] {
        if let Some(n) = number(&value["riskPolicy"][key]).filter(|n| *n > 0.0 && *n <= max) {
            risk.insert(key.into(), json!(n));
        }
    }
    let mut profits = Map::new();
    for (code, years) in object(&value["profits"]) {
        let code = code.trim().to_uppercase();
        let years: Map<String, Value> = object(years)
            .filter_map(|(year, v)| {
                let n = number(v)?;
                (valid_year(year) && n > 0.0).then(|| (year.clone(), json!(n)))
            })
            .collect();
        if !code.is_empty() && !years.is_empty() {
            profits.insert(code, Value::Object(years));
        }
    }
    let mut saved = Map::new();
    for (code, years) in object(&value["profitSavedAt"]) {
        let code = code.trim().to_uppercase();
        let years: Map<String, Value> = object(years)
            .filter_map(|(year, v)| {
                let date = v.as_str()?;
                let valid_date = DateTime::parse_from_rfc3339(date).is_ok()
                    || NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok();
                (valid_year(year)
                    && valid_date
                    && profits.get(&code).is_some_and(|p| p.get(year).is_some()))
                .then(|| (year.clone(), v.clone()))
            })
            .collect();
        if !code.is_empty() && !years.is_empty() {
            saved.insert(code, Value::Object(years));
        }
    }
    json!({"version":1,"tracks":tracks,"positions":positive_map(&value["positions"],100.0),
        "costs":positive_map(&value["costs"],f64::MAX),"riskPolicy":risk,"profits":profits,"profitSavedAt":saved})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_config_and_drops_invalid_fields() {
        let result = normalize(
            &json!({"tracks":{" aapl.us ":" AI ","bad":12},"positions":{"aapl.us":"5","bad":101},
            "costs":{"aapl.us":-1},"riskPolicy":{"accountRiskPct":"2","maxStockPositionPct":101},
            "profits":{" aapl.us ":{"2026":"10","bad":2,"2025":-1}},
            "profitSavedAt":{"aapl.us":{"2026":"2026-10-29","2025":"2026-10-29"}},"private":"must not persist"}),
        );
        assert_eq!(result["tracks"], json!({"AAPL.US":"AI"}));
        assert_eq!(result["positions"], json!({"AAPL.US":5.0}));
        assert_eq!(result["riskPolicy"], json!({"accountRiskPct":2.0}));
        assert_eq!(
            result["profitSavedAt"],
            json!({"AAPL.US":{"2026":"2026-10-29"}})
        );
        assert!(result.get("private").is_none());
    }
}
