//! Stateless offline analysis bridge. No database, credentials or providers.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}
fn fields() -> Value {
    json!({"pe_ttm":{"seriesKey":"peTtm","label":"PE(TTM)"},"pb":{"seriesKey":"pb","label":"PB"},"ps_ttm":{"seriesKey":"ps","label":"PS"}})
}

pub fn evaluate(input: &Value) -> Result<Value> {
    if let Some(items) = input.as_array() {
        return items
            .iter()
            .map(evaluate)
            .collect::<Result<Vec<_>>>()
            .map(Value::from);
    }
    Ok(
        match input["op"].as_str().context("analysis op required")? {
            "screen" => crate::dashboard::domain::screen(&input["input"]),
            "point-in-time" => json!(crate::dashboard::point_in_time::build(
                list(&input["statements"]),
                list(&input["marketCaps"]),
                input["options"]["ceiling"].as_f64().unwrap_or(300.0)
            )),
            "snapshot" => snapshot(&input["readModel"], &input["companyId"]),
            "diff" => diff(&input["previous"], &input["current"]),
            "constants" => json!({"fields":fields(),"minimumCoverage":0.25}),
            "usable-values" => json!(usable(&input["values"], text(&input["seriesKey"]))),
            "filter-values" => json!(filter_values(&input["values"], text(&input["seriesKey"]))),
            "quantile" => {
                let sorted = list(&input["sorted"]).iter().map(num).collect::<Vec<_>>();
                let q = num(&input["q"]);
                if sorted.is_empty() || !q.is_finite() || !(0.0..=1.0).contains(&q) {
                    Value::Null
                } else {
                    json!(quantile(&sorted, q))
                }
            }
            "distribution" => distribution(&input["values"], text(&input["seriesKey"])),
            "excludes-history" => json!(num(&input["coverage"]["shareInsideBand"]) < 0.25),
            "selftest" => crate::retired_selftest_bridge::evaluate(
                text(&input["function"]),
                list(&input["args"]),
            )?,
            "band-coverage" => coverage(text(&input["band"]), &input["range"], &input["sorted"]),
            "option-greeks" => option_greeks(&input["contract"])?,
            "option-implied-vol" => option_implied_vol(&input["contract"])?,
            unknown => bail!("unknown analysis op: {unknown}"),
        },
    )
}
fn filter_values(values: &Value, series: &str) -> Vec<f64> {
    let ceiling = match series {
        "pb" => 50.0,
        "ps" => 60.0,
        _ => 300.0,
    };
    list(values)
        .iter()
        .filter_map(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= ceiling)
        .collect::<Vec<_>>()
}
fn usable(values: &Value, series: &str) -> Vec<f64> {
    let mut out = filter_values(values, series);
    out.sort_by(f64::total_cmp);
    out
}
fn distribution(values: &Value, series: &str) -> Value {
    let sorted = usable(values, series);
    if sorted.is_empty() {
        return Value::Null;
    }
    json!({"samples":sorted.len(),"p10":quantile(&sorted,0.1),"p25":quantile(&sorted,0.25),"median":quantile(&sorted,0.5),"p75":quantile(&sorted,0.75),"p90":quantile(&sorted,0.9)})
}
fn quantile(sorted: &[f64], q: f64) -> f64 {
    let p = (sorted.len() - 1) as f64 * q;
    let lo = p.floor() as usize;
    let hi = p.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo as f64)
}
fn coverage(band: &str, range: &Value, sorted: &Value) -> Value {
    let field = fields()[band].clone();
    if field.is_null() || list(sorted).is_empty() {
        return Value::Null;
    }
    let values = usable(sorted, text(&field["seriesKey"]));
    if values.is_empty() {
        return Value::Null;
    }
    let low = num(&range["low"]);
    let high = num(&range["high"]);
    // Preserve the original caller contract: coverage counts the supplied sorted
    // observations; distribution separately excludes invalid multiples.
    let raw = list(sorted).iter().map(num).collect::<Vec<_>>();
    let first = raw.partition_point(|n| *n < low);
    let end = raw.partition_point(|n| *n <= high);
    let share = (end as f64 - first as f64) / raw.len() as f64;
    let median = quantile(&values, 0.5);
    json!({"band":band,"label":field["label"],"currentDefault":range,"observed":{"samples":values.len(),"p10":quantile(&values,0.1),"p25":quantile(&values,0.25),"median":median,"p75":quantile(&values,0.75),"p90":quantile(&values,0.9)},"shareInsideBand":share,"displacement":if median>high{"band_below_history"}else if median<low{"band_above_history"}else{"straddles_history"},"midpointVsMedian":((low+high)/2.0)/median,"underCoversHistory":share<0.25})
}
fn snapshot(model: &Value, id: &Value) -> Value {
    json!({"companyId":id,"code":model["code"],"archetype":model["archetype"],"asOf":model["asOf"],"bands":list(&model["bands"]).iter().map(|b|json!({"key":b["key"],"status":b["status"],"role":b["role"],"range":if b["range"].is_null(){Value::Null}else{json!({"low":b["range"]["low"],"high":b["range"]["high"]})},"unit":b["unit"],"denominator":if b["denominator"].is_null(){Value::Null}else{json!({"basis":b["denominator"]["basis"],"reportDate":b["denominator"]["reportDate"],"value":b["denominator"]["value"]})},"missingInputs":b["missingInputs"]})).collect::<Vec<_>>()})
}
fn find<'a>(rows: &'a Value, field: &str, key: &Value) -> Option<&'a Value> {
    list(rows).iter().rev().find(|row| row[field] == *key)
}
/// Shared contract for the option ops: a single priced contract in, greeks out.
///
/// Input:
/// `{"kind":"put","spot":1.326,"strike":1.20,"expiry":"2026-12-23","asOf":"2026-11-09",
///   "rate":0.015,"dividendYield":0,"price":0.0499}`
///
/// `expiry`/`asOf` are `YYYY-MM-DD`; `timeToExpiry` (years) may be supplied
/// instead when no as-of date is meaningful. `price` is the quote used for the
/// implied volatility op; pricing ops ignore it.
fn contract(input: &Value) -> Result<Contract, anyhow::Error> {
    let kind = text(&input["kind"]);
    let kind = crate::option_math::OptionKind::parse(kind)
        .ok_or_else(|| anyhow::anyhow!("contract.kind must be call or put, got {kind:?}"))?;
    let number = |name: &str, fallback: f64| -> Result<f64, anyhow::Error> {
        match input.get(name) {
            None | Some(Value::Null) => Ok(fallback),
            Some(_) => {
                let value = num(&input[name]);
                if value.is_finite() {
                    Ok(value)
                } else {
                    Err(anyhow::anyhow!("contract.{name} must be a finite number"))
                }
            }
        }
    };
    let spot = number("spot", 0.0)?;
    let strike = number("strike", 0.0)?;
    if spot <= 0.0 || strike <= 0.0 {
        return Err(anyhow::anyhow!(
            "contract.spot and contract.strike must be positive"
        ));
    }
    let rate = number("rate", 0.0)?;
    let dividend_yield = number("dividendYield", 0.0)?;
    let time_to_expiry = match input.get("timeToExpiry") {
        Some(value) if !value.is_null() => number("timeToExpiry", 0.0)?,
        _ => {
            let expiry = chrono::NaiveDate::parse_from_str(text(&input["expiry"]), "%Y-%m-%d")
                .map_err(|_| {
                    anyhow::anyhow!(
                        "contract.expiry must be YYYY-MM-DD when timeToExpiry is absent"
                    )
                })?;
            let as_of = chrono::NaiveDate::parse_from_str(text(&input["asOf"]), "%Y-%m-%d")
                .map_err(|_| {
                    anyhow::anyhow!("contract.asOf must be YYYY-MM-DD when timeToExpiry is absent")
                })?;
            (expiry - as_of).num_days().max(0) as f64 / 365.0
        }
    };
    Ok(Contract {
        kind,
        spot,
        strike,
        time_to_expiry,
        rate,
        dividend_yield,
        price: number("price", f64::NAN).unwrap_or(f64::NAN),
        volatility: number("volatility", f64::NAN).unwrap_or(f64::NAN),
    })
}

struct Contract {
    kind: crate::option_math::OptionKind,
    spot: f64,
    strike: f64,
    time_to_expiry: f64,
    rate: f64,
    dividend_yield: f64,
    price: f64,
    volatility: f64,
}

impl Contract {
    fn greeks(&self, volatility: f64) -> crate::option_math::Greeks {
        crate::option_math::black_scholes(
            self.kind,
            self.spot,
            self.strike,
            self.time_to_expiry,
            self.rate,
            self.dividend_yield,
            volatility,
        )
    }
}

fn option_greeks(input: &Value) -> Result<Value, anyhow::Error> {
    let contract = contract(input)?;
    let implied = if contract.volatility.is_finite() && contract.volatility > 0.0 {
        Some(contract.volatility)
    } else if contract.price.is_finite() && contract.price > 0.0 {
        crate::option_math::implied_volatility(
            contract.kind,
            contract.spot,
            contract.strike,
            contract.time_to_expiry,
            contract.rate,
            contract.dividend_yield,
            contract.price,
        )
    } else {
        None
    };
    let Some(volatility) = implied else {
        return Ok(json!({"kind":contract.kind.as_code(),"volatility":null,"greeks":null}));
    };
    let g = contract.greeks(volatility);
    Ok(json!({
        "kind":contract.kind.as_code(),
        "volatility":volatility,
        "timeToExpiry":contract.time_to_expiry,
        "moneyness":contract.spot / contract.strike,
        "greeks":{
            "price":g.price,
            "delta":g.delta,
            "gamma":g.gamma,
            "vega":g.vega,
            "theta":g.theta,
            "thetaPerDay":g.theta / 365.0,
            "vegaPerPoint":g.vega / 100.0,
            "rho":g.rho
        }
    }))
}

fn option_implied_vol(input: &Value) -> Result<Value, anyhow::Error> {
    let contract = contract(input)?;
    if !(contract.price.is_finite() && contract.price > 0.0) {
        return Err(anyhow::anyhow!("contract.price must be a positive quote"));
    }
    Ok(json!({
        "kind":contract.kind.as_code(),
        "volatility":crate::option_math::implied_volatility(
            contract.kind,
            contract.spot,
            contract.strike,
            contract.time_to_expiry,
            contract.rate,
            contract.dividend_yield,
            contract.price,
        ),
        "timeToExpiry":contract.time_to_expiry
    }))
}
fn js(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.to_string()
    } else if let Some(n) = v.as_f64() {
        ryu_js::Buffer::new().format(n).to_string()
    } else {
        v.to_string()
    }
}
fn fixed(v: f64) -> String {
    ryu_js::Buffer::new().format_to_fixed(v, 2).to_string()
}
fn describe_range(b: &Value) -> String {
    if b["range"].is_null() {
        "—".into()
    } else {
        format!(
            "{}–{}{}",
            js(&b["range"]["low"]),
            js(&b["range"]["high"]),
            if b["unit"] == "percent" { "%" } else { "x" }
        )
    }
}
fn describe(b: &Value) -> String {
    if b["status"] != "available" {
        js(&b["status"])
    } else {
        format!("{}（{}）", describe_range(b), js(&b["role"]))
    }
}
fn denominator(d: &Value) -> String {
    if d.is_null() {
        return "—".into();
    }
    let v = num(&d["value"]);
    let amount = if v.abs() >= 1e8 {
        format!("{} 亿", fixed(v / 1e8))
    } else if v.abs() >= 1e4 {
        format!("{} 万", fixed(v / 1e4))
    } else {
        fixed(v)
    };
    format!("{}@{}（{}）", js(&d["basis"]), js(&d["reportDate"]), amount)
}
fn date(v: &Value) -> bool {
    crate::dashboard::point_in_time::date(text(v)).is_some()
}
fn advanced(a: &Value, b: &Value) -> bool {
    date(a) && date(b) && text(b) > text(a)
}
fn change(
    now: &Value,
    band: &Value,
    kind: &str,
    attribution: &str,
    from: String,
    to: String,
    note: String,
) -> Value {
    json!({"companyId":now["companyId"],"code":now["code"],"band":band,"kind":kind,"attribution":attribution,"from":from,"to":to,"note":note})
}
fn unique(rows: &Value, key: &str) -> Value {
    let mut out: Vec<Value> = Vec::new();
    for row in list(rows) {
        if let Some(index) = out.iter().position(|old| old[key] == row[key]) {
            out[index] = row.clone();
        } else {
            out.push(row.clone());
        }
    }
    Value::Array(out)
}
fn diff(previous: &Value, current: &Value) -> Value {
    let before_rows = unique(&previous["companies"], "companyId");
    let after_rows = unique(&current["companies"], "companyId");
    let before = &before_rows;
    let after = &after_rows;
    let added = list(after)
        .iter()
        .filter(|c| find(before, "companyId", &c["companyId"]).is_none())
        .map(|c| c["companyId"].clone())
        .collect::<Vec<_>>();
    let removed = list(before)
        .iter()
        .filter(|c| find(after, "companyId", &c["companyId"]).is_none())
        .map(|c| c["companyId"].clone())
        .collect::<Vec<_>>();
    let mut changes = Vec::new();
    let mut unchanged = Vec::new();
    let mut compared = 0;
    for now in list(after) {
        let Some(then) = find(before, "companyId", &now["companyId"]) else {
            continue;
        };
        compared += 1;
        let initial = changes.len();
        let then_bands = unique(&then["bands"], "key");
        let now_bands = unique(&now["bands"], "key");
        if then["archetype"] != now["archetype"] {
            changes.push(change(now,&json!("archetype"),"archetype_changed","model",js(&then["archetype"]),js(&now["archetype"]),format!("原型从 {} 变为 {}：可用方法集随之改变，这一条是分类口径变化，不是公司经营变化。",js(&then["archetype"]),js(&now["archetype"]))));
        }
        for b in list(&now_bands) {
            let key = &b["key"];
            if let Some(a) = find(&then_bands, "key", key) {
                diff_band(now, a, b, &mut changes);
            } else {
                changes.push(change(
                    now,
                    key,
                    "appeared",
                    "model",
                    "—".into(),
                    describe(b),
                    format!(
                        "{} 是新出现的方法：原型或输入要求变了，不是公司新增了这个口径。",
                        js(key)
                    ),
                ));
            }
        }
        for a in list(&then_bands) {
            if find(&now_bands, "key", &a["key"]).is_none() {
                changes.push(change(
                    now,
                    &a["key"],
                    "disappeared",
                    "model",
                    describe(a),
                    "—".into(),
                    format!(
                        "{} 不再输出：方法集变了。缺失不等于该公司不再适用，需回看原型。",
                        js(&a["key"])
                    ),
                ));
            }
        }
        if changes.len() == initial {
            unchanged.push(now["companyId"].clone());
        }
    }
    json!({"from":previous["asOf"],"to":current["asOf"],"changes":changes,"compared":compared,"unchanged":unchanged,"added":added,"removed":removed})
}
fn diff_band(now: &Value, a: &Value, b: &Value, out: &mut Vec<Value>) {
    let key = &b["key"];
    let k = js(key);
    let ad = &a["denominator"];
    let bd = &b["denominator"];
    if a["status"] != b["status"] {
        let quote = !list(&b["missingInputs"]).is_empty()
            && list(&b["missingInputs"]).iter().all(|v| {
                text(v).contains("市值") || text(v).contains("价格") || text(v).contains("行情")
            });
        let attr = if b["status"] == "forbidden_for_archetype" {
            "model"
        } else if quote {
            "price_source"
        } else if advanced(&ad["reportDate"], &bd["reportDate"]) {
            "filing"
        } else if ad["reportDate"] != bd["reportDate"] {
            "model"
        } else {
            "unattributed"
        };
        let kind = if b["status"] == "available" {
            "became_available"
        } else if b["status"] == "forbidden_for_archetype" {
            "became_forbidden"
        } else {
            "became_unavailable"
        };
        let note = match kind {
            "became_forbidden" => format!("该方法被原型 {k} 禁用：这是口径规则，不是数据不足。"),
            "became_available" => if attr == "filing" {
                "新一期报告让分母成立：区间复位，需按新报告期复核。"
            } else {
                "输入补齐后区间重新成立；先确认补齐的是财报数据还是行情。"
            }
            .into(),
            _ => match attr {
                "price_source" => "只有行情类输入缺失：这是行情源不可用，不是估值变化。",
                "filing" => "新一期报告改变了分母，区间不再成立；按同一口径核对后再用。",
                _ => "区间不再成立，但快照无法归因（既非行情缺失也非报告期变化），需人工核对。",
            }
            .into(),
        };
        out.push(change(
            now,
            key,
            kind,
            attr,
            js(&a["status"]),
            js(&b["status"]),
            note,
        ));
    }
    if ad.is_null() != bd.is_null()
        || (!ad.is_null()
            && !bd.is_null()
            && ["basis", "reportDate", "value"]
                .iter()
                .any(|k| ad[*k] != bd[*k]))
    {
        let filed = advanced(&ad["reportDate"], &bd["reportDate"]);
        let basis = !ad.is_null() && !bd.is_null() && ad["basis"] != bd["basis"];
        let repaired = !filed && date(&ad["reportDate"]) != date(&bd["reportDate"]);
        let attr = if basis || repaired {
            "model"
        } else if filed {
            "filing"
        } else {
            "unattributed"
        };
        let note = if basis {
            format!(
                "{k} 的分母口径从 {} 改为 {}：口径变更，跨版本不可直接比较。",
                js(&ad["basis"]),
                js(&bd["basis"])
            )
        } else if repaired {
            format!(
                "{k} 的分母锚点从「{}」变为「{}」：原先缺少可解析的报告期，属口径修正，不是公司披露新报告。",
                if text(&ad["reportDate"]).is_empty() {
                    "空"
                } else {
                    text(&ad["reportDate"])
                },
                if text(&bd["reportDate"]).is_empty() {
                    "空"
                } else {
                    text(&bd["reportDate"])
                }
            )
        } else if filed {
            format!(
                "{k} 的分母已换到 {} 报告期：公司披露了新一期报告，倍数不变但锚点变了。",
                js(&bd["reportDate"])
            )
        } else {
            format!("{k} 的分母数值变化（可能是同一报告期的追溯调整），需人工确认为何变化。")
        };
        out.push(change(
            now,
            key,
            "denominator_changed",
            attr,
            denominator(ad),
            denominator(bd),
            note,
        ));
    }
    if (a["range"].is_null() != b["range"].is_null()
        || (!a["range"].is_null()
            && !b["range"].is_null()
            && ["low", "high"]
                .iter()
                .any(|k| a["range"][*k] != b["range"][*k])))
        && a["status"] == "available"
        && b["status"] == "available"
    {
        out.push(change(
            now,
            key,
            "range_changed",
            "model",
            describe_range(a),
            describe_range(b),
            format!(
                "{k} 的区间倍数变了：这是估值模型默认值的调整（模型变更），不是公司基本面变化。"
            ),
        ));
    }
    if a["role"] != b["role"] {
        out.push(change(
            now,
            key,
            "role_changed",
            "model",
            js(&a["role"]),
            js(&b["role"]),
            format!(
                "{k} 从 {} 变为 {}：这是估值模型对该原型的角色设定调整，不是公司披露变化。",
                js(&a["role"]),
                js(&b["role"])
            ),
        ));
    }
}
