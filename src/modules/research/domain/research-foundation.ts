/**
 * Shared primitives for research modules.  These deliberately keep source facts,
 * reproducible observations, forecasts, and research judgement separate.  They
 * do not persist or infer missing business inputs.
 */

export type ResearchCoverageLevel = "basic" | "standard" | "deep";
export type ResearchRequirementStatus = "available" | "partial" | "missing" | "conflicting" | "stale" | "source_unhealthy" | "not_comparable" | "object_mismatch";
export type ResearchCompletionState = "object_mismatch" | "blocked" | "conflicted" | "stale" | "ready_for_review" | "frozen";
export type ResearchKnowledgeKind = "observed_fact" | "management_guidance" | "third_party_forecast" | "source_opinion" | "analysis_assumption" | "system_judgment" | "user_decision";

export type ResearchRequirement = {
  id: string;
  label: string;
  requiredAt: ResearchCoverageLevel;
  status: ResearchRequirementStatus;
  blocking: boolean;
  effect: string;
  nextStep: string;
  sourceIds?: string[];
};

export type ResearchGap = Pick<ResearchRequirement, "id" | "label" | "status" | "effect" | "nextStep">;

export type ResearchCompletion = {
  coverageLevel: ResearchCoverageLevel;
  state: ResearchCompletionState;
  summary: string;
  requirements: ResearchRequirement[];
  gaps: ResearchGap[];
  reviewedAt: number | null;
  frozenAt: number | null;
  ruleVersion: string;
};

export const RESEARCH_FOUNDATION_RULE_VERSION = "research-foundation.v1";

const coverageRank: Record<ResearchCoverageLevel, number> = { basic: 1, standard: 2, deep: 3 };

/**
 * Applies the framework's completion precedence.  It intentionally has no
 * percentage: a missing blocking requirement remains visible even when every
 * other requirement is available.
 */
export function buildResearchCompletion(input: {
  coverageLevel: ResearchCoverageLevel;
  requirements: readonly ResearchRequirement[];
  reviewedAt?: number | null;
  frozenAt?: number | null;
}): ResearchCompletion {
  const requirements = input.requirements.filter((item) => coverageRank[item.requiredAt] <= coverageRank[input.coverageLevel]);
  const gaps = requirements
    .filter((item) => item.status !== "available")
    .map(({ id, label, status, effect, nextStep }) => ({ id, label, status, effect, nextStep }));
  const has = (statuses: readonly ResearchRequirementStatus[]) => requirements.some((item) => statuses.includes(item.status));
  const hasBlocking = (statuses: readonly ResearchRequirementStatus[]) => requirements.some((item) => item.blocking && statuses.includes(item.status));
  const reviewedAt = validTimestamp(input.reviewedAt) ? input.reviewedAt : null;
  const frozenAt = validTimestamp(input.frozenAt) ? input.frozenAt : null;

  let state: ResearchCompletionState;
  let summary: string;
  if (has(["object_mismatch"])) {
    state = "object_mismatch";
    summary = "研究对象或证券口径不一致，后续财务、估值和结论不可使用。";
  } else if (hasBlocking(["missing", "source_unhealthy", "partial"])) {
    state = "blocked";
    summary = "存在阻断事实缺失、来源不可用或仅部分可得；受影响结论保持不可得。";
  } else if (has(["conflicting", "not_comparable"])) {
    state = "conflicted";
    summary = "存在关键来源冲突或不可比口径；先保留差异并完成核对。";
  } else if (has(["stale"])) {
    state = "stale";
    summary = "关键输入已过期；更新前不应沿用已有判断。";
  } else if (frozenAt !== null && reviewedAt !== null) {
    state = "frozen";
    summary = "已按所选研究深度复核并冻结；新事实或口径变化会触发重新复核。";
  } else {
    state = "ready_for_review";
    summary = gaps.length ? "阻断项已解除，但仍保留非阻断缺口供复核。" : "已具备所选研究深度的最低输入，等待复核或冻结快照。";
  }
  return { coverageLevel: input.coverageLevel, state, summary, requirements, gaps, reviewedAt, frozenAt, ruleVersion: RESEARCH_FOUNDATION_RULE_VERSION };
}

export type SourceFact = {
  id: string;
  label: string;
  value: number | null;
  asOf: number;
  sourceIds: string[];
};

export type DerivedObservation = {
  id: string;
  label: string;
  formula: string;
  unit: string;
  asOf: number;
  value: number | null;
  state: "available" | "unavailable";
  sourceFacts: SourceFact[];
  adjustments: string[];
  missingInputIds: string[];
};

/**
 * Records a calculation and its source-bound inputs.  Formula execution stays
 * in the owning financial/valuation module so this layer never guesses a value.
 */
export function buildDerivedObservation(input: Omit<DerivedObservation, "state" | "missingInputIds">): DerivedObservation {
  const sourceFacts = input.sourceFacts.map((item) => ({ ...item, sourceIds: [...new Set(item.sourceIds.filter(Boolean))] }));
  const missingInputIds = sourceFacts.filter((item) => !finite(item.value) || item.sourceIds.length === 0 || !validTimestamp(item.asOf)).map((item) => item.id);
  const value = finite(input.value) && input.formula.trim() && input.unit.trim() && validTimestamp(input.asOf) && missingInputIds.length === 0 ? input.value : null;
  return { ...input, formula: input.formula.trim(), unit: input.unit.trim(), value, sourceFacts, adjustments: [...input.adjustments], state: value === null ? "unavailable" : "available", missingInputIds };
}

export type SourceForecast = {
  id: string;
  publisher: string;
  sourceId: string;
  sourceUrl: string;
  companyId: string;
  metric: string;
  fiscalPeriod: string;
  accountingBasis: string;
  currency: string;
  unit: string;
  value: number | null;
  publishedAt: number;
  kind: "third_party_forecast" | "management_guidance";
};

export type ForecastExclusion = { forecastId: string; reason: string };
export type ForecastConsolidation = {
  companyId: string;
  metric: string;
  fiscalPeriod: string;
  accountingBasis: string;
  currency: string;
  unit: string;
  asOf: number;
  state: "unavailable" | "insufficient_sample" | "included_sample";
  label: "预测样本不足" | "已纳入样本预测汇总" | "市场一致预期";
  included: SourceForecast[];
  exclusions: ForecastExclusion[];
  statistics: { count: number; median: number | null; mean: number | null; min: number | null; max: number | null; range: number | null };
  marketConsensus: { eligible: boolean; declaredUniverse: string | null; reason: string };
  ruleVersion: string;
};

/**
 * Consolidates only explicitly comparable third-party forecasts.  It is never
 * called market consensus unless a caller has verified the declared universe.
 */
export function buildForecastConsolidation(input: {
  asOf: number;
  companyId: string;
  metric: string;
  fiscalPeriod: string;
  accountingBasis: string;
  currency: string;
  unit: string;
  forecasts: readonly SourceForecast[];
  sourceUniverse?: { declaredUniverse?: string; broadCoverageVerified?: boolean };
}): ForecastConsolidation {
  const exclusions: ForecastExclusion[] = [];
  const latestByPublisher = new Map<string, SourceForecast>();
  for (const item of input.forecasts) {
    const reason = forecastExclusionReason(item, input);
    if (reason) {
      exclusions.push({ forecastId: item.id, reason });
      continue;
    }
    const publisherKey = item.publisher.trim().toLocaleLowerCase();
    const current = latestByPublisher.get(publisherKey);
    if (!current || item.publishedAt > current.publishedAt || item.publishedAt === current.publishedAt && item.id.localeCompare(current.id) > 0) {
      if (current) exclusions.push({ forecastId: current.id, reason: "superseded_by_newer_same_publisher" });
      latestByPublisher.set(publisherKey, item);
    } else {
      exclusions.push({ forecastId: item.id, reason: "superseded_by_newer_same_publisher" });
    }
  }
  const included = [...latestByPublisher.values()].sort((left, right) => left.publisher.localeCompare(right.publisher) || right.publishedAt - left.publishedAt);
  const values = included.map((item) => item.value!).sort((left, right) => left - right);
  const statistics = summary(values);
  const verifiedConsensus = input.sourceUniverse?.broadCoverageVerified === true && Boolean(input.sourceUniverse.declaredUniverse?.trim()) && included.length >= 2;
  const state: ForecastConsolidation["state"] = included.length === 0 ? "unavailable" : included.length === 1 ? "insufficient_sample" : "included_sample";
  const label: ForecastConsolidation["label"] = state === "unavailable" || state === "insufficient_sample"
    ? "预测样本不足"
    : verifiedConsensus ? "市场一致预期" : "已纳入样本预测汇总";
  const marketConsensus = verifiedConsensus
    ? { eligible: true, declaredUniverse: input.sourceUniverse!.declaredUniverse!.trim(), reason: "声明的来源范围已由调用方验证，且存在至少两家可比机构样本。" }
    : { eligible: false, declaredUniverse: input.sourceUniverse?.declaredUniverse?.trim() || null, reason: "未验证广覆盖来源范围；结果仅是已纳入样本预测汇总，不是市场一致预期。" };
  return { ...pickForecastScope(input), asOf: validTimestamp(input.asOf) ? input.asOf : 0, state, label, included, exclusions, statistics, marketConsensus, ruleVersion: RESEARCH_FOUNDATION_RULE_VERSION };
}

export type ForecastCalibration = {
  forecastId: string;
  actualId: string;
  state: "calibrated" | "unavailable" | "not_comparable";
  forecastValue: number | null;
  actualValue: number | null;
  absoluteError: number | null;
  relativeErrorPct: number | null;
  reason: string | null;
};

export function buildForecastCalibration(input: { forecast: SourceForecast; actual: SourceFact; accountingBasis: string; actualAccountingBasis: string; metric: string; actualMetric: string; fiscalPeriod: string; actualFiscalPeriod: string }): ForecastCalibration {
  if (input.forecast.accountingBasis !== input.accountingBasis || input.actualAccountingBasis !== input.accountingBasis || input.forecast.metric !== input.metric || input.actualMetric !== input.metric || input.forecast.fiscalPeriod !== input.fiscalPeriod || input.actualFiscalPeriod !== input.fiscalPeriod) {
    return { forecastId: input.forecast.id, actualId: input.actual.id, state: "not_comparable", forecastValue: input.forecast.value, actualValue: input.actual.value, absoluteError: null, relativeErrorPct: null, reason: "预测与实际的指标、期间或会计口径不一致。" };
  }
  if (!finite(input.forecast.value) || !finite(input.actual.value)) {
    return { forecastId: input.forecast.id, actualId: input.actual.id, state: "unavailable", forecastValue: input.forecast.value, actualValue: input.actual.value, absoluteError: null, relativeErrorPct: null, reason: "预测或实际值缺失。" };
  }
  const absoluteError = input.forecast.value - input.actual.value;
  return { forecastId: input.forecast.id, actualId: input.actual.id, state: "calibrated", forecastValue: input.forecast.value, actualValue: input.actual.value, absoluteError, relativeErrorPct: input.actual.value === 0 ? null : absoluteError / Math.abs(input.actual.value) * 100, reason: input.actual.value === 0 ? "实际值为零，百分比误差不适用。" : null };
}

function forecastExclusionReason(item: SourceForecast, expected: Pick<ForecastConsolidation, "companyId" | "metric" | "fiscalPeriod" | "accountingBasis" | "currency" | "unit" | "asOf">): string | null {
  if (item.kind !== "third_party_forecast") return "management_guidance_is_not_third_party_forecast";
  if (!item.publisher.trim() || !item.sourceId.trim() || !item.sourceUrl.trim()) return "missing_attribution";
  if (!finite(item.value)) return "missing_numeric_value";
  if (!validTimestamp(item.publishedAt) || item.publishedAt > expected.asOf) return "not_available_as_of_snapshot";
  if (item.companyId !== expected.companyId) return "different_company";
  if (item.metric !== expected.metric || item.fiscalPeriod !== expected.fiscalPeriod) return "different_metric_or_period";
  if (item.accountingBasis !== expected.accountingBasis || item.currency !== expected.currency || item.unit !== expected.unit) return "not_comparable_basis_currency_or_unit";
  return null;
}

function pickForecastScope(input: { companyId: string; metric: string; fiscalPeriod: string; accountingBasis: string; currency: string; unit: string }) {
  return { companyId: input.companyId, metric: input.metric, fiscalPeriod: input.fiscalPeriod, accountingBasis: input.accountingBasis, currency: input.currency, unit: input.unit };
}

function summary(values: readonly number[]) {
  if (!values.length) return { count: 0, median: null, mean: null, min: null, max: null, range: null };
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  const min = values[0]!;
  const max = values.at(-1)!;
  return { count: values.length, median, mean: values.reduce((total, value) => total + value, 0) / values.length, min, max, range: max - min };
}

function finite(value: number | null | undefined): value is number { return typeof value === "number" && Number.isFinite(value); }
function validTimestamp(value: number | null | undefined): value is number { return finite(value) && value > 0; }
