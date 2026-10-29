//! Conservative, dated method bands. A missing denominator is never fabricated.
use serde_json::{Value, json};

const DISCLAIMER: &str = "保守区间是研究方法输入，不是目标价、不是买卖指令；区间只对所列假设成立。";

fn positive(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
}
fn dated(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn entry(key: &str) -> (f64, f64, &'static str, &'static str) {
    match key {
        "pe_ttm" => (
            8.0,
            18.0,
            "multiple",
            "TTM 口径，未做周期调整；仅适用于利润为正且可持续的公司。",
        ),
        "pe_forward" => (
            10.0,
            22.0,
            "multiple",
            "前瞻口径依赖盈利预测，预测来源必须写明。",
        ),
        "ev_ebit" => (
            8.0,
            16.0,
            "multiple",
            "EV/EBIT 对资本密度不敏感，可作为 EV/EBITDA 的交叉检验。",
        ),
        "ev_ebitda" => (
            5.0,
            11.0,
            "multiple",
            "EV/EBITDA 高度依赖资本密度，跨公司比较前必须确认折旧/EBIT 量级相近。",
        ),
        "ev_ebitda_light" => (
            14.0,
            28.0,
            "multiple",
            "轻资本（折旧/EBIT < 0.5）：EBITDA 与 EBIT 几乎同量级，倍数自然更高，不能用重资本区间衡量。",
        ),
        "ev_ebitda_medium" => (9.0, 18.0, "multiple", "中等资本密度（折旧/EBIT 0.5–1）。"),
        "ev_ebitda_heavy" => (
            5.0,
            11.0,
            "multiple",
            "重资本（折旧/EBIT > 1）：折旧摊销吞掉大部分利润，EV/EBITDA 与 EV/EBIT 必须并列。",
        ),
        "ev_revenue" => (
            0.6,
            2.4,
            "multiple",
            "EV/营业收入只在无正利润阶段使用，利润率恢复后失效。",
        ),
        "pb" => (
            0.8,
            2.5,
            "multiple",
            "PB 使用扣除其他权益工具后的普通股股东权益；必须与 ROE 一起看，单独使用的 PB 区间没有信息量。",
        ),
        "fcf_yield" => (
            3.0,
            6.0,
            "percent",
            "自由现金流收益率下限体现机会成本，上限体现不确定性打折。",
        ),
        "dividend_yield" => (
            2.5,
            5.0,
            "percent",
            "股息率必须以可持续分红为前提，一次性特别股息不计入门槛。",
        ),
        "pe_mid_cycle" => (
            8.0,
            15.0,
            "multiple",
            "周期中枢 PE 以 5–10 年年报利润中位数为分母，上限低于 TTM PE 区间，因为中枢本身已含周期不确定性。",
        ),
        "ev_ebit_mid_cycle" => (
            7.0,
            14.0,
            "multiple",
            "周期中枢 EV/EBIT，与 EV/EBITDA 相比对重资产周期更稳健。",
        ),
        _ => unreachable!("unknown band key"),
    }
}
fn range_key<'a>(key: &'a str, input: &Value) -> &'a str {
    if key != "ev_ebitda" {
        return key;
    }
    match input["capitalIntensity"]["depreciationToEbit"]
        .as_f64()
        .filter(|v| v.is_finite())
    {
        Some(v) if v < 0.5 => "ev_ebitda_light",
        Some(v) if v <= 1.0 => "ev_ebitda_medium",
        Some(_) => "ev_ebitda_heavy",
        None => key,
    }
}
fn range(key: &str) -> Value {
    let (low, high, _, _) = entry(key);
    json!({"low":low,"high":high})
}
fn implied(value: f64, key: &str, metric: &str) -> Value {
    let (low, high, _, _) = entry(key);
    json!({"metric":metric,"low":value*low,"high":value*high,"source":"derived_from_denominator"})
}
fn forbidden(key: &str, label: &str, role: &str, archetype: &str, reason: &str) -> Value {
    json!({"key":key,"label":label,"role":role,"status":"forbidden_for_archetype","range":null,"unit":null,
        "denominator":null,"implied":null,"assumptions":[],"missingInputs":[],"reasons":[reason,format!("原型 {archetype} 的禁用规则见 docs/investment-valuation-coverage.md。")]})
}
struct Multiple<'a> {
    key: &'a str,
    label: &'a str,
    role: &'a str,
    basis: &'a str,
    value: &'a Value,
    date: &'a Value,
    market_cap: &'a Value,
    missing: Vec<&'a str>,
    assumptions: Vec<&'a str>,
}
fn multiple(input: Multiple<'_>) -> Value {
    let usable = positive(input.value);
    let mut missing = Vec::new();
    if !usable {
        missing.push("分母（值为负或缺失）");
    }
    missing.extend(input.missing);
    if !positive(input.market_cap) {
        missing.push("市值（用于隐含值）");
    }
    let mut assumptions = vec![entry(input.key).3];
    assumptions.extend(input.assumptions);
    json!({"key":input.key,"label":input.label,"role":input.role,
        "status":if usable {"available"} else {"insufficient_data"},
        "range":if usable {range(input.key)} else {Value::Null},
        "unit":if usable {json!(entry(input.key).2)} else {Value::Null},
        "denominator":if usable && dated(input.date) {json!({"basis":input.basis,"value":input.value,"reportDate":input.date})} else {Value::Null},
        "implied":if usable && positive(input.market_cap) {implied(input.value.as_f64().unwrap(),input.key,"market_cap")} else {Value::Null},
        "assumptions":assumptions,"missingInputs":missing,"reasons":[]})
}
fn enterprise(
    input: &Value,
    key: &str,
    label: &str,
    role: &str,
    basis: &str,
    value: &Value,
) -> Value {
    let usable = positive(value);
    let range_key = range_key(key, input);
    let debt = &input["balance"]["grossDebt"];
    let cash = &input["balance"]["cash"];
    let incomplete = input["balance"]["debtIncomplete"] == true;
    let ev_ready = !debt.is_null() && !cash.is_null() && !incomplete;
    let mut missing = Vec::new();
    if !usable {
        missing.push("分母（值为负或缺失）");
    }
    if debt.is_null() {
        missing.push("有息负债");
    }
    if cash.is_null() {
        missing.push("现金及等价物");
    }
    if incomplete {
        missing.push("完整有息负债科目");
    }
    if !positive(&input["marketCap"]) {
        missing.push("市值（用于隐含值）");
    }
    let mut assumptions = vec![
        entry(range_key).3,
        "EV = 市值 + 有息负债 − 现金；有息负债缺失时不计算 EV，而不是当作零。",
    ];
    if !input["balance"]["minorityEquity"].is_null() {
        assumptions.push("未将少数股东权益计入 EV；跨公司比较时需统一口径。");
    }
    json!({"key":key,"label":label,"role":role,"status":if usable {"available"} else {"insufficient_data"},
        "range":if usable {range(range_key)} else {Value::Null},"unit":if usable {json!("multiple")} else {Value::Null},
        "denominator":if usable && dated(&input["asOf"]["income"]) {json!({"basis":basis,"value":value,"reportDate":input["asOf"]["income"]})} else {Value::Null},
        "implied":if usable && positive(&input["marketCap"]) && ev_ready {implied(value.as_f64().unwrap(),range_key,"enterprise_value")} else {Value::Null},
        "assumptions":assumptions,"missingInputs":missing,"reasons":[]})
}
fn mid_cycle(input: &Value) -> Value {
    let mid = &input["midCycle"];
    let usable = mid["status"] == "available" && positive(&mid["median"]);
    let mut missing = Vec::new();
    if mid.is_null() {
        missing.push("周期中枢利润（5–10 年年报）");
    }
    if mid["status"] == "insufficient_data" {
        missing.push("足够长的年报历史");
    }
    if !usable && !mid.is_null() {
        missing.push("中枢利润为正");
    }
    if !positive(&input["marketCap"]) {
        missing.push("市值（用于隐含值）");
    }
    let anchor = mid["years"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|year| year["reportDate"].as_str())
        .max()
        .filter(|date| !date.is_empty());
    if anchor.is_none() {
        missing.push("中枢窗口内没有可用的年报报告期");
    }
    let available = usable && anchor.is_some();
    let mut assumptions = vec![
        json!(entry("pe_mid_cycle").3),
        json!("分母取年报利润中位数；缺失年度不插值，亏损年度保留。"),
    ];
    if let Some(window) = mid["window"].as_str().filter(|s| !s.is_empty()) {
        assumptions.push(json!(format!("中枢窗口 {window}。")));
    }
    assumptions.extend(mid["notes"].as_array().into_iter().flatten().cloned());
    json!({"key":"pe_mid_cycle","label":"PE（周期中枢利润）","role":"primary","status":if available {"available"} else {"insufficient_data"},
        "range":if available {range("pe_mid_cycle")} else {Value::Null},"unit":if available {json!("multiple")} else {Value::Null},
        "denominator":if available {json!({"basis":"net_income_mid_cycle","value":mid["median"],"reportDate":anchor})} else {Value::Null},
        "implied":if available && positive(&input["marketCap"]) {implied(mid["median"].as_f64().unwrap(),"pe_mid_cycle","market_cap")} else {Value::Null},
        "assumptions":assumptions,"missingInputs":missing,"reasons":[]})
}
fn yield_band(input: &Value) -> Value {
    let flow = &input["ttm"]["freeCashFlow"];
    let date = if input["asOf"]["cashflow"].is_null() {
        &input["asOf"]["income"]
    } else {
        &input["asOf"]["cashflow"]
    };
    let usable = positive(flow);
    let available = usable && positive(&input["marketCap"]) && dated(date);
    let mut missing = Vec::new();
    if flow.is_null() {
        missing.push("自由现金流（经营现金流 − 资本开支）");
    }
    if !positive(&input["marketCap"]) {
        missing.push("市值");
    }
    if !dated(date) {
        missing.push("现金流报告期");
    }
    json!({"key":"fcf_yield","label":"自由现金流收益率","role":"primary",
        "status":if available {"available"} else {"insufficient_data"},"range":if available {range("fcf_yield")} else {Value::Null},
        "unit":if available {json!("percent")} else {Value::Null},"denominator":if usable && dated(date) {json!({"basis":"free_cash_flow_ttm","value":flow,"reportDate":date})} else {Value::Null},
        "implied":null,"assumptions":[entry("fcf_yield").3,"收益率区间是门槛值，不是对当前价格的判断。"],"missingInputs":missing,"reasons":[]})
}

/// Preserves the TypeScript `buildValuationBands` contract, including method
/// prohibitions and availability being separate from optional quote diagnostics.
pub fn build(input: &Value) -> Value {
    let archetype = input["archetype"].as_str().unwrap_or("other");
    let cyclical = archetype == "cyclical_commodity";
    let financial = ["bank", "insurer", "broker"].contains(&archetype);
    let market_cap = &input["marketCap"];
    let mut bands = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if archetype == "pre_profit_milestone" {
        bands.push(forbidden(
            "pe_ttm",
            "PE(TTM)",
            "primary",
            archetype,
            "里程碑型公司尚无可持续利润，PE 无意义。",
        ));
    } else {
        let mut assumptions = Vec::new();
        if cyclical {
            assumptions.push("周期股 TTM 利润可能处在周期高点或低点，只用 TTM PE 会系统性误判，须与周期中枢 PE 并列。");
        }
        if financial {
            assumptions.push(
                "银行的利润受拨备与减值影响，PE 不能单独作为估值依据；主方法为 PB-ROE 与股息率。",
            );
        }
        bands.push(multiple(Multiple {
            key: "pe_ttm",
            label: if cyclical {
                "PE(TTM)（周期股仅作参考）"
            } else if financial {
                "PE(TTM)（资产负债表驱动，仅作辅助）"
            } else {
                "PE(TTM)"
            },
            role: if cyclical || financial {
                "auxiliary"
            } else {
                "primary"
            },
            basis: "net_income_ttm",
            value: &input["ttm"]["netProfit"],
            date: &input["asOf"]["income"],
            market_cap,
            missing: if positive(&input["ttm"]["netProfit"]) {
                vec![]
            } else {
                vec!["净利润为正（当前为负或缺失）"]
            },
            assumptions,
        }));
    }
    if cyclical {
        bands.push(mid_cycle(input));
    }
    let forward_profit = &input["forward"]["netProfit"];
    let has_forward = positive(forward_profit);
    let forward_source = input["forward"]["source"]
        .as_str()
        .is_some_and(|s| !s.is_empty());
    let forward_ready = has_forward && forward_source;
    let mut missing = Vec::new();
    if !has_forward {
        missing.push("前瞻净利润");
    }
    if !forward_source {
        missing.push("前瞻净利润来源");
    }
    if !positive(market_cap) {
        missing.push("市值（用于隐含值）");
    }
    bands.push(json!({"key":"pe_forward","label":"前瞻 PE","role":"auxiliary","status":if forward_ready && positive(market_cap) {"available"} else {"insufficient_data"},
        "range":if forward_ready {range("pe_forward")} else {Value::Null},"unit":if forward_ready {json!("multiple")} else {Value::Null},
        "denominator":if has_forward {json!({"basis":"net_income_forward","value":forward_profit,"reportDate":input["asOf"]["income"].as_str().unwrap_or("")})} else {Value::Null},
        "implied":if has_forward && positive(market_cap) {implied(forward_profit.as_f64().unwrap(),"pe_forward","market_cap")} else {Value::Null},
        "assumptions":[entry("pe_forward").3,"前瞻净利润必须来自可引用的盈利预测；本模块不自行推算未来利润。"],"missingInputs":missing,"reasons":[]}));
    if financial {
        for (key, label) in [
            ("ev_ebit", "EV/EBIT"),
            ("ev_ebitda", "EV/EBITDA"),
            ("ev_revenue", "EV/营业收入"),
        ] {
            bands.push(forbidden(
                key,
                label,
                "primary",
                archetype,
                &format!("{archetype} 属资产负债表驱动业务，EV 口径不适用。"),
            ));
        }
    } else {
        bands.push(enterprise(
            input,
            "ev_ebit",
            "EV/EBIT",
            "primary",
            "ebit_ttm",
            &input["ttm"]["ebit"],
        ));
        bands.push(enterprise(
            input,
            "ev_ebitda",
            "EV/EBITDA",
            "auxiliary",
            "ebitda_ttm",
            &input["ttm"]["ebitda"],
        ));
        if archetype == "pre_profit_milestone" || !positive(&input["ttm"]["netProfit"]) {
            bands.push(enterprise(
                input,
                "ev_revenue",
                "EV/营业收入",
                if archetype == "pre_profit_milestone" {
                    "primary"
                } else {
                    "auxiliary"
                },
                "revenue_ttm",
                &input["ttm"]["revenue"],
            ));
        }
    }
    if archetype == "bank" {
        bands.push(multiple(Multiple {
            key: "pb",
            label: "PB（须与 ROE 联读）",
            role: "primary",
            basis: "book_equity",
            value: &input["balance"]["commonEquity"],
            date: &input["asOf"]["balance"],
            market_cap,
            missing: vec![],
            assumptions: vec![],
        }));
    } else if financial {
        bands.push(forbidden(
            "pb",
            "PB",
            "primary",
            archetype,
            "保险/券商的账面权益不反映内含价值或经纪业务质量，未调整的 PB 会失真。",
        ));
    } else if ![
        "software_platform",
        "property_operator",
        "payment",
        "healthcare_services",
    ]
    .contains(&archetype)
    {
        bands.push(multiple(Multiple {
            key: "pb",
            label: "PB（辅助）",
            role: "auxiliary",
            basis: "book_equity",
            value: &input["balance"]["commonEquity"],
            date: &input["asOf"]["balance"],
            market_cap,
            missing: vec![],
            assumptions: vec![],
        }));
    }
    if [
        "stable_cash_dividend",
        "software_platform",
        "payment",
        "growth_manufacturing",
    ]
    .contains(&archetype)
    {
        bands.push(yield_band(input));
    }
    if !cyclical {
        bands.push(forbidden(
            "pe_mid_cycle",
            "PE（周期中枢利润）",
            "auxiliary",
            archetype,
            "非周期公司的利润增长是真实信号，用周期中枢会抹掉成长。",
        ));
    }
    if let Some(mid) = bands.iter().find(|b| b["key"] == "pe_mid_cycle") {
        if mid["status"] == "available"
            && let (Some(mid_value), Some(ttm_value)) = (
                mid["denominator"]["value"].as_f64(),
                bands
                    .iter()
                    .find(|b| b["key"] == "pe_ttm")
                    .and_then(|b| b["denominator"]["value"].as_f64()),
            )
        {
            let divergence = (ttm_value - mid_value).abs() / mid_value.abs();
            if divergence > 0.5 {
                warnings.push(format!("TTM 利润是周期中枢的 {:.2} 倍（相差 {:.0}%）：当前处在周期的偏{}位，倍数结论必须同时给出两种口径。",ttm_value/mid_value,divergence*100.0,if ttm_value>mid_value {"高"} else {"低"}));
            }
        }
        if cyclical && mid["status"] == "insufficient_data" {
            warnings.push(
                "周期股缺少可用的中枢利润，PE 类结论暂不成立；不要退回 TTM 单独使用。".into(),
            );
        }
    }
    let ebit = bands
        .iter()
        .find(|b| b["key"] == "ev_ebit" && b["status"] == "available")
        .and_then(|b| b["denominator"]["value"].as_f64());
    let ebitda = bands
        .iter()
        .find(|b| b["key"] == "ev_ebitda" && b["status"] == "available")
        .and_then(|b| b["denominator"]["value"].as_f64());
    if let (Some(ebit), Some(ebitda)) = (ebit, ebitda) {
        let spread = ebitda / ebit;
        if spread > 1.5 {
            warnings.push(format!("折旧摊销是 EBIT 的 {:.1} 倍：EV/EBITDA 会显著压低倍数，必须与 EV/EBIT 并列阅读，且不能与轻资产公司直接比较。",spread-1.0));
            if let Some(band) = bands
                .iter_mut()
                .find(|b| b["key"] == "ev_ebitda" && b["role"] == "primary")
            {
                band["role"] = json!("auxiliary");
            }
        }
    }
    if let Some(ratio) = input["capitalIntensity"]["depreciationToEbit"]
        .as_f64()
        .filter(|v| *v > 1.0)
    {
        warnings.push(format!(
            "折旧摊销/EBIT = {ratio:.2}，属重资本模式；倍数比较必须先分组。"
        ));
    }
    if input["balance"]["debtIncomplete"] == true {
        warnings
            .push("有息负债为部分披露科目的合计，EV 偏低；补齐缺失科目后再用 EV 类区间。".into());
    }
    if !positive(market_cap) {
        warnings.push("未提供市值：区间只给出倍数与假设，不填隐含值。".into());
    }
    if bands.iter().all(|band| band["status"] != "available") {
        warnings.push("当前没有一个区间成立，说明估值输入不足，不应据此形成任何判断。".into());
    }
    json!({"code":input["code"],"archetype":input["archetype"],"asOf":input["asOf"],"bands":bands,"warnings":warnings,"disclaimer":DISCLAIMER})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(archetype: &str) -> Value {
        json!({"code":"600036.SH","archetype":archetype,"asOf":{"income":"2026-06-30","balance":"2026-06-30","cashflow":"2026-06-30"},"ttm":{"netProfit":10,"revenue":100,"ebit":12,"ebitda":15,"freeCashFlow":8},"balance":{"parentEquity":120,"commonEquity":100,"grossDebt":20,"cash":30,"minorityEquity":0,"debtIncomplete":false},"marketCap":100,"capitalIntensity":{"depreciationToEbit":0.25},"forward":null,"midCycle":null})
    }
    fn band<'a>(model: &'a Value, key: &str) -> &'a Value {
        model["bands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|band| band["key"] == key)
            .unwrap()
    }
    #[test]
    fn financial_methods_and_common_equity() {
        let model = build(&input("bank"));
        assert_eq!(band(&model, "pe_ttm")["role"], "auxiliary");
        assert_eq!(band(&model, "pb")["role"], "primary");
        assert_eq!(band(&model, "pb")["denominator"]["value"], 100);
        assert_eq!(band(&model, "ev_ebit")["status"], "forbidden_for_archetype");
        assert_eq!(
            band(&build(&input("insurer")), "pb")["status"],
            "forbidden_for_archetype"
        );
    }
    #[test]
    fn missing_debt_and_quote_do_not_invent_ev() {
        let mut data = input("growth_manufacturing");
        data["balance"]["grossDebt"] = Value::Null;
        let model = build(&data);
        assert_eq!(band(&model, "ev_ebit")["status"], "available");
        assert!(band(&model, "ev_ebit")["implied"].is_null());
        data["marketCap"] = Value::Null;
        let model = build(&data);
        assert_eq!(band(&model, "pe_ttm")["status"], "available");
        assert_eq!(band(&model, "fcf_yield")["status"], "insufficient_data");
    }
    #[test]
    fn cyclicals_require_dated_midcycle_no_ttm_fallback() {
        let mut data = input("cyclical_commodity");
        assert_eq!(
            band(&build(&data), "pe_mid_cycle")["status"],
            "insufficient_data"
        );
        data["midCycle"] = json!({"status":"available","median":5,"window":"2016..2025","years":[{"reportDate":"2024-12-31"},{"reportDate":"2025-12-31"}],"notes":[]});
        let model = build(&data);
        assert_eq!(
            band(&model, "pe_mid_cycle")["denominator"]["reportDate"],
            "2025-12-31"
        );
        assert_eq!(band(&model, "pe_mid_cycle")["role"], "primary");
        assert!(
            model["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str().unwrap().contains("2.00"))
        );
    }
    #[test]
    fn intensity_and_preprofit_rules() {
        for (ratio, expected) in [(0.49, 14.0), (0.5, 9.0), (1.0, 9.0), (1.01, 5.0)] {
            let mut data = input("other");
            data["capitalIntensity"]["depreciationToEbit"] = json!(ratio);
            assert_eq!(band(&build(&data), "ev_ebitda")["range"]["low"], expected);
        }
        let model = build(&input("pre_profit_milestone"));
        assert_eq!(band(&model, "pe_ttm")["status"], "forbidden_for_archetype");
        assert_eq!(band(&model, "ev_revenue")["role"], "primary");
    }
}
