use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database};
use tower::ServiceExt;

fn setup() -> (tempfile::TempDir, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path().join("company.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state =
        AppState::new(db, directory.path().to_path_buf(), "127.0.0.1:18000".into()).unwrap();
    (directory, state)
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn local_company_routes_validate_queries_and_preserve_capabilities() {
    let (directory, state) = setup();
    let app = stock_info_local::router(state.clone(), directory.path());
    for path in [
        "/api/company/info",
        "/api/company/overview",
        "/api/company/notices",
        "/api/company/reports",
        "/api/company/reports/discovery-capability",
        "/api/company/reports/stream",
        "/api/report/forecast",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", "127.0.0.1:18000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
        let body = json_body(response).await;
        assert_eq!(body["code"], 400);
        assert_eq!(body["msg"], "Missing code parameter");
        assert_eq!(body["data"], Value::Null);
    }
    for (code, enabled) in [("AAPL.US", false), ("600036.SH", true)] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/company/reports/discovery-capability?code={code}"
                    ))
                    .header("host", "127.0.0.1:18000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(
            json_body(response).await["data"],
            json!({"enabled":enabled,"code":code,"task":null,"lastSuccessfulCompletedAt":null})
        );
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/company/notices?stock=00700&type=HK&contentKind=research")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(response).await["data"], json!([]));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/company/notices?code=600036.SH&contentKind=bad")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/report/url?code=600036.SH")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(response).await["data"], Value::Null);
    let rows = state
        .db
        .query("SELECT count(*) AS count FROM kv_cache", Vec::new())
        .await
        .unwrap();
    assert_eq!(
        rows[0]["count"], 0,
        "capability reads must not create discovery jobs or ledger records"
    );
}

#[tokio::test]
async fn report_stream_preserves_progress_and_terminal_result_without_html_fallback() {
    let (directory, state) = setup();
    let app = stock_info_local::router(state, directory.path());
    // Unsupported source code has no report providers and cannot schedule a
    // model. This fixture tests the transport with no external requests.
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/company/reports/stream?code=FIXTURE.ZZ")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/event-stream; charset=utf-8"
    );
    assert_eq!(response.headers()["vary"], "Cookie");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let events = std::str::from_utf8(&bytes)
        .unwrap()
        .split("\n\n")
        .filter(|event| !event.is_empty())
        .map(|event| serde_json::from_str::<Value>(event.strip_prefix("data: ").unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert!(events.iter().any(|event| event["type"] == "progress"));
    assert_eq!(events.last().unwrap(), &json!({"type":"result","data":[]}));
}

#[tokio::test]
async fn overview_does_not_read_eastmoney_quotes_and_uses_xueqiu_common_equity() {
    use reqwest::Url;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    for key in [
        "LOCAL_DATA_DIR",
        "LOCAL_MARKET_DATA_DIR",
        "LOCAL_XUEQIU_CREDENTIAL_STORE",
    ] {
        assert!(
            std::env::var_os(key).is_none_or(|value| value.is_empty()),
            "unset {key} before running isolated company fixtures"
        );
    }
    let (directory, state) = setup();
    let now = chrono::Utc::now();
    let date = now.date_naive().to_string();
    let report_date =
        stock_info_local::cache_policy::latest_completed_quarter(now.timestamp_millis());
    state
        .db
        .execute(
            "INSERT INTO stock(code,short_name,updated_at) VALUES('00700.HK','腾讯控股',?)",
            vec![now.timestamp_millis().into()],
        )
        .await
        .unwrap();
    let credential = state.data_dir().join("runtime/xueqiu-credential.json");
    std::fs::create_dir_all(credential.parent().unwrap()).unwrap();
    std::fs::write(credential, r#"{"cookie":"isolated-fixture-cookie"}"#).unwrap();
    // The validated Xueqiu quote supplies only missing HK capital; its price
    // and multiples must never override the K-line or disclosed statements.
    let quote = json!({"data":{"quote":{"symbol":"00700","currency":"HKD","timestamp":now.timestamp_millis(),"market_capital":1000000000,"current":999,"pb":8888}}}).to_string();
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES('xueqiu:quote:v1:00700.HK','https://stock.xueqiu.com/v5/stock/quote.json','GET',200,'{}',?,?,?)",vec![quote.into(),(now.timestamp_millis()+86400000).into(),now.timestamp_millis().into()]).await.unwrap();
    let store = state.market_store().unwrap();
    store.put_json("kline/normal/00700.HK.json", &json!({"schemaVersion":2,"source":"xueqiu","rawResponseText":"{}","updatedAt":now.timestamp_millis(),"startDate":date,"endDate":date,"rows":[{"date":date,"close":421.5,"pctChange":1.25,"changeAmount":5.2,"turnover":0.3,"marketCapital":null,"updatedAt":now.timestamp_millis()}]})).await.unwrap();
    for statement in ["income", "balance", "cashflow"] {
        store.put_json(&format!("financial-statements/{statement}/00700.HK.json"), &json!({"rows":[{"code":"00700.HK","statementType":statement,"source":"eastmoney","reportDate":report_date,"updatedAt":now.timestamp_millis(),"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_hk_f10_main_indicator.v2","REPORTING_CURRENCY":"HKD","REPORTING_ACCOUNT_STANDARD":"HKFRS","TOTAL_PARENT_EQUITY":600000000,"OTHER_EQUITY_TOOL":100000000}}]})).await.unwrap();
    }
    let mut url = Url::parse("https://push2delay.eastmoney.com/api/qt/stock/get").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("ut", "fa5fd1943c7b386f172d6893dbfba10b"),
        ("invt", "2"),
        ("fltt", "1"),
        ("secid", "116.00700"),
        (
            "fields",
            "f43,f57,f58,f59,f116,f124,f162,f167,f168,f169,f170",
        ),
    ]);
    let headers = BTreeMap::from([
        ("referer", "https://quote.eastmoney.com/"),
        (
            "user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        ),
    ]);
    let key = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{{\"method\":\"GET\",\"url\":{},\"headers\":{},\"body\":null}}",
                serde_json::to_string(url.as_str()).unwrap(),
                serde_json::to_string(&headers).unwrap()
            )
            .as_bytes()
        )
    );
    let body = "invalid Eastmoney quote fixture: reading this is a regression".to_string();
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?)",vec![key.into(),url.to_string().into(),body.into(),(now.timestamp_millis()+86400000).into(),now.timestamp_millis().into()]).await.unwrap();
    let app = stock_info_local::router(state, directory.path());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/company/overview?code=00700.HK")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data = json_body(response).await["data"].clone();
    assert_eq!(data["name"], "腾讯控股");
    assert_eq!(data["source"], "xueqiu");
    assert_eq!(data["latestPrice"], 421.5);
    assert_eq!(data["marketCapYi"], 10.0);
    assert_eq!(data["pb"], 2.0);
    assert_eq!(data["peTtm"], Value::Null);
    assert_eq!(data["marketDate"], date);
}

#[tokio::test]
async fn overview_rejects_missing_xueqiu_prices_instead_of_returning_empty_success() {
    for key in ["LOCAL_DATA_DIR", "LOCAL_MARKET_DATA_DIR"] {
        assert!(std::env::var_os(key).is_none_or(|value| value.is_empty()));
    }
    let (directory, state) = setup();
    let now = chrono::Utc::now();
    let today = now.date_naive().to_string();
    state
        .db
        .execute(
            "INSERT INTO stock(code,short_name,updated_at) VALUES('00700.HK','腾讯控股',?)",
            vec![now.timestamp_millis().into()],
        )
        .await
        .unwrap();
    state.market_store().unwrap().put_json("kline/normal/00700.HK.json", &json!({"schemaVersion":2,"source":"xueqiu","rawResponseText":"{}","updatedAt":now.timestamp_millis(),"startDate":today,"endDate":today,"rows":[{"date":today,"close":null}]})).await.unwrap();
    let before = cache_counts(&state).await;
    let error = stock_info_local::company::overview(&state, "00700.HK")
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Xueqiu K-line has no valid price")
    );
    let app = stock_info_local::router(state.clone(), directory.path());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/company/overview?code=00700.HK")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = json_body(response).await;
    assert_eq!(body["msg"], "internal server error");
    assert_eq!(body["data"], Value::Null);
    assert_eq!(
        cache_counts(&state).await,
        before,
        "failed overview must not persist results"
    );
}

async fn seed_get(state: &AppState, url: &str, referer: &str, body: Value) {
    use sha2::{Digest, Sha256};
    let mut headers = std::collections::BTreeMap::from([
        ("referer", referer),
        (
            "user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        ),
    ]);
    if url.starts_with("https://searchadapter.eastmoney.com/") {
        headers.remove("user-agent");
    }
    let key = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{{\"method\":\"GET\",\"url\":{},\"headers\":{},\"body\":null}}",
                serde_json::to_string(url).unwrap(),
                serde_json::to_string(&headers).unwrap()
            )
            .as_bytes()
        )
    );
    let now = chrono::Utc::now().timestamp_millis();
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?)",vec![key.into(),url.into(),body.to_string().into(),(now+86400000).into(),now.into()]).await.unwrap();
}

#[tokio::test]
async fn overview_preserves_exact_identity_and_datacenter_profile_without_quote_service() {
    for key in ["LOCAL_DATA_DIR", "LOCAL_MARKET_DATA_DIR"] {
        assert!(std::env::var_os(key).is_none_or(|value| value.is_empty()));
    }
    let (directory, state) = setup();
    let now = chrono::Utc::now();
    let today = now.date_naive().to_string();
    let report = stock_info_local::cache_policy::latest_completed_quarter(now.timestamp_millis());
    let mut search =
        reqwest::Url::parse("https://searchadapter.eastmoney.com/api/suggest/get").unwrap();
    search.query_pairs_mut().extend_pairs([
        ("input", "300308"),
        ("type", "8"),
        ("token", "D43BF722C8E33BDC906FB84D85E326E8"),
        ("count", "10"),
    ]);
    seed_get(&state, search.as_str(), "https://www.eastmoney.com/", json!({"GubaCodeTable":{"Data":[{"OuterCode":"300308.SZ","ShortName":"中际旭创"},{"OuterCode":"300307.SZ","ShortName":"不是此证券"}]}})).await;
    let mut profile =
        reqwest::Url::parse("https://datacenter.eastmoney.com/securities/api/data/v1/get").unwrap();
    profile.query_pairs_mut().extend_pairs([
        ("reportName", "RPT_F10_ORG_BASICINFO"),
        (
            "columns",
            "SECUCODE,EM2016,MAIN_BUSINESS,MAXPROFIT_PRODUCT,PRODUCT_NAME",
        ),
        ("quoteColumns", ""),
        ("filter", "(SECUCODE=\"300308.SZ\")"),
        ("pageNumber", "1"),
        ("pageSize", "1"),
        ("sortTypes", ""),
        ("sortColumns", ""),
        ("source", "HSF10"),
        ("client", "PC"),
    ]);
    seed_get(&state, profile.as_str(), "https://emweb.securities.eastmoney.com/", json!({"result":{"data":[{"SECUCODE":"300308.SZ","EM2016":"通信-通信设备","MAIN_BUSINESS":"光模块","MAXPROFIT_PRODUCT":"光通信模块"}]}})).await;
    let store = state.market_store().unwrap();
    store.put_json("kline/normal/300308.SZ.json", &json!({"schemaVersion":2,"source":"xueqiu","rawResponseText":"{}","updatedAt":now.timestamp_millis(),"startDate":today,"endDate":today,"rows":[{"date":today,"close":123,"marketCapital":1000000000,"pctChange":1.5,"changeAmount":1.8,"turnover":0.2,"updatedAt":now.timestamp_millis()}]})).await.unwrap();
    for kind in ["income", "balance", "cashflow"] {
        let mut rows = vec![
            json!({"statementType":kind,"source":"eastmoney","reportDate":report,"updatedAt":now.timestamp_millis(),"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_income.v1","TOTAL_PARENT_EQUITY":600000000,"OTHER_EQUITY_TOOL":100000000}}),
        ];
        if kind == "income" {
            rows.push(json!({"statementType":kind,"source":"eastmoney","reportDate":"2025-12-31","fiscalPeriod":"12M","updatedAt":now.timestamp_millis(),"payload":{"FINANCIAL_SOURCE_CONTRACT":"eastmoney_f10_annual_income.v1"}}));
        }
        store
            .put_json(
                &format!("financial-statements/{kind}/300308.SZ.json"),
                &json!({"rows":rows}),
            )
            .await
            .unwrap();
    }
    let response = stock_info_local::router(state, directory.path())
        .oneshot(
            Request::builder()
                .uri("/api/company/overview?code=300308.SZ")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data = json_body(response).await["data"].clone();
    assert_eq!(data["name"], "中际旭创");
    assert_eq!(data["source"], "xueqiu");
    assert_eq!(data["latestPrice"], 123.0);
    assert_eq!(data["pb"], 2.0);
    assert_eq!(data["companyProfile"]["availability"], "available");
    assert_eq!(
        data["companyProfile"]["industryLevels"],
        json!(["通信", "通信设备"])
    );
}

#[tokio::test]
async fn overview_refuses_a_search_result_for_a_different_security() {
    for key in ["LOCAL_DATA_DIR", "LOCAL_MARKET_DATA_DIR"] {
        assert!(std::env::var_os(key).is_none_or(|value| value.is_empty()));
    }
    let (directory, state) = setup();
    let now = chrono::Utc::now();
    let today = now.date_naive().to_string();
    let mut url =
        reqwest::Url::parse("https://searchadapter.eastmoney.com/api/suggest/get").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("input", "00700"),
        ("type", "8"),
        ("token", "D43BF722C8E33BDC906FB84D85E326E8"),
        ("count", "10"),
    ]);
    seed_get(
        &state,
        url.as_str(),
        "https://www.eastmoney.com/",
        json!({"GubaCodeTable":{"Data":[{"OuterCode":"HK00701","ShortName":"另一公司"}]}}),
    )
    .await;
    state.market_store().unwrap().put_json("kline/normal/00700.HK.json",&json!({"schemaVersion":2,"source":"xueqiu","rawResponseText":"{}","updatedAt":now.timestamp_millis(),"startDate":today,"endDate":today,"rows":[{"date":today,"close":421.5,"marketCapital":1000000000}]})).await.unwrap();
    let before = cache_counts(&state).await;
    let error = stock_info_local::company::overview(&state, "00700.HK")
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("company identity unavailable for exact code")
    );
    let response = stock_info_local::router(state.clone(), directory.path())
        .oneshot(
            Request::builder()
                .uri("/api/company/overview?code=00700.HK")
                .header("host", "127.0.0.1:18000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = json_body(response).await;
    assert_eq!(body["msg"], "internal server error");
    assert_eq!(body["data"], Value::Null);
    assert_eq!(
        cache_counts(&state).await,
        before,
        "failed identity must not persist results"
    );
}

async fn cache_counts(state: &AppState) -> Vec<Value> {
    state.db.query("SELECT 'kv' AS kind,count(*) AS count FROM kv_cache UNION ALL SELECT 'http',count(*) FROM http_cache",vec![]).await.unwrap()
}
