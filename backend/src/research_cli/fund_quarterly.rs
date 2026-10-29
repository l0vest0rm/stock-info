//! Native quarterly fund research pipeline. Source acquisition is read-only;
//! completed reports and structured evidence are atomically persisted locally.
pub mod domain;
mod statistics;

pub(super) use super::{write_json, write_text};
use crate::{AppState, http::number, research::taskd};
use anyhow::{Context, Result, bail};
use chrono::{Duration, Months, NaiveDate, Utc};
use futures_util::{StreamExt, stream};
use reqwest::{
    Method, Url,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn integer(v: &Value, key: &str, fallback: u64) -> u64 {
    v[key].as_u64().filter(|n| *n > 0).unwrap_or(fallback)
}
fn date(value: &str) -> Result<NaiveDate> {
    Ok(NaiveDate::parse_from_str(value, "%Y-%m-%d")?)
}
pub(super) fn days_before(value: &str, days: i64) -> Result<String> {
    Ok((date(value)? - Duration::days(days)).to_string())
}
fn months_before(value: &str, months: u32) -> Result<String> {
    Ok(date(value)?
        .checked_sub_months(Months::new(months))
        .context("date overflow")?
        .to_string())
}
fn deep_merge(base: &mut Value, other: Value) {
    match (base, other) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                if let Some(old) = a.get_mut(&k) {
                    deep_merge(old, v);
                } else {
                    a.insert(k, v);
                }
            }
        }
        (base, other) => *base = other,
    }
}
pub(super) fn read_optional(path: &Path, fallback: Value) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid JSON state {}", path.display()))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(e) => Err(e.into()),
    }
}
fn config(state: &AppState, options: &Value) -> Result<Value> {
    let configured = s(options, "config");
    let p = state.root.join(if configured.is_empty() {
        "config/research/fund-quarterly-research.json"
    } else {
        configured
    });
    let mut base: Value = serde_json::from_slice(&fs::read(&p)?)?;
    let local = if p.extension().is_some_and(|e| e == "json") {
        p.with_extension("local.json")
    } else {
        PathBuf::from(format!("{}.local.json", p.display()))
    };
    if local.exists() {
        deep_merge(&mut base, serde_json::from_slice(&fs::read(local)?)?);
    }
    Ok(base)
}
fn option<'a>(v: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    let val = s(v, key);
    if val.is_empty() { fallback } else { val }
}
fn existing(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}
fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

async fn provider(
    state: &AppState,
    mut url: Url,
    params: &[(&str, String)],
    sources: &Value,
    referer: Option<&str>,
) -> Result<Value> {
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
    let mut headers = HeaderMap::new();
    if let Some(referer) = referer {
        headers.insert("referer", HeaderValue::from_str(referer)?);
    }
    let attempts = integer(sources, "requestAttempts", 3).min(100);
    for attempt in 0..attempts {
        let result = async {
            let text = state
                .http
                .text_once(
                    url.as_str(),
                    Method::GET,
                    headers.clone(),
                    None,
                    integer(sources, "requestTimeoutMs", 30000),
                )
                .await?;
            crate::http::parse_json_or_jsonp(&text)
        }
        .await;
        match result {
            Ok(value) => return Ok(value),
            Err(error) if attempt + 1 == attempts => return Err(error),
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(
                    500 * 2_u64.pow(attempt.min(10) as u32),
                ))
                .await
            }
        }
    }
    unreachable!()
}
async fn fund_notices(state: &AppState, code: &str, sources: &Value) -> Result<Value> {
    let mut rows = vec![];
    let mut pages = 1;
    let limit = integer(sources, "noticeMaxPages", 3);
    let page_size = integer(sources, "noticePageSize", 100);
    let mut page = 1;
    while page <= pages.min(limit) {
        let body = provider(
            state,
            Url::parse("https://api.fund.eastmoney.com/f10/JJGG")?,
            &[
                ("fundcode", code.into()),
                ("pageIndex", page.to_string()),
                ("pageSize", page_size.to_string()),
                ("type", "0".into()),
            ],
            sources,
            Some("https://fund.eastmoney.com/"),
        )
        .await?;
        if number(&body["ErrCode"]) != Some(0.0) {
            bail!("Eastmoney fund notices failed");
        }
        rows.extend(array(&body["Data"]));
        pages = (number(&body["TotalCount"]).unwrap_or(rows.len() as f64) / page_size as f64)
            .ceil()
            .max(1.0) as u64;
        page += 1;
    }
    Ok(json!(rows))
}
async fn notice_content(state: &AppState, id: &str, sources: &Value) -> Result<Value> {
    let body = provider(
        state,
        Url::parse("https://np-cnotice-fund.eastmoney.com/api/content/ann")?,
        &[
            ("client_source", "web_fund".into()),
            ("show_all", "1".into()),
            ("art_code", id.into()),
        ],
        sources,
        None,
    )
    .await?;
    if number(&body["success"]) != Some(1.0) || s(&body["data"], "notice_content").is_empty() {
        bail!("Eastmoney fund notice content missing");
    }
    Ok(
        json!({"title":body["data"]["notice_title"].as_str().unwrap_or(""),"content":body["data"]["notice_content"],"attachmentUrl":body["data"]["attach_url"].as_str().unwrap_or("")}),
    )
}

#[derive(Clone)]
struct ContextData {
    as_of: String,
    report_date: String,
    prior_date: String,
    quarter: String,
    base_url: String,
    config: Value,
}

async fn evidence(state: &AppState, item: &Value, ctx: &ContextData) -> Result<Value> {
    let code = s(&item["fund"], "code");
    let sources = &ctx.config["sources"];
    let current_notice = domain::map_notice(&item["currentNotice"], code);
    let prior_notice = if item["priorNotice"].is_object() {
        domain::map_notice(&item["priorNotice"], code)
    } else {
        Value::Null
    };
    let prior_future = async {
        if prior_notice.is_null() {
            Ok(Value::Null)
        } else {
            notice_content(state, s(&prior_notice, "id"), sources).await
        }
    };
    let info_params = vec![("code".into(), format!("{code}.OF"))];
    let position_params = vec![
        ("code".into(), format!("{code}.OF")),
        ("num".into(), "5".into()),
    ];
    let (fund_info, positions, current_report, prior_report) = tokio::try_join!(
        api_sources(state, "/api/fund/info", &info_params, sources),
        api_sources(state, "/api/fund/position", &position_params, sources),
        notice_content(state, s(&current_notice, "id"), sources),
        prior_future
    )?;
    let positions = domain::normalize_position_periods(&positions);
    let current_raw = positions
        .get(&ctx.report_date)
        .cloned()
        .unwrap_or_else(|| json!({"reportDate":ctx.report_date,"holdings":[]}));
    let prior_raw = positions
        .get(&ctx.prior_date)
        .cloned()
        .unwrap_or_else(|| json!({"reportDate":ctx.prior_date,"holdings":[]}));
    let current_holdings = domain::select_disclosed_holdings(
        &current_raw["holdings"],
        s(&current_report, "content"),
        10,
    );
    let prior_holdings =
        domain::select_disclosed_holdings(&prior_raw["holdings"], s(&prior_report, "content"), 10);
    let current_shares = domain::parse_fund_total_shares(s(&current_report, "content"));
    let prior_shares = if prior_report.is_null() {
        Value::Null
    } else {
        domain::parse_fund_total_shares(s(&prior_report, "content"))
    };
    let codes = array(&current_holdings)
        .iter()
        .chain(array(&prior_holdings).iter())
        .map(|v| s(v, "code").to_string())
        .collect::<BTreeSet<_>>();
    let start = days_before(&ctx.prior_date, 7)?;
    let results=stream::iter(codes.into_iter().map(|code|{let start=&start; async move{
        let params=vec![("code".into(),code.clone()),("from".into(),start.clone()),("to".into(),ctx.as_of.clone())];
        let rows=api_sources(state,"/api/kline",&params,sources).await.unwrap_or_else(|_|json!([]));
        (code,json!({"periodReturnPct":domain::return_between_klines(&rows,&ctx.prior_date,&ctx.report_date),"postReportReturnPct":domain::return_between_klines(&rows,&ctx.report_date,&ctx.as_of)}))
    }})).buffered(integer(sources,"marketConcurrency",5) as usize).collect::<Vec<_>>().await;
    let returns = Value::Object(results.into_iter().collect());
    let changes = domain::analyze_position_changes(
        &json!({"currentHoldings":current_holdings,"previousHoldings":prior_holdings,"currentFundShares":current_shares,"previousFundShares":prior_shares,"returnsByCode":returns,"actionThresholdPct":ctx.config["analysis"]["actionThresholdPct"],"assessmentThresholdPct":ctx.config["analysis"]["assessmentThresholdPct"]}),
    );
    let mut top = array(&changes)
        .into_iter()
        .filter(|v| number(&v["estimatedContributionPct"]).is_some())
        .collect::<Vec<_>>();
    top.sort_by(|a, b| {
        number(&b["estimatedContributionPct"])
            .partial_cmp(&number(&a["estimatedContributionPct"]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    top.truncate(integer(&ctx.config["analysis"], "topContributionCount", 10) as usize);
    let mut fund = item["fund"].clone();
    for key in ["manager", "company", "style"] {
        fund[key] = json!(fund_info[key].as_str().unwrap_or(""));
    }
    fund["selectedFromRawRank"] = fund["rank"].clone();
    let mut current = current_notice.clone();
    current["totalFundShares"] = current_shares;
    let mut prior = prior_notice.clone();
    if prior.is_object() {
        prior["totalFundShares"] = prior_shares;
    }
    Ok(
        json!({"schemaVersion":1,"generatedAt":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"asOf":ctx.as_of,"reportDate":ctx.report_date,"previousReportDate":ctx.prior_date,"quarter":ctx.quarter,
        "methodology":{"action":format!("持股数量/全基金总份额变动超过 ±{}% 判定加减仓",ctx.config["analysis"]["actionThresholdPct"]),"contribution":"季初与季末权重均值 × 报告期个股涨跌幅，仅为估算","assessment":format!("季末至数据截止日涨跌绝对值不足 {}% 记为中性",ctx.config["analysis"]["assessmentThresholdPct"]),"entryExitScope":"新进/退出仅指公开持仓明细，不代表首次买入或清仓"},
        "fund":fund,"reports":{"current":current,"previous":prior,"managementDiscussion":domain::extract_management_discussion(s(&current_report,"content"),integer(&ctx.config["analysis"],"managementDiscussionMaxChars",12000) as usize)},
        "positions":{"current":current_holdings,"previous":prior_holdings,"changes":changes,"topEstimatedContributors":top},
        "sources":{"fundInfo":format!("{}/api/fund/info?code={code}.OF",ctx.base_url),"fundPositions":format!("{}/api/fund/position?code={code}.OF&num=5",ctx.base_url),"klineTemplate":format!("{}/api/kline?code={{证券代码}}&from={start}&to={}",ctx.base_url,ctx.as_of),"noticeContent":format!("https://np-cnotice-fund.eastmoney.com/api/content/ann?client_source=web_fund&show_all=1&art_code={}",s(&current_notice,"id"))}}),
    )
}

fn resolve_key(state: &AppState, llm: &Value, env_name: &str) -> Result<String> {
    if !s(llm, "apiKey").trim().is_empty() {
        return Ok(s(llm, "apiKey").trim().to_string());
    }
    if !s(llm, "apiKeyFile").is_empty() {
        let raw = s(llm, "apiKeyFile");
        let home = std::env::var("HOME").unwrap_or_default();
        let path = if raw == "~" {
            PathBuf::from(home)
        } else if let Some(rest) = raw.strip_prefix("~/") {
            PathBuf::from(home).join(rest)
        } else {
            state.root.join(raw)
        };
        let credentials = read_optional(&path, Value::Null)?;
        let field = option(llm, "apiKeyField", "OPENAI_API_KEY");
        if let Some(key) = credentials[field].as_str().filter(|s| !s.trim().is_empty()) {
            return Ok(key.trim().into());
        }
    }
    [state.setting(env_name), state.setting("LLM_API_KEY")]
        .into_iter()
        .find(|s| !s.trim().is_empty())
        .context("missing fund research LLM credential")
}
async fn generate(
    state: &AppState,
    config: &Value,
    evidence: &Value,
    evidence_path: &Path,
    output: &Path,
) -> Result<String> {
    if state.setting("LLM_RUNTIME") != "local" {
        bail!("fund research model work requires LLM_RUNTIME=local");
    }
    let system = fs::read_to_string(state.root.join(s(&config["prompts"], "system")))?;
    let template = fs::read_to_string(state.root.join(s(&config["prompts"], "user")))?;
    let prompt = domain::render_prompt(
        &template,
        &json!({"EVIDENCE_PATH":path_string(evidence_path),"OUTPUT_PATH":path_string(output),"EVIDENCE_JSON":serde_json::to_string_pretty(evidence)?}),
    )?;
    let llm = &config["llm"];
    let model = state.setting("FUND_RESEARCH_LLM_MODEL");
    let model = if model.is_empty() {
        s(llm, "model").to_string()
    } else {
        model
    };
    let base = [
        state.setting("FUND_RESEARCH_LLM_BASE_URL"),
        state.setting("LLM_BASE_URL"),
        s(llm, "baseUrl").into(),
    ]
    .into_iter()
    .find(|s| !s.trim().is_empty())
    .context("fund research LLM URL missing")?;
    let env = state.setting("FUND_RESEARCH_LLM_API_KEY_ENV");
    let env = if env.is_empty() {
        s(llm, "apiKeyEnv")
    } else {
        &env
    };
    let key = resolve_key(state, llm, env)?;
    let result=taskd::direct_text_with_credential(state,&json!({"model":model,"instructions":system,"input":[{"role":"user","content":[{"type":"input_text","text":prompt}]}],"maxTokens":llm["maxOutputTokens"],"temperature":llm["temperature"]}),&base,&key).await?;
    domain::validate_generated_report(&domain::strip_markdown_fence(&result), &evidence["fund"])
}

fn update_index(
    output: &Path,
    state_dir: &Path,
    candidates: &Value,
    discoveries: &[Value],
    ctx: &ContextData,
    partial: bool,
) -> Result<(PathBuf, Value)> {
    let scope = format!("{:x}", Sha256::digest(path_string(output).as_bytes()));
    let state_path =
        state_dir
            .join("indexes")
            .join(format!("{}-{}.json", ctx.quarter, &scope[..12]));
    let previous = read_optional(&state_path, json!({"funds":[]}))?;
    let mut records = array(&previous["funds"])
        .into_iter()
        .map(|v| (s(&v, "code").to_string(), v))
        .collect::<BTreeMap<_, _>>();
    if !partial {
        let codes = array(candidates)
            .into_iter()
            .map(|v| s(&v, "code").to_string())
            .collect::<BTreeSet<_>>();
        records.retain(|k, _| codes.contains(k));
    }
    for fund in array(candidates) {
        let code = s(&fund, "code");
        let filename = domain::build_output_filename(s(&fund, "name"), code, &ctx.report_date)?;
        if !existing(&output.join(&filename)) {
            if !partial {
                records.remove(code);
            }
            continue;
        }
        let previous = records.get(code).cloned().unwrap_or_else(|| json!({}));
        let discovery = discoveries.iter().find(|v| s(&v["fund"], "code") == code);
        let published = discovery
            .and_then(|v| v["currentNotice"]["PUBLISHDATEDesc"].as_str())
            .unwrap_or_else(|| s(&previous, "reportPublishDate"))
            .to_string();
        let mut record = previous;
        deep_merge(&mut record, fund.clone());
        record["outputFilename"] = json!(filename);
        record["reportPublishDate"] = json!(published.chars().take(10).collect::<String>());
        records.insert(code.to_string(), record);
    }
    let mut funds = records.into_values().collect::<Vec<_>>();
    funds.sort_by(|a, b| {
        number(&a["rank"])
            .partial_cmp(&number(&b["rank"]))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| s(a, "code").cmp(s(b, "code")))
    });
    let index = output.join(format!("基金季度分析索引-{}.md", ctx.quarter));
    write_json(
        &state_path,
        &json!({"schemaVersion":1,"asOf":ctx.as_of,"reportDate":ctx.report_date,"quarter":ctx.quarter,"outputDir":path_string(output),"funds":funds}),
    )?;
    write_text(
        &index,
        &format!(
            "{}\n",
            domain::render_fund_index_markdown(
                &json!({"asOf":ctx.as_of,"reportDate":ctx.report_date,"quarter":ctx.quarter,"funds":funds,"holdingsStatisticsFilename":format!("基金持仓统计-{}.html",ctx.quarter)})
            )
        ),
    )?;
    Ok((index, json!(funds)))
}

pub async fn run(state: &AppState, options: &Value) -> Result<Value> {
    for key in ["limit", "concurrency"] {
        if options.get(key).is_some() && options[key].as_u64().is_none_or(|n| n == 0) {
            bail!("{key} must be a positive integer");
        }
    }
    let fund_code = s(options, "fundCode");
    if !fund_code.is_empty()
        && (fund_code.len() != 6 || !fund_code.bytes().all(|b| b.is_ascii_digit()))
    {
        bail!("fundCode must be six digits");
    }
    let config = config(state, options)?;
    let today = Utc::now()
        .with_timezone(&chrono_tz::Asia::Shanghai)
        .date_naive()
        .to_string();
    let as_of = option(options, "asOf", &today).to_string();
    date(&as_of)?;
    let report_date = if s(options, "reportDate").is_empty() {
        domain::latest_quarterly_report_date(&as_of)?
    } else {
        s(options, "reportDate").into()
    };
    let prior_date = domain::previous_report_date(&report_date)?;
    let quarter = domain::quarter_id(&report_date)?;
    let base_url = format!("http://{}", state.authority);
    let limit = integer(options, "limit", integer(&config["ranking"], "topN", 100));
    let output = state
        .root
        .join(option(options, "output", s(&config, "outputDir")));
    let state_dir = state.root.join(s(&config, "stateDir"));
    let evidence_dir = state_dir.join("evidence").join(&quarter);
    fs::create_dir_all(&output)?;
    fs::create_dir_all(&evidence_dir)?;
    let rows = api_sources(
        state,
        "/api/fund/rank",
        &[
            ("ft".into(), s(&config["ranking"], "fundType").into()),
            ("sc".into(), "3yzf".into()),
            ("st".into(), "desc".into()),
            ("sd".into(), months_before(&as_of, 3)?),
            ("ed".into(), as_of.clone()),
            ("pi".into(), "1".into()),
            ("pn".into(), limit.to_string()),
        ],
        &config["sources"],
    )
    .await?;
    let mut ranked = array(&domain::parse_fund_rank_rows(&rows["rows"]));
    ranked.truncate(limit as usize);
    let mut candidates =
        domain::dedupe_fund_share_classes(&json!(ranked), &config["ranking"]["shareClassPriority"]);
    if !fund_code.is_empty() {
        candidates = json!(
            array(&candidates)
                .into_iter()
                .filter(|f| s(f, "code") == fund_code)
                .collect::<Vec<_>>()
        );
    }
    let ctx = ContextData {
        as_of,
        report_date,
        prior_date,
        quarter,
        base_url,
        config: config.clone(),
    };
    let discoveries=stream::iter(array(&candidates).into_iter().map(|fund|{let ctx=&ctx;let output=&output;async move{
        let code=s(&fund,"code");let output_path=match domain::build_output_filename(s(&fund,"name"),code,&ctx.report_date){Ok(name)=>output.join(name),Err(error)=>return json!({"status":"failed_discovery","fund":fund,"error":error.to_string()})};
        if options["force"]!=true&&existing(&output_path){return json!({"status":"skipped_existing","fund":fund,"outputPath":path_string(&output_path)});}
        let notices=match fund_notices(state,code,&ctx.config["sources"]).await{Ok(v)=>v,Err(error)=>return json!({"status":"failed_discovery","fund":fund,"outputPath":path_string(&output_path),"error":error.to_string()})};
        let notices=json!(array(&notices).into_iter().filter(|n|{let d=s(n,"PUBLISHDATEDesc").chars().take(10).collect::<String>();!d.is_empty()&&d<=ctx.as_of}).collect::<Vec<_>>());
        let current=domain::find_fund_report_notice(&notices,code,&ctx.report_date);if current.is_null(){return json!({"status":"skipped_no_latest_report","fund":fund,"outputPath":path_string(&output_path)});}
        let previous=domain::find_fund_report_notice(&notices,code,&ctx.prior_date);json!({"status":"eligible","fund":fund,"outputPath":path_string(&output_path),"notices":notices,"currentNotice":current,"priorNotice":previous})
    }})).buffered(integer(&config["sources"],"noticeConcurrency",5) as usize).collect::<Vec<_>>().await;
    let eligible = discoveries
        .iter()
        .filter(|d| d["status"] == "eligible")
        .cloned()
        .collect::<Vec<_>>();
    let results=stream::iter(eligible.into_iter().map(|item|{let ctx=&ctx;let evidence_dir=&evidence_dir;async move{
        let process=async{let pack=evidence(state,&item,ctx).await?;let evidence_path=evidence_dir.join(format!("{}-{}.json",s(&item["fund"],"code"),ctx.quarter));write_json(&evidence_path,&pack)?;if options["dryRun"]==true{return Ok::<Value,anyhow::Error>(json!({"status":"dry_run","fund":item["fund"],"evidencePath":path_string(&evidence_path)}));}
            let output_path=PathBuf::from(s(&item,"outputPath"));let markdown=generate(state,&ctx.config,&pack,&evidence_path,&output_path).await?;write_text(&output_path,&format!("{markdown}\n"))?;Ok(json!({"status":"written","fund":item["fund"],"evidencePath":path_string(&evidence_path),"outputPath":path_string(&output_path)}))};
        match process.await{Ok(v)=>v,Err(error)=>json!({"status":"failed_analysis","fund":item["fund"],"error":error.to_string()})}
    }})).buffered(integer(options,"concurrency",integer(&config["llm"],"concurrency",5)) as usize).collect::<Vec<_>>().await;
    let mut index_path = String::new();
    let mut statistics_path = Value::Null;
    if options["dryRun"] != true {
        let (index, funds) = update_index(
            &output,
            &state_dir,
            &candidates,
            &discoveries,
            &ctx,
            !fund_code.is_empty(),
        )?;
        index_path = path_string(&index);
        let stats=statistics::update(state,&json!({"asOf":ctx.as_of,"reportDate":ctx.report_date,"reportQuarter":ctx.quarter,"baseUrl":ctx.base_url,"outputDir":path_string(&output),"evidenceDir":path_string(&evidence_dir),"stateDir":path_string(&state_dir),"funds":funds,"config":config,"force":options["force"]})).await?;
        statistics_path = stats["path"].clone();
    }
    let all = discoveries
        .into_iter()
        .filter(|d| d["status"] != "eligible")
        .chain(results)
        .collect::<Vec<_>>();
    let mut summary = BTreeMap::<String, u64>::new();
    let mut errors = vec![];
    for item in &all {
        *summary.entry(s(item, "status").into()).or_default() += 1;
        if let Some(error) = item["error"].as_str() {
            errors.push(json!({"code":item["fund"]["code"],"error":error}));
        }
    }
    Ok(
        json!({"summary":summary,"outputDir":path_string(&output),"evidenceDir":path_string(&evidence_dir),"indexPath":index_path,"holdingsStatisticsPath":statistics_path,"dryRun":options["dryRun"]==true,"results":all,"errors":errors}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates_clamp_months_and_leap_days() {
        assert_eq!(months_before("2024-05-31", 3).unwrap(), "2024-02-29");
        assert_eq!(days_before("2024-03-01", 1).unwrap(), "2024-02-29");
    }
    #[test]
    fn merge_keeps_nested_defaults_and_replaces_arrays() {
        let mut base = json!({"x":{"a":1,"b":2},"arr":[1]});
        deep_merge(&mut base, json!({"x":{"b":3},"arr":[2]}));
        assert_eq!(base, json!({"x":{"a":1,"b":3},"arr":[2]}));
    }
}

pub(super) async fn api_sources(
    state: &AppState,
    path: &str,
    params: &[(String, String)],
    sources: &Value,
) -> Result<Value> {
    let mut url = Url::parse(&format!("http://{}", state.authority))?.join(path)?;
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    let attempts = integer(sources, "requestAttempts", 3).min(100);
    for attempt in 0..attempts {
        let result = async {
            let text = state
                .http
                .text_once(
                    url.as_str(),
                    Method::GET,
                    HeaderMap::new(),
                    None,
                    integer(sources, "requestTimeoutMs", 30000),
                )
                .await?;
            let body: Value = serde_json::from_str(&text)?;
            if body["code"] != 200 {
                bail!(
                    "local API {} failed: {}",
                    path,
                    body["msg"].as_str().unwrap_or("invalid response")
                );
            }
            Ok::<Value, anyhow::Error>(body["data"].clone())
        }
        .await;
        match result {
            Ok(v) => return Ok(v),
            Err(e) if attempt + 1 == attempts => return Err(e),
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(
                    500 * 2_u64.pow(attempt.min(10) as u32),
                ))
                .await
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod workflow_tests {
    use super::*;
    use axum::{Json, Router, routing::get};
    #[tokio::test]
    async fn empty_rank_runs_without_model_and_writes_local_index_and_statistics() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir
            .path()
            .join("config/research/fund-quarterly-research.json");
        let mut config: Value = serde_json::from_slice(include_bytes!(
            "../../../config/research/fund-quarterly-research.json"
        ))
        .unwrap();
        config["outputDir"] = json!("output");
        config["stateDir"] = json!("state");
        write_json(&config_path, &config).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/api/fund/rank",
                    get(|| async { Json(json!({"code":200,"data":{"rows":[]}})) }),
                ),
            )
            .await
            .unwrap();
        });
        let db = crate::db::Database::open(dir.path().join("fixture.sqlite")).unwrap();
        let state = AppState::new(db, dir.path().into(), authority).unwrap();
        let result = run(&state, &json!({"asOf":"2026-10-29"})).await.unwrap();
        assert_eq!(result["errors"], json!([]));
        assert!(
            dir.path()
                .join("output/基金季度分析索引-2026Q3.md")
                .is_file()
        );
        assert!(dir.path().join("output/基金持仓统计-2026Q3.html").is_file());
        assert!(!result["dryRun"].as_bool().unwrap());
        server.abort();
    }
}
