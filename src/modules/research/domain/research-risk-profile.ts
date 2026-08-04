export type ResearchRiskSeverity = "critical" | "high" | "medium" | "low" | "unavailable";
export type ResearchRiskDimensionId = "thesis" | "valuation" | "market" | "coverage";

export type ResearchRiskReference = { evidenceId: string; title: string; url: string; publishedAt: number; grade: string };

export type ResearchRiskFinding = {
  id: string;
  dimension: ResearchRiskDimensionId;
  severity: ResearchRiskSeverity;
  title: string;
  summary: string;
  whyItMatters: string;
  trigger: string;
  reviewRule: string;
  references: ResearchRiskReference[];
};

export type ResearchRiskDimension = {
  id: ResearchRiskDimensionId;
  label: string;
  severity: ResearchRiskSeverity;
  summary: string;
  findingCount: number;
};

export type ResearchRiskGap = { id: string; label: string; impact: string; status: "not_integrated" | "source_unhealthy" };

export type ResearchRiskProfile = {
  state: "优先复核" | "持续监测" | "资料待补";
  summary: string;
  dimensions: ResearchRiskDimension[];
  findings: ResearchRiskFinding[];
  gaps: ResearchRiskGap[];
  ruleVersion: string;
};

export type ResearchRiskProfileInput = {
  peTtm: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  drawdown90d: number | null;
  evidence: Array<ResearchRiskReference & { eventStatus: string }>;
  impacts: Array<{ impactId: string; direction: string; transmission: string; confidence: number; title: string | null; references: ResearchRiskReference[] }>;
  sources: Array<{ sourceId: string; name: string; state: string; lastSuccessAt: number | null; lastError: string | null }>;
  documentCount: number;
};

export const RESEARCH_RISK_PROFILE_RULE_VERSION = "research-risk-profile.v1";

const severityRank: Record<ResearchRiskSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, unavailable: 1 };
const dimensionLabels: Record<ResearchRiskDimensionId, string> = { thesis: "命题与证据", valuation: "估值安全边际", market: "市场波动", coverage: "信息与组合覆盖" };

function maxSeverity(values: ResearchRiskSeverity[]): ResearchRiskSeverity {
  return values.reduce((current, value) => severityRank[value] > severityRank[current] ? value : current, "unavailable");
}

function referenceList(items: ResearchRiskReference[]): ResearchRiskReference[] {
  return items.slice(0, 5);
}

function formatPct(value: number): string { return `${value.toFixed(1)}%`; }

export function buildResearchRiskProfile(input: ResearchRiskProfileInput): ResearchRiskProfile {
  const findings: ResearchRiskFinding[] = [];
  const conflicting = input.evidence.filter((item) => item.grade === "conflicting" || item.eventStatus === "conflicting");
  const confirmed = input.evidence.filter((item) => item.grade === "official_confirmed" || item.grade === "multi_source_confirmed");
  if (conflicting.length) {
    findings.push({ id: "conflicting-evidence", dimension: "thesis", severity: "critical", title: "核心命题存在冲突证据",
      summary: `已关联 ${conflicting.length} 条冲突证据；支持性材料不能覆盖这部分反证。`,
      whyItMatters: "若冲突涉及业绩、订单、政策或竞争格局，原有研究命题可能不成立。",
      trigger: "新增冲突来源，或原始来源否定既有关键假设。",
      reviewRule: "保留冲突记录；仅在更高等级原始来源解释分歧后降低风险等级。",
      references: referenceList(conflicting) });
  } else if (!input.evidence.length) {
    findings.push({ id: "missing-company-evidence", dimension: "thesis", severity: "unavailable", title: "缺少公司精确关联的原始证据",
      summary: "当前无法以已链接的公告、研报或官方来源验证研究命题。",
      whyItMatters: "没有可复核证据时，任何正面或负面结论都只是推测。",
      trigger: "形成研究命题但仍未附可访问的原始来源。",
      reviewRule: "补充公司级原始来源并标注证据等级、发布日期与实体关联。",
      references: [] });
  } else if (!confirmed.length) {
    findings.push({ id: "unconfirmed-company-evidence", dimension: "thesis", severity: "medium", title: "证据尚未被独立确认",
      summary: `已关联 ${input.evidence.length} 条材料，但没有官方确认或多来源确认的证据。`,
      whyItMatters: "单一线索可能遗漏前提、时效或相反事实。",
      trigger: "关键判断仍只依赖单一来源或未定级线索。",
      reviewRule: "为关键命题补至少一个独立原始来源；保留无法确认的线索。",
      references: referenceList(input.evidence) });
  }

  for (const impact of input.impacts.filter((item) => item.direction === "pressure" || item.direction === "mixed")) {
    const severity: ResearchRiskSeverity = impact.direction === "pressure" && impact.confidence >= 0.7 ? "high" : "medium";
    findings.push({ id: `pressure-impact:${impact.impactId}`, dimension: "thesis", severity,
      title: impact.title ? `不利传导：${impact.title}` : "存在待复核的不利传导",
      summary: `${impact.transmission || "未提供传导路径"}（当前置信度 ${(Math.max(0, Math.min(1, impact.confidence)) * 100).toFixed(0)}%）。`,
      whyItMatters: "外部事件传导至公司时，收入、成本、估值预期或市场流动性都可能受影响。",
      trigger: "事件进展扩大、传导链条获得确认，或新的不利影响被关联到公司。",
      reviewRule: "核对传导路径、时间范围和公司暴露；不将低置信度影响当作已发生事实。",
      references: referenceList(impact.references) });
  }

  const valuationPercentile = Math.max(input.pePercentile ?? -1, input.pbPercentile ?? -1);
  if (valuationPercentile >= 75) {
    findings.push({ id: "valuation-safety-margin", dimension: "valuation", severity: valuationPercentile >= 90 ? "high" : "medium", title: "历史估值安全边际偏弱",
      summary: `PE ${input.peTtm === null ? "待补" : input.peTtm.toFixed(2)}（历史分位 ${input.pePercentile === null ? "待补" : formatPct(input.pePercentile)}），PB ${input.pb === null ? "待补" : input.pb.toFixed(2)}（历史分位 ${input.pbPercentile === null ? "待补" : formatPct(input.pbPercentile)}）。`,
      whyItMatters: "较高历史分位不等于会下跌，但对盈利兑现、预测误差和利率变化更敏感。",
      trigger: "PE 或 PB 历史分位持续处于高位，且利润兑现缺少新的验证。",
      reviewRule: "补充可追溯的未来利润路径与同行口径；历史分位不能替代盈利预测。",
      references: [] });
  } else if (input.pePercentile === null && input.pbPercentile === null) {
    findings.push({ id: "missing-valuation-history", dimension: "valuation", severity: "unavailable", title: "估值历史覆盖不足",
      summary: "PE/PB 的有效历史样本不足，无法描述当前估值在自身历史中的位置。",
      whyItMatters: "缺少可比锚点时，无法验证是否存在估值安全边际。",
      trigger: "研究需要比较估值位置但基础数据不完整。",
      reviewRule: "修复历史估值覆盖，并核对亏损期、异常值和口径变化。",
      references: [] });
  }

  if (input.drawdown90d !== null) {
    const severity: ResearchRiskSeverity = input.drawdown90d <= -30 ? "high" : input.drawdown90d <= -15 ? "medium" : "low";
    findings.push({ id: "market-drawdown", dimension: "market", severity, title: "价格相对近期高点的波动风险",
      summary: `近 90 个交易日相对高点回撤 ${formatPct(input.drawdown90d)}。该指标描述波动，不解释原因。`,
      whyItMatters: "持续回撤可能反映风险偏好、预期修正或流动性变化，需要回到原始证据确认。",
      trigger: "回撤扩大，或价格变化与新的负面证据同时出现。",
      reviewRule: "将价格变化与公告、业绩、供需和市场环境逐项对照；不以回撤本身推导交易动作。",
      references: [] });
  } else {
    findings.push({ id: "missing-market-history", dimension: "market", severity: "unavailable", title: "市场波动历史不足",
      summary: "有效日线不足，无法计算近 90 个交易日相对高点回撤。",
      whyItMatters: "价格压力和波动区间尚未被量化。",
      trigger: "日线覆盖中断或样本数量不足。",
      reviewRule: "补齐 Xueqiu 日线后重新计算；不引入其他股票 K 线来源作为替代。",
      references: [] });
  }

  const unhealthySources = input.sources.filter((item) => item.state !== "healthy");
  const gaps: ResearchRiskGap[] = [
    { id: "capital-flow", label: "个股实时资金流", impact: "无法判断资金面的持续性或异动是否具备可审计来源。", status: "not_integrated" },
    { id: "fundamental-quality", label: "完整财务质量因子", impact: "无法系统核验盈利质量、现金流、杠杆与治理风险。", status: "not_integrated" },
    { id: "industry-exposure", label: "行业到公司暴露映射", impact: "行业事件不能被自动假定会传导到该公司。", status: "not_integrated" },
    { id: "portfolio-exposure", label: "个人组合暴露与约束", impact: "无法评估集中度、相关性、仓位和个人风险承受边界。", status: "not_integrated" },
  ];
  if (unhealthySources.length) gaps.push({ id: "source-health", label: `${unhealthySources.length} 个态势来源异常`, impact: "部分证据覆盖或更新时效可能受影响，需查看来源健康状态。", status: "source_unhealthy" });
  if (!input.documentCount) gaps.push({ id: "company-documents", label: "公司本地文档覆盖", impact: "尚无本地归档文档，不能把信息缺口误当作没有风险。", status: "not_integrated" });

  const dimensions = (Object.keys(dimensionLabels) as ResearchRiskDimensionId[]).map((id) => {
    const items = findings.filter((item) => item.dimension === id);
    const severity = items.length ? maxSeverity(items.map((item) => item.severity)) : "unavailable";
    const summary = id === "coverage" ? `${gaps.length} 项风险输入尚未接入或来源异常。` : items.length ? `已识别 ${items.length} 项，最高为${severityLabel(severity)}。` : "尚无可审计的风险条目。";
    return { id, label: dimensionLabels[id], severity, summary, findingCount: items.length };
  });
  dimensions.find((item) => item.id === "coverage")!.severity = gaps.length ? "unavailable" : "low";
  const highest = maxSeverity(findings.map((item) => item.severity));
  const coreInputMissing = findings.some((item) => item.severity === "unavailable" && item.dimension !== "coverage");
  const state = highest === "critical" ? "优先复核" : coreInputMissing ? "资料待补" : "持续监测";
  const summary = state === "优先复核" ? "存在冲突证据或高优先级不利传导，先核对反证与传导路径。"
    : state === "资料待补" ? "关键风险输入尚未覆盖；页面保留缺口，不用推测补齐。"
      : "当前没有冲突证据，但风险仍需随证据、估值与价格变化持续复核。";
  return { state, summary, dimensions, findings: findings.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]), gaps, ruleVersion: RESEARCH_RISK_PROFILE_RULE_VERSION };
}

export function severityLabel(value: ResearchRiskSeverity): string {
  return ({ critical: "优先复核", high: "高", medium: "中", low: "低", unavailable: "待补" } as Record<ResearchRiskSeverity, string>)[value];
}
