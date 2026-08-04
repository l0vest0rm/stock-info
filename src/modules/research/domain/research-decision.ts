export type ResearchGateState = "pass" | "watch" | "blocked" | "unavailable";

export type ResearchGate = {
  id: "evidence" | "valuation" | "trigger" | "risk";
  label: string;
  state: ResearchGateState;
  score: number | null;
  summary: string;
  nextStep: string;
};

export type ResearchDecisionInput = {
  klineRows: Array<{ close: number | null; peTtm: number | null; pb: number | null }>;
  evidenceCount: number;
  confirmedEvidenceCount: number;
  conflictingEvidenceCount: number;
  activeCandidateCount: number;
  pressureImpactCount: number;
  supportImpactCount: number;
};

export type ResearchDecision = {
  state: "资料待补" | "证伪复核" | "等更好估值" | "持续观察" | "优先研究";
  summary: string;
  gates: ResearchGate[];
  metrics: {
    close: number | null;
    peTtm: number | null;
    pb: number | null;
    pePercentile: number | null;
    pbPercentile: number | null;
    return20d: number | null;
    drawdown90d: number | null;
  };
  nextSteps: string[];
  ruleVersion: string;
};

export const RESEARCH_DECISION_RULE_VERSION = "research-decision.v1";

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentile(value: number | null, values: Array<number | null>): number | null {
  if (value === null) return null;
  const valid = values.filter((item): item is number => item !== null && Number.isFinite(item) && item > 0);
  if (valid.length < 30) return null;
  return Math.round((valid.filter((item) => item <= value).length / valid.length) * 1000) / 10;
}

function recentReturn(rows: ResearchDecisionInput["klineRows"], days: number): number | null {
  const closes = rows.map((item) => finite(item.close)).filter((item): item is number => item !== null && item > 0);
  if (closes.length <= days) return null;
  const earlier = closes.at(-(days + 1));
  const latest = closes.at(-1);
  return earlier && latest ? Math.round(((latest / earlier - 1) * 100) * 10) / 10 : null;
}

function drawdown(rows: ResearchDecisionInput["klineRows"], days: number): number | null {
  const closes = rows.map((item) => finite(item.close)).filter((item): item is number => item !== null && item > 0).slice(-days);
  const latest = closes.at(-1);
  const high = closes.length ? Math.max(...closes) : null;
  return latest && high ? Math.round(((latest / high - 1) * 100) * 10) / 10 : null;
}

export function buildResearchDecision(input: ResearchDecisionInput): ResearchDecision {
  const latest = input.klineRows.at(-1);
  const close = finite(latest?.close);
  const peTtm = finite(latest?.peTtm);
  const pb = finite(latest?.pb);
  const pePercentile = percentile(peTtm, input.klineRows.map((item) => finite(item.peTtm)));
  const pbPercentile = percentile(pb, input.klineRows.map((item) => finite(item.pb)));
  const return20d = recentReturn(input.klineRows, 20);
  const drawdown90d = drawdown(input.klineRows, 90);

  const evidenceState: ResearchGateState = input.evidenceCount === 0 ? "unavailable"
    : input.conflictingEvidenceCount > 0 ? "blocked"
      : input.confirmedEvidenceCount > 0 ? "pass" : "watch";
  const valuationState: ResearchGateState = pePercentile === null && pbPercentile === null ? "unavailable"
    : (pePercentile ?? pbPercentile ?? 100) <= 50 ? "pass"
      : (pePercentile ?? pbPercentile ?? 100) <= 75 ? "watch" : "blocked";
  const triggerState: ResearchGateState = return20d === null ? "unavailable"
    : input.supportImpactCount > input.pressureImpactCount && return20d > 0 ? "pass"
      : input.activeCandidateCount > 0 || return20d > 0 ? "watch" : "unavailable";
  const riskState: ResearchGateState = drawdown90d === null ? "unavailable"
    : input.conflictingEvidenceCount > 0 || input.pressureImpactCount > input.supportImpactCount ? "blocked"
      : drawdown90d <= -25 ? "watch" : "pass";
  const gates: ResearchGate[] = [
    { id: "evidence", label: "证据", state: evidenceState, score: input.evidenceCount ? Math.min(100, input.confirmedEvidenceCount * 50 + (input.evidenceCount - input.conflictingEvidenceCount) * 10) : null,
      summary: input.evidenceCount ? `关联 ${input.evidenceCount} 条证据，其中已确认 ${input.confirmedEvidenceCount} 条、冲突 ${input.conflictingEvidenceCount} 条。` : "尚无与该公司精确关联的态势证据。",
      nextStep: "核对原始公告、研报或官方来源，再升级证据等级。" },
    { id: "valuation", label: "估值", state: valuationState, score: pePercentile ?? pbPercentile,
      summary: pePercentile === null && pbPercentile === null ? "历史 PE/PB 数据不足，不能判断估值位置。" : `PE 历史分位 ${formatPct(pePercentile)}；PB 历史分位 ${formatPct(pbPercentile)}。`,
      nextStep: "结合未来利润预测与同行口径，确认估值锚是否可比。" },
    { id: "trigger", label: "触发", state: triggerState, score: return20d,
      summary: return20d === null ? "有效日线不足，无法确认近期价格行为。" : `近 20 个交易日 ${signed(return20d)}；未将价格表现单独当作基本面催化。`,
      nextStep: "寻找已验证的业绩、订单、供需或政策事件，并检查是否已被定价。" },
    { id: "risk", label: "风险", state: riskState, score: drawdown90d === null ? null : 100 + drawdown90d,
      summary: drawdown90d === null ? "有效日线不足；完整风险台账会保留这一数据缺口。" : `近 90 个交易日相对高点回撤 ${signed(drawdown90d)}；压力证据 ${input.pressureImpactCount} 条，支持证据 ${input.supportImpactCount} 条。完整分析见下方风险台账。`,
      nextStep: "逐条复核反证、传导路径、估值安全边际和个人组合暴露；不以回撤本身推导买入。" },
  ];

  const state: ResearchDecision["state"] = input.klineRows.length < 30 || evidenceState === "unavailable"
    ? "资料待补"
    : evidenceState === "blocked" || riskState === "blocked" ? "证伪复核"
      : valuationState === "blocked" ? "等更好估值"
        : gates.every((gate) => gate.state === "pass" || gate.state === "watch") && evidenceState === "pass" && valuationState === "pass" ? "优先研究"
          : "持续观察";
  const summaryByState: Record<ResearchDecision["state"], string> = {
    "资料待补": "当前资料不足以形成可审计的研究判断；系统只列出缺口，不补写结论。",
    "证伪复核": "存在冲突或压力证据，先复核反证，不将支持性材料覆盖风险。",
    "等更好估值": "历史估值位置偏高；这不是卖出建议，只表示当前缺少估值安全边际。",
    "持续观察": "已有部分输入，但尚未同时满足证据、估值、触发和风险的研究条件。",
    "优先研究": "证据与估值门槛暂未显示明显冲突，进入深入研究队列，而不是交易指令。",
  };
  return {
    state,
    summary: summaryByState[state],
    gates,
    metrics: { close, peTtm, pb, pePercentile, pbPercentile, return20d, drawdown90d },
    nextSteps: gates.filter((gate) => gate.state !== "pass").map((gate) => gate.nextStep),
    ruleVersion: RESEARCH_DECISION_RULE_VERSION,
  };
}

function formatPct(value: number | null): string { return value === null ? "待补" : `${value.toFixed(1)}%`; }
function signed(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`; }
