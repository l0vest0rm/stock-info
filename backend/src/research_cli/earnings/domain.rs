//! Deterministic earnings evidence rules. Values are observations, never trades.
use serde_json::{Value, json};
use std::{cmp::Ordering, collections::HashMap};
const YI: f64 = 100_000_000.0;
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn pick<'a>(v: &'a Value, a: &str, b: &str) -> &'a Value {
    if v[a].is_null() { &v[b] } else { &v[a] }
}
fn date(v: &Value) -> &str {
    s(v).get(..10).unwrap_or(s(v))
}
pub fn number(v: &Value) -> Option<f64> {
    if v.is_null() || v.as_str() == Some("") {
        return None;
    }
    v.as_f64()
        .or_else(|| {
            if let Some(b) = v.as_bool() {
                Some(if b { 1.0 } else { 0.0 })
            } else {
                let text = s(v).replace(',', "");
                if text.trim().is_empty() {
                    Some(0.0)
                } else {
                    text.parse().ok()
                }
            }
        })
        .filter(|n| n.is_finite())
}
fn r(n: f64) -> f64 {
    let scaled = n * 100.0;
    let floor = scaled.floor();
    (if scaled - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }) / 100.0
}
pub fn round(n: f64) -> Value {
    json!(r(n))
}
fn rounded(n: Option<f64>) -> Value {
    n.map(round).unwrap_or(Value::Null)
}
fn yi(n: Option<f64>) -> Value {
    rounded(n.map(|n| n / YI))
}
fn num(v: &Value) -> f64 {
    number(v).unwrap_or(0.0)
}
fn mid(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some((a + b) / 2.0),
        (a, b) => a.or(b),
    }
}
fn midpoint(v: &Value) -> Option<f64> {
    mid(number(&v["lowYuan"]), number(&v["highYuan"]))
}
fn range(a: &Value, b: &Value, c: &Value, d: &Value, previous: &Value) -> Value {
    let bounds = |a: &Value, b: &Value| {
        let mut v = [number(a), number(b)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        v.sort_by(f64::total_cmp);
        (v.first().copied(), v.last().copied())
    };
    let (lo, hi) = bounds(a, b);
    let (yl, yh) = bounds(c, d);
    json!({"lowYuan":lo,"highYuan":hi,"yoyLow":yl,"yoyHigh":yh,"previousYuan":number(previous)})
}
fn empty() -> Value {
    range(
        &Value::Null,
        &Value::Null,
        &Value::Null,
        &Value::Null,
        &Value::Null,
    )
}
fn code(row: &Value) -> String {
    let text = s(pick(row, "SECUCODE", "SECURITY_CODE"))
        .trim()
        .to_uppercase();
    if text.is_empty() || text.contains('.') {
        text
    } else {
        let market = match text.as_bytes()[0] {
            b'0'..=b'3' => "SZ",
            b'4' | b'8' => "BJ",
            _ => "SH",
        };
        format!("{text}.{market}")
    }
}
fn ashare(code: &str) -> bool {
    let Some((n, m)) = code.split_once('.') else {
        return false;
    };
    n.len() == 6
        && n.bytes().all(|b| b.is_ascii_digit())
        && match m {
            "SH" => n.starts_with("60") || n.starts_with("68"),
            "SZ" => n.starts_with("00") || n.starts_with("30"),
            "BJ" => n.starts_with(['4', '8', '9']),
            _ => false,
        }
}
fn newest(a: &Value, b: &Value) -> Ordering {
    format!("{}:{}", date(&b["NOTICE_DATE"]), date(&b["UPDATE_DATE"])).cmp(&format!(
        "{}:{}",
        date(&a["NOTICE_DATE"]),
        date(&a["UPDATE_DATE"])
    ))
}
fn performance(c: &str, row: &Value) -> Value {
    json!({"code":c,"name":if row["SECURITY_NAME_ABBR"].is_null(){c}else{s(&row["SECURITY_NAME_ABBR"])},"reportDate":date(&row["REPORT_DATE"]),"noticeDate":date(pick(row,"NOTICE_DATE","UPDATE_DATE")),"sourceType":"performance_report","forecastType":"业绩快报","profit":range(&row["PARENT_NETPROFIT"],&row["PARENT_NETPROFIT"],&row["JLRTBZCL"],&row["JLRTBZCL"],&row["PARENT_NETPROFIT_SQ"]),"deductProfit":empty(),"revenue":range(&row["TOTAL_OPERATE_INCOME"],&row["TOTAL_OPERATE_INCOME"],&row["YSTZ"],&row["YSTZ"],&Value::Null),"reason":""})
}
fn forecast(c: &str, row: &Value) -> Value {
    json!({"code":c,"name":if row["SECURITY_NAME_ABBR"].is_null(){c}else{s(&row["SECURITY_NAME_ABBR"])},"reportDate":date(&row["REPORT_DATE"]),"noticeDate":date(&row["NOTICE_DATE"]),"sourceType":"performance_forecast","forecastType":if row["PREDICT_TYPE"].is_null(){"业绩预告"}else{s(&row["PREDICT_TYPE"])},"profit":empty(),"deductProfit":empty(),"revenue":empty(),"reason":s(pick(row,"CHANGE_REASON_EXPLAIN","PREDICT_CONTENT")).trim()})
}
pub fn aggregate_events(
    performance_rows: &[Value],
    forecast_rows: &[Value],
    as_of: &str,
    from: &str,
    report_date: &str,
) -> Vec<Value> {
    let eligible = |row: &&Value| {
        let notice = date(pick(row, "NOTICE_DATE", "UPDATE_DATE"));
        date(&row["REPORT_DATE"]) == report_date && notice >= from && notice <= as_of
    };
    let mut rows = performance_rows.iter().filter(eligible).collect::<Vec<_>>();
    rows.sort_by(|a, b| newest(a, b));
    let mut out = Vec::new();
    let mut indices = HashMap::new();
    for row in rows {
        let c = code(row);
        if ashare(&c) && !indices.contains_key(&c) {
            indices.insert(c.clone(), out.len());
            out.push(performance(&c, row));
        }
    }
    let mut rows = forecast_rows.iter().filter(eligible).collect::<Vec<_>>();
    rows.sort_by(|a, b| newest(a, b));
    let mut metrics = std::collections::HashSet::new();
    let performance_codes = indices
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    for row in rows {
        let c = code(row);
        let metric = s(&row["PREDICT_FINANCE_CODE"]);
        if s(&row["IS_LATEST"]) == "F"
            || !ashare(&c)
            || !["004", "005", "006"].contains(&metric)
            || !metrics.insert(format!("{c}:{metric}"))
            || performance_codes.contains(&c)
        {
            continue;
        }
        let index = if let Some(i) = indices.get(&c) {
            *i
        } else {
            let i = out.len();
            indices.insert(c.clone(), i);
            out.push(forecast(&c, row));
            i
        };
        let key = match metric {
            "004" => "profit",
            "005" => "deductProfit",
            _ => "revenue",
        };
        out[index][key] = range(
            &row["PREDICT_AMT_LOWER"],
            &row["PREDICT_AMT_UPPER"],
            &row["ADD_AMP_LOWER"],
            &row["ADD_AMP_UPPER"],
            &row["PREYEAR_SAME_PERIOD"],
        );
        if date(&row["NOTICE_DATE"]) > s(&out[index]["noticeDate"]) {
            out[index]["noticeDate"] = json!(date(&row["NOTICE_DATE"]));
        }
    }
    out
}
fn pre_score(c: &Value) -> f64 {
    let growth = mid(
        number(&c["profit"]["yoyLow"]),
        number(&c["profit"]["yoyHigh"]),
    )
    .map_or(0.0, |n| n.clamp(-50.0, 100.0) / 10.0);
    let pe = number(&c["market"]["peTtm"])
        .filter(|n| *n > 0.0)
        .map_or(0.0, |n| ((50.0 - n) / 5.0).clamp(0.0, 10.0));
    let quality = midpoint(&c["profit"])
        .filter(|n| *n > 0.0)
        .zip(midpoint(&c["deductProfit"]))
        .map_or(3.0, |(p, d)| (d / p).clamp(0.0, 1.0) * 10.0);
    growth
        + pe
        + quality
        + if c["sourceType"] == "performance_report" {
            3.0
        } else {
            0.0
        }
}
pub fn attach_markets(events: &[Value], markets: &[Value], filters: &Value) -> Vec<Value> {
    let markets = markets
        .iter()
        .map(|row| (code(row), row))
        .collect::<HashMap<_, _>>();
    let mut out = Vec::new();
    for event in events {
        let Some(m) = markets.get(s(&event["code"])) else {
            continue;
        };
        let Some(cap) = number(&m["TOTAL_MARKET_CAP"]) else {
            continue;
        };
        let cap_yi = cap / YI;
        if cap_yi < num(&filters["minMarketCapYi"]) || cap_yi > num(&filters["maxMarketCapYi"]) {
            continue;
        }
        let name = if !m["SECURITY_NAME_ABBR"].is_null() {
            s(&m["SECURITY_NAME_ABBR"])
        } else {
            s(pick(event, "name", "code"))
        }
        .trim();
        if filters["excludeNamePatterns"]
            .as_array()
            .is_some_and(|patterns| patterns.iter().any(|p| name.contains(s(p))))
        {
            continue;
        }
        let mut c = event.clone();
        c["name"] = json!(name);
        c["market"] = json!({"tradeDate":date(&m["MAX_TRADE_DATE"]),"price":number(&m["NEW_PRICE"]),"marketCapYuan":cap,"marketCapYi":round(cap_yi),"peTtm":rounded(number(&m["PE9"])),"pbMrq":rounded(number(&m["PBNEWMRQ"])),"latestProfitYoY":rounded(number(&m["NETPROFIT_YOY_RATIO"])),"dividendYield":rounded(number(&m["ZXGXL"])),"institutionCount":number(&m["ALLCORP_NUM"])});
        out.push(c);
    }
    out.sort_by(|a, b| {
        pre_score(b)
            .total_cmp(&pre_score(a))
            .then_with(|| s(&b["noticeDate"]).cmp(s(&a["noticeDate"])))
    });
    out
}
pub fn prioritize(events: &[Value], limit: usize) -> Vec<Value> {
    let mut out = events.to_vec();
    out.sort_by(|a, b| {
        s(&b["noticeDate"]).cmp(s(&a["noticeDate"])).then_with(|| {
            let growth = |c: &Value| {
                mid(
                    number(&c["profit"]["yoyLow"]),
                    number(&c["profit"]["yoyHigh"]),
                )
                .unwrap_or(f64::NEG_INFINITY)
            };
            growth(b).total_cmp(&growth(a))
        })
    });
    out.truncate(limit);
    out
}
fn report_date(row: &Value) -> &str {
    date(pick(row, "reportDate", "REPORT_DATE"))
}
fn eligible(rows: &Value, as_of: &str) -> Vec<Value> {
    rows.as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            let d = report_date(row);
            let n = date(pick(row, "noticeDate", "NOTICE_DATE"));
            let n = if n.is_empty() { d } else { n };
            !d.is_empty() && d <= as_of && n <= as_of
        })
        .cloned()
        .collect()
}
fn year(d: &str) -> i64 {
    d.get(..4).unwrap_or("").parse().unwrap_or(0)
}
fn quarter(d: &str) -> i64 {
    match d.get(5..7).unwrap_or("") {
        "03" => 1,
        "06" => 2,
        "09" => 3,
        "12" => 4,
        _ => 0,
    }
}
fn quarter_row(rows: &[Value], y: i64, q: i64) -> Option<&Value> {
    rows.iter().find(|row| {
        let d = report_date(row);
        year(d) == y && quarter(d) == q
    })
}
fn statement(row: Option<&Value>, mapped: &str, raw: &str) -> Option<f64> {
    row.and_then(|row| number(pick(row, mapped, raw)))
}
fn sum(rows: &[Value], y: i64, through: i64, mapped: &str) -> Option<f64> {
    let raw = match mapped {
        "parentNetprofit" => "PARENT_NETPROFIT",
        "netcashOperate" => "NETCASH_OPERATE",
        _ => mapped,
    };
    (1..=through).try_fold(0.0, |total, q| {
        Some(total + statement(quarter_row(rows, y, q), mapped, raw)?)
    })
}
fn growth(current: Option<f64>, previous: Option<f64>) -> Option<f64> {
    current
        .zip(previous)
        .filter(|(_, p)| *p > 0.0)
        .map(|(c, p)| r((c / p - 1.0) * 100.0))
}
fn ratio(n: Option<f64>, d: Option<f64>, scale: f64) -> Value {
    rounded(
        n.zip(d)
            .filter(|(_, d)| *d != 0.0)
            .map(|(n, d)| n / d * scale),
    )
}
fn width(range: &Value) -> f64 {
    midpoint(range)
        .filter(|m| *m != 0.0)
        .zip(number(&range["lowYuan"]))
        .zip(number(&range["highYuan"]))
        .map_or(0.0, |((m, l), h)| (h - l).abs() / m.abs())
}
fn effective(
    qoq: Option<f64>,
    yoy: Option<f64>,
    comparable: bool,
    ranking: &Value,
) -> (Option<f64>, Value, Option<String>) {
    let threshold = num(&ranking["yoyIgnoreAbove"]);
    let usable = comparable && yoy.is_some_and(|y| y.abs() <= threshold);
    let reason = if !comparable {
        Some("同比属于扭亏或低基数，不参与有效增速和候选排序".into())
    } else if yoy.is_some_and(|y| y.abs() > threshold) {
        Some(format!("单季同比绝对值超过{threshold}%，按异常高增速忽略"))
    } else {
        None
    };
    let (value, q, y, qw, yw) = match (qoq, usable) {
        (Some(q), true) => {
            let qw = num(&ranking["effectiveGrowthWeights"]["qoq"]);
            let yw = num(&ranking["effectiveGrowthWeights"]["yoy"]);
            (
                Some(r(q * qw + yoy.unwrap_or_default() * yw)),
                Some(q),
                yoy,
                qw,
                yw,
            )
        }
        (Some(q), false) => (Some(q), Some(q), None, 1.0, 0.0),
        (None, true) => (yoy, None, yoy, 0.0, 1.0),
        (None, false) => (None, None, None, 0.0, 0.0),
    };
    (
        value,
        json!({"qoq":q,"yoy":y,"qoqWeight":qw,"yoyWeight":yw}),
        reason,
    )
}

pub fn analyze(
    candidate: &Value,
    statements: &Value,
    as_of: &str,
    forecast_year: i64,
    ranking: &Value,
) -> Value {
    let income = eligible(&statements["income"], as_of);
    let balance = eligible(&statements["balance"], as_of);
    let cash = eligible(&statements["cashflow"], as_of);
    let report = s(&candidate["reportDate"]);
    let y = year(report);
    let q = quarter(report);
    let p = midpoint(&candidate["profit"]);
    let previous = number(&candidate["profit"]["previousYuan"]);
    let comparable = previous
        .zip(p)
        .is_some_and(|(a, b)| a > 0.0 && b > 0.0 && a / b >= num(&ranking["lowBaseRatio"]));
    let single = p
        .zip(sum(&income, y, q - 1, "parentNetprofit"))
        .map(|(p, prior)| p - prior);
    let py = statement(
        quarter_row(&income, y - 1, q),
        "parentNetprofit",
        "PARENT_NETPROFIT",
    );
    let prior = statement(
        if q > 1 {
            quarter_row(&income, y, q - 1)
        } else {
            quarter_row(&income, y - 1, 4)
        },
        "parentNetprofit",
        "PARENT_NETPROFIT",
    );
    let yoy = growth(single, py);
    let qoq = growth(single, prior);
    let (effective, inputs, ignored) = effective(qoq, yoy, comparable, ranking);
    let peg_growth = effective
        .filter(|v| *v > 0.0)
        .map(|v| v.min(num(&ranking["growthCeiling"])));
    let factor = if q > 0 { 4.0 / q as f64 } else { f64::NAN };
    let bear = number(&candidate["profit"]["lowYuan"])
        .or(p)
        .map(|v| v * factor);
    let base = p.map(|v| v * factor);
    let bull = number(&candidate["profit"]["highYuan"])
        .or(p)
        .map(|v| v * factor);
    let pe = |profit: Option<f64>| {
        profit
            .filter(|p| *p > 0.0)
            .map(|p| r(num(&candidate["market"]["marketCapYuan"]) / p))
    };
    let pe_base = pe(base);
    let method = if p.is_none() {
        "缺少归母净利润，无法推演".to_string()
    } else if q == 4 {
        "年度数据直接采用".into()
    } else {
        let label = match q {
            1 => "一季度",
            2 => "半年",
            3 => "前三季度",
            _ => "全年",
        };
        format!("{label}累计利润按运行率×{}年化", r(factor))
    };
    let mut shares = if q == 4 { vec![1.0] } else { Vec::new() };
    if q != 4 {
        for year in ((y - 4)..y).rev() {
            if let Some((annual, ytd)) = sum(&income, year, 4, "parentNetprofit").zip(sum(
                &income,
                year,
                q,
                "parentNetprofit",
            )) && annual > 0.0
                && ytd > 0.0
            {
                let share = ytd / annual;
                if (0.05..=1.5).contains(&share) {
                    shares.push(share);
                }
            }
        }
    }
    let mut sorted = shares.clone();
    sorted.sort_by(f64::total_cmp);
    let median = if sorted.is_empty() {
        0.0
    } else {
        let middle = sorted.len() / 2;
        if sorted.len() % 2 == 1 {
            sorted[middle]
        } else {
            (sorted[middle - 1] + sorted[middle]) / 2.0
        }
    };
    let cf = sum(&cash, y, q, "netcashOperate");
    let latest = balance
        .iter()
        .filter(|row| report_date(row) <= report)
        .fold(None, |best: Option<&Value>, row| {
            if best.is_none_or(|best| report_date(row) > report_date(best)) {
                Some(row)
            } else {
                best
            }
        });
    let assets = statement(latest, "totaAssets", "TOTAL_ASSETS");
    let liabilities = statement(latest, "totalLiabilities", "TOTAL_LIABILITIES");
    let receivable = statement(latest, "accountsRece", "ACCOUNTS_RECE");
    let inventory = statement(latest, "inventory", "INVENTORY");
    let risks = ranking["riskReasonKeywords"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|k| s(&candidate["reason"]).contains(s(k)))
        .cloned()
        .collect::<Vec<_>>();
    let mut warnings = Vec::<String>::new();
    if single.is_none() {
        warnings.push("缺少完整前序季度，单季增速不可计算".into());
    }
    if !comparable {
        warnings.push("上年同期为亏损或低基数，累计同比仅作背景，不参与排序".into());
    }
    if single.is_some() && py.is_some_and(|v| v <= 0.0) {
        warnings.push("上年同季利润非正，单季同比百分比不具可比性".into());
    }
    if single.is_some() && prior.is_some_and(|v| v <= 0.0) {
        warnings.push("上一季度利润非正，单季环比百分比不具可比性".into());
    }
    if let Some(reason) = ignored {
        warnings.push(reason);
    }
    if !risks.is_empty() {
        warnings.push(format!(
            "业绩原因包含{}，按非经常性或投资收益风险扣分",
            risks.iter().map(s).collect::<Vec<_>>().join("、")
        ));
    }
    if candidate["sourceType"] == "performance_forecast" && width(&candidate["profit"]) > 0.5 {
        warnings.push("业绩预告区间较宽".into());
    }
    if p.zip(cf).is_some_and(|(p, cf)| p > 0.0 && cf / p < 0.5) {
        warnings.push("经营现金流与利润匹配偏弱".into());
    }
    if p.zip(midpoint(&candidate["deductProfit"]))
        .is_some_and(|(p, d)| p > 0.0 && d / p < 0.5)
    {
        warnings.push("扣非净利润明显低于归母净利润，需核查非经常性损益".into());
    }
    if bear.zip(bull).is_some_and(|(b, u)| b > 0.0 && u / b >= 3.0) {
        warnings.push("业绩披露区间较宽，年化利润和Forward PE跨度较大".into());
    }
    let confidence = if candidate["sourceType"] == "performance_report" {
        "high"
    } else if width(&candidate["profit"]) <= 0.3 {
        "medium"
    } else {
        "low"
    };
    let mut out = candidate.clone();
    out["forecastYear"] = json!(forecast_year);
    out["trends"] = json!({"cumulativeProfitYoYLow":rounded(number(&candidate["profit"]["yoyLow"])),"cumulativeProfitYoYHigh":rounded(number(&candidate["profit"]["yoyHigh"])),"cumulativeProfitYoYComparable":comparable,"previousCumulativeProfitYi":yi(previous),"singleQuarterProfitYi":yi(single),"singleQuarterYoY":yoy,"singleQuarterQoQ":qoq,"effectiveGrowth":effective,"effectiveGrowthInputs":inputs});
    out["projection"] = json!({"method":method,"seasonalSampleCount":shares.len(),"historicalYtdShareMedian":round(median*100.0),"confidence":confidence,"profitYi":{"bear":yi(bear),"base":yi(base),"bull":yi(bull)},"pe":{"bear":pe(bear),"base":pe_base,"bull":pe(bull)},"pegLike":rounded(pe_base.zip(peg_growth).map(|(pe,g)|pe/g)),"pegGrowthUsed":peg_growth});
    out["quality"] = json!({"operatingCashflowYi":yi(cf),"operatingCashflowToProfit":ratio(cf,p,1.0),"debtToAssets":ratio(liabilities,assets,100.0),"accountsReceivableYi":yi(receivable),"inventoryYi":yi(inventory)});
    out["riskFlags"] = json!({"eventRiskKeywords":risks});
    out["consensus"] = Value::Null;
    out["warnings"] = json!(warnings);
    out
}
fn screening(c: &Value, rk: &Value) -> Value {
    let pe = number(&c["projection"]["pe"]["base"])
        .filter(|p| *p > 0.0)
        .map_or(0.0, |p| {
            ((num(&rk["forwardPeCeiling"]) - p) / num(&rk["forwardPeCeiling"])).clamp(0.0, 1.0)
        });
    let growth = number(&c["trends"]["effectiveGrowth"]).map_or(0.0, |g| {
        ((g - num(&rk["growthFloor"])) / (num(&rk["growthCeiling"]) - num(&rk["growthFloor"])))
            .clamp(0.0, 1.0)
    });
    let peg = number(&c["projection"]["pegLike"])
        .filter(|p| *p >= 0.0)
        .map_or(0.0, |p| {
            ((num(&rk["pegLikeCeiling"]) - p) / num(&rk["pegLikeCeiling"])).clamp(0.0, 1.0)
        });
    let deduct = midpoint(&c["profit"])
        .filter(|p| *p > 0.0)
        .zip(midpoint(&c["deductProfit"]))
        .map_or(0.4, |(p, d)| (d / p).clamp(0.0, 1.0));
    let components = json!({"forwardPe":round(pe*num(&rk["weights"]["forwardPe"])),"effectiveGrowth":round(growth*num(&rk["weights"]["effectiveGrowth"])),"pegLike":round(peg*num(&rk["weights"]["pegLike"])),"deductProfitQuality":round(deduct*num(&rk["weights"]["deductProfitQuality"]))});
    let negative = if number(&c["trends"]["singleQuarterProfitYi"]).is_some_and(|n| n <= 0.0) {
        num(&rk["negativeSingleQuarterPenalty"])
    } else {
        0.0
    };
    let event = if c["riskFlags"]["eventRiskKeywords"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        num(&rk["eventRiskPenalty"])
    } else {
        0.0
    };
    json!({"score":round(["forwardPe", "effectiveGrowth", "pegLike", "deductProfitQuality"].iter().map(|key| num(&components[*key])).sum::<f64>()-negative-event),"components":components,"penalties":{"negativeSingleQuarter":negative,"eventRisk":event}})
}
pub fn rank(candidates: &[Value], ranking: &Value) -> Vec<Value> {
    let mut out = candidates
        .iter()
        .map(|c| {
            let mut v = c.clone();
            v["screening"] = screening(c, ranking);
            v
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| {
        num(&b["screening"]["score"])
            .total_cmp(&num(&a["screening"]["score"]))
            .then_with(|| s(&b["noticeDate"]).cmp(s(&a["noticeDate"])))
    });
    out
}
pub fn attach_consensus(candidate: &Value, rows: &[Value]) -> Value {
    let mut out = candidate.clone();
    if let Some(f) = rows.iter().find(|row| {
        number(&row["year"]) == number(&candidate["forecastYear"])
            && number(&row["netProfit"]).is_some()
    }) {
        let p = number(&f["netProfit"]);
        out["consensus"] = json!({"netProfitYi":rounded(p),"pe":rounded(p.filter(|p|*p>0.0).map(|p|num(&candidate["market"]["marketCapYi"])/p)),"aggregation":"最近研报正净利润的简单平均","sampleCount":null});
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn numeric(v: &Value) -> Value {
        match v {
            Value::Number(n) => json!(n.as_f64().unwrap()),
            Value::Array(a) => Value::Array(a.iter().map(numeric).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, v)| (k.clone(), numeric(v))).collect())
            }
            _ => v.clone(),
        }
    }
    #[test]
    fn node_domain_full_output_goldens() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("domain-goldens.json")).unwrap();
        for (index, c) in cases.iter().map(numeric).enumerate() {
            let events = aggregate_events(
                c["performance"].as_array().unwrap(),
                c["forecasts"].as_array().unwrap(),
                s(&c["asOf"]),
                s(&c["from"]),
                s(&c["reportDate"]),
            );
            assert_eq!(numeric(&json!(events)), c["events"], "events {index}");
            let prioritized = prioritize(&events, 20);
            assert_eq!(
                numeric(&json!(prioritized)),
                c["prioritized"],
                "prioritize {index}"
            );
            let attached = attach_markets(
                &prioritized,
                c["markets"].as_array().unwrap(),
                &c["filters"],
            );
            assert_eq!(numeric(&json!(attached)), c["attached"], "market {index}");
            let analyzed = attached
                .iter()
                .map(|v| analyze(v, &c["statements"], s(&c["asOf"]), 2027, &c["ranking"]))
                .collect::<Vec<_>>();
            assert_eq!(numeric(&json!(analyzed)), c["analyzed"], "analyze {index}");
            let ranked = rank(&analyzed, &c["ranking"]);
            assert_eq!(numeric(&json!(ranked)), c["ranked"], "rank {index}");
            let result = ranked
                .iter()
                .map(|v| attach_consensus(v, c["consensus"].as_array().unwrap()))
                .collect::<Vec<_>>();
            assert_eq!(numeric(&json!(result)), c["expected"], "consensus {index}");
        }
    }
}
