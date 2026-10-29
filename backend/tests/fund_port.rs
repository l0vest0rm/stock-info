// Standalone compilation and parser acceptance while root integrates modules.
pub use stock_info_local::{ApiResult, AppState, cache_policy, codes, http, market, ok};
#[allow(dead_code)]
#[path = "../src/fund.rs"]
mod fund;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::Datelike;
use reqwest::Url;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tower::ServiceExt;

async fn cache(state: &AppState, address: &str, referer: &str, text: &str) {
    let headers = BTreeMap::from([
        ("referer", referer),
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
                serde_json::to_string(address).unwrap(),
                serde_json::to_string(&headers).unwrap()
            )
            .as_bytes()
        )
    );
    let now = chrono::Utc::now().timestamp_millis();
    state.db.execute("INSERT INTO http_cache(cache_key,url,method,status,headers_json,body_text,expires_at,updated_at) VALUES(?,?,'GET',200,'{}',?,?,?)",vec![key.into(),address.into(),text.into(),(now+86_400_000).into(),now.into()]).await.unwrap();
}
fn url(address: &str, params: &[(&str, &str)]) -> String {
    let mut url = Url::parse(address).unwrap();
    url.query_pairs_mut().extend_pairs(params.iter().copied());
    url.to_string()
}

#[tokio::test]
async fn routes_read_provider_fixtures_without_live_network() {
    // AppState accepts process-level object-store overrides in real operation.
    // Never let an acceptance fixture write into a user's configured store.
    for key in ["LOCAL_DATA_DIR", "LOCAL_MARKET_DATA_DIR"] {
        assert!(
            std::env::var_os(key).is_none_or(|value| value.is_empty()),
            "unset {key} before running isolated fund fixtures"
        );
    }
    let temp = tempfile::tempdir().unwrap();
    let db = stock_info_local::db::Database::open(temp.path().join("stock.sqlite")).unwrap();
    db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
        .unwrap();
    let state = AppState::new(db, temp.path().to_path_buf(), "127.0.0.1:18000".into()).unwrap();
    let referer = "https://fundf10.eastmoney.com/";
    cache(
        &state,
        "https://fundf10.eastmoney.com/jbgk_000001.html",
        referer,
        "<div class='fundDetail-tit'>测试基金</div>",
    )
    .await;
    cache(&state,"https://fundf10.eastmoney.com/zcpz_000001.html",referer,"<table><tr><th>报告期</th><th>股票占净比</th><th>债券</th><th>现金</th><th>净资产</th></tr><tr><td>2026-09-30</td><td>80%</td><td>10%</td><td>10%</td><td>20</td></tr></table>").await;
    cache(
        &state,
        &url(
            "https://fundf10.eastmoney.com/FundArchivesDatas.aspx",
            &[
                ("type", "gmbd"),
                ("mode", "0"),
                ("code", "000001"),
                ("rt", "0.1"),
            ],
        ),
        referer,
        "<tr><td>2026-09-30</td><td>1</td><td>2</td><td>100</td><td>3</td><td>4</td></tr>",
    )
    .await;
    cache(&state,&url("https://api.fund.eastmoney.com/f10/JJGG",&[("fundcode","000001"),("pageIndex","2"),("pageSize","20"),("type","3")]),referer,&json!({"ErrCode":0,"Data":[{"ID":"notice1","TITLE":"季报","ATTACHTYPE":"0"}],"TotalCount":1}).to_string()).await;
    cache(
        &state,
        "https://fund.eastmoney.com/js/jjjz_gs.js?v=0.1",
        "https://fund.eastmoney.com/",
        "var companies=[[\"A\",\"基金公司\"]];",
    )
    .await;
    let now = chrono::Utc::now();
    let local = chrono::Local::now();
    let from = (now - chrono::Duration::days(366)).date_naive().to_string();
    let to = now.date_naive().to_string();
    let start_year = local.year() - i32::from(local.month() < 4);
    for code in ["000001", "000002"] {
        if code == "000002" {
            cache(
                &state,
                &format!("https://fundf10.eastmoney.com/jbgk_{code}.html"),
                referer,
                "<div class='fundDetail-tit'>另一基金</div>",
            )
            .await;
            cache(&state,&format!("https://fundf10.eastmoney.com/zcpz_{code}.html"),referer,"<table><tr><th>报告期</th><th>股票占净比</th><th>债券</th><th>现金</th><th>净资产</th></tr><tr><td>2026-09-30</td><td>90%</td><td>0%</td><td>10%</td><td>30</td></tr></table>").await;
        }
        for year in [start_year, start_year - 1] {
            cache(&state,&url("https://fundf10.eastmoney.com/FundArchivesDatas.aspx",&[("type","jjcc"),("code",code),("topline","20"),("year",&year.to_string()),("month",""),("rt","0.1")]),referer,"<div class='boxitem'><label>2026-09-30</label><tr><td>1</td><td>600036</td><td>招商银行</td><td></td><td>5%</td><td>1,000</td></tr></div>").await;
        }
        state.market_store().unwrap().put_json(&format!("fund-nav/{code}.OF.json"),&json!({"code":format!("{code}.OF"),"source":"eastmoney","updatedAt":now.timestamp_millis(),"startDate":from,"endDate":to,"rows":[{"date":from,"nav":1.0,"accumNav":1.0},{"date":to,"nav":1.1,"accumNav":1.2}]})).await.unwrap();
    }
    let sse = "https://query.sse.com.cn/commonQuery.do";
    let overview_url = |code| {
        url(
            sse,
            &[
                ("jsonCallBack", "jsonpCallbackLicaiFundOverview"),
                ("isPagination", "false"),
                ("FUNDID2", code),
                ("sqlId", "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C"),
            ],
        )
    };
    cache(
        &state,
        &overview_url("000001"),
        "https://www.sse.com.cn/",
        &json!({"result":[{"TRADING_DAY":"20261029","NAV":"￥1.234","RECORD_NUM":2}]}).to_string(),
    )
    .await;
    cache(
        &state,
        &overview_url("000002"),
        "https://www.sse.com.cn/",
        "invalid provider body",
    )
    .await;
    for page in [1, 2] {
        let response = if page == 1 {
            json!({"result":[{"NUM":1,"INSTRUMENT_ID":"600036","INSTRUMENT_NAME":"招商银行","QUANTITY":"1,000"}],"pageHelp":{"pageCount":2}})
        } else {
            json!({"result":[],"pageHelp":{"pageCount":2,"data":[{"NUM":2,"INSTRUMENT_ID":"600519","INSTRUMENT_NAME":"贵州茅台","QUANTITY":"100"}]}})
        };
        cache(
            &state,
            &url(
                sse,
                &[
                    ("jsonCallBack", "jsonpCallbackLicaiFundConstituents"),
                    ("isPagination", "true"),
                    ("FUNDID2", "000001"),
                    ("sqlId", "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C"),
                    ("pageHelp.pageSize", "10"),
                    ("pageHelp.cacheSize", "1"),
                    ("pageHelp.pageNo", &page.to_string()),
                    ("pageHelp.beginPage", &page.to_string()),
                    ("pageHelp.endPage", &page.to_string()),
                ],
            ),
            "https://www.sse.com.cn/",
            &response.to_string(),
        )
        .await;
    }
    let rank_url = url(
        "https://fund.eastmoney.com/data/rankhandler.aspx",
        &[
            ("op", "ph"),
            ("dt", "kf"),
            ("ft", "hh"),
            ("rs", ""),
            ("gs", "0"),
            ("sc", "3yzf"),
            ("st", "desc"),
            ("sd", &format!("{}-{}", local.year() - 1, &to[5..])),
            ("ed", &to),
            ("qdii", ""),
            ("tabSubtype", ",,,,,"),
            ("pi", "1"),
            ("pn", "50"),
            ("dx", "1"),
            ("v", "0.7199999265711771"),
        ],
    );
    let mut fields = (0..25).map(|n| n.to_string()).collect::<Vec<_>>();
    fields[0] = "000001".into();
    fields[1] = "测试基金".into();
    cache(
        &state,
        &rank_url,
        "https://fund.eastmoney.com/data/fundranking.html",
        &format!(
            "var rankData={{datas:[{}],allRecords:1,pageIndex:1,pageNum:50,allPages:1}}",
            serde_json::to_string(&fields.join(",")).unwrap()
        ),
    )
    .await;
    let app = fund::routes().with_state(state);
    for (path, field, expected) in [
        ("/fund/info?code=000001.OF", "name", json!("测试基金")),
        (
            "/fund/asset-allocation?code=000001.OF",
            "source",
            json!("eastmoney"),
        ),
        (
            "/fund/notices?code=000001.OF&page=2&category=3",
            "totalCount",
            json!(1.0),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
                .unwrap();
        assert_eq!(body["code"], 200);
        assert_eq!(body["data"][field], expected);
    }
    for path in [
        "/fund/info",
        "/fund/position",
        "/fund/asset-allocation",
        "/fund/share-change",
        "/fund/notices",
        "/fund/constituents",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
    }
    for path in [
        "/fund/share-change?code=000001.OF",
        "/fund/companies",
        "/fund/compare?codes=000001.OF,INVALID",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
                .unwrap();
        assert_eq!(body["code"], 200);
        if path.starts_with("/fund/compare") {
            assert_eq!(body["data"]["rows"], json!([]));
        }
        if path.starts_with("/fund/share-change") {
            assert_eq!(body["data"][0]["date"], "2026-09-30");
        }
        if path == "/fund/companies" {
            assert_eq!(body["data"], json!([["A", "基金公司"]]));
        }
    }
    for path in [
        "/fund/position?code=000001.OF",
        "/fund/constituents?code=000001.OF",
        "/fund/constituents?code=000002.OF",
        "/fund/rank?ft=hh",
        "/fund/compare?codes=000001.OF,000002.OF",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
                .unwrap();
        let data = &body["data"];
        if path.starts_with("/fund/position") {
            assert_eq!(data.as_array().unwrap().len(), 1);
            assert_eq!(data[0]["sourceCode"], "000001.OF");
            assert_eq!(data[0]["data"][0][0], "600036.SH");
        }
        if path == "/fund/constituents?code=000001.OF" {
            assert_eq!(data["rows"].as_array().unwrap().len(), 2);
            assert_eq!(data["rows"][0]["quantity"], "1000");
            assert_eq!(data["rows"][1]["priceCode"], Value::Null);
        }
        if path == "/fund/constituents?code=000002.OF" {
            assert!(
                data["sourceError"]
                    .as_str()
                    .unwrap()
                    .contains("invalid provider")
            );
            assert_eq!(data["rows"], json!([]));
        }
        if path.starts_with("/fund/rank") {
            assert_eq!(data["rows"][0][1], "000001");
            assert_eq!(data["allRecords"], 1);
        }
        if path.starts_with("/fund/compare") {
            assert_eq!(data["rows"].as_array().unwrap().len(), 2);
            for row in data["rows"].as_array().unwrap() {
                assert_eq!(row["holdingCount"], 1);
                assert_eq!(row["dataHealth"]["navSource"], "r2");
                assert_eq!(row["performance"]["oneYearReturnPct"], 20.0);
            }
        }
    }
}
