use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::{Datelike, NaiveDate, Utc};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
struct Bar {
    date: String,
    close: f64,
    open: f64,
    high: f64,
    low: f64,
    volume: Option<f64>,
    amount: Option<f64>,
    turnover: Option<f64>,
}
fn finite(v: &Value) -> Option<f64> {
    if v.is_null() || v.as_str() == Some("") {
        return None;
    }
    v.as_f64()
        .or_else(|| {
            let text = v.as_str()?.trim();
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse().ok()
            }
        })
        .or_else(|| v.as_bool().map(|b| if b { 1.0 } else { 0.0 }))
        .filter(|n| n.is_finite())
}
fn normalize(raw: &[Value]) -> Vec<Bar> {
    let mut dates = BTreeMap::new();
    for r in raw {
        let (date, c, o, h, l, v, t, a) = if r.is_array() {
            (
                (if r[0].is_null() {
                    Some(0.0)
                } else {
                    finite(&r[0])
                })
                .and_then(|t| chrono::DateTime::from_timestamp_millis(t as i64))
                .map(|d| d.date_naive().to_string())
                .unwrap_or_default(),
                &r[1],
                &r[2],
                &r[3],
                &r[4],
                &r[5],
                &r[6],
                &r[7],
            )
        } else {
            (
                r["date"].as_str().unwrap_or("").to_string(),
                &r["close"],
                &r["open"],
                &r["high"],
                &r["low"],
                &r["volume"],
                &r["turnover"],
                &r["amount"],
            )
        };
        if let (Some(close), Some(open), Some(high), Some(low)) =
            (finite(c), finite(o), finite(h), finite(l))
            && !date.is_empty()
            && [close, open, high, low].iter().all(|n| *n > 0.0)
        {
            dates.insert(
                date.clone(),
                Bar {
                    date,
                    close,
                    open,
                    high,
                    low,
                    volume: finite(v),
                    amount: finite(a),
                    turnover: finite(t),
                },
            );
        }
    }
    dates.into_values().collect()
}
fn avg(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}
fn pct(value: f64, base: f64) -> f64 {
    (value / base - 1.0) * 100.0
}
fn nonnegative(v: Option<f64>) -> Option<f64> {
    v.filter(|n| *n >= 0.0)
}
fn nullable_avg(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let values = values.flatten().collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(avg(&values))
    }
}
fn ratio(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.zip(b).filter(|(_, b)| *b != 0.0).map(|(a, b)| a / b)
}
fn n(config: &Value, group: &str, key: &str) -> f64 {
    finite(&config[group][key]).unwrap_or(0.0)
}
fn window(config: &Value, key: &str) -> usize {
    n(config, "windows", key) as usize
}
fn rsi(closes: &[f64], period: usize) -> f64 {
    let changes = closes.windows(2).map(|w| w[1] - w[0]).collect::<Vec<_>>();
    let mut gain = avg(&changes[..period]
        .iter()
        .map(|c| c.max(0.0))
        .collect::<Vec<_>>());
    let mut loss = avg(&changes[..period]
        .iter()
        .map(|c| (-c).max(0.0))
        .collect::<Vec<_>>());
    for c in &changes[period..] {
        gain = (gain * (period - 1) as f64 + c.max(0.0)) / period as f64;
        loss = (loss * (period - 1) as f64 + (-c).max(0.0)) / period as f64;
    }
    if loss == 0.0 {
        if gain == 0.0 { 50.0 } else { 100.0 }
    } else {
        100.0 - 100.0 / (1.0 + gain / loss)
    }
}
fn atr(rows: &[Bar], period: usize) -> f64 {
    let ranges = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            if i == 0 {
                r.high - r.low
            } else {
                (r.high - r.low)
                    .max((r.high - rows[i - 1].close).abs())
                    .max((r.low - rows[i - 1].close).abs())
            }
        })
        .collect::<Vec<_>>();
    let mut value = avg(&ranges[1..period + 1]);
    for range in &ranges[period + 1..] {
        value = (value * (period - 1) as f64 + range) / period as f64;
    }
    value
}

pub fn analyze(raw: &[Value], config: &Value) -> Result<Value> {
    let rows = normalize(raw);
    let count = rows.len();
    let support = window(config, "support");
    let medium = window(config, "mediumTrend");
    let slope = window(config, "slopeLookback");
    let short = window(config, "shortReturn");
    let down_window = window(config, "downDays");
    let long_volume = window(config, "volumeLong");
    let short_volume = window(config, "volumeShort");
    let rsi_period = window(config, "rsi");
    let atr_period = window(config, "atr");
    if [
        support,
        medium,
        slope,
        short,
        down_window,
        long_volume,
        short_volume,
        rsi_period,
        atr_period,
    ]
    .iter()
    .any(|n| *n > 100000)
    {
        bail!("invalid buy-point analysis windows");
    }
    let required = config["minimumBars"].as_u64().unwrap_or(0) as usize;
    let required = required.max(medium + slope);
    if rows.len() < required {
        bail!(
            "need at least {required} usable daily K-line bars, received {}",
            rows.len()
        );
    }
    if [
        support,
        medium,
        slope,
        short,
        down_window,
        long_volume,
        short_volume,
        rsi_period,
        atr_period,
    ]
    .contains(&0)
        || count <= 20
        || count <= support + slope
        || count <= short
        || count <= down_window
        || count <= rsi_period
        || count <= atr_period
        || long_volume > count
    {
        bail!("invalid buy-point analysis windows");
    }
    let latest = &rows[count - 1];
    let previous = &rows[count - 2];
    let closes = rows.iter().map(|r| r.close).collect::<Vec<_>>();
    let ma5 = avg(&closes[count - 5..]);
    let ma10 = avg(&closes[count - 10..]);
    let ma20 = avg(&closes[count - support..]);
    let ma60 = avg(&closes[count - medium..]);
    let previous_ma5 = avg(&closes[count - 6..count - 1]);
    let earlier_ma20 = avg(&closes[count - support - slope..count - slope]);
    let support_rows = &rows[count - support..];
    let low20 = support_rows
        .iter()
        .map(|r| r.low)
        .fold(f64::INFINITY, f64::min);
    let high20 = support_rows
        .iter()
        .map(|r| r.high)
        .fold(f64::NEG_INFINITY, f64::max);
    let low_close = support_rows
        .iter()
        .map(|r| r.close)
        .fold(f64::INFINITY, f64::min);
    let previous_low20 = rows[count - support - 1..count - 1]
        .iter()
        .map(|r| r.low)
        .fold(f64::INFINITY, f64::min);
    let atr14 = atr(&rows, atr_period);
    let rsi14 = rsi(&closes, rsi_period);
    let ret3 = pct(latest.close, closes[count - short - 1]);
    let ret5 = pct(latest.close, closes[count - 6]);
    let ret10 = pct(latest.close, closes[count - 11]);
    let ret20 = pct(latest.close, closes[count - 21]);
    let drawdown = pct(latest.close, high20);
    let rebound = pct(latest.close, low_close);
    let recent_down = &closes[count - down_window - 1..];
    let down_days = recent_down.windows(2).filter(|w| w[1] < w[0]).count();
    let consecutive = closes.windows(2).rev().take_while(|w| w[1] < w[0]).count();
    let low_index = rows.iter().rposition(|r| r.close == low_close).unwrap_or(0);
    let recent = &rows[count - long_volume..];
    let volume_ma20 = nullable_avg(recent.iter().map(|r| nonnegative(r.volume)));
    let volume_ma5 = nullable_avg(
        recent[long_volume.saturating_sub(short_volume)..]
            .iter()
            .map(|r| nonnegative(r.volume)),
    );
    let latest_volume = nonnegative(latest.volume);
    let volume_ratio = ratio(latest_volume, volume_ma20);
    let volume_short_ratio = ratio(volume_ma5, volume_ma20);
    let up_avg = nullable_avg(
        recent
            .windows(2)
            .filter(|w| w[1].close > w[0].close)
            .map(|w| nonnegative(w[1].volume)),
    );
    let down_avg = nullable_avg(
        recent
            .windows(2)
            .filter(|w| w[1].close < w[0].close)
            .map(|w| nonnegative(w[1].volume)),
    );
    let up_down = ratio(up_avg, down_avg);
    let amount_avg = nullable_avg(recent.iter().map(|r| nonnegative(r.amount)));
    let turnover_avg = nullable_avg(recent.iter().map(|r| nonnegative(r.turnover)));
    let amount_coverage = recent
        .iter()
        .filter(|r| nonnegative(r.amount).is_some())
        .count() as f64
        / long_volume as f64;
    let turnover_coverage = recent
        .iter()
        .filter(|r| nonnegative(r.turnover).is_some())
        .count() as f64
        / long_volume as f64;
    let ma20_distance = pct(latest.close, ma20);
    let atr_pct = atr14 / latest.close * 100.0;
    let t = |k| n(config, "thresholds", k);
    let mut flags = BTreeMap::new();
    flags.insert("rsiOversold", rsi14 <= t("oversoldRsi"));
    flags.insert("rsiWeak", rsi14 <= t("weakRsi"));
    flags.insert("deepDrawdown", drawdown <= t("deepDrawdownPct"));
    flags.insert("moderateDrawdown", drawdown <= t("moderateDrawdownPct"));
    flags.insert("denseDownDays", down_days as f64 >= t("denseDownDays"));
    flags.insert(
        "moderateDownDays",
        down_days as f64 >= (t("denseDownDays") - 1.0).max(1.0),
    );
    flags.insert(
        "nearSupport",
        latest.close - low20 <= t("nearSupportAtr") * atr14,
    );
    flags.insert(
        "bullishDay",
        latest.close > latest.open && latest.close > previous.close,
    );
    flags.insert(
        "reclaimMa5",
        latest.close >= ma5 && previous.close < previous_ma5,
    );
    flags.insert("breakPreviousHigh", latest.close > previous.high);
    flags.insert("positiveShortReturn", ret3 > 0.0);
    flags.insert(
        "volumeExpansion",
        latest.close > previous.close
            && volume_ratio.is_some_and(|r| r >= t("volumeExpansionRatio")),
    );
    flags.insert(
        "volumeContraction",
        latest.close < previous.close
            && volume_ratio.is_some_and(|r| r <= t("volumeContractionRatio")),
    );
    flags.insert(
        "upVolumeDominant",
        up_down.is_some_and(|r| r >= t("upDownVolumeRatio")),
    );
    flags.insert(
        "distributionRisk",
        latest.close < previous.close
            && volume_ratio.is_some_and(|r| r >= t("distributionVolumeRatio")),
    );
    flags.insert(
        "lowLiquidity",
        (amount_coverage >= t("minLiquidityCoverage")
            && amount_avg.is_some_and(|v| v < t("minAverageAmount20")))
            || (amount_coverage < t("minLiquidityCoverage")
                && turnover_coverage >= t("minLiquidityCoverage")
                && turnover_avg.is_some_and(|v| v < t("minAverageTurnover20"))),
    );
    flags.insert("aboveMa20", latest.close >= ma20);
    flags.insert("ma20AboveMa60", ma20 >= ma60);
    flags.insert(
        "fallingTrend",
        latest.close < ma20 && ma20 < ma60 && ma20 < earlier_ma20,
    );
    flags.insert("breakdown", latest.close < previous_low20);
    flags.insert("highVolatility", atr_pct >= t("highVolatilityAtrPct"));
    flags.insert(
        "overextended",
        (ma20_distance >= t("maxMa20PremiumPct") || rebound >= t("maxLowReboundPct"))
            && rsi14 >= t("overboughtRsi"),
    );
    let f = |k| *flags.get(k).unwrap_or(&false);
    let s = |k| n(config, "scores", k);
    let score = |flag, key| if f(flag) { s(key) } else { 0.0 };
    let setup = if f("rsiOversold") {
        s("rsiOversold")
    } else {
        score("rsiWeak", "rsiWeak")
    } + if f("deepDrawdown") {
        s("deepDrawdown")
    } else {
        score("moderateDrawdown", "moderateDrawdown")
    } + if f("denseDownDays") {
        s("denseDownDays")
    } else {
        score("moderateDownDays", "moderateDownDays")
    } + score("nearSupport", "nearSupport");
    let confirmation = [
        ("bullishDay", "bullishDay"),
        ("reclaimMa5", "reclaimMa5"),
        ("breakPreviousHigh", "breakPreviousHigh"),
        ("positiveShortReturn", "positiveShortReturn"),
        ("volumeExpansion", "volumeExpansion"),
        ("upVolumeDominant", "upVolumeDominant"),
        ("volumeContraction", "pullbackVolumeContraction"),
    ]
    .iter()
    .map(|(a, b)| score(a, b))
    .sum::<f64>();
    let trend = score("aboveMa20", "aboveMa20") + score("ma20AboveMa60", "ma20AboveMa60");
    let risk = [
        ("fallingTrend", "fallingTrendPenalty"),
        ("breakdown", "breakdownPenalty"),
        ("highVolatility", "highVolatilityPenalty"),
        ("distributionRisk", "distributionPenalty"),
        ("lowLiquidity", "lowLiquidityPenalty"),
        ("overextended", "overextendedPenalty"),
    ]
    .iter()
    .map(|(a, b)| score(a, b))
    .sum::<f64>();
    let total = (setup + confirmation + trend - risk).clamp(0.0, 100.0);
    let d = |k| n(config, "decisions", k);
    let volume_confirmed = f("volumeExpansion") || f("upVolumeDominant");
    let (status, reason) = if f("lowLiquidity") {
        (
            "流动性不足",
            "近 20 日成交额或换手率低于流动性门槛，买入后可能难以按计划退出",
        )
    } else if f("overextended") {
        (
            "不宜追高",
            "反弹幅度、均线乖离和 RSI 显示短线偏热，等待回踩",
        )
    } else if f("breakdown") && confirmation < d("minimumConfirmationForEntry") {
        ("暂不接飞刀", "收盘跌破此前 20 日低点，且反转确认不足")
    } else if f("fallingTrend") && confirmation < d("minimumConfirmationForEntry") {
        ("等待反转确认", "价格、MA20 与 MA60 仍为空头排列")
    } else if setup >= d("minimumSetupForEntry")
        && confirmation >= d("minimumConfirmationForEntry")
        && total >= d("minimumTotalForEntry")
        && volume_confirmed
    {
        (
            "可考虑分批试仓",
            "超跌条件和价格反转确认同时成立；仍需按失效位控制风险",
        )
    } else if f("aboveMa20")
        && f("ma20AboveMa60")
        && ma20_distance.abs() <= d("ma20PullbackPct")
        && confirmation >= d("minimumConfirmationForEntry")
        && volume_confirmed
    {
        (
            "趋势回踩可观察",
            "中期趋势未坏，价格靠近 MA20 且出现短线确认",
        )
    } else if setup >= d("minimumSetupForDip") {
        ("进入观察区", "已出现一定超跌条件，但反转证据尚不足")
    } else {
        (
            "暂无清晰买点",
            "超跌或趋势回踩条件不足，等待更明确的价格结构",
        )
    };
    let evidence = [
        ("rsiOversold", "RSI14 超卖"),
        ("deepDrawdown", "20 日回撤较深"),
        ("denseDownDays", "近 10 日下跌密集"),
        ("nearSupport", "靠近 20 日低点"),
        ("bullishDay", "当日阳线且高于前收"),
        ("reclaimMa5", "重新站上 MA5"),
        ("breakPreviousHigh", "收盘突破前一日高点"),
        ("positiveShortReturn", "近 3 日转正"),
        ("volumeExpansion", "上涨伴随量能放大"),
        ("fallingTrend", "MA20/MA60 空头且 MA20 下行"),
        ("breakdown", "跌破此前 20 日低点"),
        ("highVolatility", "ATR 波动偏高"),
        ("overextended", "反弹/均线乖离偏热"),
        ("volumeContraction", "下跌缩量"),
        ("upVolumeDominant", "上涨日量能强于下跌日"),
        ("distributionRisk", "放量下跌"),
        ("lowLiquidity", "流动性不足"),
    ]
    .iter()
    .filter(|(key, _)| f(key))
    .map(|(_, label)| *label)
    .collect::<Vec<_>>();
    let compounded = recent_down.windows(2).fold(1.0, |factor, w| {
        if w[1] / w[0] < 1.0 {
            factor * w[1] / w[0]
        } else {
            factor
        }
    }) * 100.0
        - 100.0;
    Ok(
        json!({"date":latest.date,"bars":count,"close":latest.close,"decision":{"status":status,"reason":reason},"scores":{"total":total,"setup":setup,"confirmation":confirmation,"trend":trend,"riskPenalty":risk},"returns":{"day3":ret3,"day5":ret5,"day10":ret10,"day20":ret20},"decline":{"downDays10":down_days,"downDayReturn10":compounded,"consecutiveDown":consecutive,"consecutiveReturn":if consecutive>0 {pct(latest.close,closes[count-consecutive-1])}else{0.0},"drawdown20":drawdown,"rebound20":rebound,"reboundFromDate":rows[low_index].date,"reboundBars":count-1-low_index},"indicators":{"ma5":ma5,"ma10":ma10,"ma20":ma20,"ma60":ma60,"ma20SlopePct":pct(ma20,earlier_ma20),"rsi14":rsi14,"atr14":atr14,"atrPct":atr_pct,"volumeRatio":volume_ratio,"volumeShortRatio":volume_short_ratio,"latestVolume":latest.volume,"volumeMa5":volume_ma5,"volumeMa20":volume_ma20,"upDownVolumeRatio":up_down,"latestAmount":latest.amount,"amountMa20":amount_avg,"latestTurnover":latest.turnover,"turnoverMa20":turnover_avg,"liquidityCoverage":amount_coverage.max(turnover_coverage)},"levels":{"supportZone":[low20,low20+t("supportZoneAtr")*atr14],"confirmationTrigger":ma5.max(previous.high),"invalidation":low20-t("invalidationAtr")*atr14},"flags":flags,"evidence":evidence}),
    )
}

pub async fn run(state: &AppState, options: &Value) -> Result<Value> {
    let raw = super::string(options, "code");
    if raw.is_empty() {
        bail!("missing stock code; use --code");
    }
    let raw = raw.trim().to_uppercase();
    if !raw.is_ascii() {
        bail!("unsupported stock code");
    }
    let code = if raw.len() == 6 && raw.bytes().all(|b| b.is_ascii_digit()) {
        format!(
            "{raw}.{}",
            if raw.starts_with(['5', '6', '9']) {
                "SH"
            } else {
                "SZ"
            }
        )
    } else if raw.len() == 8
        && ["SH", "SZ", "BJ"].contains(&&raw[..2])
        && raw[2..].bytes().all(|b| b.is_ascii_digit())
    {
        format!("{}.{}", &raw[2..], &raw[..2])
    } else {
        raw
    };
    if !regex::Regex::new(r"^\d{6}\.(SH|SZ|BJ)$")?.is_match(&code) {
        bail!("unsupported stock code");
    }
    let as_of = if super::string(options, "asOf").is_empty() {
        Utc::now().date_naive().to_string()
    } else {
        super::string(options, "asOf").to_string()
    };
    let date = NaiveDate::parse_from_str(&as_of, "%Y-%m-%d").context("invalid as-of date")?;
    let from = if super::string(options, "from").is_empty() {
        date.with_year(date.year() - 1)
            .unwrap_or_else(|| NaiveDate::from_ymd_opt(date.year() - 1, 2, 28).unwrap())
            .to_string()
    } else {
        NaiveDate::parse_from_str(super::string(options, "from"), "%Y-%m-%d")
            .context("invalid from date")?
            .to_string()
    };
    let config_path = if super::string(options, "config").is_empty() {
        "web/src/config/buy-point-analysis.json"
    } else {
        super::string(options, "config")
    };
    let config = super::read_config(state, config_path)?;
    let rows = super::api(
        state,
        "/api/kline",
        &[
            ("code".into(), code.clone()),
            ("period".into(), "day".into()),
            ("fq".into(), "qfq".into()),
            ("from".into(), from.clone()),
            ("to".into(), as_of.clone()),
        ],
    )
    .await?;
    let mut result = analyze(rows.as_array().context("invalid K-line response")?, &config)?;
    let object = result.as_object_mut().unwrap();
    object.insert("code".into(), json!(code));
    object.insert("source".into(), json!("xueqiu"));
    object.insert("from".into(), json!(from));
    object.insert("to".into(), json!(as_of));
    Ok(result)
}

fn formatted(v: &Value, places: usize) -> String {
    finite(v)
        .map(|n| {
            ryu_js::Buffer::new()
                .format_to_fixed(n, places as u8)
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}
fn price(v: &Value) -> String {
    let n = finite(v).unwrap_or(0.0);
    formatted(
        v,
        if n >= 100.0 {
            2
        } else if n >= 10.0 {
            3
        } else {
            4
        },
    )
}
fn percent(v: &Value, signed: bool) -> String {
    let n = finite(v).unwrap_or(0.0);
    format!(
        "{}{}%",
        if signed && n > 0.0 { "+" } else { "" },
        formatted(v, 2)
    )
}
fn compact(v: &Value) -> String {
    match finite(v) {
        None => "—".into(),
        Some(n) if n >= 100_000_000.0 => format!("{} 亿", formatted(&json!(n / 100_000_000.0), 2)),
        Some(n) if n >= 10000.0 => format!("{} 万", formatted(&json!(n / 10000.0), 2)),
        Some(n) => formatted(&json!(n), 0),
    }
}
fn nullable_percent(v: &Value) -> String {
    if v.is_null() {
        "—".into()
    } else {
        percent(v, false)
    }
}
fn times(v: &Value) -> String {
    if v.is_null() {
        "—".into()
    } else {
        format!("{} 倍", formatted(v, 2))
    }
}
pub fn render_text(r: &Value) -> String {
    let d = &r["decline"];
    let i = &r["indicators"];
    let returns = &r["returns"];
    let l = &r["levels"];
    let s = &r["scores"];
    let f = &r["flags"];
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    let evidence = r["evidence"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("；")
        })
        .unwrap_or_default();
    [
 format!("{} 买点分析（{}，前复权日 K，{} 根）",text(&r["code"]),text(&r["date"]),r["bars"]),
 format!("结论：{} — {}",text(&r["decision"]["status"]),text(&r["decision"]["reason"])),
 format!("成熟度：{}/100（超跌 {} + 确认 {} + 趋势 {} - 风险 {}）",formatted(&s["total"],0),formatted(&s["setup"],0),formatted(&s["confirmation"],0),formatted(&s["trend"],0),formatted(&s["riskPenalty"],0)),String::new(),
 format!("价格：收盘 {}；3/5/10/20 日涨跌 {} / {} / {} / {}",price(&r["close"]),percent(&returns["day3"],true),percent(&returns["day5"],true),percent(&returns["day10"],true),percent(&returns["day20"],true)),
 format!("下跌：近 10 日 {} 天下跌，下跌日复合 {}；连续下跌 {} 天（{}）",d["downDays10"],percent(&d["downDayReturn10"],true),d["consecutiveDown"],percent(&d["consecutiveReturn"],true)),
 format!("反弹/回撤：20 日高点回撤 {}；自 {} 低点以来 {} 个交易日反弹 {}",percent(&d["drawdown20"],true),text(&d["reboundFromDate"]),d["reboundBars"],percent(&d["rebound20"],true)),
 format!("均线：MA5 {}，MA10 {}，MA20 {}，MA60 {}；MA20 近 5 日斜率 {}",price(&i["ma5"]),price(&i["ma10"]),price(&i["ma20"]),price(&i["ma60"]),percent(&i["ma20SlopePct"],true)),
 format!("动量/风险：RSI14 {}；ATR14 {}（{}）",formatted(&i["rsi14"],1),price(&i["atr14"]),percent(&i["atrPct"],false)),
 format!("量能：当日/20日均量 {}；5日/20日均量 {}；上涨日/下跌日均量 {}",times(&i["volumeRatio"]),times(&i["volumeShortRatio"]),times(&i["upDownVolumeRatio"])),
 format!("流动性：当日成交额 {}；20日平均成交额 {}；当日换手率 {}；20日平均换手率 {}；数据覆盖 {}",compact(&i["latestAmount"]),compact(&i["amountMa20"]),nullable_percent(&i["latestTurnover"]),nullable_percent(&i["turnoverMa20"]),percent(&json!(finite(&i["liquidityCoverage"]).unwrap_or(0.0)*100.0),false)),
 format!("量价风险：{}；{}；{}",if f["volumeContraction"]==true{"下跌缩量"}else{"未出现下跌缩量"},if f["distributionRisk"]==true{"放量下跌"}else{"未触发放量下跌"},if f["lowLiquidity"]==true{"流动性不足"}else if finite(&i["liquidityCoverage"]).unwrap_or(0.0)>0.0{"流动性门槛通过"}else{"流动性数据不足"}),String::new(),
 format!("20 日支撑观察区：{}–{}",price(&l["supportZone"][0]),price(&l["supportZone"][1])),
 format!("右侧确认触发：下一收盘有效站上 {}（MA5 与前一日高点取较高值）",price(&l["confirmationTrigger"])),
 format!("参考失效位：{}（20 日低点下方 1×ATR；触发后停止加仓并重新评估）",price(&l["invalidation"])),
 format!("当前证据：{}",if evidence.is_empty(){"无显著信号"}else{&evidence}),String::new(),
 "执行纪律：先等收盘确认，计划分批买入时用“单笔可承受亏损 ÷（计划买价−失效位）”反推仓位；不要因下跌继续无上限补仓。".into(),
 "提示：这是基于历史价格与成交量的规则化观察，不包含估值、基本面、事件风险和个人资金约束，不构成投资建议。".into(),
 ].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn compare(a: &Value, b: &Value, path: &str) {
        if let (Some(a), Some(b)) = (a.as_f64(), b.as_f64()) {
            assert!(
                (a - b).abs() <= 1e-10 * a.abs().max(b.abs()).max(1.0),
                "{path}: {a} != {b}"
            );
        } else if let (Some(a), Some(b)) = (a.as_object(), b.as_object()) {
            assert_eq!(a.len(), b.len(), "{path}");
            for (k, v) in a {
                compare(v, &b[k], &format!("{path}.{k}"));
            }
        } else if let (Some(a), Some(b)) = (a.as_array(), b.as_array()) {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                compare(a, b, &format!("{path}[{i}]"));
            }
        } else {
            assert_eq!(a, b, "{path}");
        }
    }
    #[test]
    fn original_typescript_full_output_goldens() {
        let fixture: Value = serde_json::from_str(include_str!("buy_point/golden.json")).unwrap();
        let config = &fixture["config"];
        for case in fixture["cases"].as_array().unwrap() {
            let mut result = analyze(case["rows"].as_array().unwrap(), config).unwrap();
            compare(&result, &case["expected"], case["name"].as_str().unwrap());
            result["code"] = json!("300308.SZ");
            assert_eq!(
                render_text(&result),
                case["expectedText"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn rejects_missing_or_unusable_bars() {
        let config: Value = serde_json::from_str(include_str!(
            "../../../web/src/config/buy-point-analysis.json"
        ))
        .unwrap();
        assert!(
            analyze(&[], &config)
                .unwrap_err()
                .to_string()
                .contains("65 usable")
        );
        assert!(normalize(&[json!({"date":"x","close":0,"open":2,"high":3,"low":1})]).is_empty());
    }
    #[test]
    fn normalization_deduplicates_dates_and_keeps_latest() {
        let rows = normalize(&[
            json!([0, 1, 2, 3, 1, 5, 6, 7]),
            json!({"date":"1970-01-01","close":"2","open":2,"high":3,"low":1,"volume":null}),
            json!({"date":"1969-01-01","close":2,"open":2,"high":3,"low":1}),
        ]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].close, 2.0);
        assert_eq!(rows[1].volume, None);
    }
}
