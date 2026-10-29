//! Dated, source-preserving valuation inputs. Missing disclosures are not zeros.
use serde_json::{Value, json};

#[derive(Clone, Debug)]
struct Matched {
    value: f64,
    fields: Vec<String>,
}

fn pick(payload: &Value, candidates: &[&str]) -> Option<Matched> {
    candidates.iter().find_map(|field| {
        payload[*field]
            .as_f64()
            .filter(|number| number.is_finite())
            .map(|value| Matched {
                value,
                fields: vec![(*field).to_owned()],
            })
    })
}

fn payload(row: &Value) -> &Value {
    &row["payload"]
}
fn string(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty())
}
fn line(key: &str, label: &str, matched: &Matched, statement: &str) -> Value {
    json!({"key":key,"label":label,"value":matched.value,"sourceFields":matched.fields,"statement":statement})
}
fn gap(key: &str, label: &str) -> Value {
    json!({"key":key,"label":label,"reason":"field_not_reported"})
}

/// Prefer the disclosed aggregate adjustment; never double-deduct components.
fn common_equity(payload: &Value) -> Option<Matched> {
    let parent = pick(payload, &["TOTAL_PARENT_EQUITY", "totalParentEquity"])?;
    let aggregate_fields = ["OTHER_EQUITY_TOOL", "otherEquityTool"];
    let component_fields = ["PREFERRED_SHARES", "PERPETUAL_BOND", "OTHER_EQUITY_OTHER"];
    let adjustment = if let Some(adjustment) = pick(payload, &aggregate_fields) {
        adjustment
    } else {
        let preferred = pick(payload, &["PREFERRED_SHARES"]);
        let perpetual = pick(payload, &["PERPETUAL_BOND"]);
        let other = pick(payload, &["OTHER_EQUITY_OTHER"]);
        if let (Some(preferred), Some(perpetual)) = (&preferred, &perpetual)
            && (payload.get("OTHER_EQUITY_OTHER").is_none() || other.is_some())
        {
            if preferred.value < 0.0
                || perpetual.value < 0.0
                || other.as_ref().is_some_and(|v| v.value < 0.0)
            {
                return None;
            }
            Matched {
                value: preferred.value + perpetual.value + other.as_ref().map_or(0.0, |v| v.value),
                fields: preferred
                    .fields
                    .iter()
                    .chain(&perpetual.fields)
                    .chain(other.as_ref().into_iter().flat_map(|v| &v.fields))
                    .cloned()
                    .collect(),
            }
        } else if aggregate_fields
            .iter()
            .chain(&component_fields)
            .any(|key| payload.get(*key).is_some())
        {
            return None;
        } else {
            Matched {
                value: 0.0,
                fields: vec![],
            }
        }
    };
    let value = parent.value - adjustment.value;
    if adjustment.value < 0.0 || !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(Matched {
        value,
        fields: parent.fields.into_iter().chain(adjustment.fields).collect(),
    })
}

#[derive(Clone)]
struct Depreciation {
    value: f64,
    fields: Vec<String>,
    basis: &'static str,
    note: String,
}

fn depreciation_from_row(payload: &Value, tag: &str) -> Option<Depreciation> {
    let depreciation = pick(payload, &["FA_IR_DEPR", "faIrDepr"]);
    let amortizations: Vec<Matched> = ["IA_AMORTIZE", "LPE_AMORTIZE", "USERIGHT_ASSET_AMORTIZE"]
        .iter()
        .filter_map(|field| pick(payload, &[*field]))
        .collect();
    if depreciation.is_none() && amortizations.is_empty() {
        return None;
    }
    let value = depreciation.as_ref().map_or(0.0, |item| item.value)
        + amortizations.iter().map(|item| item.value).sum::<f64>();
    let fields = depreciation
        .iter()
        .chain(&amortizations)
        .flat_map(|item| item.fields.iter().map(|field| format!("{tag}.{field}")))
        .collect();
    Some(Depreciation {
        value,
        fields,
        basis: "annual",
        note: String::new(),
    })
}

fn depreciation_schedule(
    latest: &Value,
    prior_fiscal_year: &Value,
    prior_same: &Value,
    date: Option<&str>,
) -> Depreciation {
    let report_month = date
        .and_then(|s| s.get(5..7))
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let annual = depreciation_from_row(prior_fiscal_year, "priorFY");
    if report_month == 12
        && let Some(mut own) = depreciation_from_row(latest, "latest")
    {
        own.note = format!("取 {} 年报补充资料。", date.unwrap_or(""));
        return own;
    }
    let current = depreciation_from_row(latest, "latest");
    let prior_same = depreciation_from_row(prior_same, "priorSame");
    if let (Some(annual), Some(current), Some(prior_same)) = (&annual, current, prior_same)
        && (report_month == 6 || report_month == 9)
    {
        let mut fields = vec![];
        for field in annual
            .fields
            .iter()
            .chain(&current.fields)
            .chain(&prior_same.fields)
        {
            if !fields.contains(field) {
                fields.push(field.clone());
            }
        }
        return Depreciation {
            value: annual.value + current.value - prior_same.value,
            fields,
            basis: "trailing_twelve_months",
            note: format!(
                "上年报 + 本期（{}） − 上年同期，均为现金流量表补充资料口径。",
                date.unwrap_or("")
            ),
        };
    }
    if let Some(mut annual) = annual {
        annual.basis = "prior_fiscal_year";
        annual.note = format!(
            "{} 无补充资料（一季报/三季报不披露），沿用最近年报口径。",
            date.unwrap_or("最新期")
        );
        return annual;
    }
    Depreciation {
        value: 0.0,
        fields: vec![],
        basis: "unavailable",
        note: String::new(),
    }
}

/// Port of buildValuationInputs. The function never fetches, applies FX, or
/// combines securities. `input` is the original statement-row contract.
pub fn build(input: &Value) -> Value {
    let archetype = input["balanceSheetArchetype"]
        .as_str()
        .unwrap_or("non_financial");
    let mut periods = vec![];
    for statement in ["income", "balance", "cashflow"] {
        for (role, key) in [
            ("latest", "latest"),
            ("prior_year_same_period", "priorYearSamePeriod"),
            ("prior_fiscal_year", "priorFiscalYear"),
            (
                "current_fiscal_year_same_period",
                "currentFiscalYearSamePeriod",
            ),
        ] {
            let row = &input[statement][key];
            if row.is_null() {
                continue;
            }
            periods.push(json!({
                "statement":statement,"role":role,"reportDate":row["reportDate"],
                "fiscalPeriod":row.get("fiscalPeriod").filter(|v| !v.is_null()).cloned().unwrap_or_else(||json!(string(&payload(row)["FISCAL_PERIOD"]))),
                "currency":string(&payload(row)["REPORTING_CURRENCY"]).or_else(|| string(&payload(row)["CURRENCY"]))
            }));
        }
    }
    let latest_income = payload(&input["income"]["latest"]);
    let latest_balance = payload(&input["balance"]["latest"]);
    let latest_cashflow = payload(&input["cashflow"]["latest"]);
    let mut lines = Vec::new();
    let mut gaps = Vec::new();
    let mut limitations: Vec<String> = Vec::new();

    let operating_income = pick(latest_income, &["OPERATE_PROFIT", "operateProfit"]);
    let revenue = pick(
        latest_income,
        &[
            "TOTAL_OPERATE_INCOME",
            "OPERATE_INCOME",
            "totalOperateIncome",
            "operateIncome",
        ],
    );
    let net_profit = pick(latest_income, &["NETPROFIT", "netProfit"]);
    let parent_net_profit = pick(
        latest_income,
        &["PARENT_NETPROFIT", "HOLDER_PROFIT", "parentNetprofit"],
    );
    let minority_profit = pick(latest_income, &["MINORITY_INTEREST", "minorityInterest"]);
    let invest_income = pick(
        latest_income,
        &[
            "INVEST_INCOME",
            "investIncome",
            "INVEST_JOINT_INCOME",
            "investJointIncome",
        ],
    );
    let fair_value = pick(
        latest_income,
        &["FAIRVALUE_CHANGE_INCOME", "fairvalueChangeIncome"],
    );
    let income_tax = pick(latest_income, &["INCOME_TAX", "incomeTax"]);
    for (key, label, matched) in [
        ("revenue", "营业总收入", &revenue),
        ("operatingIncome", "营业利润", &operating_income),
        ("netProfit", "净利润", &net_profit),
        ("parentNetProfit", "归母净利润", &parent_net_profit),
        ("minorityProfit", "少数股东损益", &minority_profit),
    ] {
        if let Some(matched) = matched {
            lines.push(line(key, label, matched, "income"));
        }
    }

    for (key, label, fields) in [
        (
            "totalAssets",
            "总资产",
            &["TOTAL_ASSETS", "totaAssets", "totalAssets"][..],
        ),
        (
            "totalEquity",
            "股东权益合计",
            &["TOTAL_EQUITY", "totalEquity"][..],
        ),
        (
            "parentEquity",
            "归母权益",
            &["TOTAL_PARENT_EQUITY", "totalParentEquity"][..],
        ),
    ] {
        if let Some(matched) = pick(latest_balance, fields) {
            lines.push(line(key, label, &matched, "balance"));
        }
    }
    if let Some(equity) = common_equity(latest_balance) {
        lines.push(line(
            "commonEquity",
            "普通股股东权益（扣除其他权益工具）",
            &equity,
            "balance",
        ));
    } else {
        gaps.push(gap("commonEquity", "普通股股东权益"));
    }
    if let Some(matched) = pick(latest_balance, &["MINORITY_EQUITY", "minorityEquity"]) {
        lines.push(line("minorityEquity", "少数股东权益", &matched, "balance"));
    }

    let debt_fields = [
        ("shortLoan", &["SHORT_LOAN", "shortLoan"][..]),
        (
            "noncurrentLiab1year",
            &["NONCURRENT_LIAB_1YEAR", "noncurrentLiab1year"][..],
        ),
        ("longLoan", &["LONG_LOAN", "longLoan"][..]),
        ("bondPayable", &["BOND_PAYABLE", "bondPayable"][..]),
        ("leaseLiab", &["LEASE_LIAB", "leaseLiab"][..]),
        (
            "shortLeaseLiab",
            &["SHORT_LEASE_LIAB", "shortLeaseLiab"][..],
        ),
    ];
    let debt_parts: Vec<(&str, Matched)> = debt_fields
        .iter()
        .filter_map(|(key, fields)| pick(latest_balance, fields).map(|matched| (*key, matched)))
        .collect();
    let cash_parts: Vec<Matched> = [
        &["MONETARYFUNDS", "monetaryFunds"][..],
        &["TRADE_FINASSET_NOTFVTPL", "tradeFinassetNotfvtpl"][..],
    ]
    .iter()
    .filter_map(|fields| pick(latest_balance, fields))
    .collect();
    if !debt_parts.is_empty() {
        lines.push(json!({"key":"grossDebtDisclosed","label":"已披露有息负债合计","value":debt_parts.iter().map(|(_,p)|p.value).sum::<f64>(),"sourceFields":debt_parts.iter().flat_map(|(_,p)|p.fields.clone()).collect::<Vec<_>>(),"statement":"balance"}));
        let unsupplied: Vec<&str> = debt_fields
            .iter()
            .filter(|(key, fields)| {
                !debt_parts.iter().any(|(part, _)| part == key)
                    && fields
                        .iter()
                        .any(|field| latest_balance.get(*field).is_some_and(Value::is_null))
            })
            .map(|(key, _)| *key)
            .collect();
        for key in &unsupplied {
            gaps.push(gap(key, &format!("有息负债科目 {key}")));
        }
        if !unsupplied.is_empty() {
            limitations.push("有息负债合计只包含已披露科目；有科目存在但未返回数值的项已列出，未当作零，净负债与EV需补齐后再用。".into());
        }
    } else {
        gaps.push(gap("grossDebtDisclosed", "有息负债"));
        limitations.push("未取得有息负债明细，不能计算净负债与EV口径。".into());
    }
    if !cash_parts.is_empty() {
        lines.push(json!({"key":"cashDisclosed","label":"已披露现金类资产","value":cash_parts.iter().map(|p|p.value).sum::<f64>(),"sourceFields":cash_parts.iter().flat_map(|p|p.fields.clone()).collect::<Vec<_>>(),"statement":"balance"}));
    }
    if let Some(ocf) = pick(
        latest_cashflow,
        &["NETCASH_OPERATE", "netcashOperate", "netCashOperate"],
    ) {
        lines.push(line(
            "operatingCashFlow",
            "经营活动现金流净额",
            &ocf,
            "cashflow",
        ));
    } else {
        gaps.push(gap("operatingCashFlow", "经营现金流"));
    }

    let depreciation = depreciation_schedule(
        latest_cashflow,
        payload(&input["cashflow"]["priorFiscalYear"]),
        payload(&input["cashflow"]["currentFiscalYearSamePeriod"]),
        input["cashflow"]["latest"]["reportDate"].as_str(),
    );
    if depreciation.basis == "unavailable" {
        gaps.push(gap("depreciationAmortization", "折旧摊销"));
    }
    let enterprise_value_applicable = archetype == "non_financial";
    if enterprise_value_applicable {
        if let Some(operating_income) = operating_income {
            let ebit = operating_income.value
                - invest_income.as_ref().map_or(0.0, |v| v.value)
                - fair_value.as_ref().map_or(0.0, |v| v.value);
            let fields: Vec<String> = operating_income
                .fields
                .iter()
                .chain(
                    invest_income
                        .as_ref()
                        .into_iter()
                        .flat_map(|p| p.fields.iter()),
                )
                .chain(
                    fair_value
                        .as_ref()
                        .into_iter()
                        .flat_map(|p| p.fields.iter()),
                )
                .cloned()
                .collect();
            lines.push(json!({"key":"ebit","label":"EBIT（营业利润扣除投资收益与公允价值变动）","value":ebit,"sourceFields":fields,"statement":"income"}));
            if depreciation.basis != "unavailable" {
                lines.push(json!({"key":"depreciationAmortization","label":"折旧摊销（现金流量表补充资料）","value":depreciation.value,"sourceFields":depreciation.fields,"statement":"cashflow"}));
                let fields: Vec<String> = depreciation
                    .fields
                    .iter()
                    .cloned()
                    .chain(std::iter::once("derived:ebit".to_string()))
                    .collect();
                lines.push(json!({"key":"ebitda","label":"EBITDA（EBIT + 折旧摊销）","value":ebit+depreciation.value,"sourceFields":fields,"statement":"cashflow"}));
                limitations.push(format!("折旧摊销口径：{}", depreciation.note));
            } else {
                gaps.push(gap("ebitda", "折旧摊销"));
                limitations.push("现金流量表补充资料未提供折旧摊销，EBITDA 不可计算；不得用资本开支或猜测值代替。".into());
            }
        }
    } else {
        limitations.push(format!(
            "{archetype} 属资产负债表驱动业务，EBIT/EBITDA/EV 口径不适用。"
        ));
    }
    if archetype != "non_financial" {
        limitations.push("本次未提供银行/保险/证券专用口径（净利息收入、拨备前利润、NBV/EV）；通用营收与EBIT不可用于该类公司估值。".into());
    }
    if income_tax.is_none() {
        gaps.push(gap("incomeTax", "所得税"));
    }
    for name in ["income", "balance", "cashflow"] {
        if input[name]["priorYearSamePeriod"].is_null() {
            gaps.push(gap(
                &format!("{name}.priorYearSamePeriod"),
                &format!("{name} 上年同期"),
            ));
        }
    }
    let revenue_archetype = match archetype {
        "bank" => "bank_net_interest_plus_fee",
        "insurer" => "insurer_premium_net",
        "broker" => "broker_net_revenue",
        _ => "operating_revenue",
    };
    json!({"code":input["code"],"incomeReportDate":input["income"]["latest"]["reportDate"],"balanceReportDate":input["balance"]["latest"]["reportDate"],"cashflowReportDate":input["cashflow"]["latest"]["reportDate"],"periods":periods,"balanceSheetArchetype":archetype,"revenueArchetype":revenue_archetype,"lines":lines,"gaps":gaps,"enterpriseValueApplicable":enterprise_value_applicable,"evRevenueApplicable":enterprise_value_applicable,"provisional":input["provisional"].as_bool().unwrap_or(false),"limitations":limitations})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty_input() -> Value {
        json!({"code":"600036.SH","income":{"latest":null,"priorYearSamePeriod":null},"balance":{"latest":null,"priorYearSamePeriod":null},"cashflow":{"latest":null,"priorYearSamePeriod":null}})
    }
    fn value(model: &Value, key: &str) -> Option<f64> {
        model["lines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|line| line["key"] == key)
            .and_then(|line| line["value"].as_f64())
    }
    #[test]
    fn common_equity_deducts_aggregate_once_and_missing_components_fail_closed() {
        let common = common_equity(&json!({"TOTAL_PARENT_EQUITY":100,"OTHER_EQUITY_TOOL":10,"PREFERRED_SHARES":6,"PERPETUAL_BOND":4})).unwrap();
        assert_eq!(common.value, 90.0);
        assert_eq!(
            common.fields,
            vec!["TOTAL_PARENT_EQUITY", "OTHER_EQUITY_TOOL"]
        );
        assert!(
            common_equity(&json!({"TOTAL_PARENT_EQUITY":100,"OTHER_EQUITY_TOOL":null})).is_none()
        );
        assert!(common_equity(&json!({"TOTAL_PARENT_EQUITY":100,"PREFERRED_SHARES":10})).is_none());
        assert_eq!(
            common_equity(&json!({"TOTAL_PARENT_EQUITY":100}))
                .unwrap()
                .value,
            100.0
        );
        assert!(common_equity(&json!({"TOTAL_EQUITY":100})).is_none());
    }
    #[test]
    fn zero_disclosure_is_not_missing_and_absent_debt_is_not_null_debt() {
        let mut input = empty_input();
        input["balance"]["latest"] = json!({"reportDate":"2026-09-30","payload":{"TOTAL_PARENT_EQUITY":100,"SHORT_LOAN":0,"LONG_LOAN":null}});
        input["income"]["latest"] =
            json!({"reportDate":"2026-09-30","payload":{"OPERATE_PROFIT":0,"INCOME_TAX":0}});
        let model = build(&input);
        assert_eq!(value(&model, "grossDebtDisclosed"), Some(0.0));
        assert_eq!(value(&model, "ebit"), Some(0.0));
        assert!(
            model["gaps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|gap| gap["key"] == "longLoan")
        );
        assert!(
            !model["gaps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|gap| gap["key"] == "bondPayable" || gap["key"] == "incomeTax")
        );
    }
    #[test]
    fn depreciation_never_double_counts_oilgas_and_rolls_annual_supplement() {
        let mut input = empty_input();
        input["income"]["latest"] = json!({"reportDate":"2026-06-30","payload":{"OPERATE_PROFIT":100,"INVEST_INCOME":10,"FAIRVALUE_CHANGE_INCOME":5}});
        input["cashflow"]["latest"] = json!({"reportDate":"2026-06-30","payload":{"FA_IR_DEPR":12,"OILGAS_BIOLOGY_DEPR":12,"IA_AMORTIZE":3}});
        input["cashflow"]["priorFiscalYear"] =
            json!({"reportDate":"2025-12-31","payload":{"FA_IR_DEPR":20,"IA_AMORTIZE":5}});
        input["cashflow"]["currentFiscalYearSamePeriod"] =
            json!({"reportDate":"2025-06-30","payload":{"FA_IR_DEPR":10,"IA_AMORTIZE":2}});
        let model = build(&input);
        assert_eq!(value(&model, "ebit"), Some(85.0));
        assert_eq!(value(&model, "depreciationAmortization"), Some(28.0));
        assert_eq!(value(&model, "ebitda"), Some(113.0));
        input["cashflow"]["latest"] = json!({"reportDate":"2026-03-31","payload":{}});
        let model = build(&input);
        assert_eq!(value(&model, "depreciationAmortization"), Some(25.0));
        assert!(
            model["limitations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str().unwrap().contains("沿用最近年报"))
        );
    }
    #[test]
    fn financial_archetypes_never_emit_enterprise_multiples() {
        let mut input = empty_input();
        input["balanceSheetArchetype"] = json!("bank");
        input["provisional"] = json!(true);
        input["income"]["latest"] =
            json!({"reportDate":"2026-09-30","payload":{"OPERATE_PROFIT":100}});
        let model = build(&input);
        assert_eq!(model["enterpriseValueApplicable"], false);
        assert_eq!(model["revenueArchetype"], "bank_net_interest_plus_fee");
        assert_eq!(model["provisional"], true);
        assert_eq!(value(&model, "ebit"), None);
    }
}
