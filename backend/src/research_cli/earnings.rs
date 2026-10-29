//! Earnings evidence packs: deterministic screening and artifacts, never model
//! execution. Statements retain their publication cutoffs and incomplete-quarter
//! arithmetic never invents a missing observation.
mod domain;
use super::{api, read_config, string, write_json, write_text};
use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use serde_json::{Value, json};

fn date(value: &str) -> Result<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").context("date must be YYYY-MM-DD")?;
    if parsed.to_string() != value {
        bail!("date must be YYYY-MM-DD");
    }
    Ok(parsed)
}
fn previous_quarter(as_of: &str) -> Result<String> {
    let d = date(as_of)?;
    Ok(match d.month() {
        1..=3 => format!("{}-12-31", d.year() - 1),
        4..=6 => format!("{}-03-31", d.year()),
        7..=9 => format!("{}-06-30", d.year()),
        _ => format!("{}-09-30", d.year()),
    })
}
fn positive(options: &Value, key: &str, fallback: &Value) -> Result<usize> {
    options
        .get(key)
        .unwrap_or(fallback)
        .as_u64()
        .filter(|n| *n > 0)
        .and_then(|n| usize::try_from(n).ok())
        .with_context(|| format!("{key} must be a positive integer"))
}
fn trim_date(value: &Value) -> &str {
    value.as_str().and_then(|v| v.get(..10)).unwrap_or("")
}
async fn fetch_rows(
    state: &AppState,
    report: &str,
    report_date: &str,
    from: &str,
    as_of: &str,
    page_size: usize,
) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    let mut page = 1;
    let mut pages = 1;
    while page <= pages {
        let performance = report == "RPT_FCI_PERFORMANCEE";
        let filter = if performance {
            format!(
                "(SECURITY_TYPE_CODE in (\"058001001\",\"058001008\"))(TRADE_MARKET_CODE!=\"069001017\")(REPORT_DATE='{report_date}')"
            )
        } else {
            format!("(REPORT_DATE='{report_date}')")
        };
        let params: Vec<(String, String)> = vec![
            ("reportName".into(), report.into()),
            ("columns".into(), "ALL".into()),
            ("filter".into(), filter),
            ("pageNumber".into(), page.to_string()),
            ("pageSize".into(), page_size.to_string()),
            ("sortTypes".into(), "-1,-1".into()),
            (
                "sortColumns".into(),
                if performance {
                    "UPDATE_DATE,SECURITY_CODE"
                } else {
                    "NOTICE_DATE,SECURITY_CODE"
                }
                .into(),
            ),
        ];
        let mut url = reqwest::Url::parse("https://datacenter-web.eastmoney.com/api/data/v1/get")?;
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::REFERER,
            reqwest::header::HeaderValue::from_static("https://emweb.securities.eastmoney.com/"),
        );
        let text = state
            .http
            .text_with_timeout(url.as_str(), reqwest::Method::GET, headers, None, 30_000)
            .await?;
        let body: Value = serde_json::from_str(&text)?;
        if body["success"] != true {
            bail!("eastmoney {report} failed: {}", body["message"]);
        }
        pages = body["result"]["pages"].as_u64().unwrap_or(1).max(1);
        let page_rows = body["result"]["data"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let dates = page_rows
            .iter()
            .map(|r| {
                trim_date(
                    r.get("NOTICE_DATE")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&r["UPDATE_DATE"]),
                )
            })
            .filter(|d| !d.is_empty())
            .collect::<Vec<_>>();
        let stop = !dates.is_empty()
            && dates.iter().all(|d| *d < from || *d > as_of)
            && dates.iter().any(|d| *d < from);
        rows.extend(page_rows);
        if stop {
            break;
        }
        page += 1;
    }
    Ok(rows)
}

pub async fn run(state: &AppState, options: &Value) -> Result<Value> {
    let config_path = if string(options, "config").is_empty() {
        "config/research/earnings-research.json"
    } else {
        string(options, "config")
    };
    let config = read_config(state, config_path)?;
    let today = Utc::now()
        .with_timezone(&chrono_tz::Asia::Shanghai)
        .date_naive()
        .to_string();
    let as_of = if string(options, "asOf").is_empty() {
        today
    } else {
        string(options, "asOf").to_owned()
    };
    let report_date = if string(options, "reportDate").is_empty() {
        previous_quarter(&as_of)?
    } else {
        date(string(options, "reportDate"))?;
        string(options, "reportDate").to_owned()
    };
    if !["03-31", "06-30", "09-30", "12-31"].contains(&report_date.get(5..).unwrap_or("")) {
        bail!("reportDate must be a quarter end");
    }
    let days = positive(options, "days", &config["defaultDays"])?;
    let limit = positive(options, "limit", &config["defaultLimit"])?;
    let from = date(&as_of)?
        .checked_sub_signed(Duration::days(i64::try_from(days - 1)?))
        .context("announcement window exceeds valid dates")?
        .to_string();
    let run_id = format!("{}-{}", as_of, Utc::now().format("%H%M%S"));
    let output = state.root.join(if string(options, "output").is_empty() {
        format!("data/earnings-research/{run_id}")
    } else {
        string(options, "output").to_owned()
    });
    let base_url = format!("http://{}", state.authority);
    let consensus = options["includeConsensus"] == true;
    let request = json!({"asOf":as_of,"reportDate":report_date,"fromDate":from,"days":days,"limit":limit,"baseUrl":base_url,"includeConsensus":consensus,"configVersion":config["version"]});
    let page_size = positive(&json!({}), "pageSize", &config["pageSize"])?;
    let (performance, forecast) = tokio::try_join!(
        fetch_rows(
            state,
            "RPT_FCI_PERFORMANCEE",
            &report_date,
            &from,
            &as_of,
            page_size
        ),
        fetch_rows(
            state,
            "RPT_PUBLIC_OP_NEWPREDICT",
            &report_date,
            &from,
            &as_of,
            page_size
        )
    )?;
    let future_excluded = performance
        .iter()
        .chain(&forecast)
        .filter(|r| {
            trim_date(
                r.get("NOTICE_DATE")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&r["UPDATE_DATE"]),
            ) > as_of.as_str()
        })
        .count();
    let events = domain::aggregate_events(&performance, &forecast, &as_of, &from, &report_date);
    let prioritized = domain::prioritize(
        &events,
        positive(
            &json!({}),
            "marketCandidateLimit",
            &config["marketCandidateLimit"],
        )?,
    );
    let batch_size = positive(&json!({}), "marketBatchSize", &config["marketBatchSize"])?;
    let mut market_rows = Vec::new();
    for chunk in prioritized.chunks(batch_size) {
        let codes = chunk
            .iter()
            .map(|e| format!("\"{}\"", string(e, "code")))
            .collect::<Vec<_>>()
            .join(",");
        let params = vec![("st".into(),"TOTAL_MARKET_CAP".into()),("sr".into(),"-1".into()),("ps".into(),batch_size.to_string()),("p".into(),"1".into()),("sty".into(),"SECUCODE,SECURITY_NAME_ABBR,NEW_PRICE,TOTAL_MARKET_CAP,PE9,PBNEWMRQ,NETPROFIT_YOY_RATIO,ZXGXL,ALLCORP_NUM,MAX_TRADE_DATE".into()),("filter".into(),format!("(SECUCODE in ({codes}))"))];
        let response = api(state, "/api/companies/filter", &params).await?;
        market_rows.extend(response["data"].as_array().cloned().unwrap_or_default());
    }
    let market = domain::attach_markets(&prioritized, &market_rows, &config["filters"]);
    let pool = positive(
        &json!({}),
        "analysisPoolLimit",
        &config["analysisPoolLimit"],
    )?
    .min(limit.saturating_mul(2).max(20))
    .min(market.len());
    let concurrency = positive(
        &json!({}),
        "financeConcurrency",
        &config["financeConcurrency"],
    )?;
    use futures_util::{StreamExt, stream};
    let year = date(&as_of)?.year() as i64;
    let mut analyzed = stream::iter(market.iter().take(pool).enumerate().map(
        |(index, candidate)| {
            let as_of = &as_of;
            let ranking = &config["ranking"];
            async move {
                let params = vec![("code".into(), string(candidate, "code").to_owned())];
                let (income, balance, cashflow) = tokio::try_join!(
                    api(state, "/api/finance/income", &params),
                    api(state, "/api/finance/balance", &params),
                    api(state, "/api/finance/cashflow", &params)
                )?;
                Ok::<_, anyhow::Error>((
                    index,
                    domain::analyze(
                        candidate,
                        &json!({"income":income,"balance":balance,"cashflow":cashflow}),
                        as_of,
                        year,
                        ranking,
                    ),
                ))
            }
        },
    ))
    .buffer_unordered(concurrency)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect::<Result<Vec<_>>>()?;
    analyzed.sort_by_key(|(index, _)| *index);
    let analyzed = analyzed.into_iter().map(|(_, v)| v).collect::<Vec<_>>();
    let mut selected = domain::rank(&analyzed, &config["ranking"]);
    selected.truncate(limit);
    if consensus {
        let count = positive(&json!({}), "consensusLimit", &config["consensusLimit"])?;
        for candidate in selected.iter_mut().take(count) {
            match api(
                state,
                "/api/report/forecast",
                &[("code".into(), string(candidate, "code").into())],
            )
            .await
            {
                Ok(rows) => {
                    *candidate = domain::attach_consensus(
                        candidate,
                        rows.as_array().map(Vec::as_slice).unwrap_or(&[]),
                    )
                }
                Err(error) => {
                    candidate["warnings"]
                        .as_array_mut()
                        .context("candidate warnings missing")?
                        .push(json!(format!("研报预测获取失败：{error}")));
                }
            }
        }
    }
    let mut payload = request.clone();
    let object = payload.as_object_mut().unwrap();
    object.insert("schemaVersion".into(), json!(1));
    object.insert(
        "generatedAt".into(),
        json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    object.insert("stats".into(),json!({"performanceRowsRead":performance.len(),"forecastRowsRead":forecast.len(),"futureRowsExcluded":future_excluded,"eventsEligible":events.len(),"marketCandidatesRequested":prioritized.len(),"candidatesAnalyzed":analyzed.len(),"candidatesSelected":selected.len()}));
    object.insert("candidates".into(), json!(selected));
    let evidence = render_evidence(&payload);
    let evidence_path = output.join("evidence.md");
    let recommendation_path = output.join("recommendations.md");
    let template = std::fs::read_to_string(state.root.join("prompts/earnings-recommendation.md"))?;
    let prompt = template
        .replace("{{AS_OF}}", &as_of)
        .replace("{{REPORT_DATE}}", &report_date)
        .replace("{{EVIDENCE_PATH}}", &evidence_path.to_string_lossy())
        .replace("{{OUTPUT_PATH}}", &recommendation_path.to_string_lossy())
        .replace("{{EVIDENCE}}", &evidence);
    std::fs::create_dir_all(&output)?;
    write_json(&output.join("request.json"), &request)?;
    write_json(&output.join("evidence.json"), &payload)?;
    write_text(&evidence_path, &evidence)?;
    write_text(&output.join("prompt.md"), &prompt)?;
    Ok(
        json!({"ok":true,"outputDir":output,"candidates":selected.len(),"evidencePath":evidence_path,"promptPath":output.join("prompt.md"),"recommendationsPath":recommendation_path}),
    )
}

fn n(value: &Value) -> String {
    domain::number(value)
        .map(|n| {
            let rounded = ((n * 100.0) + 0.5).floor() / 100.0;
            if rounded == 0.0 {
                "0".into()
            } else {
                ryu_js::Buffer::new().format(rounded).to_owned()
            }
        })
        .unwrap_or_else(|| "-".into())
}
fn percent(value: &Value) -> String {
    if value.is_null() {
        "-".into()
    } else {
        format!("{}%", n(value))
    }
}
fn scenario(value: &Value) -> String {
    format!(
        "{} / {} / {}",
        n(&value["bear"]),
        n(&value["base"]),
        n(&value["bull"])
    )
}
fn percent_range(low: &Value, high: &Value) -> String {
    if low.is_null() && high.is_null() {
        "-".into()
    } else if low == high || high.is_null() {
        percent(low)
    } else if low.is_null() {
        percent(high)
    } else {
        format!("{}%～{}%", n(low), n(high))
    }
}
fn range_yi(value: &Value) -> String {
    let low = domain::number(&value["lowYuan"])
        .map(|v| json!(v / 100_000_000.0))
        .unwrap_or(Value::Null);
    let high = domain::number(&value["highYuan"])
        .map(|v| json!(v / 100_000_000.0))
        .unwrap_or(Value::Null);
    if low.is_null() && high.is_null() {
        "-".into()
    } else if n(&low) == n(&high) || high.is_null() {
        n(&low)
    } else if low.is_null() {
        n(&high)
    } else {
        format!("{}～{}", n(&low), n(&high))
    }
}
fn source(item: &Value) -> &'static str {
    if item["sourceType"] == "performance_report" {
        "业绩快报"
    } else {
        "业绩预告"
    }
}
fn yoy(item: &Value) -> String {
    let text = percent_range(
        &item["trends"]["cumulativeProfitYoYLow"],
        &item["trends"]["cumulativeProfitYoYHigh"],
    );
    if item["trends"]["cumulativeProfitYoYComparable"] == true {
        text
    } else {
        format!("{text}（低基数）")
    }
}
fn growth_inputs(inputs: &Value) -> String {
    let mut parts = Vec::new();
    if !inputs["qoq"].is_null() {
        parts.push(format!(
            "环比{}×{}",
            percent(&inputs["qoq"]),
            n(&inputs["qoqWeight"])
        ));
    }
    if !inputs["yoy"].is_null() {
        parts.push(format!(
            "同比{}×{}",
            percent(&inputs["yoy"]),
            n(&inputs["yoyWeight"])
        ));
    }
    if parts.is_empty() {
        "不可计算".into()
    } else {
        parts.join(" + ")
    }
}
fn components(value: &Value) -> String {
    if value.is_null() {
        "-".into()
    } else {
        format!(
            "Forward PE {}、有效增速 {}、PE/增速 {}、扣非质量 {}",
            n(&value["forwardPe"]),
            n(&value["effectiveGrowth"]),
            n(&value["pegLike"]),
            n(&value["deductProfitQuality"])
        )
    }
}
fn penalties(value: &Value) -> String {
    if value.is_null() {
        "-".into()
    } else {
        format!(
            "单季亏损 {}、非经常性/投资收益 {}",
            n(&value["negativeSingleQuarter"]),
            n(&value["eventRisk"])
        )
    }
}
fn ratio(value: &Value) -> String {
    if value.is_null() {
        "-".into()
    } else {
        format!("{}x", n(value))
    }
}
fn render_evidence(payload: &Value) -> String {
    let candidates = payload["candidates"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut lines=vec!["# 业绩研究证据包".into(),String::new(),format!("- 数据截至：{}",string(payload,"asOf")),format!("- 报告期：{}",string(payload,"reportDate")),format!("- 最近窗口：{} 至 {}",string(payload,"fromDate"),string(payload,"asOf")),format!("- 候选数量：{}",candidates.len()),format!("- 未来公告过滤：{} 条",n(&payload["stats"]["futureRowsExcluded"])),"- 说明：候选顺序仅用于控制数据量，不代表最终推荐顺序。".into(),String::new(),"## 候选总表".into(),String::new(),"| 公司 | 来源 | 公告日 | 单季环比 | 有效增速 | 累计同比口径 | 年化利润(亿) | Forward PE | PE/有效增速 | 综合分 |".into(),"|---|---|---|---:|---:|---:|---:|---:|---:|---:|".into()];
    for item in candidates {
        lines.push(format!(
            "| {}（{}） | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            string(item, "name"),
            string(item, "code"),
            source(item),
            string(item, "noticeDate"),
            percent(&item["trends"]["singleQuarterQoQ"]),
            percent(&item["trends"]["effectiveGrowth"]),
            yoy(item),
            scenario(&item["projection"]["profitYi"]),
            scenario(&item["projection"]["pe"]),
            n(&item["projection"]["pegLike"]),
            n(&item["screening"]["score"])
        ));
    }
    for item in candidates {
        let t = &item["trends"];
        let p = &item["projection"];
        let m = &item["market"];
        let q = &item["quality"];
        let consensus = if item["consensus"].is_object() {
            format!(
                "{} 亿元，对应 PE {}；口径为{}，样本数未知",
                n(&item["consensus"]["netProfitYi"]),
                n(&item["consensus"]["pe"]),
                string(&item["consensus"], "aggregation")
            )
        } else {
            "本次未获取或无有效数据".into()
        };
        let warnings = item["warnings"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        let warnings = if warnings.is_empty() {
            "未触发规则型风险提示，仍需阅读公告原文".into()
        } else {
            warnings.join("；")
        };
        let link = format!(
            "{}/api/finance/income?code={}",
            string(payload, "baseUrl"),
            string(item, "code")
        );
        let link = if item["consensus"].is_object() {
            format!(
                "[财务数据]({link})；[研报预测]({}/api/report/forecast?code={})",
                string(payload, "baseUrl"),
                string(item, "code")
            )
        } else {
            format!("[财务数据]({link})")
        };
        lines.extend([
            String::new(),
            format!("## {}（{}）", string(item, "name"), string(item, "code")),
            String::new(),
            format!(
                "- 披露：{} {}，报告期 {}",
                string(item, "noticeDate"),
                source(item),
                string(item, "reportDate")
            ),
            format!(
                "- 归母净利润：{} 亿元；累计同比 {}（{}）",
                range_yi(&item["profit"]),
                percent_range(&t["cumulativeProfitYoYLow"], &t["cumulativeProfitYoYHigh"]),
                if t["cumulativeProfitYoYComparable"] == true {
                    "比较基数有效"
                } else {
                    "低基数或扭亏，仅作背景"
                }
            ),
            format!("- 扣非净利润：{} 亿元", range_yi(&item["deductProfit"])),
            format!("- 营业收入：{} 亿元", range_yi(&item["revenue"])),
            format!(
                "- 单季净利润：{} 亿元；同比 {}；环比 {}",
                n(&t["singleQuarterProfitYi"]),
                percent(&t["singleQuarterYoY"]),
                percent(&t["singleQuarterQoQ"])
            ),
            format!(
                "- 有效增速：{}；输入 {}；PEG-like采用增速上限 {}；PE/有效增速 {}",
                percent(&t["effectiveGrowth"]),
                growth_inputs(&t["effectiveGrowthInputs"]),
                percent(&p["pegGrowthUsed"]),
                n(&p["pegLike"])
            ),
            format!(
                "- 市值：{} 亿元；TTM PE {}；PB {}；股息率 {}",
                n(&m["marketCapYi"]),
                n(&m["peTtm"]),
                n(&m["pbMrq"]),
                percent(&m["dividendYield"])
            ),
            format!(
                "- 年化利润（悲观/基准/乐观）：{} 亿元",
                scenario(&p["profitYi"])
            ),
            format!("- Forward PE（悲观/基准/乐观）：{}", scenario(&p["pe"])),
            format!(
                "- 推演方法：{}；历史季节性样本 {}；置信度 {}",
                string(p, "method"),
                n(&p["seasonalSampleCount"]),
                match string(p, "confidence") {
                    "high" => "高",
                    "medium" => "中",
                    _ => "低",
                }
            ),
            format!(
                "- 综合筛选分：{}；分项 {}；扣分 {}",
                n(&item["screening"]["score"]),
                components(&item["screening"]["components"]),
                penalties(&item["screening"]["penalties"])
            ),
            format!(
                "- 经营现金流：{} 亿元；现金流/利润 {}；资产负债率 {}",
                n(&q["operatingCashflowYi"]),
                ratio(&q["operatingCashflowToProfit"]),
                percent(&q["debtToAssets"])
            ),
            format!(
                "- 应收账款：{} 亿元；存货：{} 亿元",
                n(&q["accountsReceivableYi"]),
                n(&q["inventoryYi"])
            ),
            format!("- 研报预测：{consensus}"),
            format!(
                "- 预告类型：{}",
                if string(item, "forecastType").is_empty() {
                    "-"
                } else {
                    string(item, "forecastType")
                }
            ),
            format!(
                "- 变动原因：{}",
                if string(item, "reason").is_empty() {
                    "未提供"
                } else {
                    string(item, "reason")
                }
            ),
            format!("- 风险提示：{warnings}"),
            format!("- 数据链接：{link}"),
        ]);
    }
    lines.extend(["","## 口径与限制","","- 预告金额保留上下限；基准值取区间中点。","- 年化利润使用最新累计披露的运行率：一季度×4、半年×2、前三季度×4/3、全年直接采用。历史季节性仅作为风险参考。","- 有效增速以单季环比为主；同比在扭亏、低基数或绝对值超过配置阈值时退出评分。","- PE/有效增速是 PEG-like 辅助指标，不等同于基于长期复合增长率的标准 PEG。","- PE 使用行情接口返回的人民币总市值除以推演归母净利润，未使用存在单位歧义的 company overview marketCapYi。","- 研报预测接口目前只返回正净利润简单平均，不提供机构数、中位数或分歧度。","- 当前接口不支持完整历史 as-of 回放，本证据包适合当前研究，不代表严格无前视回测。", ""].map(str::to_owned));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cutoff_windows_and_positive_limits_are_validated() {
        assert_eq!(previous_quarter("2026-01-01").unwrap(), "2025-12-31");
        assert_eq!(previous_quarter("2026-10-29").unwrap(), "2026-09-30");
        assert!(previous_quarter("2026-99-01").is_err());
        assert!(positive(&json!({"limit":0}), "limit", &json!(20)).is_err());
        assert_eq!(positive(&json!({}), "limit", &json!(20)).unwrap(), 20);
    }
    #[test]
    fn original_node_render_goldens_match_all_scenarios() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("earnings/domain-goldens.json")).unwrap();
        for (index, case) in cases.iter().enumerate() {
            assert_eq!(
                render_evidence(&case["payload"]),
                case["expectedMarkdown"].as_str().unwrap(),
                "markdown {index}"
            );
        }
    }
    #[test]
    fn empty_evidence_keeps_explicit_research_limits() {
        let rendered = render_evidence(
            &json!({"asOf":"2026-10-29","reportDate":"2026-09-30","fromDate":"2026-09-30","candidates":[],"stats":{"futureRowsExcluded":3}}),
        );
        assert!(rendered.contains("- 未来公告过滤：3 条"));
        assert!(rendered.contains("不代表严格无前视回测"));
        assert!(rendered.ends_with('\n'));
    }
}
