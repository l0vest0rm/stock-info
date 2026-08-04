import type { ResearchCoverageModule, ResearchCoverageModuleId } from "./research-coverage";

export type ResearchDepth = "basic" | "standard" | "deep";
export type ResearchDepthStatus = "ready" | "partial" | "blocked" | "unavailable";

export type ResearchDepthRequirement = {
  id: string;
  label: string;
  status: ResearchDepthStatus;
  blockedConclusion: string;
  nextEvidence: string;
};

export type ResearchDepthAssessment = {
  depth: ResearchDepth;
  label: string;
  status: ResearchDepthStatus;
  requirements: ResearchDepthRequirement[];
  allowedOutput: string;
  prohibitedOutput: string;
};

export type ResearchDepthAssessmentSet = {
  ruleVersion: "research-depth.v1";
  levels: ResearchDepthAssessment[];
};

type Section = { availability?: string; items?: unknown[] } | null | undefined;

const sectionStatus = (section: Section): ResearchDepthStatus => {
  if (section?.availability === "available" && Array.isArray(section.items) && section.items.length > 0) return "ready";
  if (section?.availability === "unavailable") return "unavailable";
  return "blocked";
};

const moduleStatus = (modules: ResearchCoverageModule[], id: ResearchCoverageModuleId): ResearchDepthStatus => {
  const status = modules.find((item) => item.moduleId === id)?.status;
  return status === "ready" || status === "partial" || status === "blocked" || status === "unavailable" ? status : "unavailable";
};

const combine = (requirements: ResearchDepthRequirement[]): ResearchDepthStatus => {
  const statuses = requirements.map((item) => item.status);
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("partial")) return "partial";
  return "ready";
};

const requirement = (id: string, label: string, status: ResearchDepthStatus, blockedConclusion: string, nextEvidence: string): ResearchDepthRequirement => ({ id, label, status, blockedConclusion, nextEvidence });

/**
 * The framework's depth levels are declared required inputs, never a score.
 * A later level includes the earlier one and must therefore retain every
 * unresolved prerequisite instead of averaging it away.
 */
export function assessResearchDepths(input: {
  modules: ResearchCoverageModule[];
  sourceDocumentCount: number;
  industryExposures: Section;
  peerSets: Section;
  governance: Section;
  operatingModelDetails: { segments: number; contracts: number; unitEconomics: number };
  marketDetails: { assessments: number; shareBridgeSteps: number; profitPools: number };
  stressScenarios: Section;
  calibrations: Section;
}): ResearchDepthAssessmentSet {
  const basic = [
    requirement("subject", "经营公司与具体证券", moduleStatus(input.modules, "identity"), "不能混用多地上市或 ADR 的市场与权利数据。", "补充确认的经营主体、证券和权利来源。"),
    requirement("financial_trend", "最近财务趋势与来源状态", moduleStatus(input.modules, "financials"), "不能把结构化财报或缺失输入写成完整基本面事实。", "补齐同口径三表与法定核验。"),
    requirement("source_material", "重大来源材料", input.sourceDocumentCount > 0 ? "ready" : "blocked", "不能把无来源的市场观察升级为公司研究。", "绑定公告、正式披露或可使用来源材料。"),
    requirement("risk_gap", "核心风险与资料缺口", moduleStatus(input.modules, "risk_review"), "不能以价格、估值或总分掩盖核心风险缺口。", "建立来源绑定的命题、风险和复核期。"),
  ];
  const basicAssessment: ResearchDepthAssessment = {
    depth: "basic", label: "基础研究", status: combine(basic), requirements: basic,
    allowedOutput: "研究优先级、显著异常和待补资料。",
    prohibitedOutput: "完整价值区间、确定性竞争优势或长期盈利结论。",
  };

  const standard = [
    ...basic,
    requirement("operating", "字段化业务、驱动与市场边界", moduleStatus(input.modules, "operating"), "不能在无业务边界时形成可复核经营判断。", "补充分部、合同、单位经济、驱动计划和市场边界。"),
    requirement("industry", "行业档案与公司暴露", sectionStatus(input.industryExposures), "不能把行业标签当作主营或竞争市场。", "建立带来源的行业暴露和赛道档案。"),
    requirement("peers", "同行集与跨市场可比性", sectionStatus(input.peerSets), "不能直接比较不同会计、财年、币种或权利基础的证券。", "建立带排除理由和调整说明的同行集。"),
    requirement("valuation", "情景与证券估值桥", moduleStatus(input.modules, "valuation"), "不能在缺少股本、FX、净债务或权利输入时输出精确每股价值。", "保存来源绑定的情景和估值版本。"),
  ];
  const standardAssessment: ResearchDepthAssessment = {
    depth: "standard", label: "标准研究", status: combine(standard), requirements: standard,
    allowedOutput: "业务、财务、估值状态以及主要命题和证伪。",
    prohibitedOutput: "缺少关键股本、现金流或市场边界时的精确目标价。",
  };

  const deep = [
    ...standard,
    requirement("segments", "分部、合同与单位经济", input.operatingModelDetails.segments > 0 && input.operatingModelDetails.contracts > 0 && input.operatingModelDetails.unitEconomics > 0 ? "ready" : "blocked", "不能把单一总量假设当作重要公司的详细经营模型。", "补齐来源绑定的分部、合同和单位经济字段。"),
    requirement("market_validation", "市场空间、份额桥与利润池", input.marketDetails.assessments > 0 && input.marketDetails.shareBridgeSteps > 0 && input.marketDetails.profitPools > 0 ? "ready" : "blocked", "不能把 TAM 或领导地位直接变成收入、份额或利润结论。", "补齐上下测算、份额桥、利润池及边界校验。"),
    requirement("governance", "管理层、治理与资本配置", sectionStatus(input.governance), "不能以单一模糊评分替代治理和资本配置审查。", "记录五维治理和资本配置的来源事实。"),
    requirement("calibration", "预测兑现与正式实际校准", sectionStatus(input.calibrations), "不能把未校准的预测或来源观点当作长期能力事实。", "以同口径正式实际完成至少一次校准。"),
    requirement("stress", "详细压力、风险传导与复盘", sectionStatus(input.stressScenarios), "不能在无压力路径和触发条件时输出带置信边界的价值区间。", "保存来源绑定的压力情景、传导路径和复盘。"),
  ];
  return {
    ruleVersion: "research-depth.v1",
    levels: [basicAssessment, standardAssessment, {
      depth: "deep", label: "深度研究", status: combine(deep), requirements: deep,
      allowedOutput: "带置信边界的价值区间、命题变化和监测计划。",
      prohibitedOutput: "把渠道线索、单一研报或模型假设升级为事实。",
    }],
  };
}
