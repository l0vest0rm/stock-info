use super::point_in_time;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::sync::LazyLock;

static PRICE_DATE_SHAPE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap());

fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn n(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}
fn positive(value: &Value) -> Option<f64> {
    n(value).filter(|n| *n > 0.0)
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn timestamp() -> i64 {
    Utc::now().timestamp_millis()
}
fn iso(now: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn date_ms(value: &str) -> Option<i64> {
    point_in_time::date(value).map(|date| {
        date.and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis()
    })
}
fn age(date: &Value, now: i64) -> f64 {
    date_ms(s(date))
        .map(|date| (now - date) as f64 / 86_400_000.0)
        .unwrap_or(f64::INFINITY)
}
fn fresh(date: &Value, days: f64, now: i64) -> bool {
    let age = age(date, now);
    age.is_finite() && age >= -1.0 && age <= days
}
// ECMAScript toFixed rounds the exact binary value, with ties away from zero.
// Rust's precision formatting instead uses ties-to-even (e.g. 1.125 -> 1.12).
fn fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return value.to_string();
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1_u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1_u64 << 52 };
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let scaled = u128::from(mantissa) * 10_u128.pow(digits);
    let rounded = if shift >= 0 {
        scaled << shift as u32
    } else if -shift >= 128 {
        0
    } else {
        let divisor = 1_u128 << (-shift as u32);
        scaled / divisor + u128::from(scaled % divisor >= divisor / 2)
    };
    let sign = if value < 0.0 { "-" } else { "" };
    let factor = 10_u128.pow(digits);
    if digits == 0 {
        format!("{sign}{rounded}")
    } else {
        format!(
            "{sign}{}.{:0width$}",
            rounded / factor,
            rounded % factor,
            width = digits as usize
        )
    }
}
fn pct(value: f64) -> String {
    format!("{}%", fixed(value * 100.0, 1))
}
pub fn price_metrics(bars: &[Value], policy: &Value, now: i64) -> Value {
    let mut result = json!({"source":"xueqiu","adjustment":"qfq","asOf":null,"samples":0,"returns":[{"sessions":20,"value":null},{"sessions":60,"value":null},{"sessions":120,"value":null}],"drawdown252":null,"reason":null});
    let mut rows = bars.iter().collect::<Vec<_>>();
    rows.sort_by(|a, b| s(&a["date"]).cmp(s(&b["date"])));
    let rows = &rows[rows.len().saturating_sub(253)..];
    result["asOf"] = rows
        .last()
        .map(|row| row["date"].clone())
        .unwrap_or(Value::Null);
    result["samples"] = json!(rows.len());
    let mut dates = std::collections::HashSet::new();
    if rows.is_empty()
        || rows.iter().any(|bar| {
            !PRICE_DATE_SHAPE.is_match(s(&bar["date"]))
                || bar["source"] != "xueqiu"
                || !matches!(s(&bar["fq"]), "qfq" | "before")
                || positive(&bar["close"]).is_none()
                || !dates.insert(s(&bar["date"]))
        })
    {
        result["reason"] =
            json!("缺少有效雪球前复权价格，或存在缺值/重复日期；不使用未复权跌幅替代。");
        return result;
    }
    if !fresh(
        &result["asOf"],
        n(&policy["maxQuoteAgeDays"]).unwrap_or(f64::NAN),
        now,
    ) {
        result["reason"] = json!("前复权行情日期缺失、过期或未来日期。");
        return result;
    }
    let last = rows.last().unwrap();
    let last_time = date_ms(s(&last["date"])).unwrap_or(0);
    for (index, sessions) in [20, 60, 120].into_iter().enumerate() {
        if let Some(start) = rows
            .len()
            .checked_sub(1 + sessions)
            .and_then(|index| rows.get(index))
            && age(&start["date"], last_time) <= sessions as f64 * 2.2
        {
            result["returns"][index]["value"] =
                json!(n(&last["close"]).unwrap() / n(&start["close"]).unwrap() - 1.0);
        }
    }
    let window = &rows[rows.len().saturating_sub(252)..];
    if window.len() == 252 && age(&window[0]["date"], last_time) <= 550.0 {
        let max = window
            .iter()
            .map(|row| n(&row["close"]).unwrap())
            .fold(f64::NEG_INFINITY, f64::max);
        result["drawdown252"] = json!(n(&last["close"]).unwrap() / max - 1.0);
    }
    if array(&result["returns"])
        .iter()
        .any(|reading| reading["value"].is_null())
        || result["drawdown252"].is_null()
    {
        result["reason"] = json!("部分窗口不足或交易日期跨度异常；缺失窗口不按零收益处理。");
    }
    result
}

fn metric(
    key: &str,
    label: &str,
    value: Option<f64>,
    period: &str,
    source: &str,
    unit: &str,
) -> Value {
    json!({"key":key,"label":label,"value":value.filter(|n|n.is_finite()),"unit":unit,"period":period,"source":source})
}
fn fallback_text<'a>(value: &'a Value, fallback: &'a str) -> &'a str {
    if value.is_null() { fallback } else { s(value) }
}
fn prior_quarter(value: &str) -> Option<String> {
    let ends = ["03-31", "06-30", "09-30", "12-31"];
    let index = ends.iter().position(|end| Some(*end) == value.get(5..))?;
    let year = value.get(..4)?.parse::<i32>().ok()?;
    Some(if index == 0 {
        format!("{}-12-31", year - 1)
    } else {
        format!("{year}-{}", ends[index - 1])
    })
}
fn shift_year(value: &str, delta: i32) -> Option<String> {
    let year = value.get(..4)?.parse::<i32>().ok()?;
    Some(format!("{}{}", year + delta, value.get(4..)?))
}
fn seasonal_metric(
    points: &[&Value],
    latest: &Value,
    prior: Option<&str>,
    key: &str,
    current: Option<f64>,
    policy: &Value,
) -> Value {
    let mut samples = Vec::new();
    if let Some(prior) = prior {
        let lookback = policy["seasonality"]["lookbackYears"].as_u64().unwrap_or(0);
        for offset in 1..=lookback {
            let Some(end) = shift_year(s(&latest["reportDate"]), -(offset as i32)) else {
                continue;
            };
            let Some(begin) = shift_year(prior, -(offset as i32)) else {
                continue;
            };
            let a = points
                .iter()
                .filter(|q| s(&q["reportDate"]) == end)
                .collect::<Vec<_>>();
            let b = points
                .iter()
                .filter(|q| s(&q["reportDate"]) == begin)
                .collect::<Vec<_>>();
            if a.len() != 1
                || b.len() != 1
                || a[0]["provisional"] == true
                || b[0]["provisional"] == true
            {
                continue;
            }
            if let Some((a, b)) = positive(&a[0][key]).zip(positive(&b[0][key])) {
                let value = a / b - 1.0;
                if value.is_finite() {
                    samples.push(json!({"period":format!("{begin}至{end}"),"value":value}));
                }
            }
        }
    }
    let mut sorted = samples
        .iter()
        .filter_map(|sample| n(&sample["value"]))
        .collect::<Vec<_>>();
    sorted.sort_by(f64::total_cmp);
    let median = if sorted.is_empty() {
        None
    } else if sorted.len() % 2 == 1 {
        Some(sorted[sorted.len() / 2])
    } else {
        Some((sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2.0)
    };
    json!({"current":current,"median":median,"samples":samples})
}

pub fn opportunity(input: &Value) -> Value {
    let a = &input["assessment"];
    let p = &input["policy"];
    let now = input["now"].as_i64().unwrap_or_else(timestamp);
    let price = price_metrics(array(&input["adjustedBars"]), p, now);
    let mut points = array(&input["points"]).iter().collect::<Vec<_>>();
    points.sort_by(|a, b| s(&b["reportDate"]).cmp(s(&a["reportDate"])));
    let latest = points.first().copied().unwrap_or(&Value::Null);
    let prior_date = prior_quarter(s(&latest["reportDate"]));
    let previous = points
        .iter()
        .find(|q| Some(s(&q["reportDate"])) == prior_date.as_deref())
        .copied()
        .unwrap_or(&Value::Null);
    let qoq = |key: &str| -> Option<f64> {
        if latest.is_null()
            || previous.is_null()
            || points
                .iter()
                .filter(|q| q["reportDate"] == latest["reportDate"])
                .count()
                != 1
            || points
                .iter()
                .filter(|q| q["reportDate"] == previous["reportDate"])
                .count()
                != 1
            || latest["provisional"] == true
            || previous["provisional"] == true
        {
            return None;
        }
        n(&latest[key])
            .zip(positive(&previous[key]))
            .map(|(latest, previous)| latest / previous - 1.0)
            .filter(|v| v.is_finite())
    };
    let revenue_qoq = qoq("quarterRevenue");
    let profit_qoq = qoq("quarterNetProfit");
    let qoq_period = (!previous.is_null() && !latest.is_null()).then(|| {
        format!(
            "{}至{}",
            s(&previous["reportDate"]),
            s(&latest["reportDate"])
        )
    });
    let revenue = seasonal_metric(
        &points,
        latest,
        prior_date.as_deref(),
        "quarterRevenue",
        revenue_qoq,
        p,
    );
    let profit = seasonal_metric(
        &points,
        latest,
        prior_date.as_deref(),
        "quarterNetProfit",
        profit_qoq,
        p,
    );
    let readings = [&revenue, &profit];
    let missing = readings.iter().any(|r| r["current"].is_null());
    let declining = readings
        .iter()
        .filter(|r| n(&r["current"]).is_some_and(|n| n < 0.0))
        .collect::<Vec<_>>();
    let covered = declining.iter().all(|r| {
        array(&r["samples"]).len()
            >= p["seasonality"]["minimumSamples"]
                .as_u64()
                .unwrap_or(u64::MAX) as usize
    });
    let consistent = positive(&latest["quarterRevenue"]).is_some()
        && positive(&latest["quarterNetProfit"]).is_some()
        && declining.iter().all(|r| {
            array(&r["samples"])
                .iter()
                .all(|sample| n(&sample["value"]).is_some_and(|v| v < 0.0))
                && n(&r["current"])
                    .zip(n(&r["median"]))
                    .is_some_and(|(current, median)| {
                        current + 1e-12
                            >= median - n(&p["seasonality"]["tolerance"]).unwrap_or(f64::NAN)
                    })
        });
    let (seasonal_state, seasonal_reason) = if missing {
        (
            "insufficient_data",
            "正式相邻单季缺失或基数非正，不能比较环比。",
        )
    } else if declining.is_empty() {
        (
            "non_declining",
            "最新单季营收和利润环比均未下降；不代表增长加速。",
        )
    } else if !covered {
        (
            "insufficient_data",
            "下降指标缺少至少两年同季度转换样本，保留待核查。",
        )
    } else if consistent {
        (
            "consistent",
            "下降指标与历史同季度转换一致，未弱于历史中位数超过政策容忍值；仅量化初筛，不是季节性因果证明。",
        )
    } else {
        (
            "review",
            "环比下降不符合稳定历史模式或明显弱于历史中位数，需核查需求、交付及一次性因素。",
        )
    };
    let seasonality =
        json!({"revenue":revenue,"profit":profit,"state":seasonal_state,"reason":seasonal_reason});
    let qoq_review = matches!(seasonal_state, "review" | "insufficient_data");
    let archetype = s(&input["archetype"]);
    let financial = matches!(
        archetype,
        "bank" | "insurer" | "broker" | "property_operator"
    );
    let cyclical = archetype == "cyclical_commodity";
    let two_year_date = shift_year(s(&latest["reportDate"]), -2).unwrap_or_default();
    let prior2y = points
        .iter()
        .find(|q| s(&q["reportDate"]) == two_year_date)
        .copied()
        .unwrap_or(&Value::Null);
    let cagr = positive(&latest["ttmNetProfit"])
        .zip(positive(&prior2y["ttmNetProfit"]))
        .map(|(latest, prior)| (latest / prior).sqrt() - 1.0);
    let cash_conversion = if !financial && input["cashflowReportDate"] == latest["reportDate"] {
        n(&input["cashflowTtm"])
            .zip(positive(&latest["ttmNetProfit"]))
            .map(|(cash, profit)| cash / profit)
    } else {
        None
    };
    let history = array(&a["history"]["windows"]);
    let comparable_history = (!s(&a["method"]).is_empty()).then(|| {
        a["history"]["metric"] == "PE(TTM)"
            && s(&a["method"]).starts_with("PE(TTM)")
            && !financial
            && !cyclical
    });
    let hist3 = history
        .iter()
        .find(|w| w["years"] == 3)
        .and_then(|w| n(&w["percentile"]));
    let hist5 = history
        .iter()
        .find(|w| w["years"] == 5)
        .and_then(|w| n(&w["percentile"]));
    let hist_state = if comparable_history == Some(false) {
        "not_applicable"
    } else if comparable_history.is_none() || hist3.is_none() || hist5.is_none() {
        "insufficient_data"
    } else if hist3.unwrap() <= n(&p["historyPercentileMax"]).unwrap_or(f64::NAN)
        && hist5.unwrap() <= n(&p["historyPercentileMax"]).unwrap_or(f64::NAN)
    {
        "triggered"
    } else {
        "not_triggered"
    };
    let hist_summary = if comparable_history == Some(false) {
        "当前主方法不适用PE历史折价；不以辅助PE替代行业估值。".to_string()
    } else if hist3.is_none() || hist5.is_none() {
        "3年与5年历史窗口尚未同时覆盖。".into()
    } else {
        format!(
            "3年分位 {}，5年分位 {}；双窗口阈值 {}。",
            pct(hist3.unwrap()),
            pct(hist5.unwrap()),
            pct(n(&p["historyPercentileMax"]).unwrap_or(f64::NAN))
        )
    };
    let history_signal = json!({"kind":"historical_discount","group":"price","state":hist_state,"summary":hist_summary,
        "metrics":[metric("percentile3y","3年PE分位",hist3,"3年","雪球市值＋披露时点财报","ratio"),metric("percentile5y","5年PE分位",hist5,"5年","雪球市值＋披露时点财报","ratio")],"limitations":["历史便宜不等于内在低估；需复核增长中枢、竞争力及估值制度是否改变。"]});
    let quarter_count = p["earningsQuarters"].as_u64().unwrap_or(0) as usize;
    let quarters = &points[..points.len().min(quarter_count)];
    let consecutive = quarters.len() == quarter_count
        && quarters.windows(2).all(|pair| {
            let parse = |row: &Value| {
                let date = s(&row["reportDate"]);
                Some(
                    date.get(..4)?.parse::<i32>().ok()? * 12
                        + date.get(5..7)?.parse::<i32>().ok()?,
                )
            };
            parse(pair[0])
                .zip(parse(pair[1]))
                .is_some_and(|(later, earlier)| later - earlier == 3)
        });
    let ttm_growth = n(&a["operating"]["ttmGrowth"]);
    let quarterly_covered = consecutive
        && quarters.iter().all(|q| {
            n(&q["revenueYoY"]).is_some()
                && n(&q["netProfitYoY"]).is_some()
                && q["provisional"] != true
        })
        && ttm_growth.is_some();
    let earnings_state = if financial || cyclical {
        "not_applicable"
    } else if !quarterly_covered {
        "insufficient_data"
    } else if ttm_growth.unwrap() >= n(&p["ttmGrowthMin"]).unwrap_or(f64::NAN)
        && quarters.iter().all(|q| {
            n(&q["revenueYoY"]).unwrap() >= n(&p["quarterRevenueGrowthMin"]).unwrap_or(f64::NAN)
                && n(&q["netProfitYoY"]).unwrap()
                    >= n(&p["quarterProfitGrowthMin"]).unwrap_or(f64::NAN)
        })
    {
        "triggered"
    } else {
        "not_triggered"
    };
    let earnings_summary = if financial || cyclical {
        "此商业模式需专用正常化盈利/行业指标，不套用通用增长规则。".into()
    } else if !quarterly_covered {
        "缺少连续两个正式单季同比或TTM同比；不将半年报或预告冒充单季。".into()
    } else {
        format!(
            "TTM利润同比 {}；核查连续{quarter_count}季营收≥{}、利润≥{}。",
            pct(ttm_growth.unwrap()),
            pct(n(&p["quarterRevenueGrowthMin"]).unwrap_or(f64::NAN)),
            pct(n(&p["quarterProfitGrowthMin"]).unwrap_or(f64::NAN))
        )
    };
    let mut earnings_metrics = vec![
        metric(
            "revenueQoQ",
            "单季营收环比",
            revenue_qoq,
            qoq_period.as_deref().unwrap_or("未覆盖"),
            "已披露财报",
            "ratio",
        ),
        metric(
            "profitQoQ",
            "单季利润环比",
            profit_qoq,
            qoq_period.as_deref().unwrap_or("未覆盖"),
            "已披露财报",
            "ratio",
        ),
    ];
    for q in quarters {
        let date = s(&q["reportDate"]);
        earnings_metrics.push(metric(
            &format!("revenueYoY-{date}"),
            "单季营收同比",
            n(&q["revenueYoY"]),
            date,
            "已披露财报",
            "ratio",
        ));
        earnings_metrics.push(metric(
            &format!("profitYoY-{date}"),
            "单季利润同比",
            n(&q["netProfitYoY"]),
            date,
            "已披露财报",
            "ratio",
        ));
    }
    earnings_metrics.extend([
        metric(
            "ttmGrowth",
            "TTM利润同比",
            ttm_growth,
            fallback_text(&latest["reportDate"], "—"),
            "已披露财报",
            "ratio",
        ),
        metric(
            "profitCagr2y",
            "TTM利润两年复合增长",
            cagr,
            &format!(
                "{two_year_date}至{}",
                fallback_text(&latest["reportDate"], "—")
            ),
            "已披露财报",
            "ratio",
        ),
        metric(
            "valuation",
            fallback_text(&a["method"], "当前估值"),
            n(&a["current"]).map(|v| if a["unit"] == "percent" { v / 100.0 } else { v }),
            fallback_text(&a["quote"]["date"], "—"),
            fallback_text(&a["quote"]["source"], "—"),
            if a["unit"] == "percent" {
                "ratio"
            } else {
                "multiple"
            },
        ),
    ]);
    let earnings_signal = json!({"kind":"earnings_delivery","group":"earnings","state":earnings_state,"summary":earnings_summary,"metrics":earnings_metrics,
        "limitations":[seasonal_reason,"环比按单季值/上季单季值−1计算；上季非正不计算百分比，累计数和TTM不替代单季。","增长不是超预期；尚无财报发布前预期快照，不声称价格尚未反映。","总利润增长不等于摊薄EPS增长；需核查低基数、非经常损益及股本变化。不以PE小于增速判定低估。"]});
    let returns_triggered = array(&price["returns"]).iter().any(|r| {
        n(&r["value"])
            .zip(n(&p["returns"][r["sessions"].to_string()]))
            .is_some_and(|(value, threshold)| value <= threshold)
    });
    let all_price_covered = array(&price["returns"])
        .iter()
        .all(|r| n(&r["value"]).is_some())
        && n(&price["drawdown252"]).is_some();
    let drawdown_state = if returns_triggered
        || n(&price["drawdown252"])
            .zip(n(&p["drawdown252Max"]))
            .is_some_and(|(value, threshold)| value <= threshold)
    {
        "triggered"
    } else if all_price_covered {
        "not_triggered"
    } else {
        "insufficient_data"
    };
    let mut drawdown_metrics = array(&price["returns"])
        .iter()
        .map(|r| {
            let sessions = r["sessions"].to_string();
            metric(
                &format!("return{sessions}"),
                &format!("{sessions}交易日涨跌"),
                n(&r["value"]),
                &format!("{sessions}交易日截至{}", fallback_text(&price["asOf"], "—")),
                "雪球前复权",
                "ratio",
            )
        })
        .collect::<Vec<_>>();
    drawdown_metrics.push(metric(
        "drawdown252",
        "距252交易日最高收盘价",
        n(&price["drawdown252"]),
        &format!("252交易日截至{}", fallback_text(&price["asOf"], "—")),
        "雪球前复权",
        "ratio",
    ));
    let drawdown_signal = json!({"kind":"drawdown","group":"price","state":drawdown_state,"summary":"前复权回撤只触发研究，不证明错杀；需对照盈利变化及下跌原因。","metrics":drawdown_metrics,"limitations":[fallback_text(&price["reason"],"前复权由数据源处理公司行动；不是经审计的总回报序列。"),"行业相对收益、异常波动与同期盈利预测下修尚未覆盖。"]});
    let mut forward_signal = json!({"kind":"forward_gap","state":"insufficient_data","group":"expectations","summary":"未覆盖：机构预测参考尚未转化为经核验的未来估值情景与当前价格隐含预期。","metrics":[],"limitations":["需预测来源、发布日期、基准EPS、预测期间、币种/稀释口径、增长/利润率/再投资及悲观/基准/乐观情景。","搜索结果不能直接当作预测事实；接入前保持留空，不用历史增长外推替代。"]});
    let future = if input["forward"]["model"]["status"] == "available"
        && input["forward"]["priceDate"] == a["quote"]["date"]
    {
        input["forward"].clone()
    } else {
        Value::Null
    };
    if !future.is_null() {
        let base = array(&future["model"]["scenarios"])
            .iter()
            .find(|v| v["name"] == "base")
            .unwrap_or(&Value::Null);
        forward_signal["state"] = json!(if n(&base["margin"]).is_some_and(|v| v > 0.0) {
            "triggered"
        } else {
            "not_triggered"
        });
        forward_signal["summary"] =
            json!("已复核人工情景相对价格的折价线索；不是一致预期或已证明的市场错误。");
        forward_signal["metrics"] = json!([
            metric(
                "impliedGrowth",
                "达到要求回报所需利润增长",
                n(&future["model"]["impliedGrowth"]),
                s(&future["profitPeriod"]),
                &format!("已保存人工假设 v{}", future["researchVersion"]),
                "ratio"
            ),
            metric(
                "baseMargin",
                "基准情景现值折价",
                n(&base["margin"]),
                s(&future["priceDate"]),
                "有来源的盈利/市值与人工情景",
                "ratio"
            )
        ]);
        forward_signal["limitations"] = future["model"]["caveats"].clone();
    }
    let data_errors = array(&input["blockReasons"])
        .iter()
        .filter(|r| {
            !matches!(
                s(r),
                "earnings_shrinking" | "no_available_band" | "no_market_cap_band"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let data_fail = a.is_null()
        || !data_errors.is_empty()
        || !fresh(
            &a["quote"]["date"],
            n(&p["maxQuoteAgeDays"]).unwrap_or(f64::NAN),
            now,
        )
        || !fresh(
            &latest["reportDate"],
            n(&p["maxFinancialAgeDays"]).unwrap_or(f64::NAN),
            now,
        );
    let mut data_reasons = vec![json!(if data_fail {
        "关键行情/财报缺失、失败、过期或口径不一致，停止升级研究候选。"
    } else {
        "行情与最新财报通过基础时效检查；不代表全部质量指标覆盖。"
    })];
    if data_fail {
        data_reasons.extend(data_errors);
    }
    let data_gate =
        json!({"key":"data","state":if data_fail{"fail"}else{"pass"},"reasons":data_reasons});
    let mut business_state = "unknown";
    let mut business_reasons = Vec::<Value>::new();
    if financial || cyclical {
        business_reasons.push(json!(
            "需要行业专用盈利质量、资本约束或完整周期验证；通用现金利润比不作通过依据。"
        ));
    } else if archetype == "pre_profit_milestone" {
        business_reasons.push(json!(
            "里程碑型公司需要现金生存期、融资与事件成功概率验证；不套用成熟企业质量门。"
        ));
    } else if latest["provisional"] == true {
        business_reasons.push(json!("最新读数含预告/快报，等待正式披露。"));
    } else if array(&input["blockReasons"])
        .iter()
        .any(|r| r == "earnings_shrinking")
        || ttm_growth.is_some_and(|v| v < 0.0)
        || cash_conversion.is_some_and(|v| v < 0.0)
    {
        business_state = "fail";
        business_reasons.push(json!(
            "存在利润收缩或经营现金净流出，优先核查风险，不凭便宜升级候选。"
        ));
    } else if cash_conversion.is_none()
        || ttm_growth.is_none()
        || cagr.is_none()
        || n(&latest["revenueYoY"]).is_none()
        || n(&input["debtRatio"]).is_none()
        || !fresh(
            &input["balanceReportDate"],
            n(&p["maxFinancialAgeDays"]).unwrap_or(f64::NAN),
            now,
        )
    {
        business_reasons.push(json!(
            "现金转化、两年利润、营收或负债数据未完整覆盖；缺失不视为通过。"
        ));
    } else if cash_conversion.is_some_and(|v| v < n(&p["cashConversionMin"]).unwrap_or(f64::NAN))
        || cagr.is_some_and(|v| v < 0.0)
        || n(&latest["revenueYoY"]).unwrap() < 0.0
        || n(&input["debtRatio"]).unwrap() > n(&p["debtRatioReviewAbove"]).unwrap_or(f64::NAN)
    {
        business_reasons.push(json!(
            "现金转化、低基数或负债筛查需进一步复核，暂不升级候选。"
        ));
    } else if qoq_review {
        business_reasons.push(json!(seasonal_reason));
    } else {
        business_state = "pass";
        business_reasons.push(json!("营收、两年利润、同期间现金转化、负债率与最新单季环比/历史季节性比较通过量化初筛；护城河、扣非及股本稀释仍待人工验证。"));
    }
    if !input["industry"].is_null() {
        if input["industry"]["state"] == "fail" {
            business_state = "fail";
            let labels = array(&input["industry"]["checks"])
                .iter()
                .filter(|c| c["state"] == "fail")
                .map(|c| s(&c["label"]))
                .collect::<Vec<_>>()
                .join("、");
            business_reasons.push(json!(format!("行业专用质量指标未通过：{labels}")));
        } else if input["industry"]["state"] == "unknown" && business_state == "pass" {
            business_state = "unknown";
            business_reasons.push(json!(
                "行业专用质量证据未完整覆盖；通用初筛通过不替代行业验证。"
            ));
        } else if input["industry"]["state"] == "pass"
            && business_state != "fail"
            && (financial || cyclical || archetype == "pre_profit_milestone")
        {
            business_state = "pass";
            business_reasons = vec![json!(
                "有日期和来源的行业专用质量检查通过；不是公司论点或交易许可。"
            )];
        }
    }
    if input["thesisReview"]["status"] == "invalidated" {
        business_state = "fail";
        business_reasons.push(json!("人工论点已失效，不能因旧量化线索自动恢复候选。"));
    }
    let next_review = s(&input["thesisReview"]["nextReview"]);
    let today = iso(now)[..10].to_string();
    let review_time = date_ms(next_review).or_else(|| {
        DateTime::parse_from_rfc3339(next_review)
            .ok()
            .map(|date| date.timestamp_millis())
    });
    let review_due = input["thesisReview"]["status"] == "reviewed"
        && (next_review.is_empty()
            || review_time
                .zip(date_ms(&today))
                .is_some_and(|(review, today)| review < today));
    if review_due && business_state == "pass" {
        business_state = "unknown";
        business_reasons.push(json!("论点验证节点已到期，等待新证据复核。"));
    }
    let business_gate = json!({"key":"business","state":business_state,"reasons":business_reasons});
    let valuation_unknown = a.is_null() || a["status"] == "unknown";
    let valuation_pass = matches!(s(&a["status"]), "undervalued" | "fair_low" | "fair");
    let valuation_gate = json!({"key":"valuation","state":if valuation_unknown{"unknown"}else if valuation_pass{"pass"}else{"fail"},"reasons":[if valuation_unknown{"没有适用且可计算的主方法区间。"}else if valuation_pass{"价格未超过现有主方法规则区间上限；这不是公司专属内在价值认证。"}else{"当前定价高于规则区间；即使触发增长/回撤线索，也不直接升级候选。"}]});
    let gates = vec![data_gate, business_gate, valuation_gate];
    let signals = vec![
        history_signal,
        earnings_signal,
        forward_signal,
        drawdown_signal,
    ];
    let triggered = signals.iter().any(|signal| signal["state"] == "triggered");
    let stage = if data_fail {
        "insufficient_data"
    } else if business_state == "fail" {
        "blocked"
    } else if triggered {
        if gates.iter().all(|gate| gate["state"] == "pass") {
            "research_candidate"
        } else {
            "clue"
        }
    } else if signals
        .iter()
        .filter(|signal| signal["kind"] != "forward_gap")
        .all(|signal| matches!(s(&signal["state"]), "not_applicable" | "insufficient_data"))
    {
        "insufficient_data"
    } else {
        "no_signal"
    };
    let path = if financial {
        "financial"
    } else if cyclical {
        "cyclical"
    } else if archetype == "pre_profit_milestone" {
        "milestone"
    } else if matches!(archetype, "stable_cash_dividend" | "exchange") {
        "cash_return"
    } else {
        "growth"
    };
    let (path_label, evidence) = match path {
        "cash_return" => (
            "现金回报",
            vec![
                "核对维护性资本开支后的自由现金流和分红覆盖。",
                "核对债务到期、利息负担及分红承诺，不用高股息代替可持续性。",
            ],
        ),
        "cyclical" => (
            "周期研究（非反转认定）",
            vec![
                "核对价格、库存、供需及新增产能，记录周期位置证据。",
                "使用与当前业务规模可比的中周期利润，并验证低谷现金生存能力。",
            ],
        ),
        "financial" => (
            "行业专用质量核查",
            vec![
                if archetype == "bank" {
                    "核对资产质量、拨备、净息差及核心资本充足率。"
                } else if archetype == "insurer" {
                    "核对偿付能力、新业务价值、内含价值假设及投资风险。"
                } else {
                    "核对行业专用资本约束、资产质量和可分配现金流。"
                },
                "专用指标未接入，不以通用增长与现金利润比自动通过。",
            ],
        ),
        "milestone" => (
            "里程碑与现金生存",
            vec![
                "核对现金消耗、融资稀释、关键审批/交付节点及失败情景。",
                "未建立有来源的成功概率与风险调整估值前，不以营收增长代替盈利验证。",
            ],
        ),
        _ => (
            "优质成长",
            vec![
                "核对有机收入、扣非利润与摊薄EPS，而非只看总利润。",
                "核对增量资本回报、应收/存货与现金转化，解释增长所需再投资。",
            ],
        ),
    };
    let queue = if data_fail {
        "repair_data"
    } else if business_state == "fail" {
        "review_risk"
    } else if triggered {
        "verify_thesis"
    } else {
        "monitor"
    };
    let next_action = match queue {
        "repair_data" => "先修复数据与口径；数据失败不等于公司经营恶化。",
        "review_risk" => "优先复核利润/现金流风险，记录是否推翻原论点。",
        "verify_thesis" => "验证市场担忧、价格隐含假设和反证；量化候选不是已验证投资论点。",
        _ => "等待新披露或经营/估值触发，不为填满候选而降低门槛。",
    };
    let workflow = json!({"path":path,"pathLabel":path_label,"queue":queue,"nextAction":next_action,"requiredEvidence":evidence,"thesisStatus":if input["thesisReview"]["status"]=="invalidated"{"invalidated"}else if review_due{"review_due"}else if input["thesisReview"]["status"]=="reviewed"{"reviewed"}else{"not_verified"}});
    let mut next_checks = vec!["核查下一期正式财报的收入、扣非利润、现金回款和摊薄EPS。"];
    if drawdown_state == "triggered" {
        next_checks.push("核查下跌期间公司公告、行业变化及盈利预测是否同步下修。");
    }
    next_checks.push("核查应收/存货、债务到期、资本开支与竞争地位；记录来源和日期。");
    let mut result = json!({"seasonality":seasonality,"workflow":workflow,"policyVersion":p["version"],"computedAt":iso(now),"stage":stage,"confidence":if stage=="research_candidate"{"medium"}else{"low"},"signals":signals,"gates":gates,"price":price,
        "quality":{"revenueQoQ":revenue_qoq,"profitQoQ":profit_qoq,"qoqPeriod":qoq_period,"revenueYoY":latest["revenueYoY"],"profitYoY":latest["netProfitYoY"],"ttmGrowth":ttm_growth,"profitCagr2y":cagr,"cashConversion":cash_conversion,"debtRatio":input["debtRatio"],"cashflowReportDate":input["cashflowReportDate"],"balanceReportDate":input["balanceReportDate"]},
        "review":{"marketConcern":"尚未核验市场为何给予当前定价；不能从下跌反推利空原因。","alternativeView":if triggered{"已发现可量化线索；经营是否稳定、市场是否过度悲观仍待一手证据验证。"}else{"目前没有足够证据形成与市场不同的判断。"},"nextChecks":next_checks,"invalidation":["盈利或现金回款持续恶化，或发现一次性收益/稀释主导增长。","历史估值所依赖的业务结构、资本成本或竞争优势已改变。","行情/报表过期、币种不一致、关键证据不能复核时撤销候选状态。"]},
        "caveats":["历史折价与回撤都含价格因素；四类线索不按命中数累加评分。","所有通过均为量化研究初筛，不是买入、换仓或仓位建议。","阈值是版本化研究政策，尚未证明能预测收益；未做无幸存者偏差的样本外回测。"],"future":future,"executable":false});
    if let Some(industry) = input.get("industry") {
        result["industry"] = industry.clone();
    }
    result
}

pub fn normalize_currency(value: &Value) -> Option<&'static str> {
    match s(value).trim().to_uppercase().as_str() {
        "CNY" | "RMB" | "人民币" | "人民幣" => Some("CNY"),
        "HKD" | "港元" | "港币" | "港幣" => Some("HKD"),
        "USD" | "美元" | "US$" => Some("USD"),
        "KRW" | "韩元" | "韓元" => Some("KRW"),
        _ => None,
    }
}

pub fn growth(reading: &Value) -> Value {
    let Some(value) = n(&reading["ttmGrowth"]) else {
        return json!({"verdict":"unknown","ttmGrowth":null,"reportDate":null,"note":null});
    };
    let source = if reading["provisional"] == true {
        "业绩快报/预告口径"
    } else {
        "正式报告口径"
    };
    let date = s(&reading["reportDate"]);
    let (verdict, note) = if value <= -0.15 {
        (
            "vetoes",
            Some(format!(
                "TTM 净利润同比 {}（{source}，截至 {date}），低于 -15% 门槛；此时低 PE 是分子分母同时下降，不能当作折价。",
                pct(value)
            )),
        )
    } else if value < -0.05 {
        (
            "weakens",
            Some(format!(
                "TTM 净利润同比 {}（{source}，截至 {date}），利润在小幅收缩，需确认是一次性因素还是趋势。",
                pct(value)
            )),
        )
    } else if value >= 1.0 {
        (
            "not_meaningful",
            Some(format!(
                "TTM 净利润同比 {}（{source}，截至 {date}），超过 100% 上限；这个量级无法只凭一个 TTM 数字区分「基期一次性损益」与「真实加速」（同期中际旭创 +200%、寒武纪 +122% 属真实增长），因此既不支持也不否决区间，需查一手财报。",
                pct(value)
            )),
        )
    } else {
        ("supports", None)
    };
    json!({"verdict":verdict,"ttmGrowth":value,"reportDate":reading["reportDate"],"note":note})
}

pub fn screen(input: &Value) -> Value {
    let growth = growth(&input["growth"]);
    let base = json!({"code":input["code"],"archetype":input["archetype"],"executable":false,"growth":growth});
    let blocked = |reason: &str, note: String| {
        let mut result = base.clone();
        result["verdict"] = json!("blocked");
        result["basis"] = Value::Null;
        result["position"] = Value::Null;
        result["blockReasons"] = json!([reason]);
        result["note"] = json!(note);
        result
    };
    let usable = array(&input["bands"])
        .iter()
        .filter(|band| {
            band["status"] == "available"
                && !band["denominator"].is_null()
                && !band["range"].is_null()
                && !s(&band["unit"]).is_empty()
        })
        .collect::<Vec<_>>();
    if usable.is_empty() {
        return blocked(
            "no_available_band",
            "本原型没有任何可用区间，估值输入不足。".into(),
        );
    }
    let mut comparable = usable
        .into_iter()
        .filter(|band| band["unit"] == "percent" || !s(&band["key"]).starts_with("ev_"))
        .collect::<Vec<_>>();
    if comparable.is_empty() {
        return blocked("no_market_cap_band","只有 EV 口径区间可用；EV 需先扣有息负债加现金，且本仓库在负债科目不全时拒绝计算，不能直接与市值比较。".into());
    }
    let quote = &input["quote"];
    if quote.is_null() {
        return blocked(
            "quote_missing",
            "缺少同日期行情，无法把区间与市场定价对照；区间本身仍然成立。".into(),
        );
    }
    let (Some(band_currency), Some(quote_currency)) = (
        normalize_currency(&input["bandCurrency"]),
        normalize_currency(&quote["currency"]),
    ) else {
        return blocked(
            "currency_unknown",
            "区间分母或行情的币种缺失，无法确认两边同币种；不做隐含换算。".into(),
        );
    };
    if band_currency != quote_currency {
        return blocked(
            "currency_mismatch",
            format!(
                "区间分母以 {band_currency} 计价、行情以 {quote_currency} 计价；需先取官方汇率换算，本判定不做隐含换算。"
            ),
        );
    }
    let Some(cap) = positive(&quote["marketCap"]) else {
        return blocked(
            "quote_missing",
            "缺少同日期市值，无法把区间与市场定价对照；区间本身仍然成立。".into(),
        );
    };
    let preference = [
        "pe_ttm",
        "pe_mid_cycle",
        "pb",
        "ev_ebit",
        "ev_ebitda",
        "ev_revenue",
        "fcf_yield",
        "dividend_yield",
    ];
    comparable.sort_by_key(|band| {
        (
            if band["role"] == "primary" { 0 } else { 1 },
            preference
                .iter()
                .position(|key| *key == s(&band["key"]))
                .unwrap_or(preference.len()),
        )
    });
    let chosen = comparable[0];
    let key = s(&chosen["key"]);
    let report = s(&chosen["denominator"]["reportDate"]);
    let has_primary = comparable.iter().any(|band| band["role"] == "primary");
    let through_cycle = matches!(
        s(&chosen["denominator"]["basis"]),
        "net_income_mid_cycle" | "ebit_mid_cycle"
    );
    let max_age = n(&input["maxBasisAgeDays"]).unwrap_or(if through_cycle { 460.0 } else { 120.0 });
    let Some(age) = date_ms(report)
        .zip(date_ms(s(&quote["priceAsOf"])))
        .map(|(from, to)| ((to - from) as f64 / 86_400_000.0).round().abs())
    else {
        return blocked(
            "stale_basis",
            "缺少报告期或行情日期，无法确认两边是同一时点。".into(),
        );
    };
    if age > max_age {
        return blocked(
            "stale_basis",
            if through_cycle {
                format!(
                    "中枢锚点 {report} 与行情 {} 相隔 {age} 天（上限 {max_age} 天），已缺一个完整年度；此时中枢不代表当前周期位置。",
                    s(&quote["priceAsOf"])
                )
            } else {
                format!(
                    "报表锚点 {report} 与行情 {} 相隔 {age} 天（上限 {max_age} 天）；此时比较测的是股价漂移，不是公司估值。",
                    s(&quote["priceAsOf"])
                )
            },
        );
    }
    let basis = json!({"key":key,"role":chosen["role"],"reportDate":report,"range":chosen["range"],"unit":chosen["unit"]});
    let denominator = n(&chosen["denominator"]["value"]).unwrap_or(f64::NAN);
    let low = n(&chosen["range"]["low"]).unwrap_or(f64::NAN);
    let high = n(&chosen["range"]["high"]).unwrap_or(f64::NAN);
    let result = |verdict: &str, note: String, position: Value| {
        let mut result = base.clone();
        result["verdict"] = json!(verdict);
        result["basis"] = basis.clone();
        result["position"] = position;
        result["blockReasons"] = json!([]);
        result["note"] = json!(note);
        result
    };
    let watch = |note: String, position: Value| {
        result(
            "watch",
            format!("{note}这只是观察项，不是交易指令。"),
            position,
        )
    };
    let veto = growth["verdict"] == "vetoes" && chosen["denominator"]["basis"] == "net_income_ttm";
    if chosen["unit"] == "percent" {
        let current = denominator / cap * 100.0;
        let current_fixed = fixed(current, 2);
        let implied_high = denominator / high * 100.0;
        let margin = (current - high) / high;
        let position = json!({"metric":"yield","marketCap":cap,"impliedHigh":implied_high,"marginOfSafety":margin});
        if current < low {
            return watch(
                format!("当前收益率 {current_fixed}% 低于区间下限 {low}%（区间 {low}–{high}%）。"),
                position,
            );
        }
        if margin < 0.2 {
            return watch(
                format!(
                    "当前收益率 {current_fixed}% 在区间内，但高出上限仅 {}%，低于 20% 门槛。",
                    fixed(margin * 100.0, 1)
                ),
                position,
            );
        }
        if !has_primary {
            return watch(
                format!(
                    "只有辅助方法 {key} 可用（当前收益率 {current_fixed}%，高出上限 {}%）；该原型的主方法不可计算，辅助方法不单独形成候选。",
                    fixed(margin * 100.0, 1)
                ),
                position,
            );
        }
        if veto {
            return blocked(
                "earnings_shrinking",
                format!(
                    "{}现金流收益率因此不能单独作为入选依据。",
                    s(&growth["note"])
                ),
            );
        }
        return result(
            "research_candidate",
            format!(
                "{key} 当前 {current_fixed}%，高出保守上限 {high}% 达 {}%；这只是研究候选，不是交易指令。",
                fixed(margin * 100.0, 1)
            ),
            position,
        );
    }
    let implied_high = denominator * high;
    let margin = (implied_high - cap) / implied_high;
    let metric = if key.starts_with("pe") {
        "pe"
    } else if key.starts_with("ev") {
        "ev"
    } else if key.starts_with("pb") {
        "pb"
    } else {
        "yield"
    };
    let position =
        json!({"metric":metric,"marketCap":cap,"impliedHigh":implied_high,"marginOfSafety":margin});
    let yi = |value: f64| format!("{} 亿", fixed(value / 100_000_000.0, 2));
    if cap > implied_high {
        return watch(
            format!(
                "市值 {} 高于区间上限 {}（区间 {low}–{high}x）。",
                yi(cap),
                yi(implied_high)
            ),
            position,
        );
    }
    if margin < 0.2 {
        return watch(
            format!(
                "安全边际 {}% 低于 20% 门槛（市值 {}，区间上限 {}）。",
                fixed(margin * 100.0, 1),
                yi(cap),
                yi(implied_high)
            ),
            position,
        );
    }
    if !has_primary {
        return watch(
            format!(
                "只有辅助方法 {key} 可用（安全边际 {}%）；该原型的主方法不可计算，辅助方法不单独形成候选。",
                fixed(margin * 100.0, 1)
            ),
            position,
        );
    }
    if veto {
        return blocked(
            "earnings_shrinking",
            format!(
                "{}区间本身成立，但分母在收缩时不能把低倍数当作折价。",
                s(&growth["note"])
            ),
        );
    }
    result(
        "research_candidate",
        format!(
            "{key} 口径下市值 {} 低于区间上限 {} 约 {}%，达到研究门槛；这只是研究候选，不是交易指令。",
            yi(cap),
            yi(implied_high),
            fixed(margin * 100.0, 1)
        ),
        position,
    )
}

pub fn band_position(cap: f64, low: f64, high: f64) -> &'static str {
    if ![cap, low, high].iter().all(|n| n.is_finite() && *n > 0.0) || low > high {
        "unknown"
    } else if cap < low {
        "undervalued"
    } else if cap < (low + high) / 2.0 {
        "fair_low"
    } else if cap <= high {
        "fair"
    } else if cap <= high * 1.2 {
        "expensive"
    } else {
        "very_expensive"
    }
}

pub fn assess(input: &Value) -> Value {
    let result = &input["result"];
    let bands = &input["bands"];
    let series = &input["series"];
    let quote = &input["quote"];
    let chosen = array(&bands["bands"])
        .iter()
        .find(|band| band["key"] == result["basis"]["key"])
        .unwrap_or(&Value::Null);
    let cap = n(&result["position"]["marketCap"]);
    let range = &chosen["range"];
    let denominator = n(&chosen["denominator"]["value"]);
    let eligible = result["verdict"] != "blocked"
        && chosen["role"] == "primary"
        && !range.is_null()
        && denominator.is_some_and(|v| v > 0.0)
        && cap.is_some_and(|v| v > 0.0);
    let percent = chosen["unit"] == "percent";
    let low = eligible.then(|| {
        if percent {
            denominator.unwrap() * 100.0 / n(&range["high"]).unwrap_or(f64::NAN)
        } else {
            denominator.unwrap() * n(&range["low"]).unwrap_or(f64::NAN)
        }
    });
    let high = eligible.then(|| {
        if percent {
            denominator.unwrap() * 100.0 / n(&range["low"]).unwrap_or(f64::NAN)
        } else {
            denominator.unwrap() * n(&range["high"]).unwrap_or(f64::NAN)
        }
    });
    let status = match (low, high, cap) {
        (Some(low), Some(high), Some(cap)) if low != 0.0 && high != 0.0 && cap != 0.0 => {
            band_position(cap, low, high)
        }
        _ => "unknown",
    };
    let latest = array(&series["points"]).first().unwrap_or(&Value::Null);
    let mut limitations = array(&bands["warnings"])
        .iter()
        .filter(|warning| cap.is_none_or(|v| v == 0.0) || !s(warning).starts_with("未提供市值"))
        .cloned()
        .collect::<Vec<_>>();
    limitations.push(json!(
        "区间来自现有行业/商业模式规则，尚非公司专属内在价值；未来估值未覆盖。"
    ));
    if !eligible {
        limitations.push(result["note"].clone());
    }
    if chosen["role"] == "auxiliary" {
        limitations.push(json!("仅有辅助方法，不据此判定低估或合理。"));
    }
    if latest["provisional"] == true {
        limitations.push(json!("最新经营读数包含业绩预告/快报，非正式财报。"));
    }
    let current = cap
        .filter(|v| *v != 0.0)
        .zip(denominator.filter(|v| *v > 0.0))
        .map(|(cap, den)| {
            if percent {
                den / cap * 100.0
            } else {
                cap / den
            }
        });
    let strict = array(&input["statements"])
        .iter()
        .filter(|row| {
            point_in_time::notice_date(row).is_some()
                && point_in_time::is_cumulative(&row["payload"])
        })
        .cloned()
        .collect::<Vec<_>>();
    let bars = array(&input["bars"])
        .iter()
        .filter_map(|bar| {
            positive(&bar["marketCapital"]).map(|cap| json!({"date":bar["date"],"marketCap":cap}))
        })
        .collect::<Vec<_>>();
    let historical = if input["historyComparable"] == true && chosen["key"] == "pe_ttm" {
        point_in_time::build(&strict, &bars, f64::INFINITY)
    } else {
        vec![]
    };
    let history_end = s(&quote["date"]);
    let windows=[3,5].into_iter().map(|years|{
        let from=history_end.get(..4).and_then(|year|year.parse::<i32>().ok()).map(|year|format!("{}{}",year-years,&history_end[4..])).unwrap_or_default();
        let values=historical.iter().filter(|point|s(&point["date"])>=from.as_str()&&s(&point["date"])<=history_end&&n(&point["peTtm"]).is_some()).collect::<Vec<_>>();
        let span=values.first().zip(values.last()).and_then(|(first,last)|date_ms(s(&last["date"])).zip(date_ms(s(&first["date"])))).map(|(end,start)|(end-start)as f64/86_400_000.0).unwrap_or(0.0);
        let enough=values.len()>=years as usize*180&&span>=years as f64*365.0*0.85;
        let percentile=if enough{current.map(|current|values.iter().filter(|p|n(&p["peTtm"]).unwrap()<=current).count()as f64/values.len()as f64)}else{None};
        json!({"years":years,"percentile":percentile,"samples":values.len(),"from":values.first().map(|v|&v["date"]),"to":values.last().map(|v|&v["date"])})
    }).collect::<Vec<_>>();
    json!({"status":status,"confidence":if eligible&&result["growth"]["verdict"]!="unknown"&&latest["provisional"]!=true{"medium"}else{"low"},"method":chosen["label"],"current":current,"unit":chosen["unit"],"range":range,
        "conservativeMargin":low.filter(|low|*low!=0.0).zip(cap.filter(|cap|*cap!=0.0)).map(|(low,cap)|1.0-cap/low),"assumptions":chosen.get("assumptions").cloned().unwrap_or_else(||json!([])),"limitations":limitations,"quote":quote,
        "history":{"metric":"PE(TTM)","windows":windows,"note":"只用披露日已知的累计财报重建PE；缺披露日、币种不可比或样本不足时留空。历史分位不等于低估；历史重述仍可能影响结果。非PE主方法暂不提供分位。"},
        "operating":{"reportDate":latest["reportDate"],"periodLabel":if !latest["quarterNetProfit"].is_null(){"最近单季"}else{"最近报告期（无单季口径）"},"revenueYoY":latest["revenueYoY"],"profitYoY":latest["netProfitYoY"],"ttmGrowth":result["growth"]["ttmGrowth"],"provisional":latest.get("provisional").cloned().unwrap_or(json!(false))},"future":null,"computedAt":iso(timestamp())})
}

#[cfg(test)]
mod tests {
    use super::fixed;

    #[test]
    fn decimal_labels_follow_javascript_exact_binary_rounding() {
        assert_eq!(fixed(1.125, 2), "1.13");
        assert_eq!(fixed(-1.125, 2), "-1.13");
        assert_eq!(fixed(1.005, 2), "1.00");
        assert_eq!(fixed(2.55, 1), "2.5");
        assert_eq!(fixed(1e-100, 2), "0.00");
        assert_eq!(fixed(-1e-100, 2), "-0.00");
        assert_eq!(fixed(-0.0, 2), "0.00");
    }
}
