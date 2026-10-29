//! Deterministic valuation archetypes and issuer factor coverage. The same
//! declarative policy drives every listed line; no provider inference occurs.
use serde_json::{Map, Value, json};
use std::{collections::HashSet, sync::OnceLock};

fn policy() -> &'static Value {
    static POLICY: OnceLock<Value> = OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(POLICY_JSON).expect("valid valuation policy"))
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub fn resolve_archetype(track_id: &str, company_id: Option<&str>) -> Value {
    if let Some(company_id) = company_id
        && let Some(item) = array(&policy()["OVERRIDES"])
            .iter()
            .find(|v| text(v, "companyId") == company_id)
    {
        return json!({"archetype":item["archetype"],"overrideReason":item["reason"]});
    }
    json!({"archetype":policy()["TRACK_ARCHETYPE"].get(track_id).and_then(Value::as_str).unwrap_or("other"),"overrideReason":null})
}

pub fn valuation_profile(archetype: &str) -> Value {
    policy()["PROFILES"]
        .get(archetype)
        .unwrap_or(&policy()["PROFILES"]["other"])
        .clone()
}

pub fn research_tier(
    company: &Value,
    evidence_count: usize,
    all_securities_verified: bool,
) -> Value {
    let archetype = text(&company["valuationProfile"], "archetype");
    let mut basis = vec![json!(format!("原型 {archetype}"))];
    let mut level = policy()["ARCHETYPE_DIFFICULTY"][archetype]
        .as_u64()
        .unwrap_or(1);
    let primary: Vec<&Value> = array(&company["factors"])
        .iter()
        .filter(|v| text(v, "weight") == "primary")
        .collect();
    if primary.len() == 1 && text(primary[0], "direction") == "mixed" {
        level = (level + 1).min(3);
        basis.push(json!("唯一主导因子方向不确定"));
    }
    if !all_securities_verified {
        basis.push(json!("身份未核验，先补一手文件"));
        return json!({"priority":"L1","watchStatus":"research","basis":basis});
    }
    basis.push(json!("全部证券身份已核验"));
    if evidence_count == 0 {
        return json!({"priority":"L1","watchStatus":"research","basis":basis});
    }
    json!({"priority":if level>=3 {"L3"} else if level==2 {"L2"} else {"L1"},"watchStatus":if level>=2 {"priority"} else {"research"},"basis":basis})
}

fn factors(track: &str, company: &str) -> Vec<Value> {
    let added = array(&policy()["COMPANY_FACTOR_ADDITIONS"][company]);
    let added_factors: HashSet<&str> = added.iter().map(|v| text(v, "factor")).collect();
    let entries = array(&policy()["TRACK_FACTORS"][track])
        .iter()
        .filter(|v| !added_factors.contains(text(v, "factor")))
        .chain(added.iter());
    let mut result: Vec<Value> = Vec::new();
    for entry in entries {
        let mut next = entry.clone();
        if next.get("label").is_none() {
            next["label"] = policy()["FACTOR_LABELS"][text(entry, "factor")].clone();
        }
        let existing = result
            .iter()
            .position(|v| text(v, "factor") == text(entry, "factor"));
        if let Some(index) = existing {
            if text(&result[index], "weight") == "secondary" && text(&next, "weight") == "primary" {
                result[index] = next;
            }
        } else {
            result.push(next);
        }
    }
    result.sort_by_key(|v| if text(v, "weight") == "primary" { 0 } else { 1 });
    result
}

fn rate_sensitivity(companies: &[Value]) -> Value {
    let mut channels: Vec<Value> = Vec::new();
    let mut unresolved = Vec::new();
    for company in companies {
        let factors = array(&company["factors"]);
        let Some(rate) = factors
            .iter()
            .find(|v| text(v, "factor") == "interest_rate")
        else {
            continue;
        };
        let Some(transmitter) = factors
            .iter()
            .find(|v| text(v, "factor") != "interest_rate")
        else {
            unresolved.push(company["displayName"].clone());
            continue;
        };
        let channel = text(transmitter, "factor");
        let index = if let Some(index) = channels.iter().position(|v| text(v, "channel") == channel)
        {
            index
        } else {
            channels.push(json!({"channel":channel,"direction":rate["direction"],"companies":[]}));
            channels.len() - 1
        };
        if channels[index]["direction"] != rate["direction"] {
            channels[index]["direction"] = json!("mixed");
        }
        channels[index]["companies"].as_array_mut().unwrap().push(json!({"companyId":company["companyId"],"displayName":company["displayName"],"archetype":company["valuationProfile"]["archetype"],"transmittedBy":rate["reason"]}));
    }
    channels.sort_by(|a, b| {
        array(&b["companies"])
            .len()
            .cmp(&array(&a["companies"]).len())
            .then_with(|| text(a, "channel").cmp(text(b, "channel")))
    });
    json!({"channels":channels,"unresolved":unresolved})
}

pub fn build(universe: &Value, industry_profiles: &Value, company_profiles: &Value) -> Value {
    if array(&universe["companies"]).is_empty() {
        return json!({"universeAsOf":universe["asOf"].as_str().unwrap_or(""),"companyCount":0,"em2016Lookup":{"available":0,"notApplicableForMarket":0,"missing":0},"archetypeCounts":{},"factorCounts":{},"topFactors":[],"rateSensitivity":{"channels":[],"unresolved":[]},"companies":[],"gaps":["观察池数据未随本次构建提供公司列表；估值原型与因子为空，不代表没有敞口。"],"limitations":["本次构建未包含观察池数据，估值原型与因子覆盖不可用。"]});
    }
    let mut available = 0;
    let mut missing = 0;
    let mut not_applicable = 0;
    let mut companies = Vec::new();
    for company in array(&universe["companies"]) {
        let ticker = text(company, "preferredTicker");
        let listed = array(&company_profiles["profiles"])
            .iter()
            .rev()
            .find(|v| text(v, "availability") == "available" && text(v, "code") == ticker);
        let industry = listed.and_then(|v| v["industry"].as_str());
        let lookup = if industry.is_some_and(|s| !s.is_empty()) {
            available += 1;
            "available"
        } else if [".SH", ".SZ", ".BJ"]
            .iter()
            .any(|suffix| ticker.ends_with(suffix))
        {
            missing += 1;
            "missing"
        } else {
            not_applicable += 1;
            "not_applicable_for_market"
        };
        let profile = industry.and_then(|industry| {
            array(&industry_profiles["profiles"]).iter().find(|p| {
                array(&p["industries"])
                    .iter()
                    .any(|i| i.as_str() == Some(industry))
            })
        });
        let resolved =
            resolve_archetype(text(company, "primaryTrackId"), Some(text(company, "id")));
        let securities: Vec<Value> = array(&company["securities"])
            .iter()
            .map(|s| json!({"ticker":s["ticker"],"market":s["market"]}))
            .collect();
        let evidence_count = array(&company["evidenceRefs"]).len();
        let verified = !securities.is_empty()
            && array(&company["securities"])
                .iter()
                .all(|s| s["identityVerified"] == true);
        let mut draft = json!({"companyId":company["id"],"displayName":company["displayName"],"sectorId":company["primarySectorId"],"trackId":company["primaryTrackId"],"preferredTicker":ticker,"securities":securities,"em2016Industry":listed.map(|v|v["industry"].clone()).unwrap_or(Value::Null),"em2016LookupStatus":lookup,"em2016ProfileId":profile.map(|p|p["profileId"].clone()).unwrap_or(Value::Null),"valuationProfile":valuation_profile(text(&resolved,"archetype")),"overrideReason":resolved["overrideReason"],"factors":factors(text(company,"primaryTrackId"),text(company,"id")),"evidenceCount":evidence_count});
        draft["researchTier"] = research_tier(&draft, evidence_count, verified);
        companies.push(draft);
    }
    let mut archetype_counts = Map::new();
    // Preserve first-seen factor order for stable sorting of equal-sized buckets.
    let mut factor_counts = Map::new();
    let mut factor_order: Vec<String> = Vec::new();
    let mut memberships: Vec<(String, HashSet<String>)> = Vec::new();
    for company in &companies {
        let archetype = text(&company["valuationProfile"], "archetype");
        let count = archetype_counts
            .get(archetype)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        archetype_counts.insert(archetype.into(), json!(count));
        for factor in array(&company["factors"]) {
            let key = text(factor, "factor");
            if !factor_counts.contains_key(key) {
                factor_order.push(key.into());
                memberships.push((key.into(), HashSet::new()));
                factor_counts.insert(key.into(), json!({"companies":0,"primary":0,"secondary":0}));
            }
            let ids = &mut memberships
                .iter_mut()
                .find(|(name, _)| name == key)
                .unwrap()
                .1;
            ids.insert(text(company, "companyId").to_string());
            let entry = factor_counts.get_mut(key).unwrap();
            entry["companies"] = json!(ids.len());
            let weight = if text(factor, "weight") == "primary" {
                "primary"
            } else {
                "secondary"
            };
            entry[weight] = json!(entry[weight].as_u64().unwrap_or(0) + 1);
        }
    }
    let mut top_factors:Vec<Value>=factor_order.iter().map(|key|json!({"factor":key,"label":policy()["FACTOR_LABELS"][key],"companies":factor_counts[key]["companies"]})).collect();
    top_factors.sort_by(|a, b| b["companies"].as_u64().cmp(&a["companies"].as_u64()));
    let mut gaps = Vec::new();
    if missing > 0 {
        gaps.push(json!(format!(
            "{missing} 家 A 股首选证券在 EM2016 画像中查不到分类，需重新同步。"
        )));
    }
    if not_applicable > 0 {
        gaps.push(json!(format!("{not_applicable} 家港股/美股不在 EM2016（A 股行业分类）覆盖范围内，属于结构上无对应分类，非取数失败；这些公司的可比性只能由业务模型判定。")));
    }
    let missing_factors: Vec<&str> = companies
        .iter()
        .filter(|c| array(&c["factors"]).is_empty())
        .map(|c| text(c, "displayName"))
        .collect();
    if !missing_factors.is_empty() {
        gaps.push(json!(format!("未分配因子：{}", missing_factors.join("、"))));
    }
    json!({"universeAsOf":universe["asOf"].as_str().unwrap_or(""),"companyCount":companies.len(),"em2016Lookup":{"available":available,"notApplicableForMarket":not_applicable,"missing":missing},"archetypeCounts":archetype_counts,"factorCounts":factor_counts,"topFactors":top_factors,"rateSensitivity":rate_sensitivity(&companies),"companies":companies,"gaps":gaps,"limitations":["archetype 决定可用方法，不等于已经给出估值；仍须同证券、同日期、同币种的价格与保守价值区间。","因子只标注方向性敞口，不代表已量化的 beta 或权重。","多地上市公司的 A/H/ADR 敞口相同，但交易权限与税费不同，不能互换。"]})
}

fn coverage_data() -> &'static Value {
    static COVERAGE: OnceLock<Value> = OnceLock::new();
    COVERAGE.get_or_init(|| {
        build(
            &serde_json::from_str(include_str!("../../config/investment-universe.json"))
                .expect("universe JSON"),
            &serde_json::from_str(include_str!(
                "../../config/research/research-eastmoney-em2016-industry-profiles.json"
            ))
            .expect("industry profiles JSON"),
            &serde_json::from_str(include_str!(
                "../../config/generated/eastmoney-company-em2016-profiles.json"
            ))
            .expect("company profiles JSON"),
        )
    })
}

pub fn read() -> Value {
    coverage_data().clone()
}

pub fn company_coverage(ticker: &str) -> Option<Value> {
    use std::collections::HashMap;
    static BY_SECURITY: OnceLock<HashMap<String, usize>> = OnceLock::new();
    let companies = array(&coverage_data()["companies"]);
    let index = BY_SECURITY.get_or_init(|| {
        let mut result = HashMap::new();
        for (index, company) in companies.iter().enumerate() {
            for ticker in std::iter::once(text(company, "preferredTicker")).chain(
                array(&company["securities"])
                    .iter()
                    .map(|s| text(s, "ticker")),
            ) {
                let code = crate::codes::normalize(ticker);
                if code.is_empty() {
                    continue;
                }
                // Preserve first issuer wins and the exact narrow sameSecurity
                // rule: only a bare US ticker and its .US form are aliases.
                result.entry(code.clone()).or_insert(index);
                result.entry(format!("{code}.US")).or_insert(index);
                if let Some(bare) = code.strip_suffix(".US") {
                    result.entry(bare.to_string()).or_insert(index);
                }
            }
        }
        result
    });
    let code = crate::codes::normalize(ticker);
    index
        .get(&code)
        .and_then(|index| companies.get(*index))
        .cloned()
}
pub fn company_archetype(ticker: &str) -> Option<String> {
    company_coverage(ticker).and_then(|v| {
        v["valuationProfile"]["archetype"]
            .as_str()
            .map(str::to_string)
    })
}
// Declarative profiles and exposure policy migrated from valuation-coverage.ts.
const POLICY_JSON: &str = r#"{"ARCHETYPE_DIFFICULTY":{"insurer":3,"property_operator":3,"pre_profit_milestone":3,"cyclical_commodity":3,"bank":2,"exchange":2,"stable_cash_dividend":2,"payment":2,"growth_manufacturing":1,"software_platform":1,"healthcare_services":1,"other":1},"TRACK_ARCHETYPE":{"IT-01":"growth_manufacturing","IT-02":"cyclical_commodity","IT-03":"growth_manufacturing","IT-04":"cyclical_commodity","IT-05":"growth_manufacturing","IT-06":"growth_manufacturing","IT-07":"software_platform","IT-08":"software_platform","IT-09":"software_platform","COM-01":"software_platform","COM-02":"stable_cash_dividend","CD-01":"growth_manufacturing","CD-02":"stable_cash_dividend","CD-03":"software_platform","CS-01":"stable_cash_dividend","CS-02":"stable_cash_dividend","HC-01":"pre_profit_milestone","HC-02":"healthcare_services","HC-03":"healthcare_services","FIN-01":"bank","FIN-02":"insurer","FIN-03":"exchange","FIN-04":"payment","IND-01":"growth_manufacturing","IND-02":"growth_manufacturing","IND-03":"growth_manufacturing","IND-04":"growth_manufacturing","IND-05":"growth_manufacturing","IND-06":"cyclical_commodity","IND-07":"growth_manufacturing","MAT-01":"cyclical_commodity","MAT-02":"cyclical_commodity","EN-01":"cyclical_commodity","EN-02":"stable_cash_dividend","UTIL-01":"stable_cash_dividend","UTIL-02":"stable_cash_dividend","RE-01":"property_operator"},"PROFILES":{"bank":{"archetype":"bank","label":"银行（资产负债表驱动）","basis":"损益与资产端同时驱动，股价对 ROE 与不良/拨备的敏感度高于净利润增速。","methods":[{"role":"primary","method":"pb_roe","label":"PB-ROE / 剩余收益"},{"role":"primary","method":"dividend_yield","label":"股息率与分红覆盖"},{"role":"auxiliary","method":"forward_pe","label":"PE（辅助，不单独使用）"}],"requires":["不良率与拨备覆盖率","核心一级资本充足率","净息差","分红率"],"forbidden":["EV/EBITDA","EV/EBIT","EV/营业收入","PS"]},"insurer":{"archetype":"insurer","label":"保险（内含价值驱动）","basis":"寿险价值主要来自新业务价值与内含价值，净利润受投资收益与准备金假设扰动。","methods":[{"role":"primary","method":"price_to_embedded_value","label":"P/EV 与新业务价值倍数"},{"role":"primary","method":"pb","label":"PB-ROEV"},{"role":"auxiliary","method":"forward_pe","label":"PE（辅助）"}],"requires":["内含价值 EV","新业务价值 NBV","综合成本率","投资收益率假设"],"forbidden":["EV/EBITDA","EV/EBIT","PB-ROE（未按 ROEV 调整）"]},"exchange":{"archetype":"exchange","label":"交易所（成交驱动）","basis":"收入与成交额强相关、资本轻，估值中枢跟随交投活跃度而非资产规模。","methods":[{"role":"primary","method":"forward_pe","label":"前瞻 PE"},{"role":"primary","method":"ev_ebitda","label":"EV/EBITDA"},{"role":"auxiliary","method":"dividend_yield","label":"股息率"}],"requires":["日均成交额","费率结构"],"forbidden":["PB（资本轻，PB 无意义）"]},"payment":{"archetype":"payment","label":"支付（支付量驱动）","basis":"价值随支付量与净费率增长，但收单机构与卡组织利润率差异巨大，需分开建模。","methods":[{"role":"primary","method":"ev_ebitda","label":"EV/EBITDA"},{"role":"primary","method":"forward_pe","label":"前瞻 PE（剔除股权激励后）"},{"role":"auxiliary","method":"fcf_yield","label":"自由现金流收益率"}],"requires":["支付金额与净费率","股权激励摊薄"],"forbidden":["PB（低相关性）","EV/营业收入（收单为低毛利业务）"]},"property_operator":{"archetype":"property_operator","label":"不动产运营（NAV/现金流驱动）","basis":"资产按租金与资本化率定价，利润受公允价值变动与开发结转干扰。","methods":[{"role":"primary","method":"nav","label":"NAV 与折价"},{"role":"primary","method":"fcf_yield","label":"P/FFO 类运营现金流倍数"},{"role":"auxiliary","method":"dividend_yield","label":"股息率"}],"requires":["出租率与租金","资本化率","有息负债与期限"],"forbidden":["PE（含公允价值变动）","EV/营业收入"]},"cyclical_commodity":{"archetype":"cyclical_commodity","label":"资源周期（中枢利润）","basis":"当期利润由商品价格决定，单季或景气顶部利润会被高估，必须用周期中枢。","methods":[{"role":"primary","method":"mid_cycle_earnings","label":"周期中枢利润 PE"},{"role":"primary","method":"ev_ebitda","label":"EV/EBITDA（中枢口径）"},{"role":"auxiliary","method":"nav","label":"P/NAV 或 P/储量（矿业）"}],"requires":["至少一个完整周期的年度利润序列","商品价格假设"],"forbidden":["单季年化 PE","TTM PE（景气顶部/底部）"]},"stable_cash_dividend":{"archetype":"stable_cash_dividend","label":"稳定现金流与分红","basis":"增长有限但现金流稳定，价值主要体现在可持续分红与自由现金流。","methods":[{"role":"primary","method":"dividend_yield","label":"股息率与分红可持续性"},{"role":"primary","method":"fcf_yield","label":"自由现金流收益率"},{"role":"auxiliary","method":"forward_pe","label":"前瞻 PE"}],"requires":["自由现金流或经营现金流","分红率与资本开支"],"forbidden":["EV/营业收入"]},"growth_manufacturing":{"archetype":"growth_manufacturing","label":"成长制造","basis":"利润随订单、产能与产品结构变化，估值需同时看利润与资本投入回报。","methods":[{"role":"primary","method":"forward_pe","label":"前瞻 PE（NTM）"},{"role":"primary","method":"ev_ebit","label":"EV/EBIT"},{"role":"auxiliary","method":"ev_ebitda","label":"EV/EBITDA"},{"role":"auxiliary","method":"reverse_dcf","label":"反推 DCF（隐含增速）"}],"requires":["营业利润或 EBIT","净负债（有息负债明细）","折旧摊销（如需 EBITDA）"],"forbidden":["周期中枢利润（非周期时）"]},"software_platform":{"archetype":"software_platform","label":"软件与平台","basis":"经常性收入与网络效应驱动，早期利润被投入压制，收入倍数需与留存和现金流配合。","methods":[{"role":"primary","method":"ev_revenue","label":"EV/营业收入（或 EV/ARR）"},{"role":"primary","method":"fcf_yield","label":"自由现金流收益率"},{"role":"auxiliary","method":"sotp","label":"分部加总（多云/多业务时）"},{"role":"auxiliary","method":"forward_pe","label":"前瞻 PE"}],"requires":["收入口径（含云与外延）","经营现金流或 FCF"],"forbidden":["PB（轻资产）"]},"pre_profit_milestone":{"archetype":"pre_profit_milestone","label":"里程碑型（管线药物）","basis":"价值来自未上市管线与已上市品种的现金流，利润倍数在研发期无意义。","methods":[{"role":"primary","method":"rn_pv","label":"风险调整 NPV（按管线）"},{"role":"primary","method":"sotp","label":"分部加总（已上市品种 + 管线）"},{"role":"auxiliary","method":"ev_revenue","label":"EV/营业收入（已有商业化收入时）"}],"requires":["管线阶段与成功概率","峰值销售假设","专利到期时间"],"forbidden":["PE（研发期利润失真）","周期中枢利润"]},"healthcare_services":{"archetype":"healthcare_services","label":"医疗服务与器械","basis":"收入随装机/客流与耗材复购增长，受支付方定价影响明显。","methods":[{"role":"primary","method":"forward_pe","label":"前瞻 PE"},{"role":"primary","method":"ev_ebitda","label":"EV/EBITDA"},{"role":"auxiliary","method":"ev_revenue","label":"EV/营业收入"}],"requires":["装机量/就诊量","集采与医保政策状态"],"forbidden":["PB（区分度低）"]},"other":{"archetype":"other","label":"其他/待归类","basis":"尚未归类，只能做相对观察。","methods":[{"role":"auxiliary","method":"forward_pe","label":"前瞻 PE"}],"requires":["先完成 archetype 归类"],"forbidden":[]}},"OVERRIDES":[{"companyId":"co-0123","archetype":"stable_cash_dividend","reason":"IND-06 同时含航运、快递与铁路：京沪高铁是收费类稳定现金流资产，不能套用运价周期模型。"},{"companyId":"co-0119","archetype":"payment","reason":"收单机构，接近低毛利交易处理而非卡组织网络，但仍按支付量建模。"}],"TRACK_FACTORS":{"IT-01":[{"factor":"ai_capex","label":"AI 算力资本开支","weight":"primary","direction":"positive","reason":"加速器需求直接由云厂商与主权 AI 资本开支决定"},{"factor":"memory_price_cycle","label":"存储价格周期","weight":"secondary","direction":"positive","reason":"加速器与 HBM 共用先进封装产能，存储景气会挤占产能，但需求端同向"}],"IT-02":[{"factor":"ai_capex","label":"AI 算力资本开支","weight":"primary","direction":"positive","reason":"先进制程与封装产能跟随 AI 芯片订单"},{"factor":"semiconductor_cycle","label":"成熟制程产能利用率","weight":"secondary","direction":"positive","reason":"除先进节点外，成熟制程稼动率决定折旧摊薄"},{"factor":"geopolitical_export_control","label":"出口管制","weight":"secondary","direction":"negative","reason":"先进节点客户的设备许可与订单受出口管制直接约束"}],"IT-03":[{"factor":"semiconductor_cycle","label":"半导体资本开支周期","weight":"primary","direction":"positive","reason":"设备订单跟随晶圆厂扩产资本开支"},{"factor":"geopolitical_export_control","label":"出口管制","weight":"secondary","direction":"mixed","reason":"管制同时带来国产替代订单与被限制客户收入"}],"IT-04":[{"factor":"memory_price_cycle","label":"存储价格周期","weight":"primary","direction":"positive","reason":"DRAM/NAND 位元价格直接决定利润"},{"factor":"ai_capex","label":"AI 算力资本开支","weight":"secondary","direction":"positive","reason":"HBM 需求由 AI 服务器拉动，与传统周期叠加"}],"IT-05":[{"factor":"ai_capex","label":"AI 算力资本开支","weight":"primary","direction":"positive","reason":"800G/1.6T 模块需求来自智算集群扩建"},{"factor":"semiconductor_cycle","label":"光芯片供给周期","weight":"secondary","direction":"negative","reason":"上游光芯片与 DSP 的产能与代次决定模块厂毛利"}],"IT-06":[{"factor":"ai_capex","label":"AI 算力资本开支","weight":"primary","direction":"positive","reason":"高多层 PCB 与高速材料由 AI 服务器主板拉动"},{"factor":"commodity_price","label":"铜箔与覆铜板成本","weight":"secondary","direction":"negative","reason":"铜价与树脂价格上行压缩 PCB 毛利"}],"IT-07":[{"factor":"platform_regulation","label":"平台监管与政企采购","weight":"primary","direction":"mixed","reason":"办公软件与云服务收入由政企采购预算与合规要求决定"},{"factor":"ai_capex","label":"AI 算力资本开支","weight":"secondary","direction":"positive","reason":"Copilot 类订阅与自有模型推理投入受 AI 节奏影响"}],"IT-08":[{"factor":"semiconductor_cycle","label":"半导体设计景气","weight":"primary","direction":"positive","reason":"EDA 授权收入跟随芯片设计活动与先进工艺迭代"},{"factor":"geopolitical_export_control","label":"出口管制","weight":"secondary","direction":"mixed","reason":"工具与 IP 的对华许可受出口管制约束"}],"IT-09":[{"factor":"policy_regulation","label":"政策与合规周期","weight":"primary","direction":"positive","reason":"安全预算受政策与合规要求驱动"},{"factor":"china_consumption","label":"政企 IT 预算","weight":"secondary","direction":"negative","reason":"地方财政与政企 IT 预算收缩会延后项目验收"}],"COM-01":[{"factor":"platform_regulation","label":"平台监管与广告周期","weight":"primary","direction":"mixed","reason":"广告定价与反垄断政策决定变现"},{"factor":"ai_capex","label":"AI 算力资本开支","weight":"secondary","direction":"mixed","reason":"自建或外购算力既推高成本，也决定广告与云模型的竞争位置"}],"COM-02":[{"factor":"interest_rate","label":"利率与股息吸引力","weight":"primary","direction":"negative","reason":"高股息资产估值对无风险利率敏感：利率下行则估值抬升"},{"factor":"policy_regulation","label":"提速降费与国资考核","weight":"secondary","direction":"mixed","reason":"资费监管与分红率考核同时影响收入与股息支付"}],"CD-01":[{"factor":"new_energy_price_war","label":"新能源价格战","weight":"primary","direction":"negative","reason":"单车盈利由价格战与成本曲线决定，降价直接压缩单车毛利"},{"factor":"geopolitical_export_control","label":"出口关税与贸易壁垒","weight":"secondary","direction":"negative","reason":"海外关税与本地化要求在价格战之外额外决定出口盈利"}],"CD-02":[{"factor":"china_consumption","label":"中国消费与地产链","weight":"primary","direction":"positive","reason":"家电更新与地产竣工相关"},{"factor":"commodity_price","label":"铜铝与面板成本","weight":"secondary","direction":"negative","reason":"原材料与面板涨价压缩家电毛利"}],"CD-03":[{"factor":"china_consumption","label":"中国消费与电商景气","weight":"primary","direction":"positive","reason":"电商 GMV 与外贸景气驱动"},{"factor":"fx","label":"汇率","weight":"secondary","direction":"mixed","reason":"跨境业务与海外仓成本受汇率影响"}],"CS-01":[{"factor":"china_consumption","label":"中国消费与商务需求","weight":"primary","direction":"positive","reason":"白酒终端动销与批价绑定商务与宴席场景"},{"factor":"policy_regulation","label":"消费税与价格监管","weight":"secondary","direction":"negative","reason":"消费税调整与批价管控直接影响渠道利润"}],"CS-02":[{"factor":"china_consumption","label":"中国消费降级压力","weight":"primary","direction":"negative","reason":"大众品依赖量与价的平衡，消费降级时结构下移"},{"factor":"commodity_price","label":"农产品与包材成本","weight":"secondary","direction":"negative","reason":"原奶、糖与包材价格上行压缩毛利"}],"HC-01":[{"factor":"medicare_pricing","label":"医保谈判与集采","weight":"primary","direction":"mixed","reason":"创新药定价与放量受医保准入影响：降价换量"},{"factor":"geopolitical_export_control","label":"海外授权与审批","weight":"secondary","direction":"positive","reason":"License-out 与海外临床进度决定管线价值变现"}],"HC-02":[{"factor":"medicare_pricing","label":"集采与医院采购","weight":"primary","direction":"negative","reason":"集采降价与医院资本开支收缩直接压缩器械价格与招标量"},{"factor":"policy_regulation","label":"设备更新与贴息政策","weight":"secondary","direction":"positive","reason":"医疗设备更新专项会前置采购需求"}],"HC-03":[{"factor":"medicare_pricing","label":"医保支付与消费医疗","weight":"primary","direction":"mixed","reason":"医疗服务量价受支付方约束，医保内控费与自费项目景气方向相反"},{"factor":"china_consumption","label":"可选医疗消费","weight":"secondary","direction":"positive","reason":"眼科、口腔等自费项目跟随居民可选消费"}],"FIN-01":[{"factor":"interest_rate","label":"净息差（利率与存款重定价）","weight":"primary","direction":"negative","reason":"利率下行时资产端重定价快于存款端，净息差通常收窄"},{"factor":"property_cycle","label":"地产与城投资产质量","weight":"secondary","direction":"negative","reason":"地产与平台敞口决定不良生成与拨备计提"}],"FIN-02":[{"factor":"interest_rate","label":"长端利率与利差损","weight":"primary","direction":"negative","reason":"长端利率下行压低再投资收益并抬高准备金，形成利差损"},{"factor":"policy_regulation","label":"定价与渠道监管","weight":"secondary","direction":"negative","reason":"预定利率与报行合一监管压低新业务价值率"}],"FIN-03":[{"factor":"policy_regulation","label":"交投活跃度与监管","weight":"primary","direction":"positive","reason":"成交额与互联互通政策决定收入"},{"factor":"interest_rate","label":"结算利率与衍生品需求","weight":"secondary","direction":"mixed","reason":"利率水平影响结算利息收入与衍生品对冲需求"}],"FIN-04":[{"factor":"policy_regulation","label":"支付监管与费率","weight":"primary","direction":"negative","reason":"备付金利息与费率上限由监管直接规定"},{"factor":"china_consumption","label":"社会消费品零售","weight":"secondary","direction":"positive","reason":"交易笔数跟随线下与线上消费景气"}],"IND-01":[{"factor":"china_consumption","label":"制造业资本开支","weight":"primary","direction":"positive","reason":"工控订单跟随制造业固定资产投资"},{"factor":"ai_capex","label":"AI 数据中心建设","weight":"secondary","direction":"positive","reason":"数据中心温控与电源柜拉动工控与自动化订单"}],"IND-02":[{"factor":"grid_capex","label":"电网资本开支","weight":"primary","direction":"positive","reason":"国网招标节奏决定订单"},{"factor":"ai_capex","label":"数据中心用电与配网","weight":"secondary","direction":"positive","reason":"智算中心用电增长带动配网扩容需求"}],"IND-03":[{"factor":"new_energy_price_war","label":"锂电价格战","weight":"primary","direction":"negative","reason":"电芯价格与产能利用率决定利润，价格战压缩单 Wh 盈利"},{"factor":"commodity_price","label":"碳酸锂与镍钴价格","weight":"secondary","direction":"mixed","reason":"上游锂价的涨跌同时影响成本与存货减值"}],"IND-04":[{"factor":"new_energy_price_war","label":"光伏与储能景气","weight":"primary","direction":"mixed","reason":"装机节奏决定出货，组件与储能价格战决定单机毛利"},{"factor":"grid_capex","label":"配储与电网接入","weight":"secondary","direction":"positive","reason":"强制配储与电网接入政策决定储能装机"}],"IND-05":[{"factor":"commodity_price","label":"基建与矿业资本开支","weight":"primary","direction":"positive","reason":"工程机械销量跟随下游基建与矿业资本开支"},{"factor":"property_cycle","label":"地产与出口景气","weight":"secondary","direction":"positive","reason":"地产竣工与海外出口是工程机械的另一半需求"}],"IND-06":[{"factor":"commodity_price","label":"运价与贸易周期","weight":"primary","direction":"positive","reason":"航运与快递价格波动大"},{"factor":"china_consumption","label":"出口货量","weight":"secondary","direction":"positive","reason":"集运与快递量跟随出口与社零货运量"}],"IND-07":[{"factor":"ai_capex","label":"AI 数据中心建设","weight":"primary","direction":"positive","reason":"机柜功率密度与机房建设决定订单"},{"factor":"grid_capex","label":"配电与并网","weight":"secondary","direction":"positive","reason":"高密度机柜受限于配电容量与电网接入"}],"MAT-01":[{"factor":"commodity_price","label":"铜金价格","weight":"primary","direction":"positive","reason":"金属价格直接决定矿企利润"},{"factor":"interest_rate","label":"实际利率（金价）","weight":"secondary","direction":"negative","reason":"实际利率上行压制金价与黄金股的估值中枢"}],"MAT-02":[{"factor":"commodity_price","label":"化工价差","weight":"primary","direction":"positive","reason":"产品价差与能源成本决定利润"},{"factor":"property_cycle","label":"地产与制造业需求","weight":"secondary","direction":"positive","reason":"MDI 等品种需求与地产竣工、家电汽车产量绑定"}],"EN-01":[{"factor":"commodity_price","label":"油价","weight":"primary","direction":"positive","reason":"实现油价决定上游利润"},{"factor":"fx","label":"汇率","weight":"secondary","direction":"mixed","reason":"油气以美元计价，人民币汇率影响折算与成本"}],"EN-02":[{"factor":"commodity_price","label":"煤价与电价","weight":"primary","direction":"positive","reason":"长协与现货价格决定现金流"},{"factor":"policy_regulation","label":"长协比例与电价管制","weight":"secondary","direction":"mixed","reason":"长协履约率与电价上限决定价格弹性"}],"UTIL-01":[{"factor":"interest_rate","label":"利率（股息贴现率）","weight":"primary","direction":"negative","reason":"类债券资产：折现率下行则估值抬升，上行则估值承压（与银行方向相反）"},{"factor":"commodity_price","label":"来水与梯级调度","weight":"secondary","direction":"positive","reason":"来水与梯级调度决定发电量与度电毛利"}],"UTIL-02":[{"factor":"commodity_price","label":"气价与顺价机制","weight":"primary","direction":"mixed","reason":"购销价差与顺价进度决定毛利：气价上行在顺价不足时压缩毛利"},{"factor":"policy_regulation","label":"终端顺价与居民气价","weight":"secondary","direction":"positive","reason":"顺价机制落地是气价上涨转化为利润的前提"}],"RE-01":[{"factor":"property_cycle","label":"地产与租金周期","weight":"primary","direction":"positive","reason":"出租率与资本化率与地产周期相关"},{"factor":"interest_rate","label":"资本化率与融资成本","weight":"secondary","direction":"negative","reason":"无风险利率上行抬升资本化率，压低 NAV"}]},"FACTOR_LABELS":{"ai_capex":"AI 算力资本开支","semiconductor_cycle":"半导体资本开支周期","memory_price_cycle":"存储价格周期","china_consumption":"中国消费与内需","commodity_price":"商品价格周期","interest_rate":"利率","policy_regulation":"政策与监管","fx":"汇率","platform_regulation":"平台监管与广告周期","property_cycle":"地产与租金周期","new_energy_price_war":"新能源价格战","grid_capex":"电网与配电资本开支","medicare_pricing":"医保谈判与集采","geopolitical_export_control":"出口管制"},"COMPANY_FACTOR_ADDITIONS":{"co-0005":[{"factor":"geopolitical_export_control","label":"出口管制","weight":"primary","direction":"negative","reason":"先进制程客户与设备许可直接受出口管制约束，限制收入与扩产节奏"}],"co-0001":[{"factor":"platform_regulation","label":"出口管制取代平台反垄断","weight":"secondary","direction":"mixed","reason":"对华销售许可与反垄断审查共同约束区域收入，管制已成为比平台监管更硬的约束"}],"co-0106":[{"factor":"china_consumption","label":"广告主预算","weight":"secondary","direction":"positive","reason":"梯媒收入滞后于社零与广告主预算，消费走弱时刊例价与上刊率先回落"}],"co-0047":[{"factor":"geopolitical_export_control","label":"创新药出海与出海定价","weight":"secondary","direction":"positive","reason":"海外授权与 FDA 审批决定管线价值变现，医保降价压力被出海首付款部分抵消"}],"co-0070":[{"factor":"commodity_price","label":"碳酸锂与镍钴价格","weight":"secondary","direction":"mixed","reason":"锂价下行降低电芯成本，但存货跌价与电池售价联动使价格弹性双向"}],"co-0073":[{"factor":"grid_capex","label":"新能源配储与并网","weight":"secondary","direction":"positive","reason":"配储要求与电网接入节奏决定储能逆变器与系统集成出货"}],"co-0079":[{"factor":"commodity_price","label":"集运运价","weight":"secondary","direction":"positive","reason":"绕行与运力投放决定运价，运价上行直接放大利差；运价归因于运力而非商品价格本身"}],"co-0083":[{"factor":"interest_rate","label":"实际利率（金价）","weight":"secondary","direction":"negative","reason":"金价与实际利率反向，利率上行压制黄金分部估值"}],"co-0031":[{"factor":"new_energy_price_war","label":"电芯过剩下的电池成本红利","weight":"secondary","direction":"positive","reason":"电芯产能过剩压低整车电池成本，同一因子在整车端是降价压力、在电池采购端是毛利支撑"}],"co-0050":[{"factor":"medicare_pricing","label":"欧美医保支付与招标周期","weight":"secondary","direction":"mixed","reason":"收入以北美与欧洲为主，报销目录与医院招标节奏充当海外版的集采定价机制"}]}}"#;
