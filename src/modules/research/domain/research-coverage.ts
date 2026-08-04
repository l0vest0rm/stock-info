import type { ForecastCoverageReadModel } from "./forecast-coverage";

export type ResearchCoverageStatus = "ready" | "partial" | "blocked" | "unavailable";
export type ResearchCoverageModuleId = "identity" | "financials" | "operating" | "industry_competition" | "forecasts" | "valuation" | "risk_review" | "market_state";

export type ResearchCoverageModule = {
  moduleId: ResearchCoverageModuleId;
  label: string;
  status: ResearchCoverageStatus;
  asOf: number | null;
  conclusionImpact: string;
  nextEvidence: string;
  target: "overview" | "foundation" | "model" | "review";
};

export type ResearchCoverage = { ruleVersion: "research-coverage.v1"; modules: ResearchCoverageModule[]; openReviewCount: number };

type Section = { availability?: string; items?: unknown[]; updatedAt?: number; createdAt?: number } | null | undefined;
const items = (section: Section) => Array.isArray(section?.items) ? section.items.length : 0;
const usable = (section: Section) => section?.availability === "available" && items(section) > 0;
const asOf = (...sections: Section[]) => Math.max(0, ...sections.map((section) => Number(section?.updatedAt ?? section?.createdAt ?? 0)).filter(Number.isFinite)) || null;

/** One read-model owner for what is covered, what is blocked and which evidence
 * can move a module forward. It does not compute an investment verdict. */
export function buildResearchCoverage(input: {
  identity: { operatingCompany?: unknown; listedSecurity?: { mappingStatus?: unknown } | null; gaps?: string[] };
  financials: { availability?: string; statutoryGate?: { status?: string } | null };
  marketStructure?: { availability?: string; perShareValuation?: { status?: string; reason?: string | null } | null };
  operating: { models?: Section; driverPlans?: Section; marketSpaceAssessments?: Section };
  industry: { exposures?: Section; peerSets?: Section; competitiveMarkets?: Section };
  forecast: ForecastCoverageReadModel;
  valuation: Section;
  reverseValuation: Section;
  risk: Section;
  theses: Section;
  modelReviewItems: Array<{ state?: string }>;
  market: { rows?: number; source?: string | null; latestDate?: string | null };
}): ResearchCoverage {
  const identityReady = Boolean(input.identity.operatingCompany) && input.identity.listedSecurity?.mappingStatus === "confirmed";
  const financialReady = input.financials.availability === "available" && input.financials.statutoryGate?.status === "verified";
  const operatingCount = [input.operating.models, input.operating.driverPlans, input.operating.marketSpaceAssessments].filter(usable).length;
  const industryCount = [input.industry.exposures, input.industry.peerSets, input.industry.competitiveMarkets].filter(usable).length;
  const valuationCount = items(input.valuation) + items(input.reverseValuation);
  const riskCount = [input.risk, input.theses].filter(usable).length;
  const openReviewCount = input.modelReviewItems.filter((item) => item.state === "open").length;
  const perShareReady = input.marketStructure?.availability === "available" && input.marketStructure.perShareValuation?.status === "ready";
  const valuationBlocker = !identityReady
    ? "先确认经营公司与具体上市证券的映射。"
    : !financialReady
      ? "正式财务或法定核验未通过；历史模型不能升级为当前估值结论。"
      : !perShareReady
        ? input.marketStructure?.perShareValuation?.reason || "缺少可审计的期末基础股数、稀释股数或 ADR 比例。"
        : null;
  const valuationStatus: ResearchCoverageStatus = !valuationCount
    ? "blocked"
    : valuationBlocker
      ? "blocked"
      : openReviewCount
        ? "partial"
        : "ready";
  return {
    ruleVersion: "research-coverage.v1",
    openReviewCount,
    modules: [
      { moduleId: "identity", label: "公司与证券范围", status: identityReady ? "ready" : input.identity.listedSecurity ? "partial" : "blocked", asOf: null, conclusionImpact: identityReady ? "主体、证券与权利映射可作为研究范围。" : "不得混用多地上市或 ADR 的价格、股本与权利。", nextEvidence: input.identity.gaps?.[0] || "补充经营主体、证券权利和官方关系文件。", target: "foundation" },
      { moduleId: "financials", label: "正式财务与法定核验", status: financialReady ? "ready" : input.financials.availability === "available" ? "partial" : "blocked", asOf: null, conclusionImpact: financialReady ? "同口径正式财务可进入质量分析。" : "财务质量和实际校准保持受阻，不以聚合值替代法定事实。", nextEvidence: financialReady ? "持续关注重述与新财报。" : "补齐三表字段、期间口径和 CNINFO/HKEX/SEC 核验。", target: "foundation" },
      { moduleId: "operating", label: "业务、驱动与市场", status: operatingCount === 3 ? "ready" : operatingCount ? "partial" : "blocked", asOf: asOf(input.operating.models, input.operating.driverPlans, input.operating.marketSpaceAssessments), conclusionImpact: operatingCount ? "仅已来源绑定的经营变量可传导至情景。" : "不能由叙述、价格或 LLM 直接补写经营假设。", nextEvidence: operatingCount === 3 ? "用最新披露复核驱动变量。" : "补充字段化分部/合同/单位经济、驱动计划和市场边界。", target: "foundation" },
      { moduleId: "industry_competition", label: "行业、竞争与同行", status: industryCount === 3 ? "ready" : industryCount ? "partial" : "blocked", asOf: asOf(input.industry.exposures, input.industry.peerSets, input.industry.competitiveMarkets), conclusionImpact: industryCount === 3 ? "行业暴露、竞争市场和同行可比边界均有来源绑定记录，仍需持续复核。" : "没有完整的行业暴露、竞争市场与同行可比边界，不能形成竞争位置或壁垒结论。", nextEvidence: industryCount === 3 ? "用最新行业、公司和同行来源复核竞争传导与侵蚀路径。" : "补主营/次要业务暴露、竞争市场边界及带排除理由的同行可比集。", target: "foundation" },
      forecastCoverageModule(input.forecast),
      { moduleId: "valuation", label: "情景与证券估值", status: valuationStatus, asOf: asOf(input.valuation, input.reverseValuation), conclusionImpact: !valuationCount ? "没有来源、情景、FX、股本和证券权利前，不展示每股结论。" : valuationBlocker ? `已保存版本仅作为历史审计记录；${valuationBlocker} 精确每股价值、股权价值和敏感性保持不可得。` : openReviewCount ? "存在新事实待复核；历史模型保持冻结。" : "已保存版本仅代表其冻结输入日期。", nextEvidence: !valuationCount ? "先建立字段化经营情景、股本/FX/净债务和来源证据。" : valuationBlocker || (openReviewCount ? "处理明确的模型待复核项，不自动重算。" : "以新版本记录新的情景或估值输入。"), target: "model" },
      { moduleId: "risk_review", label: "命题、风险与复盘", status: riskCount === 2 ? "ready" : riskCount ? "partial" : "blocked", asOf: asOf(input.risk, input.theses), conclusionImpact: riskCount ? "风险、反证和命题保留独立状态，不被价格走势抵消。" : "没有命题和风险台账，不能声称结论已完成。", nextEvidence: riskCount === 2 ? "记录触发结果、反证和快照差分。" : "建立来源绑定的核心命题、风险传导与复核期。", target: "review" },
      { moduleId: "market_state", label: "市场状态", status: input.market.rows && input.market.rows > 0 && input.market.source === "xueqiu" ? "partial" : "blocked", asOf: null, conclusionImpact: input.market.rows && input.market.rows > 0 && input.market.source === "xueqiu" ? "行情仅作辅助观察，不能形成基本面或交易结论。" : "没有符合股票 K 线来源边界的行情序列，市场观察不可得。", nextEvidence: input.market.rows && input.market.rows > 0 && input.market.source === "xueqiu" ? "将价格、回撤和流动性逐项对照公告、业绩和供需证据。" : "恢复 Xueqiu K 线来源并确认最新交易日；不得改用其他股票 K 线来源。", target: "overview" },
    ],
  };
}

function forecastCoverageModule(forecast: ForecastCoverageReadModel): ResearchCoverageModule {
  const counts = forecast.counts;
  const consolidation = forecast.consolidation;
  const sourceBoundary = "仅指已审核原始承载、模型血缘和独立来源组可追溯的机会性样本；绝非市场一致预期。";
  if (forecast.status === "ready") {
    return {
      moduleId: "forecasts", label: "来源预测与实际校准", status: "ready", asOf: forecast.asOf,
      conclusionImpact: `当前“${consolidation.label}”纳入 ${counts.included} 条来源预测；${sourceBoundary}`,
      nextEvidence: counts.excluded || counts.pending
        ? `继续处理待审核 ${counts.pending} 条、汇总排除 ${counts.excluded} 条的原因，并以法定实际校准。`
        : "以新来源版本和法定实际持续校准，历史样本不自动改写。",
      target: "model",
    };
  }
  if (forecast.status === "partial") {
    return {
      moduleId: "forecasts", label: "来源预测与实际校准", status: "partial", asOf: forecast.asOf,
      conclusionImpact: `已有 ${counts.originalEligible} 条已审核的原始独立来源预测，但尚无可展示的“已纳入样本的预测汇总”；${sourceBoundary}`,
      nextEvidence: "复核 v4 汇总状态、比较口径与排除原因；随后再以法定实际校准。",
      target: "model",
    };
  }
  if (forecast.status === "blocked") {
    return {
      moduleId: "forecasts", label: "来源预测与实际校准", status: "blocked", asOf: forecast.asOf,
      conclusionImpact: `已有 ${counts.candidates} 条来源候选和 ${counts.reviewed} 条人工审核记录，但没有已审核的原始独立来源预测；不生成未来业绩结论。`,
      nextEvidence: counts.pending
        ? `审核待处理的 ${counts.pending} 条候选，并为可纳入样本确认原始承载、模型血缘、独立来源组和会计口径。`
        : "补齐原始承载、模型血缘、独立来源组和会计口径；转载、联合署名、共享或未知承载不计入样本。",
      target: "model",
    };
  }
  return {
    moduleId: "forecasts", label: "来源预测与实际校准", status: "unavailable", asOf: null,
    conclusionImpact: "没有已审核的 v4 来源预测；普通文档或研报数量不能形成预测覆盖。",
    nextEvidence: "在授权范围内导入并预处理可使用的来源材料，再进行本地人工身份与独立性审核。",
    target: "model",
  };
}
