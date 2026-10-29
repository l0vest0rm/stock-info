//! Local fund holdings statistics; generated reports retain missing-source warnings.
use super::{api_sources, days_before, domain, read_optional, write_json, write_text};
use crate::AppState;
use anyhow::{Context, Result, bail};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
};

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn number(v: &Value) -> Option<f64> {
    if v.is_null() || v.as_str() == Some("") {
        return None;
    }
    v.as_f64()
        .or_else(|| v.as_str()?.replace(',', "").parse().ok())
        .filter(|n| n.is_finite())
}
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::String(value) if value.trim().is_empty() => Some(0.0),
        Value::String(value) => value.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        Value::Number(value) => value.as_f64().filter(|n| n.is_finite()),
        _ => None,
    }
}
fn normalize(code: &str) -> String {
    let text = code.trim().to_uppercase();
    if text.len() == 8
        && text
            .get(..2)
            .is_some_and(|prefix| ["SH", "SZ", "BJ"].contains(&prefix))
        && text[2..].bytes().all(|b| b.is_ascii_digit())
    {
        format!("{}.{}", &text[2..], &text[..2])
    } else {
        text
    }
}
fn a_share(code: &str) -> bool {
    let code = normalize(code);
    code.len() == 9
        && code.as_bytes()[6] == b'.'
        && code[..6].bytes().all(|b| b.is_ascii_digit())
        && ["SH", "SZ", "BJ"].contains(&&code[7..])
}
fn remove_optional(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn performance_periods(as_of: &str, definitions: &Value) -> Result<Value> {
    let mut periods = Vec::new();
    for definition in array(definitions) {
        let start = if definition["yearStart"] == true {
            format!("{}-01-01", as_of.get(..4).context("invalid as-of")?)
        } else {
            let days = js_number(&definition["days"])
                .context("performance period days must be positive integer")?;
            if days <= 0.0 || days.fract() != 0.0 || days > i64::MAX as f64 {
                bail!("performance period days must be positive integer");
            }
            days_before(as_of, days as i64)?
        };
        periods.push(
            json!({"key":s(&definition,"key"),"label":s(&definition,"label"),"startDate":start}),
        );
    }
    Ok(json!(periods))
}
pub fn forecast_years(as_of: &str, configured: &Value) -> Result<Value> {
    if configured.as_array().is_some_and(|a| !a.is_empty()) {
        let years: BTreeSet<i64> = array(configured)
            .iter()
            .filter_map(js_number)
            .filter(|n| n.fract() == 0.0 && *n >= i64::MIN as f64 && *n <= i64::MAX as f64)
            .map(|n| n as i64)
            .collect();
        return Ok(json!(years));
    }
    let year = as_of.get(..4).context("invalid as-of")?.parse::<i32>()?;
    Ok(json!([year, year + 1, year + 2]))
}
fn signature(as_of: &str, report_date: &str, holdings: &Value) -> Result<String> {
    let holdings: Vec<Value> = array(holdings)
        .iter()
        .map(|h| {
            json!([
                s(h, "code"),
                array(&h["funds"])
                    .iter()
                    .map(|f| json!([s(f, "code"), f["weightPct"]]))
                    .collect::<Vec<Value>>()
            ])
        })
        .collect();
    let payload = format!(
        "{{\"schemaVersion\":1,\"asOf\":{},\"reportDate\":{},\"holdings\":{}}}",
        serde_json::to_string(as_of)?,
        serde_json::to_string(report_date)?,
        crate::knowledge::information_records::canonical_json(&json!(holdings))
    );
    Ok(format!("{:x}", Sha256::digest(payload.as_bytes())))
}
async fn markets(
    state: &AppState,
    codes: &[String],
    settings: &Value,
    sources: &Value,
) -> Result<Vec<Value>> {
    let batch_size = settings["marketBatchSize"].as_u64().unwrap_or(50) as usize;
    if batch_size == 0 {
        bail!("holdings marketBatchSize must be positive");
    }
    let codes = codes
        .iter()
        .filter(|code| a_share(code))
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    for chunk in codes.chunks(batch_size) {
        let quoted = chunk
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(",");
        let params=vec![("st".into(),"TOTAL_MARKET_CAP".into()),("sr".into(),"-1".into()),("ps".into(),batch_size.to_string()),("p".into(),"1".into()),("sty".into(),"SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,NEW_PRICE,TOTAL_MARKET_CAP,MAX_TRADE_DATE".into()),("filter".into(),format!("(SECUCODE in ({quoted}))"))];
        match api_sources(state, "/api/companies/filter", &params, sources).await {
            Ok(data) => rows.extend(array(&data["data"])),
            Err(error) => eprintln!(
                "{}",
                json!({"event":"holding_market_batch_failed","codes":chunk,"error":error.to_string()})
            ),
        }
    }
    Ok(rows)
}

pub async fn update(state: &AppState, context: &Value) -> Result<Value> {
    let as_of = s(context, "asOf");
    let report_date = s(context, "reportDate");
    let quarter = s(context, "reportQuarter");
    let settings = &context["config"]["holdingsStatistics"];
    if settings["enabled"] == false {
        return Ok(json!({"path":"","skipped":true,"holdings":0}));
    }
    let output = PathBuf::from(s(context, "outputDir"));
    let evidence_dir = PathBuf::from(s(context, "evidenceDir"));
    let path = output.join(format!("基金持仓统计-{quarter}.html"));
    let legacy = output.join(format!("基金持仓统计-{quarter}.md"));
    let mut evidences = Vec::new();
    let mut warnings = Vec::new();
    for fund in array(&context["funds"]) {
        let evidence = read_optional(
            &evidence_dir.join(format!("{}-{quarter}.json", s(&fund, "code"))),
            Value::Null,
        )?;
        if evidence.is_null() {
            warnings.push(format!(
                "{}（{}）缺少结构化持仓证据，未纳入统计。",
                s(&fund, "name"),
                s(&fund, "code")
            ));
        } else {
            evidences.push(evidence);
        }
    }
    let holdings = domain::aggregate_current_fund_holdings(&json!(evidences));
    let signature = signature(as_of, report_date, &holdings)?;
    let state_path = Path::new(s(context, "stateDir"))
        .join("holdings")
        .join(format!("{quarter}-{as_of}.json"));
    let previous = read_optional(&state_path, Value::Null)?;
    let periods = performance_periods(as_of, &settings["performancePeriods"])?;
    let years = forecast_years(as_of, &settings["forecastYears"])?;
    let render = |holdings: &Value, count: usize, warnings: &Value| {
        domain::render_fund_holdings_statistics_html(
            &json!({"asOf":as_of,"reportDate":report_date,"quarter":quarter,"fundsAnalyzed":count,"holdings":holdings,"periods":periods,"forecastYears":years,"baseUrl":s(context,"baseUrl"),"warnings":warnings}),
        )
    };
    if context["force"] != true
        && previous["signature"] == signature
        && previous["holdings"].is_array()
    {
        let count = previous["fundsAnalyzed"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or(evidences.len());
        let html = render(&previous["holdings"], count, &previous["warnings"]);
        write_text(&path, &format!("{html}\n"))?;
        remove_optional(&legacy)?;
        return Ok(
            json!({"path":path,"skipped":true,"holdings":array(&previous["holdings"]).len()}),
        );
    }
    let earliest = array(&periods)
        .iter()
        .map(|p| s(p, "startDate").to_owned())
        .min()
        .unwrap_or(days_before(as_of, 365)?);
    let kline_start = days_before(&earliest, 7)?;
    let codes = array(&holdings)
        .iter()
        .map(|h| s(h, "code").to_owned())
        .collect::<Vec<_>>();
    let market_rows = markets(state, &codes, settings, &context["config"]["sources"]).await?;
    let markets = market_rows
        .into_iter()
        .map(|r| {
            let code = r["SECUCODE"]
                .as_str()
                .or_else(|| r["SECURITY_CODE"].as_str())
                .unwrap_or("");
            (normalize(code), r)
        })
        .collect::<HashMap<_, _>>();
    let mut enriched = Vec::new();
    let mut failures = 0;
    let sources = &context["config"]["sources"];
    let mut report_sources = sources.clone();
    report_sources["requestTimeoutMs"] = settings["forecastRequestTimeoutMs"]
        .as_u64()
        .unwrap_or(120_000)
        .into();
    report_sources["requestAttempts"] = settings["forecastRequestAttempts"]
        .as_u64()
        .unwrap_or(1)
        .into();
    let report_sources = &report_sources;
    let markets = &markets;
    let periods = &periods;
    let years = &years;
    let kline_start = &kline_start;
    let concurrency = settings["concurrency"].as_u64().unwrap_or(5).max(1) as usize;
    let mut jobs=stream::iter(array(&holdings)).map(|mut holding|async move {
        let code = s(&holding, "code").to_owned();
        let params = vec![
            ("code".into(), code.clone()),
            ("from".into(), kline_start.clone()),
            ("to".into(), as_of.into()),
        ];
        let reports = async {
            if a_share(&code) {
                api_sources(
                    state,
                    "/api/company/reports",
                    &[("code".into(), code.clone()), ("page".into(), "1".into())],
                    report_sources,
                )
                .await
            } else {
                Ok(json!([]))
            }
        };
        let (kline, reports) = tokio::join!(api_sources(state, "/api/kline", &params, sources), reports);
        let mut errors = Vec::new();
        let kline = match kline {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("行情：{e}"));
                json!([])
            }
        };
        let reports = match reports {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("研报：{e}"));
                json!([])
            }
        };
        let mut market = domain::build_holding_market_snapshot(&kline, as_of, periods);
        let row = markets.get(&normalize(&code)).unwrap_or(&Value::Null);
        if let Some(price) = number(&row["NEW_PRICE"]) {
            market["price"] = json!(price);
        }
        if !row["MAX_TRADE_DATE"].is_null() {
            market["priceDate"] = json!(
                s(row, "MAX_TRADE_DATE")
                    .chars()
                    .take(10)
                    .collect::<String>()
            );
        }
        market["marketCapYi"] = number(&row["TOTAL_MARKET_CAP"])
            .map(|n| json!(n / 100_000_000.0))
            .unwrap_or(Value::Null);
        let forecasts = domain::aggregate_report_forecasts(
            &reports,
            &json!({"years":years,"currentPrice":market["price"],"marketCapYi":market["marketCapYi"]}),
        );
        holding["market"]=market;holding["forecasts"]=forecasts;
        (holding,errors,code)
    }).buffered(concurrency);
    while let Some((holding, errors, code)) = jobs.next().await {
        if !errors.is_empty() {
            failures += errors.len();
            warnings.push(format!(
                "{}（{code}）{}",
                s(&holding, "name"),
                errors.join("；")
            ));
        }
        enriched.push(holding);
        println!(
            "{}",
            json!({"event":"holding_statistics_progress","completed":enriched.len(),"total":codes.len(),"code":code,"forecastYears":enriched.last().map(|v|array(&v["forecasts"]).len()).unwrap_or(0),"sourceErrors":errors.len()})
        );
    }
    let count = enriched.len();
    let enriched = json!(enriched);
    let warnings = json!(warnings);
    write_text(
        &path,
        &format!("{}\n", render(&enriched, evidences.len(), &warnings)),
    )?;
    remove_optional(&legacy)?;
    write_json(
        &state_path,
        &json!({"schemaVersion":1,"generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"signature":signature,"asOf":as_of,"reportDate":report_date,"quarter":quarter,"fundsAnalyzed":evidences.len(),"holdings":enriched,"warnings":warnings,"sourceFailureCount":failures}),
    )?;
    Ok(json!({"path":path,"skipped":false,"holdings":count}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_period_and_forecast_year_contracts() {
        let periods=performance_periods("2026-10-29",&json!([{"key":"ytd","label":"今年","yearStart":true},{"key":"month","label":"月","days":30}])).unwrap();
        assert_eq!(periods[0]["startDate"], "2026-01-01");
        assert_eq!(periods[1]["startDate"], "2026-09-29");
        assert!(performance_periods("2026-10-29", &json!([{"days":0}])).is_err());
        assert_eq!(
            forecast_years("2026-10-29", &json!([2028, "2026", 2028, 2.5])).unwrap(),
            json!([2026, 2028])
        );
        assert_eq!(
            forecast_years("2026-10-29", &json!([null, true, ""])).unwrap(),
            json!([0, 1])
        );
        assert_eq!(
            forecast_years("2026-10-29", &Value::Null).unwrap(),
            json!([2026, 2027, 2028])
        );
    }
    #[test]
    fn security_normalization_preserves_market_scope() {
        assert_eq!(normalize("sz300308"), "300308.SZ");
        assert!(a_share("SH600036"));
        assert!(!a_share("00700.HK"));
    }
    #[test]
    fn signature_matches_original_field_order_and_tuple_arrays() {
        let holdings = json!([{"code":"600036.SH","funds":[{"code":"005844","weightPct":2.5}]}]);
        let raw = r#"{"schemaVersion":1,"asOf":"2026-10-29","reportDate":"2026-09-30","holdings":[["600036.SH",[["005844",2.5]]]]}"#;
        assert_eq!(
            signature("2026-10-29", "2026-09-30", &holdings).unwrap(),
            format!("{:x}", Sha256::digest(raw.as_bytes()))
        );
        let integral = json!([{"code":"600036.SH","funds":[{"code":"005844","weightPct":2.0}]}]);
        let raw = raw.replace("2.5", "2");
        assert_eq!(
            signature("2026-10-29", "2026-09-30", &integral).unwrap(),
            format!("{:x}", Sha256::digest(raw.as_bytes()))
        );
    }
    #[tokio::test]
    async fn empty_missing_evidence_state_and_cached_render_never_fetch_sources() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("db.sqlite")).unwrap();
        let state = AppState::new(db, dir.path().into(), "127.0.0.1:1".into()).unwrap();
        let output = dir.path().join("reports");
        fs::create_dir_all(&output).unwrap();
        let legacy = output.join("基金持仓统计-2026Q3.md");
        fs::write(&legacy, "old").unwrap();
        let context = json!({"asOf":"2026-10-29","reportDate":"2026-09-30","reportQuarter":"2026Q3","baseUrl":"http://127.0.0.1:1","outputDir":output,"evidenceDir":dir.path().join("evidence"),"stateDir":dir.path().join("state"),"funds":[{"code":"005844","name":"基金A"}],"config":{"holdingsStatistics":{"performancePeriods":[]}}});
        let result = update(&state, &context).await.unwrap();
        assert_eq!(result["holdings"], 0);
        assert_eq!(result["skipped"], false);
        assert!(!legacy.exists());
        let html = fs::read_to_string(output.join("基金持仓统计-2026Q3.html")).unwrap();
        assert!(html.contains("缺少结构化持仓证据"));
        let stored = read_optional(
            &dir.path().join("state/holdings/2026Q3-2026-10-29.json"),
            Value::Null,
        )
        .unwrap();
        assert_eq!(stored["fundsAnalyzed"], 0);
        assert_eq!(stored["sourceFailureCount"], 0);
        assert_eq!(stored["warnings"].as_array().unwrap().len(), 1);
        assert_eq!(update(&state, &context).await.unwrap()["skipped"], true);
    }
}
