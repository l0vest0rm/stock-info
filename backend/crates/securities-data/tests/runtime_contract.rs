//! External-crate consumer: no stock-info, SQLite, assets or environment needed.
use anyhow::{Result, bail};
use reqwest::header::HeaderMap;
use securities_data::{
    Runtime,
    finance::{dividends, providers},
    reports::sources,
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex};

type Cache = HashMap<String, (Value, i64)>;
#[derive(Default)]
struct Host {
    snapshots: Mutex<HashMap<String, Value>>,
    http_cache: Mutex<HashMap<String, (String, i64)>>,
    cache: Mutex<Cache>,
    requests: Mutex<Vec<String>>,
    response: Mutex<Option<String>>,
    policies: Mutex<Vec<(HeaderMap, i64)>>,
    changes: Mutex<Vec<Value>>,
}
impl Runtime for Host {
    fn config(&self, _: &str) -> Result<Value> {
        Ok(json!({}))
    }
    async fn read_snapshot(&self, key: &str) -> Result<Option<Value>> {
        Ok(self.snapshots.lock().unwrap().get(key).cloned())
    }
    async fn write_snapshot(&self, key: &str, value: &Value) -> Result<()> {
        self.snapshots
            .lock()
            .unwrap()
            .insert(key.into(), value.clone());
        Ok(())
    }
    async fn read_http_cache(&self, key: &str, now: i64) -> Result<Option<String>> {
        Ok(self
            .http_cache
            .lock()
            .unwrap()
            .get(key)
            .filter(|(_, expires)| *expires > now)
            .map(|(value, _)| value.clone()))
    }
    async fn write_http_cache(
        &self,
        key: &str,
        _: &str,
        text: &str,
        expires_at: i64,
        _: i64,
    ) -> Result<()> {
        self.http_cache
            .lock()
            .unwrap()
            .insert(key.into(), (text.into(), expires_at));
        Ok(())
    }
    async fn read_cache(&self, namespace: &str, key: &str, now: i64) -> Result<Option<Value>> {
        Ok(self
            .cache
            .lock()
            .unwrap()
            .get(&format!("{namespace}:{key}"))
            .filter(|(_, expires)| *expires > now)
            .map(|(value, _)| value.clone()))
    }
    async fn write_cache(
        &self,
        namespace: &str,
        key: &str,
        value: &Value,
        expires_at: i64,
    ) -> Result<()> {
        self.cache
            .lock()
            .unwrap()
            .insert(format!("{namespace}:{key}"), (value.clone(), expires_at));
        Ok(())
    }
    async fn get_text(&self, url: &str, _: HeaderMap) -> Result<String> {
        self.requests.lock().unwrap().push(url.into());
        let response = self
            .response
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("host transport rejected request"))?;
        if url.contains("RPT_F10_EH_EQUITY") {
            return Ok(json!({"result":{"data":*self.changes.lock().unwrap()}}).to_string());
        }
        Ok(response)
    }
    async fn cached_json(&self, url: &str, headers: HeaderMap, ttl: i64) -> Result<Value> {
        self.policies.lock().unwrap().push((headers.clone(), ttl));
        Ok(serde_json::from_str(&self.get_text(url, headers).await?)?)
    }
    async fn get_bytes(
        &self,
        _: &str,
        _: HeaderMap,
        _: Option<u64>,
    ) -> Result<(Vec<u8>, HeaderMap)> {
        bail!("host byte transport rejected request")
    }
}

#[tokio::test]
async fn yahoo_acquisition_and_normalization_use_host_transport_and_cache() {
    let host = Host::default();
    *host.response.lock().unwrap() = Some(json!({"timeseries":{"error":null,"result":[{"meta":{"type":["quarterlyTotalRevenue"]},"quarterlyTotalRevenue":[{"asOfDate":"2026-06-30","periodType":"3M","currencyCode":"USD","reportedValue":{"raw":10}}]}]}}).to_string());
    let first = providers::fetch_us(&host, "TEST.US", "income")
        .await
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["payload"]["TOTAL_OPERATE_INCOME"], 10.0);
    assert_eq!(first[0]["payload"]["REPORTING_CURRENCY"], "USD");
    assert_eq!(first[0]["source"], "yahoo");
    assert_eq!(first[0]["fiscalPeriod"], "3M");
    *host.response.lock().unwrap() = None;
    let second = providers::fetch_us(&host, "TEST.US", "income")
        .await
        .unwrap();
    assert_eq!(second[0]["payload"], first[0]["payload"]);
    let requests = host.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with(
        "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/TEST?"
    ));
    assert_eq!(host.http_cache.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn rejected_source_is_not_cached_or_switched_to_another_provider() {
    let host = Host::default();
    assert!(
        providers::fetch_us(&host, "TEST.US", "income")
            .await
            .is_err()
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    assert!(host.http_cache.lock().unwrap().is_empty());
    assert!(
        providers::load(&host, "TEST.US", "unsupported")
            .await
            .is_err()
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    *host.response.lock().unwrap() =
        Some(r#"{"timeseries":{"error":{"code":"Unauthorized"}}}"#.into());
    assert!(
        providers::fetch_us(&host, "TEST.US", "income")
            .await
            .is_err()
    );
    assert!(host.http_cache.lock().unwrap().is_empty());
}

#[tokio::test]
async fn research_sources_and_pdf_cache_are_reusable_without_stock_info() {
    let host = Host::default();
    *host.response.lock().unwrap() =
        Some(r#"{"data":[{"infoCode":"AP123","title":"Report","predictThisYearEps":1.5}]}"#.into());
    let reports = sources::eastmoney_reports(&host, "600036.SH", 1, 10)
        .await
        .unwrap();
    assert_eq!(
        reports[0]["url"],
        "https://pdf.dfcfw.com/pdf/H3_AP123_1.pdf"
    );
    assert_eq!(reports[0]["predictThisYearEps"], "1.5");
    let key = "eastmoney-report-pdf-text:AP123";
    sources::write_app(&host, key, &json!({"text":"cached PDF"}), 10000)
        .await
        .unwrap();
    assert_eq!(
        sources::eastmoney_pdf_text(&host, "AP123").await.unwrap(),
        "cached PDF"
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    assert!(
        sources::write_app(&host, "unknown-key", &json!({}), 100)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn dividend_history_preserves_provider_contract_and_plan_normalization() {
    let host = Host::default();
    let raw = json!([
        {"NOTICE_DATE":"2026-04-01 00:00:00","IMPL_PLAN_PROFILE":"10送2转3派5元","EQUITY_RECORD_DATE":"2026-05-01","EX_DIVIDEND_DATE":"2026-05-02","ASSIGN_PROGRESS":"实施"},
        {"NOTICE_DATE":"2025-03-01","IMPL_PLAN_PROFILE":"10派2元","EX_DIVIDEND_DATE":"2025-04-01"},
        {"IMPL_PLAN_PROFILE":"不分配不转增"},
        {"IMPL_PLAN_PROFILE":""}
    ]);
    *host.response.lock().unwrap() = Some(json!({"result":{"data":raw}}).to_string());
    *host.changes.lock().unwrap() = vec![
        json!({"END_DATE":"2026-04-30","TOTAL_SHARES":200}),
        json!({"END_DATE":"2024-01-01","TOTAL_SHARES":100}),
    ];
    let rows = dividends::share_bonuses(&host, "600036").await.unwrap();
    assert_eq!(
        rows,
        vec![
            json!({"noticeDate":"2026-04-01","progress":"实施","plan":"10送2转3派5元","give":0.2,"trans":0.3,"bonus":0.5,"bonusTotal":100.0,"divDate":"2026-05-02","recordDate":"2026-05-01"}),
            json!({"noticeDate":"2025-03-01","progress":"","plan":"10派2元","give":0.0,"trans":0.0,"bonus":0.2,"bonusTotal":20.0,"divDate":"2025-04-01","recordDate":""}),
        ]
    );
    assert_eq!(host.requests.lock().unwrap().len(), 2);
    for request in host.requests.lock().unwrap().iter() {
        assert!(
            reqwest::Url::parse(request)
                .unwrap()
                .host_str()
                .unwrap()
                .ends_with(".eastmoney.com")
        );
    }
    let equity = reqwest::Url::parse(&host.requests.lock().unwrap()[1]).unwrap();
    let equity_params = equity.query_pairs().collect::<HashMap<_, _>>();
    assert_eq!(equity_params["reportName"], "RPT_F10_EH_EQUITY");
    assert_eq!(equity_params["pageSize"], "5000");
    assert_eq!(equity_params["sortColumns"], "END_DATE");
    assert_eq!(equity_params["filter"], "(SECUCODE=\"600036.SH\")");
    let request = reqwest::Url::parse(&host.requests.lock().unwrap()[0]).unwrap();
    assert_eq!(request.host_str(), Some("datacenter.eastmoney.com"));
    let params = request.query_pairs().collect::<HashMap<_, _>>();
    assert_eq!(params["reportName"], "RPT_F10_DIVIDEND_MAIN");
    assert_eq!(params["filter"], "(SECUCODE=\"600036.SH\")");
    assert_eq!(params["pageSize"], "100");
    assert_eq!(params["sortTypes"], "-1");
    assert_eq!(params["sortColumns"], "NOTICE_DATE");
    let policies = host.policies.lock().unwrap();
    assert_eq!(policies[0].1, 86_400_000);
    assert_eq!(
        policies[0].0[reqwest::header::REFERER],
        "https://emweb.securities.eastmoney.com/"
    );
    assert_eq!(
        dividends::share_bonuses_from_rows(raw.as_array().unwrap(), &[])[0]["bonusTotal"],
        0.0
    );
}

#[tokio::test]
async fn dividend_yield_uses_explicit_prices_without_a_market_provider() {
    let host = Host::default();
    let raw = json!([
        {"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-03-01","EX_DIVIDEND_DATE":"2026-04-01","IMPL_PLAN_PROFILE":"10派2元"},
        {"REPORT_TIME":"2026-03-31","NOTICE_DATE":"2026-05-01","IMPL_PLAN_PROFILE":"10派1元"}
    ]);
    *host.response.lock().unwrap() = Some(json!({"result":{"data":raw}}).to_string());
    let bars = vec![
        json!({"date":"2026-02-28","close":10}),
        json!({"date":"2026-03-01","close":10}),
        json!({"date":"2026-05-01","close":10}),
    ];
    let value = dividends::dividend_yield(&host, "600036", &bars)
        .await
        .unwrap();
    assert_eq!(value["series"].as_array().unwrap().len(), 2);
    assert_eq!(value["series"][0], json!([1772323200000_i64, 2.0]));
    assert!((value["currentYield"].as_f64().unwrap() - 3.0).abs() < 1e-12);
    assert!((value["annualizedCashPerShare"].as_f64().unwrap() - 0.3).abs() < 1e-12);
    let request = reqwest::Url::parse(&host.requests.lock().unwrap()[0]).unwrap();
    let params = request.query_pairs().collect::<HashMap<_, _>>();
    assert_eq!(params["sortTypes"], "1");
    assert!(params["columns"].contains("REPORT_TIME"));
    assert_eq!(
        dividends::dividend_yield(&host, "00700.HK", &bars)
            .await
            .unwrap()["events"],
        json!([])
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    *host.response.lock().unwrap() = None;
    assert!(dividends::fetch_history(&host, "600036.SH").await.is_err());
    assert!(dividends::share_bonuses(&host, "600036.SH").await.is_err());
    assert!(
        dividends::dividend_yield(&host, "600036.SH", &bars)
            .await
            .is_err()
    );
}

#[test]
fn dividend_revisions_and_rolling_quarters_preserve_existing_cash_policy() {
    let rows = vec![
        json!({"REPORT_TIME":"2024-12-31","NOTICE_DATE":"2025-01-01","IMPL_PLAN_PROFILE":"10派10元"}),
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-01-01","IMPL_PLAN_PROFILE":"10派2元"}),
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-01-02","IMPL_PLAN_PROFILE":"10派3元"}),
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-01-03","IMPL_PLAN_PROFILE":"不分配不转增"}),
        json!({"NOTICE_DATE":"2026-01-04","IMPL_PLAN_PROFILE":"10派100元"}),
    ];
    let bars = vec![
        json!({"date":"2026-01-01","close":10}),
        json!({"date":"2026-01-03","close":10}),
    ];
    let value = dividends::dividend_yield_from_rows(&rows, &bars);
    assert!((value["annualizedCash"].as_f64().unwrap() - 0.3).abs() < 1e-12);
    assert_eq!(value["events"].as_array().unwrap().len(), 3);
    assert_eq!(
        dividends::dividend_yield_from_rows(&rows, &[])["series"],
        json!([])
    );
}

#[tokio::test]
async fn share_history_keeps_source_history_and_never_fabricates_current_shares() {
    let host = Host::default();
    *host.response.lock().unwrap() = Some("{}".into());
    assert!(
        dividends::share_changes(&host, "600036.SH")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    assert!(
        dividends::share_changes(&host, "00700.HK")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    *host.changes.lock().unwrap() = vec![
        json!({"END_DATE":"2026-01-01 00:00:00","TOTAL_SHARES":120,"CHANGE_REASON":"转增"}),
        json!({"END_DATE":"2025-01-01","TOTAL_SHARES":100}),
    ];
    let rows = dividends::share_changes(&host, "600036").await.unwrap();
    assert_eq!(rows[0]["totalShares"], 120.0);
    assert_eq!(rows[0]["changeDate"], "2026-01-01");
    assert_eq!(rows[0]["changeRatio"], "20.0000");
    assert_eq!(rows[0]["changeShares"], 20.0);
    assert_eq!(rows[1]["changeRatio"], "0.0000");
    *host.response.lock().unwrap() = None;
    assert!(dividends::share_changes(&host, "600036.SH").await.is_err());
}

#[tokio::test]
async fn daily_valuations_use_only_selected_field_and_no_kline_or_private_runtime() {
    use securities_data::finance::valuations::{self, Metric};
    let host = Host::default();
    let from = "2026-01-01".parse().unwrap();
    let to = "2026-11-20".parse().unwrap();
    *host.response.lock().unwrap() = Some(json!({"success":true,"result":{"count":1,"pages":1,"data":[{"SECUCODE":"600519.SH","TRADE_DATE":"2026-11-20","PE_TTM":22.6,"PB_MRQ":6.8,"CLOSE_PRICE":1485.75}]}}).to_string());
    assert_eq!(
        valuations::history(&host, "600519.SH", Metric::Pb, from, to)
            .await
            .unwrap()[0]["value"],
        6.8
    );
    assert_eq!(
        valuations::history(&host, "600519.SH", Metric::PeTtm, from, to)
            .await
            .unwrap()[0]["value"],
        22.6
    );
    assert_eq!(
        valuations::closing_prices(&host, "600519.SH", from, to)
            .await
            .unwrap()[0]["close"],
        1485.75
    );
    let requests = host.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    for (url, field) in requests.iter().zip(["PB_MRQ", "PE_TTM", "CLOSE_PRICE"]) {
        let url = reqwest::Url::parse(url).unwrap();
        let params = url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(params["columns"], format!("SECUCODE,TRADE_DATE,{field}"));
        assert_eq!(params["reportName"], "RPT_VALUEANALYSIS_DET");
    }
}
#[tokio::test]
async fn daily_valuations_reject_partial_provider_failures_and_never_fallback() {
    use securities_data::finance::valuations::{self, Metric};
    let host = Host::default();
    let from = "2026-01-01".parse().unwrap();
    let to = "2026-11-20".parse().unwrap();
    for body in [
        json!({"success":false}),
        json!({"success":true,"result":{"count":2,"pages":1,"data":[]}}),
        json!({"success":true,"result":{"count":2,"pages":1,"data":[{"SECUCODE":"600519.SH","TRADE_DATE":"2026-11-20","PB_MRQ":2}]}}),
    ] {
        *host.response.lock().unwrap() = Some(body.to_string());
        assert!(
            valuations::history(&host, "600519.SH", Metric::Pb, from, to)
                .await
                .is_err()
        );
    }
    assert_eq!(host.requests.lock().unwrap().len(), 3);
}

#[test]
fn periodic_dividends_replace_prior_same_period_independent_of_announcement_spacing() {
    let rows = vec![
        json!({"REPORT_TIME":"2024-06-30","NOTICE_DATE":"2024-08-01","IMPL_PLAN_PROFILE":"10派8元"}),
        json!({"REPORT_TIME":"2024-12-31","NOTICE_DATE":"2025-06-01","IMPL_PLAN_PROFILE":"10派12元"}),
        // New H1 announced less than 12 months after old H1: old H1 is excluded.
        json!({"REPORT_TIME":"2025-06-30","NOTICE_DATE":"2025-07-25","IMPL_PLAN_PROFILE":"10派10元"}),
        // Same reporting period revision must REPLACE, never add to the proposal.
        json!({"REPORT_TIME":"2025-06-30","NOTICE_DATE":"2025-08-01","IMPL_PLAN_PROFILE":"10派11元"}),
        // New final announced >12 months after old final: still replace by report period.
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-07-01","IMPL_PLAN_PROFILE":"10派13元"}),
    ];
    let bars = vec![
        json!({"date":"2025-06-01","close":40}),
        json!({"date":"2025-07-25","close":40}),
        json!({"date":"2025-08-01","close":40}),
        json!({"date":"2026-06-20","close":40}),
        json!({"date":"2026-07-01","close":40}),
    ];
    let points = dividends::periodic_dividend_yield_from_rows(&rows, &bars);
    let expected = [5.0, 5.5, 5.75, 5.75, 6.0];
    for (point, value) in points.iter().zip(expected) {
        assert_eq!(point["status"], "available");
        assert!((point["value"].as_f64().unwrap() - value).abs() < 1e-10);
    }
    assert_eq!(points[1]["dividendPeriods"][0]["reportDate"], "2024-12-31");
    assert_eq!(points[1]["dividendPeriods"].as_array().unwrap().len(), 2);
    assert_eq!(points[4]["dividendPeriods"][0]["reportDate"], "2025-06-30");
}

#[test]
fn periodic_dividends_cmb_frequency_transition_never_prorates_an_annual_plan() {
    // Source: Eastmoney RPT_F10_DIVIDEND_MAIN, 600036.SH, read 2026-11-21.
    // These are source implementation notice dates, not original proposal dates.
    let rows = vec![
        json!({"REPORT_TIME":"2024-06-30","NOTICE_DATE":"2024-08-30","IMPL_PLAN_PROFILE":"不分配不转增"}),
        json!({"REPORT_TIME":"2024-12-31","NOTICE_DATE":"2025-07-04","IMPL_PLAN_PROFILE":"10派20元"}),
        json!({"REPORT_TIME":"2025-06-30","NOTICE_DATE":"2026-01-10","IMPL_PLAN_PROFILE":"10派10.13元"}),
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-07-04","IMPL_PLAN_PROFILE":"10派10.03元"}),
        json!({"REPORT_TIME":"2026-06-30","NOTICE_DATE":"2026-03-28","IMPL_PLAN_PROFILE":"现金分红金额占2026年半年度归属于本行普通股股东净利润的比例为35%"}),
    ];
    let bars = vec![
        json!({"date":"2025-07-04","close":40}),
        json!({"date":"2026-06-17","close":40}),
        json!({"date":"2026-07-04","close":40}),
    ];
    let points = dividends::periodic_dividend_yield_from_rows(&rows, &bars);
    assert_eq!(points[0]["value"], 5.0);
    assert_eq!(points[1]["value"], Value::Null);
    assert_eq!(points[1]["status"], "incomplete_cycle");
    assert_eq!(points[2]["status"], "available");
    assert!((points[2]["cashPerShare"].as_f64().unwrap() - 2.016).abs() < 1e-10);
    assert!((points[2]["value"].as_f64().unwrap() - 5.04).abs() < 1e-10);
    assert_eq!(points[2]["reportDate"], "2025-12-31");
}

#[test]
fn periodic_dividends_handle_quarterly_zero_cancellations_and_missing_without_lookahead() {
    let rows = vec![
        json!({"REPORT_TIME":"2024-12-31","NOTICE_DATE":"2025-03-01","IMPL_PLAN_PROFILE":"10派10元"}),
        json!({"REPORT_TIME":"2025-03-31","NOTICE_DATE":"2025-04-20","IMPL_PLAN_PROFILE":"10派1元"}),
        json!({"REPORT_TIME":"2025-06-30","NOTICE_DATE":"2025-08-20","IMPL_PLAN_PROFILE":"10派2元"}),
        json!({"REPORT_TIME":"2025-09-30","NOTICE_DATE":"2025-10-20","IMPL_PLAN_PROFILE":"10派3元"}),
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-03-01","IMPL_PLAN_PROFILE":"10派4元"}),
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-03-02","IMPL_PLAN_PROFILE":"不分配不转增"}),
        json!({"REPORT_TIME":"2025-09-30","NOTICE_DATE":"2026-03-03","IMPL_PLAN_PROFILE":"10派0元"}),
    ];
    let bars = vec![
        json!({"date":"2025-02-28","close":10}),
        json!({"date":"2026-03-01","close":10}),
        json!({"date":"2026-03-02","close":10}),
        json!({"date":"2026-03-03","close":10}),
        json!({"date":"2026-03-04","close":0}),
    ];
    let points = dividends::periodic_dividend_yield_from_rows(&rows, &bars);
    assert_eq!(points.len(), 3);
    for (point, expected) in points.iter().zip([10.0, 6.0, 3.0]) {
        assert!((point["value"].as_f64().unwrap() - expected).abs() < 1e-10);
    }
    assert!(dividends::periodic_dividend_yield_from_rows(&[], &bars).is_empty());
    assert!(dividends::periodic_dividend_yield_from_rows(&rows, &[]).is_empty());
    let missing = vec![
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-01-01","IMPL_PLAN_PROFILE":"待定"}),
    ];
    assert!(dividends::periodic_dividend_yield_from_rows(&missing, &bars).is_empty());
    let zero = vec![
        json!({"REPORT_TIME":"2025-12-31","NOTICE_DATE":"2026-01-01","IMPL_PLAN_PROFILE":"不分配不转增"}),
    ];
    assert_eq!(
        dividends::periodic_dividend_yield_from_rows(&zero, &bars)[0]["value"],
        0.0
    );
}

impl securities_data::notices::NoticeRuntime for Host {
    async fn cached_post_json(
        &self,
        url: &str,
        headers: HeaderMap,
        body: Option<String>,
        ttl: i64,
    ) -> Result<Value> {
        self.requests.lock().unwrap().push(url.to_owned());
        match body {
            None => {
                assert!(url.ends_with("/new/information/topSearch/query?keyWord=300308&maxNum=10"));
                assert_eq!(ttl, 30 * 86_400_000);
                Ok(json!([{"code":"300308","orgId":"org1"}]))
            }
            Some(form) => {
                assert!(url.ends_with("/new/hisAnnouncement/query"));
                assert_eq!(headers["origin"], "https://www.cninfo.com.cn");
                let parsed = reqwest::Url::parse(&format!("http://localhost/?{form}"))?;
                let fields: HashMap<_, _> = parsed.query_pairs().collect();
                for (k, v) in [
                    ("stock", "300308,org1"),
                    ("pageNum", "2"),
                    ("pageSize", "30"),
                    ("column", "szse"),
                    ("tabName", "relation"),
                ] {
                    assert_eq!(fields[k], v);
                }
                assert_eq!(ttl, 30 * 60_000);
                Ok(
                    json!({"announcements":[{"announcementId":"a1","announcementTitle":"调研记录"}]}),
                )
            }
        }
    }
}

#[tokio::test]
async fn notice_listing_uses_injected_post_and_keeps_market_routing() {
    use securities_data::notices::company_notices;
    let host = Host::default();
    assert!(
        company_notices(&host, "00700.HK", 1., 20., "", true)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        company_notices(&host, "300308", 101., 20., "", false)
            .await
            .is_err()
    );
    assert!(host.requests.lock().unwrap().is_empty());
    let rows = company_notices(&host, "300308", 2., 50., "", true)
        .await
        .unwrap();
    assert_eq!(
        rows,
        vec![
            json!({"artCode":"a1","title":"调研记录","noticeDate":"","noticeType":"公司调研","pdfUrl":""})
        ]
    );
    *host.response.lock().unwrap() = Some(json!({"data":{"list":[{"art_code":"a/b","title":"Annual","notice_date":"2026-01-01T08:00"}]}}).to_string());
    let rows = company_notices(&host, "TEST.US", 1., 5., "", false)
        .await
        .unwrap();
    assert_eq!(
        rows[0]["pdfUrl"],
        "https://pdf.dfcfw.com/pdf/H3_a%2Fb_1.pdf"
    );
    assert!(
        host.requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .contains("ann_type=U%2CU_Pink")
    );
}

#[tokio::test]
async fn share_additional_preserves_raw_financing_rows_and_provider_contract() {
    let host = Host::default();
    let row = json!({"NOTICE_DATE":"2024-09-20","ISSUE_NUM":22000000,"NET_RAISE_FUNDS":null,"ISSUE_PRICE":12.34,"ISSUE_WAY_EXPLAIN":"定向增发"});
    *host.response.lock().unwrap() = Some(json!({"result":{"data":[row]}}).to_string());
    assert_eq!(
        dividends::share_additional(&host, "300308").await.unwrap(),
        vec![row]
    );
    let url = reqwest::Url::parse(&host.requests.lock().unwrap()[0]).unwrap();
    let params: HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(url.host_str(), Some("datacenter.eastmoney.com"));
    for (key, value) in [
        ("reportName", "RPT_F10_DIVIDEND_SEO"),
        ("filter", r#"(SECUCODE="300308.SZ")"#),
        ("pageNumber", "1"),
        ("pageSize", "100"),
        ("sortColumns", "NOTICE_DATE"),
        ("sortTypes", "-1"),
    ] {
        assert_eq!(params[key], value);
    }
    assert_eq!(host.policies.lock().unwrap()[0].1, 86_400_000);
    *host.response.lock().unwrap() = Some(json!({"result":{"data":[]}}).to_string());
    assert!(
        dividends::share_additional(&host, "300308")
            .await
            .unwrap()
            .is_empty()
    );
    *host.response.lock().unwrap() = None;
    assert!(dividends::share_additional(&host, "300308").await.is_err());
}
