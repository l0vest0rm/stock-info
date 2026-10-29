use stock_info_local::{AppState, options, thirteenf};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use stock_info_local::db::Database;
use tower::ServiceExt;

fn setup() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("stock-info.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, dir.path().into(), "127.0.0.1:8000".into()).unwrap();
    (dir, state)
}

async fn response_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap()
}

#[tokio::test]
async fn cached_options_keep_shapes_and_apply_selection_without_provider_calls() {
    let (_dir, state) = setup();
    let expiry = chrono::Utc::now().timestamp_millis() + 60_000;
    let summary = json!({"code":"AAPL.US","symbol":"AAPL","currentPrice":200.0,"updatedAt":1,"expirations":[{"date":"November 20, 2026","strikeCount":2}],"strikes":[100.0,110.0]});
    let call = |strike| json!({"symbol":format!("aapl-{strike}c"),"type":"call","expiration":"November 20, 2026","strike":strike,"last":2.0,"bid":1.0,"ask":3.0,"price":2.0,"volume":10,"openInterest":100});
    let expiration =
        json!({"date":"November 20, 2026","calls":[call(100.0),call(110.0)],"puts":[]});
    state
        .db
        .put_kv(
            "us_option_chain",
            "us.options.chain.v2.AAPL.US.summary",
            &summary,
            Some(expiry),
        )
        .await
        .unwrap();
    state
        .db
        .put_kv(
            "us_option_chain",
            "us.options.chain.v2.AAPL.US.expiration.November 20, 2026",
            &expiration,
            Some(expiry),
        )
        .await
        .unwrap();
    let app = options::routes().with_state(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/options/us/summary?code=aapl.us")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_body(response).await["data"], summary);
    let response=app.clone().oneshot(Request::builder().uri("/options/us/contracts?code=AAPL.US&strikes=100,invalid,-1&expirations=November%2020,%202026").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data = response_body(response).await["data"].clone();
    assert_eq!(data["expirations"][0]["calls"].as_array().unwrap().len(), 1);
    assert_eq!(data["expirations"][0]["calls"][0]["strike"], 100.0);
    assert_eq!(data["updatedAt"], 1);
    for path in [
        "/options/us/summary",
        "/options/us/summary?code=600036.SH",
        "/options/us/contracts?code=019785.OF",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response_body(response).await["data"], Value::Null);
    }
    let error = options::fetch_expiration(&state, "AAPL.US", "unknown expiration")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("option expiration not found"));
}

#[tokio::test]
async fn cached_13f_html_and_json_are_served_in_legacy_array_shapes() {
    let (_dir, state) = setup();
    let now = chrono::Utc::now().timestamp_millis();
    let html = "<tr><td><a href='/manager/berkshire'>Berkshire Hathaway Inc</a></td><td>x</td><td>x</td><td>x</td><td>$300 B</td></tr>";
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static("https://13f.info/"),
    );
    let html_key =
        stock_info_local::http::cache_key("GET", "https://13f.info/managers", &headers, None)
            .unwrap();
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?)",vec![html_key.into(),"https://13f.info/managers".into(),html.into(),(now+60_000).into(),now.into()]).await.unwrap();
    let url = "https://13f.info/data/13f/filing-1";
    let key = stock_info_local::http::cache_key("GET", url, &headers, None).unwrap();
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?)",vec![key.into(),url.into(),json!({"data":[["AAPL",100,200]]}).to_string().into(),(now+60_000).into(),now.into()]).await.unwrap();
    let app = thirteenf::routes().with_state(state);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/13f/manager/list")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let rows = response_body(response).await["data"].clone();
    assert_eq!(rows[0][0], "berkshire");
    assert_eq!(rows[0][2], "伯克希尔哈撒韦");
    let response = app
        .oneshot(
            Request::builder()
                .uri("/13f/position/filing-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response_body(response).await["data"],
        json!([["AAPL", 100, 200]])
    );
}
